import { EffectRecoveryClass, assertDriverCanResolve, assertDriverManifest, assertDurableRecoveryAllowed } from './actuator.mjs';
import { fail } from './store.mjs';

export class CapabilityReport {
  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this.blockers);
    Object.freeze(this.warnings);
    Object.freeze(this.coveredRequests);
    Object.freeze(this);
  }
}

export function createRunPolicy(input = {}) {
  return Object.freeze({
    durableAutomatic: input.durableAutomatic !== false,
    allowBestEffort: input.allowBestEffort === true,
    allowedAuthorityLabels: new Set(input.allowedAuthorityLabels ?? []),
    allowedFileRoots: new Set(input.allowedFileRoots ?? []),
    allowedHttpOrigins: new Set(input.allowedHttpOrigins ?? []),
    maximumConcurrentEffects: input.maximumConcurrentEffects ?? 1,
    maximumRequestBytes: input.maximumRequestBytes ?? 1024 * 1024,
    maximumResponseBytes: input.maximumResponseBytes ?? 1024 * 1024,
    acceptedSupervisionPolicies: new Set(input.acceptedSupervisionPolicies ?? ['default']),
  });
}

export function createHostCapabilityManifest(input = {}) {
  return Object.freeze({
    runtimeLimits: input.runtimeLimits ?? {},
    drivers: input.drivers ?? [],
    policy: input.policy ?? createRunPolicy(),
    diagnostics: input.diagnostics ?? {},
  });
}

export function preflightCapabilities({ application, applianceManifest = {}, currentHead = null, pendingRequests = [], drivers = [], policy = createRunPolicy() }) {
  const blockers = [];
  const warnings = [];
  const manifests = drivers.map((driver) => assertDriverManifest(driver.manifest()));
  const coveredRequests = [];

  for (const required of application?.requiredActuators ?? []) {
    const covered = manifests.some((manifest) => manifest.supportedActuatorRefs.includes(required.actuatorRef ?? required));
    if (!covered) blockers.push(`required-actuator-uncovered:${required.actuatorRef ?? required}`);
  }

  for (const request of pendingRequests) {
    const route = findDriverManifestForRequest(manifests, request);
    if (!route) {
      blockers.push(`pending-request-uncovered:${request.hostRequestFingerprint ?? request.actuatorRef}`);
      continue;
    }
    try {
      assertDurableRecoveryAllowed(route.recoveryClass, policy);
    } catch (error) {
      blockers.push(error.code);
    }
    const deniedLabels = route.authorityLabels.filter((label) => policy.allowedAuthorityLabels.size && !policy.allowedAuthorityLabels.has(label));
    if (deniedLabels.length) blockers.push(`authority-denied:${deniedLabels.join(',')}`);
    if (request.actuationClass === 'http') {
      const origin = requestOrigin(request);
      if (!origin || policy.allowedHttpOrigins.size && !policy.allowedHttpOrigins.has(origin)) blockers.push(`http-origin-denied:${origin ?? 'unknown'}`);
    }
    coveredRequests.push({ actuatorRef: request.actuatorRef, descriptorFingerprint: request.descriptorFingerprint, driverId: route.driverId });
  }

  const runtimeLimits = application?.requiredRuntimeLimits ?? {};
  if (runtimeLimits.maximumRequestBytes > policy.maximumRequestBytes) blockers.push('runtime-request-limit-exceeds-policy');
  if (runtimeLimits.maximumResponseBytes > policy.maximumResponseBytes) blockers.push('runtime-response-limit-exceeds-policy');
  if (applianceManifest.supervisionPolicy && !policy.acceptedSupervisionPolicies.has(applianceManifest.supervisionPolicy)) blockers.push('supervision-policy-rejected');
  if (!currentHead) warnings.push('current-head-not-provided');

  return new CapabilityReport({
    executableCompatible: blockers.every((item) => !item.startsWith('required-actuator')),
    runtimeCompatible: !blockers.some((item) => item.startsWith('runtime-') || item === 'supervision-policy-rejected'),
    everyRequiredActuatorCovered: !blockers.some((item) => item.startsWith('required-actuator')),
    everyPendingRequestCovered: !blockers.some((item) => item.startsWith('pending-request')),
    responseStatusesSupported: !blockers.some((item) => item.includes('RESPONSE_STATUS')),
    valueSizeLimitsSupported: !blockers.some((item) => item.startsWith('runtime-')),
    recoveryClassSufficient: !blockers.includes('ERR_BEST_EFFORT_REQUIRES_OPERATOR_OPT_IN'),
    fileNetworkAuthoritiesAllowed: !blockers.some((item) => item.startsWith('authority-denied') || item.startsWith('http-origin-denied')),
    supervisionPolicyAccepted: !blockers.includes('supervision-policy-rejected'),
    coveredRequests,
    blockers,
    warnings,
  });
}

export function findDriverManifestForRequest(manifests, request) {
  for (const manifest of manifests) {
    try {
      assertDriverCanResolve(manifest, request);
      return manifest;
    } catch {
      continue;
    }
  }
  return null;
}

export function assertCapabilityReportAccepted(report) {
  if (!(report instanceof CapabilityReport)) fail('ERR_INVALID_CAPABILITY_REPORT');
  if (report.blockers.length) fail('ERR_CAPABILITY_PREFLIGHT_BLOCKED', 'capability preflight blocked', { blockers: report.blockers });
  return true;
}

export { EffectRecoveryClass };

function requestOrigin(request) {
  try {
    const text = new TextDecoder().decode(request.requestBytes);
    const value = JSON.parse(text);
    return new URL(value.url).origin;
  } catch {
    return null;
  }
}
