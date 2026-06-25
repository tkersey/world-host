import { EffectJournal } from './effect_journal.mjs';
import { assertDurableRecoveryAllowed } from './actuator.mjs';
import { createRunHead } from './run.mjs';
import { assertBytes, fail, fromUtf8, toHex } from './store.mjs';
import { decodeResolutionInputBytes, encodeContinueTurnInput } from '../protocol/world_appliance_wire_codec.mjs';
import { inspectTurnOutput, summarizeTurnClosureForRunHead } from '../protocol/world_universal_appliance_codec.mjs';

export class WorldWorker {
  constructor() {
    this.disposed = false;
    this.loadedExecutableFingerprint = null;
    this.binding = null;
    this.lastTurnClosureBytes = null;
    this.runtimeManifest = null;
  }

  async instantiate(wasmBytes) {
    this.#assertLive();
    const bytes = assertBytes(wasmBytes, 'wasmBytes');
    this.runtimeManifest = Object.freeze({
      kind: 'world-host.worker-runtime',
      wasmByteLength: bytes.byteLength,
      importCount: 0,
      abiValidated: false,
    });
    return this.runtimeManifest;
  }

  readRuntimeManifest() {
    this.#assertLive();
    return this.runtimeManifest ?? fail('ERR_WORKER_NOT_INSTANTIATED');
  }

  async loadExecutable(imageBytes) {
    this.#assertLive();
    const bytes = assertBytes(imageBytes, 'imageBytes');
    this.loadedExecutableFingerprint = `sha256:${await sha256Hex(bytes)}`;
    return { executableImageFingerprint: this.loadedExecutableFingerprint };
  }

  readApplianceManifest() {
    this.#assertLive();
    return Object.freeze({
      kind: 'world-host.appliance-manifest-placeholder',
      evidenceAuthority: false,
    });
  }

  async submitTurn(turnInputBytes) {
    this.#assertLive();
    assertBytes(turnInputBytes, 'turnInputBytes');
    fail('ERR_RELEASED_WORLD_WIRE_CODEC_NOT_INSTALLED', 'submitTurn requires the released World wire codec or a conformance worker');
  }

  readTurnClosure() {
    this.#assertLive();
    if (!this.lastTurnClosureBytes) fail('ERR_TURN_CLOSURE_NOT_AVAILABLE');
    return new Uint8Array(this.lastTurnClosureBytes);
  }

  reset() {
    this.#assertLive();
    this.binding = null;
    this.lastTurnClosureBytes = null;
  }

  unload() {
    this.#assertLive();
    this.loadedExecutableFingerprint = null;
    this.binding = null;
    this.lastTurnClosureBytes = null;
  }

  dispose() {
    this.disposed = true;
    this.binding = null;
    this.lastTurnClosureBytes = null;
  }

  bind(binding) {
    this.#assertLive();
    this.binding = createWorkerBinding(binding);
    return this.binding;
  }

  #assertLive() {
    if (this.disposed) fail('ERR_WORKER_DISPOSED');
  }
}

export class RunController {
  constructor({
    store,
    workerFactory,
    wasmBytes,
    turnInputFactory,
    effectDrivers = [],
    effectPolicy = {},
    effectContextFactory = defaultEffectContextFactory,
    hostRequestMapper = worldHostRequestToEffectRequest,
  } = {}) {
    if (!store) fail('ERR_RUN_CONTROLLER_STORE_REQUIRED');
    if (typeof workerFactory !== 'function') fail('ERR_RUN_CONTROLLER_WORKER_FACTORY_REQUIRED');
    this.store = store;
    this.workerFactory = workerFactory;
    this.wasmBytes = wasmBytes ?? fromUtf8('world-host:conformance-wasm-placeholder');
    this.turnInputFactory = turnInputFactory ?? defaultTurnInputFactory;
    this.effectDrivers = [...effectDrivers];
    this.effectPolicy = { ...effectPolicy };
    this.effectContextFactory = effectContextFactory;
    this.hostRequestMapper = hostRequestMapper;
    this.warmWorker = null;
  }

  async advance(runId, branchId, options = {}) {
    const run = await this.store.getRun(runId);
    const application = await this.store.getApplication(run.applicationId);
    const parentHead = await this.store.readHead(runId, branchId);
    const parentClosureBytes = await this.store.getBlob(parentHead.turnClosureRef);
    const imageBytes = await this.store.getBlob(application.executableImageRef);
    const executableHostFingerprint = `sha256:${await sha256Hex(imageBytes)}`;
    const worker = await this.#workerFor({
      applicationId: run.applicationId,
      branchId,
      turnClosureWorldFingerprint: parentHead.turnClosureWorldFingerprint,
      resultingStateFingerprint: parentHead.resultingStateFingerprint,
      turnSequence: parentHead.generation,
    });

    if (worker.loadedExecutableFingerprint !== executableHostFingerprint) await worker.loadExecutable(imageBytes);
    if (typeof worker.restoreFromTurnClosure === 'function') await worker.restoreFromTurnClosure(parentClosureBytes, parentHead);

    const effectTurn = await this.#effectTurnInput({ run, branchId, application, parentHead, parentClosureBytes, worker, options });
    const turnInputBytes = effectTurn?.turnInputBytes ?? await this.turnInputFactory({ run, branchId, application, parentHead, parentClosureBytes, worker, options });
    const turnResult = options.turnResult ?? await worker.submitTurn(turnInputBytes);
    const nextClosureBytes = assertBytes(turnResult.turnClosureBytes ?? worker.readTurnClosure(), 'turnClosureBytes');
    const inspected = deriveTurnResult(turnResult, nextClosureBytes);
    if ((inspected.archiveMomentFingerprint == null) !== (inspected.archiveSealFingerprint == null)) {
      fail('ERR_PARTIAL_ARCHIVE_ANCHOR', 'archive moment and seal must both be present or both be absent');
    }
    const retainedArchivePending = inspected.archiveMomentFingerprint == null;
    const turnClosureRef = await this.store.putBlob(nextClosureBytes);
    const nextHead = createRunHead({
      generation: parentHead.generation + 1,
      turnClosureRef,
      turnClosureWorldFingerprint: requiredString(inspected.turnClosureWorldFingerprint, 'turnClosureWorldFingerprint'),
      resultingStateFingerprint: requiredString(inspected.resultingStateFingerprint, 'resultingStateFingerprint'),
      chronicleCursor: requiredString(inspected.chronicleCursor, 'chronicleCursor'),
      archiveMomentFingerprint: retainedArchivePending ? parentHead.archiveMomentFingerprint : requiredString(inspected.archiveMomentFingerprint, 'archiveMomentFingerprint'),
      archiveSealFingerprint: retainedArchivePending ? parentHead.archiveSealFingerprint : requiredString(inspected.archiveSealFingerprint, 'archiveSealFingerprint'),
      status: inspected.status ?? 'needs_host',
      updateDiagnostics: {
        workerWarm: worker === this.warmWorker,
        parentTurnClosureFingerprint: parentHead.turnClosureWorldFingerprint,
        committedEffectIds: effectTurn?.effects.map((effect) => effect.record.idempotencyKeyWorldFingerprint) ?? [],
        inspectedTurnClosure: inspected.inspectionDiagnostics ?? null,
        retainedArchivePending,
        unresolvedHostRequestCount: effectTurn?.unresolvedHostRequests.length ?? 0,
        unresolvedHostRequests: effectTurn?.unresolvedHostRequests ?? [],
      },
    });
    const cas = await this.store.compareAndSwapHead(runId, branchId, parentHead.generation, nextHead);
    if (!cas.ok) {
      return {
        status: 'branch_conflict',
        orphanClosureRef: turnClosureRef,
        winningHead: cas.current,
        submittedEffects: [],
        unresolvedHostRequests: effectTurn?.unresolvedHostRequests ?? [],
      };
    }
    const submittedEffects = [];
    if (effectTurn) {
      for (const effect of effectTurn.effects) submittedEffects.push(await effectTurn.journal.markSubmitted(effect.record));
    }
    const committedEffects = [];
    for (const effect of submittedEffects) committedEffects.push(await effectTurn.journal.markClosureCommitted(effect));
    worker.bind({
      applicationId: run.applicationId,
      branchId,
      turnClosureWorldFingerprint: cas.current.turnClosureWorldFingerprint,
      resultingStateFingerprint: cas.current.resultingStateFingerprint,
      turnSequence: cas.current.generation,
    });
    return {
      status: 'advanced',
      parentHead,
      nextHead: cas.current,
      closureRef: turnClosureRef,
      workerStatus: worker === this.warmWorker ? 'warm' : 'cold',
      effects: committedEffects,
      unresolvedHostRequests: effectTurn?.unresolvedHostRequests ?? [],
    };
  }

  async #workerFor(binding) {
    if (this.warmWorker && !this.warmWorker.disposed) {
      try {
        assertWarmWorkerBinding(this.warmWorker, binding);
        return this.warmWorker;
      } catch {
        this.warmWorker.dispose();
      }
    }
    const worker = await this.workerFactory();
    await worker.instantiate(this.wasmBytes);
    worker.bind(binding);
    this.warmWorker = worker;
    return worker;
  }

  async #effectTurnInput({ run, branchId, application, parentHead, parentClosureBytes, worker, options }) {
    if (parentHead.status !== 'needs_host') return null;
    let parentSummary;
    try {
      parentSummary = inspectTurnOutput(parentClosureBytes);
    } catch (error) {
      fail('ERR_PARENT_TURN_CLOSURE_INSPECTION_FAILED', error?.message ?? String(error));
    }
    if (parentSummary.hostRequestCount === 0) return null;

    const policy = options.effectPolicy ?? this.effectPolicy;
    const journal = new EffectJournal({
      store: this.store,
      runId: run.runId,
      branchId,
      parentTurnClosureFingerprint: parentHead.turnClosureWorldFingerprint,
      policy,
    });
    const pending = [];
    const unresolvedHostRequests = [];
    for (let index = 0; index < parentSummary.hostRequests.length; index += 1) {
      const worldHostRequest = parentSummary.hostRequests[index];
      const hostRequest = this.hostRequestMapper(worldHostRequest);
      const selection = selectEffectDriver(this.effectDrivers, hostRequest, policy);
      if (!selection) {
        unresolvedHostRequests.push(unresolvedHostRequestDiagnostic(index, hostRequest));
        continue;
      }
      pending.push({ index, worldHostRequest, hostRequest, ...selection });
    }
    if (unresolvedHostRequests.length > 0 && policy.allowPartialEffectBatch !== true) {
      const first = unresolvedHostRequests[0];
      fail('ERR_HOST_REQUEST_DRIVER_UNAVAILABLE', 'no exact driver for pending HostRequest', {
        actuatorRef: first.actuatorRef,
        descriptorFingerprint: first.descriptorFingerprint,
        actuationClass: first.actuationClass,
        unresolvedHostRequestCount: unresolvedHostRequests.length,
      });
    }
    if (pending.length === 0) {
      if (unresolvedHostRequests.length > 0) {
        fail('ERR_PARTIAL_EFFECT_BATCH_EMPTY', 'partial effect batch has no covered HostRequests', {
          unresolvedHostRequestCount: unresolvedHostRequests.length,
        });
      }
      return null;
    }
    if (unresolvedHostRequests.length > 0) {
      for (const unresolved of unresolvedHostRequests) {
        unresolved.policy = 'allowPartialEffectBatch';
      }
    }
    const effects = await this.#resolveEffectBatch({
      journal,
      pending,
      run,
      branchId,
      application,
      parentHead,
      parentClosureBytes,
      worker,
      options,
      policy,
    });
    const resolutions = effects.map((effect) => decodeResolutionInputBytes(effect.resolutionInputBytes));
    return {
      journal,
      effects,
      unresolvedHostRequests,
      turnInputBytes: encodeContinueTurnInput({
        manifestFingerprint: parentSummary.manifestFingerprint,
        previousTurnReceiptFingerprint: parentSummary.turnReceipt.receiptFingerprint,
        turnSequenceNumber: parentSummary.turnSequenceNumber + 1n,
        resolutions,
        metadata: options.effectTurnMetadata ?? 'world-host.runcontroller.effects',
      }),
    };
  }

  async #resolveEffectBatch({ journal, pending, run, branchId, application, parentHead, parentClosureBytes, worker, options, policy }) {
    const effects = new Array(pending.length);
    const pendingPositions = new Map(pending.map((item, index) => [item, index]));
    const groups = groupPendingEffects(pending);
    await Promise.all(groups.map((group) => runBounded(group, effectConcurrencyLimit(group.manifest, policy), async (item) => {
      effects[pendingPositions.get(item)] = await journal.resolve(
        await this.effectContextFactory({
          run,
          branchId,
          application,
          parentHead,
          parentClosureBytes,
          worker,
          options,
          hostRequest: item.hostRequest,
          worldHostRequest: item.worldHostRequest,
        }),
        item.hostRequest,
        item.driver,
      );
    })));
    return effects;
  }
}

function deriveTurnResult(turnResult, nextClosureBytes) {
  try {
    return summarizeTurnClosureForRunHead(nextClosureBytes);
  } catch (error) {
    fail('ERR_TURN_CLOSURE_INSPECTION_FAILED', error?.message ?? String(error));
  }
}

export function createWorkerBinding(input) {
  return Object.freeze({
    applicationId: requiredString(input.applicationId, 'applicationId'),
    branchId: requiredString(input.branchId, 'branchId'),
    turnClosureWorldFingerprint: requiredString(input.turnClosureWorldFingerprint, 'turnClosureWorldFingerprint'),
    resultingStateFingerprint: requiredString(input.resultingStateFingerprint, 'resultingStateFingerprint'),
    turnSequence: requiredInteger(input.turnSequence, 'turnSequence'),
  });
}

export function assertWarmWorkerBinding(worker, expectedInput) {
  const expected = createWorkerBinding(expectedInput);
  const actual = worker?.binding;
  if (!actual) fail('ERR_WARM_WORKER_UNBOUND');
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) fail('ERR_WARM_WORKER_IDENTITY_MISMATCH', `${key} mismatch`);
  }
  return true;
}

async function defaultTurnInputFactory({ parentHead }) {
  return fromUtf8(`turn-input:${parentHead.turnClosureWorldFingerprint}`);
}

async function defaultEffectContextFactory(context) {
  return context;
}

function selectEffectDriver(drivers, hostRequest, policy = {}) {
  for (const driver of drivers) {
    const manifest = driverManifest(driver);
    if (manifest && driverSupportsManifest(manifest, hostRequest, policy)) {
      return { driver, manifest };
    }
  }
  return null;
}

function driverManifest(driver) {
  if (!driver || typeof driver.manifest !== 'function') return null;
  return driver.manifest();
}

function driverSupports(driver, hostRequest) {
  const manifest = driverManifest(driver);
  return manifest ? driverSupportsManifest(manifest, hostRequest) : false;
}

function driverSupportsManifest(manifest, hostRequest, policy = {}) {
  const structuralMatch = manifest.supportedActuatorRefs?.includes(hostRequest.actuatorRef) === true &&
    manifest.supportedDescriptorFingerprints?.includes(hostRequest.descriptorFingerprint) === true &&
    manifest.supportedActuationClasses?.includes(hostRequest.actuationClass) === true &&
    (!hostRequest.responseSchema || manifest.supportedResponseStatuses?.includes(hostRequest.responseSchema.status) === true);
  if (!structuralMatch) return false;
  if (hostRequest.requestBytes?.byteLength > manifest.maximumRequestBytes) return false;
  const allowedAuthorityLabels = policySet(policy.allowedAuthorityLabels);
  if (allowedAuthorityLabels.size && manifest.authorityLabels.some((label) => !allowedAuthorityLabels.has(label))) return false;
  const allowedHttpOrigins = policySet(policy.allowedHttpOrigins);
  if (allowedHttpOrigins.size && (hostRequest.actuationClass === 'http' || manifest.authorityLabels.includes('network:http'))) {
    const origin = requestOrigin(hostRequest);
    if (!origin || !allowedHttpOrigins.has(origin)) return false;
  }
  try {
    assertDurableRecoveryAllowed(manifest.recoveryClass, policy);
  } catch {
    return false;
  }
  return true;
}

function policySet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

function requestOrigin(hostRequest) {
  try {
    const request = JSON.parse(new TextDecoder().decode(hostRequest.requestBytes));
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

function unresolvedHostRequestDiagnostic(index, hostRequest) {
  return {
    index,
    hostRequestFingerprint: hostRequest.hostRequestFingerprint,
    actuatorRef: hostRequest.actuatorRef,
    descriptorFingerprint: hostRequest.descriptorFingerprint,
    actuationClass: hostRequest.actuationClass,
    responseStatus: hostRequest.responseSchema?.status ?? null,
  };
}

function groupPendingEffects(pending) {
  const groups = new Map();
  for (const item of pending) {
    const key = `${item.manifest.driverId}\0${item.manifest.recoveryClass}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      group.manifest = item.manifest;
      groups.set(key, group);
    }
    group.push(item);
  }
  return [...groups.values()];
}

function effectConcurrencyLimit(manifest, policy = {}) {
  const driverLimit = manifest.concurrencyLimit;
  const policyLimit = policy.maximumConcurrentEffects ?? driverLimit;
  if (!Number.isSafeInteger(driverLimit) || driverLimit < 1) fail('ERR_EFFECT_CONCURRENCY_LIMIT_INVALID', 'driver concurrencyLimit must be at least one');
  if (!Number.isSafeInteger(policyLimit) || policyLimit < 1) fail('ERR_EFFECT_CONCURRENCY_LIMIT_INVALID', 'maximumConcurrentEffects must be at least one');
  return Math.min(driverLimit, policyLimit);
}

async function runBounded(items, limit, fn) {
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  }));
}

export function worldHostRequestToEffectRequest(request) {
  return {
    hostRequestFingerprint: `world:host-request:${fingerprintString(request.requestFingerprint)}`,
    idempotencyKeyBytes: assertBytes(request.idempotencyKeyBytes, 'idempotencyKeyBytes'),
    idempotencyKeyWorldFingerprint: `world:idempotency-key:${fingerprintString(request.idempotencyKeyFingerprint)}`,
    actuatorRef: `world:actuator-ref:${fingerprintString(request.actuatorRefFingerprint)}`,
    descriptorFingerprint: `world:descriptor:${fingerprintString(request.expectedResponseDescriptorFingerprint)}`,
    actuationClass: `world:actuation-class:${request.actuationClass}`,
    responseSchema: {
      status: 'responded',
    },
    requestBytes: request.hostRequestBytes ?? concatBytes([
      request.metadata,
      request.frameRequestBytes,
      request.payloadValueImageBytes,
      request.preparedActuationEvidenceBytes,
    ]),
  };
}

function fingerprintString(value) {
  if (value == null) fail('ERR_REQUIRED_FIELD', 'fingerprint is required');
  return BigInt(value).toString(16).padStart(16, '0');
}

function concatBytes(values) {
  const length = values.reduce((sum, value) => sum + value.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    out.set(value, offset);
    offset += value.byteLength;
  }
  return out;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail('ERR_REQUIRED_FIELD', `${label} is required`);
  return value;
}

function requiredInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('ERR_REQUIRED_INTEGER', `${label} must be nonnegative integer`);
  return value;
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}
