import { EffectJournal } from '../../src/core/effect_journal.mjs';
import { fromUtf8 } from '../../src/core/store.mjs';
import { MemoryStore } from '../../src/stores/memory_store.mjs';

export async function runExample() {
  const store = new MemoryStore();
  const journal = new EffectJournal({ store, runId: 'crash-run', branchId: 'main', parentTurnClosureFingerprint: 'world:closure:0' });
  const driver = idempotentDriver();
  const request = {
    actuatorRef: 'fixture:model',
    descriptorFingerprint: 'descriptor:fixture',
    actuationClass: 'fixture',
    responseSchema: { status: 'ok' },
    idempotencyKeyBytes: fromUtf8('same-full-world-key'),
    idempotencyKeyWorldFingerprint: 'world:key:same',
    requestBytes: fromUtf8('request'),
  };
  const first = await journal.resolve({}, request, driver);
  const retry = await journal.resolve({}, request, driver);
  return {
    example: 'crash-recovery',
    persistedOutcomeReused: retry.reused,
    driverInvocations: driver.calls,
    sameResolutionBytes: new TextDecoder().decode(first.resolutionInputBytes) === new TextDecoder().decode(retry.resolutionInputBytes),
  };
}

function idempotentDriver() {
  return {
    calls: 0,
    manifest() {
      return {
        driverId: 'example-idempotent',
        supportedActuatorRefs: ['fixture:model'],
        supportedDescriptorFingerprints: ['descriptor:fixture'],
        supportedActuationClasses: ['fixture'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024,
        maximumResponseBytes: 1024,
        recoveryClass: 'idempotent',
        concurrencyLimit: 1,
        authorityLabels: ['fixture'],
      };
    },
    async resolve() {
      this.calls += 1;
      return { resolutionInputBytes: fromUtf8('resolution') };
    },
  };
}
