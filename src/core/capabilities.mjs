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
    allowPartialEffectBatch: input.allowPartialEffectBatch === true,
    allowedAuthorityLabels: new Set(input.allowedAuthorityLabels ?? []),
    allowedFileRoots: new Set(input.allowedFileRoots ?? []),
    allowedHttpOrigins: new Set(input.allowedHttpOrigins ?? []),
    maximumConcurrentEffects: positiveSafeInteger(input.maximumConcurrentEffects ?? 1, 'maximumConcurrentEffects'),
    maximumRequestBytes: positiveSafeInteger(input.maximumRequestBytes ?? 1024 * 1024, 'maximumRequestBytes'),
    maximumResponseBytes: positiveSafeInteger(input.maximumResponseBytes ?? 1024 * 1024, 'maximumResponseBytes'),
    acceptedSupervisionPolicies: new Set(input.acceptedSupervisionPolicies ?? ['default']),
  });
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail('ERR_RUN_POLICY_LIMIT_INVALID', `${field} must be a positive safe integer`);
  return value;
}

export function createHostCapabilityManifest(input = {}) {
  return Object.freeze({
    runtimeLimits: input.runtimeLimits ?? {},
    drivers: input.drivers ?? [],
    policy: input.policy ?? createRunPolicy(),
    diagnostics: input.diagnostics ?? {},
  });
}

export function preflightCapabilities({ application, applianceManifest = {}, currentHead = null, pendingRequests = [], drivers = [], policy: policyInput = createRunPolicy() }) {
  const policy = createRunPolicy(policyInput);
  const blockers = [];
  const warnings = [];
  const manifests = drivers.map((driver) => assertDriverManifest(driver.manifest()));
  const coveredRequests = [];
  const selectedRequiredActuatorRoutes = [];
  const selectedPendingRequestRoutes = [];
  const hasPendingRequestContext = pendingRequests.length > 0;

  for (const required of application?.requiredActuators ?? []) {
    const requirement = normalizeRequiredActuator(required);
    const route = findRequiredActuatorManifest(manifests, requirement, policy);
    if (!route) {
      const structuralRoute = findRequiredActuatorManifest(manifests, requirement);
      if (structuralRoute) {
        blockers.push(`required-actuator-policy-blocked:${requirement.actuatorRef}`, ...policyBlockers(structuralRoute, null, policy));
      } else if (
        requirement.descriptorFingerprint &&
        findRequiredActuatorManifest(manifests, { actuatorRef: requirement.actuatorRef })
      ) {
        blockers.push(`required-actuator-descriptor-uncovered:${requirement.actuatorRef}:${requirement.descriptorFingerprint}`);
      } else {
        blockers.push(`required-actuator-uncovered:${requirement.actuatorRef}`);
      }
      continue;
    }
    selectedRequiredActuatorRoutes.push({ manifest: route, requirement });
  }

  for (const request of pendingRequests) {
    const route = findDriverManifestForRequest(manifests, request, policy);
    if (!route) {
      const structuralRoute = findDriverManifestForRequest(manifests, request);
      if (structuralRoute) {
        blockers.push(...policyBlockers(structuralRoute, request, policy));
        coveredRequests.push({ actuatorRef: request.actuatorRef, descriptorFingerprint: request.descriptorFingerprint, driverId: structuralRoute.driverId });
      } else if (manifests.some((manifest) => driverMatchesExceptResponseStatus(manifest, request))) {
        blockers.push('ERR_RESPONSE_STATUS_NOT_SUPPORTED');
      } else {
        blockers.push(`pending-request-uncovered:${request.hostRequestFingerprint ?? request.actuatorRef}`);
      }
      continue;
    }
    coveredRequests.push({ actuatorRef: request.actuatorRef, descriptorFingerprint: request.descriptorFingerprint, driverId: route.driverId });
    selectedPendingRequestRoutes.push({ manifest: route, request });
  }

  for (const label of application?.requiredHostAuthorityLabels ?? []) {
    if (hasPendingRequestContext && selectedPendingRequestRoutes.some(({ manifest }) => manifest.authorityLabels.includes(label))) continue;
    if (!hasPendingRequestContext && selectedRequiredActuatorRoutes.some(({ manifest }) => manifest.authorityLabels.includes(label))) continue;
    const authorityRoutes = manifests.filter((manifest) => manifest.authorityLabels.includes(label));
    if (!authorityRoutes.length) {
      blockers.push(`required-authority-uncovered:${label}`);
      continue;
    }
    const routePolicyBlockers = authorityRoutes.map((manifest) => policyBlockers(manifest, null, policy));
    if (routePolicyBlockers.every((items) => items.length > 0)) {
      blockers.push(`required-authority-policy-blocked:${label}`, ...uniqueFlat(routePolicyBlockers));
      continue;
    }
    if (requiredAuthorityLabelNeedsPendingBinding(label, selectedRequiredActuatorRoutes, selectedPendingRequestRoutes, hasPendingRequestContext)) {
      blockers.push(`required-authority-unbound:${label}`);
    }
  }

  const runtimeLimits = application?.requiredRuntimeLimits ?? {};
  if (runtimeLimits.maximumConcurrentEffects > policy.maximumConcurrentEffects) blockers.push('runtime-concurrency-limit-exceeds-policy');
  if (runtimeLimits.maximumRequestBytes > policy.maximumRequestBytes) blockers.push('runtime-request-limit-exceeds-policy');
  if (runtimeLimits.maximumResponseBytes > policy.maximumResponseBytes) blockers.push('runtime-response-limit-exceeds-policy');
  if (applianceManifest.supervisionPolicy && !policy.acceptedSupervisionPolicies.has(applianceManifest.supervisionPolicy)) blockers.push('supervision-policy-rejected');
  if (!currentHead) warnings.push('current-head-not-provided');

  return new CapabilityReport({
    executableCompatible: !blockers.some((item) => item.startsWith('required-actuator') || item.startsWith('required-authority')),
    runtimeCompatible: !blockers.some((item) => item.startsWith('runtime-') || item === 'supervision-policy-rejected'),
    everyRequiredActuatorCovered: !blockers.some((item) => item.startsWith('required-actuator') || item.startsWith('required-authority')),
    everyPendingRequestCovered: !blockers.some((item) => item.startsWith('pending-request')),
    responseStatusesSupported: !blockers.some((item) => item.includes('RESPONSE_STATUS')),
    valueSizeLimitsSupported: !blockers.some((item) => item.startsWith('runtime-') || item === 'request-limit-exceeds-policy' || item === 'response-limit-exceeds-policy'),
    recoveryClassSufficient: !blockers.includes('ERR_BEST_EFFORT_REQUIRES_OPERATOR_OPT_IN'),
    fileNetworkAuthoritiesAllowed: !blockers.some((item) => item.startsWith('authority-denied') || item.startsWith('http-origin-denied') || item.startsWith('http-origin-driver-denied') || item.startsWith('http-method-driver-denied') || item.startsWith('file-root-denied')),
    supervisionPolicyAccepted: !blockers.includes('supervision-policy-rejected'),
    coveredRequests,
    blockers,
    warnings,
  });
}

function normalizeRequiredActuator(required) {
  if (typeof required === 'string') return { actuatorRef: required, descriptorFingerprint: null };
  return {
    actuatorRef: required?.actuatorRef,
    descriptorFingerprint: required?.descriptorFingerprint ?? null,
  };
}

function uniqueFlat(groups) {
  return [...new Set(groups.flat())];
}

function requiredAuthorityLabelNeedsPendingBinding(label, selectedRequiredActuatorRoutes, selectedPendingRequestRoutes, hasPendingRequestContext) {
  if (!hasPendingRequestContext) return selectedRequiredActuatorRoutes.length > 0;
  if (!selectedRequiredActuatorRoutes.length) return selectedPendingRequestRoutes.length > 0;
  const labeledRequiredRoutes = selectedRequiredActuatorRoutes.filter(({ manifest }) => manifest.authorityLabels.includes(label));
  if (!labeledRequiredRoutes.length) return true;
  return labeledRequiredRoutes.some(({ requirement }) => selectedPendingRequestRoutes.some(({ request }) => requirementMatchesRequest(requirement, request)));
}

function requirementMatchesRequest(requirement, request) {
  return requirement.actuatorRef === request.actuatorRef &&
    (!requirement.descriptorFingerprint || requirement.descriptorFingerprint === request.descriptorFingerprint);
}

function findRequiredActuatorManifest(manifests, requirement, policy = null) {
  const required = normalizeRequiredActuator(requirement);
  for (const manifest of manifests) {
    if (!manifest.supportedActuatorRefs.includes(required.actuatorRef)) continue;
    if (
      required.descriptorFingerprint &&
      !manifest.supportedDescriptorFingerprints.includes(required.descriptorFingerprint)
    ) {
      continue;
    }
    if (policy && policyBlockers(manifest, null, policy).length) continue;
    return manifest;
  }
  return null;
}

function policyBlockers(route, request, policy) {
  const blockers = [];
  try {
    assertDurableRecoveryAllowed(route.recoveryClass, policy);
  } catch (error) {
    blockers.push(error.code);
  }
  const deniedLabels = route.authorityLabels.filter((label) => policy.allowedAuthorityLabels.size && !policy.allowedAuthorityLabels.has(label));
  if (deniedLabels.length) blockers.push(`authority-denied:${deniedLabels.join(',')}`);
  if (request && policy.maximumRequestBytes !== undefined && request.requestBytes?.byteLength > policy.maximumRequestBytes) blockers.push('request-limit-exceeds-policy');
  if (policy.maximumResponseBytes !== undefined && route.maximumResponseBytes > policy.maximumResponseBytes) blockers.push('response-limit-exceeds-policy');
  const allowedFileRoots = policy.allowedFileRoots ?? new Set();
  if (allowedFileRoots.size && route.authorityLabels.includes('file:sandbox')) {
    const root = route.diagnostics?.root;
    if (!root || !allowedFileRoots.has(root)) blockers.push(`file-root-denied:${root ?? 'unknown'}`);
  }
  if (request && (request.actuationClass === 'http' || route.authorityLabels.includes('network:http'))) {
    const origin = requestOrigin(request);
    const driverOrigins = Array.isArray(route.diagnostics?.origins) ? new Set(route.diagnostics.origins) : null;
    if (driverOrigins && (!origin || !driverOrigins.has(origin))) blockers.push(`http-origin-driver-denied:${origin ?? 'unknown'}`);
    if (!origin || policy.allowedHttpOrigins.size && !policy.allowedHttpOrigins.has(origin)) blockers.push(`http-origin-denied:${origin ?? 'unknown'}`);
    const method = requestMethod(request);
    const driverMethods = Array.isArray(route.diagnostics?.methods)
      ? new Set(route.diagnostics.methods.map((item) => String(item).toUpperCase()))
      : null;
    if (driverMethods && (!method || !driverMethods.has(method))) blockers.push(`http-method-driver-denied:${method ?? 'unknown'}`);
  }
  return blockers;
}

function driverMatchesExceptResponseStatus(manifest, request) {
  return manifest.supportedActuatorRefs.includes(request.actuatorRef) &&
    manifest.supportedDescriptorFingerprints.includes(request.descriptorFingerprint) &&
    manifest.supportedActuationClasses.includes(request.actuationClass) &&
    request.responseSchema &&
    !manifest.supportedResponseStatuses.includes(request.responseSchema.status);
}

export function findDriverManifestForRequest(manifests, request, policy = null) {
  for (const manifest of manifests) {
    try {
      assertDriverCanResolve(manifest, request);
      if (policy && policyBlockers(manifest, request, policy).length) continue;
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

function requestMethod(request) {
  try {
    const text = new TextDecoder().decode(request.requestBytes);
    const value = JSON.parse(text);
    return String(value.method ?? 'GET').toUpperCase();
  } catch {
    return null;
  }
}
