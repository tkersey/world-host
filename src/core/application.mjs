import { assertBlobRef, assertWorldFingerprint, fail } from './store.mjs';

export function createApplicationRecord(input) {
  const record = {
    applicationId: requiredString(input.applicationId, 'applicationId'),
    universalWasmChecksum: requiredSha256Checksum(input.universalWasmChecksum, 'universalWasmChecksum'),
    universalWasmByteLength: requiredNonnegativeInteger(input.universalWasmByteLength, 'universalWasmByteLength'),
    worldProtocolVersion: requiredString(input.worldProtocolVersion, 'worldProtocolVersion'),
    applianceAbiVersion: requiredString(input.applianceAbiVersion, 'applianceAbiVersion'),
    executableImageRef: assertBlobRef(input.executableImageRef),
    executableImageWorldFingerprint: assertWorldFingerprint(input.executableImageWorldFingerprint, 'executableImageWorldFingerprint'),
    applianceManifestRef: assertBlobRef(input.applianceManifestRef),
    requiredActuators: Array.isArray(input.requiredActuators) ? input.requiredActuators : [],
    requiredRuntimeLimits: input.requiredRuntimeLimits ?? {},
    installationDiagnostics: input.installationDiagnostics ?? {},
  };
  return Object.freeze(record);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail('ERR_REQUIRED_FIELD', `${label} is required`);
  return value;
}

function requiredSha256Checksum(value, label) {
  const text = requiredString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/.test(text)) fail('ERR_INVALID_SHA256_CHECKSUM', `${label} must be sha256:<64 lowercase hex>`);
  return text;
}

function requiredNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('ERR_REQUIRED_INTEGER', `${label} must be nonnegative integer`);
  return value;
}
