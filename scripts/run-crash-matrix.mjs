#!/usr/bin/env node
import assert from 'node:assert/strict';

import { EffectRecoveryClass } from '../src/core/actuator.mjs';
import { EffectJournal, EffectState } from '../src/core/effect_journal.mjs';
import { fromUtf8 } from '../src/core/store.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';

await provesPersistedOutcomeReuse();
await provesRecoverableClasses();
await provesBestEffortIntervention();
await provesConflictIsHard();
await provesCommittedHeadReconcilesSubmittedEffects();
await provesCommittedHeadReconcilesResolvedEffects();

console.log('crash_matrix=passed');

async function provesPersistedOutcomeReuse() {
  const store = new MemoryStore();
  const journal = new EffectJournal({ store, runId: 'run-e', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
  const driver = driverFor(EffectRecoveryClass.idempotent, 'resolution:e');
  const first = await journal.resolve({}, request('e'), driver);
  const retried = await journal.resolve({}, request('e'), driver);

  assert.equal(first.record.state, EffectState.resolved, 'E-F outcome persisted before World submission');
  assert.equal(retried.reused, true, 'lost output retry reuses persisted ResolutionInput');
  assert.equal(driver.calls, 1, 'idempotent external effect not invoked twice after persisted outcome');
}

async function provesRecoverableClasses() {
  for (const recoveryClass of [
    EffectRecoveryClass.pure,
    EffectRecoveryClass.idempotent,
    EffectRecoveryClass.externallyRecoverable,
    EffectRecoveryClass.transactional,
  ]) {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: `run-${recoveryClass}`, branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(request(recoveryClass), { recoveryClass });
    const recovered = await journal.recover({}, { ...observed, state: EffectState.running }, driverFor(recoveryClass, `resolution:${recoveryClass}`));
    assert.equal(recovered.record.state, EffectState.resolved, `${recoveryClass} recovers automatically`);
    assert.deepEqual(recovered.resolutionInputBytes, fromUtf8(`recovered:${recoveryClass}`));
  }
}

async function provesBestEffortIntervention() {
  const store = new MemoryStore();
  const journal = new EffectJournal({
    store,
    runId: 'run-best-effort',
    branchId: 'main',
    parentTurnClosureFingerprint: 'turn:0',
    policy: { allowBestEffort: true },
  });
  const observed = await journal.observe(request('best'), { recoveryClass: EffectRecoveryClass.bestEffort });
  const recovered = await journal.recover({}, { ...observed, state: EffectState.running }, driverFor(EffectRecoveryClass.bestEffort, 'resolution:best'));
  assert.equal(recovered.record.state, EffectState.operatorInterventionRequired);
  assert.equal(recovered.operatorInterventionRequired, true);
}

async function provesConflictIsHard() {
  const store = new MemoryStore();
  const journal = new EffectJournal({ store, runId: 'run-conflict', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
  await journal.resolve({}, request('conflict'), driverFor(EffectRecoveryClass.pure, 'resolution:conflict'));
  await assert.rejects(
    () => journal.resolve({}, { ...request('conflict'), requestBytes: fromUtf8('different-request') }, driverFor(EffectRecoveryClass.pure, 'resolution:conflict')),
    { code: 'ERR_EFFECT_IDEMPOTENCY_CONFLICT' },
  );
}

async function provesCommittedHeadReconcilesSubmittedEffects() {
  const store = new MemoryStore();
  const journal = new EffectJournal({ store, runId: 'run-hi', branchId: 'main', parentTurnClosureFingerprint: 'turn:parent' });
  const driver = driverFor(EffectRecoveryClass.idempotent, 'resolution:hi');
  const resolved = await journal.resolve({}, request('hi'), driver);
  const submitted = await journal.markSubmitted(resolved.record);

  const recovery = await journal.reconcileCommittedHead({
    generation: 1,
    updateDiagnostics: { parentTurnClosureFingerprint: 'turn:parent' },
  });
  const retried = await journal.resolve({}, request('hi'), driver);

  assert.equal(submitted.state, EffectState.submitted, 'H-I crash leaves submitted effect before finalization');
  assert.equal(recovery.committedCount, 1, 'H-I recovery finalizes submitted effect from committed head');
  assert.equal(recovery.committed[0].state, EffectState.closureCommitted);
  assert.equal(retried.reused, true, 'post-recovery retry reuses persisted ResolutionInput');
  assert.equal(driver.calls, 1, 'H-I recovery does not rerun the external driver');
}

async function provesCommittedHeadReconcilesResolvedEffects() {
  const store = new MemoryStore();
  const journal = new EffectJournal({ store, runId: 'run-hi-resolved', branchId: 'main', parentTurnClosureFingerprint: 'turn:parent' });
  const driver = driverFor(EffectRecoveryClass.idempotent, 'resolution:hi-resolved');
  const resolved = await journal.resolve({}, request('hi-resolved'), driver);

  const recovery = await journal.reconcileCommittedHead({
    generation: 1,
    updateDiagnostics: { parentTurnClosureFingerprint: 'turn:parent' },
  });
  const retried = await journal.resolve({}, request('hi-resolved'), driver);

  assert.equal(resolved.record.state, EffectState.resolved, 'H-I crash before submission leaves resolved effect');
  assert.equal(recovery.committedCount, 1, 'H-I recovery finalizes resolved effect from committed head');
  assert.equal(recovery.committed[0].state, EffectState.closureCommitted);
  assert.equal(retried.reused, true, 'post-recovery retry reuses recovered committed ResolutionInput');
  assert.equal(driver.calls, 1, 'H-I resolved recovery does not rerun the external driver');
}

function request(key) {
  return {
    actuatorRef: 'fixture:model',
    descriptorFingerprint: 'descriptor:fixture',
    actuationClass: 'fixture',
    responseSchema: { status: 'ok' },
    idempotencyKeyBytes: fromUtf8(`complete-world-key:${key}`),
    idempotencyKeyWorldFingerprint: `world:key:${key}`,
    requestBytes: fromUtf8(`request:${key}`),
  };
}

function driverFor(recoveryClass, response) {
  return {
    calls: 0,
    manifest() {
      return {
        driverId: `driver:${recoveryClass}`,
        supportedActuatorRefs: ['fixture:model'],
        supportedDescriptorFingerprints: ['descriptor:fixture'],
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
      return { resolutionInputBytes: fromUtf8(`recovered:${recoveryClass}`) };
    },
  };
}
