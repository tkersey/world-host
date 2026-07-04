import { EffectJournal, EffectState, assertResolutionAccepted, journaledHostRequest } from './effect_journal.mjs';
import { assertDriverCanResolve } from './actuator.mjs';
import { assertCapabilityPolicyAllows, createCapabilityPolicy } from './capability_policy.mjs';
import { assertCapabilityResolutionBoundary, defineCapabilityDriver } from './capability_driver.mjs';
import { fail, fromUtf8, stableJson } from './store.mjs';

const FIXTURE_MODEL_AUTHORITY_LABELS = new Set(['model:fixture', 'model:fixture-agent']);

export const CapabilityExecutionMode = Object.freeze({
  fixture: 'fixture',
  dryRun: 'dry-run',
  shadow: 'shadow',
  approval: 'approval',
  live: 'live',
});

export { journaledHostRequest };

export async function runCapabilityMode({
  mode,
  driver: driverLike,
  context = {},
  hostRequest,
  recordedResolution = null,
  journalOptions = null,
  policy = {},
  approval = null,
}) {
  if (!Object.values(CapabilityExecutionMode).includes(mode)) fail('ERR_CAPABILITY_MODE_INVALID');
  const driver = defineCapabilityDriver(driverLike);
  const manifest = driver.manifest();
  const livePolicy = createCapabilityPolicy(policy);
  if (mode === CapabilityExecutionMode.fixture) {
    assertManifestCoversHostRequest(manifest, hostRequest);
    assertFixtureModeAllowed(manifest, hostRequest);
    assertLocalCapabilityPolicyAllows(manifest, hostRequest, livePolicy, 'fixture');
    assertCapabilityPreflightAccepted(await driver.preflight(context, hostRequest));
    const resolved = await driver.resolve(context, hostRequest);
    assertCapabilityResolutionBoundary(resolved);
    assertResolutionAccepted(resolved.resolutionInputBytes, hostRequest, manifest, livePolicy);
    return { ...resolved, mode, submittedToWorld: true };
  }
  if (mode === CapabilityExecutionMode.dryRun) {
    assertManifestCoversHostRequest(manifest, hostRequest);
    assertLocalCapabilityPolicyAllows(manifest, hostRequest, livePolicy, 'dry-run');
    return { mode, submittedToWorld: false, dryRun: await driver.dryRun(context, hostRequest) };
  }
  if (mode === CapabilityExecutionMode.shadow) {
    assertManifestCoversHostRequest(manifest, hostRequest);
    const shadowContext = { ...context, mode: 'shadow', policy: livePolicy };
    if (shadowRequiresLivePolicy(manifest, hostRequest)) {
      if (context?.allowShadowNetwork !== true && context?.allowShadowLiveEffects !== true) {
        fail('ERR_CAPABILITY_SHADOW_LIVE_EFFECT_DENIED', 'shadow mode live-capable drivers require explicit shadow live policy');
      }
      assertCapabilityPolicyAllows({
        manifest,
        hostRequest: networkPolicyHostRequest(hostRequest, manifest),
        policy: livePolicy,
        mode: 'live',
        enforceNetworkTarget: shouldEnforceNetworkTarget(hostRequest, manifest),
      });
      assertCapabilityPreflightAccepted(await driver.preflight(shadowContext, hostRequest));
    } else {
      assertLocalCapabilityPolicyAllows(manifest, hostRequest, livePolicy, 'shadow');
    }
    return { mode, submittedToWorld: false, shadow: await driver.shadow(shadowContext, hostRequest, recordedResolution) };
  }
  if (mode === CapabilityExecutionMode.approval) {
    assertManifestCoversHostRequest(manifest, hostRequest);
    assertLocalCapabilityPolicyAllows(manifest, hostRequest, livePolicy, 'approval');
    const proposed = await driver.dryRun(context, hostRequest);
    const decision = await approvalDecision(approval, { manifest, hostRequest, proposed });
    if (decision.approved !== true) return { mode, submittedToWorld: false, approved: false, proposed };
    if (isEffectFreeFixture(manifest) && !journalOptions) {
      assertFixtureModeAllowed(manifest, hostRequest);
      assertCapabilityPreflightAccepted(await driver.preflight(context, hostRequest));
      const resolved = await driver.resolve(context, hostRequest);
      assertCapabilityResolutionBoundary(resolved);
      assertResolutionAccepted(resolved.resolutionInputBytes, hostRequest, manifest, livePolicy);
      return { ...resolved, mode, submittedToWorld: true, approved: true, proposed };
    }
    assertCapabilityPolicyAllows({
      manifest,
      hostRequest: networkPolicyHostRequest(hostRequest, manifest),
      policy: livePolicy,
      mode: 'live',
      action: { approved: true },
      enforceNetworkTarget: shouldEnforceNetworkTarget(hostRequest, manifest),
      checkLiveModelBudget: false,
    });
    if (!journalOptions) fail('ERR_CAPABILITY_APPROVAL_JOURNAL_REQUIRED', 'approval mode live effects require EffectJournal options');
    const journal = journalOptions instanceof EffectJournal ? journalOptions : new EffectJournal({ ...journalOptions, policy: livePolicy });
    const approvedContext = liveContext(context, livePolicy, { approved: true });
    const journalHostRequest = journaledHostRequest(hostRequest, manifest);
    const resolved = await journal.resolve(approvedContext, journalHostRequest, driver, {
      beforeInvoke: async (preflightContext, preflightHostRequest) => {
        assertCapabilityPolicyAllows({
          manifest,
          hostRequest: networkPolicyHostRequest(preflightHostRequest, manifest),
          policy: livePolicy,
          mode: 'live',
          action: { approved: true },
          enforceNetworkTarget: shouldEnforceNetworkTarget(preflightHostRequest, manifest),
        });
        assertCapabilityPreflightAccepted(await driver.preflight(preflightContext, preflightHostRequest));
      },
    });
    return { ...resolved, mode, submittedToWorld: submittedResolutionToWorld(resolved), approved: true, proposed };
  }
  assertCapabilityPolicyAllows({
    manifest,
    hostRequest: networkPolicyHostRequest(hostRequest, manifest),
    policy: livePolicy,
    mode: 'live',
    enforceNetworkTarget: shouldEnforceNetworkTarget(hostRequest, manifest),
    checkLiveModelBudget: false,
  });
  if (!journalOptions) fail('ERR_CAPABILITY_LIVE_JOURNAL_REQUIRED', 'live mode requires EffectJournal options');
  const journal = journalOptions instanceof EffectJournal ? journalOptions : new EffectJournal({ ...journalOptions, policy: livePolicy });
  const liveDriverContext = liveContext(context, livePolicy);
  const journalHostRequest = journaledHostRequest(hostRequest, manifest);
  const resolved = await journal.resolve(liveDriverContext, journalHostRequest, driver, {
    beforeInvoke: async (preflightContext, preflightHostRequest) => {
      assertCapabilityPolicyAllows({
        manifest,
        hostRequest: networkPolicyHostRequest(preflightHostRequest, manifest),
        policy: livePolicy,
        mode: 'live',
        enforceNetworkTarget: shouldEnforceNetworkTarget(preflightHostRequest, manifest),
      });
      assertCapabilityPreflightAccepted(await driver.preflight(preflightContext, preflightHostRequest));
    },
  });
  return { ...resolved, mode, submittedToWorld: submittedResolutionToWorld(resolved) };
}

function liveContext(context, policy, action = null) {
  return { ...context, mode: 'live', policy, action };
}

function assertLocalCapabilityPolicyAllows(manifest, hostRequest, policy, mode) {
  const localPolicy = createCapabilityPolicy(policy);
  assertCapabilityPolicyAllows({
    manifest,
    hostRequest: networkPolicyHostRequest(hostRequest, manifest),
    policy: localPolicy,
    mode,
    enforceNetworkTarget: shouldEnforceNetworkTarget(hostRequest, manifest),
    requireEffectOptIn: false,
    checkNetworkTarget: localPolicy.allowedOrigins.size > 0 || localPolicy.allowedMethods.size > 0,
    checkFileRoot: mode !== 'dry-run' || localPolicy.allowedFileRoots.size > 0,
    checkRecoveryClass: mode !== 'dry-run',
    enforceApprovalRequirements: false,
  });
}

function submittedResolutionToWorld(resolved) {
  return resolved?.record?.state === EffectState.submitted || resolved?.record?.state === EffectState.closureCommitted;
}

function shadowRequiresLivePolicy(manifest, hostRequest) {
  const labels = manifest?.authorityLabels ?? [];
  return ['http', 'file', 'human'].includes(hostRequest?.actuationClass) ||
    (manifest?.supportedActuationClasses ?? []).some((item) => ['http', 'file', 'human'].includes(item)) ||
    labels.some((label) => label.startsWith('network:') || label.startsWith('file:') || label.startsWith('human:')) ||
    isLiveModelCall(manifest, hostRequest);
}

function isLiveModelCall(manifest, hostRequest) {
  const modelLabels = (manifest?.authorityLabels ?? []).filter((label) => label.startsWith('model:'));
  const liveModelLabels = modelLabels.filter((label) => !fixtureModelLabel(label));
  const modelCapable = hostRequest?.actuationClass === 'model' ||
    (manifest?.supportedActuationClasses ?? []).includes('model') ||
    liveModelLabels.length > 0;
  if (!modelCapable) return false;
  if (!liveModelLabels.length && hasDeterministicFixtureModelAuthority(manifest, modelLabels)) return false;
  return true;
}

function hasDeterministicFixtureModelAuthority(manifest, modelLabels = (manifest?.authorityLabels ?? []).filter((label) => label.startsWith('model:'))) {
  if (manifest?.diagnostics?.deterministic !== true) return false;
  return modelLabels.length > 0 && modelLabels.every(fixtureModelLabel);
}

function fixtureModelLabel(label) {
  return FIXTURE_MODEL_AUTHORITY_LABELS.has(label);
}

function assertManifestCoversHostRequest(manifest, hostRequest) {
  assertDriverCanResolve(manifest, hostRequest);
  return true;
}

export function assertCapabilityPreflightAccepted(report) {
  if (report.accepted !== true) fail('ERR_CAPABILITY_PREFLIGHT_BLOCKED', 'capability preflight blocked', { blockers: report.blockers });
  return true;
}

function shouldEnforceNetworkTarget(hostRequest, manifest) {
  if (manifest?.diagnostics?.endpointSource === 'config') return true;
  if (!hostRequest?.requestBytes) return true;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(hostRequest.requestBytes));
    if (manifest?.diagnostics?.endpointSource === 'request-or-config' && parsed?.url === undefined) return true;
    return true;
  } catch {
    return true;
  }
}

export function networkPolicyHostRequest(hostRequest, manifest) {
  const endpointSource = manifest?.diagnostics?.endpointSource;
  if (!hostRequest?.requestBytes) {
    return endpointSource === 'config' || endpointSource === 'request-or-config'
      ? configuredNetworkPolicyHostRequest(hostRequest, manifest)
      : hostRequest;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(hostRequest.requestBytes));
    if (endpointSource === 'config' || (endpointSource === 'request-or-config' && parsed?.url === undefined)) {
      return configuredNetworkPolicyHostRequest(hostRequest, manifest, parsed);
    }
    if (parsed?.url === undefined || parsed.method !== undefined) return hostRequest;
    const methods = Array.isArray(manifest?.diagnostics?.methods) ? manifest.diagnostics.methods : [];
    const method = manifest?.diagnostics?.defaultMethod ?? (methods.length === 1 ? methods[0] : 'GET');
    return { ...hostRequest, requestBytes: fromUtf8(stableJson({ ...parsed, method })) };
  } catch {
    return hostRequest;
  }
}

function configuredNetworkPolicyHostRequest(hostRequest, manifest, parsed = {}) {
  const origins = Array.isArray(manifest?.diagnostics?.origins) ? manifest.diagnostics.origins : [];
  const methods = Array.isArray(manifest?.diagnostics?.methods) ? manifest.diagnostics.methods : [];
  const endpointSource = manifest?.diagnostics?.endpointSource;
  const requestUrl = endpointSource === 'request-or-config' && parsed?.url !== undefined ? parsed.url : null;
  const url = requestUrl ?? manifest?.diagnostics?.configuredEndpointUrl ?? manifest?.diagnostics?.configuredOrigin ?? (origins.length === 1 ? origins[0] : null);
  const method = parsed.method ?? manifest?.diagnostics?.defaultMethod ?? (methods.length === 1 ? methods[0] : null);
  if (!url || !method) return hostRequest;
  return {
    ...hostRequest,
    policyRequestBytes: hostRequest?.requestBytes,
    requestBytes: fromUtf8(stableJson({ url, method })),
  };
}

function assertFixtureModeAllowed(manifest, hostRequest) {
  if (manifest.diagnostics?.deterministic !== true) fail('ERR_CAPABILITY_FIXTURE_REQUIRES_DETERMINISTIC_DRIVER');
  const liveActuationClasses = new Set(['http', 'file', 'human']);
  const manifestLiveActuationClasses = (manifest.supportedActuationClasses ?? []).filter((item) => liveActuationClasses.has(item));
  const requestedLiveActuationClasses = liveActuationClasses.has(hostRequest?.actuationClass) ? [hostRequest.actuationClass] : [];
  const liveModelActuationClasses = isLiveModelCall(manifest, hostRequest) ? ['model'] : [];
  const liveAuthorityLabels = (manifest.authorityLabels ?? []).filter((label) => (
    label.startsWith('network:') ||
    label.startsWith('file:') ||
    label.startsWith('human:') ||
    (label.startsWith('model:') && !label.startsWith('model:fixture'))
  ));
  if (manifestLiveActuationClasses.length || requestedLiveActuationClasses.length || liveModelActuationClasses.length || liveAuthorityLabels.length) {
    fail('ERR_CAPABILITY_FIXTURE_LIVE_EFFECT_DENIED', 'fixture mode cannot invoke live-effect authority', {
      actuationClasses: [...new Set([...manifestLiveActuationClasses, ...requestedLiveActuationClasses, ...liveModelActuationClasses])],
      labels: liveAuthorityLabels,
    });
  }
}

function isEffectFreeFixture(manifest) {
  return manifest.driverId === 'fixture-agent-model' && manifest.diagnostics?.deterministic === true;
}

async function approvalDecision(approval, proposal) {
  if (typeof approval === 'function') return await approval(proposal);
  if (approval && typeof approval.approve === 'function') return await approval.approve(proposal);
  return { approved: false, reason: 'approval-provider-missing' };
}
