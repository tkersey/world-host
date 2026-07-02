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
  const requiredAuthorityLabels = application?.requiredHostAuthorityLabels ?? [];
  const requiredActuatorOptions = [];

  for (const required of application?.requiredActuators ?? []) {
    const requirement = normalizeRequiredActuator(required);
    const candidates = findRequiredActuatorManifests(manifests, requirement, policy);
    if (!candidates.length) {
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
    requiredActuatorOptions.push({ requirement, candidates });
  }

  for (const option of requiredActuatorOptions) {
    const route = selectPreferredAuthorityManifest(
      option.candidates,
      preferredAuthorityLabelsForRequirement(option, requiredActuatorOptions, requiredAuthorityLabels),
    );
    selectedRequiredActuatorRoutes.push({ manifest: route, requirement: option.requirement });
  }

  for (const request of pendingRequests) {
    const candidates = findDriverManifestsForRequest(manifests, request, policy);
    if (!candidates.length) {
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
    const requiredOption = requiredActuatorOptions.find(({ requirement }) => requirementMatchesRequest(requirement, request));
    const preferredAuthorityLabels = requiredOption
      ? preferredAuthorityLabelsForRequirement(requiredOption, requiredActuatorOptions, requiredAuthorityLabels)
      : preferredAuthorityLabelsWithoutRequirement(requiredAuthorityLabels);
    const route = selectPreferredAuthorityManifest(candidates, preferredAuthorityLabels);
    coveredRequests.push({ actuatorRef: request.actuatorRef, descriptorFingerprint: request.descriptorFingerprint, driverId: route.driverId });
    selectedPendingRequestRoutes.push({ manifest: route, request });
  }

  for (const label of requiredAuthorityLabels) {
    const pendingBindingState = hasPendingRequestContext
      ? pendingAuthorityBindingState(label, requiredAuthorityLabels, selectedRequiredActuatorRoutes, selectedPendingRequestRoutes)
      : null;
    if (pendingBindingState === 'bound') continue;
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
    if (hasPendingRequestContext ? pendingBindingState === 'unbound' : selectedRequiredActuatorRoutes.length > 0) {
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
    fileNetworkAuthoritiesAllowed: !blockers.some((item) => item.startsWith('authority-denied') || item === 'http-origin-allowlist-required' || item.startsWith('http-origin-denied') || item.startsWith('http-origin-driver-denied') || item.startsWith('http-method-driver-denied') || item.startsWith('file-root-denied')),
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

function pendingAuthorityBindingState(label, requiredLabels, selectedRequiredActuatorRoutes, selectedPendingRequestRoutes) {
  if (!selectedPendingRequestRoutes.length) return 'inactive';
  const requiredLabelSet = new Set(requiredLabels);
  const activePendingRoutes = selectedPendingRequestRoutes.filter(({ request }) => {
    const requiredRoute = selectedRequiredActuatorRoutes.find(({ requirement }) => requirementMatchesRequest(requirement, request));
    if (!requiredRoute) return true;
    if (requiredRoute.manifest.authorityLabels.includes(label)) return true;
    const labelBearingOtherRoutes = selectedRequiredActuatorRoutes.filter(({ manifest, requirement }) =>
      !requirementMatchesRequest(requirement, request) && manifest.authorityLabels.includes(label));
    const hasAnotherRequiredLabel = requiredRoute.manifest.authorityLabels.some((item) =>
      item !== label && requiredLabelSet.has(item));
    const labelBearingOtherRouteIsPending = labelBearingOtherRoutes.some(({ requirement }) =>
      selectedPendingRequestRoutes.some((pendingRoute) => requirementMatchesRequest(requirement, pendingRoute.request)));
    if (labelBearingOtherRouteIsPending && hasAnotherRequiredLabel) return false;
    if (
      labelBearingOtherRoutes.length &&
      !labelBearingOtherRouteIsPending &&
      labelBearingOtherRoutes.every(({ manifest }) => countRequiredAuthorityLabels(manifest, requiredLabelSet) === 1)
    ) {
      return false;
    }
    return true;
  });
  if (!activePendingRoutes.length) return 'inactive';
  return activePendingRoutes.every(({ manifest }) => manifest.authorityLabels.includes(label)) ? 'bound' : 'unbound';
}

function countRequiredAuthorityLabels(manifest, requiredLabelSet) {
  return manifest.authorityLabels.filter((item) => requiredLabelSet.has(item)).length;
}

function requirementMatchesRequest(requirement, request) {
  return requirement.actuatorRef === request.actuatorRef &&
    (!requirement.descriptorFingerprint || requirement.descriptorFingerprint === request.descriptorFingerprint);
}

function findRequiredActuatorManifest(manifests, requirement, policy = null, preferredAuthorityLabels = []) {
  return selectPreferredAuthorityManifest(findRequiredActuatorManifests(manifests, requirement, policy), preferredAuthorityLabels);
}

function findRequiredActuatorManifests(manifests, requirement, policy = null) {
  const required = normalizeRequiredActuator(requirement);
  const matches = [];
  for (const manifest of manifests) {
    if (!manifest.supportedActuatorRefs.includes(required.actuatorRef)) continue;
    if (
      required.descriptorFingerprint &&
      !manifest.supportedDescriptorFingerprints.includes(required.descriptorFingerprint)
    ) {
      continue;
    }
    if (policy && policyBlockers(manifest, null, policy).length) continue;
    matches.push(manifest);
  }
  return matches;
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
  if (allowedFileRoots.size && isFileRoute(route, request)) {
    const root = route.diagnostics?.root;
    if (!root || !allowedFileRoots.has(root)) blockers.push(`file-root-denied:${root ?? 'unknown'}`);
  }
  if (request && (request.actuationClass === 'http' || route.authorityLabels.includes('network:http'))) {
    const origin = requestOriginForRoute(request, route);
    const driverOrigins = Array.isArray(route.diagnostics?.origins) ? new Set(route.diagnostics.origins) : null;
    if (driverOrigins && (!origin || !driverOrigins.has(origin))) blockers.push(`http-origin-driver-denied:${origin ?? 'unknown'}`);
    if (!origin) blockers.push('http-origin-denied:unknown');
    else if (!policy.allowedHttpOrigins.size) blockers.push('http-origin-allowlist-required');
    else if (!policy.allowedHttpOrigins.has(origin)) blockers.push(`http-origin-denied:${origin}`);
    const method = requestMethodForRoute(request, route);
    const driverMethods = Array.isArray(route.diagnostics?.methods)
      ? new Set(route.diagnostics.methods.map((item) => String(item).toUpperCase()))
      : null;
    if (driverMethods && (!method || !driverMethods.has(method))) blockers.push(`http-method-driver-denied:${method ?? 'unknown'}`);
  }
  return blockers;
}

function isFileRoute(route, request) {
  return request?.actuationClass === 'file' ||
    (route.supportedActuationClasses ?? []).includes('file') ||
    (route.authorityLabels ?? []).some((label) => label.startsWith('file:'));
}

function driverMatchesExceptResponseStatus(manifest, request) {
  return manifest.supportedActuatorRefs.includes(request.actuatorRef) &&
    manifest.supportedDescriptorFingerprints.includes(request.descriptorFingerprint) &&
    manifest.supportedActuationClasses.includes(request.actuationClass) &&
    request.responseSchema &&
    !manifest.supportedResponseStatuses.includes(request.responseSchema.status);
}

export function findDriverManifestForRequest(manifests, request, policy = null, preferredAuthorityLabels = []) {
  return selectPreferredAuthorityManifest(findDriverManifestsForRequest(manifests, request, policy), preferredAuthorityLabels);
}

function findDriverManifestsForRequest(manifests, request, policy = null) {
  const matches = [];
  for (const manifest of manifests) {
    try {
      assertDriverCanResolve(manifest, request);
      if (policy && policyBlockers(manifest, request, policy).length) continue;
      matches.push(manifest);
    } catch {
      continue;
    }
  }
  return matches;
}

function selectPreferredAuthorityManifest(manifests, preferredAuthorityLabels) {
  if (!manifests.length) return null;
  let selected = manifests[0];
  let selectedScore = authorityPreferenceScore(selected, preferredAuthorityLabels);
  for (const manifest of manifests.slice(1)) {
    const score = authorityPreferenceScore(manifest, preferredAuthorityLabels);
    if (score > selectedScore) {
      selected = manifest;
      selectedScore = score;
    }
  }
  return selected;
}

function authorityPreferenceScore(manifest, preferredAuthorityLabels) {
  return preferredAuthorityLabels.filter((label) => manifest.authorityLabels.includes(label)).length;
}

function preferredAuthorityLabelsForRequirement(option, allOptions, requiredAuthorityLabels) {
  const targetLabels = authorityLabelsPresent(option.candidates, requiredAuthorityLabels);
  const uniqueLabels = requiredAuthorityLabels.filter((label) =>
    targetLabels.has(label) &&
    !allOptions.some((candidateOption) =>
      candidateOption !== option && authorityLabelsPresent(candidateOption.candidates, requiredAuthorityLabels).has(label)));
  if (uniqueLabels.length) return uniqueLabels;
  const presentLabels = requiredAuthorityLabels.filter((label) => targetLabels.has(label));
  return presentLabels.length === 1 ? presentLabels : [];
}

function preferredAuthorityLabelsWithoutRequirement(requiredAuthorityLabels) {
  return requiredAuthorityLabels.length === 1 ? requiredAuthorityLabels : [];
}

function authorityLabelsPresent(manifests, requiredAuthorityLabels) {
  const present = new Set();
  for (const manifest of manifests) {
    for (const label of requiredAuthorityLabels) {
      if (manifest.authorityLabels.includes(label)) present.add(label);
    }
  }
  return present;
}

export function assertCapabilityReportAccepted(report) {
  if (!(report instanceof CapabilityReport)) fail('ERR_INVALID_CAPABILITY_REPORT');
  if (report.blockers.length) fail('ERR_CAPABILITY_PREFLIGHT_BLOCKED', 'capability preflight blocked', { blockers: report.blockers });
  return true;
}

export { EffectRecoveryClass };

function requestOriginForRoute(request, route) {
  try {
    const text = new TextDecoder().decode(request.requestBytes);
    const value = JSON.parse(text);
    if (fixedConfiguredEndpointRoute(route)) return route.diagnostics.configuredOrigin;
    if (value.url === undefined && configuredEndpointRoute(route)) return route.diagnostics.configuredOrigin;
    return new URL(value.url).origin;
  } catch {
    return null;
  }
}

function requestMethodForRoute(request, route) {
  try {
    const text = new TextDecoder().decode(request.requestBytes);
    const value = JSON.parse(text);
    if (fixedConfiguredEndpointRoute(route)) return String(value.method ?? route.diagnostics.defaultMethod ?? 'POST').toUpperCase();
    if (value.url === undefined && configuredEndpointRoute(route)) return String(value.method ?? route.diagnostics.defaultMethod ?? 'POST').toUpperCase();
    return String(value.method ?? route?.diagnostics?.defaultMethod ?? 'GET').toUpperCase();
  } catch {
    return null;
  }
}

function fixedConfiguredEndpointRoute(route) {
  return route?.diagnostics?.endpointSource === 'config';
}

function configuredEndpointRoute(route) {
  return route?.diagnostics?.endpointSource === 'config' || route?.diagnostics?.endpointSource === 'request-or-config';
}
