import { EffectRecoveryClass } from '../core/actuator.mjs';
import { DryRunReport, ShadowReport, capabilityHostClaimBytes, defaultCapabilityPreflight } from '../core/capability_driver.mjs';
import { redactCapabilityDiagnostics } from '../core/capability_policy.mjs';
import { fail, fromUtf8, stableJson } from '../core/store.mjs';
import { encodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';
import { encodeCanonicalValueImage } from '../protocol/world_loaded_value_codec.mjs';

export class HumanApprovalCapabilityDriver {
  constructor({ mode = 'noninteractive-deny', prompt = null } = {}) {
    this.mode = mode;
    this.prompt = prompt;
  }

  manifest() {
    return {
      driverId: 'human-approval',
      supportedActuatorRefs: ['human:approval'],
      supportedDescriptorFingerprints: ['descriptor:human-approval'],
      supportedActuationClasses: ['human'],
      supportedResponseStatuses: ['ok', 'rejected', 'failed'],
      maximumRequestBytes: 64 * 1024,
      maximumResponseBytes: 64 * 1024,
      recoveryClass: EffectRecoveryClass.transactional,
      concurrencyLimit: 1,
      authorityLabels: ['human:approval'],
      diagnostics: { mode: this.mode, cryptographicAttestation: false },
    };
  }

  preflight(context, hostRequest) {
    return defaultCapabilityPreflight(this.manifest(), hostRequest);
  }

  dryRun(context, hostRequest) {
    return new DryRunReport({
      wouldInvoke: this.mode === 'interactive-terminal',
      proposedAction: { approval: this.#redactedPrompt(hostRequest) },
      diagnostics: { mode: this.mode },
    });
  }

  shadow() {
    return new ShadowReport({ liveInvoked: false, schemaAccepted: true });
  }

  async approve({ proposed }) {
    if (this.mode === 'noninteractive-allow') return { approved: true, record: this.#record('approved') };
    if (this.mode === 'noninteractive-deny') return { approved: false, record: this.#record('denied') };
    if (typeof this.prompt !== 'function') fail('ERR_HUMAN_APPROVAL_PROMPT_REQUIRED');
    const approved = await this.prompt({ proposed }) === true;
    return { approved, record: this.#record(approved ? 'approved' : 'denied') };
  }

  async resolve(context, hostRequest) {
    const decision = await this.approve({ proposed: { hostRequest } });
    return this.#resolution(hostRequest, decision.approved ? 'approved' : 'rejected', decision.record);
  }

  async recover(context, effectRecord) {
    return {
      operatorInterventionRequired: true,
      diagnostics: { decision: 'operator_required' },
    };
  }

  #resolution(hostRequest, decision, record) {
    const ok = decision === 'approved';
    return {
      resolutionInputBytes: encodeResolutionInputBytes({
        targetHostRequestFingerprint: resolutionTarget(hostRequest),
        status: ok ? 0 : 1,
        responseValueImageBytes: ok
          ? encodeCanonicalValueImage({ bytes: fromUtf8(stableJson({ decision })), dynamicSize: true })
          : new Uint8Array(),
        hostClaimBytes: capabilityHostClaimBytes(record),
        attemptNumber: 1,
        metadata: fromUtf8(stableJson({ driver: 'human-approval', decision })),
      }),
      hostClaimBytes: capabilityHostClaimBytes(record),
      diagnostics: { decision },
    };
  }

  #record(decision) {
    return {
      kind: 'world-host.human-approval.v0',
      decision,
      cryptographicAttestation: false,
      worldAuthoredEvidence: false,
    };
  }

  #redactedPrompt(hostRequest) {
    try {
      return redactCapabilityDiagnostics(JSON.parse(new TextDecoder().decode(hostRequest.requestBytes)));
    } catch {
      return { bytes: hostRequest.requestBytes?.byteLength ?? 0 };
    }
  }
}

function resolutionTarget(hostRequest = {}) {
  const value = hostRequest.hostRequestFingerprint;
  if (typeof value === 'bigint' || typeof value === 'number') return BigInt(value);
  const match = String(value ?? '').match(/(?:0x|world:host-request:)?([0-9a-f]+)$/i);
  if (!match) fail('ERR_HOST_REQUEST_FINGERPRINT_REQUIRED');
  return BigInt(`0x${match[1]}`);
}
