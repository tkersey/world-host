import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { createApplicationRecord } from '../core/application.mjs';
import { exportCarrierRun, forkRunBranch, importCarrierRun } from '../core/migration.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../core/run.mjs';
import { assertBlobRef, fail, fromUtf8, makeBlobRef, stableJson } from '../core/store.mjs';
import { RunController, worldHostRequestToEffectRequest } from '../core/worker.mjs';
import { createRunPolicy, preflightCapabilities } from '../core/capabilities.mjs';
import { decodeResolutionInputBytes, encodeBootTurnInput, encodeResolutionInputBytes, encodeRestoreTurnInput, encodeTurnInput, operationBoot } from '../protocol/world_appliance_wire_codec.mjs';
import { encodeCanonicalValueImage, fingerprintValueImage } from '../protocol/world_loaded_value_codec.mjs';
import { inspectTurnOutput, summarizeTurnClosureForRunHead } from '../protocol/world_universal_appliance_codec.mjs';
import { carrierVersionSummary } from '../protocol/world_manifest.mjs';
import { EffectJournal, EffectState } from '../core/effect_journal.mjs';
import { FixtureAgentModelDriver } from '../drivers/fixture_agent_model_driver.mjs';
import { SandboxFileDriver } from '../drivers/sandbox_file_driver.mjs';
import { BunWorldWorker } from './bun_worker.mjs';
import { DirectoryStore } from '../stores/directory_store.mjs';

const AGENT_MODEL_ACTUATOR = 'world:actuator-ref:4f0c7160f25c4c62';
const AGENT_MODEL_DESCRIPTOR = 'world:descriptor:be73177924a6b377';
const AGENT_MODEL_ACTUATION_CLASS = 'world:actuation-class:2';
const AGENT_FILE_ACTUATOR = 'world:actuator-ref:d5e4b1b427522cf2';
const AGENT_FILE_DESCRIPTOR = 'world:descriptor:74afc8c3b2fe4c33';
const AGENT_FILE_ACTUATION_CLASS = 'world:actuation-class:1';
const AGENT_RUNTIME_FIXTURE_OUTPUT = 'actuate updated the fixture';
export async function runBunCli(args, io, options = {}) {
  const command = args[0] ?? 'help';
  if (command === '--version' || command === 'version') {
    io.stdout.write(`${carrierVersionSummary().carrierVersion}\n`);
    return 0;
  }
  if (command === 'doctor') {
    io.stdout.write(`${JSON.stringify({
      ok: true,
      manifest: carrierVersionSummary(),
      runtimeDependencies: 0,
      nativeWorldHelperProcess: false,
      childProcessProtocolEncoding: false,
    }, null, 2)}\n`);
    return 0;
  }
  if (command === 'agent') return await runAgentCommand(args.slice(1), io, options);
  if (command === 'inspect' || command === 'effects') {
    const storePath = valueAfter(args, '--store');
    const runId = valueAfter(args, '--run');
    if (storePath && runId) return await runStoreDiagnostics(command, args, io, storePath, runId);
    throw new Error(`missing required option: ${storePath ? '--run' : '--store'}`);
  }
  if (command === 'recover') {
    const storePath = valueAfter(args, '--store');
    if (storePath) return await runRecover(args, io, storePath);
    throw new Error('missing required option: --store');
  }
  if (command === 'fork' || command === 'export' || command === 'import') {
    const storePath = valueAfter(args, '--store');
    if (storePath && command === 'fork') return await runFork(args, io, storePath);
    if (storePath && command === 'export') return await runExport(args, io, storePath);
    if (storePath && command === 'import') return await runImport(args, io, storePath);
    throw new Error('missing required option: --store');
  }
  if (command === 'install') {
    const storePath = valueAfter(args, '--store');
    if (storePath) return await runInstall(args, io, storePath);
    throw new Error('missing required option: --store');
  }
  if (command === 'run') {
    const storePath = valueAfter(args, '--store');
    if (storePath) return await runStoreRun(args, io, storePath, options);
    throw new Error('missing required option: --store');
  }
  if (command === 'resume') {
    const storePath = valueAfter(args, '--store');
    if (storePath) return await runStoreResume(args, io, storePath, options);
    throw new Error('missing required option: --store');
  }
  if (command === 'run-example') return await runExample(args[1], io);
  io.stdout.write('world-host commands: agent, install, doctor, run, resume, inspect, effects, recover, fork, export, import, run-example, version\n');
  return command === 'help' || command === '--help' || command === '-h' ? 0 : 2;
}

async function runAgentCommand(args, io, options) {
  const subcommand = args[0] ?? 'help';
  if (subcommand === 'install') {
    const pack = requiredOption(args, '--pack');
    const storePath = requiredOption(args, '--store');
    const applicationId = valueAfter(args, '--app') ?? valueAfter(args, '--name') ?? 'agent-runtime-v0.1';
    const { checkAgentRuntimePack } = await import('../../scripts/agent_runtime_pack_lib.mjs');
    const packCheckOptions = options.requireReleaseReceipt === false
      ? { validateReleaseReceipt: false }
      : { requireReleaseReceipt: true, validateReleaseReceipt: options.validateReleaseReceipt };
    const checked = await checkAgentRuntimePack(pack, packCheckOptions);
    const manifest = checked.manifest;
    const requiredActuators = requiredActuatorRequirements(manifest);
    const requiredHostAuthorityLabels = [...manifest.requiredHostAuthorityLabels];
    return await runInstall([
      'install',
      '--store', storePath,
      '--name', applicationId,
      '--wasm', path.join(checked.root, 'world/world_universal_appliance.wasm'),
      '--image', path.join(checked.root, 'world/agent.executable-image'),
      '--image-fingerprint', manifest.world.executableImageFingerprint,
      '--manifest', path.join(checked.root, 'world/appliance-manifest.bin'),
    ], io, storePath, { requiredActuators, requiredHostAuthorityLabels });
  }
  if (subcommand === 'run') {
    const runOptions = args.includes('--no-execute') ? options : agentRuntimeRunOptions(args, options);
    return await runStoreRun(forwardAgentRunArgs(args), io, requiredOption(args, '--store'), runOptions);
  }
  if (subcommand === 'resume') return await runStoreResume(['resume', ...args.slice(1)], io, requiredOption(args, '--store'), agentRuntimeRunOptions(args, options));
  if (subcommand === 'inspect') return await runStoreDiagnostics('inspect', ['inspect', ...args.slice(1)], io, requiredOption(args, '--store'), requiredOption(args, '--run'));
  if (subcommand === 'replay') return await runStoreReplay(['replay', ...args.slice(1)], io, requiredOption(args, '--store'), requiredOption(args, '--run'));
  if (subcommand === 'migrate') {
    const storePath = requiredOption(args, '--store');
    const out = requiredOption(args, '--out');
    return await runExport(['export', ...args.slice(1), '--out', out], io, storePath);
  }
  if (subcommand === 'import') {
    return await runImport(['import', ...args.slice(1)], io, requiredOption(args, '--store'), {
      ...options,
      agentRuntimeOptionsArgs: args,
    });
  }
  if (subcommand === 'conformance') {
    const pack = requiredOption(args, '--pack');
    const {
      assertAgentRuntimeReleaseReceipt,
      checkAgentRuntimePack,
      refreshAgentRuntimePackChecksums,
    } = await import('../../scripts/agent_runtime_pack_lib.mjs');
    const { runAgentRuntimeConformance } = await import('../../scripts/run-agent-runtime-conformance.mjs');
    await checkAgentRuntimePack(pack);
    const { receipt, releaseReceipt } = await runAgentRuntimeConformance(pack);
    const releaseReceiptPath = path.join(pack, 'manifest/agent-runtime-release-receipt.json');
    const existingReleaseReceipt = await readJsonIfExists(releaseReceiptPath);
    if (existingReleaseReceipt) {
      await assertAgentRuntimeReleaseReceipt(pack, existingReleaseReceipt);
      if (existingReleaseReceipt.receiptFingerprint !== releaseReceipt.receiptFingerprint) {
        fail('ERR_AGENT_RUNTIME_RELEASE_RECEIPT_MISMATCH');
      }
    } else {
      await writeFile(releaseReceiptPath, `${JSON.stringify(releaseReceipt, null, 2)}\n`);
      await refreshAgentRuntimePackChecksums(pack);
    }
    io.stdout.write(`${JSON.stringify(redact({
      command: 'agent conformance',
      pack,
      agentRuntimeManifestFingerprint: receipt.agentRuntimeManifestFingerprint,
      releaseReceiptFingerprint: releaseReceipt.receiptFingerprint,
      packValid: true,
      scenariosPassed: true,
    }), null, 2)}\n`);
    return 0;
  }
  io.stdout.write('world-host agent commands: install, run, resume, inspect, replay, migrate, import, conformance\n');
  return subcommand === 'help' || subcommand === '--help' || subcommand === '-h' ? 0 : 2;
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function requiredActuatorRequirements(manifest) {
  if (manifest.requiredActuatorRefs.length !== manifest.requiredDescriptorFingerprints.length) {
    throw new Error('ERR_AGENT_RUNTIME_REQUIRED_ACTUATOR_DESCRIPTOR_MISMATCH');
  }
  return manifest.requiredActuatorRefs.map((actuatorRef, index) => ({
    actuatorRef,
    descriptorFingerprint: manifest.requiredDescriptorFingerprints[index],
  }));
}

async function runStoreRun(args, io, storePath, options) {
  const applicationId = valueAfter(args, '--app') ?? positionalAfterCommand(args);
  if (!applicationId) throw new Error('missing required application id');
  const runId = valueAfter(args, '--run') ?? `run-${randomUUID()}`;
  const branchId = valueAfter(args, '--branch') ?? 'main';
  const inputPath = valueAfter(args, '--input');
  const store = new DirectoryStore(storePath);
  await store.acquireLock();
  try {
    const { run, head, created } = await getOrCreateInitialRun(store, {
      applicationId,
      runId,
      branchId,
      inputPath,
    });
    if (args.includes('--no-execute')) {
      io.stdout.write(`${JSON.stringify(redact(summarizeRunLifecycle({
        command: 'run',
        storePath,
        run,
        branchId,
        created,
        head,
        advance: null,
      })), null, 2)}\n`);
      return 0;
    }
    const advance = await advanceRunOnce(store, run.runId, branchId, options);
    io.stdout.write(`${JSON.stringify(redact(summarizeRunLifecycle({
      command: 'run',
      storePath,
      run,
      branchId,
      created,
      head: advance.nextHead ?? advance.winningHead ?? head,
      advance,
      driversInvokedByCli: options.agentRuntimeDrivers === true,
    })), null, 2)}\n`);
    return 0;
  } finally {
    await store.releaseLock();
  }
}

async function runStoreResume(args, io, storePath, options) {
  const runId = requiredOption(args, '--run');
  const branchId = valueAfter(args, '--branch') ?? 'main';
  const store = new DirectoryStore(storePath);
  await store.acquireLock();
  try {
    const run = await store.getRun(runId);
    const advance = await advanceRunOnce(store, runId, branchId, options);
    io.stdout.write(`${JSON.stringify(redact(summarizeRunLifecycle({
      command: 'resume',
      storePath,
      run,
      branchId,
      created: false,
      head: advance.nextHead ?? advance.winningHead,
      advance,
      driversInvokedByCli: options.agentRuntimeDrivers === true,
    })), null, 2)}\n`);
    return 0;
  } finally {
    await store.releaseLock();
  }
}

async function runInstall(args, io, storePath, options = {}) {
  const applicationId = requiredOption(args, '--name');
  const wasmPath = requiredOption(args, '--wasm');
  const imagePath = requiredOption(args, '--image');
  const imageWorldFingerprint = requiredOption(args, '--image-fingerprint');
  const manifestPath = valueAfter(args, '--manifest');
  const wasmBytes = await readFile(wasmPath);
  const imageBytes = await readFile(imagePath);
  const store = new DirectoryStore(storePath);
  await store.acquireLock();
  try {
    await assertApplicationDoesNotExist(store, applicationId);
    const wasmRef = await store.putBlob(new Uint8Array(wasmBytes));
    const imageRef = await store.putBlob(new Uint8Array(imageBytes));
    const manifestBytes = manifestPath
      ? new Uint8Array(await readFile(manifestPath))
      : createInstallManifestBytes({
          applicationId,
          wasmRef,
          imageRef,
          imageWorldFingerprint,
        });
    const manifestRef = await store.putBlob(manifestBytes);
    const versions = carrierVersionSummary();
    const app = createApplicationRecord({
      applicationId,
      universalWasmChecksum: `sha256:${wasmRef.checksum}`,
      universalWasmByteLength: wasmRef.byteLength,
      worldProtocolVersion: versions.world,
      applianceAbiVersion: versions.applianceAbi,
      executableImageRef: imageRef,
      executableImageWorldFingerprint: imageWorldFingerprint,
      applianceManifestRef: manifestRef,
      requiredActuators: options.requiredActuators ?? [],
      requiredHostAuthorityLabels: options.requiredHostAuthorityLabels ?? [],
      requiredRuntimeLimits: {},
      installationDiagnostics: {
        command: 'install',
        manifestSource: manifestPath ? 'operator-supplied' : 'host-generated-install-summary',
        wasmByteLength: wasmRef.byteLength,
        imageByteLength: imageRef.byteLength,
        manifestByteLength: manifestRef.byteLength,
        hostChecksumsOnly: true,
        worldFingerprintSource: '--image-fingerprint',
        worldFingerprintDerivedFromSha256: false,
        workerExecuted: false,
        driversInvoked: false,
        runCreated: false,
        worldEvidenceAuthored: false,
      },
    });
    await store.createApplication(app);
    io.stdout.write(`${JSON.stringify(redact({
      command: 'install',
      ok: true,
      mode: 'json',
      store: storePath,
      ...summarizeApplicationInstall(app),
      blobs: {
        wasm: summarizeBlobRef(wasmRef),
        executableImage: summarizeBlobRef(imageRef),
        applianceManifest: summarizeBlobRef(manifestRef),
      },
      diagnostics: {
        manifestSource: app.installationDiagnostics.manifestSource,
        authorityCarried: false,
        hostChecksumsOnly: true,
        worldFingerprintSource: '--image-fingerprint',
        worldFingerprintDerivedFromSha256: false,
        workerExecuted: false,
        driversInvoked: false,
        runCreated: false,
        worldEvidenceAuthored: false,
      },
    }), null, 2)}\n`);
    return 0;
  } finally {
    await store.releaseLock();
  }
}

async function assertApplicationDoesNotExist(store, applicationId) {
  try {
    await store.getApplication(applicationId);
  } catch (error) {
    if (error?.code === 'ERR_APPLICATION_NOT_FOUND') return;
    throw error;
  }
  fail('ERR_APPLICATION_EXISTS');
}

async function getOrCreateInitialRun(store, { applicationId, runId, branchId, inputPath }) {
  try {
    const existing = await store.getRun(runId);
    if (existing.applicationId !== applicationId) throw new Error('ERR_RUN_APPLICATION_MISMATCH');
    return { run: existing, head: await store.readHead(runId, branchId), created: false };
  } catch (error) {
    if (error?.code !== 'ERR_RUN_NOT_FOUND') throw error;
  }
  await store.getApplication(applicationId);
  const genesisClosureRef = await store.putBlob(fromUtf8('world-host:genesis'));
  const inputRef = inputPath ? await store.putBlob(new Uint8Array(await readFile(inputPath))) : null;
  const head = createRunHead({
    generation: 0,
    turnClosureRef: genesisClosureRef,
    turnClosureWorldFingerprint: 'world:turn-closure:genesis',
    resultingStateFingerprint: 'world:state:genesis',
    chronicleCursor: 'world:chronicle-cursor:genesis',
    archiveMomentFingerprint: 'world:archive-moment:genesis',
    archiveSealFingerprint: 'world:archive-seal:genesis',
    status: 'genesis',
    updateDiagnostics: {
      source: 'world-host.cli.run',
      inputRef,
    },
  });
  const run = createRunRecord({
    runId,
    applicationId,
    branches: [createBranchRecord({ branchId, currentHead: head })],
    effectJournalNamespace: `${runId}:effects`,
    creationMetadata: {
      source: 'world-host.cli.run',
      inputRef,
    },
    diagnostics: {
      scheduler: false,
      workerAuthoritative: false,
    },
  });
  await store.createRun(run);
  return { run, head, created: true };
}

async function advanceRunOnce(store, runId, branchId, options) {
  const run = await store.getRun(runId);
  const application = await store.getApplication(run.applicationId);
  const wasmBytes = options.wasmBytes ?? await store.getBlob(wasmBlobRefFromApplication(application));
  const controller = new RunController({
    store,
    wasmBytes,
    workerFactory: options.workerFactory ?? (async () => new BunWorldWorker()),
    turnInputFactory: options.turnInputFactory ?? cliTurnInputFactory,
    effectDrivers: options.effectDrivers ?? [],
    effectPolicy: options.effectPolicy ?? {},
    hostRequestMapper: options.hostRequestMapper,
  });
  try {
    return await controller.advance(runId, branchId, options.advanceOptions ?? {});
  } finally {
    controller.warmWorker?.dispose();
  }
}

function wasmBlobRefFromApplication(application) {
  const checksum = application.universalWasmChecksum?.startsWith('sha256:')
    ? application.universalWasmChecksum.slice('sha256:'.length)
    : null;
  const byteLength = application.universalWasmByteLength;
  if (!checksum || !Number.isSafeInteger(byteLength)) {
    throw new Error('ERR_APPLICATION_WASM_BLOB_REF_MISSING');
  }
  return makeBlobRef(checksum, byteLength);
}

function cliTurnInputFactory({ parentHead, parentClosureBytes, worker }) {
  const applianceManifest = worker.readApplianceManifest();
  const manifestFingerprint = applianceManifest.decoded?.manifestFingerprint ?? 0n;
  if (parentHead.status === 'genesis') {
    return encodeBootTurnInput({
      manifestFingerprint,
      metadata: 'world-host.cli.boot',
    });
  }
  const parentSummary = inspectTurnOutput(parentClosureBytes);
  return encodeRestoreTurnInput({
    manifestFingerprint,
    parentTurnClosureBytes: parentClosureBytes,
    expectedParentClosureFingerprint: parentSummary.closureFingerprint,
    expectedParentStateFingerprint: parentSummary.resultingStateFingerprint,
    previousTurnReceiptFingerprint: parentSummary.turnReceipt.receiptFingerprint,
    turnSequenceNumber: parentSummary.turnSequenceNumber + 1n,
    metadata: 'world-host.cli.restore',
  });
}

async function runStoreDiagnostics(command, args, io, storePath, runId) {
  const branchId = valueAfter(args, '--branch') ?? 'main';
  const store = new DirectoryStore(storePath);
  await store.acquireLock();
  try {
    const result = command === 'inspect'
      ? await inspectStore(store, storePath, runId, branchId)
      : await inspectEffects(store, storePath, runId);
    io.stdout.write(`${JSON.stringify(redact(result), null, 2)}\n`);
    return 0;
  } finally {
    await store.releaseLock();
  }
}

async function runStoreReplay(args, io, storePath, runId) {
  const branchId = valueAfter(args, '--branch') ?? 'main';
  const store = new DirectoryStore(storePath);
  await store.acquireLock();
  try {
    const result = await replayStoreRun(store, storePath, runId, branchId);
    io.stdout.write(`${JSON.stringify(redact(result), null, 2)}\n`);
    return 0;
  } finally {
    await store.releaseLock();
  }
}

async function runFork(args, io, storePath) {
  const runId = requiredOption(args, '--run');
  const sourceBranchId = valueAfter(args, '--source-branch') ?? 'main';
  const sourceClosureFingerprint = requiredOption(args, '--from');
  const newBranchId = requiredOption(args, '--branch');
  const store = new DirectoryStore(storePath);
  await store.acquireLock();
  try {
    const sourceBefore = await store.readHead(runId, sourceBranchId);
    const branch = await forkRunBranch(store, {
      runId,
      sourceBranchId,
      sourceClosureFingerprint,
      newBranchId,
    });
    const sourceAfter = await store.readHead(runId, sourceBranchId);
    io.stdout.write(`${JSON.stringify(redact({
      command: 'fork',
      ok: true,
      mode: 'json',
      store: storePath,
      runId,
      sourceBranchId,
      newBranchId: branch.branchId,
      forkedFromTurnClosureFingerprint: branch.forkedFromTurnClosureFingerprint,
      sourceBranchMutated: sourceBefore.turnClosureWorldFingerprint !== sourceAfter.turnClosureWorldFingerprint ||
        sourceBefore.generation !== sourceAfter.generation,
      diagnostics: {
        workerExecuted: false,
        driversInvoked: false,
        worldEvidenceAuthored: false,
        branchMergeSemantics: false,
      },
    }), null, 2)}\n`);
    return 0;
  } finally {
    await store.releaseLock();
  }
}

async function runExport(args, io, storePath) {
  const runId = requiredOption(args, '--run');
  const branchId = valueAfter(args, '--branch') ?? 'main';
  const outPath = requiredOption(args, '--out');
  const store = new DirectoryStore(storePath);
  await store.acquireLock();
  try {
    const carrierExport = await exportCarrierRun(store, runId, branchId);
    await writeFile(outPath, `${JSON.stringify(carrierExport, null, 2)}\n`);
    io.stdout.write(`${JSON.stringify(redact({
      command: 'export',
      ok: true,
      mode: 'json',
      store: storePath,
      package: outPath,
      ...summarizeCarrierExport(carrierExport),
      diagnostics: {
        completeIdempotencyKeyBytesOmitted: true,
        workerExecuted: false,
        driversInvoked: false,
        worldEvidenceAuthored: false,
      },
    }), null, 2)}\n`);
    return 0;
  } finally {
    await store.releaseLock();
  }
}

async function runImport(args, io, storePath, options = {}) {
  const packagePath = requiredOption(args, '--package');
  const receiverRunId = valueAfter(args, '--run');
  const carrierExport = JSON.parse(await readFile(packagePath, 'utf8'));
  const store = new DirectoryStore(storePath);
  await store.acquireLock();
  try {
    const imported = await importCarrierRun(store, carrierExport, {
      runId: receiverRunId,
      preflight: async (candidate) => {
        const pendingRequests = pendingRequestsForImportedHead(candidate);
        const mayBypassPreflightRequirements = importedHeadCanBypassPreflightRequirements(candidate.bundle.head);
        const preflightOptions = !mayBypassPreflightRequirements && options.agentRuntimeOptionsArgs
          ? agentRuntimeRunOptions(options.agentRuntimeOptionsArgs, options)
          : options;
        if (candidate.bundle.head?.status === 'needs_host' && pendingRequests.length === 0) {
          fail('ERR_IMPORT_PREFLIGHT_NEEDS_HOST_REQUESTS_EMPTY', 'receiver preflight rejects needs_host imports with no pending HostRequests');
        }
        const application = mayBypassPreflightRequirements && pendingRequests.length === 0
          ? { ...candidate.bundle.application, requiredActuators: [], requiredHostAuthorityLabels: [] }
          : candidate.bundle.application;
        return preflightCapabilities({
          application,
          currentHead: candidate.bundle.head,
          pendingRequests: pendingRequests.map(preflightOptions.hostRequestMapper ?? worldHostRequestToEffectRequest),
          drivers: preflightOptions.effectDrivers ?? [],
          policy: preflightOptions.effectPolicy ?? createRunPolicy(),
        });
      },
    });
    io.stdout.write(`${JSON.stringify(redact({
      command: 'import',
      ok: true,
      mode: 'json',
      store: storePath,
      package: packagePath,
      ...summarizeImportedRun(imported),
      diagnostics: {
        completeIdempotencyKeyBytesOmitted: true,
        workerExecuted: false,
        driversInvoked: false,
        worldEvidenceAuthored: false,
        receiverLocalPolicyApplied: imported.receiverPolicyApplied,
      },
    }), null, 2)}\n`);
    return 0;
  } finally {
    await store.releaseLock();
  }
}

function importedHeadCanBypassPreflightRequirements(head) {
  return ['genesis', 'completed', 'failed', 'cancelled', 'inspected'].includes(head?.status);
}

function pendingRequestsForImportedHead(candidate) {
  const head = candidate.bundle?.head;
  const closureBytes = carrierBundleBlobBytes(candidate.bundle, head.turnClosureRef);
  if (head.status === 'genesis') {
    assertImportedGenesisHead(head, closureBytes);
    return [];
  }
  let summary;
  let headSummary;
  try {
    summary = inspectTurnOutput(closureBytes);
    headSummary = summarizeTurnClosureForRunHead(closureBytes);
  } catch (error) {
    fail('ERR_IMPORT_PREFLIGHT_CLOSURE_UNDECODABLE', 'receiver preflight could not inspect selected closure', { cause: error.message });
  }
  const decodedStatus = importClosureStatusLabel(summary.status);
  if (head.status !== decodedStatus) {
    fail('ERR_IMPORT_PREFLIGHT_HEAD_STATUS_MISMATCH', 'receiver preflight requires imported head status to match selected closure', { headStatus: head.status, decodedStatus });
  }
  assertImportedHeadMatchesClosure(head, headSummary);
  return decodedStatus === 'needs_host' ? summary.hostRequests : [];
}

function assertImportedGenesisHead(head, closureBytes) {
  const genesisBytes = fromUtf8('world-host:genesis');
  if (head.generation !== 0 || closureBytes.byteLength !== genesisBytes.byteLength || !closureBytes.every((byte, index) => byte === genesisBytes[index])) {
    fail('ERR_IMPORT_PREFLIGHT_GENESIS_MISMATCH', 'receiver preflight requires genesis heads to use the host genesis sentinel');
  }
  for (const [field, expected] of Object.entries({
    turnClosureWorldFingerprint: 'world:turn-closure:genesis',
    resultingStateFingerprint: 'world:state:genesis',
    chronicleCursor: 'world:chronicle-cursor:genesis',
    archiveMomentFingerprint: 'world:archive-moment:genesis',
    archiveSealFingerprint: 'world:archive-seal:genesis',
    status: 'genesis',
  })) {
    if (head[field] !== expected) {
      fail('ERR_IMPORT_PREFLIGHT_GENESIS_MISMATCH', 'receiver preflight requires genesis heads to use canonical host genesis metadata', {
        field,
        headValue: head[field],
        expected,
      });
    }
  }
}

function assertImportedHeadMatchesClosure(head, summary) {
  const expectedGeneration = summary.inspectionDiagnostics.turnSequenceNumber + 1;
  if (head.generation !== expectedGeneration) {
    fail('ERR_IMPORT_PREFLIGHT_HEAD_GENERATION_MISMATCH', 'receiver preflight requires imported head generation to match selected closure sequence', {
      headGeneration: head.generation,
      closureTurnSequenceNumber: summary.inspectionDiagnostics.turnSequenceNumber,
      expectedGeneration,
    });
  }
  for (const field of [
    'turnClosureWorldFingerprint',
    'resultingStateFingerprint',
    'chronicleCursor',
    'archiveMomentFingerprint',
    'archiveSealFingerprint',
    'status',
  ]) {
    if ((field === 'archiveMomentFingerprint' || field === 'archiveSealFingerprint') && summary[field] == null) continue;
    if (head[field] !== summary[field]) {
      fail('ERR_IMPORT_PREFLIGHT_HEAD_CLOSURE_MISMATCH', 'receiver preflight requires imported head metadata to match selected closure', {
        field,
        headValue: head[field],
        closureValue: summary[field],
      });
    }
  }
}

function carrierBundleBlobBytes(bundle, ref) {
  const expected = assertBlobRef(ref);
  const blob = (bundle?.blobs ?? []).find((candidate) => candidate.checksum === expected.checksum && candidate.byteLength === expected.byteLength);
  if (!blob || !Array.isArray(blob.bytes)) {
    fail('ERR_IMPORT_PREFLIGHT_CLOSURE_BLOB_MISSING', 'receiver preflight requires exported needs_host closure bytes');
  }
  const bytes = Uint8Array.from(blob.bytes);
  if (bytes.byteLength !== expected.byteLength || createHash('sha256').update(bytes).digest('hex') !== expected.checksum) {
    fail('ERR_IMPORT_PREFLIGHT_CLOSURE_BLOB_MISMATCH', 'receiver preflight closure bytes do not match the selected head ref');
  }
  return bytes;
}

function importClosureStatusLabel(status) {
  if (status === 0) return 'needs_host';
  if (status === 1) return 'yielded_budget';
  if (status === 2) return 'completed';
  if (status === 3) return 'failed';
  if (status === 4) return 'cancelled';
  if (status === 5) return 'inspected';
  return `world-status:${status}`;
}

function agentRuntimeRunOptions(args, options = {}) {
  const sandboxRootOption = valueAfter(args, '--sandbox-root');
  if (!sandboxRootOption) fail('ERR_AGENT_RUNTIME_SANDBOX_ROOT_REQUIRED', 'agent runtime file driver requires --sandbox-root');
  const sandboxRoot = path.resolve(sandboxRootOption);
  const scenario = valueAfter(args, '--scenario') ?? valueAfter(args, '--agent-scenario') ?? 'skeleton';
  return {
    ...options,
    effectDrivers: [
      agentWorldRequestDriver(new FixtureAgentModelDriver({
        scenario,
        actuatorRef: AGENT_MODEL_ACTUATOR,
        descriptorFingerprint: AGENT_MODEL_DESCRIPTOR,
      }), AGENT_MODEL_ACTUATION_CLASS),
      agentWorldRequestDriver(new SandboxFileDriver({
        root: sandboxRoot,
        actuatorRef: AGENT_FILE_ACTUATOR,
        descriptorFingerprint: AGENT_FILE_DESCRIPTOR,
      }), AGENT_FILE_ACTUATION_CLASS),
      ...(options.effectDrivers ?? []),
    ],
    effectPolicy: {
      allowBestEffort: true,
      ...(options.effectPolicy ?? {}),
    },
    turnInputFactory: options.turnInputFactory ?? agentRuntimeTurnInputFactory(scenario),
    hostRequestMapper: options.hostRequestMapper ?? ((request) => agentWorldHostRequestToEffectRequest(request, { scenario, sandboxRoot })),
    agentRuntimeDrivers: true,
  };
}

function agentRuntimeTurnInputFactory(scenario) {
  return (context) => {
    if (context.parentHead.status !== 'genesis') return cliTurnInputFactory(context);
    const applianceManifest = context.worker.readApplianceManifest();
    return encodeTurnInput({
      operation: operationBoot,
      manifestFingerprint: applianceManifest.decoded.manifestFingerprint,
      turnSequenceNumber: 0n,
      rootArgumentImages: [fromUtf8(agentRuntimeScenarioPayload(scenario))],
      hostMetadata: `world-host.agent-runtime.${scenario}`,
    });
  };
}

function agentRuntimeScenarioPayload(scenario) {
  const fixture = scenario === 'fixture';
  return stableJson({
    schema: 'boundary.Agent.DecisionPrompt.v0',
    observation: fixture ? 'goal=fixture' : 'goal=invoke',
    traceSummary: 'bounded',
    operation: fixture ? 'write' : 'read',
    path: fixture ? 'output.txt' : 'input.txt',
    ...(fixture ? { content: AGENT_RUNTIME_FIXTURE_OUTPUT } : {}),
  });
}

export function agentWorldHostRequestToEffectRequest(request, options = {}) {
  const mapped = worldHostRequestToEffectRequest(request);
  const expectedResponseDiagnostics = agentRuntimeExpectedResponseDiagnostics(request);
  return {
    ...mapped,
    expectedResponseValueRefFingerprint: request.expectedResponseValueRefFingerprint,
    expectedResponseSchemaRefFingerprint: request.expectedResponseSchemaRefFingerprint,
    diagnostics: {
      ...mapped.diagnostics,
      ...expectedResponseDiagnostics,
    },
    ...agentRuntimePayloadBytes(request.payloadValueImageBytes, request),
  };
}

export function agentWorldRequestDriver(driver, actuationClass) {
  return {
    manifest() {
      return {
        ...driver.manifest(),
        supportedActuationClasses: [actuationClass],
        supportedResponseStatuses: ['responded'],
      };
    },
    async resolve(context, hostRequest) {
      const delegated = {
        ...hostRequest,
        responseSchema: hostRequest.responseSchema ? { ...hostRequest.responseSchema, status: 'ok' } : hostRequest.responseSchema,
      };
      return bindAgentRuntimeResolution(hostRequest, await driver.resolve(context, delegated));
    },
  };
}

function bindAgentRuntimeResolution(hostRequest, result) {
  const resolution = decodeResolutionInputBytes(result.resolutionInputBytes);
  const translated = translateAgentRuntimeResolution(resolution);
  const expectedValue = hostRequest.expectedResponseValueRefFingerprint ??
    hostRequest.diagnostics?.agentRuntimeExpectedResponseValueRefFingerprint;
  const expectedSchema = hostRequest.expectedResponseSchemaRefFingerprint ??
    hostRequest.diagnostics?.agentRuntimeExpectedResponseSchemaRefFingerprint;
  const shouldBindExpectedRefs = expectedValue != null || expectedSchema != null;
  if (translated === resolution && !shouldBindExpectedRefs) return result;
  if (translated.status !== 0 || translated.responseValueImageBytes.byteLength === 0) return result;
  const payload = decodeCanonicalValueImage(translated.responseValueImageBytes).payload;
  return {
    ...result,
    resolutionInputBytes: encodeResolutionInputBytes({
      ...translated,
      responseValueImageBytes: shouldBindExpectedRefs
        ? encodeCanonicalValueImage({
            boundaryValueFingerprint: expectedValue,
            codecSchemaDescriptorFingerprint: expectedSchema,
            bytes: payload,
            dynamicSize: true,
          })
        : translated.responseValueImageBytes,
    }),
    diagnostics: {
      ...result.diagnostics,
      ...(shouldBindExpectedRefs ? { agentRuntimeResponseBoundToExpectedRefs: true } : {}),
      ...(translated === resolution ? {} : { agentRuntimeTranslatedResponseStatus: 'not_found' }),
    },
  };
}

function translateAgentRuntimeResolution(resolution) {
  if (resolution.status !== 1) return resolution;
  return {
    ...resolution,
    status: 0,
    responseValueImageBytes: encodeCanonicalValueImage({
      bytes: fromUtf8(stableJson({ status: 'not_found' })),
      dynamicSize: true,
    }),
  };
}

function agentRuntimeExpectedResponseDiagnostics(request) {
  return {
    agentRuntimeExpectedResponseValueRefFingerprint: optionalFingerprintHex(request.expectedResponseValueRefFingerprint),
    agentRuntimeExpectedResponseSchemaRefFingerprint: optionalFingerprintHex(request.expectedResponseSchemaRefFingerprint),
  };
}

function optionalFingerprintHex(value) {
  if (value == null) return null;
  return `0x${BigInt(value).toString(16).padStart(16, '0')}`;
}

function tryDecodeCanonicalValueImage(bytes, request) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (!hasCanonicalValueImageHeader(data)) return null;
  return decodeCanonicalValueImage(data, request);
}

function hasCanonicalValueImageHeader(data) {
  if (data.byteLength < 8) return false;
  const view = new DataView(data.buffer, data.byteOffset, 8);
  return view.getUint32(0, true) === 1 && view.getUint32(4, true) === 1;
}

function canonicalView(data, offset, length) {
  if (offset > data.byteLength || length > data.byteLength - offset) fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_MALFORMED');
  return new DataView(data.buffer, data.byteOffset + offset, length);
}

function canonicalOptionalTag(data, offset) {
  if (offset >= data.byteLength) fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_MALFORMED');
  const tag = data[offset];
  if (tag !== 0 && tag !== 1) fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_MALFORMED');
  return tag;
}

function canonicalPortableBytes(data, offset) {
  const length = Number(canonicalView(data, offset, 8).getBigUint64(0, true));
  if (!Number.isSafeInteger(length)) fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_MALFORMED');
  const start = offset + 8;
  const end = start + length;
  if (end > data.byteLength) fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_MALFORMED');
  return { payload: data.slice(start, end), offset: end };
}

function readCanonicalOptional(data, offset, width, readValue) {
  const tag = canonicalOptionalTag(data, offset);
  if (tag === 0) return { value: null, offset: offset + 1 };
  const valueOffset = offset + 1;
  const next = valueOffset + width;
  if (next > data.byteLength) fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_MALFORMED');
  return { value: readValue(data, valueOffset), offset: next };
}

function readCanonicalU32(data, offset) {
  return canonicalView(data, offset, 4).getUint32(0, true);
}

function readCanonicalU64(data, offset) {
  return canonicalView(data, offset, 8).getBigUint64(0, true);
}

function readCanonicalBool(data, offset) {
  if (offset >= data.byteLength) fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_MALFORMED');
  const value = data[offset];
  if (value !== 0 && value !== 1) fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_MALFORMED');
  return { value: value === 1, offset: offset + 1 };
}

function decodeCanonicalValueImage(bytes, request = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  let offset = 0;
  if (readCanonicalU32(data, offset) !== 1) fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_UNSUPPORTED');
  offset += 4;
  if (readCanonicalU32(data, offset) !== 1) fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_UNSUPPORTED');
  offset += 4;
  const embeddedFingerprint = readCanonicalU64(data, offset);
  offset += 8;
  const valueTable = readCanonicalOptional(data, offset, 4, readCanonicalU32);
  offset = valueTable.offset;
  const boundaryValue = readCanonicalOptional(data, offset, 8, readCanonicalU64);
  offset = boundaryValue.offset;
  const codecSchema = readCanonicalOptional(data, offset, 8, readCanonicalU64);
  offset = codecSchema.offset;
  const dynamicSize = readCanonicalBool(data, offset);
  offset = dynamicSize.offset;
  const decoded = canonicalPortableBytes(data, offset);
  const diagnosticTypeLabel = readCanonicalOptionalPortableBytes(data, decoded.offset);
  offset = diagnosticTypeLabel.offset;
  if (offset !== data.byteLength) fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_TRAILING_BYTES');
  const actualFingerprint = fingerprintValueImage({
    valueTableId: valueTable.value,
    boundaryValueFingerprint: boundaryValue.value,
    codecSchemaDescriptorFingerprint: codecSchema.value,
    dynamicSize: dynamicSize.value,
    diagnosticTypeLabel: diagnosticTypeLabel.value,
    bytes: decoded.payload,
  });
  if (embeddedFingerprint !== actualFingerprint) fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_FINGERPRINT');
  const requestPayloadRef = request.payloadValueRefFingerprint;
  if (requestPayloadRef != null && boundaryValue.value !== BigInt(requestPayloadRef)) {
    fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_PAYLOAD_REF');
  }
  const requestPayloadSchemaRef = request.payloadSchemaRefFingerprint;
  if (requestPayloadSchemaRef != null && codecSchema.value !== BigInt(requestPayloadSchemaRef)) {
    fail('ERR_AGENT_RUNTIME_VALUE_IMAGE_PAYLOAD_SCHEMA_REF');
  }
  return {
    payload: decoded.payload,
    boundaryValueFingerprint: boundaryValue.value,
    codecSchemaDescriptorFingerprint: codecSchema.value,
    fingerprint: actualFingerprint,
  };
}

function readCanonicalOptionalPortableBytes(data, offset) {
  const tag = canonicalOptionalTag(data, offset);
  if (tag === 0) return { value: null, offset: offset + 1 };
  const decoded = canonicalPortableBytes(data, offset + 1);
  return { value: decoded.payload, offset: decoded.offset };
}

function agentRuntimePayloadBytes(payloadValueImageBytes, request) {
  const decoded = tryDecodeCanonicalValueImage(payloadValueImageBytes, request);
  if (decoded) {
    if (decoded.payload.byteLength === 0) fail('ERR_AGENT_RUNTIME_EMPTY_PAYLOAD_UNSUPPORTED', 'agent runtime HostRequest payload did not carry request bytes');
    return { requestBytes: decoded.payload, agentRuntimePayloadDecoded: true, agentRuntimePayloadFormat: 'world.frame.value_image' };
  }
  const portable = decodeAgentRuntimePayloadValueImage(payloadValueImageBytes);
  assertLegacyAgentRuntimePayloadMatchesRequest(portable, request);
  if (portable.rootArgumentImageBytes.byteLength > 0) {
    return {
      requestBytes: portable.rootArgumentImageBytes,
      agentRuntimePayloadDecoded: true,
      agentRuntimePayloadFormat: portable.format,
    };
  }
  fail('ERR_AGENT_RUNTIME_EMPTY_PAYLOAD_UNSUPPORTED', 'agent runtime HostRequest payload did not carry request bytes');
}

function assertLegacyAgentRuntimePayloadMatchesRequest(portable, request = {}) {
  const refs = legacyAgentRuntimePayloadRefs(request);
  if (refs.commandFingerprint == null || refs.bindingFingerprint == null) {
    fail('ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_FRAME_REF');
  }
  if (portable.commandFingerprint !== BigInt(refs.commandFingerprint)) {
    fail('ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_COMMAND_REF');
  }
  if (portable.bindingFingerprint !== BigInt(refs.bindingFingerprint)) {
    fail('ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_BINDING_REF');
  }
  if (request.worldPortId != null && portable.worldPortId !== Number(request.worldPortId)) {
    fail('ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_WORLD_PORT');
  }
}

function legacyAgentRuntimePayloadRefs(request) {
  const frameRefs = request.frameRequestBytes != null
    ? decodeAgentRuntimeFrameRequest(request.frameRequestBytes)
    : null;
  const legacyRefs = request.commandFingerprint != null || request.bindingFingerprint != null
    ? {
        commandFingerprint: request.commandFingerprint,
        bindingFingerprint: request.bindingFingerprint,
      }
    : null;
  // HostRequest targetRefFingerprint and pendingPortFingerprint are World routing refs,
  // not the frame command/binding refs carried by the legacy payload wrapper.
  if (legacyRefs && frameRefs) assertLegacyPayloadRefPairMatches(legacyRefs, frameRefs);
  if (frameRefs?.worldPortId != null && request.worldPortId != null && frameRefs.worldPortId !== Number(request.worldPortId)) {
    fail('ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_WORLD_PORT');
  }
  return legacyRefs ?? frameRefs ?? { commandFingerprint: null, bindingFingerprint: null };
}

function assertLegacyPayloadRefPairMatches(actual, expected) {
  if (actual.commandFingerprint == null || actual.bindingFingerprint == null ||
    expected.commandFingerprint == null || expected.bindingFingerprint == null) {
    fail('ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_FRAME_REF');
  }
  if (BigInt(actual.commandFingerprint) !== BigInt(expected.commandFingerprint)) {
    fail('ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_COMMAND_REF');
  }
  if (BigInt(actual.bindingFingerprint) !== BigInt(expected.bindingFingerprint)) {
    fail('ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_BINDING_REF');
  }
}

function decodeAgentRuntimeFrameRequest(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  let offset = 0;
  const view = (length) => {
    if (offset > data.byteLength || length > data.byteLength - offset) fail('ERR_AGENT_RUNTIME_FRAME_REQUEST_MALFORMED');
    const value = new DataView(data.buffer, data.byteOffset + offset, length);
    offset += length;
    return value;
  };
  const u32 = () => view(4).getUint32(0, true);
  const u64 = () => view(8).getBigUint64(0, true);
  const portableBytes = () => {
    const length = u32();
    if (offset > data.byteLength || length > data.byteLength - offset) fail('ERR_AGENT_RUNTIME_FRAME_REQUEST_MALFORMED');
    const value = data.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const format = new TextDecoder().decode(portableBytes());
  if (format !== 'world.appliance.frame_request.v1') fail('ERR_AGENT_RUNTIME_FRAME_REQUEST_UNSUPPORTED');
  u64();
  const commandFingerprint = u64();
  u64();
  u64();
  const worldPortId = u32();
  const bindingFingerprint = u64();
  u64();
  u64();
  u64();
  if (offset !== data.byteLength) fail('ERR_AGENT_RUNTIME_FRAME_REQUEST_MALFORMED');
  return { commandFingerprint, bindingFingerprint, worldPortId };
}

function decodeAgentRuntimePayloadValueImage(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  let offset = 0;
  const view = (length) => {
    if (offset > data.byteLength || length > data.byteLength - offset) fail('ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_MALFORMED');
    const value = new DataView(data.buffer, data.byteOffset + offset, length);
    offset += length;
    return value;
  };
  const u32 = () => view(4).getUint32(0, true);
  const u64 = () => view(8).getBigUint64(0, true);
  const portableBytes = () => {
    const length = u32();
    if (offset > data.byteLength || length > data.byteLength - offset) fail('ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_MALFORMED');
    const value = data.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const format = new TextDecoder().decode(portableBytes());
  if (format !== 'world.appliance.payload_value_image.v1') fail('ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_UNSUPPORTED');
  const commandFingerprint = u64();
  const bindingFingerprint = u64();
  const worldPortId = u32();
  const rootArgumentImageBytes = portableBytes();
  if (offset !== data.byteLength) fail('ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_TRAILING_BYTES');
  return { format, commandFingerprint, bindingFingerprint, worldPortId, rootArgumentImageBytes };
}

async function runRecover(args, io, storePath) {
  const runId = valueAfter(args, '--run');
  const branchId = valueAfter(args, '--branch') ?? 'main';
  const store = new DirectoryStore(storePath);
  await store.acquireLock();
  try {
    const scan = await store.recover();
    const effectReconciliation = runId
      ? await recoverEffects(store, runId, branchId)
      : null;
    io.stdout.write(`${JSON.stringify(redact({
      command: 'recover',
      ok: true,
      mode: 'json',
      store: storePath,
      scan: summarizeRecoveryScan(scan),
      effectReconciliation,
      diagnostics: {
        workerExecuted: false,
        driversInvoked: false,
        runHeadMutated: false,
        worldEvidenceAuthored: false,
        completeIdempotencyKeyBytesOmitted: true,
      },
    }), null, 2)}\n`);
    return 0;
  } finally {
    await store.releaseLock();
  }
}

async function recoverEffects(store, runId, branchId) {
  const head = await store.readHead(runId, branchId);
  const parentTurnClosureFingerprint = head.updateDiagnostics?.parentTurnClosureFingerprint;
  if (typeof parentTurnClosureFingerprint !== 'string' || parentTurnClosureFingerprint.length === 0) {
    return {
      runId,
      branchId,
      committedCount: 0,
      parentTurnClosureFingerprint: null,
    };
  }
  const journal = new EffectJournal({
    store,
    runId,
    branchId,
    parentTurnClosureFingerprint,
  });
  const reconciliation = await journal.reconcileCommittedHead(head);
  return {
    runId,
    branchId,
    committedCount: reconciliation.committedCount,
    parentTurnClosureFingerprint: reconciliation.parentTurnClosureFingerprint,
  };
}

async function inspectStore(store, storePath, runId, branchId) {
  const run = await store.getRun(runId);
  const head = await store.readHead(runId, branchId);
  const effects = (await store.listEffectRecords(runId)).filter((effect) => effect.branchId === branchId);
  const closureBytes = await store.getBlob(head.turnClosureRef);
  return {
    command: 'inspect',
    ok: true,
    mode: 'json',
    store: storePath,
    run: {
      runId: run.runId,
      applicationId: run.applicationId,
      branchId,
      receiverPolicyRef: run.receiverPolicyRef,
    },
    head: {
      generation: head.generation,
      status: head.status,
      turnClosureWorldFingerprint: head.turnClosureWorldFingerprint,
      resultingStateFingerprint: head.resultingStateFingerprint,
      chronicleCursor: head.chronicleCursor,
      archiveMomentFingerprint: head.archiveMomentFingerprint,
      archiveSealFingerprint: head.archiveSealFingerprint,
      closureByteSize: closureBytes.byteLength,
    },
    effects: summarizeEffectStates(effects),
    diagnostics: {
      workerExecuted: false,
      driversInvoked: false,
      worldEvidenceAuthored: false,
    },
  };
}

async function replayStoreRun(store, storePath, runId, branchId) {
  const run = await store.getRun(runId);
  const head = await store.readHead(runId, branchId);
  const closureBytes = await store.getBlob(head.turnClosureRef);
  const parentTurnClosureFingerprint = head.updateDiagnostics?.parentTurnClosureFingerprint;
  if (typeof parentTurnClosureFingerprint !== 'string' || parentTurnClosureFingerprint.length === 0) {
    fail('ERR_AGENT_RUNTIME_REPLAY_HEAD_PARENT_REQUIRED', 'agent replay requires a head with committed parent TurnClosure diagnostics');
  }
  const committedEffectIds = head.updateDiagnostics?.committedEffectIds;
  if (!Array.isArray(committedEffectIds) || committedEffectIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    fail('ERR_AGENT_RUNTIME_REPLAY_EFFECT_IDS_REQUIRED', 'agent replay requires committed effect id diagnostics');
  }
  if (new Set(committedEffectIds).size !== committedEffectIds.length) {
    fail('ERR_AGENT_RUNTIME_REPLAY_EFFECT_IDS_DUPLICATE', 'agent replay requires unique committed effect id diagnostics');
  }
  const journal = new EffectJournal({ store, runId, branchId, parentTurnClosureFingerprint });
  const reconciliation = await journal.reconcileCommittedHead(head);
  const effects = (await store.listEffectRecords(runId)).filter((effect) => effect.branchId === branchId);
  const retained = effects.filter((effect) => (
    effect.parentTurnClosureFingerprint === parentTurnClosureFingerprint &&
    effect.state === EffectState.closureCommitted &&
    committedEffectIds.includes(effect.idempotencyKeyWorldFingerprint)
  ));
  const retainedIds = new Set(retained.map((effect) => effect.idempotencyKeyWorldFingerprint));
  const missingEffectIds = committedEffectIds.filter((id) => !retainedIds.has(id));
  return {
    command: 'replay',
    ok: missingEffectIds.length === 0,
    mode: 'json',
    store: storePath,
    run: {
      runId: run.runId,
      applicationId: run.applicationId,
      branchId,
    },
    head: {
      generation: head.generation,
      status: head.status,
      turnClosureWorldFingerprint: head.turnClosureWorldFingerprint,
      resultingStateFingerprint: head.resultingStateFingerprint,
      closureByteSize: closureBytes.byteLength,
    },
    replay: {
      parentTurnClosureFingerprint,
      expectedEffectCount: committedEffectIds.length,
      retainedEffectCount: retained.length,
      reconciledSubmittedEffectCount: reconciliation.committedCount,
      missingEffectIds,
      freshEffectCount: 0,
      completed: missingEffectIds.length === 0,
    },
    effects: summarizeEffectStates(effects),
    diagnostics: {
      workerExecuted: false,
      driversInvoked: false,
      freshModelEffects: 0,
      freshFileEffects: 0,
      retainedEffectsReused: missingEffectIds.length === 0,
      worldEvidenceAuthored: false,
    },
  };
}

async function inspectEffects(store, storePath, runId) {
  const effects = await store.listEffectRecords(runId);
  return {
    command: 'effects',
    ok: true,
    mode: 'json',
    store: storePath,
    runId,
    effects: effects.map(summarizeEffectRecord),
    diagnostics: {
      completeIdempotencyKeyBytesOmitted: true,
      workerExecuted: false,
      driversInvoked: false,
    },
  };
}

function summarizeEffectStates(effects) {
  const states = {};
  for (const effect of effects) states[effect.state] = (states[effect.state] ?? 0) + 1;
  return { total: effects.length, states };
}

function createInstallManifestBytes({ applicationId, wasmRef, imageRef, imageWorldFingerprint }) {
  return fromUtf8(`${JSON.stringify({
    kind: 'world-host.install-summary',
    applicationId,
    release: carrierVersionSummary(),
    universalWasmRef: summarizeBlobRef(wasmRef),
    executableImageRef: summarizeBlobRef(imageRef),
    executableImageWorldFingerprint: imageWorldFingerprint,
    source: 'host-generated-install-summary',
    worldAuthoredEvidence: false,
    diagnostics: {
      hostChecksumsOnly: true,
      worldFingerprintDerivedFromSha256: false,
    },
  }, null, 2)}\n`);
}

function summarizeRecoveryScan(scan) {
  return {
    temporaryFilesIgnored: scan.temporaryFilesIgnored ?? [],
    temporaryFileCount: scan.temporaryFilesIgnored?.length ?? 0,
    orphanBlobs: (scan.orphanBlobs ?? []).map(summarizeBlobRef),
    orphanBlobCount: scan.orphanBlobs?.length ?? 0,
    garbageCollected: scan.garbageCollected,
    multiProcessWriterSupport: scan.multiProcessWriterSupport,
  };
}

function summarizeApplicationInstall(app) {
  return {
    applicationId: app.applicationId,
    universalWasmChecksum: app.universalWasmChecksum,
    universalWasmByteLength: app.universalWasmByteLength,
    worldProtocolVersion: app.worldProtocolVersion,
    applianceAbiVersion: app.applianceAbiVersion,
    executableImageWorldFingerprint: app.executableImageWorldFingerprint,
  };
}

function summarizeRunLifecycle({ command, storePath, run, branchId, created, head, advance, driversInvokedByCli = false }) {
  const advanceEffectCount = countAdvanceEffects(advance);
  return {
    command,
    ok: true,
    mode: 'json',
    store: storePath,
    run: {
      runId: run.runId,
      applicationId: run.applicationId,
      branchId,
      created,
    },
    head: head ? {
      generation: head.generation,
      status: head.status,
      turnClosureWorldFingerprint: head.turnClosureWorldFingerprint,
      resultingStateFingerprint: head.resultingStateFingerprint,
      rootResultFingerprint: head.updateDiagnostics?.inspectedTurnClosure?.rootResultFingerprint ?? null,
    } : null,
    advance: advance ? {
      status: advance.status,
      workerStatus: advance.workerStatus ?? null,
      closureRef: summarizeBlobRef(advance.closureRef ?? advance.orphanClosureRef),
      effectCount: advanceEffectCount,
      submittedEffectCount: advance.submittedEffects?.length ?? 0,
      unresolvedHostRequestCount: advance.unresolvedHostRequests?.length ?? 0,
      branchConflict: advance.status === 'branch_conflict',
    } : null,
    diagnostics: {
      workerExecuted: advance !== null,
      runCreated: created,
      schedulerLoop: false,
      driversInvokedByCli: advance !== null && driversInvokedByCli && advanceEffectCount > 0,
      runHeadMutatedDirectlyByCli: false,
      worldEvidenceAuthored: false,
    },
  };
}

function countAdvanceEffects(advance) {
  return (advance?.effects?.length ?? 0) + (advance?.submittedEffects?.length ?? 0);
}

function summarizeCarrierExport(carrierExport) {
  return {
    carrierExportVersion: carrierExport.carrierExportVersion,
    release: carrierExport.release,
    selectedRunId: carrierExport.selectedRunId,
    selectedBranchId: carrierExport.selectedBranchId,
    authorityCarried: carrierExport.authorityCarried,
    blobCount: carrierExport.bundle?.blobs?.length ?? 0,
    effectCount: carrierExport.bundle?.effects?.length ?? 0,
  };
}

function summarizeImportedRun(imported) {
  return {
    runId: imported.run.runId,
    branchId: imported.branchId,
    authorityImported: imported.authorityImported,
    receiverPolicyApplied: imported.receiverPolicyApplied,
  };
}

function summarizeEffectRecord(record) {
  return {
    runId: record.runId,
    branchId: record.branchId,
    parentTurnClosureFingerprint: record.parentTurnClosureFingerprint,
    hostRequestFingerprint: record.hostRequestFingerprint,
    idempotencyKeyWorldFingerprint: record.idempotencyKeyWorldFingerprint,
    completeIdempotencyKeyBytesOmitted: true,
    actuatorRef: record.actuatorRef,
    descriptorFingerprint: record.descriptorFingerprint,
    requestBytesChecksum: record.requestBytesChecksum,
    state: record.state,
    attemptCount: record.attemptCount,
    driverRecoveryClass: record.driverRecoveryClass,
    resolutionInputRef: summarizeBlobRef(record.resolutionInputRef),
    hostClaimRef: summarizeBlobRef(record.hostClaimRef),
    driverTransactionRef: record.driverTransactionRef ?? null,
    diagnostics: sanitizeEffectDiagnostics(record.diagnostics ?? {}),
  };
}

function sanitizeEffectDiagnostics(value) {
  if (Array.isArray(value)) return value.map(sanitizeEffectDiagnostics);
  if (!value || typeof value !== 'object') return value;
  if (value.format === 'world-idempotency-key-bytes.hex' && typeof value.bytesHex === 'string') {
    return { format: value.format, completeIdempotencyKeyBytesOmitted: true };
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'bytesHex') {
      out.hexBytesOmitted = true;
    } else if (key === 'idempotencyKeyBytes') {
      out.idempotencyKeyBytesOmitted = true;
    } else {
      out[key] = sanitizeEffectDiagnostics(item);
    }
  }
  return out;
}

function summarizeBlobRef(ref) {
  if (!ref) return null;
  return {
    algorithm: ref.algorithm,
    checksum: ref.checksum,
    byteLength: ref.byteLength,
  };
}

export async function runExample(name, io) {
  const modules = {
    'file-rewrite-agent': '../../examples/file_rewrite_agent/run.mjs',
    'agent-skeleton': '../../examples/agent_runtime/skeleton/run.mjs',
    'agent-fixture': '../../examples/agent_runtime/fixture_file_rewrite/run.mjs',
    'agent-replay': '../../examples/agent_runtime/replay/run.mjs',
    'agent-retry': '../../examples/agent_runtime/retry/run.mjs',
    'agent-migration': '../../examples/agent_runtime/migration/run.mjs',
    'agent-branching': '../../examples/agent_runtime/branching/run.mjs',
    'crash-recovery': '../../examples/crash_recovery/run.mjs',
    migration: '../../examples/migration/run.mjs',
    branching: '../../examples/branching/run.mjs',
  };
  const specifier = modules[name];
  if (!specifier) {
    io.stderr.write(`unknown example: ${name ?? ''}\n`);
    return 2;
  }
  const module = await import(specifier);
  const result = await module.runExample();
  io.stdout.write(`${JSON.stringify(redact(result), null, 2)}\n`);
  return 0;
}

const SECRET_PATTERN = /credential|authorization|bearer|token|secret|password|(?:api|access|private)[_-]?key/i;

export function redact(value) {
  if (typeof value === 'string') return SECRET_PATTERN.test(value) ? '[redacted]' : value;
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SECRET_PATTERN.test(key) ? '[redacted]' : redact(child),
  ]));
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

function positionalAfterCommand(args) {
  const value = args[1];
  return value && !value.startsWith('--') ? value : null;
}

function forwardAgentRunArgs(args) {
  const forwarded = ['run', ...args.slice(1)];
  if (!valueAfter(forwarded, '--app') && !positionalAfterCommand(forwarded)) {
    const applicationId = positionalAfterOptions(args, 1);
    if (applicationId) forwarded.push('--app', applicationId);
  }
  return forwarded;
}

function positionalAfterOptions(args, start) {
  const optionsWithValues = new Set(['--agent-scenario', '--app', '--branch', '--input', '--name', '--pack', '--run', '--sandbox-root', '--scenario', '--store']);
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--')) {
      if (optionsWithValues.has(arg)) index += 1;
      continue;
    }
    return arg;
  }
  return null;
}

function requiredOption(args, name) {
  const value = valueAfter(args, name);
  if (!value) throw new Error(`missing required option: ${name}`);
  return value;
}
