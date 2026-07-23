import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { clearTimeout as clearHostTimeout, setTimeout as setHostTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { inspect as inspectValue } from 'node:util';

import { createApplicationRecord } from '../core/application.mjs';
import { assertDriverManifest, authorityLabelDeclaresNetwork } from '../core/actuator.mjs';
import { exportCarrierRun, forkRunBranch, importCarrierRun } from '../core/migration.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../core/run.mjs';
import { assertBlobRef, fail, fromUtf8, makeBlobRef, stableJson } from '../core/store.mjs';
import { RunController, effectRecordHostReplyFingerprint, worldHostRequestToEffectRequest } from '../core/worker.mjs';
import { CapabilityReport, createRunPolicy, preflightCapabilities } from '../core/capabilities.mjs';
import { decodeApplianceManifest, decodeResolutionInputBytes, encodeBootTurnInput, encodeResolutionInputBytes, encodeRestoreTurnInput, encodeTurnInput, operationBoot } from '../protocol/world_appliance_wire_codec.mjs';
import { encodeCanonicalValueImage, fingerprintValueImage } from '../protocol/world_loaded_value_codec.mjs';
import { inspectTurnOutput, summarizeTurnClosureForRunHead } from '../protocol/world_universal_appliance_codec.mjs';
import { carrierVersionSummary } from '../protocol/world_manifest.mjs';
import { EffectJournal, EffectState, assertResolutionAccepted } from '../core/effect_journal.mjs';
import { assertCapabilityResolutionBoundary, assertNoWorldEvidenceKeys, defineCapabilityDriver } from '../core/capability_driver.mjs';
import { FixtureAgentModelDriver } from '../drivers/fixture_agent_model_driver.mjs';
import {
  assertCapabilityPackDriverManifestMatches,
  assertReceiverCapabilityPackDriverManifestMatches,
  createReceiverCapabilityPackDriver,
} from '../drivers/capability_pack_driver_registry.mjs';
import { SandboxFileDriver } from '../drivers/sandbox_file_driver.mjs';
import { CapabilitySidecar, CapabilitySidecarCommand } from '../sidecars/capability_sidecar.mjs';
import { BunWorldWorker } from './bun_worker.mjs';
import { DirectoryStore } from '../stores/directory_store.mjs';

const AGENT_MODEL_ACTUATOR = 'world:actuator-ref:4f0c7160f25c4c62';
const AGENT_MODEL_DESCRIPTOR = 'world:descriptor:be73177924a6b377';
const AGENT_MODEL_ACTUATION_CLASS = 'world:actuation-class:2';
const AGENT_FILE_ACTUATOR = 'world:actuator-ref:d5e4b1b427522cf2';
const AGENT_FILE_DESCRIPTOR = 'world:descriptor:74afc8c3b2fe4c33';
const AGENT_FILE_ACTUATION_CLASS = 'world:actuation-class:1';
const AGENT_RUNTIME_FIXTURE_OUTPUT = 'actuate updated the fixture';
const DEFAULT_CAPABILITY_PACK_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_CAPABILITY_PACK_PROBE_CHILD_OUTPUT_BYTES = 1024 * 1024;
const CAPABILITY_PACK_PROBE_SETTLE_MS = 25;
const CAPABILITY_PACK_PROBE_CHILD_ARG = '--world-host-capability-probe-child';
const CAPABILITY_PACK_PROBE_IMPORT_ROOT_ENV = 'WORLD_HOST_CAPABILITY_PACK_PROBE_IMPORT_ROOT';
const CAPABILITY_PACK_PROBE_FILE_ROOT_ENV = 'WORLD_HOST_CAPABILITY_PACK_PROBE_FILE_ROOT';
const CAPABILITY_PACK_PROBE_FILE_ROOT_PREFIX = 'world-host-capability-probe-files-';
const CAPABILITY_PACK_PROBE_FILE_NAME = 'world-host-abi-probe.txt';
const CAPABILITY_PACK_PROBE_FILE_CONTENT = 'world-host capability pack ABI probe\n';
const DEFINE_PROPERTY = Object.defineProperty;
const GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const DELETE_PROPERTY = Reflect.deleteProperty;
let capabilityPackProbeGlobalLock = Promise.resolve();
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
  if (command === 'app') {
    const { runApplicationV1Cli } = await import('./application_v1_cli.mjs');
    return await runApplicationV1Cli(args.slice(1), io, options.applicationV1 ?? {});
  }
  if (command === 'agent') return await runAgentCommand(args.slice(1), io, options);
  if (command === 'capability') return await runCapabilityCommand(args.slice(1), io, options);
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
    if (storePath && command === 'import') return await runImport(args, io, storePath, options);
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
  io.stdout.write('world-host commands: app, agent, capability, install, doctor, run, resume, inspect, effects, recover, fork, export, import, run-example, version\n');
  return command === 'help' || command === '--help' || command === '-h' ? 0 : 2;
}

async function runCapabilityCommand(args, io, options = {}) {
  const subcommand = args[0] ?? 'help';
  if (subcommand === 'check-pack') {
    const pack = requiredOption(args, '--pack');
    const trustedExecuteAdapters = args.includes('--trusted-execute-adapters');
    const {
      assertCapabilityConformanceReceipt,
      assertCapabilityPackChecksums,
      capabilityConformanceReceiptFingerprint,
      validateCapabilityPackManifest,
    } = await import('../core/capability_pack.mjs');
    const manifest = JSON.parse(await readPackFile(pack, 'manifest.json', 'utf8'));
    const checked = await validateCapabilityPackManifest(manifest, { requirePackFingerprint: true, verifyFingerprint: true });
    const artifacts = {};
    for (const item of checked.checksums) artifacts[item.path] = new Uint8Array(await readPackFile(pack, item.path));
    await assertCapabilityPackChecksums(checked, artifacts);
    if (checked.conformanceCorpusFingerprint != null) {
      const receipt = assertCapabilityConformanceReceipt(JSON.parse(await readPackFile(pack, 'conformance.json', 'utf8')));
      if (receipt.driverId !== checked.driverId) fail('ERR_CAPABILITY_CONFORMANCE_RECEIPT_MISMATCH', 'conformance receipt driverId does not match manifest');
      if (receipt.packFingerprint !== checked.packFingerprint) fail('ERR_CAPABILITY_CONFORMANCE_RECEIPT_MISMATCH', 'conformance receipt packFingerprint does not match manifest');
      if (receipt.corpusFingerprint !== checked.conformanceCorpusFingerprint) fail('ERR_CAPABILITY_CONFORMANCE_RECEIPT_MISMATCH', 'conformance receipt corpusFingerprint does not match manifest');
      if (await capabilityConformanceReceiptFingerprint(receipt) !== checked.conformanceReceiptFingerprint) {
        fail('ERR_CAPABILITY_CONFORMANCE_RECEIPT_MISMATCH', 'conformance receipt fingerprint does not match manifest');
      }
    }
    assertReceiverCapabilityPackDriverManifestMatches(checked);
    if (trustedExecuteAdapters) {
      const isolatedProbeChild = args.includes(CAPABILITY_PACK_PROBE_CHILD_ARG);
      const isolationDisabled = options.isolateTrustedCapabilityPackAdapters === false;
      if (isolatedProbeChild || isolationDisabled) {
        await assertCapabilityPackAdapterAbi(checked, artifacts, { isolatedProbeChild });
      } else {
        await assertCapabilityPackAdapterAbiIsolated(pack, checked);
      }
    }
    io.stdout.write(`${JSON.stringify(redact({
      command: 'capability check-pack',
      pack,
      driverId: checked.driverId,
      packFingerprint: checked.packFingerprint,
      artifactCount: checked.checksums.length,
      trustedAdapterExecution: trustedExecuteAdapters,
      worldAuthoredEvidence: false,
    }), null, 2)}\n`);
    return 0;
  }
  io.stdout.write('world-host capability commands: check-pack\n');
  return subcommand === 'help' || subcommand === '--help' || subcommand === '-h' ? 0 : 2;
}

async function assertCapabilityPackAdapterAbiIsolated(packRoot, packManifest) {
  const binPath = fileURLToPath(new URL('../../bin/world-host.mjs', import.meta.url));
  let importRoot = null;
  let probeFileRoot = null;
  try {
    importRoot = await mkdtemp(path.join(tmpdir(), 'world-host-capability-adapter-imports-'));
    probeFileRoot = await createCapabilityPackProbeFileRoot();
    const result = await runWorldHostProbeChild([
      'capability',
      'check-pack',
      '--pack',
      packRoot,
      '--trusted-execute-adapters',
      CAPABILITY_PACK_PROBE_CHILD_ARG,
    ], binPath, {
      env: {
        [CAPABILITY_PACK_PROBE_IMPORT_ROOT_ENV]: importRoot,
        [CAPABILITY_PACK_PROBE_FILE_ROOT_ENV]: probeFileRoot,
      },
      timeoutMs: capabilityPackProbeChildTimeoutMs(packManifest),
    });
    if (result.timedOut) {
      fail('ERR_CAPABILITY_PACK_ADAPTER_PROBE_TIMEOUT', 'capability pack adapter probe child timed out', {
        timeoutMs: result.timeoutMs,
        signal: result.signal,
      });
    }
    if (result.outputLimitExceeded) {
      fail('ERR_CAPABILITY_PACK_ADAPTER_PROBE_OUTPUT_TOO_LARGE', 'capability pack adapter probe child output exceeded limit', {
        stream: result.outputLimitExceeded.stream,
        limitBytes: result.outputLimitExceeded.limitBytes,
        signal: result.signal,
      });
    }
    if (result.code === 0) return;
    const childError = parseChildCliError(result.stderr);
    if (childError?.code) {
      fail(childError.code, childError.message ?? childError.code, childError.details ?? {});
    }
    const message = result.stderr.trim() || result.stdout.trim() ||
      `capability pack probe child failed: ${result.signal ?? result.code ?? 'unknown'}`;
    fail('ERR_CAPABILITY_PACK_ADAPTER_PROBE_PROCESS', message, {
      exitCode: result.code,
      signal: result.signal,
    });
  } finally {
    if (importRoot != null) await rm(importRoot, { recursive: true, force: true });
    if (probeFileRoot != null) await rm(probeFileRoot, { recursive: true, force: true });
  }
}

function runWorldHostProbeChild(args, binPath, { env = {}, timeoutMs = capabilityPackProbeTimeoutMs() } = {}) {
  return new Promise((resolve, reject) => {
    const outputLimitBytes = capabilityPackProbeChildOutputBytes();
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
        WORLD_HOST_CLI_ERROR_JSON: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = null;
    let terminating = false;
    let timeoutTimer = null;
    let killTimer = null;
    const clearTimers = () => {
      if (timeoutTimer) clearHostTimeout(timeoutTimer);
      if (killTimer) clearHostTimeout(killTimer);
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(value);
    };
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      child.kill('SIGTERM');
      killTimer = setHostTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 1000);
      killTimer.unref?.();
    };
    const appendOutput = (stream, chunk) => {
      if (outputLimitExceeded) return;
      const text = String(chunk);
      const chunkBytes = Buffer.byteLength(text);
      const currentBytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
      if (currentBytes + chunkBytes > outputLimitBytes) {
        outputLimitExceeded = { stream, limitBytes: outputLimitBytes };
        terminate();
        return;
      }
      if (stream === 'stdout') {
        stdout += text;
        stdoutBytes += chunkBytes;
      } else {
        stderr += text;
        stderrBytes += chunkBytes;
      }
    };
    timeoutTimer = setHostTimeout(() => {
      if (outputLimitExceeded) return;
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeoutTimer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      appendOutput('stdout', chunk);
    });
    child.stderr.on('data', (chunk) => {
      appendOutput('stderr', chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.on('close', (code, signal) => {
      settle({ code, signal, stdout, stderr, timedOut, timeoutMs, outputLimitExceeded });
    });
  });
}

function parseChildCliError(stderr) {
  const lines = String(stderr ?? '').trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && (typeof parsed.code === 'string' || typeof parsed.message === 'string')) {
        return parsed;
      }
    } catch {}
  }
  return null;
}

async function readPackFile(packRoot, relativePath, encoding = null) {
  const root = await safePackRoot(packRoot);
  const target = path.resolve(packRoot, relativePath);
  const info = await lstat(target).catch(() => fail('ERR_CAPABILITY_PACK_ARTIFACT_MISSING', `artifact missing: ${relativePath}`));
  if (info.isSymbolicLink()) fail('ERR_CAPABILITY_PACK_ARTIFACT_UNSAFE', `artifact is a symlink: ${relativePath}`);
  if (!info.isFile()) fail('ERR_CAPABILITY_PACK_ARTIFACT_MISSING', `artifact is not a file: ${relativePath}`);
  const actual = await realpath(target).catch(() => fail('ERR_CAPABILITY_PACK_ARTIFACT_MISSING', `artifact missing: ${relativePath}`));
  if (!pathInside(root, actual)) fail('ERR_CAPABILITY_PACK_ARTIFACT_UNSAFE', `artifact escapes pack root: ${relativePath}`);
  return encoding ? await readFile(actual, encoding) : await readFile(actual);
}

async function safePackRoot(packRoot) {
  const normalizedRoot = path.resolve(packRoot);
  const info = await lstat(normalizedRoot).catch(() => fail('ERR_CAPABILITY_PACK_ROOT_INVALID', `pack root is not readable: ${packRoot}`));
  if (info.isSymbolicLink()) fail('ERR_CAPABILITY_PACK_ROOT_UNSAFE', `pack root is a symlink: ${packRoot}`);
  if (!info.isDirectory()) fail('ERR_CAPABILITY_PACK_ROOT_INVALID', `pack root is not a directory: ${packRoot}`);
  return await realpath(normalizedRoot).catch(() => fail('ERR_CAPABILITY_PACK_ROOT_INVALID', `pack root is not readable: ${packRoot}`));
}

function pathInside(root, target) {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function assertCapabilityPackAdapterAbi(packManifest, artifacts, { isolatedProbeChild = false } = {}) {
  const probeFileRoot = await capabilityPackProbeFileRoot({ isolatedProbeChild });
  try {
    await withDeterministicCapabilityPackProbeNetwork(packManifest, null, async (probeNetwork) => {
      let adapterSnapshotRoot = null;
      let driver;
      let sidecar = false;
      try {
        if (packManifest.adapter.kind === 'receiver') {
          driver = createReceiverCapabilityPackDriver(
            packManifest,
            capabilityPackAdapterOptions(packManifest, probeFileRoot.root),
          );
          await probeNetwork?.assertNoViolations();
        } else if (packManifest.adapter.kind === 'sidecar') {
          if (externalCapabilityPackEffectProbe(packManifest, null)) {
            fail('ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED', 'network sidecar probes must not perform live external effects');
          }
          if (fileCapabilityPackEffectProbe(packManifest, null)) {
            fail('ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED', 'file sidecar probes must not perform live external effects');
          }
          adapterSnapshotRoot = await capabilityPackAdapterSnapshot(packManifest, artifacts);
          driver = new CapabilitySidecar({
            command: packManifest.adapter.command,
            cwd: adapterSnapshotRoot,
            packFingerprint: packManifest.packFingerprint,
          });
          sidecar = true;
        } else {
          return;
        }
        const capabilityDriver = defineCapabilityDriver(driver);
        if (packManifest.canRecover === true && typeof driver.recover !== 'function') fail('ERR_CAPABILITY_PACK_ADAPTER_RECOVER');
        const driverManifest = sidecar
          ? await withCapabilityPackProbeTimeout('manifest', capabilityPackSidecarManifest(driver, packManifest))
          : capabilityDriver.manifest();
        await probeNetwork?.assertNoViolations();
        assertCapabilityPackDriverManifestMatches(packManifest, driverManifest);
        await assertCapabilityPackAdapterProbe(packManifest, capabilityDriver, driverManifest, {
          driver,
          sidecar,
          probeNetwork,
          probeFileRoot: probeFileRoot.root,
        });
      } finally {
        if (adapterSnapshotRoot != null) await rm(adapterSnapshotRoot, { recursive: true, force: true });
      }
    });
  } finally {
    if (probeFileRoot.locallyOwned) await rm(probeFileRoot.root, { recursive: true, force: true });
  }
}

async function capabilityPackSidecarManifest(sidecarDriver, packManifest) {
  const raw = await sidecarDriver.manifest();
  const manifest = assertDriverManifest(raw);
  if (raw.packFingerprint != null && typeof raw.packFingerprint !== 'string') {
    fail('ERR_INVALID_DRIVER_MANIFEST', 'packFingerprint must be a string');
  }
  return raw.packFingerprint == null ? manifest : Object.freeze({ ...manifest, packFingerprint: raw.packFingerprint });
}

async function assertCapabilityPackAdapterProbe(packManifest, capabilityDriver, driverManifest, { driver, sidecar = false, probeNetwork = null, probeFileRoot } = {}) {
  const hostRequests = capabilityPackSidecarProbeHostRequests(driverManifest);
  for (const hostRequest of hostRequests) {
    await assertCapabilityPackAdapterProbeRequest(packManifest, capabilityDriver, driverManifest, hostRequest, {
      driver,
      sidecar,
      probeNetwork,
      probeFileRoot,
    });
  }
}

async function assertCapabilityPackAdapterProbeRequest(packManifest, capabilityDriver, driverManifest, hostRequest, { driver, sidecar = false, probeNetwork = null, probeFileRoot } = {}) {
  const policy = capabilityPackSidecarProbePolicy(driverManifest, hostRequest, probeFileRoot);
  const context = { worldHostCapabilityPackAbiProbe: true, policy };
  probeNetwork?.setProbeHostRequest?.(hostRequest);
  probeNetwork?.setProbePolicy(policy);
  if (sidecar && externalCapabilityPackEffectProbe(driverManifest, hostRequest)) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED', 'network sidecar probes must not perform live external effects');
  }
  probeNetwork?.setNetworkAllowed(networkCapabilityPackEffectProbe(driverManifest, hostRequest));
  probeNetwork?.setPhase('preflight');
  const preflight = await withCapabilityPackProbeTimeout('preflight', capabilityDriver.preflight(context, hostRequest));
  await probeNetwork?.assertNoViolations();
  if (preflight.accepted !== true || preflight.blockers.length > 0) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_PREFLIGHT', 'sidecar adapter ABI probe preflight rejected', { blockers: preflight.blockers });
  }
  probeNetwork?.setPhase('dryRun');
  await withCapabilityPackProbeTimeout('dryRun', capabilityDriver.dryRun(context, hostRequest));
  await probeNetwork?.assertNoViolations();
  probeNetwork?.setPhase('shadow');
  await withCapabilityPackProbeTimeout('shadow', capabilityDriver.shadow(context, hostRequest, { worldHostCapabilityPackAbiProbe: true }));
  await probeNetwork?.assertNoViolations();
  probeNetwork?.beginWorldIdempotencyObservation(capabilityPackProbeWorldIdempotencyObservation(
    packManifest,
    driverManifest,
    hostRequest,
    'resolve',
  ));
  probeNetwork?.setPhase('resolve');
  const resolution = driver.resolve(context, hostRequest);
  probeNetwork?.allowReturnedPromise(resolution);
  if (isThenable(resolution)) {
    probeNetwork?.setPhase('resolve-await');
  } else {
    probeNetwork?.setPhase('resolve-returned');
  }
  const resolvedResolution = await withCapabilityPackProbeTimeout('resolve', resolution);
  probeNetwork?.setPhase('resolve-returned');
  assertCapabilityPackSidecarProbeResolution(
    resolvedResolution,
    hostRequest,
    driverManifest,
    policy,
  );
  probeNetwork?.assertWorldIdempotencyObserved();
  await probeNetwork?.assertNoViolations();
  if (packManifest.canRecover === true) {
    if (typeof capabilityDriver.recover !== 'function') fail('ERR_CAPABILITY_PACK_ADAPTER_RECOVER');
    probeNetwork?.beginWorldIdempotencyObservation(capabilityPackProbeWorldIdempotencyObservation(
      packManifest,
      driverManifest,
      hostRequest,
      'recover',
    ));
    probeNetwork?.setPhase('recover');
    const recoveryResult = driver.recover(context, capabilityPackSidecarProbeEffectRecord(driverManifest, hostRequest));
    probeNetwork?.allowReturnedPromise(recoveryResult);
    if (isThenable(recoveryResult)) {
      probeNetwork?.setPhase('recover-await');
    } else {
      probeNetwork?.setPhase('recover-returned');
    }
    const recovery = await withCapabilityPackProbeTimeout('recover', recoveryResult);
    probeNetwork?.setPhase('recover-returned');
    if (recovery?.operatorInterventionRequired !== true) {
      assertCapabilityPackSidecarProbeResolution(recovery, hostRequest, driverManifest, policy);
    } else {
      assertNoWorldEvidenceKeys(recovery);
    }
    probeNetwork?.assertWorldIdempotencyObserved({ requireObserved: false });
    await probeNetwork?.assertNoViolations();
  }
}

async function withCapabilityPackProbeTimeout(phase, value) {
  const timeoutMs = capabilityPackProbeTimeoutMs();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setHostTimeout(() => reject(capabilityPackProbeTimeoutError(phase, timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve(value), timeout]);
  } finally {
    clearHostTimeout(timer);
  }
}

function capabilityPackProbeTimeoutMs() {
  const parsed = Number.parseInt(process.env.WORLD_HOST_CAPABILITY_PACK_PROBE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CAPABILITY_PACK_PROBE_TIMEOUT_MS;
}

function capabilityPackProbeChildTimeoutMs(packManifest) {
  const phaseTimeoutMs = capabilityPackProbeTimeoutMs();
  const routeCount = Math.max(
    1,
    (packManifest.supportedActuatorRefs?.length ?? 1) *
      (packManifest.supportedDescriptorFingerprints?.length ?? 1) *
      (packManifest.supportedActuationClasses?.length ?? 1) *
      Math.max(1, packManifest.supportedResponseStatuses?.length ?? 1),
  );
  const phasesPerRoute = packManifest.canRecover === true ? 5 : 4;
  const phaseBudget = 2 + (routeCount * phasesPerRoute);
  return (phaseBudget * (phaseTimeoutMs + CAPABILITY_PACK_PROBE_SETTLE_MS)) + Math.max(250, phaseTimeoutMs);
}

function capabilityPackProbeChildOutputBytes() {
  const parsed = Number.parseInt(process.env.WORLD_HOST_CAPABILITY_PACK_PROBE_OUTPUT_BYTES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CAPABILITY_PACK_PROBE_CHILD_OUTPUT_BYTES;
}

function capabilityPackProbeTimeoutError(phase, timeoutMs) {
  return Object.assign(new Error(`capability pack adapter probe timed out during ${phase}`), {
    code: 'ERR_CAPABILITY_PACK_ADAPTER_PROBE_TIMEOUT',
    phase,
    timeoutMs,
  });
}

async function withDeterministicCapabilityPackProbeNetwork(driverManifest, hostRequest, fn) {
  if (driverManifest?.adapter?.kind === 'sidecar') {
    return await withCapabilityPackProbeGlobalLock(fn);
  }
  return await withCapabilityPackProbeGlobalLock(async () => {
    const previousGlobals = {
      fetch: globalThis.fetch,
      WebSocket: globalThis.WebSocket,
      EventSource: globalThis.EventSource,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setImmediate: globalThis.setImmediate,
      clearImmediate: globalThis.clearImmediate,
      bunBuild: globalThis.Bun?.build,
      bunFile: globalThis.Bun?.file,
      bunGlob: globalThis.Bun?.Glob,
      bunMmap: globalThis.Bun?.mmap,
      bunResolve: globalThis.Bun?.resolve,
      bunResolveSync: globalThis.Bun?.resolveSync,
      bunWrite: globalThis.Bun?.write,
      bunSleep: globalThis.Bun?.sleep,
      promiseResolve: globalThis.Promise?.resolve,
      queueMicrotask: globalThis.queueMicrotask,
      Request: globalThis.Request,
    };
    const previousDescriptors = {
      fetch: GET_OWN_PROPERTY_DESCRIPTOR(globalThis, 'fetch'),
      WebSocket: GET_OWN_PROPERTY_DESCRIPTOR(globalThis, 'WebSocket'),
      EventSource: GET_OWN_PROPERTY_DESCRIPTOR(globalThis, 'EventSource'),
      setTimeout: GET_OWN_PROPERTY_DESCRIPTOR(globalThis, 'setTimeout'),
      clearTimeout: GET_OWN_PROPERTY_DESCRIPTOR(globalThis, 'clearTimeout'),
      setInterval: GET_OWN_PROPERTY_DESCRIPTOR(globalThis, 'setInterval'),
      clearInterval: GET_OWN_PROPERTY_DESCRIPTOR(globalThis, 'clearInterval'),
      setImmediate: GET_OWN_PROPERTY_DESCRIPTOR(globalThis, 'setImmediate'),
      clearImmediate: GET_OWN_PROPERTY_DESCRIPTOR(globalThis, 'clearImmediate'),
      bunBuild: globalThis.Bun == null ? undefined : GET_OWN_PROPERTY_DESCRIPTOR(globalThis.Bun, 'build'),
      bunFile: globalThis.Bun == null ? undefined : GET_OWN_PROPERTY_DESCRIPTOR(globalThis.Bun, 'file'),
      bunGlob: globalThis.Bun == null ? undefined : GET_OWN_PROPERTY_DESCRIPTOR(globalThis.Bun, 'Glob'),
      bunMmap: globalThis.Bun == null ? undefined : GET_OWN_PROPERTY_DESCRIPTOR(globalThis.Bun, 'mmap'),
      bunResolve: globalThis.Bun == null ? undefined : GET_OWN_PROPERTY_DESCRIPTOR(globalThis.Bun, 'resolve'),
      bunResolveSync: globalThis.Bun == null ? undefined : GET_OWN_PROPERTY_DESCRIPTOR(globalThis.Bun, 'resolveSync'),
      bunWrite: globalThis.Bun == null ? undefined : GET_OWN_PROPERTY_DESCRIPTOR(globalThis.Bun, 'write'),
      bunSleep: globalThis.Bun == null ? undefined : GET_OWN_PROPERTY_DESCRIPTOR(globalThis.Bun, 'sleep'),
      promiseResolve: globalThis.Promise == null ? undefined : GET_OWN_PROPERTY_DESCRIPTOR(globalThis.Promise, 'resolve'),
      queueMicrotask: GET_OWN_PROPERTY_DESCRIPTOR(globalThis, 'queueMicrotask'),
    };
    const hadGlobals = {
      fetch: Object.prototype.hasOwnProperty.call(globalThis, 'fetch'),
      WebSocket: Object.prototype.hasOwnProperty.call(globalThis, 'WebSocket'),
      EventSource: Object.prototype.hasOwnProperty.call(globalThis, 'EventSource'),
      setTimeout: Object.prototype.hasOwnProperty.call(globalThis, 'setTimeout'),
      clearTimeout: Object.prototype.hasOwnProperty.call(globalThis, 'clearTimeout'),
      setInterval: Object.prototype.hasOwnProperty.call(globalThis, 'setInterval'),
      clearInterval: Object.prototype.hasOwnProperty.call(globalThis, 'clearInterval'),
      setImmediate: Object.prototype.hasOwnProperty.call(globalThis, 'setImmediate'),
      clearImmediate: Object.prototype.hasOwnProperty.call(globalThis, 'clearImmediate'),
      bunBuild: globalThis.Bun != null && Object.prototype.hasOwnProperty.call(globalThis.Bun, 'build'),
      bunFile: globalThis.Bun != null && Object.prototype.hasOwnProperty.call(globalThis.Bun, 'file'),
      bunGlob: globalThis.Bun != null && Object.prototype.hasOwnProperty.call(globalThis.Bun, 'Glob'),
      bunMmap: globalThis.Bun != null && Object.prototype.hasOwnProperty.call(globalThis.Bun, 'mmap'),
      bunResolve: globalThis.Bun != null && Object.prototype.hasOwnProperty.call(globalThis.Bun, 'resolve'),
      bunResolveSync: globalThis.Bun != null && Object.prototype.hasOwnProperty.call(globalThis.Bun, 'resolveSync'),
      bunWrite: globalThis.Bun != null && Object.prototype.hasOwnProperty.call(globalThis.Bun, 'write'),
      bunSleep: globalThis.Bun != null && Object.prototype.hasOwnProperty.call(globalThis.Bun, 'sleep'),
      promiseResolve: globalThis.Promise != null && Object.prototype.hasOwnProperty.call(globalThis.Promise, 'resolve'),
      queueMicrotask: Object.prototype.hasOwnProperty.call(globalThis, 'queueMicrotask'),
    };
    let activeProbeResponseStatus = null;
    const deterministicFetch = async (input, init = {}) => {
      const request = new previousGlobals.Request(input, init);
      deterministicNetwork.assertHttpAllowed('fetch', request, request.method);
      deterministicNetwork.observeFetchRequest(request);
      if (activeProbeResponseStatus === 'http_error') {
        return new Response('', {
          status: 503,
          headers: { 'x-request-id': 'world-host-capability-pack-abi-probe' },
        });
      }
      if (activeProbeResponseStatus === 'failed') {
        return new Response('not-json', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'world-host-capability-pack-abi-probe',
          },
        });
      }
      if (activeProbeResponseStatus === 'deferred') {
        throw Object.assign(new Error('world-host deterministic probe timeout'), { name: 'AbortError' });
      }
      return new Response(stableJson({
        worldHostCapabilityPackAbiProbe: true,
        action: { variant: 'final', text: 'world-host capability pack ABI probe' },
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'world-host-capability-pack-abi-probe',
        },
      });
    };
    const deterministicNetwork = deterministicCapabilityPackProbeNetwork({
      fetch: deterministicFetch,
      setTimeout: previousGlobals.setTimeout.bind(globalThis),
      clearTimeout: previousGlobals.clearTimeout.bind(globalThis),
      setInterval: previousGlobals.setInterval.bind(globalThis),
      clearInterval: previousGlobals.clearInterval.bind(globalThis),
      setImmediate: typeof previousGlobals.setImmediate === 'function' ? previousGlobals.setImmediate.bind(globalThis) : null,
      clearImmediate: typeof previousGlobals.clearImmediate === 'function' ? previousGlobals.clearImmediate.bind(globalThis) : null,
      file: typeof previousGlobals.bunFile === 'function' ? previousGlobals.bunFile.bind(globalThis.Bun) : null,
      write: typeof previousGlobals.bunWrite === 'function' ? previousGlobals.bunWrite.bind(globalThis.Bun) : null,
      sleep: typeof previousGlobals.bunSleep === 'function' ? previousGlobals.bunSleep.bind(globalThis.Bun) : null,
      promiseResolve: previousGlobals.promiseResolve.bind(globalThis.Promise),
      queueMicrotask: previousGlobals.queueMicrotask.bind(globalThis),
      failNetworkEffect: (api) => fail(
        'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED',
        `${api} is only supported during deterministic resolve/recover capability pack probes`,
      ),
    });
    deterministicNetwork.setProbeHostRequest = (request) => {
      activeProbeResponseStatus = request?.responseSchema?.status ?? null;
    };
    const restorations = [
      [globalThis.Promise, 'resolve', previousDescriptors.promiseResolve, 'Promise.resolve'],
      [globalThis, 'fetch', previousDescriptors.fetch, 'globalThis.fetch'],
      [globalThis, 'WebSocket', previousDescriptors.WebSocket, 'globalThis.WebSocket'],
      [globalThis, 'EventSource', previousDescriptors.EventSource, 'globalThis.EventSource'],
      [globalThis, 'setTimeout', previousDescriptors.setTimeout, 'globalThis.setTimeout'],
      [globalThis, 'clearTimeout', previousDescriptors.clearTimeout, 'globalThis.clearTimeout'],
      [globalThis, 'setInterval', previousDescriptors.setInterval, 'globalThis.setInterval'],
      [globalThis, 'clearInterval', previousDescriptors.clearInterval, 'globalThis.clearInterval'],
      [globalThis, 'setImmediate', previousDescriptors.setImmediate, 'globalThis.setImmediate'],
      [globalThis, 'clearImmediate', previousDescriptors.clearImmediate, 'globalThis.clearImmediate'],
      [globalThis.Bun, 'build', previousDescriptors.bunBuild, 'Bun.build'],
      [globalThis.Bun, 'file', previousDescriptors.bunFile, 'Bun.file'],
      [globalThis.Bun, 'Glob', previousDescriptors.bunGlob, 'Bun.Glob'],
      [globalThis.Bun, 'mmap', previousDescriptors.bunMmap, 'Bun.mmap'],
      [globalThis.Bun, 'resolve', previousDescriptors.bunResolve, 'Bun.resolve'],
      [globalThis.Bun, 'resolveSync', previousDescriptors.bunResolveSync, 'Bun.resolveSync'],
      [globalThis.Bun, 'write', previousDescriptors.bunWrite, 'Bun.write'],
      [globalThis.Bun, 'sleep', previousDescriptors.bunSleep, 'Bun.sleep'],
      [globalThis, 'queueMicrotask', previousDescriptors.queueMicrotask, 'globalThis.queueMicrotask'],
    ];
    let result;
    let probeError = null;
    try {
      globalThis.fetch = deterministicNetwork.fetch;
      if (hadGlobals.WebSocket) globalThis.WebSocket = deterministicNetwork.WebSocket;
      if (hadGlobals.EventSource) globalThis.EventSource = deterministicNetwork.EventSource;
      globalThis.setTimeout = deterministicNetwork.setTimeout;
      globalThis.clearTimeout = deterministicNetwork.clearTimeout;
      globalThis.setInterval = deterministicNetwork.setInterval;
      globalThis.clearInterval = deterministicNetwork.clearInterval;
      if (typeof previousGlobals.setImmediate === 'function') globalThis.setImmediate = deterministicNetwork.setImmediate;
      if (typeof previousGlobals.clearImmediate === 'function') globalThis.clearImmediate = deterministicNetwork.clearImmediate;
      if (globalThis.Bun && typeof previousGlobals.bunBuild === 'function') globalThis.Bun.build = deniedCapabilityPackProbeFileApi(deterministicNetwork, 'Bun.build');
      if (globalThis.Bun && typeof previousGlobals.bunFile === 'function') globalThis.Bun.file = deterministicNetwork.file;
      if (globalThis.Bun && typeof previousGlobals.bunGlob === 'function') globalThis.Bun.Glob = deniedCapabilityPackProbeFileApi(deterministicNetwork, 'Bun.Glob');
      if (globalThis.Bun && typeof previousGlobals.bunMmap === 'function') globalThis.Bun.mmap = deniedCapabilityPackProbeFileApi(deterministicNetwork, 'Bun.mmap');
      if (globalThis.Bun && typeof previousGlobals.bunResolve === 'function') globalThis.Bun.resolve = deniedCapabilityPackProbeFileApi(deterministicNetwork, 'Bun.resolve');
      if (globalThis.Bun && typeof previousGlobals.bunResolveSync === 'function') globalThis.Bun.resolveSync = deniedCapabilityPackProbeFileApi(deterministicNetwork, 'Bun.resolveSync');
      if (globalThis.Bun && typeof previousGlobals.bunWrite === 'function') globalThis.Bun.write = deterministicNetwork.write;
      if (globalThis.Bun && typeof previousGlobals.bunSleep === 'function') globalThis.Bun.sleep = deterministicNetwork.sleep;
      globalThis.Promise.resolve = deterministicNetwork.promiseResolve;
      globalThis.queueMicrotask = deterministicNetwork.queueMicrotask;
      result = await fn(deterministicNetwork);
    } catch (error) {
      probeError = error;
    }
    try {
      deterministicNetwork.setPhase('closed');
      await deterministicNetwork.assertNoViolations();
    } catch (error) {
      probeError = error;
    }
    const cleanupFailures = restoreCapabilityPackProbeProperties(restorations);
    if (cleanupFailures.length > 0) {
      fail('ERR_CAPABILITY_PACK_ADAPTER_PROBE_CLEANUP_FAILED', 'capability pack probe globals could not be restored', {
        failures: cleanupFailures,
        probeErrorCode: probeError?.code ?? null,
      });
    }
    if (probeError) throw probeError;
    return result;
  });
}

async function withCapabilityPackProbeGlobalLock(fn) {
  const previous = capabilityPackProbeGlobalLock;
  let release;
  capabilityPackProbeGlobalLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

function deterministicCapabilityPackProbeNetwork({ fetch, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, file, write, sleep, promiseResolve, queueMicrotask, failNetworkEffect }) {
  let phase = 'capture';
  let phaseToken = 0;
  let networkAllowed = false;
  let fileAllowed = false;
  let allowedOrigins = new Set();
  let allowedMethods = new Set();
  let allowedFileRoots = [];
  let worldIdempotencyObservation = null;
  let violations = [];
  const pendingTimeouts = new Set();
  const pendingIntervals = new Set();
  const pendingImmediates = new Set();
  const assertAllowed = (api) => {
    if (((phase === 'resolve' || phase === 'recover') || asyncContinuationNetworkAllowedDepth > 0) && networkAllowed === true) return;
    violations.push(api);
    if (phase === 'closed' || phase === 'resolve-await' || phase === 'resolve-returned' ||
      phase === 'recover-await' || phase === 'recover-returned') return;
    failNetworkEffect(api);
  };
  const assertFileAllowed = (api, target) => {
    if (((phase === 'resolve' || phase === 'recover') || asyncContinuationNetworkAllowedDepth > 0) && fileAllowed === true && fileProbeTargetAllowed(target, allowedFileRoots)) return;
    violations.push(api);
    if (phase === 'closed' || phase === 'resolve-await' || phase === 'resolve-returned' ||
      phase === 'recover-await' || phase === 'recover-returned') return;
    failNetworkEffect(api);
  };
  const rejectUnconfinedFileApi = (api) => {
    violations.push(api);
    if (phase === 'closed' || phase === 'resolve-await' || phase === 'resolve-returned' ||
      phase === 'recover-await' || phase === 'recover-returned') return;
    failNetworkEffect(api);
  };
  const assertHttpAllowed = (api, input, method) => {
    assertAllowed(api);
    let url;
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url);
    } catch {
      violations.push(`${api}:url`);
      failNetworkEffect(api);
    }
    const normalizedMethod = String(method ?? 'GET').toUpperCase();
    if ((allowedOrigins.size > 0 && !allowedOrigins.has(url.origin)) ||
      (allowedMethods.size > 0 && !allowedMethods.has(normalizedMethod))) {
      violations.push(`${api}:policy`);
      failNetworkEffect(api);
    }
  };
  const assertUrlOriginAllowed = (api, input) => {
    let url;
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url);
    } catch {
      violations.push(`${api}:url`);
      failNetworkEffect(api);
    }
    if (allowedOrigins.size > 0 && !allowedOrigins.has(url.origin)) {
      violations.push(`${api}:policy`);
      failNetworkEffect(api);
    }
  };
  const cancelPendingTimers = () => {
    for (const timer of pendingTimeouts) clearTimeout(timer);
    for (const timer of pendingIntervals) clearInterval(timer);
    if (typeof clearImmediate === 'function') {
      for (const immediate of pendingImmediates) clearImmediate(immediate);
    }
    pendingTimeouts.clear();
    pendingIntervals.clear();
    pendingImmediates.clear();
  };
  const recordPendingTimers = () => {
    if (pendingTimeouts.size === 0 && pendingIntervals.size === 0 && pendingImmediates.size === 0) return;
    violations.push('async-timer');
    cancelPendingTimers();
  };
  const trackedPromiseStates = new WeakMap();
  let asyncContinuationNetworkAllowedDepth = 0;
  const runAsyncContinuation = (callback, value, { allowNetwork = false } = {}) => {
    const previousPhase = phase;
    const effectiveAllowNetwork = allowNetwork || asyncContinuationNetworkAllowedDepth > 0;
    const phaseChanged = !effectiveAllowNetwork;
    let restoreDeferred = false;
    if (effectiveAllowNetwork) {
      asyncContinuationNetworkAllowedDepth += 1;
    } else {
      phase = 'closed';
    }
    const restoreContinuation = () => {
      if (phaseChanged) phase = previousPhase;
      if (effectiveAllowNetwork) asyncContinuationNetworkAllowedDepth = Math.max(0, asyncContinuationNetworkAllowedDepth - 1);
    };
    try {
      const result = callback(value);
      if (effectiveAllowNetwork && isThenable(result)) {
        restoreDeferred = true;
        promiseResolve(result).then(restoreContinuation, restoreContinuation);
      }
      return result;
    } catch (error) {
      if (!effectiveAllowNetwork) violations.push('async-callback');
      throw error;
    } finally {
      if (!restoreDeferred) restoreContinuation();
    }
  };
  const trackedPromise = (promise, state = { allowNetwork: false }) => {
    const wrapped = {
      then(onFulfilled, onRejected) {
        const childState = { allowNetwork: state.allowNetwork };
        return trackedPromise(promise.then(
          typeof onFulfilled === 'function' ? (value) => runAsyncContinuation(onFulfilled, value, childState) : onFulfilled,
          typeof onRejected === 'function' ? (reason) => runAsyncContinuation(onRejected, reason, childState) : onRejected,
        ), childState);
      },
      catch(onRejected) {
        return this.then(undefined, onRejected);
      },
      finally(onFinally) {
        return this.then(
          (value) => promiseResolve(typeof onFinally === 'function' ? runAsyncContinuation(onFinally, undefined, state) : undefined).then(() => value),
          (reason) => promiseResolve(typeof onFinally === 'function' ? runAsyncContinuation(onFinally, undefined, state) : undefined).then(() => { throw reason; }),
        );
      },
      [Symbol.toStringTag]: 'Promise',
    };
    trackedPromiseStates.set(wrapped, state);
    return wrapped;
  };

  class DeterministicWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url, protocols = '') {
      assertAllowed('WebSocket');
      assertUrlOriginAllowed('WebSocket', url);
      this.url = String(url);
      this.protocol = Array.isArray(protocols) ? String(protocols[0] ?? '') : String(protocols ?? '');
      this.extensions = '';
      this.binaryType = 'blob';
      this.readyState = DeterministicWebSocket.CLOSED;
      this.worldHostCapabilityPackAbiProbe = true;
    }

    close() {
      this.readyState = DeterministicWebSocket.CLOSED;
    }

    send() {
      fail('ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED', 'WebSocket send is not supported during deterministic capability pack probes');
    }

    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
  }

  class DeterministicEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    constructor(url) {
      assertAllowed('EventSource');
      assertUrlOriginAllowed('EventSource', url);
      this.url = String(url);
      this.readyState = DeterministicEventSource.CLOSED;
      this.withCredentials = false;
      this.worldHostCapabilityPackAbiProbe = true;
    }

    close() {
      this.readyState = DeterministicEventSource.CLOSED;
    }

    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
  }

  return {
    setNetworkAllowed(allowed) {
      networkAllowed = allowed === true;
    },
    setProbePolicy(policy = {}) {
      allowedOrigins = new Set((policy.allowedOrigins ?? policy.allowedHttpOrigins ?? []).map((origin) => {
        try {
          return new URL(origin).origin;
        } catch {
          return null;
        }
      }).filter(Boolean));
      allowedMethods = new Set((policy.allowedMethods ?? policy.allowedHttpMethods ?? []).map((method) => String(method).toUpperCase()));
      allowedFileRoots = [...(policy.allowedFileRoots ?? [])].filter((root) => typeof root === 'string' && root.length > 0);
      fileAllowed = policy.allowFileEffects === true;
    },
    setPhase(nextPhase) {
      phase = nextPhase;
      phaseToken += 1;
    },
    assertHttpAllowed,
    rejectUnconfinedFileApi,
    beginWorldIdempotencyObservation(observation) {
      worldIdempotencyObservation = {
        ...observation,
        fetchCount: 0,
        invalidFetchCount: 0,
      };
    },
    observeFetchRequest(request) {
      if (worldIdempotencyObservation == null) return;
      worldIdempotencyObservation.fetchCount += 1;
      if (worldIdempotencyObservation.enforce !== true) return;
      const observed = request.headers.get(worldIdempotencyObservation.headerName);
      if (observed !== worldIdempotencyObservation.expectedValue) {
        worldIdempotencyObservation.invalidFetchCount += 1;
        fail('ERR_CAPABILITY_PACK_ADAPTER_IDEMPOTENCY_NOT_PROPAGATED', 'capability pack adapter fetch did not propagate World idempotency', {
          phase: worldIdempotencyObservation.phase,
          headerName: worldIdempotencyObservation.headerName,
          fetchCount: worldIdempotencyObservation.fetchCount,
        });
      }
    },
    assertWorldIdempotencyObserved({ requireObserved = true } = {}) {
      const observation = worldIdempotencyObservation;
      worldIdempotencyObservation = null;
      if (observation?.enforce !== true) return;
      if (observation.invalidFetchCount > 0) {
        fail('ERR_CAPABILITY_PACK_ADAPTER_IDEMPOTENCY_NOT_PROPAGATED', 'capability pack adapter fetch did not propagate World idempotency', {
          phase: observation.phase,
          headerName: observation.headerName,
          fetchCount: observation.fetchCount,
          invalidFetchCount: observation.invalidFetchCount,
        });
      }
      if (requireObserved !== true || observation.fetchCount > 0) return;
      fail('ERR_CAPABILITY_PACK_ADAPTER_IDEMPOTENCY_NOT_PROPAGATED', 'capability pack adapter claimed World idempotency propagation without an observed fetch', {
        phase: observation.phase,
        headerName: observation.headerName,
        fetchCount: 0,
      });
    },
    allowReturnedPromise(value) {
      const state = trackedPromiseStates.get(value);
      if (state) {
        state.allowNetwork = true;
        return;
      }
      if (!(value instanceof Promise) || !inspectValue(value).includes('<pending>')) return;
      asyncContinuationNetworkAllowedDepth += 1;
      promiseResolve(value).then(
        () => { asyncContinuationNetworkAllowedDepth = Math.max(0, asyncContinuationNetworkAllowedDepth - 1); },
        () => { asyncContinuationNetworkAllowedDepth = Math.max(0, asyncContinuationNetworkAllowedDepth - 1); },
      );
    },
    promiseResolve(value) {
      return trackedPromise(promiseResolve(value), { allowNetwork: asyncContinuationNetworkAllowedDepth > 0 });
    },
    queueMicrotask(callback) {
      return queueMicrotask(() => runAsyncContinuation(callback));
    },
    async assertNoViolations() {
      await promiseResolve();
      await new Promise((resolve) => setTimeout(resolve, CAPABILITY_PACK_PROBE_SETTLE_MS));
      recordPendingTimers();
      if (violations.length === 0) return;
      const blockedApis = [...new Set(violations)].join(',');
      violations = [];
      failNetworkEffect(blockedApis);
    },
    fetch: (...args) => {
      assertAllowed('fetch');
      return fetch(...args);
    },
    file: (target, options) => {
      assertFileAllowed('Bun.file', target);
      return file(target, options);
    },
    write: (target, data, options) => {
      assertFileAllowed('Bun.write', target);
      return write(target, data, options);
    },
    sleep: () => {
      assertAllowed('Bun.sleep');
      const scheduledPhase = phase;
      const scheduledPhaseToken = phaseToken;
      let timer;
      const runContinuation = (callback, value) => {
        const previousPhase = phase;
        if (scheduledPhaseToken === phaseToken) {
          phase = scheduledPhase;
        } else {
          violations.push('async-callback');
          phase = 'closed';
        }
        try {
          return callback(value);
        } catch {
          violations.push('async-callback');
          return undefined;
        } finally {
          phase = previousPhase;
        }
      };
      const promise = new Promise((resolve) => {
        timer = setTimeout(() => {
          pendingTimeouts.delete(timer);
          const previousPhase = phase;
          if (scheduledPhaseToken === phaseToken) {
            phase = scheduledPhase;
          } else {
            violations.push('async-callback');
            phase = 'closed';
          }
          try {
            resolve();
          } finally {
            phase = previousPhase;
          }
        }, 0);
        pendingTimeouts.add(timer);
      });
      return {
        then(onFulfilled, onRejected) {
          return promise.then(
            typeof onFulfilled === 'function' ? (value) => runContinuation(onFulfilled, value) : onFulfilled,
            typeof onRejected === 'function' ? (reason) => runContinuation(onRejected, reason) : onRejected,
          );
        },
        catch(onRejected) {
          return this.then(undefined, onRejected);
        },
        finally(onFinally) {
          return this.then(
            (value) => promiseResolve(typeof onFinally === 'function' ? runContinuation(onFinally) : undefined).then(() => value),
            (reason) => promiseResolve(typeof onFinally === 'function' ? runContinuation(onFinally) : undefined).then(() => { throw reason; }),
          );
        },
        [Symbol.toStringTag]: 'Promise',
      };
    },
    setTimeout: (callback, delay, ...args) => {
      if (typeof callback !== 'function') return setTimeout(callback, delay, ...args);
      const scheduledPhase = phase;
      const scheduledPhaseToken = phaseToken;
      let timer;
      timer = setTimeout((...callbackArgs) => {
        pendingTimeouts.delete(timer);
        const previousPhase = phase;
        if (scheduledPhaseToken === phaseToken) {
          phase = scheduledPhase;
        } else {
          violations.push('async-callback');
          phase = 'closed';
        }
        try {
          return callback(...callbackArgs);
        } catch {
          violations.push('async-callback');
        } finally {
          phase = previousPhase;
        }
      }, delay, ...args);
      pendingTimeouts.add(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      pendingTimeouts.delete(timer);
      return clearTimeout(timer);
    },
    setInterval: (callback, delay, ...args) => {
      if (typeof callback !== 'function') return setInterval(callback, delay, ...args);
      const scheduledPhase = phase;
      const scheduledPhaseToken = phaseToken;
      const timer = setInterval((...callbackArgs) => {
        const previousPhase = phase;
        if (scheduledPhaseToken === phaseToken) {
          phase = scheduledPhase;
        } else {
          violations.push('async-callback');
          phase = 'closed';
        }
        try {
          return callback(...callbackArgs);
        } catch {
          violations.push('async-callback');
        } finally {
          phase = previousPhase;
        }
      }, delay, ...args);
      pendingIntervals.add(timer);
      return timer;
    },
    clearInterval: (timer) => {
      pendingIntervals.delete(timer);
      return clearInterval(timer);
    },
    setImmediate: (callback, ...args) => {
      if (typeof setImmediate !== 'function') return undefined;
      if (typeof callback !== 'function') return setImmediate(callback, ...args);
      const scheduledPhase = phase;
      const scheduledPhaseToken = phaseToken;
      let immediate;
      immediate = setImmediate((...callbackArgs) => {
        pendingImmediates.delete(immediate);
        const previousPhase = phase;
        if (scheduledPhaseToken === phaseToken) {
          phase = scheduledPhase;
        } else {
          violations.push('async-callback');
          phase = 'closed';
        }
        try {
          return callback(...callbackArgs);
        } catch {
          violations.push('async-callback');
        } finally {
          phase = previousPhase;
        }
      }, ...args);
      pendingImmediates.add(immediate);
      return immediate;
    },
    clearImmediate: (immediate) => {
      pendingImmediates.delete(immediate);
      if (typeof clearImmediate !== 'function') return undefined;
      return clearImmediate(immediate);
    },
    WebSocket: DeterministicWebSocket,
    EventSource: DeterministicEventSource,
  };
}

function deniedCapabilityPackProbeFileApi(probeNetwork, api) {
  return function () {
    return probeNetwork.rejectUnconfinedFileApi(api);
  };
}

function fileProbeTargetAllowed(target, allowedFileRoots) {
  if (allowedFileRoots.length === 0) return false;
  let targetPath;
  try {
    if (target instanceof URL) {
      if (target.protocol !== 'file:') return false;
      targetPath = fileURLToPath(target);
    } else {
      targetPath = String(target);
    }
  } catch {
    return false;
  }
  const resolvedTarget = path.resolve(targetPath);
  return allowedFileRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolvedTarget === resolvedRoot || pathInside(resolvedRoot, resolvedTarget);
  });
}

function restoreCapabilityPackProbeProperties(restorations) {
  const failures = [];
  for (let index = 0; index < restorations.length; index += 1) {
    const restoration = restorations[index];
    const target = restoration[0];
    const name = restoration[1];
    const descriptor = restoration[2];
    const label = restoration[3];
    if (target == null) continue;
    try {
      if (descriptor === undefined) {
        if (!DELETE_PROPERTY(target, name)) failures[failures.length] = label;
      } else {
        DEFINE_PROPERTY(target, name, descriptor);
      }
    } catch {
      failures[failures.length] = label;
    }
  }
  return failures;
}

function externalCapabilityPackEffectProbe(driverManifest, hostRequest) {
  return manifestNetworkCapabilityPackEffectProbe(driverManifest);
}

function fileCapabilityPackEffectProbe(driverManifest, hostRequest = null) {
  if (hostRequest?.actuationClass === 'file') return true;
  if (hostRequest) return false;
  return (driverManifest.supportedActuationClasses ?? []).includes('file') ||
    (driverManifest.authorityLabels ?? []).some((label) => typeof label === 'string' && label.startsWith('file:'));
}

function networkCapabilityPackEffectProbe(driverManifest, hostRequest = null) {
  if (hostRequest?.actuationClass === 'http') return true;
  if (hostRequest?.actuationClass === 'model') {
    return networkCapabilityPackAuthorityLabel(driverManifest);
  }
  if (hostRequest) return false;
  return manifestNetworkCapabilityPackEffectProbe(driverManifest);
}

function isThenable(value) {
  return value != null && typeof value.then === 'function';
}

function manifestNetworkCapabilityPackEffectProbe(driverManifest) {
  return (driverManifest.supportedActuationClasses ?? []).includes('http') ||
    networkCapabilityPackAuthorityLabel(driverManifest);
}

function networkCapabilityPackAuthorityLabel(driverManifest) {
  return (driverManifest.authorityLabels ?? []).some(authorityLabelDeclaresNetwork);
}

function capabilityPackProbeWorldIdempotencyObservation(packManifest, driverManifest, hostRequest, phase) {
  return Object.freeze({
    enforce: packManifest.propagatesWorldIdempotencyKey === true && networkCapabilityPackEffectProbe(driverManifest, hostRequest),
    expectedValue: hostRequest.idempotencyKeyWorldFingerprint,
    headerName: capabilityPackProbeWorldIdempotencyHeaderName(driverManifest),
    phase,
  });
}

function capabilityPackProbeWorldIdempotencyHeaderName(driverManifest) {
  const diagnostics = driverManifest.diagnostics ?? {};
  const value = diagnostics.requestRendering?.idempotencyHeaderName ?? diagnostics.idempotencyHeaderName;
  return typeof value === 'string' && value.length > 0 ? value : 'Idempotency-Key';
}

function assertCapabilityPackSidecarProbeResolution(value, hostRequest, driverManifest, policy) {
  assertCapabilityResolutionBoundary(value);
  assertResolutionAccepted(value.resolutionInputBytes, hostRequest, driverManifest, policy);
}

function capabilityPackSidecarProbePolicy(driverManifest, hostRequest, probeFileRoot) {
  const actuationClasses = new Set(driverManifest.supportedActuationClasses ?? []);
  const diagnostics = driverManifest.diagnostics ?? {};
  const { origins, methods } = capabilityPackSidecarProbeHttpPolicy(diagnostics, hostRequest);
  return Object.freeze({
    allowLiveEffects: true,
    allowNetworkEffects: true,
    allowFileEffects: true,
    allowHumanEffects: true,
    allowBestEffort: true,
    requireApprovalForDestructiveEffects: false,
    requireApprovalForNetworkEffects: false,
    requireApprovalForBestEffort: false,
    maximumLiveModelCalls: actuationClasses.has('model') ? 1 : 0,
    allowedAuthorityLabels: [...(driverManifest.authorityLabels ?? [])],
    allowedCapabilityPacks: [driverManifest.packFingerprint, driverManifest.driverId].filter((item) => typeof item === 'string' && item.length > 0),
    allowedOrigins: origins,
    allowedMethods: methods,
    allowedHttpOrigins: origins,
    allowedHttpMethods: methods,
    allowedFileRoots: [probeFileRoot],
    maximumConcurrentEffects: Math.max(1, driverManifest.concurrencyLimit ?? 1),
    maximumRequestBytes: Math.max(1, driverManifest.maximumRequestBytes ?? 1, hostRequest.requestBytes?.byteLength ?? 0),
    maximumPromptBytes: Math.max(1, driverManifest.maximumRequestBytes ?? 1, hostRequest.requestBytes?.byteLength ?? 0),
    maximumResponseBytes: Math.max(1, driverManifest.maximumResponseBytes ?? 1),
  });
}

function capabilityPackSidecarProbeHttpPolicy(diagnostics, hostRequest) {
  const origins = new Set();
  for (const origin of diagnostics.origins ?? []) addHttpOrigin(origins, origin);
  addHttpOrigin(origins, diagnostics.configuredOrigin);
  addHttpOrigin(origins, diagnostics.configuredEndpointUrl);
  const request = parseProbeJson(hostRequest.requestBytes);
  addHttpOrigin(origins, request?.url);
  const methods = new Set((diagnostics.methods ?? []).map((item) => String(item).toUpperCase()));
  if (diagnostics.defaultMethod) methods.add(String(diagnostics.defaultMethod).toUpperCase());
  if (request?.method) methods.add(String(request.method).toUpperCase());
  return { origins: [...origins], methods: [...methods] };
}

function addHttpOrigin(origins, value) {
  if (typeof value !== 'string' || value.length === 0) return;
  try {
    origins.add(new URL(value).origin);
  } catch {
    // Non-URL diagnostics are ignored; concrete probe bytes still provide a target when needed.
  }
}

function parseProbeJson(bytes) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function capabilityPackSidecarProbeHostRequests(driverManifest) {
  const actuatorRefs = driverManifest.supportedActuatorRefs;
  const descriptorFingerprints = driverManifest.supportedDescriptorFingerprints;
  const actuationClasses = driverManifest.supportedActuationClasses;
  if (actuatorRefs.length < 1 || descriptorFingerprints.length < 1 || actuationClasses.length < 1) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_PREFLIGHT', 'capability pack adapter ABI probe requires at least one advertised capability route');
  }
  const hostRequests = [];
  const responseStatuses = driverManifest.supportedResponseStatuses?.length > 0 ? driverManifest.supportedResponseStatuses : ['ok'];
  for (const actuatorRef of actuatorRefs) {
    for (const descriptorFingerprint of descriptorFingerprints) {
      for (const actuationClass of actuationClasses) {
        for (const responseStatus of responseStatuses) {
          hostRequests.push(capabilityPackSidecarProbeHostRequest({
            driverManifest,
            actuatorRef,
            descriptorFingerprint,
            actuationClass,
            responseStatus,
            index: hostRequests.length,
          }));
        }
      }
    }
  }
  return hostRequests;
}

function capabilityPackSidecarProbeHostRequest({ driverManifest, actuatorRef, descriptorFingerprint, actuationClass, responseStatus, index }) {
  const targetFingerprint = (0xabcn + BigInt(index)).toString(16).padStart(16, '0');
  const requestBytes = capabilityPackSidecarProbeRequestBytes(driverManifest, actuationClass);
  return Object.freeze({
    actuatorRef,
    descriptorFingerprint,
    actuationClass,
    idempotencyKeyBytes: fromUtf8(`world-host-capability-pack-sidecar-abi-probe-key:${index}`),
    idempotencyKeyWorldFingerprint: `world:idempotency-key:world-host-capability-pack-sidecar-abi-probe:${index}`,
    responseSchema: { status: responseStatus },
    requestBytes,
    hostRequestFingerprint: `world:host-request:${targetFingerprint}`,
  });
}

function capabilityPackSidecarProbeRequestBytes(driverManifest, actuationClass) {
  const diagnostics = driverManifest.diagnostics ?? {};
  if (actuationClass === 'http') {
    return fromUtf8(stableJson({
      url: diagnostics.configuredEndpointUrl ??
        httpProbeUrlForOrigin(diagnostics.configuredOrigin) ??
        httpProbeUrlForOrigin(diagnostics.origins?.[0]) ??
        'https://example.invalid/world-host-abi-probe',
      method: diagnostics.defaultMethod ?? diagnostics.methods?.[0] ?? 'POST',
      body: { worldHostCapabilityPackAbiProbe: true },
    }));
  }
  if (actuationClass === 'model') {
    return fromUtf8(stableJson({
      schema: 'boundary.Agent.DecisionPrompt.v0',
      observation: 'goal=fixture',
    }));
  }
  if (actuationClass === 'human') {
    return fromUtf8(stableJson({ action: 'world-host capability pack sidecar ABI probe' }));
  }
  if (actuationClass === 'file') {
    return fromUtf8(stableJson({ operation: 'read', path: 'world-host-abi-probe.txt' }));
  }
  return fromUtf8(stableJson({ worldHostCapabilityPackAbiProbe: true }));
}

function httpProbeUrlForOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return null;
  try {
    return new URL('/world-host-abi-probe', origin).href;
  } catch {
    return null;
  }
}

function capabilityPackSidecarProbeEffectRecord(driverManifest, hostRequest) {
  const requestBytesChecksum = `sha256:${sha256BytesHex(hostRequest.requestBytes)}`;
  const requestBytesRef = capabilityPackSidecarProbeBlobRef(hostRequest.requestBytes);
  return Object.freeze({
    runId: 'world-host-capability-pack-sidecar-abi-probe-run',
    branchId: 'main',
    parentTurnClosureFingerprint: 'world:turn-closure:0000000000000abc',
    state: 'running',
    attemptCount: 1,
    driverId: driverManifest.driverId,
    driverRecoveryClass: driverManifest.recoveryClass,
    actuatorRef: hostRequest.actuatorRef,
    descriptorFingerprint: hostRequest.descriptorFingerprint,
    actuationClass: hostRequest.actuationClass,
    responseSchema: hostRequest.responseSchema,
    idempotencyKey: {
      format: 'world-idempotency-key-bytes.hex',
      bytesHex: bytesHex(hostRequest.idempotencyKeyBytes),
    },
    idempotencyKeyWorldFingerprint: hostRequest.idempotencyKeyWorldFingerprint,
    hostRequestFingerprint: hostRequest.hostRequestFingerprint,
    requestBytes: hostRequest.requestBytes,
    requestBytesRef,
    requestBytesChecksum,
    requestIdentityChecksum: requestBytesChecksum,
    effectIdentityBytesRef: requestBytesRef,
    effectIdentityBytes: hostRequest.requestBytes,
    diagnostics: { worldHostCapabilityPackAbiProbe: true },
  });
}

function capabilityPackSidecarProbeBlobRef(bytes) {
  return Object.freeze({
    algorithm: 'sha256',
    checksum: sha256BytesHex(bytes),
    byteLength: bytes.byteLength,
  });
}

function sha256BytesHex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function capabilityPackAdapterSnapshot(packManifest, artifacts) {
  const root = await capabilityPackAdapterImportRoot();
  for (const item of packManifest.checksums) {
    const bytes = artifacts[item.path];
    if (!(bytes instanceof Uint8Array)) fail('ERR_CAPABILITY_PACK_ARTIFACT_MISSING', `artifact missing: ${item.path}`);
    const target = path.resolve(root, item.path);
    if (!pathInside(root, target)) fail('ERR_CAPABILITY_HOST_PATH_FORBIDDEN', `checksum path escapes adapter import root: ${item.path}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  return root;
}

async function capabilityPackAdapterImportRoot() {
  const ownerRoot = process.env[CAPABILITY_PACK_PROBE_IMPORT_ROOT_ENV];
  if (ownerRoot == null || ownerRoot.length === 0) {
    return await mkdtemp(path.join(tmpdir(), 'world-host-capability-adapter-imports-'));
  }
  const actual = await realpath(ownerRoot);
  const tempRoot = await realpath(tmpdir());
  if (!pathInside(tempRoot, actual) || !path.basename(actual).startsWith('world-host-capability-adapter-imports-')) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_IMPORT_ROOT', 'adapter import root must be a world-host temp directory');
  }
  return actual;
}

function capabilityPackAdapterOptions(packManifest, probeFileRoot) {
  const base = {
    packFingerprint: packManifest.packFingerprint,
    root: probeFileRoot,
    ...(packManifest.requiredSecrets.length > 0
      ? { secretProvider: capabilityPackProbeSecretProvider(packManifest.requiredSecrets) }
      : {}),
  };
  if (packManifest.driverId === 'generic-http-json' || packManifest.driverId === 'generic-http-json-model') {
    const allowedOrigin = packManifest.policyRequirements.allowedOrigins[0] ?? null;
    const allowedMethod = packManifest.policyRequirements.allowedMethods[0] ?? null;
    return {
      ...base,
      endpointUrl: capabilityPackProbeEndpointUrl(allowedOrigin),
      ...(allowedMethod == null ? {} : { methods: [allowedMethod] }),
    };
  }
  return base;
}

function capabilityPackProbeEndpointUrl(allowedOrigin) {
  if (allowedOrigin == null) return 'https://example.invalid/decide';
  try {
    return new URL('/world-host-capability-pack-abi-probe', allowedOrigin).href;
  } catch {
    fail(
      'ERR_CAPABILITY_PACK_ADAPTER_MANIFEST_MISMATCH',
      'receiver driver cannot realize policyRequirements.allowedOrigins',
    );
  }
}

function capabilityPackProbeSecretProvider(descriptors) {
  const byName = new Map(descriptors.map((descriptor, index) => [descriptor.name, {
    descriptor,
    value: `world-host-probe-placeholder-${index}-${sha256BytesHex(fromUtf8(descriptor.name)).slice(0, 12)}`,
  }]));
  const entry = (name) => byName.get(name) ?? null;
  return Object.freeze({
    describe(name) {
      const found = entry(name);
      return found == null
        ? Object.freeze({ name, class: 'opaque', provider: 'world-host-probe', required: true, redacted: true })
        : Object.freeze({ ...found.descriptor, provider: 'world-host-probe', redacted: true });
    },
    has(name) {
      return entry(name) != null;
    },
    get(name, purpose = 'capability-pack-abi-probe') {
      const found = entry(name);
      if (found == null) fail('ERR_SECRET_MISSING', `missing secret: ${name}`, { name, purpose });
      return found.value;
    },
    accessReport(name, purpose = 'capability-pack-abi-probe') {
      return Object.freeze({ name, purpose, available: entry(name) != null, valueRedacted: true });
    },
  });
}

async function createCapabilityPackProbeFileRoot() {
  const root = await mkdtemp(path.join(tmpdir(), CAPABILITY_PACK_PROBE_FILE_ROOT_PREFIX));
  try {
    await writeFile(path.join(root, CAPABILITY_PACK_PROBE_FILE_NAME), CAPABILITY_PACK_PROBE_FILE_CONTENT, {
      flag: 'wx',
      mode: 0o600,
    });
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function capabilityPackProbeFileRoot({ isolatedProbeChild }) {
  if (!isolatedProbeChild) {
    return Object.freeze({ root: await createCapabilityPackProbeFileRoot(), locallyOwned: true });
  }
  const ownerRoot = process.env[CAPABILITY_PACK_PROBE_FILE_ROOT_ENV];
  if (ownerRoot == null || ownerRoot.length === 0) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_FILE_ROOT', 'isolated capability pack probes require a parent-owned file root');
  }
  const actual = await realpath(ownerRoot).catch(() => fail('ERR_CAPABILITY_PACK_ADAPTER_FILE_ROOT', 'capability pack probe file root is not readable'));
  const tempRoot = await realpath(tmpdir());
  if (!pathInside(tempRoot, actual) || !path.basename(actual).startsWith(CAPABILITY_PACK_PROBE_FILE_ROOT_PREFIX)) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_FILE_ROOT', 'capability pack probe file root must be a world-host temp directory');
  }
  const probePath = path.join(actual, CAPABILITY_PACK_PROBE_FILE_NAME);
  const info = await lstat(probePath).catch(() => fail('ERR_CAPABILITY_PACK_ADAPTER_FILE_ROOT', 'capability pack probe file is missing'));
  if (info.isSymbolicLink() || !info.isFile()) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_FILE_ROOT', 'capability pack probe file must be a regular file');
  }
  const probeActual = await realpath(probePath);
  if (!pathInside(actual, probeActual)) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_FILE_ROOT', 'capability pack probe file escapes its root');
  }
  return Object.freeze({ root: actual, locallyOwned: false });
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
    return result.ok ? 0 : 1;
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
        const headPreflight = importedHeadPreflight(candidate);
        const pendingRequests = headPreflight.pendingRequests;
        const mayBypassPreflightRequirements = importedHeadCanBypassPreflightRequirements(candidate.bundle.head);
        const effectResolutionInputs = pendingRequests.length > 0
          ? await importedEffectResolutionInputs(candidate.bundle, store)
          : new Map();
        const preflightOptions = !mayBypassPreflightRequirements && options.agentRuntimeOptionsArgs
          ? agentRuntimeRunOptions(options.agentRuntimeOptionsArgs, options)
          : options;
        if (candidate.bundle.head?.status === 'needs_host' && pendingRequests.length === 0) {
          fail('ERR_IMPORT_PREFLIGHT_NEEDS_HOST_REQUESTS_EMPTY', 'receiver preflight rejects needs_host imports with no pending HostRequests');
        }
        const bypassesPreflightRequirements = mayBypassPreflightRequirements && pendingRequests.length === 0;
        const application = bypassesPreflightRequirements
          ? { ...candidate.bundle.application, requiredActuators: [], requiredHostAuthorityLabels: [], requiredRuntimeLimits: {} }
          : candidate.bundle.application;
        const applianceManifest = await importedApplianceManifest(candidate.bundle, application, store, headPreflight.manifestFingerprint, {
          required: !bypassesPreflightRequirements,
        });
        const policy = createRunPolicy(preflightOptions.effectPolicy ?? createRunPolicy());
        const mapped = importedPendingRequestsForPreflight(
          pendingRequests,
          preflightOptions.hostRequestMapper ?? worldHostRequestToEffectRequest,
          policy,
        );
        const report = preflightCapabilities({
          application,
          applianceManifest,
          currentHead: candidate.bundle.head,
          currentBranchId: candidate.selectedBranchId,
          pendingRequests: mapped.pendingRequests,
          drivers: preflightOptions.effectDrivers ?? [],
          policy,
          effectRecords: candidate.bundle.effects ?? [],
          effectResolutionInputs,
        });
        return importedPreflightReport(report, pendingRequests.length, mapped.unresolvedPendingRequestRoutes);
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

async function importedEffectResolutionInputs(bundle, store) {
  const inputs = new Map();
  for (const effect of bundle?.effects ?? []) {
    if (!effect?.resolutionInputRef || !['resolved', 'submitted', 'closure_committed'].includes(effect.state)) continue;
    const bytes = carrierBundleBlobBytesOptional(bundle, effect.resolutionInputRef, 'effect resolution') ??
      await storedCarrierBlobBytes(store, effect.resolutionInputRef);
    if (!bytes) {
      fail('ERR_IMPORT_PREFLIGHT_EFFECT_RESOLUTION_MISSING', 'receiver preflight requires exported reusable effect ResolutionInput bytes');
    }
    inputs.set(blobRefKey(effect.resolutionInputRef), bytes);
  }
  return inputs;
}

function importedPendingRequestsForPreflight(worldRequests, mapper, policy) {
  const pendingRequests = [];
  const unresolvedPendingRequestRoutes = [];
  for (let index = 0; index < worldRequests.length; index += 1) {
    const worldRequest = worldRequests[index];
    try {
      pendingRequests.push(importedMappedHostRequest(mapper(worldRequest), index, worldRequest));
    } catch (error) {
      if (policy.allowPartialEffectBatch !== true) throw error;
      unresolvedPendingRequestRoutes.push(importedUnresolvedPendingRequestRoute(index, worldRequest, error));
    }
  }
  return { pendingRequests, unresolvedPendingRequestRoutes };
}

function importedMappedHostRequest(hostRequest, index, worldRequest) {
  const next = { ...hostRequest };
  if (worldRequest?.requestFingerprint != null) {
    next.hostRequestFingerprint = worldHostRequestFingerprint(worldRequest);
  }
  const worldHostReplyBinding = maybeWorldHostReplyBindingDiagnostics(worldRequest);
  if (worldHostReplyBinding) {
    next.diagnostics = {
      ...(next.diagnostics ?? {}),
      worldHostReplyBinding,
    };
  }
  next.pendingRequestIndex = index;
  return next;
}

function importedUnresolvedPendingRequestRoute(index, worldRequest, error) {
  return {
    actuatorRef: `world:actuator-ref:${fingerprintString(worldRequest?.actuatorRefFingerprint)}`,
    descriptorFingerprint: `world:descriptor:${fingerprintString(worldRequest?.expectedResponseDescriptorFingerprint)}`,
    hostRequestFingerprint: worldHostRequestFingerprint(worldRequest),
    pendingRequestIndex: index,
    driverId: null,
    driverIndex: null,
    blockers: [error?.code ?? 'ERR_HOST_REQUEST_MAPPER_REJECTED'],
  };
}

function importedPreflightReport(report, pendingRequestCount, mapperUnresolvedPendingRequestRoutes) {
  const unresolvedPendingRequestRoutes = [
    ...mapperUnresolvedPendingRequestRoutes,
    ...(report.unresolvedPendingRequestRoutes ?? []),
  ];
  if (
    pendingRequestCount > 0 &&
    unresolvedPendingRequestRoutes.length > 0 &&
    (report.selectedPendingRequestRoutes?.length ?? 0) === 0 &&
    !(report.blockers?.length)
  ) {
    fail('ERR_PARTIAL_EFFECT_BATCH_EMPTY', 'partial effect batch has no covered HostRequests', {
      unresolvedHostRequestCount: unresolvedPendingRequestRoutes.length,
    });
  }
  if (!mapperUnresolvedPendingRequestRoutes.length) return report;
  return new CapabilityReport({
    ...report,
    everyPendingRequestCovered: false,
    unresolvedPendingRequestRoutes,
  });
}

function worldHostRequestFingerprint(worldRequest) {
  return `world:host-request:${fingerprintString(worldRequest?.requestFingerprint)}`;
}

function maybeWorldHostReplyBindingDiagnostics(worldRequest) {
  try {
    return {
      requestFingerprint: fingerprintString(worldRequest?.requestFingerprint),
      intentFingerprint: fingerprintString(worldRequest?.intentFingerprint),
      envelopeFingerprint: fingerprintString(worldRequest?.envelopeFingerprint),
      idempotencyKeyFingerprint: fingerprintString(worldRequest?.idempotencyKeyFingerprint),
    };
  } catch {
    return null;
  }
}

function fingerprintString(value) {
  if (value == null) fail('ERR_REQUIRED_FIELD', 'fingerprint is required');
  return BigInt(value).toString(16).padStart(16, '0');
}

function importedHeadPreflight(candidate) {
  const head = candidate.bundle?.head;
  const closureBytes = carrierBundleBlobBytes(candidate.bundle, head.turnClosureRef);
  if (head.status === 'genesis') {
    assertImportedGenesisHead(head, closureBytes);
    return { pendingRequests: [], manifestFingerprint: null };
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
  return {
    pendingRequests: decodedStatus === 'needs_host' ? summary.hostRequests : [],
    manifestFingerprint: summary.manifestFingerprint,
  };
}

async function importedApplianceManifest(bundle, application, store, expectedManifestFingerprint, options = {}) {
  const required = options.required !== false;
  const ref = application.applianceManifestRef;
  if (!ref) {
    if (required) {
      fail('ERR_IMPORT_PREFLIGHT_APPLIANCE_MANIFEST_MISSING', 'receiver preflight requires exported ApplianceManifest bytes');
    }
    return null;
  }
  const bytes = carrierBundleBlobBytesOptional(bundle, ref, 'appliance manifest') ??
    await storedCarrierBlobBytes(store, ref);
  if (!bytes) {
    fail('ERR_IMPORT_PREFLIGHT_APPLIANCE_MANIFEST_MISSING', 'receiver preflight requires exported ApplianceManifest bytes');
  }
  if (
    !required &&
    application.installationDiagnostics?.manifestSource !== 'operator-supplied' &&
    isHostGeneratedInstallSummaryBytes(bytes)
  ) return null;
  try {
    const manifest = decodeApplianceManifest(bytes);
    if (expectedManifestFingerprint != null && manifest.manifestFingerprint !== expectedManifestFingerprint) {
      fail('ERR_IMPORT_PREFLIGHT_APPLIANCE_MANIFEST_MISMATCH', 'receiver preflight requires ApplianceManifest fingerprint to match the selected closure', {
        expectedManifestFingerprint: manifestFingerprintDiagnostic(expectedManifestFingerprint),
        actualManifestFingerprint: manifestFingerprintDiagnostic(manifest.manifestFingerprint),
      });
    }
    return manifest;
  } catch (error) {
    if (error?.code === 'ERR_IMPORT_PREFLIGHT_APPLIANCE_MANIFEST_MISMATCH') throw error;
    fail('ERR_IMPORT_PREFLIGHT_APPLIANCE_MANIFEST_INVALID', 'receiver preflight could not decode ApplianceManifest bytes', {
      cause: error.message,
    });
  }
}

function isHostGeneratedInstallSummaryBytes(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return false;
  }
  return parsed?.kind === 'world-host.install-summary' &&
    parsed?.source === 'host-generated-install-summary' &&
    parsed?.worldAuthoredEvidence === false;
}

function manifestFingerprintDiagnostic(value) {
  return `world:manifest:${BigInt(value).toString(16).padStart(16, '0')}`;
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

function carrierBundleBlobBytes(bundle, ref, kind = 'closure') {
  const bytes = carrierBundleBlobBytesOptional(bundle, ref, kind);
  if (bytes) return bytes;
  fail(
    kind === 'effect resolution' ? 'ERR_IMPORT_PREFLIGHT_EFFECT_RESOLUTION_MISSING' : 'ERR_IMPORT_PREFLIGHT_CLOSURE_BLOB_MISSING',
    kind === 'effect resolution'
      ? 'receiver preflight requires exported reusable effect ResolutionInput bytes'
      : 'receiver preflight requires exported needs_host closure bytes',
  );
}

function carrierBundleBlobBytesOptional(bundle, ref, kind = 'closure') {
  const expected = assertBlobRef(ref);
  const blob = (bundle?.blobs ?? [])
    .filter((candidate) => candidate.checksum === expected.checksum && candidate.byteLength === expected.byteLength)
    .find((candidate) => Array.isArray(candidate.bytes));
  if (!blob || !Array.isArray(blob.bytes)) return null;
  const bytes = Uint8Array.from(blob.bytes);
  if (bytes.byteLength !== expected.byteLength || createHash('sha256').update(bytes).digest('hex') !== expected.checksum) {
    fail(importBlobMismatchCode(kind), importBlobMismatchMessage(kind));
  }
  return bytes;
}

function importBlobMismatchCode(kind) {
  if (kind === 'effect resolution') return 'ERR_IMPORT_PREFLIGHT_EFFECT_RESOLUTION_MISMATCH';
  if (kind === 'appliance manifest') return 'ERR_IMPORT_PREFLIGHT_APPLIANCE_MANIFEST_MISMATCH';
  return 'ERR_IMPORT_PREFLIGHT_CLOSURE_BLOB_MISMATCH';
}

function importBlobMismatchMessage(kind) {
  if (kind === 'effect resolution') return 'receiver preflight reusable effect ResolutionInput bytes do not match the effect ref';
  if (kind === 'appliance manifest') return 'receiver preflight ApplianceManifest bytes do not match the application manifest ref';
  return 'receiver preflight closure bytes do not match the selected head ref';
}

async function storedCarrierBlobBytes(store, ref) {
  try {
    return await store.getBlob(ref);
  } catch (error) {
    if (error?.code === 'ERR_BLOB_NOT_FOUND') return null;
    throw error;
  }
}

function blobRefKey(ref) {
  const expected = assertBlobRef(ref);
  return `${expected.algorithm}:${expected.checksum}:${expected.byteLength}`;
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
      requireApprovalForBestEffort: false,
      requireApprovalForDestructiveEffects: false,
      allowedFileRoots: [sandboxRoot],
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
  const inspected = inspectTurnOutput(closureBytes);
  const headSummary = summarizeTurnClosureForRunHead(closureBytes);
  assertReplayHeadMatchesClosure(head, headSummary);
  if (head.status === 'needs_host') {
    fail('ERR_AGENT_RUNTIME_REPLAY_HEAD_INCOMPLETE', 'agent replay requires a terminal head with no pending HostRequests');
  }
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
  const appliedHostReplyFingerprints = inspected.turnReceipt.appliedHostReplyFingerprints.map((value) => value.toString(16).padStart(16, '0'));
  if (new Set(appliedHostReplyFingerprints).size !== appliedHostReplyFingerprints.length) {
    fail('ERR_AGENT_RUNTIME_REPLAY_RECEIPT_DUPLICATE_REPLY', 'agent replay requires unique applied HostReply fingerprints');
  }
  if (appliedHostReplyFingerprints.length !== committedEffectIds.length) {
    fail('ERR_AGENT_RUNTIME_REPLAY_EFFECT_RECEIPT_MISMATCH', 'agent replay committed effect diagnostics must match the TurnReceipt applied replies');
  }
  const journal = new EffectJournal({ store, runId, branchId, parentTurnClosureFingerprint });
  const effects = (await store.listEffectRecords(runId)).filter((effect) => effect.branchId === branchId);
  const retainedBeforeReconcile = effects.filter((effect) => (
    effect.parentTurnClosureFingerprint === parentTurnClosureFingerprint &&
    (effect.state === EffectState.closureCommitted || effect.state === EffectState.submitted) &&
    committedEffectIds.includes(effect.idempotencyKeyWorldFingerprint)
  ));
  const retainedIds = new Set(retainedBeforeReconcile.map((effect) => effect.idempotencyKeyWorldFingerprint));
  const missingEffectIds = committedEffectIds.filter((id) => !retainedIds.has(id));
  let reconciliation = { committedCount: 0 };
  let effectsAfterReconcile = effects;
  if (missingEffectIds.length === 0) {
    await validateRetainedReplayEffects(store, committedEffectIds, retainedBeforeReconcile, appliedHostReplyFingerprints);
    reconciliation = await journal.reconcileCommittedHead(head);
    effectsAfterReconcile = (await store.listEffectRecords(runId)).filter((effect) => effect.branchId === branchId);
  }
  const retained = effectsAfterReconcile.filter((effect) => (
    effect.parentTurnClosureFingerprint === parentTurnClosureFingerprint &&
    effect.state === EffectState.closureCommitted &&
    committedEffectIds.includes(effect.idempotencyKeyWorldFingerprint)
  ));
  const completed = missingEffectIds.length === 0 && head.status === 'completed';
  return {
    command: 'replay',
    ok: completed,
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
      completed,
    },
    effects: summarizeEffectStates(effectsAfterReconcile),
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

function assertReplayHeadMatchesClosure(head, summary) {
  const expectedGeneration = summary.inspectionDiagnostics.turnSequenceNumber + 1;
  if (head.generation !== expectedGeneration) {
    fail('ERR_AGENT_RUNTIME_REPLAY_HEAD_GENERATION_MISMATCH', 'agent replay requires head generation to match selected closure sequence', {
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
      fail('ERR_AGENT_RUNTIME_REPLAY_HEAD_CLOSURE_MISMATCH', 'agent replay requires head metadata to match selected closure', {
        field,
        headValue: head[field],
        closureValue: summary[field],
      });
    }
  }
}

async function validateRetainedReplayEffects(store, committedEffectIds, retainedEffects, appliedHostReplyFingerprints) {
  const effectsById = new Map();
  for (const effect of retainedEffects) {
    if (effectsById.has(effect.idempotencyKeyWorldFingerprint)) {
      fail('ERR_AGENT_RUNTIME_REPLAY_EFFECT_IDS_DUPLICATE', 'agent replay requires unique retained effect ids');
    }
    effectsById.set(effect.idempotencyKeyWorldFingerprint, effect);
  }
  const appliedReplies = new Set(appliedHostReplyFingerprints);
  const retainedReplies = new Set();
  for (const effectId of committedEffectIds) {
    const effect = effectsById.get(effectId);
    const resolutionInputBytes = await replayResolutionInputBytes(store, effect);
    const resolution = decodeResolutionInputBytes(resolutionInputBytes);
    const expectedTarget = `world:host-request:${resolution.targetHostRequestFingerprint.toString(16).padStart(16, '0')}`;
    if (effect.hostRequestFingerprint !== expectedTarget) {
      fail('ERR_AGENT_RUNTIME_REPLAY_EFFECT_TARGET_MISMATCH', 'retained replay ResolutionInput targets a different HostRequest');
    }
    let replyFingerprint;
    try {
      replyFingerprint = effectRecordHostReplyFingerprint(effect, resolutionInputBytes, resolution.targetHostRequestFingerprint);
    } catch (error) {
      if (error?.code === 'ERR_EFFECT_HOST_REPLY_BINDING_TARGET_MISMATCH') {
        fail('ERR_AGENT_RUNTIME_REPLAY_EFFECT_RECEIPT_TARGET_MISMATCH', 'retained replay HostReply binding targets a different HostRequest', {
          cause: error?.message ?? String(error),
        });
      }
      fail('ERR_AGENT_RUNTIME_REPLAY_EFFECT_RECEIPT_BINDING_REQUIRED', 'retained replay effects must carry HostReply binding diagnostics', {
        cause: error?.message ?? String(error),
      });
    }
    if (!appliedReplies.has(replyFingerprint)) {
      fail('ERR_AGENT_RUNTIME_REPLAY_EFFECT_RECEIPT_MISMATCH', 'retained replay effect was not applied by the TurnReceipt');
    }
    if (retainedReplies.has(replyFingerprint)) {
      fail('ERR_AGENT_RUNTIME_REPLAY_RECEIPT_DUPLICATE_REPLY', 'retained replay effects must map to unique HostReply fingerprints');
    }
    retainedReplies.add(replyFingerprint);
  }
}

async function replayResolutionInputBytes(store, effect) {
  if (!effect?.resolutionInputRef) {
    fail('ERR_AGENT_RUNTIME_REPLAY_EFFECT_RESOLUTION_MISSING', 'retained replay effects require ResolutionInput blobs');
  }
  try {
    return await store.getBlob(effect.resolutionInputRef);
  } catch (error) {
    fail('ERR_AGENT_RUNTIME_REPLAY_EFFECT_RESOLUTION_MISSING', 'retained replay ResolutionInput blob is missing or unreadable', {
      cause: error?.message ?? String(error),
    });
  }
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
    'capability-runtime': '../../examples/capability_runtime/run.mjs',
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
