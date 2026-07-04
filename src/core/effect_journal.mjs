import {
  EffectRecoveryClass,
  ResponseStatusCode,
  assertDriverCanResolve,
  assertDurableRecoveryAllowed,
  assertRecoveryClass,
  defineActuatorDriver,
} from './actuator.mjs';
import { createRunPolicy } from './capabilities.mjs';
import { assertBlobRef, assertBytes, fail, fromUtf8, stableJson, toHex } from './store.mjs';
import { decodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';

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
const RECOVER_AFTER_RESOLVE_FAILURE = new Set([
  EffectRecoveryClass.pure,
  EffectRecoveryClass.idempotent,
  EffectRecoveryClass.externallyRecoverable,
  EffectRecoveryClass.transactional,
]);
const MAX_U64 = (1n << 64n) - 1n;
const EFFECT_STATE_ORDER = Object.freeze({
  [EffectState.observed]: 0,
  [EffectState.claimed]: 1,
  [EffectState.running]: 2,
  [EffectState.resolved]: 3,
  [EffectState.submitted]: 4,
  [EffectState.closureCommitted]: 5,
  [EffectState.operatorInterventionRequired]: 6,
  [EffectState.failed]: 6,
});
const effectKeyLocksByStore = new WeakMap();
const effectKeyLocksByStoreKey = new Map();

export class EffectJournal {
  constructor({ store, runId, branchId, parentTurnClosureFingerprint, policy = {} }) {
    if (!store) fail('ERR_EFFECT_STORE_REQUIRED');
    if (!runId) fail('ERR_EFFECT_RUN_REQUIRED');
    if (!branchId) fail('ERR_EFFECT_BRANCH_REQUIRED');
    this.store = store;
    this.runId = runId;
    this.branchId = branchId;
    this.parentTurnClosureFingerprint = parentTurnClosureFingerprint;
    this.policy = createRunPolicy(policy);
  }

  async observe(hostRequest, options = {}) {
    const manifest = options.manifest ? normalizeManifest(options.manifest) : null;
    const journalHostRequest = manifest ? journaledHostRequest(hostRequest, manifest) : hostRequest;
    const prepared = await prepareHostRequest(journalHostRequest);
    return await withEffectKeyLock(this.store, effectLockKey(this.runId, prepared.idempotencyKey), async () => {
      return await this.#observePrepared(journalHostRequest, prepared, options);
    });
  }

  async #observePrepared(hostRequest, prepared, options = {}) {
    const existing = await this.store.getEffectRecord(this.runId, prepared.idempotencyKey, this.branchId);
    if (existing) return await this.#reuseOrConflict(existing, prepared);
    if (options.createIfMissing === false) {
      return await this.#branchLocalReusableRecord(prepared, { outcomesOnly: true });
    }

    const reusable = await this.#branchLocalReusableRecord(prepared);
    if (reusable) return reusable;

    const manifest = options.manifest ? normalizeManifest(options.manifest) : null;
    const recoveryClass = options.recoveryClass ?? manifest?.recoveryClass ?? hostRequest.recoveryClass;
    assertRecoveryClass(recoveryClass);
    assertDurableRecoveryAllowed(recoveryClass, this.policy);
    assertPreparedRequestWithinLimits(prepared, manifest, this.policy);
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
      actuationClass: hostRequest.actuationClass,
      responseSchema: hostRequest.responseSchema,
      requestBytesRef,
      requestBytesChecksum: prepared.requestBytesChecksum,
      requestIdentityChecksum: prepared.requestIdentityChecksum,
      state: EffectState.observed,
      attemptCount: 0,
      driverRecoveryClass: recoveryClass,
      diagnostics: options.diagnostics ?? hostRequest.diagnostics ?? {},
    });
    return await this.store.putEffectRecord(record);
  }

  async resolve(context, hostRequest, driverLike, options = {}) {
    const driver = defineActuatorDriver(driverLike);
    const manifest = driver.manifest();
    assertDriverCanResolve(manifest, hostRequest);
    assertDriverRecoveryHookSufficient(manifest, driver);
    const journalHostRequest = journaledHostRequest(hostRequest, manifest);
    const prepared = await prepareHostRequest(journalHostRequest);
    const normalizedHostRequest = normalizePreparedHostRequest(journalHostRequest, prepared);
    assertPreparedRequestWithinLimits(prepared, manifest, this.policy);
    assertDurableRecoveryAllowed(manifest.recoveryClass, this.policy);
    return await withEffectKeyLock(this.store, effectLockKey(this.runId, prepared.idempotencyKey), async () => {
      let observed = await this.#observePrepared(journalHostRequest, prepared, { manifest, createIfMissing: false });
      const existingOutcome = observed ? await this.#nonInvokingResolution(observed, normalizedHostRequest, manifest) : null;
      if (existingOutcome?.retryRequired) {
        observed = existingOutcome.record;
      } else if (existingOutcome) {
        return existingOutcome;
      }
      if (typeof options.beforeInvoke === 'function') await options.beforeInvoke(context, normalizedHostRequest);
      if (!observed) observed = await this.#observePrepared(journalHostRequest, prepared, { manifest });
      const observedOutcome = await this.#nonInvokingResolution(observed, normalizedHostRequest, manifest);
      if (observedOutcome?.retryRequired) {
        observed = observedOutcome.record;
      } else if (observedOutcome) {
        return observedOutcome;
      }
      if (observed.state === EffectState.running) return await this.#recoverLocked(context, observed, driver);
      assertManifestResponseWithinPolicy(manifest, this.policy);

      const running = await this.#put({
        ...observed,
        state: EffectState.running,
        attemptCount: observed.attemptCount + 1,
        resolutionInputRef: undefined,
        hostClaimRef: undefined,
        driverTransactionRef: undefined,
        diagnostics: { ...observed.diagnostics, driverId: manifest.driverId },
      });

      let resolved;
      try {
        resolved = normalizeDriverResolution(await driver.resolve(context, normalizedHostRequest));
      } catch (error) {
        await this.#put({
          ...running,
          state: driverFailureState(manifest.recoveryClass),
          diagnostics: {
            ...running.diagnostics,
            error: error.message,
            ...driverFailureDiagnostics(manifest.recoveryClass),
          },
        });
        throw error;
      }

      try {
        assertResolutionAccepted(resolved.resolutionInputBytes, normalizedHostRequest, manifest, this.policy);
        assertDriverCarriedBytesAccepted(resolved, manifest, this.policy);
      } catch (error) {
        const failureState = invalidResolutionFailureState(manifest.recoveryClass);
        await this.#put({
          ...running,
          state: failureState,
          driverTransactionRef: resolved.driverTransactionRef ?? running.driverTransactionRef,
          diagnostics: {
            ...running.diagnostics,
            error: error.message,
            ...resolutionFailureDiagnostics(failureState),
          },
        });
        throw error;
      }

      try {
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
        const failureState = persistenceFailureState(manifest.recoveryClass);
        await this.#put({
          ...running,
          state: failureState,
          driverTransactionRef: resolved.driverTransactionRef ?? running.driverTransactionRef,
          diagnostics: {
            ...running.diagnostics,
            error: error.message,
            ...persistenceFailureDiagnostics(failureState, manifest.recoveryClass),
          },
        });
        throw error;
      }
    });
  }

  async recover(context, effectRecord, driverLike) {
    const requested = this.#assertRecordInScope(effectRecord);
    return await withEffectKeyLock(this.store, effectLockKey(this.runId, requested.idempotencyKey), async () => {
      const current = await this.store.getEffectRecord(this.runId, requested.idempotencyKey, this.branchId);
      return await this.#recoverLocked(context, current ?? requested, driverLike);
    });
  }

  async #recoverLocked(context, effectRecord, driverLike) {
    const driver = defineActuatorDriver(driverLike);
    const record = this.#assertRecordInScope(effectRecord);
    const manifest = driver.manifest();
    assertDriverCanRecover(manifest, record);
    const reused = await this.#resolutionFromRecord(record);
    if (reused) {
      assertResolutionAccepted(reused.resolutionInputBytes, record, manifest, this.policy);
      return reused;
    }

    if (record.driverRecoveryClass === EffectRecoveryClass.bestEffort) {
      const intervention = await this.#put({
        ...record,
        state: EffectState.operatorInterventionRequired,
        diagnostics: { ...record.diagnostics, recoveryRequired: 'best_effort_unresolved' },
      });
      return { record: intervention, resolutionInputBytes: null, reused: false, operatorInterventionRequired: true };
    }

    const recordWithRequestBytes = await this.#recordWithRequestBytes(record);
    await assertRecoveredRequestWithinLimits(recordWithRequestBytes, manifest, this.policy);
    await assertRecoveredEffectIdentityMatchesManifest(recordWithRequestBytes, manifest);
    assertManifestResponseWithinPolicy(manifest, this.policy);
    if (typeof driver.recover === 'function' || canSafelyReResolve(record.driverRecoveryClass)) {
      const recoveryResult = typeof driver.recover === 'function'
        ? await driver.recover(context, recordWithRequestBytes)
        : await driver.resolve(context, recordWithRequestBytes);
      if (recoveryResult?.operatorInterventionRequired === true) {
        const intervention = await this.#put({
          ...record,
          state: EffectState.operatorInterventionRequired,
          diagnostics: {
            ...record.diagnostics,
            ...recoveryResult.diagnostics,
            recoveryRequired: recoveryResult.recoveryRequired ?? 'operator_required',
          },
        });
        return { record: intervention, resolutionInputBytes: null, reused: false, operatorInterventionRequired: true };
      }
      const recovered = normalizeDriverResolution(recoveryResult);
      try {
        assertResolutionAccepted(recovered.resolutionInputBytes, record, manifest, this.policy);
        assertDriverCarriedBytesAccepted(recovered, manifest, this.policy);
      } catch (error) {
        const failureState = invalidResolutionFailureState(record.driverRecoveryClass);
        await this.#put({
          ...record,
          state: failureState,
          diagnostics: {
            ...record.diagnostics,
            error: error.message,
            ...resolutionFailureDiagnostics(failureState),
          },
        });
        throw error;
      }
      return await this.#recordRecoveredResolution(record, recovered);
    }

    fail('ERR_EFFECT_RECOVERY_UNAVAILABLE', 'driver does not expose recovery for unresolved effect');
  }

  async #nonInvokingResolution(observed, normalizedHostRequest, manifest) {
    assertDurableRecoveryAllowed(observed.driverRecoveryClass, this.policy);
    if (observed.state === EffectState.operatorInterventionRequired) {
      return { record: observed, resolutionInputBytes: null, reused: false, operatorInterventionRequired: true };
    }
    if (observed.state === EffectState.failed) {
      fail('ERR_EFFECT_FAILED_REQUIRES_OPERATOR', 'failed effects require explicit operator recovery before retry');
    }
    assertEffectRecoveryClassMatchesManifest(manifest, observed);
    const reused = await this.#resolutionFromRecord(observed);
    if (!reused) return null;
    try {
      assertResolutionAccepted(reused.resolutionInputBytes, normalizedHostRequest, manifest, this.policy);
    } catch (error) {
      if (
        observed.state !== EffectState.resolved ||
        !observed.requestBytesRef ||
        !canSafelyReResolve(observed.driverRecoveryClass) ||
        !retryableReusableResolutionError(error, manifest, this.policy)
      ) {
        throw error;
      }
      const retryRecord = await this.#put({
        ...observed,
        state: EffectState.observed,
        resolutionInputRef: undefined,
        hostClaimRef: undefined,
        driverTransactionRef: undefined,
        diagnostics: {
          ...observed.diagnostics,
          invalidReusableResolution: error.code ?? 'ERR_EFFECT_RESOLUTION_INVALID',
        },
      });
      return { record: retryRecord, resolutionInputBytes: null, reused: false, retryRequired: true };
    }
    return reused;
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
    const committedEffectIds = new Set(Array.isArray(head?.updateDiagnostics?.committedEffectIds)
      ? head.updateDiagnostics.committedEffectIds
      : []);
    const committed = [];
    for (const record of await this.list()) {
      assertEffectRecord(record);
      if (
        record.branchId === this.branchId &&
        record.parentTurnClosureFingerprint === committedParent &&
        record.state === EffectState.submitted &&
        committedEffectIds.has(record.idempotencyKeyWorldFingerprint)
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
    if (effectIdentityChecksum(existing) !== prepared.requestIdentityChecksum) {
      fail('ERR_EFFECT_IDEMPOTENCY_CONFLICT', 'same full idempotency key used with different request bytes', {
        runId: this.runId,
        idempotencyKeyWorldFingerprint: existing.idempotencyKeyWorldFingerprint,
      });
    }
    if (existing.hostRequestFingerprint !== prepared.hostRequestFingerprint) {
      fail('ERR_EFFECT_IDEMPOTENCY_CONFLICT', 'same full idempotency key used with different host request identity', {
        runId: this.runId,
        idempotencyKeyWorldFingerprint: existing.idempotencyKeyWorldFingerprint,
      });
    }
    if (
      existing.parentTurnClosureFingerprint !== this.parentTurnClosureFingerprint &&
      (
        existing.state === EffectState.observed ||
        existing.state === EffectState.running ||
        (TERMINAL_WITH_OUTCOME.has(existing.state) && existing.resolutionInputRef)
      )
    ) {
      return await this.#put({
        ...existing,
        parentTurnClosureFingerprint: this.parentTurnClosureFingerprint,
        state: existing.state === EffectState.observed || existing.state === EffectState.running ? existing.state : EffectState.resolved,
        diagnostics: { ...existing.diagnostics, parentReboundFrom: existing.parentTurnClosureFingerprint },
      });
    }
    return existing;
  }

  async #branchLocalReusableRecord(prepared, options = {}) {
    const idempotencyKeyJson = stableJson(prepared.idempotencyKey);
    let reusable = null;
    for (const record of await this.list()) {
      assertEffectRecord(record);
      if (stableJson(record.idempotencyKey) !== idempotencyKeyJson) continue;
      if (effectIdentityChecksum(record) !== prepared.requestIdentityChecksum) {
        fail('ERR_EFFECT_IDEMPOTENCY_CONFLICT', 'same full idempotency key used with different request bytes', {
          runId: this.runId,
          idempotencyKeyWorldFingerprint: record.idempotencyKeyWorldFingerprint,
        });
      }
      if (record.hostRequestFingerprint !== prepared.hostRequestFingerprint) {
        fail('ERR_EFFECT_IDEMPOTENCY_CONFLICT', 'same full idempotency key used with different host request identity', {
          runId: this.runId,
          idempotencyKeyWorldFingerprint: record.idempotencyKeyWorldFingerprint,
        });
      }
      const hasOutcome = TERMINAL_WITH_OUTCOME.has(record.state) && record.resolutionInputRef;
      if (hasOutcome && (reusable === null || reusable.state === EffectState.running)) {
        reusable = record;
      } else if (!options.outcomesOnly && reusable === null && record.state === EffectState.running) {
        reusable = record;
      }
    }
    if (reusable) {
      return await this.#put({
        ...reusable,
        branchId: this.branchId,
        parentTurnClosureFingerprint: this.parentTurnClosureFingerprint,
        state: reusable.state === EffectState.running ? EffectState.running : EffectState.resolved,
        diagnostics: { ...reusable.diagnostics, branchLocalReuse: reusable.branchId },
      });
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
    const requested = this.#assertRecordInScope(record);
    return await withEffectKeyLock(this.store, effectLockKey(this.runId, requested.idempotencyKey), async () => {
      const current = this.#assertRecordInScope(
        await this.store.getEffectRecord(this.runId, requested.idempotencyKey, this.branchId) ?? requested,
      );
      const currentOrder = EFFECT_STATE_ORDER[current.state];
      const nextOrder = EFFECT_STATE_ORDER[state];
      if (nextOrder < currentOrder) fail('ERR_EFFECT_STATE_REGRESSION', 'effect state transitions must be monotonic');
      if (nextOrder === currentOrder) return current;
      if (!current.resolutionInputRef) fail('ERR_EFFECT_RESOLUTION_REF_MISSING');
      return await this.#put({ ...current, state });
    });
  }

  async #put(record) {
    return await this.store.putEffectRecord(this.#assertRecordInScope(record));
  }

  #assertRecordInScope(record) {
    const current = assertEffectRecord(record);
    if (current.runId !== this.runId || current.branchId !== this.branchId) {
      fail('ERR_EFFECT_RECORD_SCOPE_MISMATCH', 'effect record does not belong to this journal scope', {
        journalRunId: this.runId,
        journalBranchId: this.branchId,
        recordRunId: current.runId,
        recordBranchId: current.branchId,
      });
    }
    return current;
  }

  async #recordWithRequestBytes(record) {
    if (!record.requestBytesRef) return record;
    return { ...record, requestBytes: await this.store.getBlob(record.requestBytesRef) };
  }

  async #recordRecoveredResolution(record, recovered) {
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
}

export function journaledHostRequest(hostRequest, manifest) {
  const endpointSource = manifest?.diagnostics?.endpointSource;
  if (endpointSource !== 'config' && endpointSource !== 'request-or-config') return hostRequest;
  const requestRendering = manifest?.diagnostics?.requestRendering ?? null;
  let parsed = {};
  try {
    const requestBytes = hostRequest?.requestBytes ?? fromUtf8(stableJson(hostRequest?.request ?? {}));
    parsed = JSON.parse(new TextDecoder().decode(requestBytes));
  } catch {
    return hostRequest;
  }
  if (endpointSource === 'request-or-config' && parsed?.url !== undefined && parsed.method !== undefined) {
    return requestRendering === null && !hasModelOutputValidation(manifest?.diagnostics) ? hostRequest : {
      ...hostRequest,
      effectIdentityBytes: fromUtf8(stableJson(effectIdentityPayload(manifest?.diagnostics, parsed, null, requestRendering))),
    };
  }
  const configuredEndpoint = configuredEffectIdentityTarget(manifest, parsed);
  if (!configuredEndpoint && requestRendering === null && !hasModelOutputValidation(manifest?.diagnostics)) return hostRequest;
  return {
    ...hostRequest,
    effectIdentityBytes: fromUtf8(stableJson(effectIdentityPayload(manifest?.diagnostics, parsed, configuredEndpoint, requestRendering))),
  };
}

function configuredEffectIdentityTarget(manifest, parsed = {}) {
  const origins = Array.isArray(manifest?.diagnostics?.origins) ? manifest.diagnostics.origins : [];
  const methods = Array.isArray(manifest?.diagnostics?.methods) ? manifest.diagnostics.methods : [];
  const endpointSource = manifest?.diagnostics?.endpointSource;
  const requestUrl = endpointSource === 'request-or-config' && parsed?.url !== undefined ? parsed.url : null;
  const url = requestUrl ?? manifest?.diagnostics?.configuredEndpointUrl ?? manifest?.diagnostics?.configuredOrigin ?? (origins.length === 1 ? origins[0] : null);
  const method = parsed.method ?? manifest?.diagnostics?.defaultMethod ?? (methods.length === 1 ? methods[0] : null);
  if (!url || !method) return null;
  return { url, method };
}

function effectIdentityPayload(diagnostics, request, configuredEndpoint, requestRendering) {
  const payload = { request, configuredEndpoint, requestRendering };
  if (hasModelOutputValidation(diagnostics)) payload.modelOutputValidation = diagnostics.modelOutputValidation;
  return payload;
}

function hasModelOutputValidation(diagnostics) {
  return diagnostics != null && Object.prototype.hasOwnProperty.call(diagnostics, 'modelOutputValidation');
}

function driverFailureState(recoveryClass) {
  if (recoveryClass === EffectRecoveryClass.bestEffort) return EffectState.operatorInterventionRequired;
  if (RECOVER_AFTER_RESOLVE_FAILURE.has(recoveryClass)) return EffectState.running;
  return EffectState.failed;
}

function driverFailureDiagnostics(recoveryClass) {
  if (recoveryClass === EffectRecoveryClass.bestEffort) return { recoveryRequired: 'best_effort_resolution_not_durable' };
  if (RECOVER_AFTER_RESOLVE_FAILURE.has(recoveryClass)) return { recoveryRequired: `${recoveryClass}_resolve_failed` };
  return {};
}

function invalidResolutionFailureState(recoveryClass) {
  if (recoveryClass === EffectRecoveryClass.bestEffort) return EffectState.operatorInterventionRequired;
  return EffectState.failed;
}

function persistenceFailureState(recoveryClass) {
  return driverFailureState(recoveryClass);
}

function resolutionFailureDiagnostics(failureState) {
  if (failureState === EffectState.operatorInterventionRequired) return { recoveryRequired: 'best_effort_resolution_not_durable' };
  return {};
}

function persistenceFailureDiagnostics(failureState, recoveryClass) {
  if (failureState === EffectState.operatorInterventionRequired) return { recoveryRequired: 'best_effort_resolution_not_durable' };
  if (RECOVER_AFTER_RESOLVE_FAILURE.has(recoveryClass)) return { recoveryRequired: `${recoveryClass}_persistence_failed` };
  return {};
}

function canSafelyReResolve(recoveryClass) {
  return recoveryClass === EffectRecoveryClass.pure || recoveryClass === EffectRecoveryClass.idempotent;
}

function retryableReusableResolutionError(error, manifest, policy) {
  if (!error?.code) return true;
  if (error.code === 'ERR_EFFECT_RESPONSE_TOO_LARGE') {
    return policy.maximumResponseBytes === undefined || manifest.maximumResponseBytes <= policy.maximumResponseBytes;
  }
  return new Set([
    'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH',
    'ERR_RESPONSE_STATUS_NOT_SUPPORTED',
    'ERR_EFFECT_RESPONSE_STATUS_MISMATCH',
    'ERR_EFFECT_RESPONSE_REQUIRED',
    'ERR_EFFECT_RESPONSE_FORBIDDEN',
  ]).has(error.code);
}

function assertDriverRecoveryHookSufficient(manifest, driver) {
  if (
    (manifest.recoveryClass === EffectRecoveryClass.externallyRecoverable ||
      manifest.recoveryClass === EffectRecoveryClass.transactional) &&
    typeof driver.recover !== 'function'
  ) {
    fail('ERR_EFFECT_RECOVERY_HOOK_REQUIRED', 'externally recoverable and transactional drivers must expose recover before durable invocation');
  }
}

function assertDriverCanRecover(manifest, record) {
  if (!manifest.supportedActuatorRefs.includes(record.actuatorRef)) fail('ERR_ACTUATOR_REF_NOT_SUPPORTED');
  if (!manifest.supportedDescriptorFingerprints.includes(record.descriptorFingerprint)) fail('ERR_DESCRIPTOR_NOT_SUPPORTED');
  if (!record.actuationClass || !manifest.supportedActuationClasses.includes(record.actuationClass)) fail('ERR_ACTUATION_CLASS_NOT_SUPPORTED');
  if (record.responseSchema && !manifest.supportedResponseStatuses.includes(record.responseSchema.status)) fail('ERR_RESPONSE_STATUS_NOT_SUPPORTED');
  hostRequestTargetFingerprint(record);
  assertEffectRecoveryClassMatchesManifest(manifest, record);
}

function assertEffectRecoveryClassMatchesManifest(manifest, record) {
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
    actuationClass: record.actuationClass,
    responseSchema: record.responseSchema,
    requestBytesChecksum: record.requestBytesChecksum,
    requestIdentityChecksum: record.requestIdentityChecksum,
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
  if (typeof record.actuationClass !== 'string' || record.actuationClass.length === 0) fail('ERR_INVALID_EFFECT_RECORD', 'actuationClass is required');
  if (record.requestIdentityChecksum !== undefined && (typeof record.requestIdentityChecksum !== 'string' || record.requestIdentityChecksum.length === 0)) {
    fail('ERR_INVALID_EFFECT_RECORD', 'requestIdentityChecksum must be string');
  }
  if (!EFFECT_STATES.has(record.state)) fail('ERR_INVALID_EFFECT_STATE');
  if (!Number.isSafeInteger(record.attemptCount) || record.attemptCount < 0) fail('ERR_INVALID_EFFECT_RECORD', 'attemptCount must be non-negative');
  assertRecoveryClass(record.driverRecoveryClass);
  assertOptionalBlobRef(record.requestBytesRef, 'requestBytesRef');
  assertOptionalBlobRef(record.resolutionInputRef, 'resolutionInputRef');
  assertOptionalBlobRef(record.hostClaimRef, 'hostClaimRef');
  if (record.state === EffectState.running && !record.requestBytesRef) {
    fail('ERR_INVALID_EFFECT_RECORD', 'running effects require persisted request bytes');
  }
  if (TERMINAL_WITH_OUTCOME.has(record.state) && !record.resolutionInputRef) {
    fail('ERR_INVALID_EFFECT_RECORD', 'outcome effects require a persisted ResolutionInput');
  }
  return record;
}

function assertOptionalBlobRef(ref, field) {
  if (ref === undefined || ref === null) return;
  try {
    assertBlobRef(ref);
  } catch (error) {
    fail('ERR_INVALID_EFFECT_RECORD', `${field} must be a valid blob ref`, { cause: error.message });
  }
}

export async function prepareHostRequest(hostRequest) {
  if (!hostRequest || typeof hostRequest !== 'object') fail('ERR_INVALID_HOST_REQUEST');
  const idempotencyKeyBytes = assertBytes(hostRequest.idempotencyKeyBytes, 'idempotencyKeyBytes');
  const requestBytes = assertBytes(hostRequest.requestBytes ?? fromUtf8(stableJson(hostRequest.request ?? {})), 'requestBytes');
  const effectIdentityBytes = hostRequest.effectIdentityBytes === undefined
    ? requestBytes
    : assertBytes(hostRequest.effectIdentityBytes, 'effectIdentityBytes');
  if (hostRequest.shortIdempotencyKeyHash) fail('ERR_SHORT_IDEMPOTENCY_KEY_FORBIDDEN');
  const requestBytesChecksum = `sha256:${await sha256Hex(requestBytes)}`;
  const requestIdentityChecksum = `sha256:${await sha256Hex(effectIdentityBytes)}`;
  const generatedHostRequestHash = await sha256Hex(fromUtf8(stableJson({
    actuatorRef: hostRequest.actuatorRef,
    descriptorFingerprint: hostRequest.descriptorFingerprint,
    actuationClass: hostRequest.actuationClass,
    responseSchema: hostRequest.responseSchema ?? null,
    requestBytesChecksum: requestIdentityChecksum,
  })));
  const hostRequestFingerprint = hostRequest.hostRequestFingerprint ?? `world:host-request:${generatedHostRequestHash.slice(0, 16)}`;
  hostRequestTargetFingerprint({ hostRequestFingerprint });
  return {
    idempotencyKey: {
      format: 'world-idempotency-key-bytes.hex',
      bytesHex: toHex(idempotencyKeyBytes),
    },
    idempotencyKeyWorldFingerprint: hostRequest.idempotencyKeyWorldFingerprint ?? `sha256:${await sha256Hex(idempotencyKeyBytes)}`,
    requestBytes,
    requestBytesChecksum,
    requestIdentityChecksum,
    hostRequestFingerprint,
  };
}

function effectIdentityChecksum(record) {
  return record.requestIdentityChecksum ?? record.requestBytesChecksum;
}

function normalizePreparedHostRequest(hostRequest, prepared) {
  return {
    ...hostRequest,
    requestBytes: prepared.requestBytes,
    hostRequestFingerprint: prepared.hostRequestFingerprint,
    idempotencyKeyWorldFingerprint: prepared.idempotencyKeyWorldFingerprint,
  };
}

function normalizeDriverResolution(value) {
  const resolutionInputBytes = value instanceof Uint8Array ? value : value?.resolutionInputBytes;
  assertBytes(resolutionInputBytes, 'resolutionInputBytes');
  return {
    resolutionInputBytes,
    hostClaimBytes: value?.hostClaimBytes === undefined ? undefined : assertBytes(value.hostClaimBytes, 'hostClaimBytes'),
    driverTransactionRef: value?.driverTransactionRef,
    diagnostics: value?.diagnostics ?? {},
  };
}

function assertPreparedRequestWithinLimits(prepared, manifest, policy) {
  if (manifest && prepared.requestBytes.byteLength > manifest.maximumRequestBytes) fail('ERR_HOST_REQUEST_TOO_LARGE');
  if (policy.maximumRequestBytes !== undefined && prepared.requestBytes.byteLength > policy.maximumRequestBytes) fail('ERR_HOST_REQUEST_TOO_LARGE');
}

async function assertRecoveredRequestWithinLimits(record, manifest, policy) {
  if (!record.requestBytes) fail('ERR_EFFECT_REQUEST_BYTES_REQUIRED', 'effect recovery requires persisted request bytes');
  const checksum = `sha256:${await sha256Hex(record.requestBytes)}`;
  if (checksum !== record.requestBytesChecksum) fail('ERR_EFFECT_REQUEST_BYTES_CHECKSUM_MISMATCH');
  if (record.requestBytes.byteLength > manifest.maximumRequestBytes) fail('ERR_HOST_REQUEST_TOO_LARGE');
  if (policy.maximumRequestBytes !== undefined && record.requestBytes.byteLength > policy.maximumRequestBytes) fail('ERR_HOST_REQUEST_TOO_LARGE');
}

async function assertRecoveredEffectIdentityMatchesManifest(record, manifest) {
  const recoveredHostRequest = journaledHostRequest(record, manifest);
  const effectIdentityBytes = recoveredHostRequest.effectIdentityBytes === undefined
    ? record.requestBytes
    : assertBytes(recoveredHostRequest.effectIdentityBytes, 'effectIdentityBytes');
  const checksum = `sha256:${await sha256Hex(effectIdentityBytes)}`;
  if (checksum !== effectIdentityChecksum(record)) {
    fail('ERR_EFFECT_IDEMPOTENCY_CONFLICT', 'recovery driver rendered a different effect identity', {
      idempotencyKeyWorldFingerprint: record.idempotencyKeyWorldFingerprint,
    });
  }
}

function assertManifestResponseWithinPolicy(manifest, policy) {
  if (policy.maximumResponseBytes !== undefined && manifest.maximumResponseBytes > policy.maximumResponseBytes) {
    fail('ERR_EFFECT_RESPONSE_LIMIT_EXCEEDS_POLICY');
  }
}

export function assertResolutionAccepted(resolutionInputBytes, hostRequest, manifest, policy) {
  const resolution = decodeResolutionInputBytes(resolutionInputBytes);
  const expectedTarget = hostRequestTargetFingerprint(hostRequest);
  if (resolution.targetHostRequestFingerprint !== expectedTarget) {
    fail('ERR_EFFECT_RESOLUTION_TARGET_MISMATCH', 'driver ResolutionInput targets a different HostRequest');
  }
  assertResolutionStatusAccepted(resolution.status, hostRequest, manifest);
  if (resolution.status === 0 && resolution.responseValueImageBytes.byteLength === 0) {
    fail('ERR_EFFECT_RESPONSE_REQUIRED', 'responded ResolutionInput requires response bytes');
  }
  if (resolution.status !== 0 && resolution.responseValueImageBytes.byteLength !== 0) {
    fail('ERR_EFFECT_RESPONSE_FORBIDDEN', 'non-responded ResolutionInput must not carry response bytes');
  }
  const maximumResponseBytes = policy.maximumResponseBytes === undefined
    ? manifest.maximumResponseBytes
    : Math.min(manifest.maximumResponseBytes, policy.maximumResponseBytes);
  if (maximumResponseBytes === Number.MAX_SAFE_INTEGER) return;
  if (resolutionInputBytes.byteLength > maximumResponseBytes) {
    fail('ERR_EFFECT_RESPONSE_TOO_LARGE', 'driver ResolutionInput exceeds byte limit');
  }
  if (resolution.responseValueImageBytes.byteLength > maximumResponseBytes) {
    fail('ERR_EFFECT_RESPONSE_TOO_LARGE', 'driver ResolutionInput response exceeds byte limit');
  }
  if (resolution.hostClaimBytes.byteLength > maximumResponseBytes) {
    fail('ERR_EFFECT_RESPONSE_TOO_LARGE', 'driver ResolutionInput host claim exceeds byte limit');
  }
  if (resolution.metadata.byteLength > maximumResponseBytes) {
    fail('ERR_EFFECT_RESPONSE_TOO_LARGE', 'driver ResolutionInput metadata exceeds byte limit');
  }
}

function assertDriverCarriedBytesAccepted(resolved, manifest, policy) {
  if (!resolved.hostClaimBytes) return;
  const maximumResponseBytes = policy.maximumResponseBytes === undefined
    ? manifest.maximumResponseBytes
    : Math.min(manifest.maximumResponseBytes, policy.maximumResponseBytes);
  if (maximumResponseBytes !== Number.MAX_SAFE_INTEGER && resolved.hostClaimBytes.byteLength > maximumResponseBytes) {
    fail('ERR_EFFECT_RESPONSE_TOO_LARGE', 'driver host claim exceeds byte limit');
  }
}

function assertResolutionStatusAccepted(status, hostRequest, manifest) {
  const expectedStatus = hostRequest.responseSchema?.status;
  if (expectedStatus === undefined) {
    const manifestStatuses = new Set((manifest.supportedResponseStatuses ?? []).map((item) => ResponseStatusCode[item]));
    if (!manifestStatuses.has(status)) fail('ERR_RESPONSE_STATUS_NOT_SUPPORTED', 'ResolutionInput status is not supported by the selected driver manifest');
    return;
  }
  const expectedWireStatus = ResponseStatusCode[expectedStatus];
  if (expectedWireStatus === undefined) fail('ERR_RESPONSE_STATUS_NOT_SUPPORTED', 'response schema status is not mapped to a wire status');
  if (status !== expectedWireStatus) fail('ERR_EFFECT_RESPONSE_STATUS_MISMATCH', 'driver ResolutionInput status does not match the HostRequest response schema');
}

export function hostRequestTargetFingerprint(hostRequest) {
  const value = hostRequest.hostRequestFingerprint;
  if (typeof value === 'bigint' || typeof value === 'number') return assertU64Fingerprint(BigInt(value));
  const match = String(value ?? '').match(/^(?:world:host-request:|0x)([0-9a-f]+)$/i);
  if (!match) fail('ERR_HOST_REQUEST_FINGERPRINT_REQUIRED');
  return assertU64Fingerprint(BigInt(`0x${match[1]}`));
}

function assertU64Fingerprint(value) {
  if (value < 0n || value > MAX_U64) fail('ERR_HOST_REQUEST_FINGERPRINT_RANGE', 'HostRequest fingerprint must fit the World u64 wire range');
  return value;
}

async function withEffectKeyLock(store, key, fn) {
  const locks = effectLockMap(store);
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

function effectLockMap(store) {
  const storeKey = store?.concurrencyKey;
  if (typeof storeKey === 'string' && storeKey.length > 0) {
    let locks = effectKeyLocksByStoreKey.get(storeKey);
    if (!locks) {
      locks = new Map();
      effectKeyLocksByStoreKey.set(storeKey, locks);
    }
    return locks;
  }
  let locks = effectKeyLocksByStore.get(store);
  if (!locks) {
    locks = new Map();
    effectKeyLocksByStore.set(store, locks);
  }
  return locks;
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
