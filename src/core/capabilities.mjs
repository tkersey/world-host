import { createHash } from 'node:crypto';

import { EffectRecoveryClass, assertDriverCanResolve, assertDriverManifest, assertDurableRecoveryAllowed } from './actuator.mjs';
import { assertBytes, fail, fromUtf8, stableJson, toHex } from './store.mjs';

export class CapabilityReport {
  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this.blockers);
    Object.freeze(this.warnings);
    Object.freeze(this.coveredRequests);
    if (this.selectedPendingRequestRoutes) Object.freeze(this.selectedPendingRequestRoutes);
    Object.freeze(this);
  }
}

export function createRunPolicy(input = {}) {
  return Object.freeze({
    durableAutomatic: input.durableAutomatic !== false,
    allowBestEffort: input.allowBestEffort === true,
    allowHumanEffects: input.allowHumanEffects === true,
    allowPartialEffectBatch: input.allowPartialEffectBatch === true,
    auditOnly: input.auditOnly === true,
    requireApprovalForDestructiveEffects: input.requireApprovalForDestructiveEffects !== false,
    requireApprovalForNetworkEffects: input.requireApprovalForNetworkEffects === true,
    requireApprovalForBestEffort: input.requireApprovalForBestEffort !== false,
    maximumLiveModelCalls: nonNegativeSafeInteger(input.maximumLiveModelCalls ?? 0, 'maximumLiveModelCalls'),
    allowedAuthorityLabels: new Set(iterable(input.allowedAuthorityLabels)),
    allowedCapabilityPacks: new Set(iterable(input.allowedCapabilityPacks)),
    deniedCapabilityPacks: new Set(iterable(input.deniedCapabilityPacks)),
    allowedFileRoots: new Set(iterable(input.allowedFileRoots)),
    allowedHttpOrigins: new Set(iterable(input.allowedHttpOrigins)),
    allowedHttpMethods: new Set(iterable(input.allowedHttpMethods).map((item) => String(item).toUpperCase())),
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

function nonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail('ERR_RUN_POLICY_LIMIT_INVALID', `${field} must be a non-negative safe integer`);
  return value;
}

function iterable(value) {
  if (value == null) return [];
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value;
  return [value];
}

export function createHostCapabilityManifest(input = {}) {
  return Object.freeze({
    runtimeLimits: input.runtimeLimits ?? {},
    drivers: input.drivers ?? [],
    policy: input.policy ?? createRunPolicy(),
    diagnostics: input.diagnostics ?? {},
  });
}

export function preflightCapabilities({ application, applianceManifest = {}, currentHead = null, pendingRequests = [], drivers = [], policy: policyInput = createRunPolicy(), effectRecords = [] }) {
  const policy = createRunPolicy(policyInput);
  const blockers = [];
  const warnings = [];
  const manifests = drivers.map((driver, driverIndex) => manifestWithDriverIndex(normalizeDriverManifest(driver.manifest()), driverIndex));
  const coveredRequests = [];
  const selectedRequiredActuatorRoutes = [];
  const selectedPendingRequestRoutes = [];
  let selectedLiveModelRequestCount = 0;
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
    const route = selectPendingRequestRoute(candidates, preferredAuthorityLabels, request, policy, effectRecords, selectedLiveModelRequestCount);
    coveredRequests.push({ actuatorRef: request.actuatorRef, descriptorFingerprint: request.descriptorFingerprint, driverId: route.driverId });
    selectedPendingRequestRoutes.push({ manifest: route, request });
    if (chargesLiveModelBudget(route, request, effectRecords)) selectedLiveModelRequestCount += 1;
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
  if (selectedLiveModelRequestCount > policy.maximumLiveModelCalls) blockers.push('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED');
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
    fileNetworkAuthoritiesAllowed: !blockers.some((item) => item.startsWith('authority-denied') || item === 'http-origin-allowlist-required' || item.startsWith('http-origin-denied') || item.startsWith('http-origin-driver-denied') || item === 'http-method-allowlist-required' || item.startsWith('http-method-denied') || item.startsWith('http-method-driver-denied') || item === 'file-root-allowlist-required' || item.startsWith('file-root-denied')),
    supervisionPolicyAccepted: !blockers.includes('supervision-policy-rejected'),
    coveredRequests,
    selectedPendingRequestRoutes: selectedPendingRequestRoutes.map(({ manifest, request }) => ({
      actuatorRef: request.actuatorRef,
      descriptorFingerprint: request.descriptorFingerprint,
      driverId: manifest.driverId,
      driverIndex: manifest.driverIndex,
    })),
    blockers,
    warnings,
  });
}

function normalizeDriverManifest(raw) {
  const manifest = assertDriverManifest(raw);
  if (raw.packFingerprint == null) return manifest;
  if (typeof raw.packFingerprint !== 'string') fail('ERR_INVALID_DRIVER_MANIFEST', 'packFingerprint must be a string');
  return Object.freeze({ ...manifest, packFingerprint: raw.packFingerprint });
}

function manifestWithDriverIndex(manifest, driverIndex) {
  return Object.freeze({ ...manifest, driverIndex });
}

function normalizeRequiredActuator(required) {
  if (typeof required === 'string') return { actuatorRef: required, descriptorFingerprint: null };
  return {
    actuatorRef: required?.actuatorRef,
    descriptorFingerprint: required?.descriptorFingerprint ?? null,
  };
}

function hasReusableEffectOutcome(request, effectRecords, route) {
  if (!request?.idempotencyKeyWorldFingerprint || !request?.hostRequestFingerprint) return false;
  const identity = reusableRequestIdentity(request, route);
  if (!identity) return false;
  return effectRecords.some((record) => (
    record?.idempotencyKeyWorldFingerprint === request.idempotencyKeyWorldFingerprint &&
    record?.hostRequestFingerprint === request.hostRequestFingerprint &&
    record?.idempotencyKey?.format === 'world-idempotency-key-bytes.hex' &&
    record.idempotencyKey.bytesHex === identity.idempotencyKeyBytesHex &&
    (record.requestIdentityChecksum ?? record.requestBytesChecksum) === identity.requestIdentityChecksum &&
    record?.resolutionInputRef &&
    (record.state === 'resolved' || record.state === 'submitted' || record.state === 'closure_committed')
  ));
}

function reusableRequestIdentity(request, route) {
  try {
    const idempotencyKeyBytes = assertBytes(request.idempotencyKeyBytes, 'idempotencyKeyBytes');
    const requestBytes = assertBytes(request.requestBytes, 'requestBytes');
    const effectIdentityBytes = request.effectIdentityBytes === undefined
      ? routeEffectIdentityBytes(requestBytes, route) ?? requestBytes
      : assertBytes(request.effectIdentityBytes, 'effectIdentityBytes');
    return {
      idempotencyKeyBytesHex: toHex(idempotencyKeyBytes),
      requestIdentityChecksum: `sha256:${createHash('sha256').update(effectIdentityBytes).digest('hex')}`,
    };
  } catch {
    return null;
  }
}

function routeEffectIdentityBytes(requestBytes, route) {
  const endpointSource = route?.diagnostics?.endpointSource;
  if (endpointSource !== 'config' && endpointSource !== 'request-or-config') return null;
  const requestRendering = route?.diagnostics?.requestRendering ?? null;
  let parsed = {};
  try {
    parsed = JSON.parse(new TextDecoder().decode(requestBytes));
  } catch {
    return null;
  }
  if (endpointSource === 'request-or-config' && parsed?.url !== undefined && parsed.method !== undefined) {
    return requestRendering === null && !hasModelOutputValidation(route?.diagnostics)
      ? null
      : fromUtf8(stableJson(effectIdentityPayload(route?.diagnostics, parsed, null, requestRendering)));
  }
  const configuredEndpoint = configuredEffectIdentityTargetForRoute(route, parsed);
  if (!configuredEndpoint && requestRendering === null && !hasModelOutputValidation(route?.diagnostics)) return null;
  return fromUtf8(stableJson(effectIdentityPayload(route?.diagnostics, parsed, configuredEndpoint, requestRendering)));
}

function configuredEffectIdentityTargetForRoute(route, parsed = {}) {
  const origins = Array.isArray(route?.diagnostics?.origins) ? route.diagnostics.origins : [];
  const methods = Array.isArray(route?.diagnostics?.methods) ? route.diagnostics.methods : [];
  const endpointSource = route?.diagnostics?.endpointSource;
  const requestUrl = endpointSource === 'request-or-config' && parsed?.url !== undefined ? parsed.url : null;
  const url = requestUrl ?? route?.diagnostics?.configuredEndpointUrl ?? route?.diagnostics?.configuredOrigin ?? (origins.length === 1 ? origins[0] : null);
  const method = parsed.method ?? route?.diagnostics?.defaultMethod ?? (methods.length === 1 ? methods[0] : null);
  if (!url || !method) return null;
  return { url, method };
}

function effectIdentityPayload(diagnostics, request, configuredEndpoint, requestRendering) {
  const payload = { request, configuredEndpoint, requestRendering };
  if (hasModelOutputValidation(diagnostics)) payload.modelOutputValidation = diagnostics.modelOutputValidation;
  return payload;
}

function hasModelOutputValidation(diagnostics) {
  return diagnostics != null && Object.prototype.hasOwnProperty.call(diagnostics, 'modelOutputValidation');
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
  if (policy.deniedCapabilityPacks.has(route.packFingerprint) || policy.deniedCapabilityPacks.has(route.driverId)) {
    blockers.push('ERR_CAPABILITY_PACK_DENIED');
  }
  if (
    policy.allowedCapabilityPacks.size &&
    !policy.allowedCapabilityPacks.has(route.packFingerprint) &&
    !policy.allowedCapabilityPacks.has(route.driverId)
  ) {
    blockers.push('ERR_CAPABILITY_PACK_NOT_ALLOWED');
  }
  const deniedLabels = route.authorityLabels.filter((label) => policy.allowedAuthorityLabels.size && !policy.allowedAuthorityLabels.has(label));
  if (deniedLabels.length) blockers.push(`authority-denied:${deniedLabels.join(',')}`);
  if (request && policy.maximumRequestBytes !== undefined && request.requestBytes?.byteLength > policy.maximumRequestBytes) blockers.push('request-limit-exceeds-policy');
  if (policy.maximumResponseBytes !== undefined && route.maximumResponseBytes > policy.maximumResponseBytes) blockers.push('response-limit-exceeds-policy');
  const allowedFileRoots = policy.allowedFileRoots ?? new Set();
  if (isFileRoute(route, request)) {
    if (!allowedFileRoots.size) blockers.push('file-root-allowlist-required');
    const root = route.diagnostics?.root;
    if (allowedFileRoots.size && (!root || !allowedFileRoots.has(root))) blockers.push(`file-root-denied:${root ?? 'unknown'}`);
  }
  if (isHumanRoute(route, request) && policy.allowHumanEffects !== true) blockers.push('ERR_CAPABILITY_HUMAN_DENIED');
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
    if (!method) blockers.push('http-method-denied:unknown');
    else if (!policy.allowedHttpMethods.size) blockers.push('http-method-allowlist-required');
    else if (!policy.allowedHttpMethods.has(method)) blockers.push(`http-method-denied:${method}`);
  }
  return blockers;
}

function isFileRoute(route, request) {
  return request?.actuationClass === 'file' ||
    (route.supportedActuationClasses ?? []).includes('file') ||
    (route.authorityLabels ?? []).some((label) => label.startsWith('file:'));
}

function isHumanRoute(route, request) {
  return request?.actuationClass === 'human' ||
    (route.supportedActuationClasses ?? []).includes('human') ||
    (route.authorityLabels ?? []).some((label) => label.startsWith('human:'));
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

function selectPendingRequestRoute(candidates, preferredAuthorityLabels, request, policy, effectRecords, selectedLiveModelRequestCount) {
  const selected = selectPreferredAuthorityManifest(candidates, preferredAuthorityLabels);
  if (!chargesLiveModelBudget(selected, request, effectRecords)) return selected;

  const nonChargingCandidates = candidates.filter((manifest) => !chargesLiveModelBudget(manifest, request, effectRecords));
  if (!nonChargingCandidates.length) return selected;
  if (selectedLiveModelRequestCount >= policy.maximumLiveModelCalls) {
    return selectPreferredAuthorityManifest(nonChargingCandidates, preferredAuthorityLabels);
  }

  const selectedScore = authorityPreferenceScore(selected, preferredAuthorityLabels);
  const equallyPreferredNonChargingCandidates = nonChargingCandidates.filter((manifest) =>
    authorityPreferenceScore(manifest, preferredAuthorityLabels) === selectedScore);
  return equallyPreferredNonChargingCandidates.length
    ? selectPreferredAuthorityManifest(equallyPreferredNonChargingCandidates, preferredAuthorityLabels)
    : selected;
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
    const methods = Array.isArray(route?.diagnostics?.methods) ? route.diagnostics.methods : [];
    return String(value.method ?? route?.diagnostics?.defaultMethod ?? (methods.length === 1 ? methods[0] : 'GET')).toUpperCase();
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

function isLiveModelRoute(route, request) {
  const modelLabels = (route?.authorityLabels ?? []).filter((label) => label.startsWith('model:'));
  if (modelLabels.some((label) => !label.startsWith('model:fixture'))) return true;
  const modelCapable = request?.actuationClass === 'model' ||
    (route?.supportedActuationClasses ?? []).includes('model');
  if (!modelCapable) return false;
  if (route?.driverId === 'fixture-agent-model') return false;
  if (!modelLabels.length) return true;
  return false;
}

function chargesLiveModelBudget(route, request, effectRecords) {
  return isLiveModelRoute(route, request) && !hasReusableEffectOutcome(request, effectRecords, route);
}
