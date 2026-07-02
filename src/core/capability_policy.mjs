import { EffectRecoveryClass } from './actuator.mjs';
import { fail } from './store.mjs';

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
    this.maximumRequestBytes = positiveSafeInteger(input.maximumRequestBytes ?? input.maximumPromptBytes ?? 1024 * 1024, 'maximumRequestBytes');
    this.maximumPromptBytes = positiveSafeInteger(input.maximumPromptBytes ?? this.maximumRequestBytes, 'maximumPromptBytes');
    this.maximumResponseBytes = positiveSafeInteger(input.maximumResponseBytes ?? 1024 * 1024, 'maximumResponseBytes');
    this.allowedOrigins = new Set(iterable(input.allowedOrigins));
    this.allowedMethods = new Set(iterable(input.allowedMethods).map((item) => String(item).toUpperCase()));
    this.allowedFileRoots = new Set(iterable(input.allowedFileRoots));
    this.allowedAuthorityLabels = new Set(iterable(input.allowedAuthorityLabels));
    this.allowedCapabilityPacks = new Set(iterable(input.allowedCapabilityPacks));
    this.deniedCapabilityPacks = new Set(iterable(input.deniedCapabilityPacks));
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

export function assertCapabilityPolicyAllows({ manifest, hostRequest = null, policy: inputPolicy = {}, mode = 'live', action = null, enforceNetworkTarget = true }) {
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
  if (isNetwork(manifest, hostRequest) && policy.allowNetworkEffects !== true) fail('ERR_CAPABILITY_NETWORK_DENIED');
  if (isFile(manifest, hostRequest) && policy.allowFileEffects !== true) fail('ERR_CAPABILITY_FILE_DENIED');
  if (isHuman(manifest, hostRequest) && policy.allowHumanEffects !== true) fail('ERR_CAPABILITY_HUMAN_DENIED');
  if (mode === 'live' && isLiveModelCall(manifest, hostRequest) && policy.maximumLiveModelCalls < 1) fail('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED');
  if (manifest?.recoveryClass === EffectRecoveryClass.bestEffort && policy.allowBestEffort !== true) fail('ERR_BEST_EFFORT_REQUIRES_OPERATOR_OPT_IN');
  const policyRequestBytes = hostRequest?.policyRequestBytes ?? hostRequest?.requestBytes;
  if (policyRequestBytes?.byteLength > policy.maximumRequestBytes) fail('ERR_CAPABILITY_PROMPT_TOO_LARGE');
  if (manifest?.maximumResponseBytes > policy.maximumResponseBytes) fail('ERR_CAPABILITY_RESPONSE_LIMIT_EXCEEDS_POLICY');
  if (isNetwork(manifest, hostRequest)) {
    if (enforceNetworkTarget) {
      assertOriginAndMethodAllowed(hostRequest, policy);
    } else {
      assertNetworkAllowlistsPresent(policy);
    }
  }
  assertFileRootAllowed(manifest, policy);
  const approved = action?.approved === true;
  if (action?.destructive === true && policy.requireApprovalForDestructiveEffects && !approved) fail('ERR_CAPABILITY_APPROVAL_REQUIRED');
  if (isNetwork(manifest, hostRequest) && policy.requireApprovalForNetworkEffects && !approved) fail('ERR_CAPABILITY_APPROVAL_REQUIRED');
  if (manifest?.recoveryClass === EffectRecoveryClass.bestEffort && policy.requireApprovalForBestEffort && !approved) fail('ERR_CAPABILITY_APPROVAL_REQUIRED');
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
    this.authorityLabels = new Set(iterable(input.authorityLabels));
    this.capabilityPacks = new Set(iterable(input.capabilityPacks));
    this.origins = new Set(iterable(input.origins));
    this.fileRoots = new Set(iterable(input.fileRoots));
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
  if (typeof value === 'string') return secretLike(value) ? '[redacted]' : value;
  if (Array.isArray(value)) return value.map(redactCapabilityDiagnostics);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    secretLike(key) ? '[redacted]' : redactCapabilityDiagnostics(child),
  ]));
}

function isNetwork(manifest, hostRequest) {
  return hostRequest?.actuationClass === 'http' || (manifest?.authorityLabels ?? []).some((label) => label.startsWith('network:'));
}

function isFile(manifest, hostRequest) {
  return hostRequest?.actuationClass === 'file' || (manifest?.authorityLabels ?? []).some((label) => label.startsWith('file:'));
}

function isHuman(manifest, hostRequest) {
  return hostRequest?.actuationClass === 'human' || (manifest?.authorityLabels ?? []).some((label) => label.startsWith('human:'));
}

function isLiveModelCall(manifest, hostRequest) {
  if (hostRequest?.actuationClass !== 'model') return false;
  if (manifest?.driverId === 'fixture-agent-model' || manifest?.diagnostics?.deterministic === true) return false;
  const labels = manifest?.authorityLabels ?? [];
  if (labels.some((label) => label.startsWith('model:fixture'))) return false;
  return labels.some((label) => label.startsWith('model:'));
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

function assertFileRootAllowed(manifest, policy) {
  if (!policy.allowedFileRoots.size) return;
  const root = manifest?.diagnostics?.root ?? manifest?.policyRequirements?.root;
  if ((manifest?.authorityLabels ?? []).some((label) => label.startsWith('file:')) && (!root || !policy.allowedFileRoots.has(root))) {
    fail('ERR_CAPABILITY_FILE_ROOT_DENIED', `file root denied: ${root ?? 'unknown'}`);
  }
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

function iterable(value) {
  if (value == null) return [];
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value;
  return [value];
}
