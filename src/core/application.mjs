import { assertBlobRef, assertWorldFingerprint, fail } from './store.mjs';

export function createApplicationRecord(input) {
  const record = {
    applicationId: requiredString(input.applicationId, 'applicationId'),
    universalWasmChecksum: requiredString(input.universalWasmChecksum, 'universalWasmChecksum'),
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
