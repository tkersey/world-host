import { EffectRecoveryClass } from '../core/actuator.mjs';
import { fail, fromUtf8 } from '../core/store.mjs';
import { encodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';
import { encodeCanonicalValueImage } from '../protocol/world_loaded_value_codec.mjs';

export class FixtureModelDriver {
  constructor({ responses = [], actuatorRef = 'fixture:model', descriptorFingerprint = 'descriptor:fixture-model' } = {}) {
    this.responses = [...responses];
    this.index = 0;
    this.actuatorRef = actuatorRef;
    this.descriptorFingerprint = descriptorFingerprint;
    this.responsesByKey = new Map();
  }

  manifest() {
    return {
      driverId: 'fixture-model',
      supportedActuatorRefs: [this.actuatorRef],
      supportedDescriptorFingerprints: [this.descriptorFingerprint],
      supportedActuationClasses: ['model', 'fixture'],
      supportedResponseStatuses: ['ok', 'final'],
      maximumRequestBytes: 1024 * 1024,
      maximumResponseBytes: 1024 * 1024,
      recoveryClass: EffectRecoveryClass.pure,
      concurrencyLimit: 4,
      authorityLabels: ['model:fixture'],
      diagnostics: { deterministic: true },
    };
  }

  async resolve(context, hostRequest) {
    if (!this.responses.length) fail('ERR_FIXTURE_MODEL_RESPONSE_MISSING');
    const responseValueImageBytes = this.#responseFor(hostRequest);
    return { resolutionInputBytes: resolutionInput(hostRequest, responseValueImageBytes) };
  }

  async recover(context, effectRecord) {
    if (!effectRecord.resolutionInputRef) return await this.resolve(context, effectRecord);
    fail('ERR_FIXTURE_RECOVERY_SHOULD_REUSE_PERSISTED_OUTCOME');
  }

  #responseFor(hostRequest) {
    const key = fixtureResponseKey(hostRequest);
    if (key && this.responsesByKey.has(key)) return new Uint8Array(this.responsesByKey.get(key));
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    const bytes = response instanceof Uint8Array
      ? new Uint8Array(response)
      : encodeCanonicalValueImage({ bytes: fromUtf8(String(response)), dynamicSize: true });
    if (key) this.responsesByKey.set(key, new Uint8Array(bytes));
    return bytes;
  }
}

function fixtureResponseKey(hostRequest = {}) {
  return hostRequest.idempotencyKeyWorldFingerprint ?? hostRequest.hostRequestFingerprint ?? null;
}

function resolutionInput(hostRequest, responseValueImageBytes, status = 0) {
  return encodeResolutionInputBytes({
    targetHostRequestFingerprint: resolutionTarget(hostRequest),
    status,
    responseValueImageBytes,
    hostClaimBytes: new Uint8Array(),
    attemptNumber: 1,
    metadata: fromUtf8('fixture-model'),
  });
}

function resolutionTarget(hostRequest = {}) {
  const value = hostRequest.hostRequestFingerprint;
  if (value === undefined) return 0n;
  if (typeof value === 'bigint' || typeof value === 'number') return BigInt(value);
  const match = String(value).match(/(?:0x)?([0-9a-f]+)$/i);
  if (!match) fail('ERR_HOST_REQUEST_FINGERPRINT_REQUIRED');
  return BigInt(`0x${match[1]}`);
}
