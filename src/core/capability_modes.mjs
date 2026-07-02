import { EffectJournal } from './effect_journal.mjs';
import { assertCapabilityPolicyAllows, createCapabilityPolicy } from './capability_policy.mjs';
import { assertCapabilityResolutionBoundary, defineCapabilityDriver } from './capability_driver.mjs';
import { fail, fromUtf8, stableJson } from './store.mjs';

export const CapabilityExecutionMode = Object.freeze({
  fixture: 'fixture',
  dryRun: 'dry-run',
  shadow: 'shadow',
  approval: 'approval',
  live: 'live',
});

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
    assertFixtureModeAllowed(manifest);
    assertCapabilityPreflightAccepted(driver.preflight(context, hostRequest));
    const resolved = await driver.resolve(context, hostRequest);
    assertCapabilityResolutionBoundary(resolved);
    return { mode, submittedToWorld: true, ...resolved };
  }
  if (mode === CapabilityExecutionMode.dryRun) {
    return { mode, submittedToWorld: false, dryRun: await driver.dryRun(context, hostRequest) };
  }
  if (mode === CapabilityExecutionMode.shadow) {
    const shadowContext = { ...context, mode: 'shadow', policy: livePolicy };
    if (context?.allowShadowNetwork === true || context?.allowShadowLiveEffects === true) {
      assertCapabilityPolicyAllows({
        manifest,
        hostRequest: networkPolicyHostRequest(hostRequest, manifest),
        policy: livePolicy,
        mode: 'live',
        enforceNetworkTarget: shouldEnforceNetworkTarget(hostRequest, manifest),
      });
      assertCapabilityPreflightAccepted(driver.preflight(shadowContext, hostRequest));
    }
    return { mode, submittedToWorld: false, shadow: await driver.shadow(shadowContext, hostRequest, recordedResolution) };
  }
  if (mode === CapabilityExecutionMode.approval) {
    const proposed = await driver.dryRun(context, hostRequest);
    const decision = await approvalDecision(approval, { manifest, hostRequest, proposed });
    if (decision.approved !== true) return { mode, submittedToWorld: false, approved: false, proposed };
    if (isEffectFreeFixture(manifest) && !journalOptions) {
      assertCapabilityPreflightAccepted(driver.preflight(context, hostRequest));
      const resolved = await driver.resolve(context, hostRequest);
      assertCapabilityResolutionBoundary(resolved);
      return { mode, submittedToWorld: true, approved: true, proposed, ...resolved };
    }
    assertCapabilityPolicyAllows({
      manifest,
      hostRequest: networkPolicyHostRequest(hostRequest, manifest),
      policy: livePolicy,
      mode: 'live',
      action: { approved: true },
      enforceNetworkTarget: shouldEnforceNetworkTarget(hostRequest, manifest),
    });
    if (!journalOptions) fail('ERR_CAPABILITY_APPROVAL_JOURNAL_REQUIRED', 'approval mode live effects require EffectJournal options');
    const journal = journalOptions instanceof EffectJournal ? journalOptions : new EffectJournal({ ...journalOptions, policy: livePolicy });
    const approvedContext = liveContext(context, livePolicy, { approved: true });
    const resolved = await journal.resolve(approvedContext, hostRequest, driver, {
      beforeInvoke: (preflightContext, preflightHostRequest) => {
        assertCapabilityPreflightAccepted(driver.preflight(preflightContext, preflightHostRequest));
      },
    });
    return { mode, submittedToWorld: true, approved: true, proposed, ...resolved };
  }
  assertCapabilityPolicyAllows({
    manifest,
    hostRequest: networkPolicyHostRequest(hostRequest, manifest),
    policy: livePolicy,
    mode: 'live',
    enforceNetworkTarget: shouldEnforceNetworkTarget(hostRequest, manifest),
  });
  if (!journalOptions) fail('ERR_CAPABILITY_LIVE_JOURNAL_REQUIRED', 'live mode requires EffectJournal options');
  const journal = journalOptions instanceof EffectJournal ? journalOptions : new EffectJournal({ ...journalOptions, policy: livePolicy });
  const liveDriverContext = liveContext(context, livePolicy);
  const resolved = await journal.resolve(liveDriverContext, hostRequest, driver, {
    beforeInvoke: (preflightContext, preflightHostRequest) => {
      assertCapabilityPreflightAccepted(driver.preflight(preflightContext, preflightHostRequest));
    },
  });
  return { mode, submittedToWorld: true, ...resolved };
}

function liveContext(context, policy, action = null) {
  return { ...context, mode: 'live', policy, action };
}

function assertCapabilityPreflightAccepted(report) {
  if (report.accepted !== true) fail('ERR_CAPABILITY_PREFLIGHT_BLOCKED', 'capability preflight blocked', { blockers: report.blockers });
  return true;
}

function shouldEnforceNetworkTarget(hostRequest, manifest) {
  if (manifest?.diagnostics?.endpointSource === 'config') return false;
  if (!hostRequest?.requestBytes) return true;
  try {
    return JSON.parse(new TextDecoder().decode(hostRequest.requestBytes))?.url !== undefined;
  } catch {
    return true;
  }
}

function networkPolicyHostRequest(hostRequest, manifest) {
  if (manifest?.diagnostics?.endpointSource === 'config' || !hostRequest?.requestBytes) return hostRequest;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(hostRequest.requestBytes));
    if (parsed?.url === undefined || parsed.method !== undefined) return hostRequest;
    const methods = Array.isArray(manifest?.diagnostics?.methods) ? manifest.diagnostics.methods : [];
    if (methods.length !== 1) return hostRequest;
    return { ...hostRequest, requestBytes: fromUtf8(stableJson({ ...parsed, method: methods[0] })) };
  } catch {
    return hostRequest;
  }
}

function assertFixtureModeAllowed(manifest) {
  if (manifest.diagnostics?.deterministic !== true) fail('ERR_CAPABILITY_FIXTURE_REQUIRES_DETERMINISTIC_DRIVER');
  const liveAuthorityLabels = (manifest.authorityLabels ?? []).filter((label) => (
    label.startsWith('network:') ||
    label.startsWith('file:') ||
    label.startsWith('human:')
  ));
  if (liveAuthorityLabels.length) {
    fail('ERR_CAPABILITY_FIXTURE_LIVE_EFFECT_DENIED', 'fixture mode cannot invoke live-effect authority labels', { labels: liveAuthorityLabels });
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
