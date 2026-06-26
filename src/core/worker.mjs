import { EffectJournal } from './effect_journal.mjs';
import { assertDurableRecoveryAllowed } from './actuator.mjs';
import { assertCapabilityReportAccepted, createRunPolicy, preflightCapabilities } from './capabilities.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from './run.mjs';
import { assertBytes, fail, fromUtf8, toHex } from './store.mjs';
import { decodeResolutionInputBytes, encodeRestoreTurnInput, resolutionResponded } from '../protocol/world_appliance_wire_codec.mjs';
import { inspectTurnOutput, summarizeTurnClosureForRunHead } from '../protocol/world_universal_appliance_codec.mjs';
import { wyhash64 } from '../protocol/world_loaded_value_codec.mjs';

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
    assertHeadContinuable(parentHead);
    const policy = createRunPolicy(options.effectPolicy ?? this.effectPolicy);
    assertCapabilityReportAccepted(preflightCapabilities({
      application,
      currentHead: parentHead,
      drivers: this.effectDrivers,
      policy,
    }));
    const parentClosureBytes = await this.store.getBlob(parentHead.turnClosureRef);
    assertParentHeadMatchesClosure(parentHead, parentClosureBytes);
    const imageBytes = await this.store.getBlob(application.executableImageRef);
    const executableHostFingerprint = `sha256:${await sha256Hex(imageBytes)}`;
    const { worker, reused: workerReused } = await this.#workerFor({
      applicationId: run.applicationId,
      branchId,
      turnClosureWorldFingerprint: parentHead.turnClosureWorldFingerprint,
      resultingStateFingerprint: parentHead.resultingStateFingerprint,
      turnSequence: parentHead.generation,
    });

    let workerMayBeDirty = false;
    try {
      if (worker.loadedExecutableFingerprint !== executableHostFingerprint) {
        workerMayBeDirty = true;
        await worker.loadExecutable(imageBytes);
      }
      assertParentClosureManifestMatchesWorker(worker, parentHead, parentClosureBytes);
      if (!workerReused && parentHead.status !== 'genesis' && typeof worker.restoreFromTurnClosure === 'function') {
        workerMayBeDirty = true;
        await worker.restoreFromTurnClosure(parentClosureBytes, parentHead);
      }

      const effectTurn = await this.#effectTurnInput({ run, branchId, application, parentHead, parentClosureBytes, worker, options });
      const turnInputBytes = effectTurn?.turnInputBytes ?? await this.turnInputFactory({ run, branchId, application, parentHead, parentClosureBytes, worker, options });
      workerMayBeDirty = true;
      const turnResult = options.turnResult ?? await worker.submitTurn(turnInputBytes);
      const nextClosureBytes = assertBytes(turnResult.turnClosureBytes ?? worker.readTurnClosure(), 'turnClosureBytes');
      const inspected = deriveTurnResult(turnResult, nextClosureBytes);
      assertNextTurnSequence(parentHead, parentClosureBytes, inspected);
      const confirmedEffects = effectTurn ? confirmedTurnEffects(effectTurn.effects, inspected) : [];
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
          workerWarm: workerReused,
          parentTurnClosureFingerprint: parentHead.turnClosureWorldFingerprint,
          committedEffectIds: confirmedEffects.map((effect) => effect.record.idempotencyKeyWorldFingerprint),
          inspectedTurnClosure: inspected.inspectionDiagnostics ?? null,
          retainedArchivePending,
          unresolvedHostRequestCount: effectTurn?.unresolvedHostRequests.length ?? 0,
          unresolvedHostRequests: effectTurn?.unresolvedHostRequests ?? [],
        },
      });
      const cas = await this.store.compareAndSwapHead(runId, branchId, parentHead.generation, nextHead);
      if (!cas.ok) {
        this.#disposeWarmWorker(worker);
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
        for (const effect of confirmedEffects) submittedEffects.push(await effectTurn.journal.markSubmitted(effect.record));
      }
      const committedEffects = [];
      for (const effect of submittedEffects) committedEffects.push(await effectTurn.journal.markClosureCommitted(effect));
      await recordBranchHeadProvenance(this.store, runId, branchId, cas.current);
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
        workerStatus: workerReused ? 'warm' : 'cold',
        effects: committedEffects,
        unresolvedHostRequests: effectTurn?.unresolvedHostRequests ?? [],
      };
    } catch (error) {
      if (workerMayBeDirty) this.#disposeWarmWorker(worker);
      throw error;
    }
  }

  async #workerFor(binding) {
    if (this.warmWorker && !this.warmWorker.disposed) {
      try {
        assertWarmWorkerBinding(this.warmWorker, binding);
        return { worker: this.warmWorker, reused: true };
      } catch {
        this.warmWorker.dispose();
      }
    }
    const worker = await this.workerFactory();
    try {
      await worker.instantiate(this.wasmBytes);
      worker.bind(binding);
      this.warmWorker = worker;
      return { worker, reused: false };
    } catch (error) {
      worker.dispose?.();
      throw error;
    }
  }

  #disposeWarmWorker(worker) {
    if (worker === this.warmWorker) this.warmWorker = null;
    worker.dispose();
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

    const policy = createRunPolicy(options.effectPolicy ?? this.effectPolicy);
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
    const resolutions = assertEffectTargetsPendingRequests(effects, pending);
    return {
      journal,
      effects,
      unresolvedHostRequests,
      turnInputBytes: encodeRestoreTurnInput({
        manifestFingerprint: parentSummary.manifestFingerprint,
        parentTurnClosureBytes: parentClosureBytes,
        expectedParentClosureFingerprint: parentSummary.closureFingerprint,
        expectedParentStateFingerprint: parentSummary.resultingStateFingerprint,
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
    await runGroupedBounded(groups, policy, async (item) => {
      const resolved = await journal.resolve(
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
      effects[pendingPositions.get(item)] = { ...resolved, worldHostRequest: item.worldHostRequest };
    });
    return effects;
  }
}

async function recordBranchHeadProvenance(store, runId, branchId, nextHead) {
  if (typeof store.writeRun !== 'function') return;
  const run = await store.getRun(runId);
  let updated = false;
  const branches = (run.branches ?? []).map((branch) => {
    if (branch.branchId !== branchId) return branch;
    updated = true;
    const historicalTurnClosureFingerprints = appendUnique(
      branch.diagnostics?.historicalTurnClosureFingerprints,
      branch.currentHead?.turnClosureWorldFingerprint,
    );
    return createBranchRecord({
      ...branch,
      currentHead: nextHead,
      diagnostics: {
        ...branch.diagnostics,
        historicalTurnClosureFingerprints,
      },
    });
  });
  if (!updated) return;
  await store.writeRun(createRunRecord({ ...run, branches }));
}

function appendUnique(values, next) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value === 'string' && value.length > 0 && !out.includes(value)) out.push(value);
  }
  if (typeof next === 'string' && next.length > 0 && !out.includes(next)) out.push(next);
  return out;
}

function deriveTurnResult(turnResult, nextClosureBytes) {
  try {
    return summarizeTurnClosureForRunHead(nextClosureBytes);
  } catch (error) {
    fail('ERR_TURN_CLOSURE_INSPECTION_FAILED', error?.message ?? String(error));
  }
}

function assertHeadContinuable(parentHead) {
  if (parentHead.status === 'genesis' || parentHead.status === 'needs_host' || parentHead.status === 'yielded_budget') return;
  fail('ERR_BRANCH_HEAD_NOT_CONTINUABLE', `branch head status ${parentHead.status} cannot be advanced`);
}

function assertNextTurnSequence(parentHead, parentClosureBytes, inspected) {
  const actual = inspected.inspectionDiagnostics?.turnSequenceNumber;
  if (!Number.isSafeInteger(actual)) fail('ERR_TURN_CLOSURE_SEQUENCE_MISMATCH', 'next TurnClosure sequence is not inspectable');
  const expected = parentHead.status === 'genesis'
    ? 0
    : summarizeTurnClosureForRunHead(parentClosureBytes).inspectionDiagnostics.turnSequenceNumber + 1;
  if (actual !== expected) {
    fail('ERR_TURN_CLOSURE_SEQUENCE_MISMATCH', 'next TurnClosure sequence does not match the parent turn', {
      expected,
      actual,
    });
  }
}

function assertEffectTargetsPendingRequests(effects, pending) {
  return effects.map((effect, index) => {
    if (effect?.operatorInterventionRequired) {
      fail('ERR_EFFECT_OPERATOR_INTERVENTION_REQUIRED', 'effect requires operator intervention before a turn can be submitted');
    }
    const resolution = decodeResolutionInputBytes(effect.resolutionInputBytes);
    const expected = BigInt(pending[index].worldHostRequest.requestFingerprint);
    if (resolution.targetHostRequestFingerprint !== expected) {
      fail('ERR_EFFECT_RESOLUTION_TARGET_MISMATCH', 'effect ResolutionInput targets a different pending HostRequest');
    }
    return resolution;
  });
}

function confirmedTurnEffects(effects, inspected) {
  const appliedReplies = new Set(inspected.inspectionDiagnostics?.appliedHostReplyFingerprints ?? []);
  return effects.filter((effect) => {
    const replyFingerprint = effectHostReplyFingerprint(effect);
    return replyFingerprint ? appliedReplies.has(replyFingerprint) : false;
  });
}

function effectHostReplyFingerprint(effect) {
  if (!effect.worldHostRequest) return null;
  try {
    const request = effect.worldHostRequest;
    const resolution = decodeResolutionInputBytes(effect.resolutionInputBytes);
    const responseFingerprint = resolution.status === 0 ? valueImageFingerprint(resolution.responseValueImageBytes) : null;
    const responseKind = resolution.status === 0 ? 1n : 0n;
    const outcomeFingerprint = nonzero(wyhash64(concatBytes([
      hashBytes(fromUtf8('world.appliance.host_outcome.fingerprint')),
      u64(1n),
      u64(1n),
      u64(request.requestFingerprint),
      u64(request.intentFingerprint),
      u64(request.envelopeFingerprint),
      u64(request.idempotencyKeyFingerprint),
      u64(resolution.status),
      optionalU64(responseFingerprint),
      u64(responseKind),
      hashBytes(resolution.responseValueImageBytes),
      optionalU64(null),
      hashBytes(resolution.hostClaimBytes),
      u64(resolution.attemptNumber),
      hashBytes(resolution.metadata),
    ])));
    return nonzero(wyhash64(concatBytes([
      hashBytes(fromUtf8('world.appliance.host_reply.fingerprint')),
      u64(1n),
      u64(1n),
      u64(request.requestFingerprint),
      u64(outcomeFingerprint),
      optionalU64(null),
      u64(0n),
      hashBytes(resolution.metadata),
    ]))).toString(16).padStart(16, '0');
  } catch {
    return null;
  }
}

function valueImageFingerprint(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16) throw new Error('invalid value image');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (BigInt(view.getUint32(12, true)) << 32n) | BigInt(view.getUint32(8, true));
}

function hashBytes(bytes) {
  return concatBytes([u64(bytes.byteLength), bytes]);
}

function optionalU64(value) {
  return value == null ? u64(0n) : concatBytes([u64(1n), u64(value)]);
}

function nonzero(value) {
  return value === 0n ? 1n : value;
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
  if (policy.maximumRequestBytes !== undefined && hostRequest.requestBytes?.byteLength > policy.maximumRequestBytes) return false;
  if (policy.maximumResponseBytes !== undefined && manifest.maximumResponseBytes > policy.maximumResponseBytes) return false;
  const allowedAuthorityLabels = policySet(policy.allowedAuthorityLabels);
  if (allowedAuthorityLabels.size && manifest.authorityLabels.some((label) => !allowedAuthorityLabels.has(label))) return false;
  const allowedHttpOrigins = policySet(policy.allowedHttpOrigins);
  if (hostRequest.actuationClass === 'http' || manifest.authorityLabels.includes('network:http')) {
    const origin = requestOrigin(hostRequest);
    const driverOrigins = Array.isArray(manifest.diagnostics?.origins) ? new Set(manifest.diagnostics.origins) : null;
    if (driverOrigins && (!origin || !driverOrigins.has(origin))) return false;
    if (allowedHttpOrigins.size && (!origin || !allowedHttpOrigins.has(origin))) return false;
    const method = requestMethod(hostRequest);
    const driverMethods = Array.isArray(manifest.diagnostics?.methods)
      ? new Set(manifest.diagnostics.methods.map((item) => String(item).toUpperCase()))
      : null;
    if (driverMethods && (!method || !driverMethods.has(method))) return false;
  }
  const allowedFileRoots = policySet(policy.allowedFileRoots);
  if (allowedFileRoots.size && manifest.authorityLabels.includes('file:sandbox')) {
    const root = manifest.diagnostics?.root;
    if (!root || !allowedFileRoots.has(root)) return false;
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

function requestMethod(hostRequest) {
  try {
    const request = JSON.parse(new TextDecoder().decode(hostRequest.requestBytes));
    return String(request.method ?? 'GET').toUpperCase();
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
    const key = item.driver;
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

async function runGroupedBounded(groups, policy, fn) {
  const states = groups.map((group) => ({
    items: group,
    next: 0,
    active: 0,
    limit: effectConcurrencyLimit(group.manifest, policy),
  }));
  const total = states.reduce((sum, state) => sum + state.items.length, 0);
  const globalLimit = effectGlobalConcurrencyLimit(states, policy);
  let active = 0;
  let settled = 0;
  let cursor = 0;
  let firstError = null;
  await new Promise((resolve, reject) => {
    const launch = () => {
      if (firstError) return;
      if (settled === total) {
        resolve();
        return;
      }
      while (active < globalLimit) {
        const ready = nextReadyGroup(states, cursor);
        if (!ready) break;
        const { state, index } = ready;
        cursor = (index + 1) % states.length;
        const item = state.items[state.next];
        state.next += 1;
        state.active += 1;
        active += 1;
        Promise.resolve(fn(item)).then(() => {
          state.active -= 1;
          active -= 1;
          settled += 1;
          if (firstError) {
            if (active === 0) reject(firstError);
            return;
          }
          launch();
        }, (error) => {
          state.active -= 1;
          active -= 1;
          settled += 1;
          firstError ??= error;
          if (active === 0) reject(firstError);
        });
      }
    };
    launch();
  });
}

function nextReadyGroup(states, cursor) {
  for (let offset = 0; offset < states.length; offset += 1) {
    const index = (cursor + offset) % states.length;
    const state = states[index];
    if (state.next < state.items.length && state.active < state.limit) return { state, index };
  }
  return null;
}

function effectGlobalConcurrencyLimit(states, policy = {}) {
  const policyLimit = policy.maximumConcurrentEffects ?? states.reduce((sum, state) => sum + state.limit, 0);
  if (!Number.isSafeInteger(policyLimit) || policyLimit < 1) fail('ERR_EFFECT_CONCURRENCY_LIMIT_INVALID', 'maximumConcurrentEffects must be at least one');
  return policyLimit;
}

function assertParentHeadMatchesClosure(parentHead, parentClosureBytes) {
  if (parentHead.status === 'genesis') return;
  let summarized;
  try {
    summarized = summarizeTurnClosureForRunHead(parentClosureBytes);
  } catch (error) {
    fail('ERR_PARENT_HEAD_CLOSURE_UNDECODABLE', 'parent RunHead closure bytes are not decodable', { cause: error?.message ?? String(error) });
  }
  assertHeadGenerationMatchesClosure(parentHead, summarized);
  for (const field of [
    'turnClosureWorldFingerprint',
    'resultingStateFingerprint',
    'chronicleCursor',
    'archiveMomentFingerprint',
    'archiveSealFingerprint',
    'status',
  ]) {
    if ((field === 'archiveMomentFingerprint' || field === 'archiveSealFingerprint') && summarized[field] == null) continue;
    if (parentHead[field] !== summarized[field]) {
      fail('ERR_PARENT_HEAD_CLOSURE_MISMATCH', 'parent RunHead does not match selected TurnClosure bytes', {
        field,
        headValue: parentHead[field],
        closureValue: summarized[field],
      });
    }
  }
}

function assertParentClosureManifestMatchesWorker(worker, parentHead, parentClosureBytes) {
  if (parentHead.status === 'genesis') return;
  if (typeof worker.readApplianceManifest !== 'function') return;
  const applianceManifest = worker.readApplianceManifest();
  const loadedManifestFingerprint = applianceManifest?.decoded?.manifestFingerprint;
  if (loadedManifestFingerprint == null) return;
  const inspected = inspectTurnOutput(parentClosureBytes);
  if (loadedManifestFingerprint !== inspected.manifestFingerprint) {
    fail('ERR_PARENT_HEAD_CLOSURE_MISMATCH', 'parent TurnClosure manifest does not match loaded application manifest', {
      field: 'manifestFingerprint',
      headValue: `world:manifest:${inspected.manifestFingerprint.toString(16).padStart(16, '0')}`,
      loadedValue: `world:manifest:${loadedManifestFingerprint.toString(16).padStart(16, '0')}`,
    });
  }
}

function assertHeadGenerationMatchesClosure(head, summary) {
  const closureGeneration = summary.inspectionDiagnostics?.turnSequenceNumber;
  if (!Number.isSafeInteger(closureGeneration)) fail('ERR_PARENT_HEAD_CLOSURE_MISMATCH', 'parent TurnClosure sequence is not inspectable');
  const storedClosureGeneration = head.updateDiagnostics?.inspectedTurnClosure?.turnSequenceNumber;
  if (storedClosureGeneration !== undefined && !Number.isSafeInteger(storedClosureGeneration)) fail('ERR_PARENT_HEAD_CLOSURE_MISMATCH', 'parent RunHead generation is not inspectable');
  const generationMatches = storedClosureGeneration === undefined
    ? closureGeneration === head.generation || closureGeneration === head.generation + 1
    : closureGeneration === storedClosureGeneration;
  if (!generationMatches) {
    fail('ERR_PARENT_HEAD_CLOSURE_MISMATCH', 'parent RunHead generation does not match selected TurnClosure bytes', {
      field: 'generation',
      headValue: head.generation,
      closureValue: closureGeneration,
    });
  }
}

export function worldHostRequestToEffectRequest(request) {
  assertWorldResponseStatusAllowed(request, resolutionResponded, 'responded');
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

function assertWorldResponseStatusAllowed(request, status, label) {
  const allowed = request?.allowedResponseStatuses;
  if (!Number.isSafeInteger(allowed) || allowed < 0 || allowed > 0xff) fail('ERR_WORLD_HOST_REQUEST_ALLOWED_RESPONSE_STATUSES_INVALID');
  if ((allowed & (1 << status)) === 0) fail('ERR_WORLD_HOST_REQUEST_RESPONSE_STATUS_NOT_ALLOWED', `World HostRequest does not allow ${label}`);
}

function fingerprintString(value) {
  if (value == null) fail('ERR_REQUIRED_FIELD', 'fingerprint is required');
  return BigInt(value).toString(16).padStart(16, '0');
}

function u64(value) {
  const out = new Uint8Array(8);
  const actual = BigInt.asUintN(64, BigInt(value));
  const view = new DataView(out.buffer);
  view.setUint32(0, Number(actual & 0xffff_ffffn), true);
  view.setUint32(4, Number((actual >> 32n) & 0xffff_ffffn), true);
  return out;
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
