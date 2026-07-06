import { EffectRecoveryClass } from '../core/actuator.mjs';
import { DryRunReport, ShadowReport, capabilityHostClaimBytes, defaultCapabilityPreflight } from '../core/capability_driver.mjs';
import { hostRequestTargetFingerprint } from '../core/effect_journal.mjs';
import { assertCapabilityPolicyAllows, redactCapabilityDiagnostics } from '../core/capability_policy.mjs';
import { fail, fromUtf8, stableJson } from '../core/store.mjs';
import { encodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';
import { encodeCanonicalValueImage } from '../protocol/world_loaded_value_codec.mjs';

export class HumanApprovalCapabilityDriver {
  constructor({ mode = 'noninteractive-deny', prompt = null, packFingerprint = null } = {}) {
    this.mode = mode;
    this.prompt = prompt;
    this.packFingerprint = packFingerprint;
  }

  manifest() {
    return {
      driverId: 'human-approval',
      ...(this.packFingerprint ? { packFingerprint: this.packFingerprint } : {}),
      supportedActuatorRefs: ['human:approval'],
      supportedDescriptorFingerprints: ['descriptor:human-approval'],
      supportedActuationClasses: ['human'],
      supportedResponseStatuses: humanApprovalResponseStatuses(this.mode),
      maximumRequestBytes: 64 * 1024,
      maximumResponseBytes: 64 * 1024,
      recoveryClass: EffectRecoveryClass.transactional,
      concurrencyLimit: 1,
      authorityLabels: ['human:approval'],
      diagnostics: { mode: this.mode, cryptographicAttestation: false },
    };
  }

  preflight(context, hostRequest) {
    const structural = defaultCapabilityPreflight(this.manifest(), hostRequest);
    const blockers = [...structural.blockers];
    if (!blockers.length) {
      try {
        assertHumanApprovalModeReady(this.mode, this.prompt);
        assertHumanPolicyAllows(context, this.manifest(), hostRequest);
        assertFixedModeSupportsResponseSchema(this.mode, hostRequest);
      } catch (error) {
        blockers.push(error.code ?? 'ERR_HUMAN_APPROVAL_PREFLIGHT_REJECTED');
      }
    }
    return { accepted: blockers.length === 0, blockers };
  }

  dryRun(context, hostRequest) {
    assertHumanPromptPolicyAllows(context, this.manifest(), hostRequest);
    return new DryRunReport({
      wouldInvoke: this.mode === 'interactive-terminal',
      proposedAction: { approval: this.#redactedPrompt(hostRequest) },
      diagnostics: { mode: this.mode },
    });
  }

  shadow(context, hostRequest, recordedResolution) {
    return new ShadowReport({ liveInvoked: false, schemaAccepted: Boolean(recordedResolution) });
  }

  async approve({ proposed }) {
    assertHumanApprovalModeReady(this.mode, this.prompt);
    if (this.mode === 'noninteractive-allow') return { approved: true, record: this.#record('approved') };
    if (this.mode === 'noninteractive-deny') return { approved: false, record: this.#record('denied') };
    const approved = await this.prompt({ proposed }) === true;
    return { approved, record: this.#record(approved ? 'approved' : 'denied') };
  }

  async resolve(context, hostRequest) {
    assertHumanApprovalModeReady(this.mode, this.prompt);
    assertHumanPolicyAllows(context, this.manifest(), hostRequest);
    assertFixedModeSupportsResponseSchema(this.mode, hostRequest);
    resolutionTarget(hostRequest);
    const decision = await this.approve({ proposed: this.#redactedPrompt(hostRequest) });
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

function assertHumanPolicyAllows(context, manifest, hostRequest) {
  assertCapabilityPolicyAllows({
    manifest,
    hostRequest: humanPolicyHostRequest(hostRequest),
    policy: context?.policy ?? {},
    mode: 'live',
  });
}

function assertHumanPromptPolicyAllows(context, manifest, hostRequest) {
  assertCapabilityPolicyAllows({
    manifest,
    hostRequest: humanPolicyHostRequest(hostRequest),
    policy: context?.policy ?? {},
    mode: 'dry-run',
    requireEffectOptIn: false,
    checkNetworkTarget: false,
    checkFileRoot: false,
    checkRecoveryClass: false,
    enforceApprovalRequirements: false,
  });
}

function humanPolicyHostRequest(hostRequest) {
  return hostRequest && hostRequest.policyRequestBytes === undefined
    ? { ...hostRequest, policyRequestBytes: hostRequest.requestBytes }
    : hostRequest;
}

function assertHumanApprovalModeReady(mode, prompt) {
  if (mode !== 'noninteractive-allow' && mode !== 'noninteractive-deny' && mode !== 'interactive-terminal') {
    fail('ERR_HUMAN_APPROVAL_MODE_UNSUPPORTED', 'unsupported human approval mode');
  }
  if (mode === 'interactive-terminal' && typeof prompt !== 'function') {
    fail('ERR_HUMAN_APPROVAL_PROMPT_REQUIRED', 'interactive human approval requires a prompt');
  }
}

function humanApprovalResponseStatuses(mode) {
  if (mode === 'noninteractive-allow') return ['ok'];
  if (mode === 'noninteractive-deny') return ['rejected'];
  return ['ok', 'rejected'];
}

function resolutionTarget(hostRequest = {}) {
  return hostRequestTargetFingerprint(hostRequest);
}

function assertFixedModeSupportsResponseSchema(mode, hostRequest = {}) {
  const status = hostRequest.responseSchema?.status;
  if (!status || mode === 'interactive-terminal') return;
  if (mode === 'noninteractive-allow' && status !== 'ok') {
    fail('ERR_HUMAN_APPROVAL_RESPONSE_SCHEMA_UNSUPPORTED', 'noninteractive allow can only emit ok approvals');
  }
  if (mode === 'noninteractive-deny' && status !== 'rejected') {
    fail('ERR_HUMAN_APPROVAL_RESPONSE_SCHEMA_UNSUPPORTED', 'noninteractive deny can only emit rejected approvals');
  }
}
