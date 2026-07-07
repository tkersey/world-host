import { createHash } from 'node:crypto';

import { EffectRecoveryClass, ResponseStatusCode, assertDriverCanResolve, assertDriverManifest, assertDurableRecoveryAllowed } from './actuator.mjs';
import { assertBytes, fail, fromUtf8, stableJson, toHex } from './store.mjs';
import { decodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';
import { decodeCanonicalValueImage } from '../protocol/world_loaded_value_codec.mjs';

const FIXTURE_MODEL_AUTHORITY_LABELS = new Set(['model:fixture', 'model:fixture-agent']);
const TERMINAL_REUSABLE_OUTCOME_STATES = new Set(['resolved', 'submitted', 'closure_committed']);

export class CapabilityReport {
  constructor(fields) {
    Object.assign(this, fields);
    Object.freeze(this.blockers);
    Object.freeze(this.warnings);
    Object.freeze(this.coveredRequests);
    if (this.selectedPendingRequestRoutes) Object.freeze(this.selectedPendingRequestRoutes);
    if (this.unresolvedPendingRequestRoutes) Object.freeze(this.unresolvedPendingRequestRoutes);
    Object.freeze(this);
  }
}

export function createRunPolicy(input = {}) {
  const maximumRequestBytes = positiveSafeInteger(input.maximumRequestBytes ?? 1024 * 1024, 'maximumRequestBytes');
  const maximumPromptBytes = positiveSafeInteger(input.maximumPromptBytes ?? maximumRequestBytes, 'maximumPromptBytes');
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
    maximumRequestBytes,
    maximumPromptBytes,
    maximumResponseBytes: positiveSafeInteger(input.maximumResponseBytes ?? 1024 * 1024, 'maximumResponseBytes'),
    acceptedSupervisionPolicies: new Set(iterable(input.acceptedSupervisionPolicies ?? ['default'])),
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

export function preflightCapabilities({
  application,
  applianceManifest = {},
  currentHead = null,
  currentBranchId = null,
  pendingRequests = [],
  drivers = [],
  policy: policyInput = createRunPolicy(),
  effectRecords = [],
  effectResolutionInputs = new Map(),
}) {
  const policy = createRunPolicy(policyInput);
  const blockers = [];
  const warnings = [];
  const manifests = drivers.map((driver, driverIndex) => manifestWithDriverIndex(normalizeDriverManifest(driver.manifest()), driverIndex));
  const coveredRequests = [];
  const selectedRequiredActuatorRoutes = [];
  const selectedPendingRequestRoutes = [];
  const unresolvedPendingRequestRoutes = [];
  let selectedLiveModelRequestCount = 0;
  const reusableEffectBlockers = [];
  const nonRerunnableReusableEffectBlockers = [];
  const currentParentTurnClosureFingerprint = currentHeadParentTurnClosureFingerprint(currentHead);
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
        const structuralBlockers = policyBlockers(structuralRoute, request, policy);
        if (policy.allowPartialEffectBatch === true && structuralBlockers.length) {
          coveredRequests.push({ actuatorRef: request.actuatorRef, descriptorFingerprint: request.descriptorFingerprint, driverId: structuralRoute.driverId });
          unresolvedPendingRequestRoutes.push(unresolvedPendingRequestRoute(structuralRoute, request, structuralBlockers));
          continue;
        }
        blockers.push(...structuralBlockers);
        coveredRequests.push({ actuatorRef: request.actuatorRef, descriptorFingerprint: request.descriptorFingerprint, driverId: structuralRoute.driverId });
      } else {
        const oversizedStructuralRoute = findDriverManifestForOversizedRequest(manifests, request);
        if (oversizedStructuralRoute) {
          if (policy.allowPartialEffectBatch === true) {
            coveredRequests.push({ actuatorRef: request.actuatorRef, descriptorFingerprint: request.descriptorFingerprint, driverId: oversizedStructuralRoute.driverId });
            unresolvedPendingRequestRoutes.push(unresolvedPendingRequestRoute(oversizedStructuralRoute, request, ['ERR_HOST_REQUEST_TOO_LARGE']));
            continue;
          }
          blockers.push('ERR_HOST_REQUEST_TOO_LARGE');
          coveredRequests.push({ actuatorRef: request.actuatorRef, descriptorFingerprint: request.descriptorFingerprint, driverId: oversizedStructuralRoute.driverId });
        } else if (manifests.some((manifest) => driverMatchesExceptResponseStatus(manifest, request))) {
          if (policy.allowPartialEffectBatch === true) {
            unresolvedPendingRequestRoutes.push(unresolvedPendingRequestRoute(null, request, ['ERR_RESPONSE_STATUS_NOT_SUPPORTED']));
            continue;
          }
          blockers.push('ERR_RESPONSE_STATUS_NOT_SUPPORTED');
        } else {
          blockers.push(`pending-request-uncovered:${request.hostRequestFingerprint ?? request.actuatorRef}`);
        }
      }
      continue;
    }
    const requiredOption = requiredActuatorOptions.find(({ requirement }) => requirementMatchesRequest(requirement, request));
    const preferredAuthorityLabels = requiredOption
      ? preferredAuthorityLabelsForRequirement(requiredOption, requiredActuatorOptions, requiredAuthorityLabels)
      : preferredAuthorityLabelsWithoutRequirement(requiredAuthorityLabels);
    const route = selectPendingRequestRoute(
      candidates,
      preferredAuthorityLabels,
      request,
      policy,
      effectRecords,
      selectedLiveModelRequestCount,
      currentBranchId,
      currentParentTurnClosureFingerprint,
      effectResolutionInputs,
    );
    if (!route) {
      if (policy.allowPartialEffectBatch === true) {
        coveredRequests.push({ actuatorRef: request.actuatorRef, descriptorFingerprint: request.descriptorFingerprint, driverId: selectedPendingRequestRouteDriverId(candidates, preferredAuthorityLabels) });
        unresolvedPendingRequestRoutes.push(unresolvedPendingRequestRoute(null, request, ['ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED']));
        continue;
      }
      blockers.push('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED');
      continue;
    }
    hasReusableEffectOutcome(
      request,
      effectRecords,
      route,
      currentBranchId,
      currentParentTurnClosureFingerprint,
      effectResolutionInputs,
      policy,
      reusableEffectBlockers,
      nonRerunnableReusableEffectBlockers,
    );
    coveredRequests.push({ actuatorRef: request.actuatorRef, descriptorFingerprint: request.descriptorFingerprint, driverId: route.driverId });
    selectedPendingRequestRoutes.push({ manifest: route, request });
    if (chargesLiveModelBudget(
      route,
      request,
      effectRecords,
      currentBranchId,
      currentParentTurnClosureFingerprint,
      effectResolutionInputs,
      policy,
      reusableEffectBlockers,
      nonRerunnableReusableEffectBlockers,
    )) selectedLiveModelRequestCount += 1;
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
  const liveModelBudgetExceeded = selectedLiveModelRequestCount > policy.maximumLiveModelCalls;
  blockers.push(...nonRerunnableReusableEffectBlockers);
  if (policy.auditOnly && hasPendingRequestContext) blockers.push('ERR_CAPABILITY_AUDIT_ONLY_DENIED');
  if (liveModelBudgetExceeded) {
    blockers.push(...reusableEffectBlockers);
    blockers.push('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED');
  }
  if (runtimeLimits.maximumConcurrentEffects > policy.maximumConcurrentEffects) blockers.push('runtime-concurrency-limit-exceeds-policy');
  if (runtimeLimits.maximumRequestBytes > policy.maximumRequestBytes) blockers.push('runtime-request-limit-exceeds-policy');
  if (runtimeLimits.maximumResponseBytes > policy.maximumResponseBytes) blockers.push('runtime-response-limit-exceeds-policy');
  const supervisionPolicy = applianceSupervisionPolicy(applianceManifest);
  if (supervisionPolicy != null && !policy.acceptedSupervisionPolicies.has(supervisionPolicy)) blockers.push('supervision-policy-rejected');
  if (!currentHead) warnings.push('current-head-not-provided');
  const everyPendingRequestCovered = unresolvedPendingRequestRoutes.length === 0 &&
    !blockers.some((item) => item.startsWith('pending-request'));
  const reportBlockers = [
    ...blockers,
    ...uniqueFlat(unresolvedPendingRequestRoutes.map((route) => route.blockers ?? [])),
  ];

  return new CapabilityReport({
    executableCompatible: !blockers.some((item) => item.startsWith('required-actuator') || item.startsWith('required-authority')),
    runtimeCompatible: !blockers.some((item) => item.startsWith('runtime-') || item === 'supervision-policy-rejected'),
    everyRequiredActuatorCovered: !blockers.some((item) => item.startsWith('required-actuator') || item.startsWith('required-authority')),
    everyPendingRequestCovered,
    responseStatusesSupported: !reportBlockers.some(responseStatusBlocker),
    valueSizeLimitsSupported: !reportBlockers.some(sizeLimitBlocker),
    recoveryClassSufficient: !blockers.includes('ERR_BEST_EFFORT_REQUIRES_OPERATOR_OPT_IN'),
    fileNetworkAuthoritiesAllowed: !reportBlockers.some((item) => item.startsWith('authority-denied') || item === 'http-origin-allowlist-required' || item.startsWith('http-origin-denied') || item.startsWith('http-origin-driver-denied') || item === 'http-method-allowlist-required' || item.startsWith('http-method-denied') || item.startsWith('http-method-driver-denied') || item === 'file-root-allowlist-required' || item.startsWith('file-root-denied')),
    supervisionPolicyAccepted: !blockers.includes('supervision-policy-rejected'),
    coveredRequests,
    selectedPendingRequestRoutes: selectedPendingRequestRoutes.map(({ manifest, request }) => ({
      actuatorRef: request.actuatorRef,
      descriptorFingerprint: request.descriptorFingerprint,
      ...(request.hostRequestFingerprint == null ? {} : { hostRequestFingerprint: request.hostRequestFingerprint }),
      ...(Number.isSafeInteger(request.pendingRequestIndex) ? { pendingRequestIndex: request.pendingRequestIndex } : {}),
      driverId: manifest.driverId,
      driverIndex: manifest.driverIndex,
    })),
    unresolvedPendingRequestRoutes,
    blockers,
    warnings,
  });
}

function sizeLimitBlocker(item) {
  return item.startsWith('runtime-') ||
    item === 'request-limit-exceeds-policy' ||
    item === 'prompt-limit-exceeds-policy' ||
    item === 'response-limit-exceeds-policy' ||
    item === 'ERR_HOST_REQUEST_TOO_LARGE' ||
    item === 'ERR_CAPABILITY_REUSABLE_EFFECT_RESPONSE_TOO_LARGE';
}

function responseStatusBlocker(item) {
  return item.includes('RESPONSE_STATUS') ||
    item === 'ERR_CAPABILITY_REUSABLE_EFFECT_STATUS_UNSUPPORTED' ||
    item === 'ERR_CAPABILITY_REUSABLE_EFFECT_STATUS_MISMATCH';
}

function applianceSupervisionPolicy(applianceManifest) {
  if (applianceManifest?.supervisionPolicyFingerprint != null) {
    const fingerprint = applianceManifest.supervisionPolicyFingerprint;
    return fingerprint === 0n || fingerprint === 0 ? null : fingerprint;
  }
  const supervisionPolicy = applianceManifest?.supervisionPolicy;
  return supervisionPolicy ? supervisionPolicy : null;
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

function hasReusableEffectOutcome(
  request,
  effectRecords,
  route,
  currentBranchId = null,
  currentParentTurnClosureFingerprint = null,
  effectResolutionInputs = new Map(),
  policy = createRunPolicy(),
  reusableEffectBlockers = [],
  nonRerunnableReusableEffectBlockers = [],
) {
  if (!request?.hostRequestFingerprint) return false;
  const identity = reusableRequestIdentity(request, route);
  if (!identity) return false;
  const sameKeyRecords = effectRecords.filter((record) => (
    record?.idempotencyKey?.format === 'world-idempotency-key-bytes.hex' &&
    record.idempotencyKey.bytesHex === identity.idempotencyKeyBytesHex
  ));
  if (sameKeyRecords.some((record) => !reusableRecordIdentityMatches(record, request, identity))) {
    addUniqueBlocker(nonRerunnableReusableEffectBlockers, 'ERR_EFFECT_IDEMPOTENCY_CONFLICT');
    return false;
  }
  const matchingRecords = sameKeyRecords.filter((record) => reusableRecordIdentityMatches(record, request, identity));
  const orderedRecords = currentBranchId
    ? [
        ...matchingRecords.filter((record) => record?.branchId === currentBranchId),
        ...matchingRecords.filter((record) => record?.branchId !== currentBranchId),
      ]
    : matchingRecords;
  const candidateReusableEffectBlockers = [];
  const candidateNonRerunnableReusableEffectBlockers = [];
  for (const record of orderedRecords) {
    const recordReusableEffectBlockers = [];
    const recordNonRerunnableReusableEffectBlockers = [];
    if (reusableOutcomeRecord(
      record,
      request,
      route,
      effectResolutionInputs,
      policy,
      recordReusableEffectBlockers,
      recordNonRerunnableReusableEffectBlockers,
      currentBranchId,
      currentParentTurnClosureFingerprint,
    )) {
      return true;
    }
    addUniqueBlockers(candidateReusableEffectBlockers, recordReusableEffectBlockers);
    addUniqueBlockers(candidateNonRerunnableReusableEffectBlockers, recordNonRerunnableReusableEffectBlockers);
    if (branchLocalTerminalOutcomeRecord(record, currentBranchId)) {
      addUniqueBlockers(reusableEffectBlockers, candidateReusableEffectBlockers);
      addUniqueBlockers(nonRerunnableReusableEffectBlockers, candidateNonRerunnableReusableEffectBlockers);
      return false;
    }
  }
  addUniqueBlockers(reusableEffectBlockers, candidateReusableEffectBlockers);
  addUniqueBlockers(nonRerunnableReusableEffectBlockers, candidateNonRerunnableReusableEffectBlockers);
  return false;
}

function reusableOutcomeRecord(record, request, route, effectResolutionInputs, policy, reusableEffectBlockers, nonRerunnableReusableEffectBlockers, currentBranchId = null, currentParentTurnClosureFingerprint = null) {
  if (!record?.resolutionInputRef || !TERMINAL_REUSABLE_OUTCOME_STATES.has(record.state)) return false;
  const resolutionInputBytes = effectResolutionInputs.get(blobRefKey(record.resolutionInputRef));
  if (!resolutionInputBytes) return false;
  try {
    assertReusableRecoveryClassAccepted(record, route);
    assertReusableResolutionAccepted(resolutionInputBytes, request, route, policy);
  } catch (error) {
    const blockers = reusableRecordCanRerun(record, route, currentBranchId, currentParentTurnClosureFingerprint)
      ? reusableEffectBlockers
      : nonRerunnableReusableEffectBlockers;
    addUniqueBlocker(blockers, error?.code ?? 'ERR_CAPABILITY_REUSABLE_EFFECT_INVALID');
    return false;
  }
  return true;
}

function branchLocalTerminalOutcomeRecord(record, currentBranchId = null) {
  return Boolean(
    currentBranchId &&
    record?.branchId === currentBranchId &&
    record?.resolutionInputRef &&
    TERMINAL_REUSABLE_OUTCOME_STATES.has(record.state)
  );
}

function assertReusableRecoveryClassAccepted(record, route) {
  if (record.driverRecoveryClass && route?.recoveryClass && record.driverRecoveryClass !== route.recoveryClass) {
    fail('ERR_EFFECT_RECOVERY_CLASS_MISMATCH');
  }
}

function assertReusableResolutionAccepted(resolutionInputBytes, request, route, policy) {
  let resolution;
  try {
    resolution = decodeResolutionInputBytes(resolutionInputBytes);
  } catch (error) {
    fail('ERR_CAPABILITY_REUSABLE_EFFECT_INVALID', 'reusable effect ResolutionInput is invalid', { error: String(error?.message ?? error) });
  }
  if (resolution.targetHostRequestFingerprint !== hostRequestTargetFingerprint(request)) {
    fail('ERR_CAPABILITY_REUSABLE_EFFECT_TARGET_MISMATCH', 'reusable effect ResolutionInput targets a different HostRequest');
  }
  assertReusableResolutionStatusAccepted(resolution.status, request, route);
  if (resolution.status === 0 && resolution.responseValueImageBytes.byteLength === 0) {
    fail('ERR_CAPABILITY_REUSABLE_EFFECT_RESPONSE_REQUIRED', 'reusable effect response is empty');
  }
  if (resolution.status !== 0 && resolution.responseValueImageBytes.byteLength !== 0) {
    fail('ERR_CAPABILITY_REUSABLE_EFFECT_RESPONSE_FORBIDDEN', 'non-responded reusable effect carries response bytes');
  }
  const maximumResponseBytes = Math.min(route.maximumResponseBytes ?? Number.MAX_SAFE_INTEGER, policy.maximumResponseBytes);
  if (maximumResponseBytes !== Number.MAX_SAFE_INTEGER && (
    resolutionInputBytes.byteLength > maximumResponseBytes ||
    resolution.responseValueImageBytes.byteLength > maximumResponseBytes ||
    resolution.hostClaimBytes.byteLength > maximumResponseBytes ||
    resolution.metadata.byteLength > maximumResponseBytes
  )) {
    fail('ERR_CAPABILITY_REUSABLE_EFFECT_RESPONSE_TOO_LARGE', 'reusable effect ResolutionInput exceeds response policy');
  }
  assertReusableModelOutputAccepted(resolution, route);
}

function assertReusableModelOutputAccepted(resolution, route) {
  const validation = route?.diagnostics?.modelOutputValidation;
  if (validation == null || resolution.status !== 0) return;
  try {
    assertModelOutputValidationSupported(validation);
    validateAgentActionValueImage(resolution.responseValueImageBytes, validation);
  } catch (error) {
    fail('ERR_CAPABILITY_REUSABLE_EFFECT_OUTPUT_INVALID', 'reusable model effect output does not satisfy route validation', {
      error: error?.code ?? String(error?.message ?? error),
    });
  }
}

function assertModelOutputValidationSupported(validation) {
  if (validation?.outputSchema !== 'boundary.Agent.Action.v0') {
    fail('ERR_CAPABILITY_REUSABLE_EFFECT_OUTPUT_VALIDATION_UNSUPPORTED');
  }
}

function validateAgentActionValueImage(responseValueImageBytes, validation) {
  let payload;
  try {
    const payloadBytes = decodeCanonicalValueImage(responseValueImageBytes).payload;
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    fail('ERR_AGENT_ACTION_MALFORMED');
  }
  const action = payload?.schema === 'boundary.Agent.Action.v0' ? payload.action : payload?.body;
  validateAgentAction(action, validation);
}

function validateAgentAction(action, validation) {
  const allowedToolIds = new Set(validation.allowedToolIds ?? []);
  if (!action || typeof action !== 'object' || typeof action.variant !== 'string') {
    fail('ERR_AGENT_ACTION_MALFORMED');
  }
  if (action.variant === 'final') {
    if (typeof action.text !== 'string') fail('ERR_AGENT_ACTION_MALFORMED');
    return;
  }
  if (action.variant === 'tool') {
    if (typeof action.toolId !== 'string' || typeof action.payload !== 'string') fail('ERR_AGENT_ACTION_MALFORMED');
    if (!allowedToolIds.has(action.toolId)) fail('ERR_AGENT_ACTION_TOOL_UNKNOWN');
    return;
  }
  if (action.variant === 'defer') {
    if (typeof action.reason !== 'string') fail('ERR_AGENT_ACTION_MALFORMED');
    return;
  }
  fail('ERR_AGENT_ACTION_MALFORMED');
}

function assertReusableResolutionStatusAccepted(status, request, route) {
  const expectedStatus = request.responseSchema?.status;
  if (expectedStatus === undefined) {
    const manifestStatuses = new Set((route.supportedResponseStatuses ?? []).map((item) => ResponseStatusCode[item]));
    if (!manifestStatuses.has(status)) fail('ERR_CAPABILITY_REUSABLE_EFFECT_STATUS_UNSUPPORTED', 'reusable effect status is not supported by the selected route');
    return;
  }
  const expectedWireStatus = ResponseStatusCode[expectedStatus];
  if (expectedWireStatus === undefined || status !== expectedWireStatus) {
    fail('ERR_CAPABILITY_REUSABLE_EFFECT_STATUS_MISMATCH', 'reusable effect status does not match the pending request schema');
  }
}

function hostRequestTargetFingerprint(request) {
  const value = request.hostRequestFingerprint;
  if (typeof value === 'bigint' || typeof value === 'number') return BigInt(value);
  const match = String(value ?? '').match(/^(?:world:host-request:|0x)([0-9a-f]+)$/i);
  if (!match) fail('ERR_HOST_REQUEST_FINGERPRINT_REQUIRED');
  return BigInt(`0x${match[1]}`);
}

function blobRefKey(ref) {
  return `${ref?.algorithm}:${ref?.checksum}:${ref?.byteLength}`;
}

function addUniqueBlocker(blockers, code) {
  if (!blockers.includes(code)) blockers.push(code);
}

function addUniqueBlockers(blockers, codes) {
  for (const code of codes) addUniqueBlocker(blockers, code);
}

function reusableRecordCanRerun(record, route, currentBranchId = null, currentParentTurnClosureFingerprint = null) {
  const effectiveState = reusableRecordEffectiveState(record, currentBranchId, currentParentTurnClosureFingerprint);
  if (effectiveState !== 'resolved') return false;
  if (!record?.requestBytesRef) return false;
  if (record.driverRecoveryClass && route?.recoveryClass && record.driverRecoveryClass !== route.recoveryClass) return false;
  const recoveryClass = record.driverRecoveryClass ?? route?.recoveryClass;
  return recoveryClass === EffectRecoveryClass.pure || recoveryClass === EffectRecoveryClass.idempotent;
}

function reusableRecordEffectiveState(record, currentBranchId = null, currentParentTurnClosureFingerprint = null) {
  return (
    ['submitted', 'closure_committed'].includes(record?.state) &&
    (
      (currentBranchId && record?.branchId !== currentBranchId) ||
      (currentBranchId && currentParentTurnClosureFingerprint &&
        record?.branchId === currentBranchId &&
        record?.parentTurnClosureFingerprint !== currentParentTurnClosureFingerprint)
    )
  )
    ? 'resolved'
    : record?.state;
}

function currentHeadParentTurnClosureFingerprint(currentHead) {
  if (typeof currentHead?.turnClosureWorldFingerprint === 'string' && currentHead.turnClosureWorldFingerprint.length > 0) {
    return currentHead.turnClosureWorldFingerprint;
  }
  const updateParent = currentHead?.updateDiagnostics?.parentTurnClosureFingerprint;
  return typeof updateParent === 'string' && updateParent.length > 0 ? updateParent : null;
}

function reusableRequestIdentity(request, route) {
  try {
    const idempotencyKeyBytes = assertBytes(request.idempotencyKeyBytes, 'idempotencyKeyBytes');
    const requestBytes = assertBytes(request.requestBytes, 'requestBytes');
    const requestBytesChecksum = `sha256:${createHash('sha256').update(requestBytes).digest('hex')}`;
    const routeIdentity = request.effectIdentityBytes === undefined ? routeEffectIdentity(request, route) : null;
    const effectIdentityBytes = request.effectIdentityBytes === undefined
      ? routeIdentity?.bytes ?? requestBytes
      : assertBytes(request.effectIdentityBytes, 'effectIdentityBytes');
    return {
      idempotencyKeyBytesHex: toHex(idempotencyKeyBytes),
      requestBytesChecksum,
      requestIdentityChecksum: `sha256:${createHash('sha256').update(effectIdentityBytes).digest('hex')}`,
      rawRequestIdentityUpgradeAllowed: routeIdentity?.rawRequestIdentityUpgradeAllowed === true,
    };
  } catch {
    return null;
  }
}

function reusableRecordIdentityMatches(record, request, identity) {
  if (record.hostRequestFingerprint !== request.hostRequestFingerprint) return false;
  const recordIdentityChecksum = record.requestIdentityChecksum ?? record.requestBytesChecksum;
  if (recordIdentityChecksum === identity.requestIdentityChecksum) return true;
  return rawReusableIdentityCanUpgrade(record, identity);
}

function rawReusableIdentityCanUpgrade(record, identity) {
  const recordWasRawRequestIdentity = record.requestIdentityChecksum == null ||
    record.requestIdentityChecksum === record.requestBytesChecksum;
  return recordWasRawRequestIdentity &&
    identity.rawRequestIdentityUpgradeAllowed === true &&
    record.requestBytesChecksum === identity.requestBytesChecksum &&
    identity.requestIdentityChecksum !== identity.requestBytesChecksum;
}

function routeEffectIdentity(request, route) {
  const endpointSource = route?.diagnostics?.endpointSource;
  if (endpointSource !== 'config' && endpointSource !== 'request-or-config') {
    return rawHttpRouteEffectIdentity(request, route);
  }
  const requestRendering = route?.diagnostics?.requestRendering ?? null;
  let parsed = {};
  try {
    const requestBytes = assertBytes(request.requestBytes, 'requestBytes');
    parsed = JSON.parse(new TextDecoder().decode(requestBytes));
  } catch {
    return null;
  }
  const identityRequest = canonicalHttpIdentityRequest(
    route?.diagnostics,
    parsed,
    shouldCanonicalizeDefaultHttpMethod(route, request),
  );
  if (endpointSource === 'request-or-config' && identityRequest?.url !== undefined && identityRequest.method !== undefined) {
    return requestRendering === null && !hasModelOutputValidation(route?.diagnostics) && httpIdentityRequestEquivalent(parsed, identityRequest)
      ? null
      : {
          bytes: fromUtf8(stableJson(effectIdentityPayload(route?.diagnostics, identityRequest, null, requestRendering))),
          rawRequestIdentityUpgradeAllowed: false,
        };
  }
  const configuredEndpoint = configuredEffectIdentityTargetForRoute(route, identityRequest);
  if (!configuredEndpoint && requestRendering === null && !hasModelOutputValidation(route?.diagnostics)) return null;
  return {
    bytes: fromUtf8(stableJson(effectIdentityPayload(route?.diagnostics, identityRequest, configuredEndpoint, requestRendering))),
    rawRequestIdentityUpgradeAllowed: false,
  };
}

function rawHttpRouteEffectIdentity(request, route) {
  if (!shouldCanonicalizeDefaultHttpMethod(route, request)) return null;
  let parsed = {};
  try {
    const requestBytes = assertBytes(request.requestBytes, 'requestBytes');
    parsed = JSON.parse(new TextDecoder().decode(requestBytes));
  } catch {
    return null;
  }
  const identityRequest = canonicalHttpIdentityRequest(route?.diagnostics, parsed, true);
  if (!httpIdentityRequestHasMethod(identityRequest)) return null;
  return {
    bytes: fromUtf8(stableJson(effectIdentityPayload(route?.diagnostics, identityRequest, null, null))),
    rawRequestIdentityUpgradeAllowed: true,
  };
}

function httpIdentityRequestHasMethod(request) {
  return request?.method !== undefined && request.method !== null;
}

function httpIdentityRequestEquivalent(left, right) {
  return stableJson(left) === stableJson(right);
}

function configuredEffectIdentityTargetForRoute(route, parsed = {}) {
  const origins = Array.isArray(route?.diagnostics?.origins) ? route.diagnostics.origins : [];
  const methods = Array.isArray(route?.diagnostics?.methods) ? route.diagnostics.methods : [];
  const endpointSource = route?.diagnostics?.endpointSource;
  const requestUrl = endpointSource === 'request-or-config' && parsed?.url !== undefined ? parsed.url : null;
  const url = requestUrl ?? route?.diagnostics?.configuredEndpointUrl ?? route?.diagnostics?.configuredOrigin ?? (origins.length === 1 ? origins[0] : null);
  const method = normalizedHttpMethod(parsed.method ?? route?.diagnostics?.defaultMethod ?? (methods.length === 1 ? methods[0] : null));
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

function shouldCanonicalizeDefaultHttpMethod(route, request) {
  return request?.actuationClass === 'http' || (route?.supportedActuationClasses ?? []).includes('http');
}

function canonicalHttpIdentityRequest(diagnostics, request, defaultMethodAllowed) {
  if (!plainHttpIdentityObject(request)) return request;
  if (request?.method !== undefined) return normalizedHttpMethodRequest(request);
  if (!defaultMethodAllowed) return normalizedHttpMethodRequest(request);
  const method = defaultHttpMethodForDiagnostics(diagnostics);
  return method == null ? normalizedHttpMethodRequest(request) : { ...request, method };
}

function defaultHttpMethodForDiagnostics(diagnostics) {
  const methods = Array.isArray(diagnostics?.methods) ? diagnostics.methods : [];
  return normalizedHttpMethod(diagnostics?.defaultMethod ?? (methods.length === 1 ? methods[0] : null));
}

function normalizedHttpMethodRequest(request) {
  if (!plainHttpIdentityObject(request)) return request;
  if (request?.method === undefined) return request;
  return { ...request, method: normalizedHttpMethod(request.method) };
}

function plainHttpIdentityObject(request) {
  return request !== null && typeof request === 'object' && !Array.isArray(request);
}

function normalizedHttpMethod(method) {
  return method == null ? null : String(method).toUpperCase();
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
  const promptByteLength = requestPolicyPromptByteLength(route, request);
  if (request && policy.maximumPromptBytes !== undefined && promptByteLength > policy.maximumPromptBytes) blockers.push('prompt-limit-exceeds-policy');
  if (policy.maximumResponseBytes !== undefined && route.maximumResponseBytes > policy.maximumResponseBytes) blockers.push('response-limit-exceeds-policy');
  if (request && routeRequiresApproval(route, request, policy)) blockers.push('ERR_CAPABILITY_APPROVAL_REQUIRED');
  const allowedFileRoots = policy.allowedFileRoots ?? new Set();
  if (isFileRoute(route, request)) {
    if (!allowedFileRoots.size) blockers.push('file-root-allowlist-required');
    const root = route.diagnostics?.root;
    if (allowedFileRoots.size && (!root || !allowedFileRoots.has(root))) blockers.push(`file-root-denied:${root ?? 'unknown'}`);
  }
  if (isHumanRoute(route, request) && policy.allowHumanEffects !== true) blockers.push('ERR_CAPABILITY_HUMAN_DENIED');
  if (isHttpRoute(route, request)) {
    const driverOrigins = Array.isArray(route.diagnostics?.origins) ? new Set(route.diagnostics.origins) : null;
    const driverMethods = Array.isArray(route.diagnostics?.methods)
      ? new Set(route.diagnostics.methods.map((item) => String(item).toUpperCase()))
      : null;
    if (!request) {
      if (!driverOrigins?.size) blockers.push('http-origin-denied:unknown');
      else if (!policy.allowedHttpOrigins.size) blockers.push('http-origin-allowlist-required');
      else if (!setsIntersect(driverOrigins, policy.allowedHttpOrigins)) blockers.push(`http-origin-denied:${[...driverOrigins].join(',')}`);
      if (!driverMethods?.size) blockers.push('http-method-denied:unknown');
      else if (!policy.allowedHttpMethods.size) blockers.push('http-method-allowlist-required');
      else if (!setsIntersect(driverMethods, policy.allowedHttpMethods)) blockers.push(`http-method-denied:${[...driverMethods].join(',')}`);
    } else {
      const origin = requestOriginForRoute(request, route);
      if (driverOrigins && (!origin || !driverOrigins.has(origin))) blockers.push(`http-origin-driver-denied:${origin ?? 'unknown'}`);
      if (!origin) blockers.push('http-origin-denied:unknown');
      else if (!policy.allowedHttpOrigins.size) blockers.push('http-origin-allowlist-required');
      else if (!policy.allowedHttpOrigins.has(origin)) blockers.push(`http-origin-denied:${origin}`);
      const method = requestMethodForRoute(request, route);
      if (driverMethods && (!method || !driverMethods.has(method))) blockers.push(`http-method-driver-denied:${method ?? 'unknown'}`);
      if (!method) blockers.push('http-method-denied:unknown');
      else if (!policy.allowedHttpMethods.size) blockers.push('http-method-allowlist-required');
      else if (!policy.allowedHttpMethods.has(method)) blockers.push(`http-method-denied:${method}`);
    }
  }
  return blockers;
}

function routeRequiresApproval(route, request, policy) {
  return (policy.requireApprovalForNetworkEffects && isHttpRoute(route, request)) ||
    (policy.requireApprovalForDestructiveEffects && isDestructiveFileRequest(route, request)) ||
    (policy.requireApprovalForBestEffort && route.recoveryClass === EffectRecoveryClass.bestEffort);
}

function isDestructiveFileRequest(route, request) {
  if (!isFileRoute(route, request)) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(request.requestBytes));
    return payload?.operation !== 'read';
  } catch {
    return true;
  }
}

function requestPolicyPromptByteLength(route, request) {
  return hostRequestPolicyPromptByteLength(route, request);
}

export function hostRequestPolicyPromptByteLength(manifest, hostRequest) {
  if (!hostRequest) return undefined;
  if (hostRequest.policyRequestBytes) return hostRequest.policyRequestBytes.byteLength;
  if (isLiveModelRoute(manifest, hostRequest) || isHumanRoute(manifest, hostRequest)) return hostRequest.requestBytes?.byteLength;
  if (isHttpRoute(manifest, hostRequest)) return httpRequestBodyPolicyByteLength(manifest, hostRequest);
  return undefined;
}

function httpRequestBodyPolicyByteLength(route, request) {
  if (bodylessHttpMethod(requestMethodForRoute(request, route))) return 0;
  if (route?.driverId === 'generic-http-json' && route?.diagnostics?.requestRendering?.requestTemplateFingerprint) {
    return requestTemplateBodyByteLength(route.diagnostics.requestRendering);
  }
  try {
    const payload = JSON.parse(new TextDecoder().decode(request.requestBytes));
    const rendered = route?.driverId === 'http-json'
      ? (Object.prototype.hasOwnProperty.call(payload, 'body') ? JSON.stringify(payload.body) : undefined)
      : stableJson(Object.prototype.hasOwnProperty.call(payload, 'body') ? payload.body : payload);
    return rendered === undefined ? 0 : fromUtf8(rendered).byteLength;
  } catch {
    return undefined;
  }
}

function requestTemplateBodyByteLength(requestRendering) {
  const byteLength = requestRendering?.requestTemplateBodyBytes;
  return Number.isSafeInteger(byteLength) && byteLength >= 0 ? byteLength : undefined;
}

function bodylessHttpMethod(method) {
  return method === 'GET' || method === 'HEAD';
}

function setsIntersect(left, right) {
  for (const item of left) {
    if (right.has(item)) return true;
  }
  return false;
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

function findDriverManifestForOversizedRequest(manifests, request, preferredAuthorityLabels = []) {
  return selectPreferredAuthorityManifest(manifests.filter((manifest) =>
    driverMatchesExceptRequestSize(manifest, request)), preferredAuthorityLabels);
}

function driverMatchesExceptRequestSize(manifest, request) {
  return manifest.supportedActuatorRefs.includes(request.actuatorRef) &&
    manifest.supportedDescriptorFingerprints.includes(request.descriptorFingerprint) &&
    manifest.supportedActuationClasses.includes(request.actuationClass) &&
    (!request.responseSchema || manifest.supportedResponseStatuses.includes(request.responseSchema.status)) &&
    request.requestBytes?.byteLength > manifest.maximumRequestBytes;
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

function selectPendingRequestRoute(candidates, preferredAuthorityLabels, request, policy, effectRecords, selectedLiveModelRequestCount, currentBranchId = null, currentParentTurnClosureFingerprint = null, effectResolutionInputs = new Map()) {
  const selected = selectPreferredAuthorityManifest(candidates, preferredAuthorityLabels);
  if (!chargesLiveModelBudget(selected, request, effectRecords, currentBranchId, currentParentTurnClosureFingerprint, effectResolutionInputs, policy)) return selected;

  const nonChargingCandidates = candidates.filter((manifest) =>
    !chargesLiveModelBudget(manifest, request, effectRecords, currentBranchId, currentParentTurnClosureFingerprint, effectResolutionInputs, policy));
  if (!nonChargingCandidates.length) {
    return policy.allowPartialEffectBatch === true && selectedLiveModelRequestCount >= policy.maximumLiveModelCalls ? null : selected;
  }
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

function selectedPendingRequestRouteDriverId(candidates, preferredAuthorityLabels) {
  return selectPreferredAuthorityManifest(candidates, preferredAuthorityLabels)?.driverId ?? null;
}

function unresolvedPendingRequestRoute(route, request, blockers) {
  return {
    actuatorRef: request.actuatorRef,
    descriptorFingerprint: request.descriptorFingerprint,
    hostRequestFingerprint: request.hostRequestFingerprint ?? null,
    ...(Number.isSafeInteger(request.pendingRequestIndex) ? { pendingRequestIndex: request.pendingRequestIndex } : {}),
    driverId: route?.driverId ?? null,
    driverIndex: route?.driverIndex ?? null,
    blockers: [...blockers],
  };
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
  if (report.blockers.length === 1 && report.blockers[0] === 'ERR_CAPABILITY_AUDIT_ONLY_DENIED') {
    fail('ERR_CAPABILITY_AUDIT_ONLY_DENIED', 'capability preflight audit-only denied', { blockers: report.blockers });
  }
  if (report.blockers.length) fail('ERR_CAPABILITY_PREFLIGHT_BLOCKED', 'capability preflight blocked', { blockers: report.blockers });
  return true;
}

export { EffectRecoveryClass };

function requestOriginForRoute(request, route) {
  try {
    if (!request) return configuredRouteOrigin(route);
    const text = new TextDecoder().decode(request.requestBytes);
    const value = JSON.parse(text);
    if (fixedConfiguredEndpointRoute(route)) return configuredRouteOrigin(route);
    if (value.url === undefined && configuredEndpointRoute(route)) return configuredRouteOrigin(route);
    return validatedRequestUrlOrigin(value.url);
  } catch {
    return null;
  }
}

function validatedRequestUrlOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (credentialUrlPathOrFragment(parsed) || credentialUrlQuery(parsed)) return null;
  return parsed.origin;
}

function credentialUrlPathOrFragment(url) {
  const pathname = decodeUrlComponent(url.pathname);
  const hash = decodeUrlComponent(url.hash);
  if (credentialQueryValue(pathname) || credentialQueryValue(hash) || credentialAssignmentText(pathname) || credentialAssignmentText(hash)) {
    return true;
  }
  const pathSegments = pathname.split('/').filter(Boolean);
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    if (credentialPathKey(pathSegments[index]) && !credentialUrlSentinel(pathSegments[index + 1])) return true;
  }
  return false;
}

function credentialUrlQuery(url) {
  for (const [key, value] of url.searchParams) {
    if (credentialQueryKey(key) || credentialQueryValue(value) || credentialAssignmentText(value)) return true;
  }
  return false;
}

function credentialQueryKey(value) {
  return /credential|authorization|bearer|token|secret|password|(?:api|access|private)[_-]?key/i.test(value);
}

function credentialQueryValue(value) {
  return /\b(?:bearer|basic)\s+\S+/i.test(value) || /sk-[A-Za-z0-9_-]{8,}/.test(value);
}

function credentialAssignmentText(value) {
  return /(?:^|[\/#?&;,\s{])(?:credential|authorization|bearer|token|secret|password|(?:api|access|private)[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}={0,2}/i.test(value);
}

function credentialPathKey(value) {
  return /^(?:credentials?|authorization|bearer|tokens?|secrets?|password|(?:api|access|private)[_-]?keys?)$/i.test(value);
}

function credentialUrlSentinel(value) {
  return /^(?:redacted|opaque|required|none|null|example(?:[-_].*)?|fixture(?:[-_].*)?|no-(?:credentials?|secrets?|tokens?))$/i.test(value);
}

function decodeUrlComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function requestMethodForRoute(request, route) {
  try {
    if (!request) return configuredRouteMethod(route);
    const text = new TextDecoder().decode(request.requestBytes);
    const value = JSON.parse(text);
    if (fixedConfiguredEndpointRoute(route)) return String(value.method ?? configuredRouteMethod(route) ?? 'POST').toUpperCase();
    if (value.url === undefined && configuredEndpointRoute(route)) return String(value.method ?? configuredRouteMethod(route) ?? 'POST').toUpperCase();
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

function requestRoutedEndpointRoute(route) {
  return route?.diagnostics?.endpointSource === 'request-or-config';
}

function configuredRouteOrigin(route) {
  if (route?.diagnostics?.configuredOrigin) return route.diagnostics.configuredOrigin;
  if (route?.diagnostics?.configuredEndpointUrl) {
    try {
      return new URL(route.diagnostics.configuredEndpointUrl).origin;
    } catch {
      return null;
    }
  }
  const origins = Array.isArray(route?.diagnostics?.origins) ? route.diagnostics.origins : [];
  return origins.length === 1 ? origins[0] : null;
}

function configuredRouteMethod(route) {
  if (route?.diagnostics?.defaultMethod) return String(route.diagnostics.defaultMethod).toUpperCase();
  const methods = Array.isArray(route?.diagnostics?.methods) ? route.diagnostics.methods : [];
  return methods.length === 1 ? String(methods[0]).toUpperCase() : null;
}

function isHttpRoute(route, request) {
  return request?.actuationClass === 'http' ||
    (route?.supportedActuationClasses ?? []).includes('http') ||
    (route?.authorityLabels ?? []).some((label) => label.startsWith('network:'));
}

function isLiveModelRoute(route, request) {
  const modelLabels = (route?.authorityLabels ?? []).filter((label) => label.startsWith('model:'));
  const liveModelLabels = modelLabels.filter((label) => !fixtureModelLabel(label));
  const modelCapable = request?.actuationClass === 'model' ||
    (route?.supportedActuationClasses ?? []).includes('model') ||
    liveModelLabels.length > 0;
  if (!modelCapable) return false;
  if (!liveModelLabels.length && hasDeterministicFixtureModelAuthority(route, modelLabels)) return false;
  return true;
}

function hasDeterministicFixtureModelAuthority(route, modelLabels = (route?.authorityLabels ?? []).filter((label) => label.startsWith('model:'))) {
  if (route?.diagnostics?.deterministic !== true) return false;
  return modelLabels.length > 0 && modelLabels.every(fixtureModelLabel);
}

function fixtureModelLabel(label) {
  return FIXTURE_MODEL_AUTHORITY_LABELS.has(label);
}

function chargesLiveModelBudget(
  route,
  request,
  effectRecords,
  currentBranchId = null,
  currentParentTurnClosureFingerprint = null,
  effectResolutionInputs = new Map(),
  policy = createRunPolicy(),
  reusableEffectBlockers = [],
  nonRerunnableReusableEffectBlockers = [],
) {
  return isLiveModelRoute(route, request) && !hasReusableEffectOutcome(
    request,
    effectRecords,
    route,
    currentBranchId,
    currentParentTurnClosureFingerprint,
    effectResolutionInputs,
    policy,
    reusableEffectBlockers,
    nonRerunnableReusableEffectBlockers,
  );
}
