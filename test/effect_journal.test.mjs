import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EffectRecoveryClass } from '../src/core/actuator.mjs';
import { EffectJournal, EffectState, prepareHostRequest } from '../src/core/effect_journal.mjs';
import { fromUtf8 } from '../src/core/store.mjs';
import { HttpJsonDriver } from '../src/drivers/http_json_driver.mjs';
import { decodeResolutionInputBytes, encodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';

describe('EffectJournal', () => {
  it('reuses persisted ResolutionInput for the same complete idempotency key', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, response: 'resolution:one' });
    const first = await journal.resolve({}, hostRequest(), driver);
    const second = await journal.resolve({}, hostRequest(), driver);

    assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
    assert.equal(driver.calls, 1);
    assert.deepEqual(decodeResolutionInputBytes(second.resolutionInputBytes).responseValueImageBytes, fromUtf8('resolution:one'));
  });

  it('serializes concurrent same-key resolutions before driver execution', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, response: 'resolution:one', delayMs: 10 });

    const [first, second] = await Promise.all([
      journal.resolve({}, hostRequest(), driver),
      journal.resolve({}, hostRequest(), driver),
    ]);

    assert.equal(driver.calls, 1);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.deepEqual(decodeResolutionInputBytes(second.resolutionInputBytes).responseValueImageBytes, fromUtf8('resolution:one'));
  });

  it('rejects actual driver responses that exceed receiver policy', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({
      store,
      runId: 'run',
      branchId: 'main',
      parentTurnClosureFingerprint: 'turn:0',
      policy: { maximumResponseBytes: 1 },
    });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), fixtureDriver({
        recoveryClass: EffectRecoveryClass.idempotent,
        response: encodeResolutionInputBytes({
          targetHostRequestFingerprint: 0xa1n,
          status: 0,
          responseValueImageBytes: fromUtf8('too large'),
          hostClaimBytes: new Uint8Array(),
          attemptNumber: 1,
          metadata: new Uint8Array(),
        }),
      })),
      { code: 'ERR_EFFECT_RESPONSE_TOO_LARGE' },
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, EffectState.failed);
  });

  it('rejects actual driver responses that exceed manifest limits', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), fixtureDriver({
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1,
        response: encodeResolutionInputBytes({
          targetHostRequestFingerprint: 0xa1n,
          status: 0,
          responseValueImageBytes: fromUtf8('too large'),
          hostClaimBytes: new Uint8Array(),
          attemptNumber: 1,
          metadata: new Uint8Array(),
        }),
      })),
      { code: 'ERR_EFFECT_RESPONSE_TOO_LARGE' },
    );
  });

  it('rejects driver ResolutionInput targeting another HostRequest before persisting it', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), fixtureDriver({
        recoveryClass: EffectRecoveryClass.idempotent,
        response: encodeResolutionInputBytes({
          targetHostRequestFingerprint: 0xa2n,
          status: 0,
          responseValueImageBytes: fromUtf8('wrong target'),
          hostClaimBytes: new Uint8Array(),
          attemptNumber: 1,
          metadata: new Uint8Array(),
        }),
      })),
      { code: 'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH' },
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, EffectState.failed);
    assert.equal(records[0].resolutionInputRef, undefined);
  });

  it('validates serialized fallback request bytes before driver execution', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, maximumRequestBytes: 1 });

    await assert.rejects(
      () => journal.resolve({}, hostRequest({ requestBytes: undefined, request: { payload: 'too large' } }), driver),
      { code: 'ERR_HOST_REQUEST_TOO_LARGE' },
    );
    assert.equal(driver.calls, 0);
    assert.equal((await store.listEffectRecords('run')).length, 0);
  });

  it('rejects the same full idempotency key with different request bytes', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    await journal.resolve({}, hostRequest(), fixtureDriver({ recoveryClass: EffectRecoveryClass.pure }));

    await assert.rejects(
      () => journal.resolve({}, hostRequest({ requestBytes: fromUtf8('different') }), fixtureDriver({ recoveryClass: EffectRecoveryClass.pure })),
      { code: 'ERR_EFFECT_IDEMPOTENCY_CONFLICT' },
    );
  });

  it('rejects the same full idempotency key with a different host request identity', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.pure });
    await journal.resolve({}, hostRequest({ hostRequestFingerprint: 'world:host-request:one' }), driver);

    await assert.rejects(
      () => journal.resolve({}, hostRequest({ hostRequestFingerprint: 'world:host-request:two' }), driver),
      { code: 'ERR_EFFECT_IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(driver.calls, 1);
  });

  it('forbids shortened idempotency-key hash authority', async () => {
    await assert.rejects(
      () => prepareHostRequest(hostRequest({ shortIdempotencyKeyHash: 'abc123' })),
      { code: 'ERR_SHORT_IDEMPOTENCY_KEY_FORBIDDEN' },
    );
  });

  it('rejects best_effort drivers for durable automatic runs without operator opt-in', async () => {
    const journal = new EffectJournal({ store: new MemoryStore(), runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    await assert.rejects(
      () => journal.resolve({}, hostRequest(), fixtureDriver({ recoveryClass: EffectRecoveryClass.bestEffort })),
      { code: 'ERR_BEST_EFFORT_REQUIRES_OPERATOR_OPT_IN' },
    );
  });

  it('recovers running effects instead of resolving them again', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.idempotent });
    await store.putEffectRecord({ ...observed, state: EffectState.running, attemptCount: 1 });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, recoverHostClaim: true });

    const recovered = await journal.resolve({}, hostRequest(), driver);

    assert.equal(recovered.record.state, EffectState.resolved);
    assert.deepEqual(await store.getBlob(recovered.record.hostClaimRef), fromUtf8('recovered-host-claim'));
    assert.equal(driver.calls, 0);
    assert.equal(driver.recoverCalls, 1);
  });

  it('recomputes running pure effects when no recover hook exists', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.pure });
    await store.putEffectRecord({ ...observed, state: EffectState.running, attemptCount: 1 });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.pure, recover: false });

    const recovered = await journal.resolve({}, hostRequest(), driver);

    assert.equal(recovered.record.state, EffectState.resolved);
    assert.equal(driver.calls, 1);
    assert.equal(driver.recoverCalls, 0);
  });

  it('recovers idempotent HTTP effects from persisted request bytes', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(httpHostRequest(), { recoveryClass: EffectRecoveryClass.idempotent });
    await store.putEffectRecord({ ...observed, state: EffectState.running, attemptCount: 1 });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = async (url, options) => {
        calls += 1;
        assert.equal(String(url), 'https://allowed.example/path');
        assert.equal(options.headers['Idempotency-Key'], 'world:key:http');
        return new Response('{"ok":true}', { status: 200, headers: { 'x-request-id': 'recover-1' } });
      };
      const recovered = await journal.resolve({}, httpHostRequest(), new HttpJsonDriver({ origins: ['https://allowed.example'] }));

      assert.equal(recovered.record.state, EffectState.resolved);
      assert.equal(recovered.record.driverTransactionRef, 'recover-1');
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('marks unresolved best_effort recovery for operator intervention', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({
      store,
      runId: 'run',
      branchId: 'main',
      parentTurnClosureFingerprint: 'turn:0',
      policy: { allowBestEffort: true },
    });
    const observed = await journal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.bestEffort });
    const recovered = await journal.recover({}, { ...observed, state: EffectState.running }, fixtureDriver({ recoveryClass: EffectRecoveryClass.bestEffort }));

    assert.equal(recovered.operatorInterventionRequired, true);
    assert.equal(recovered.record.state, EffectState.operatorInterventionRequired);
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.bestEffort });
    const retried = await journal.resolve({}, hostRequest(), driver);
    assert.equal(retried.operatorInterventionRequired, true);
    assert.equal(retried.record.state, EffectState.operatorInterventionRequired);
    assert.equal(driver.calls, 0);
  });

  it('parks best_effort post-run validation failures for operator intervention', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({
      store,
      runId: 'run',
      branchId: 'main',
      parentTurnClosureFingerprint: 'turn:0',
      policy: { allowBestEffort: true },
    });
    const driver = fixtureDriver({
      recoveryClass: EffectRecoveryClass.bestEffort,
      response: encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xa2n,
        status: 0,
        responseValueImageBytes: fromUtf8('wrong target'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: new Uint8Array(),
      }),
    });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), driver),
      { code: 'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH' },
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records[0].state, EffectState.operatorInterventionRequired);
    const retried = await journal.resolve({}, hostRequest(), driver);
    assert.equal(retried.operatorInterventionRequired, true);
    assert.equal(driver.calls, 1);
  });

  it('validates recovery driver authority against the effect record', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.idempotent });

    await assert.rejects(
      () => journal.recover({}, observed, fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, descriptorFingerprint: 'descriptor:other' })),
      { code: 'ERR_DESCRIPTOR_NOT_SUPPORTED' },
    );
    await assert.rejects(
      () => journal.recover({}, observed, fixtureDriver({ recoveryClass: EffectRecoveryClass.pure })),
      { code: 'ERR_EFFECT_RECOVERY_CLASS_MISMATCH' },
    );
  });

  it('reconciles resolved and submitted effects from the committed head without crossing branch or parent', async () => {
    const store = new MemoryStore();
    const mainJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const otherParentJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:other' });
    const otherBranchJournal = new EffectJournal({ store, runId: 'run', branchId: 'alternate', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });

    const resolved = (await mainJournal.resolve({}, hostRequest({
      idempotencyKeyBytes: fromUtf8('key:resolved'),
      idempotencyKeyWorldFingerprint: 'world:key:resolved',
      requestBytes: fromUtf8('request:resolved'),
    }), driver)).record;
    const uncommittedResolved = (await mainJournal.resolve({}, hostRequest({
      idempotencyKeyBytes: fromUtf8('key:uncommitted-resolved'),
      idempotencyKeyWorldFingerprint: 'world:key:uncommitted-resolved',
      requestBytes: fromUtf8('request:uncommitted-resolved'),
    }), driver)).record;
    const matching = await mainJournal.markSubmitted((await mainJournal.resolve({}, hostRequest({ idempotencyKeyBytes: fromUtf8('key:matching') }), driver)).record);
    const otherParent = await otherParentJournal.markSubmitted((await otherParentJournal.resolve({}, hostRequest({
      idempotencyKeyBytes: fromUtf8('key:other-parent'),
      idempotencyKeyWorldFingerprint: 'world:key:other-parent',
      requestBytes: fromUtf8('request:other-parent'),
    }), driver)).record);
    const otherBranch = await otherBranchJournal.markSubmitted((await otherBranchJournal.resolve({}, hostRequest({
      idempotencyKeyBytes: fromUtf8('key:other-branch'),
      idempotencyKeyWorldFingerprint: 'world:key:other-branch',
      requestBytes: fromUtf8('request:other-branch'),
    }), driver)).record);

    const result = await mainJournal.reconcileCommittedHead({
      updateDiagnostics: {
        parentTurnClosureFingerprint: 'turn:0',
        committedEffectIds: [resolved.idempotencyKeyWorldFingerprint, matching.idempotencyKeyWorldFingerprint],
      },
    });
    const records = await store.listEffectRecords('run');

    assert.equal(result.committedCount, 2);
    assert.deepEqual(result.committed.map((record) => record.idempotencyKey.bytesHex).sort(), [
      matching.idempotencyKey.bytesHex,
      resolved.idempotencyKey.bytesHex,
    ].sort());
    assert.equal(records.find((record) => record.idempotencyKey.bytesHex === resolved.idempotencyKey.bytesHex).state, EffectState.closureCommitted);
    assert.equal(records.find((record) => record.idempotencyKey.bytesHex === uncommittedResolved.idempotencyKey.bytesHex).state, EffectState.resolved);
    assert.equal(records.find((record) => record.idempotencyKey.bytesHex === matching.idempotencyKey.bytesHex).state, EffectState.closureCommitted);
    assert.equal(records.find((record) => record.idempotencyKey.bytesHex === otherParent.idempotencyKey.bytesHex).state, EffectState.submitted);
    assert.equal(records.find((record) => record.idempotencyKey.bytesHex === otherBranch.idempotencyKey.bytesHex).state, EffectState.submitted);
    assert.equal(driver.calls, 5);
  });

  it('reuses same-key outcomes with a branch-local effect record', async () => {
    const store = new MemoryStore();
    const mainJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const alternateJournal = new EffectJournal({ store, runId: 'run', branchId: 'alternate', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });

    const main = await mainJournal.resolve({}, hostRequest(), driver);
    const alternate = await alternateJournal.resolve({}, hostRequest(), driver);
    const records = await store.listEffectRecords('run');

    assert.equal(main.record.branchId, 'main');
    assert.equal(alternate.record.branchId, 'alternate');
    assert.equal(alternate.reused, true);
    assert.equal(driver.calls, 1);
    assert.equal(records.length, 2);
    assert.equal(records.filter((record) => record.branchId === 'main').length, 1);
    assert.equal(records.filter((record) => record.branchId === 'alternate').length, 1);
  });

  it('reparents same-branch reused outcomes to the current parent', async () => {
    const store = new MemoryStore();
    const firstJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const nextJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:1' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });

    await firstJournal.resolve({}, hostRequest(), driver);
    const reused = await nextJournal.resolve({}, hostRequest(), driver);
    const records = await store.listEffectRecords('run');

    assert.equal(reused.reused, true);
    assert.equal(reused.record.parentTurnClosureFingerprint, 'turn:1');
    assert.equal(reused.record.state, EffectState.resolved);
    assert.equal(records.length, 1);
    assert.equal(records[0].parentTurnClosureFingerprint, 'turn:1');
    assert.equal(driver.calls, 1);
  });

  it('fails closed when committed-head recovery lacks a parent fingerprint', async () => {
    const journal = new EffectJournal({ store: new MemoryStore(), runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });

    await assert.rejects(
      () => journal.reconcileCommittedHead({ updateDiagnostics: {} }),
      { code: 'ERR_EFFECT_RECONCILE_HEAD_PARENT_REQUIRED' },
    );
  });
});

function hostRequest(overrides = {}) {
  return {
    actuatorRef: 'fixture:model',
    descriptorFingerprint: 'descriptor:fixture',
    actuationClass: 'fixture',
    responseSchema: { status: 'ok' },
    idempotencyKeyBytes: fromUtf8('complete-world-idempotency-key'),
    idempotencyKeyWorldFingerprint: 'world:idempotency:key',
    requestBytes: fromUtf8('request:one'),
    hostRequestFingerprint: 'world:host-request:00000000000000a1',
    ...overrides,
  };
}

function httpHostRequest(overrides = {}) {
  return {
    actuatorRef: 'http:json',
    descriptorFingerprint: 'descriptor:http-json',
    actuationClass: 'http',
    responseSchema: { status: 'ok' },
    idempotencyKeyBytes: fromUtf8('complete-http-idempotency-key'),
    idempotencyKeyWorldFingerprint: 'world:key:http',
    requestBytes: fromUtf8(JSON.stringify({ url: 'https://allowed.example/path' })),
    hostRequestFingerprint: 'world:host-request:00000000000000a1',
    ...overrides,
  };
}

function fixtureDriver({ recoveryClass, response = 'resolution', descriptorFingerprint = 'descriptor:fixture', recover = true, recoverHostClaim = false, delayMs = 0, maximumRequestBytes = 1024, maximumResponseBytes = Number.MAX_SAFE_INTEGER }) {
  return {
    calls: 0,
    recoverCalls: 0,
    manifest() {
      return {
        driverId: 'fixture-driver',
        supportedActuatorRefs: ['fixture:model'],
        supportedDescriptorFingerprints: [descriptorFingerprint],
        supportedActuationClasses: ['fixture'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes,
        maximumResponseBytes,
        recoveryClass,
        concurrencyLimit: 1,
        authorityLabels: ['fixture'],
      };
    },
    async resolve(_context, request) {
      this.calls += 1;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { resolutionInputBytes: response instanceof Uint8Array ? response : fixtureResolutionInputBytes(request, fromUtf8(response)) };
    },
    recover: recover ? async function recoverFn(_context, record) {
      this.recoverCalls += 1;
      return {
        resolutionInputBytes: fixtureResolutionInputBytes(record, fromUtf8(`recovered:${response}`)),
        hostClaimBytes: recoverHostClaim ? fromUtf8('recovered-host-claim') : undefined,
      };
    } : undefined,
  };
}

function fixtureResolutionInputBytes(request, responseValueImageBytes) {
  return encodeResolutionInputBytes({
    targetHostRequestFingerprint: requestTargetFingerprint(request),
    status: 0,
    responseValueImageBytes,
    hostClaimBytes: new Uint8Array(),
    attemptNumber: 1,
    metadata: new Uint8Array(),
  });
}

function requestTargetFingerprint(request) {
  const value = request.hostRequestFingerprint;
  if (typeof value === 'bigint' || typeof value === 'number') return BigInt(value);
  const match = String(value ?? '').match(/(?:0x)?([0-9a-f]+)$/i);
  return BigInt(`0x${match[1]}`);
}
