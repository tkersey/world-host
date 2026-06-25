import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EffectRecoveryClass } from '../src/core/actuator.mjs';
import { EffectJournal, EffectState, prepareHostRequest } from '../src/core/effect_journal.mjs';
import { fromUtf8 } from '../src/core/store.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';

describe('EffectJournal', () => {
  it('reuses persisted ResolutionInput for the same complete idempotency key', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, response: 'resolution:one' });
    const first = await journal.resolve({}, hostRequest(), driver);
    const second = await journal.resolve({}, hostRequest(), driver);

    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(driver.calls, 1);
    assert.deepEqual(second.resolutionInputBytes, fromUtf8('resolution:one'));
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
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });

    const recovered = await journal.resolve({}, hostRequest(), driver);

    assert.equal(recovered.record.state, EffectState.resolved);
    assert.equal(driver.calls, 0);
    assert.equal(driver.recoverCalls, 1);
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
    ...overrides,
  };
}

function fixtureDriver({ recoveryClass, response = 'resolution', descriptorFingerprint = 'descriptor:fixture' }) {
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
        maximumRequestBytes: 1024,
        maximumResponseBytes: 1024,
        recoveryClass,
        concurrencyLimit: 1,
        authorityLabels: ['fixture'],
      };
    },
    async resolve() {
      this.calls += 1;
      return { resolutionInputBytes: fromUtf8(response) };
    },
    async recover() {
      this.recoverCalls += 1;
      return { resolutionInputBytes: fromUtf8(`recovered:${response}`) };
    },
  };
}
