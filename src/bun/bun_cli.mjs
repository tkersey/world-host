import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

import { createApplicationRecord } from '../core/application.mjs';
import { exportCarrierRun, forkRunBranch, importCarrierRun } from '../core/migration.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../core/run.mjs';
import { assertBlobRef, fail, fromUtf8, makeBlobRef } from '../core/store.mjs';
import { RunController } from '../core/worker.mjs';
import { createRunPolicy, preflightCapabilities } from '../core/capabilities.mjs';
import { encodeBootTurnInput, encodeRestoreTurnInput } from '../protocol/world_appliance_wire_codec.mjs';
import { inspectTurnOutput, summarizeTurnClosureForRunHead } from '../protocol/world_universal_appliance_codec.mjs';
import { carrierVersionSummary } from '../protocol/world_manifest.mjs';
import { EffectJournal } from '../core/effect_journal.mjs';
import { BunWorldWorker } from './bun_worker.mjs';
import { DirectoryStore } from '../stores/directory_store.mjs';

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
  if (command === 'inspect' || command === 'effects') {
    const storePath = valueAfter(args, '--store');
    const runId = valueAfter(args, '--run');
    if (storePath && runId) return await runStoreDiagnostics(command, args, io, storePath, runId);
    if (args.includes('--store') || args.includes('--run')) {
      throw new Error(`missing required option: ${storePath ? '--run' : '--store'}`);
    }
    io.stdout.write(`${JSON.stringify(redact({
      command,
      ok: true,
      mode: args.includes('--json') ? 'json' : 'human',
      diagnostics: { store: valueAfter(args, '--store') ?? null },
    }), null, 2)}\n`);
    return 0;
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
  io.stdout.write('world-host commands: install, doctor, run, resume, inspect, effects, recover, fork, export, import, run-example, version\n');
  return command === 'help' || command === '--help' || command === '-h' ? 0 : 2;
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
    })), null, 2)}\n`);
    return 0;
  } finally {
    await store.releaseLock();
  }
}

async function runInstall(args, io, storePath) {
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
      worldProtocolVersion: versions.world,
      applianceAbiVersion: versions.applianceAbi,
      executableImageRef: imageRef,
      executableImageWorldFingerprint: imageWorldFingerprint,
      applianceManifestRef: manifestRef,
      requiredActuators: [],
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
  const byteLength = application.installationDiagnostics?.wasmByteLength;
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

async function runImport(args, io, storePath) {
  const packagePath = requiredOption(args, '--package');
  const receiverRunId = valueAfter(args, '--run');
  const carrierExport = JSON.parse(await readFile(packagePath, 'utf8'));
  const store = new DirectoryStore(storePath);
  await store.acquireLock();
  try {
    const imported = await importCarrierRun(store, carrierExport, {
      runId: receiverRunId,
      preflight: async (candidate) => preflightCapabilities({
        application: candidate.bundle.application,
        currentHead: candidate.bundle.head,
        pendingRequests: pendingRequestsForImportedHead(candidate),
        drivers: [],
        policy: createRunPolicy(),
      }),
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
    worldProtocolVersion: app.worldProtocolVersion,
    applianceAbiVersion: app.applianceAbiVersion,
    executableImageWorldFingerprint: app.executableImageWorldFingerprint,
  };
}

function summarizeRunLifecycle({ command, storePath, run, branchId, created, head, advance }) {
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
    } : null,
    advance: advance ? {
      status: advance.status,
      workerStatus: advance.workerStatus ?? null,
      closureRef: summarizeBlobRef(advance.closureRef ?? advance.orphanClosureRef),
      effectCount: advance.effects?.length ?? 0,
      unresolvedHostRequestCount: advance.unresolvedHostRequests?.length ?? 0,
      branchConflict: advance.status === 'branch_conflict',
    } : null,
    diagnostics: {
      workerExecuted: advance !== null,
      runCreated: created,
      schedulerLoop: false,
      driversInvokedByCli: false,
      runHeadMutatedDirectlyByCli: false,
      worldEvidenceAuthored: false,
    },
  };
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

function requiredOption(args, name) {
  const value = valueAfter(args, name);
  if (!value) throw new Error(`missing required option: ${name}`);
  return value;
}
