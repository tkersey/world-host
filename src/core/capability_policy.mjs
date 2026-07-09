import { EffectRecoveryClass } from './actuator.mjs';
import { immutablePolicySet } from './immutable_set.mjs';
import { fail } from './store.mjs';

const FIXTURE_MODEL_AUTHORITY_LABELS = new Set(['model:fixture', 'model:fixture-agent']);
const APPLY = Reflect.apply;
const NativeString = String;
const STRING_TO_UPPER_CASE = String.prototype.toUpperCase;

export function createCapabilityPolicy(input = {}) {
  return new CapabilityPolicy(input);
}

export class CapabilityPolicy {
  constructor(input = {}) {
    this.allowLiveEffects = input.allowLiveEffects === true;
    this.allowNetworkEffects = input.allowNetworkEffects === true;
    this.allowFileEffects = input.allowFileEffects === true;
    this.allowHumanEffects = input.allowHumanEffects === true;
    this.allowBestEffort = input.allowBestEffort === true;
    this.requireApprovalForDestructiveEffects = input.requireApprovalForDestructiveEffects !== false;
    this.requireApprovalForNetworkEffects = input.requireApprovalForNetworkEffects === true;
    this.requireApprovalForBestEffort = input.requireApprovalForBestEffort !== false;
    this.maximumLiveModelCalls = nonNegativeSafeInteger(input.maximumLiveModelCalls ?? 0, 'maximumLiveModelCalls');
    this.maximumRequestBytes = positiveSafeInteger(input.maximumRequestBytes ?? 1024 * 1024, 'maximumRequestBytes');
    this.maximumPromptBytes = positiveSafeInteger(input.maximumPromptBytes ?? this.maximumRequestBytes, 'maximumPromptBytes');
    this.maximumResponseBytes = positiveSafeInteger(input.maximumResponseBytes ?? 1024 * 1024, 'maximumResponseBytes');
    this.allowedOrigins = immutablePolicySet(input.allowedOrigins);
    this.allowedMethods = immutablePolicySet(input.allowedMethods, upperCaseString);
    this.allowedFileRoots = immutablePolicySet(input.allowedFileRoots);
    this.allowedAuthorityLabels = immutablePolicySet(input.allowedAuthorityLabels);
    this.allowedCapabilityPacks = immutablePolicySet(input.allowedCapabilityPacks);
    this.deniedCapabilityPacks = immutablePolicySet(input.deniedCapabilityPacks);
    this.redactionPolicy = input.redactionPolicy ?? 'secret-shaped';
    this.dryRun = input.dryRun === true;
    this.shadowMode = input.shadowMode === true;
    this.auditOnly = input.auditOnly === true;
    Object.freeze(this.allowedOrigins);
    Object.freeze(this.allowedMethods);
    Object.freeze(this.allowedFileRoots);
    Object.freeze(this.allowedAuthorityLabels);
    Object.freeze(this.allowedCapabilityPacks);
    Object.freeze(this.deniedCapabilityPacks);
    Object.freeze(this);
  }
}

export class LiveRunPolicy extends CapabilityPolicy {
  constructor(input = {}) {
    super({ ...input, allowLiveEffects: input.allowLiveEffects === true });
  }
}

export function assertCapabilityPolicyAllows({
  manifest,
  hostRequest = null,
  policy: inputPolicy = {},
  mode = 'live',
  action = null,
  enforceNetworkTarget = true,
  requireEffectOptIn = true,
  checkNetworkTarget = true,
  checkFileRoot = true,
  checkRecoveryClass = true,
  checkLiveModelBudget = true,
  enforceApprovalRequirements = true,
}) {
  const policy = createCapabilityPolicy(inputPolicy);
  if (mode === 'live' && policy.auditOnly === true) fail('ERR_CAPABILITY_AUDIT_ONLY_DENIED');
  if (mode === 'live' && policy.allowLiveEffects !== true) fail('ERR_CAPABILITY_LIVE_DENIED');
  if (policy.deniedCapabilityPacks.has(manifest?.packFingerprint) || policy.deniedCapabilityPacks.has(manifest?.driverId)) {
    fail('ERR_CAPABILITY_PACK_DENIED');
  }
  if (
    policy.allowedCapabilityPacks.size &&
    !policy.allowedCapabilityPacks.has(manifest?.packFingerprint) &&
    !policy.allowedCapabilityPacks.has(manifest?.driverId)
  ) {
    fail('ERR_CAPABILITY_PACK_NOT_ALLOWED');
  }
  const authorityLabels = manifest?.authorityLabels ?? [];
  const deniedAuthorityLabels = authorityLabels.filter((label) => policy.allowedAuthorityLabels.size && !policy.allowedAuthorityLabels.has(label));
  if (deniedAuthorityLabels.length) fail('ERR_CAPABILITY_AUTHORITY_DENIED', 'authority label denied', { labels: deniedAuthorityLabels });
  if (requireEffectOptIn && isNetwork(manifest, hostRequest) && policy.allowNetworkEffects !== true) fail('ERR_CAPABILITY_NETWORK_DENIED');
  if (requireEffectOptIn && isFile(manifest, hostRequest) && policy.allowFileEffects !== true) fail('ERR_CAPABILITY_FILE_DENIED');
  if (requireEffectOptIn && isHuman(manifest, hostRequest) && policy.allowHumanEffects !== true) fail('ERR_CAPABILITY_HUMAN_DENIED');
  if (checkLiveModelBudget && mode === 'live' && isLiveModelCall(manifest, hostRequest) && policy.maximumLiveModelCalls < 1) fail('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED');
  if (checkRecoveryClass && manifest?.recoveryClass === EffectRecoveryClass.bestEffort && policy.allowBestEffort !== true) fail('ERR_BEST_EFFORT_REQUIRES_OPERATOR_OPT_IN');
  if (hostRequest?.requestBytes?.byteLength > policy.maximumRequestBytes) fail('ERR_CAPABILITY_PROMPT_TOO_LARGE');
  const promptBytes = hostRequest?.policyRequestBytes ?? (isLiveModelCall(manifest, hostRequest) || isHuman(manifest, hostRequest) ? hostRequest?.requestBytes : undefined);
  if (promptBytes?.byteLength > policy.maximumPromptBytes) fail('ERR_CAPABILITY_PROMPT_TOO_LARGE');
  if (manifest?.maximumResponseBytes > policy.maximumResponseBytes) fail('ERR_CAPABILITY_RESPONSE_LIMIT_EXCEEDS_POLICY');
  if (checkNetworkTarget && isNetwork(manifest, hostRequest)) {
    if (enforceNetworkTarget) {
      assertOriginAndMethodAllowed(hostRequest, policy);
    } else {
      assertNetworkAllowlistsPresent(policy);
    }
  }
  if (checkFileRoot) assertFileRootAllowed(manifest, hostRequest, policy);
  const approved = action?.approved === true;
  if (enforceApprovalRequirements && (action?.destructive === true || isDestructiveHostRequest(manifest, hostRequest)) && policy.requireApprovalForDestructiveEffects && !approved) fail('ERR_CAPABILITY_APPROVAL_REQUIRED');
  if (enforceApprovalRequirements && isNetwork(manifest, hostRequest) && policy.requireApprovalForNetworkEffects && !approved) fail('ERR_CAPABILITY_APPROVAL_REQUIRED');
  if (enforceApprovalRequirements && manifest?.recoveryClass === EffectRecoveryClass.bestEffort && policy.requireApprovalForBestEffort && !approved) fail('ERR_CAPABILITY_APPROVAL_REQUIRED');
  return true;
}

export function createAuthorityGrant(input = {}) {
  return new AuthorityGrant(input);
}

export function createApprovalPolicy(input = {}) {
  return new ApprovalPolicy(input);
}

export class AuthorityGrant {
  constructor(input = {}) {
    this.authorityLabels = immutablePolicySet(input.authorityLabels);
    this.capabilityPacks = immutablePolicySet(input.capabilityPacks);
    this.origins = immutablePolicySet(input.origins);
    this.fileRoots = immutablePolicySet(input.fileRoots);
    this.receiverLocal = input.receiverLocal !== false;
    Object.freeze(this.authorityLabels);
    Object.freeze(this.capabilityPacks);
    Object.freeze(this.origins);
    Object.freeze(this.fileRoots);
    Object.freeze(this);
  }
}

export class ApprovalPolicy {
  constructor(input = {}) {
    this.requireForDestructiveEffects = input.requireForDestructiveEffects !== false;
    this.requireForNetworkEffects = input.requireForNetworkEffects === true;
    this.requireForBestEffort = input.requireForBestEffort !== false;
    this.noninteractiveDefault = input.noninteractiveDefault ?? 'deny';
    Object.freeze(this);
  }
}

export function redactCapabilityDiagnostics(value) {
  return redactCapabilityDiagnosticsValue(value, new WeakSet());
}

function redactCapabilityDiagnosticsValue(value, seen) {
  if (typeof value === 'string') return secretLike(value) ? '[redacted]' : value;
  if (value instanceof ArrayBuffer) return `[bytes:${value.byteLength}]`;
  if (ArrayBuffer.isView(value)) return `[bytes:${value.byteLength}]`;
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const redacted = value.map((item) => redactCapabilityDiagnosticsValue(item, seen));
    seen.delete(value);
    return redacted;
  }
  if (value instanceof Map) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const redacted = {};
    let index = 0;
    for (const [key, child] of value.entries()) {
      if (typeof key === 'string' && concreteSecretKeyMaterial(key)) continue;
      Object.defineProperty(redacted, typeof key === 'string' ? key : `map:${index}`, {
        value: typeof key === 'string' && secretLike(key) ? '[redacted]' : redactCapabilityDiagnosticsValue(child, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      index += 1;
    }
    seen.delete(value);
    return redacted;
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const redacted = Object.fromEntries(Object.entries(value)
    .filter(([key]) => !concreteSecretKeyMaterial(key))
    .map(([key, child]) => [key, secretLike(key) ? '[redacted]' : redactCapabilityDiagnosticsValue(child, seen)]));
  seen.delete(value);
  return redacted;
}

function isNetwork(manifest, hostRequest) {
  return hostRequest?.actuationClass === 'http' ||
    (manifest?.supportedActuationClasses ?? []).includes('http') ||
    (manifest?.authorityLabels ?? []).some((label) => label.startsWith('network:'));
}

function isFile(manifest, hostRequest) {
  return hostRequest?.actuationClass === 'file' ||
    (manifest?.supportedActuationClasses ?? []).includes('file') ||
    (manifest?.authorityLabels ?? []).some((label) => label.startsWith('file:'));
}

function isHuman(manifest, hostRequest) {
  return hostRequest?.actuationClass === 'human' ||
    (manifest?.supportedActuationClasses ?? []).includes('human') ||
    (manifest?.authorityLabels ?? []).some((label) => label.startsWith('human:'));
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

function assertOriginAndMethodAllowed(hostRequest, policy) {
  if (!hostRequest?.requestBytes) fail('ERR_CAPABILITY_NETWORK_TARGET_REQUIRED');
  const parsed = parseJsonRequest(hostRequest);
  if (!parsed?.url) fail('ERR_CAPABILITY_NETWORK_TARGET_REQUIRED');
  let url;
  try {
    url = new URL(parsed.url);
  } catch {
    fail('ERR_CAPABILITY_NETWORK_TARGET_REQUIRED');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('ERR_CAPABILITY_NETWORK_TARGET_REQUIRED', 'network target must be http(s)');
  if (url.username || url.password) fail('ERR_CAPABILITY_NETWORK_TARGET_REQUIRED', 'network target must not include credentials');
  if (credentialUrlPathOrFragment(url) || credentialUrlQuery(url)) {
    fail('ERR_CAPABILITY_NETWORK_TARGET_REQUIRED', 'network target must not include credentials');
  }
  const origin = url.origin;
  if (!policy.allowedOrigins.size) fail('ERR_CAPABILITY_ORIGIN_ALLOWLIST_REQUIRED');
  if (!policy.allowedOrigins.has(origin)) fail('ERR_CAPABILITY_ORIGIN_DENIED', `origin denied: ${origin}`);
  if (!policy.allowedMethods.size) fail('ERR_CAPABILITY_METHOD_ALLOWLIST_REQUIRED');
  const method = parsed.method === undefined ? null : String(parsed.method).toUpperCase();
  if (method === null) fail('ERR_CAPABILITY_METHOD_REQUIRED');
  if (!policy.allowedMethods.has(method)) fail('ERR_CAPABILITY_METHOD_DENIED', `method denied: ${method}`);
}

function assertNetworkAllowlistsPresent(policy) {
  if (!policy.allowedOrigins.size) fail('ERR_CAPABILITY_ORIGIN_ALLOWLIST_REQUIRED');
  if (!policy.allowedMethods.size) fail('ERR_CAPABILITY_METHOD_ALLOWLIST_REQUIRED');
}

function credentialUrlPathOrFragment(url) {
  const pathname = decodeURIComponentSafe(url.pathname);
  const hash = decodeURIComponentSafe(url.hash);
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
  for (const [key, value] of url.searchParams.entries()) {
    if (credentialQueryKey(key) || credentialQueryValue(value) || credentialAssignmentText(value)) return true;
  }
  return false;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function credentialQueryKey(value) {
  return /credential|authorization|bearer|token|secret|password|(?:api|access|private)[_-]?key/i.test(value);
}

function credentialQueryValue(value) {
  return /sk-[A-Za-z0-9_-]{8,}/.test(value) ||
    /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{8,}={0,2}/i.test(value);
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

function assertFileRootAllowed(manifest, hostRequest, policy) {
  if (!isFile(manifest, hostRequest)) return;
  if (!policy.allowedFileRoots.size) fail('ERR_CAPABILITY_FILE_ROOT_ALLOWLIST_REQUIRED');
  const root = manifest?.diagnostics?.root ?? manifest?.policyRequirements?.root;
  if (!root || !policy.allowedFileRoots.has(root)) fail('ERR_CAPABILITY_FILE_ROOT_DENIED', `file root denied: ${root ?? 'unknown'}`);
}

function isDestructiveHostRequest(manifest, hostRequest) {
  if (!isFile(manifest, hostRequest)) return false;
  const request = parseJsonRequest(hostRequest);
  return request?.operation !== 'read';
}

function parseJsonRequest(hostRequest) {
  try {
    return JSON.parse(new TextDecoder().decode(hostRequest.requestBytes));
  } catch {
    return null;
  }
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail('ERR_CAPABILITY_POLICY_LIMIT_INVALID', `${field} must be positive`);
  return value;
}

function nonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail('ERR_CAPABILITY_POLICY_LIMIT_INVALID', `${field} must be non-negative`);
  return value;
}

function secretLike(value) {
  return /credential|authorization|bearer|token|secret|password|(?:api|access|private)[_-]?key|sk-[A-Za-z0-9_-]{8,}/i.test(value);
}

function concreteSecretKeyMaterial(value) {
  return /\b(?:bearer|basic)\s+\S+/i.test(value) ||
    /sk-[A-Za-z0-9_-]{8,}/.test(value) ||
    /(?:^|[?&;,\s{])(?:credential|authorization|bearer|token|secret|password|(?:api|access|private)[_-]?key)\s*[:=]\s*\S+/i.test(value);
}

function upperCaseString(value) {
  return APPLY(STRING_TO_UPPER_CASE, APPLY(NativeString, undefined, [value]), []);
}
