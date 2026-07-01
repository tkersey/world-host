import { EffectJournal } from '../../src/core/effect_journal.mjs';
import { fromUtf8 } from '../../src/core/store.mjs';
import { encodeResolutionInputBytes } from '../../src/protocol/world_appliance_wire_codec.mjs';
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
    hostRequestFingerprint: 'world:host-request:0000000000000c01',
  };
  const first = await journal.resolve({}, request, driver);
  const retry = await journal.resolve({}, request, driver);
  return {
    example: 'crash-recovery',
    persistedOutcomeReused: retry.reused,
    driverInvocations: driver.calls,
    sameResolutionBytes: sameBytes(first.resolutionInputBytes, retry.resolutionInputBytes),
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
    async resolve(_context, hostRequest) {
      this.calls += 1;
      return { resolutionInputBytes: resolutionInputBytes(hostRequest, fromUtf8('resolution')) };
    },
  };
}

function resolutionInputBytes(hostRequest, responseValueImageBytes) {
  return encodeResolutionInputBytes({
    targetHostRequestFingerprint: requestTargetFingerprint(hostRequest),
    status: 0,
    responseValueImageBytes,
    hostClaimBytes: new Uint8Array(),
    attemptNumber: 1,
    metadata: new Uint8Array(),
  });
}

function requestTargetFingerprint(hostRequest) {
  const match = String(hostRequest.hostRequestFingerprint ?? '').match(/(?:0x)?([0-9a-f]+)$/i);
  return BigInt(`0x${match[1]}`);
}

function sameBytes(left, right) {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
