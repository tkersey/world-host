import { EffectJournal } from './effect_journal.mjs';
import { assertCapabilityPolicyAllows, createCapabilityPolicy } from './capability_policy.mjs';
import { assertCapabilityResolutionBoundary, defineCapabilityDriver } from './capability_driver.mjs';
import { fail } from './store.mjs';

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
  if (mode === CapabilityExecutionMode.fixture && manifest.diagnostics?.deterministic !== true) fail('ERR_CAPABILITY_FIXTURE_REQUIRES_DETERMINISTIC_DRIVER');
  if (mode === CapabilityExecutionMode.dryRun) {
    return { mode, submittedToWorld: false, dryRun: await driver.dryRun(context, hostRequest) };
  }
  if (mode === CapabilityExecutionMode.shadow) {
    return { mode, submittedToWorld: false, shadow: await driver.shadow(context, hostRequest, recordedResolution) };
  }
  if (mode === CapabilityExecutionMode.approval) {
    const proposed = await driver.resolve(context, hostRequest);
    assertCapabilityResolutionBoundary(proposed);
    const decision = await approvalDecision(approval, { manifest, hostRequest, proposed });
    if (decision.approved !== true) return { mode, submittedToWorld: false, approved: false, proposed };
    return { mode, submittedToWorld: true, approved: true, resolutionInputBytes: proposed.resolutionInputBytes, proposed };
  }
  assertCapabilityPolicyAllows({ manifest, hostRequest, policy: livePolicy, mode: 'live' });
  if (!journalOptions) fail('ERR_CAPABILITY_LIVE_JOURNAL_REQUIRED', 'live mode requires EffectJournal options');
  const journal = journalOptions instanceof EffectJournal ? journalOptions : new EffectJournal({ ...journalOptions, policy: livePolicy });
  const resolved = await journal.resolve(context, hostRequest, driver);
  return { mode, submittedToWorld: true, ...resolved };
}

async function approvalDecision(approval, proposal) {
  if (typeof approval === 'function') return await approval(proposal);
  if (approval && typeof approval.approve === 'function') return await approval.approve(proposal);
  return { approved: false, reason: 'approval-provider-missing' };
}
