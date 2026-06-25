import {
  EffectRecoveryClass,
  assertDriverCanResolve,
  assertDurableRecoveryAllowed,
  assertRecoveryClass,
  defineActuatorDriver,
} from './actuator.mjs';
import { assertBytes, fail, fromUtf8, stableJson, toHex } from './store.mjs';

export const EffectState = Object.freeze({
  observed: 'observed',
  claimed: 'claimed',
  running: 'running',
  resolved: 'resolved',
  submitted: 'submitted',
  closureCommitted: 'closure_committed',
  operatorInterventionRequired: 'operator_intervention_required',
  failed: 'failed',
});

const TERMINAL_WITH_OUTCOME = new Set([
  EffectState.resolved,
  EffectState.submitted,
  EffectState.closureCommitted,
]);

const EFFECT_STATES = new Set(Object.values(EffectState));
const effectKeyLocks = new WeakMap();

export class EffectJournal {
  constructor({ store, runId, branchId, parentTurnClosureFingerprint, policy = {} }) {
    if (!store) fail('ERR_EFFECT_STORE_REQUIRED');
    if (!runId) fail('ERR_EFFECT_RUN_REQUIRED');
    if (!branchId) fail('ERR_EFFECT_BRANCH_REQUIRED');
    this.store = store;
    this.runId = runId;
    this.branchId = branchId;
    this.parentTurnClosureFingerprint = parentTurnClosureFingerprint;
    this.policy = { durableAutomatic: true, ...policy };
  }

  async observe(hostRequest, options = {}) {
    const prepared = await prepareHostRequest(hostRequest);
    const existing = await this.store.getEffectRecord(this.runId, prepared.idempotencyKey, this.branchId);
    if (existing) return await this.#reuseOrConflict(existing, prepared);

    const reusable = await this.#branchLocalReusableRecord(prepared);
    if (reusable) return reusable;

    const manifest = options.manifest ? normalizeManifest(options.manifest) : null;
    const recoveryClass = options.recoveryClass ?? manifest?.recoveryClass ?? hostRequest.recoveryClass;
    assertRecoveryClass(recoveryClass);
    assertDurableRecoveryAllowed(recoveryClass, this.policy);
    const requestBytesRef = await this.store.putBlob(prepared.requestBytes);

    const record = createEffectRecord({
      runId: this.runId,
      branchId: this.branchId,
      parentTurnClosureFingerprint: this.parentTurnClosureFingerprint,
      hostRequestFingerprint: prepared.hostRequestFingerprint,
      idempotencyKey: prepared.idempotencyKey,
      idempotencyKeyWorldFingerprint: prepared.idempotencyKeyWorldFingerprint,
      actuatorRef: hostRequest.actuatorRef,
      descriptorFingerprint: hostRequest.descriptorFingerprint,
      requestBytesRef,
      requestBytesChecksum: prepared.requestBytesChecksum,
      state: EffectState.observed,
      attemptCount: 0,
      driverRecoveryClass: recoveryClass,
      diagnostics: options.diagnostics ?? {},
    });
    return await this.store.putEffectRecord(record);
  }

  async resolve(context, hostRequest, driverLike) {
    const driver = defineActuatorDriver(driverLike);
    const manifest = driver.manifest();
    assertDriverCanResolve(manifest, hostRequest);
    const prepared = await prepareHostRequest(hostRequest);
    return await withEffectKeyLock(this.store, effectLockKey(this.runId, prepared.idempotencyKey), async () => {
      const observed = await this.observe(hostRequest, { manifest });
      const reused = await this.#resolutionFromRecord(observed);
      if (reused) return reused;
      if (observed.state === EffectState.running) return await this.recover(context, observed, driver);
      if (observed.state === EffectState.operatorInterventionRequired) {
        return { record: observed, resolutionInputBytes: null, reused: false, operatorInterventionRequired: true };
      }

      const running = await this.#put({
        ...observed,
        state: EffectState.running,
        attemptCount: observed.attemptCount + 1,
        diagnostics: { ...observed.diagnostics, driverId: manifest.driverId },
      });

      try {
        const resolved = normalizeDriverResolution(await driver.resolve(context, hostRequest));
        const resolutionInputRef = await this.store.putBlob(resolved.resolutionInputBytes);
        const hostClaimRef = resolved.hostClaimBytes ? await this.store.putBlob(resolved.hostClaimBytes) : running.hostClaimRef;
        const record = await this.#put({
          ...running,
          state: EffectState.resolved,
          resolutionInputRef,
          hostClaimRef,
          driverTransactionRef: resolved.driverTransactionRef ?? running.driverTransactionRef,
          diagnostics: { ...running.diagnostics, ...resolved.diagnostics },
        });
        return {
          record,
          resolutionInputBytes: await this.store.getBlob(resolutionInputRef),
          reused: false,
        };
      } catch (error) {
        await this.#put({
          ...running,
          state: EffectState.failed,
          diagnostics: { ...running.diagnostics, error: error.message },
        });
        throw error;
      }
    });
  }

  async recover(context, effectRecord, driverLike) {
    const driver = defineActuatorDriver(driverLike);
    const record = assertEffectRecord(effectRecord);
    const reused = await this.#resolutionFromRecord(record);
    if (reused) return reused;

    if (record.driverRecoveryClass === EffectRecoveryClass.bestEffort) {
      const intervention = await this.#put({
        ...record,
        state: EffectState.operatorInterventionRequired,
        diagnostics: { ...record.diagnostics, recoveryRequired: 'best_effort_unresolved' },
      });
      return { record: intervention, resolutionInputBytes: null, reused: false, operatorInterventionRequired: true };
    }

    if (typeof driver.recover === 'function') {
      assertDriverCanRecover(driver.manifest(), record);
      const recovered = normalizeDriverResolution(await driver.recover(context, await this.#recordWithRequestBytes(record)));
      const resolutionInputRef = await this.store.putBlob(recovered.resolutionInputBytes);
      const hostClaimRef = recovered.hostClaimBytes ? await this.store.putBlob(recovered.hostClaimBytes) : record.hostClaimRef;
      const next = await this.#put({
        ...record,
        state: EffectState.resolved,
        resolutionInputRef,
        hostClaimRef,
        driverTransactionRef: recovered.driverTransactionRef ?? record.driverTransactionRef,
        diagnostics: { ...record.diagnostics, ...recovered.diagnostics, recovered: true },
      });
      return { record: next, resolutionInputBytes: await this.store.getBlob(resolutionInputRef), reused: false };
    }

    fail('ERR_EFFECT_RECOVERY_UNAVAILABLE', 'driver does not expose recovery for unresolved effect');
  }

  async markSubmitted(record) {
    return await this.#advance(record, EffectState.submitted);
  }

  async markClosureCommitted(record) {
    return await this.#advance(record, EffectState.closureCommitted);
  }

  async reconcileCommittedHead(head) {
    const committedParent = head?.updateDiagnostics?.parentTurnClosureFingerprint;
    if (typeof committedParent !== 'string' || committedParent.length === 0) {
      fail('ERR_EFFECT_RECONCILE_HEAD_PARENT_REQUIRED', 'committed head parent TurnClosure fingerprint is required');
    }
    const committedEffectIds = Array.isArray(head?.updateDiagnostics?.committedEffectIds)
      ? new Set(head.updateDiagnostics.committedEffectIds)
      : null;
    const committed = [];
    for (const record of await this.list()) {
      assertEffectRecord(record);
      if (
        record.branchId === this.branchId &&
        record.parentTurnClosureFingerprint === committedParent &&
        (record.state === EffectState.submitted ||
          (record.state === EffectState.resolved && committedEffectIds?.has(record.idempotencyKeyWorldFingerprint)))
      ) {
        committed.push(await this.markClosureCommitted(record));
      }
    }
    return {
      committed,
      committedCount: committed.length,
      parentTurnClosureFingerprint: committedParent,
    };
  }

  async list() {
    return await this.store.listEffectRecords(this.runId);
  }

  async #reuseOrConflict(existing, prepared) {
    assertEffectRecord(existing);
    if (existing.requestBytesChecksum !== prepared.requestBytesChecksum) {
      fail('ERR_EFFECT_IDEMPOTENCY_CONFLICT', 'same full idempotency key used with different request bytes', {
        runId: this.runId,
        idempotencyKeyWorldFingerprint: existing.idempotencyKeyWorldFingerprint,
      });
    }
    return existing;
  }

  async #branchLocalReusableRecord(prepared) {
    const idempotencyKeyJson = stableJson(prepared.idempotencyKey);
    for (const record of await this.list()) {
      assertEffectRecord(record);
      if (stableJson(record.idempotencyKey) !== idempotencyKeyJson) continue;
      if (record.requestBytesChecksum !== prepared.requestBytesChecksum) {
        fail('ERR_EFFECT_IDEMPOTENCY_CONFLICT', 'same full idempotency key used with different request bytes', {
          runId: this.runId,
          idempotencyKeyWorldFingerprint: record.idempotencyKeyWorldFingerprint,
        });
      }
      if (record.state === EffectState.running || (TERMINAL_WITH_OUTCOME.has(record.state) && record.resolutionInputRef)) {
        return await this.#put({
          ...record,
          branchId: this.branchId,
          parentTurnClosureFingerprint: this.parentTurnClosureFingerprint,
          state: record.state === EffectState.running ? EffectState.running : EffectState.resolved,
          diagnostics: { ...record.diagnostics, branchLocalReuse: record.branchId },
        });
      }
    }
    return null;
  }

  async #resolutionFromRecord(record) {
    if (!TERMINAL_WITH_OUTCOME.has(record.state)) return null;
    if (!record.resolutionInputRef) fail('ERR_EFFECT_RESOLUTION_REF_MISSING');
    return {
      record,
      resolutionInputBytes: await this.store.getBlob(record.resolutionInputRef),
      reused: true,
    };
  }

  async #advance(record, state) {
    assertEffectRecord(record);
    if (!record.resolutionInputRef) fail('ERR_EFFECT_RESOLUTION_REF_MISSING');
    return await this.#put({ ...record, state });
  }

  async #put(record) {
    return await this.store.putEffectRecord(assertEffectRecord(record));
  }

  async #recordWithRequestBytes(record) {
    if (!record.requestBytesRef) return record;
    return { ...record, requestBytes: await this.store.getBlob(record.requestBytesRef) };
  }
}

function assertDriverCanRecover(manifest, record) {
  if (!manifest.supportedActuatorRefs.includes(record.actuatorRef)) fail('ERR_ACTUATOR_REF_NOT_SUPPORTED');
  if (!manifest.supportedDescriptorFingerprints.includes(record.descriptorFingerprint)) fail('ERR_DESCRIPTOR_NOT_SUPPORTED');
  if (manifest.recoveryClass !== record.driverRecoveryClass) fail('ERR_EFFECT_RECOVERY_CLASS_MISMATCH');
}

export function createEffectRecord(record) {
  return assertEffectRecord({
    runId: record.runId,
    branchId: record.branchId,
    parentTurnClosureFingerprint: record.parentTurnClosureFingerprint,
    hostRequestFingerprint: record.hostRequestFingerprint,
    idempotencyKey: record.idempotencyKey,
    idempotencyKeyWorldFingerprint: record.idempotencyKeyWorldFingerprint,
    actuatorRef: record.actuatorRef,
    descriptorFingerprint: record.descriptorFingerprint,
    requestBytesChecksum: record.requestBytesChecksum,
    state: record.state ?? EffectState.observed,
    attemptCount: record.attemptCount ?? 0,
    driverRecoveryClass: record.driverRecoveryClass,
    requestBytesRef: record.requestBytesRef,
    resolutionInputRef: record.resolutionInputRef,
    hostClaimRef: record.hostClaimRef,
    driverTransactionRef: record.driverTransactionRef,
    diagnostics: record.diagnostics ?? {},
  });
}

export function assertEffectRecord(record) {
  if (!record || typeof record !== 'object') fail('ERR_INVALID_EFFECT_RECORD');
  for (const field of [
    'runId',
    'branchId',
    'parentTurnClosureFingerprint',
    'hostRequestFingerprint',
    'idempotencyKeyWorldFingerprint',
    'actuatorRef',
    'descriptorFingerprint',
    'requestBytesChecksum',
    'driverRecoveryClass',
  ]) {
    if (typeof record[field] !== 'string' || record[field].length === 0) fail('ERR_INVALID_EFFECT_RECORD', `${field} is required`);
  }
  if (!record.idempotencyKey || record.idempotencyKey.format !== 'world-idempotency-key-bytes.hex' || !/^[0-9a-f]+$/.test(record.idempotencyKey.bytesHex)) {
    fail('ERR_INVALID_EFFECT_RECORD', 'complete idempotency key bytes are required');
  }
  if (!EFFECT_STATES.has(record.state)) fail('ERR_INVALID_EFFECT_STATE');
  if (!Number.isSafeInteger(record.attemptCount) || record.attemptCount < 0) fail('ERR_INVALID_EFFECT_RECORD', 'attemptCount must be non-negative');
  assertRecoveryClass(record.driverRecoveryClass);
  return record;
}

export async function prepareHostRequest(hostRequest) {
  if (!hostRequest || typeof hostRequest !== 'object') fail('ERR_INVALID_HOST_REQUEST');
  const idempotencyKeyBytes = assertBytes(hostRequest.idempotencyKeyBytes, 'idempotencyKeyBytes');
  const requestBytes = assertBytes(hostRequest.requestBytes ?? fromUtf8(stableJson(hostRequest.request ?? {})), 'requestBytes');
  if (hostRequest.shortIdempotencyKeyHash) fail('ERR_SHORT_IDEMPOTENCY_KEY_FORBIDDEN');
  const requestBytesChecksum = `sha256:${await sha256Hex(requestBytes)}`;
  const hostRequestFingerprint = hostRequest.hostRequestFingerprint ?? `sha256:${await sha256Hex(fromUtf8(stableJson({
    actuatorRef: hostRequest.actuatorRef,
    descriptorFingerprint: hostRequest.descriptorFingerprint,
    actuationClass: hostRequest.actuationClass,
    requestBytesChecksum,
  })))}`;
  return {
    idempotencyKey: {
      format: 'world-idempotency-key-bytes.hex',
      bytesHex: toHex(idempotencyKeyBytes),
    },
    idempotencyKeyWorldFingerprint: hostRequest.idempotencyKeyWorldFingerprint ?? `sha256:${await sha256Hex(idempotencyKeyBytes)}`,
    requestBytes,
    requestBytesChecksum,
    hostRequestFingerprint,
  };
}

function normalizeDriverResolution(value) {
  const resolutionInputBytes = value instanceof Uint8Array ? value : value?.resolutionInputBytes;
  assertBytes(resolutionInputBytes, 'resolutionInputBytes');
  return {
    resolutionInputBytes,
    hostClaimBytes: value?.hostClaimBytes,
    driverTransactionRef: value?.driverTransactionRef,
    diagnostics: value?.diagnostics ?? {},
  };
}

async function withEffectKeyLock(store, key, fn) {
  let locks = effectKeyLocks.get(store);
  if (!locks) {
    locks = new Map();
    effectKeyLocks.set(store, locks);
  }
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  const stored = current.catch(() => {});
  locks.set(key, stored);
  try {
    return await current;
  } finally {
    if (locks.get(key) === stored) locks.delete(key);
  }
}

function effectLockKey(runId, idempotencyKey) {
  return `${runId}\0${stableJson(idempotencyKey)}`;
}

function normalizeManifest(value) {
  return value;
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}
