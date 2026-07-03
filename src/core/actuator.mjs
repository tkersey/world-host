import { fail } from './store.mjs';

export const EffectRecoveryClass = Object.freeze({
  pure: 'pure',
  idempotent: 'idempotent',
  externallyRecoverable: 'externally_recoverable',
  transactional: 'transactional',
  bestEffort: 'best_effort',
});

export const ActuationClass = Object.freeze({
  model: 'model',
  file: 'file',
  human: 'human',
  http: 'http',
  fixture: 'fixture',
  host: 'host',
});

const RECOVERY_CLASSES = new Set(Object.values(EffectRecoveryClass));
export const ResponseStatusCode = Object.freeze({
  responded: 0,
  ok: 0,
  final: 0,
  rejected: 1,
  not_found: 1,
  http_error: 1,
  failed: 2,
  pending: 3,
  deferred: 4,
  cancelled: 5,
});
const RESPONSE_STATUSES = new Set(Object.keys(ResponseStatusCode));

export function assertRecoveryClass(value) {
  if (!RECOVERY_CLASSES.has(value)) fail('ERR_INVALID_EFFECT_RECOVERY_CLASS', `invalid recovery class: ${value}`);
  return value;
}

export function assertDurableRecoveryAllowed(recoveryClass, policy = {}) {
  assertRecoveryClass(recoveryClass);
  if (recoveryClass === EffectRecoveryClass.bestEffort && policy.durableAutomatic !== false && policy.allowBestEffort !== true) {
    fail('ERR_BEST_EFFORT_REQUIRES_OPERATOR_OPT_IN', 'durable automatic runs reject best_effort drivers');
  }
  return true;
}

export function defineActuatorDriver(driver) {
  if (!driver || typeof driver !== 'object') fail('ERR_INVALID_ACTUATOR_DRIVER');
  if (typeof driver.manifest !== 'function') fail('ERR_ACTUATOR_DRIVER_MANIFEST_REQUIRED');
  if (typeof driver.resolve !== 'function') fail('ERR_ACTUATOR_DRIVER_RESOLVE_REQUIRED');
  return Object.freeze({
    manifest() {
      const raw = driver.manifest();
      const manifest = assertDriverManifest(raw);
      if (raw.packFingerprint == null) return manifest;
      if (typeof raw.packFingerprint !== 'string') fail('ERR_INVALID_DRIVER_MANIFEST', 'packFingerprint must be a string');
      return Object.freeze({ ...manifest, packFingerprint: raw.packFingerprint });
    },
    resolve: driver.resolve.bind(driver),
    recover: typeof driver.recover === 'function' ? driver.recover.bind(driver) : undefined,
    query: typeof driver.query === 'function' ? driver.query.bind(driver) : undefined,
    cancel: typeof driver.cancel === 'function' ? driver.cancel.bind(driver) : undefined,
  });
}

export function assertDriverManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') fail('ERR_INVALID_DRIVER_MANIFEST');
  requiredString(manifest.driverId, 'driverId');
  requiredList(manifest.supportedActuatorRefs, 'supportedActuatorRefs');
  requiredList(manifest.supportedDescriptorFingerprints, 'supportedDescriptorFingerprints');
  requiredList(manifest.supportedActuationClasses, 'supportedActuationClasses');
  requiredKnownResponseStatusList(manifest.supportedResponseStatuses, 'supportedResponseStatuses');
  requiredSafeInteger(manifest.maximumRequestBytes, 'maximumRequestBytes');
  requiredSafeInteger(manifest.maximumResponseBytes, 'maximumResponseBytes');
  assertRecoveryClass(manifest.recoveryClass);
  requiredPositiveSafeInteger(manifest.concurrencyLimit, 'concurrencyLimit');
  requiredList(manifest.authorityLabels, 'authorityLabels');
  return Object.freeze({
    driverId: manifest.driverId,
    supportedActuatorRefs: [...manifest.supportedActuatorRefs],
    supportedDescriptorFingerprints: [...manifest.supportedDescriptorFingerprints],
    supportedActuationClasses: [...manifest.supportedActuationClasses],
    supportedResponseStatuses: [...manifest.supportedResponseStatuses],
    maximumRequestBytes: manifest.maximumRequestBytes,
    maximumResponseBytes: manifest.maximumResponseBytes,
    recoveryClass: manifest.recoveryClass,
    concurrencyLimit: manifest.concurrencyLimit,
    authorityLabels: [...manifest.authorityLabels],
    diagnostics: manifest.diagnostics ?? {},
  });
}

export function assertDriverCanResolve(manifest, hostRequest) {
  assertDriverManifest(manifest);
  if (!manifest.supportedActuatorRefs.includes(hostRequest.actuatorRef)) fail('ERR_ACTUATOR_REF_NOT_SUPPORTED');
  if (!manifest.supportedDescriptorFingerprints.includes(hostRequest.descriptorFingerprint)) fail('ERR_DESCRIPTOR_NOT_SUPPORTED');
  if (!manifest.supportedActuationClasses.includes(hostRequest.actuationClass)) fail('ERR_ACTUATION_CLASS_NOT_SUPPORTED');
  if (hostRequest.responseSchema?.status !== undefined && !RESPONSE_STATUSES.has(hostRequest.responseSchema.status)) {
    fail('ERR_RESPONSE_STATUS_NOT_SUPPORTED');
  }
  if (hostRequest.responseSchema && !manifest.supportedResponseStatuses.includes(hostRequest.responseSchema.status)) {
    fail('ERR_RESPONSE_STATUS_NOT_SUPPORTED');
  }
  if (hostRequest.requestBytes?.byteLength > manifest.maximumRequestBytes) fail('ERR_HOST_REQUEST_TOO_LARGE');
  return true;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) fail('ERR_INVALID_DRIVER_MANIFEST', `${field} is required`);
}

function requiredList(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('ERR_INVALID_DRIVER_MANIFEST', `${field} must be a string list`);
  }
}

function requiredKnownResponseStatusList(value, field) {
  requiredList(value, field);
  if (value.some((item) => !RESPONSE_STATUSES.has(item))) {
    fail('ERR_INVALID_DRIVER_MANIFEST', `${field} must contain known response statuses`);
  }
}

function requiredSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail('ERR_INVALID_DRIVER_MANIFEST', `${field} must be a non-negative safe integer`);
}

function requiredPositiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail('ERR_INVALID_DRIVER_MANIFEST', `${field} must be a positive safe integer`);
}
