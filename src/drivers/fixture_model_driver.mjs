import { EffectRecoveryClass } from '../core/actuator.mjs';
import { fail, fromUtf8 } from '../core/store.mjs';

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

  async resolve() {
    if (!this.responses.length) fail('ERR_FIXTURE_MODEL_RESPONSE_MISSING');
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    return { resolutionInputBytes: response instanceof Uint8Array ? response : fromUtf8(String(response)) };
  }

  async recover(context, effectRecord) {
    if (!effectRecord.resolutionInputRef) return await this.resolve(context, {});
    fail('ERR_FIXTURE_RECOVERY_SHOULD_REUSE_PERSISTED_OUTCOME');
  }
}
