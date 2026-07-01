import { EffectRecoveryClass, ResponseStatusCode, assertRecoveryClass } from './actuator.mjs';
import { assertBytes, fail, fromUtf8, stableJson, toHex } from './store.mjs';

export const world_host_capability_pack_format_version = 1;
export const world_host_capability_driver_abi_version = 1;

const RECOVERY_CLASSES = new Set(Object.values(EffectRecoveryClass));
const RESPONSE_STATUSES = new Set(Object.keys(ResponseStatusCode));
const SEMANTIC_FIELDS = Object.freeze([
  'formatVersion',
  'packageName',
  'packageVersion',
  'driverId',
  'driverAbiVersion',
  'supportedWorldProtocolVersion',
  'supportedApplianceAbiVersion',
  'supportedTurnClosureVersion',
  'supportedActuatorRefs',
  'supportedDescriptorFingerprints',
  'supportedActuationClasses',
  'supportedResponseStatuses',
  'recoveryClass',
  'canDryRun',
  'canShadow',
  'canReplay',
  'canRecover',
  'propagatesWorldIdempotencyKey',
  'requiresApproval',
  'requiredSecrets',
  'authorityLabels',
  'policyRequirements',
  'maximumRequestBytes',
  'maximumResponseBytes',
  'conformanceCorpusFingerprint',
  'metadataBytes',
]);
const SECRET_PATTERN = /credential|authorization|bearer|token|secret|password|(?:api|access|private)[_-]?key/i;

export class CapabilityManifest {
  constructor(fields) {
    Object.assign(this, fields);
    for (const key of [
      'supportedActuatorRefs',
      'supportedDescriptorFingerprints',
      'supportedActuationClasses',
      'supportedResponseStatuses',
      'requiredSecrets',
      'authorityLabels',
      'checksums',
      'docs',
    ]) {
      if (Array.isArray(this[key])) Object.freeze(this[key]);
    }
    Object.freeze(this.policyRequirements);
    Object.freeze(this.adapter);
    Object.freeze(this);
  }
}

export class CapabilityPack {
  constructor({ manifest, conformanceReceipt = null, artifacts = {}, docs = [] } = {}) {
    this.manifest = assertCapabilityManifest(manifest);
    this.conformanceReceipt = conformanceReceipt == null ? null : assertCapabilityConformanceReceipt(conformanceReceipt);
    this.artifacts = Object.freeze({ ...artifacts });
    this.docs = Object.freeze([...docs]);
    Object.freeze(this);
  }
}

export class CapabilityDescriptor {
  constructor(fields) {
    requiredString(fields?.actuatorRef, 'actuatorRef');
    requiredString(fields?.descriptorFingerprint, 'descriptorFingerprint');
    requiredString(fields?.actuationClass, 'actuationClass');
    this.actuatorRef = fields.actuatorRef;
    this.descriptorFingerprint = fields.descriptorFingerprint;
    this.actuationClass = fields.actuationClass;
    this.responseStatuses = requiredKnownResponseStatusList(fields.responseStatuses ?? ['responded'], 'responseStatuses');
    Object.freeze(this.responseStatuses);
    Object.freeze(this);
  }
}

export class CapabilityConformanceReceipt {
  constructor(fields) {
    requiredString(fields?.driverId, 'driverId');
    requiredString(fields?.packFingerprint, 'packFingerprint');
    requiredString(fields?.corpusFingerprint, 'corpusFingerprint');
    if (!Array.isArray(fields?.vectors) || fields.vectors.length === 0) {
      fail('ERR_CAPABILITY_CONFORMANCE_RECEIPT_INVALID', 'vectors are required');
    }
    this.driverId = fields.driverId;
    this.packFingerprint = fields.packFingerprint;
    this.corpusFingerprint = fields.corpusFingerprint;
    this.vectors = fields.vectors.map(assertConformanceVector);
    this.nonClaims = fields.nonClaims ?? [];
    Object.freeze(this.vectors);
    Object.freeze(this.nonClaims);
    Object.freeze(this);
  }
}

export function assertCapabilityManifest(input, options = {}) {
  if (!input || typeof input !== 'object') fail('ERR_CAPABILITY_MANIFEST_INVALID');
  const formatVersion = exactInteger(input.formatVersion, 'formatVersion', world_host_capability_pack_format_version);
  const driverAbiVersion = exactInteger(input.driverAbiVersion, 'driverAbiVersion', world_host_capability_driver_abi_version);
  const manifest = new CapabilityManifest({
    formatVersion,
    packFingerprint: optionalFingerprint(input.packFingerprint, 'packFingerprint'),
    packageName: packageName(input.packageName),
    packageVersion: requiredString(input.packageVersion, 'packageVersion'),
    driverId: requiredString(input.driverId, 'driverId'),
    driverAbiVersion,
    supportedWorldProtocolVersion: requiredString(input.supportedWorldProtocolVersion, 'supportedWorldProtocolVersion'),
    supportedApplianceAbiVersion: requiredString(input.supportedApplianceAbiVersion, 'supportedApplianceAbiVersion'),
    supportedTurnClosureVersion: requiredString(input.supportedTurnClosureVersion, 'supportedTurnClosureVersion'),
    supportedActuatorRefs: requiredStringList(input.supportedActuatorRefs, 'supportedActuatorRefs'),
    supportedDescriptorFingerprints: requiredStringList(input.supportedDescriptorFingerprints, 'supportedDescriptorFingerprints'),
    supportedActuationClasses: requiredStringList(input.supportedActuationClasses, 'supportedActuationClasses'),
    supportedResponseStatuses: requiredKnownResponseStatusList(input.supportedResponseStatuses, 'supportedResponseStatuses'),
    recoveryClass: assertRecoveryClass(input.recoveryClass),
    canDryRun: requiredBoolean(input.canDryRun, 'canDryRun'),
    canShadow: requiredBoolean(input.canShadow, 'canShadow'),
    canReplay: requiredBoolean(input.canReplay, 'canReplay'),
    canRecover: requiredBoolean(input.canRecover, 'canRecover'),
    propagatesWorldIdempotencyKey: requiredBoolean(input.propagatesWorldIdempotencyKey, 'propagatesWorldIdempotencyKey'),
    requiresApproval: requiredBoolean(input.requiresApproval, 'requiresApproval'),
    requiredSecrets: normalizeSecretDescriptors(input.requiredSecrets ?? []),
    authorityLabels: requiredStringList(input.authorityLabels, 'authorityLabels'),
    policyRequirements: normalizePolicyRequirements(input.policyRequirements ?? {}),
    maximumRequestBytes: requiredPositiveSafeInteger(input.maximumRequestBytes, 'maximumRequestBytes'),
    maximumResponseBytes: requiredPositiveSafeInteger(input.maximumResponseBytes, 'maximumResponseBytes'),
    conformanceCorpusFingerprint: optionalFingerprint(input.conformanceCorpusFingerprint, 'conformanceCorpusFingerprint'),
    metadataBytes: normalizeMetadataBytes(input.metadataBytes ?? ''),
    adapter: normalizeAdapter(input.adapter ?? {}),
    checksums: normalizeChecksums(input.checksums ?? []),
    docs: requiredStringList(input.docs ?? [], 'docs'),
  });
  assertNoCredentialMaterial(manifest);
  assertNoOperationLabelAuthority(manifest);
  if (options.requirePackFingerprint && !manifest.packFingerprint) fail('ERR_CAPABILITY_PACK_FINGERPRINT_REQUIRED');
  return manifest;
}

export async function validateCapabilityPackManifest(input, options = {}) {
  const manifest = assertCapabilityManifest(input, options);
  if (options.verifyFingerprint === true) {
    if (!manifest.packFingerprint) fail('ERR_CAPABILITY_PACK_FINGERPRINT_REQUIRED');
    const actual = await capabilityPackFingerprint(manifest);
    if (actual !== manifest.packFingerprint) fail('ERR_CAPABILITY_PACK_FINGERPRINT_MISMATCH', 'pack fingerprint does not match semantic identity', { expected: manifest.packFingerprint, actual });
  }
  return manifest;
}

export async function capabilityPackFingerprint(manifestLike) {
  const manifest = assertCapabilityManifest(manifestLike);
  return `sha256:${await sha256Hex(fromUtf8(stableJson(capabilityManifestSemanticIdentity(manifest))))}`;
}

export function capabilityManifestSemanticIdentity(manifestLike) {
  const manifest = assertCapabilityManifest(manifestLike);
  const identity = {};
  for (const key of SEMANTIC_FIELDS) identity[key] = manifest[key];
  return identity;
}

export function capabilityDescriptorFromManifest(manifestLike) {
  const manifest = assertCapabilityManifest(manifestLike);
  return new CapabilityDescriptor({
    actuatorRef: manifest.supportedActuatorRefs[0],
    descriptorFingerprint: manifest.supportedDescriptorFingerprints[0],
    actuationClass: manifest.supportedActuationClasses[0],
    responseStatuses: manifest.supportedResponseStatuses,
  });
}

export function assertCapabilityConformanceReceipt(input) {
  return new CapabilityConformanceReceipt(input);
}

export async function assertCapabilityPackChecksums(manifestLike, artifacts = {}) {
  const manifest = assertCapabilityManifest(manifestLike);
  assertReferencedArtifactsCovered(manifest);
  for (const item of manifest.checksums) {
    const bytes = artifacts[item.path];
    if (!(bytes instanceof Uint8Array)) fail('ERR_CAPABILITY_PACK_ARTIFACT_MISSING', `artifact missing: ${item.path}`);
    const actual = `sha256:${await sha256Hex(bytes)}`;
    if (actual !== item.checksum) fail('ERR_CAPABILITY_PACK_CHECKSUM_MISMATCH', `artifact checksum mismatch: ${item.path}`, { expected: item.checksum, actual });
  }
  return true;
}

function assertReferencedArtifactsCovered(manifest) {
  const covered = new Set(manifest.checksums.map((item) => item.path));
  const required = new Set([
    ...manifest.docs,
    ...(manifest.conformanceCorpusFingerprint ? ['conformance.json'] : []),
  ]);
  if (manifest.adapter.kind === 'in_process' && manifest.adapter.module) required.add(manifest.adapter.module);
  for (const path of required) {
    if (!covered.has(path)) fail('ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED', `referenced artifact is not checksum-covered: ${path}`);
  }
}

function normalizeAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') fail('ERR_CAPABILITY_ADAPTER_INVALID');
  const kind = adapter.kind ?? 'in_process';
  if (!['in_process', 'sidecar'].includes(kind)) fail('ERR_CAPABILITY_ADAPTER_INVALID', 'adapter kind must be in_process or sidecar');
  if (kind === 'in_process') {
    const module = optionalRelativePath(adapter.module, 'adapter.module');
    return Object.freeze({
      kind,
      module,
      exportName: adapter.exportName == null ? null : requiredString(adapter.exportName, 'adapter.exportName'),
    });
  }
  if (!Array.isArray(adapter.command) || adapter.command.length === 0) {
    fail('ERR_CAPABILITY_ADAPTER_INVALID', 'sidecar adapter command must be a non-empty argv array');
  }
  return Object.freeze({
    kind,
    command: adapter.command.map((item) => requiredString(item, 'adapter.command')),
  });
}

function normalizeSecretDescriptors(value) {
  if (!Array.isArray(value)) fail('ERR_CAPABILITY_SECRET_DESCRIPTOR_INVALID');
  return value.map((item) => {
    if (typeof item === 'string') return Object.freeze({ name: item, class: 'opaque', required: true });
    requiredString(item?.name, 'secret.name');
    return Object.freeze({
      name: item.name,
      class: item.class == null ? 'opaque' : requiredString(item.class, 'secret.class'),
      required: item.required !== false,
      purpose: item.purpose == null ? null : requiredString(item.purpose, 'secret.purpose'),
    });
  });
}

function normalizePolicyRequirements(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ERR_CAPABILITY_POLICY_REQUIREMENTS_INVALID');
  return Object.freeze({
    allowLiveEffects: value.allowLiveEffects === true,
    allowNetworkEffects: value.allowNetworkEffects === true,
    allowFileEffects: value.allowFileEffects === true,
    allowHumanEffects: value.allowHumanEffects === true,
    allowBestEffort: value.allowBestEffort === true,
    allowedOrigins: requiredStringList(value.allowedOrigins ?? [], 'policyRequirements.allowedOrigins'),
    allowedMethods: requiredStringList(value.allowedMethods ?? [], 'policyRequirements.allowedMethods').map((item) => item.toUpperCase()),
    allowedFileRoots: requiredStringList(value.allowedFileRoots ?? [], 'policyRequirements.allowedFileRoots'),
  });
}

function normalizeChecksums(value) {
  if (!Array.isArray(value)) fail('ERR_CAPABILITY_PACK_CHECKSUM_INVALID');
  return value.map((item) => Object.freeze({
    path: optionalRelativePath(item?.path, 'checksum.path'),
    checksum: requiredSha256(item?.checksum, 'checksum.checksum'),
  }));
}

function assertConformanceVector(value) {
  if (!value || typeof value !== 'object') fail('ERR_CAPABILITY_CONFORMANCE_RECEIPT_INVALID');
  requiredString(value.name, 'vector.name');
  if (value.status !== 'passed') fail('ERR_CAPABILITY_CONFORMANCE_RECEIPT_INVALID', 'conformance vectors must pass');
  return Object.freeze({ ...value });
}

function assertNoCredentialMaterial(value, path = []) {
  if (value == null) return;
  if (path[0] === 'requiredSecrets') return;
  if (typeof value === 'string') {
    if (SECRET_PATTERN.test(path.join('.')) && value.length > 0 && !['opaque', 'required', 'redacted'].includes(value)) {
      fail('ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN', `credential-like value forbidden at ${path.join('.')}`);
    }
    if (/sk-[A-Za-z0-9_-]{8,}/.test(value)) fail('ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN', `secret-looking value forbidden at ${path.join('.')}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialMaterial(item, [...path, String(index)]));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) assertNoCredentialMaterial(child, [...path, key]);
  }
}

function assertNoOperationLabelAuthority(manifest) {
  const bad = manifest.authorityLabels.filter((label) => /^operation:/i.test(label) || /^op:/i.test(label));
  if (bad.length) fail('ERR_CAPABILITY_OPERATION_LABEL_AUTHORITY_FORBIDDEN', 'operation-label dispatch is not authority', { labels: bad });
}

function packageName(value) {
  requiredString(value, 'packageName');
  if (!/^[a-z0-9@._/-]+$/i.test(value)) fail('ERR_CAPABILITY_PACKAGE_NAME_INVALID');
  return value;
}

function optionalRelativePath(value, field) {
  requiredString(value, field);
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\0')) {
    fail('ERR_CAPABILITY_HOST_PATH_FORBIDDEN', `${field} must be a relative artifact path`);
  }
  if (value.split(/[\\/]+/).includes('..')) fail('ERR_CAPABILITY_HOST_PATH_FORBIDDEN', `${field} must not escape the pack root`);
  return value;
}

function normalizeMetadataBytes(value) {
  if (value instanceof Uint8Array) return { format: 'base64', bytes: btoa(String.fromCharCode(...value)) };
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value;
  fail('ERR_CAPABILITY_METADATA_INVALID');
}

function exactInteger(value, field, expected) {
  if (value !== expected) fail('ERR_CAPABILITY_VERSION_UNSUPPORTED', `${field} must be ${expected}`);
  return value;
}

function requiredBoolean(value, field) {
  if (typeof value !== 'boolean') fail('ERR_CAPABILITY_MANIFEST_INVALID', `${field} must be boolean`);
  return value;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) fail('ERR_CAPABILITY_MANIFEST_INVALID', `${field} is required`);
  return value;
}

function requiredStringList(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('ERR_CAPABILITY_MANIFEST_INVALID', `${field} must be a string list`);
  }
  return [...value];
}

function requiredKnownResponseStatusList(value, field) {
  const list = requiredStringList(value, field);
  for (const item of list) {
    if (!RESPONSE_STATUSES.has(item)) fail('ERR_CAPABILITY_RESPONSE_STATUS_UNSUPPORTED', `${field} contains unsupported response status`);
  }
  return list;
}

function requiredPositiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail('ERR_CAPABILITY_MANIFEST_INVALID', `${field} must be a positive safe integer`);
  return value;
}

function optionalFingerprint(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) fail('ERR_CAPABILITY_FINGERPRINT_INVALID', `${field} must be sha256 hex`);
  return value;
}

function requiredSha256(value, field) {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) fail('ERR_CAPABILITY_PACK_CHECKSUM_INVALID', `${field} must be sha256 hex`);
  return value;
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', assertBytes(bytes));
  return toHex(new Uint8Array(digest));
}
