import { EffectRecoveryClass } from '../core/actuator.mjs';
import { fail, fromUtf8 } from '../core/store.mjs';
import { encodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';

export class FixtureModelDriver {
  constructor({ responses = [], actuatorRef = 'fixture:model', descriptorFingerprint = 'descriptor:fixture-model' } = {}) {
    this.responses = [...responses];
    this.index = 0;
    this.actuatorRef = actuatorRef;
    this.descriptorFingerprint = descriptorFingerprint;
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
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return { resolutionInputBytes: resolutionInput(hostRequest, response instanceof Uint8Array ? response : fromUtf8(String(response))) };
  }

  async recover(context, effectRecord) {
    if (!effectRecord.resolutionInputRef) return await this.resolve(context, effectRecord);
    fail('ERR_FIXTURE_RECOVERY_SHOULD_REUSE_PERSISTED_OUTCOME');
  }
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
