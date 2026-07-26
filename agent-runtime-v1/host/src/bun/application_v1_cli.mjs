import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';

import {
  ApplicationWorker,
  DirectoryApplicationStoreV1,
  FrameStatus,
  RunControllerV1,
  decodeEffectResult,
} from '../v1/index.mjs';
import { fail } from '../v1/errors.mjs';

const MAXIMUM_APPLICATION_BYTES = 64 << 20;
const MAXIMUM_MIGRATION_TRANSPORT_BYTES = 96 << 20;
const MAXIMUM_MIGRATION_MANIFEST_BYTES = 1 << 20;
const MAXIMUM_MIGRATION_FRAME_BYTES = 8 << 20;
const MAXIMUM_MIGRATION_RESULT_BYTES = 2 << 20;
const DEFAULT_INSPECTION_TIMEOUT_MS = 5_000;
const MAXIMUM_INSPECTION_TIMEOUT_MS = 60_000;

export async function runApplicationV1Cli(args, io, options = {}) {
  const command = args[0] ?? 'help';
  if (command === 'inspect-app') return await inspectApplicationWasm(args.slice(1), io, options);
  if (command === 'install') return await installApplication(args.slice(1), io, options);
  if (command === 'run') return await runApplication(args.slice(1), io, options);
  if (command === 'resume') return await resumeApplication(args.slice(1), io, options, 'app resume');
  if (command === 'retry') return await replayRetainedApplication(args.slice(1), io, options, 'app retry');
  if (command === 'replay') return await replayRetainedApplication(args.slice(1), io, options, 'app replay');
  if (command === 'inspect') return await inspectApplication(args.slice(1), io, options);
  if (command === 'fork') return await forkApplication(args.slice(1), io, options);
  if (command === 'branch') return await forkApplication(args.slice(1), io, options, 'app branch');
  if (command === 'export') return await exportApplication(args.slice(1), io, options);
  if (command === 'import') return await importApplication(args.slice(1), io, options);
  if (command === 'list') return await listApplications(args.slice(1), io);
  io.stdout.write('world-host commands: inspect-app, install, run, resume, retry, replay, inspect, fork, branch, export, import, list\n');
  return command === 'help' || command === '--help' || command === '-h' ? 0 : 2;
}

async function inspectApplicationWasm(args, io, options) {
  const wasmPath = valueAfter(args, '--wasm') ?? positional(args);
  const wasmBytes = await readBoundedFile(wasmPath, MAXIMUM_APPLICATION_BYTES, 'application WASM');
  const inspection = await inspectApplicationInWorker(wasmBytes, options);
  writeJson(io, {
    command: 'app inspect-app',
    inspectionMode: 'isolated-runtime',
    ...inspection,
  });
  return 0;
}

async function inspectApplicationInWorker(wasmBytes, options) {
  const timeoutMs = options.inspectionTimeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAXIMUM_INSPECTION_TIMEOUT_MS) {
    fail('ERR_APPLICATION_V1_CLI_OPTION', 'invalid inspection timeout');
  }
  const worker = new Worker(new URL('./application_v1_inspection_worker.mjs', import.meta.url), {
    type: 'module',
  });
  const transferableBytes = Uint8Array.from(wasmBytes);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      operation();
    };
    const timer = setTimeout(() => finish(() => reject(inspectionError(
      'ERR_APPLICATION_V1_WASM_INSPECTION_TIMEOUT',
      `application inspection exceeded ${timeoutMs} ms`,
    ))), timeoutMs);
    worker.onmessage = ({ data }) => {
      if (data?.ok === true) finish(() => resolve(data.inspection));
      else finish(() => reject(inspectionError(
        data?.error?.code ?? 'ERR_APPLICATION_V1_WASM_INSPECTION',
        data?.error?.message ?? 'application inspection failed',
        data?.error?.details ?? {},
      )));
    };
    worker.onerror = (event) => finish(() => reject(inspectionError(
      'ERR_APPLICATION_V1_WASM_INSPECTION',
      event?.message ?? 'application inspection worker failed',
    )));
    worker.postMessage({
      wasmBytes: transferableBytes.buffer,
      workerOptions: options.workerOptions ?? {},
    }, [transferableBytes.buffer]);
  });
}

function inspectionError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'WorldApplicationHostError';
  error.code = code;
  error.details = details;
  return error;
}

async function installApplication(args, io, options) {
  const store = new DirectoryApplicationStoreV1(requiredOption(args, '--store'));
  const wasmBytes = await readBoundedFile(requiredOption(args, '--wasm'), MAXIMUM_APPLICATION_BYTES, 'application WASM');
  const controller = await createController(store, wasmBytes, options);
  const manifest = controller.manifest;
  const record = await store.applications.register({
    name: valueAfter(args, '--name') ?? manifest.applicationName,
    applicationId: hex(manifest.applicationId),
    applicationVersion: manifest.applicationVersion,
    wasmRef: controller.wasmRef,
    manifestRef: controller.manifestRef,
  });
  writeJson(io, {
    command: 'app install',
    application: summarizeApplication(record),
    residualEffectCount: manifest.residualEffects.length,
    requiredHostCapabilities: manifest.requiredHostCapabilities.toString(),
  });
  return 0;
}

async function runApplication(args, io, options) {
  const store = new DirectoryApplicationStoreV1(requiredOption(args, '--store'));
  const application = await store.applications.get(valueAfter(args, '--app') ?? positional(args));
  const controller = await loadController(store, application, options);
  const initialArgsPath = valueAfter(args, '--initial-args');
  const initialArgsBytes = initialArgsPath === null
    ? Buffer.alloc(0)
    : await readBoundedFile(initialArgsPath, controller.manifest.limits.maximumInitialArgsBytes, 'initial arguments');
  const runId = valueAfter(args, '--run') ?? `run-${randomUUID()}`;
  const branchId = valueAfter(args, '--branch') ?? 'main';
  const result = await controller.initialize(runId, branchId, {
    initialArgsBytes,
    fuel: fuelFrom(args, controller.manifest),
  });
  writeJson(io, summarizeAdvance('app run', runId, branchId, application, result));
  return result.status === 'conflict' ? 3 : 0;
}

async function resumeApplication(args, io, options, command, { retainedOnly = false } = {}) {
  const store = new DirectoryApplicationStoreV1(requiredOption(args, '--store'));
  const runId = requiredOption(args, '--run');
  const branchId = valueAfter(args, '--branch') ?? 'main';
  const head = await store.headStore.readHead(runId, branchId);
  if (head === null) fail('ERR_APPLICATION_V1_BRANCH_NOT_FOUND');
  const application = await store.applications.get(head.applicationId);
  const controller = await loadController(store, application, options);
  let retained = null;
  if (retainedOnly) {
    const current = await controller.readCurrentFrame(runId, branchId);
    if (current.frame.status !== FrameStatus.needsEffect ||
        current.frame.pendingEffect === null) {
      fail('ERR_APPLICATION_V1_EFFECT_RESULT_REQUIRED');
    }
    retained = await store.effectJournal.readResult({
      runId,
      branchId,
      parentFrameId: current.frame.frameId,
      request: current.frame.pendingEffect,
      limits: controller.manifest.limits,
    });
    if (retained === null) fail('ERR_APPLICATION_V1_EFFECT_RESULT_REQUIRED');
  }
  const effectResultPath = valueAfter(args, '--effect-result');
  const effectResult = effectResultPath === null
    ? null
    : decodeEffectResult(
        await readBoundedFile(effectResultPath, controller.manifest.limits.maximumResultBytes +
          controller.manifest.limits.maximumHostClaimBytes + 256, 'EffectResult'),
        controller.manifest.limits,
      );
  const result = await controller.advance(runId, branchId, {
    effectResult,
    fuel: retained === null
      ? fuelFrom(args, controller.manifest)
      : retainedFuelFrom(args, controller.manifest, retained.record),
    effectMetadata: effectResult === null ? {} : {
      handlerId: valueAfter(args, '--handler') ?? 'operator-supplied',
      handlerConfigurationId: valueAfter(args, '--handler-configuration') ?? 'operator-supplied',
      recoveryClass: valueAfter(args, '--recovery-class') ?? 'replayable',
      externalTransactionRef: valueAfter(args, '--external-transaction'),
    },
  });
  writeJson(io, summarizeAdvance(command, runId, branchId, application, result));
  return result.status === 'conflict' ? 3 : 0;
}

async function replayRetainedApplication(args, io, options, command) {
  for (const option of [
    '--effect-result',
    '--handler',
    '--handler-configuration',
    '--recovery-class',
    '--external-transaction',
  ]) {
    if (args.includes(option)) {
      fail('ERR_APPLICATION_V1_CLI_OPTION', `${command} does not admit ${option}`);
    }
  }
  return await resumeApplication(args, io, options, command, { retainedOnly: true });
}

async function inspectApplication(args, io, options) {
  const store = new DirectoryApplicationStoreV1(requiredOption(args, '--store'));
  const runId = requiredOption(args, '--run');
  const branchId = valueAfter(args, '--branch') ?? 'main';
  const head = await store.headStore.readHead(runId, branchId);
  if (head === null) fail('ERR_APPLICATION_V1_BRANCH_NOT_FOUND');
  const application = await store.applications.get(head.applicationId);
  const controller = await loadController(store, application, options);
  const current = await controller.readCurrentFrame(runId, branchId);
  writeJson(io, {
    command: 'app inspect',
    runId,
    branchId,
    application: summarizeApplication(application),
    head: summarizeHead(current.head),
    frame: summarizeFrame(current.frame, current.frameBytes.length),
  });
  return 0;
}

async function forkApplication(args, io, options, command = 'app fork') {
  const store = new DirectoryApplicationStoreV1(requiredOption(args, '--store'));
  const runId = requiredOption(args, '--run');
  const sourceBranchId = valueAfter(args, '--source-branch') ?? 'main';
  const targetBranchId = requiredOption(args, '--branch');
  const source = await store.headStore.readHead(runId, sourceBranchId);
  if (source === null) fail('ERR_APPLICATION_V1_BRANCH_NOT_FOUND');
  const application = await store.applications.get(source.applicationId);
  const controller = await loadController(store, application, options);
  const head = await controller.forkBranch(runId, sourceBranchId, targetBranchId);
  writeJson(io, {
    command,
    runId,
    sourceBranchId,
    targetBranchId,
    application: summarizeApplication(application),
    head: summarizeHead(head),
  });
  return 0;
}

async function exportApplication(args, io, options) {
  const store = new DirectoryApplicationStoreV1(requiredOption(args, '--store'));
  const runId = requiredOption(args, '--run');
  const branchId = valueAfter(args, '--branch') ?? 'main';
  const outputPath = requiredOption(args, '--out');
  const head = await store.headStore.readHead(runId, branchId);
  if (head === null) fail('ERR_APPLICATION_V1_BRANCH_NOT_FOUND');
  const application = await store.applications.get(head.applicationId);
  const controller = await loadController(store, application, options);
  const bundle = await controller.exportBranch(runId, branchId);
  await writeFile(outputPath, `${JSON.stringify(encodeMigrationTransport(bundle), null, 2)}\n`);
  writeJson(io, {
    command: 'app export',
    runId,
    branchId,
    application: summarizeApplication(application),
    frameId: bundle.frameId,
    retainedEffectResult: bundle.retainedEffectResultBytes !== null,
  });
  return 0;
}

async function importApplication(args, io, options) {
  const store = new DirectoryApplicationStoreV1(requiredOption(args, '--store'));
  const inputPath = requiredOption(args, '--in');
  const runId = requiredOption(args, '--run');
  const branchId = valueAfter(args, '--branch') ?? 'main';
  const transportBytes = await readBoundedFile(inputPath, MAXIMUM_MIGRATION_TRANSPORT_BYTES, 'migration transport');
  const bundle = decodeMigrationTransport(transportBytes);
  const admittedApplication = await createController(store, bundle.applicationWasmBytes, options);
  const admittedManifest = admittedApplication.manifest;
  if (hex(admittedManifest.applicationId) !== bundle.applicationId ||
      !Buffer.from(admittedManifest.encodedBytes).equals(bundle.manifestBytes)) {
    fail('ERR_APPLICATION_V1_MIGRATION_MANIFEST');
  }
  const application = await store.applications.register({
    name: valueAfter(args, '--name') ?? admittedManifest.applicationName,
    applicationId: hex(admittedManifest.applicationId),
    applicationVersion: admittedManifest.applicationVersion,
    wasmRef: admittedApplication.wasmRef,
    manifestRef: admittedApplication.manifestRef,
  });
  const imported = await RunControllerV1.importBranch({
    bundle,
    runId,
    branchId,
    blockStore: store.blockStore,
    headStore: store.headStore,
    effectJournal: store.effectJournal,
    workerFactory: applicationWorkerFactory(options),
    preflight: async () => ({ blockers: [] }),
  });
  writeJson(io, {
    command: 'app import',
    runId,
    branchId,
    application: summarizeApplication(application),
    head: summarizeHead(imported.head),
    receiverPreflightApplied: true,
  });
  return 0;
}

async function listApplications(args, io) {
  const store = new DirectoryApplicationStoreV1(requiredOption(args, '--store'));
  writeJson(io, {
    command: 'app list',
    applications: (await store.applications.list()).map(summarizeApplication),
  });
  return 0;
}

async function createController(store, wasmBytes, options) {
  return await RunControllerV1.create({
    wasmBytes,
    blockStore: store.blockStore,
    headStore: store.headStore,
    effectJournal: store.effectJournal,
    workerFactory: applicationWorkerFactory(options),
    preflight: options.preflight,
  });
}

function applicationWorkerFactory(options) {
  return () => new ApplicationWorker(options.workerOptions);
}

async function loadController(store, application, options) {
  const wasmBytes = await store.blockStore.getBlock(application.wasmRef);
  const controller = await createController(store, wasmBytes, options);
  const manifest = controller.manifest;
  if (hex(manifest.applicationId) !== application.applicationId || manifest.applicationVersion !== application.applicationVersion ||
      controller.manifestRef.checksum !== application.manifestRef.checksum ||
      controller.manifestRef.byteLength !== application.manifestRef.byteLength) {
    fail('ERR_APPLICATION_V1_APPLICATION_REGISTRY');
  }
  return controller;
}

function summarizeAdvance(command, runId, branchId, application, result) {
  if (result.status === 'conflict') {
    return {
      command,
      runId,
      branchId,
      status: 'conflict',
      application: summarizeApplication(application),
      currentHead: result.currentHead === null ? null : summarizeHead(result.currentHead),
      retainedFrameId: hex(result.retainedFrame.frameId),
    };
  }
  return {
    command,
    runId,
    branchId,
    status: 'advanced',
    application: summarizeApplication(application),
    head: summarizeHead(result.nextHead),
    frame: summarizeFrame(result.frame, result.frameBytes.length),
  };
}

function summarizeApplication(record) {
  return {
    name: record.name,
    applicationId: record.applicationId,
    applicationVersion: record.applicationVersion,
    wasm: summarizeRef(record.wasmRef),
    manifest: summarizeRef(record.manifestRef),
  };
}

function summarizeHead(head) {
  return {
    generation: head.generation,
    applicationId: head.applicationId,
    frameId: head.frameId,
    frameArtifactChecksum: head.frameRef.checksum,
    frameByteLength: head.frameRef.byteLength,
    status: frameStatusName(head.status),
  };
}

function summarizeFrame(frame, byteLength) {
  return {
    frameId: hex(frame.frameId),
    parentFrameId: frame.parentFrameId === null ? null : hex(frame.parentFrameId),
    sequence: frame.sequence.toString(),
    status: frameStatusName(frame.status),
    byteLength,
    pendingEffect: frame.pendingEffect === null ? null : {
      requestId: hex(frame.pendingEffect.requestId),
      interfaceId: hex(frame.pendingEffect.interfaceId),
      siteId: frame.pendingEffect.siteId.toString(),
      payloadSchemaId: hex(frame.pendingEffect.payloadSchemaId),
      resultSchemaId: hex(frame.pendingEffect.resultSchemaId),
      idempotencyKey: hex(frame.pendingEffect.idempotencyKey),
    },
    finalResult: frame.finalResultBytes === null ? null : {
      schemaId: hex(frame.finalResultSchemaId),
      byteLength: frame.finalResultBytes.length,
    },
    failureByteLength: frame.failure?.length ?? 0,
    resourceCounters: Object.fromEntries(
      Object.entries(frame.resourceCounters).map(([key, value]) => [key, value.toString()]),
    ),
  };
}

function summarizeRef(ref) {
  return { algorithm: ref.algorithm, checksum: ref.checksum, byteLength: ref.byteLength };
}

function frameStatusName(status) {
  for (const [name, value] of Object.entries(FrameStatus)) if (value === status) return name;
  fail('ERR_APPLICATION_V1_FRAME_STATUS');
}

function encodeMigrationTransport(bundle) {
  return {
    transportVersion: 'world-host.application-migration-json-v1',
    bundleVersion: bundle.bundleVersion,
    applicationId: bundle.applicationId,
    applicationWasmBase64: Buffer.from(bundle.applicationWasmBytes).toString('base64'),
    manifestBase64: Buffer.from(bundle.manifestBytes).toString('base64'),
    sourceHeadGeneration: bundle.sourceHeadGeneration,
    frameId: bundle.frameId,
    frameArtifactChecksum: bundle.frameArtifactChecksum,
    frameStatus: bundle.frameStatus,
    frameBase64: Buffer.from(bundle.frameBytes).toString('base64'),
    retainedEffectResultBase64: bundle.retainedEffectResultBytes === null
      ? null
      : Buffer.from(bundle.retainedEffectResultBytes).toString('base64'),
    retainedEffectFuel: bundle.retainedEffectFuel,
  };
}

function decodeMigrationTransport(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('ERR_APPLICATION_V1_MIGRATION_TRANSPORT');
  }
  const fields = [
    'applicationId',
    'applicationWasmBase64',
    'bundleVersion',
    'frameArtifactChecksum',
    'frameBase64',
    'frameId',
    'frameStatus',
    'manifestBase64',
    'retainedEffectResultBase64',
    'retainedEffectFuel',
    'sourceHeadGeneration',
    'transportVersion',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== fields.sort().join('\0') ||
      value.transportVersion !== 'world-host.application-migration-json-v1') {
    fail('ERR_APPLICATION_V1_MIGRATION_TRANSPORT');
  }
  return {
    bundleVersion: value.bundleVersion,
    applicationId: value.applicationId,
    applicationWasmBytes: decodeBase64(value.applicationWasmBase64, MAXIMUM_APPLICATION_BYTES),
    manifestBytes: decodeBase64(value.manifestBase64, MAXIMUM_MIGRATION_MANIFEST_BYTES),
    sourceHeadGeneration: value.sourceHeadGeneration,
    frameId: value.frameId,
    frameArtifactChecksum: value.frameArtifactChecksum,
    frameStatus: value.frameStatus,
    frameBytes: decodeBase64(value.frameBase64, MAXIMUM_MIGRATION_FRAME_BYTES),
    retainedEffectResultBytes: value.retainedEffectResultBase64 === null
      ? null
      : decodeBase64(value.retainedEffectResultBase64, MAXIMUM_MIGRATION_RESULT_BYTES),
    retainedEffectFuel: value.retainedEffectFuel,
  };
}

function decodeBase64(value, maximum) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail('ERR_APPLICATION_V1_MIGRATION_BASE64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maximum || bytes.toString('base64') !== value) fail('ERR_APPLICATION_V1_MIGRATION_BASE64');
  return bytes;
}

async function readBoundedFile(file, maximum, label) {
  const info = await stat(file);
  if (!info.isFile() || info.size > maximum) fail('ERR_APPLICATION_V1_FILE_LIMIT', `${label} exceeds ${maximum} bytes`);
  const bytes = await readFile(file);
  if (bytes.length > maximum) fail('ERR_APPLICATION_V1_FILE_LIMIT', `${label} exceeds ${maximum} bytes`);
  return bytes;
}

function fuelFrom(args, manifest) {
  const raw = valueAfter(args, '--fuel');
  const fuel = raw === null ? manifest.limits.maximumFuelPerStep : parseUnsigned(raw, 'fuel');
  if (fuel === 0n || fuel > manifest.limits.maximumFuelPerStep) fail('ERR_APPLICATION_V1_FUEL');
  return fuel;
}

function retainedFuelFrom(args, manifest, record) {
  const retainedFuel = parseUnsigned(record.fuel, 'retained fuel');
  if (retainedFuel === 0n || retainedFuel > manifest.limits.maximumFuelPerStep) {
    fail('ERR_APPLICATION_V1_EFFECT_JOURNAL_FUEL');
  }
  const raw = valueAfter(args, '--fuel');
  if (raw === null) return retainedFuel;
  const requestedFuel = parseUnsigned(raw, 'fuel');
  if (requestedFuel !== retainedFuel) fail('ERR_APPLICATION_V1_RETAINED_FUEL_MISMATCH');
  return retainedFuel;
}

function parseUnsigned(value, label) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail('ERR_APPLICATION_V1_CLI_OPTION', label);
  return BigInt(value);
}

function requiredOption(args, name) {
  const value = valueAfter(args, name);
  if (value === null) fail('ERR_APPLICATION_V1_CLI_OPTION', `missing required option: ${name}`);
  return value;
}

function valueAfter(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
    fail('ERR_APPLICATION_V1_CLI_OPTION', `${name} requires a value`);
  }
  return args[index + 1];
}

function positional(args) {
  const value = args.find((item, index) => index === 0 && !item.startsWith('--')) ?? null;
  if (value === null) fail('ERR_APPLICATION_V1_CLI_OPTION', 'missing application identifier');
  return value;
}

function writeJson(io, value) {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function hex(value) {
  return Buffer.from(value).toString('hex');
}
