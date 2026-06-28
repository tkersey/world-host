export const carrierManifest = Object.freeze({
  carrierVersion: '0.0.0-carrier-v0',
  supportedWorldRelease: 'v0.1.0',
  supportedBoundaryRelease: 'v0.6.2',
  applianceAbiVersion: 'v4',
  turnClosureFormatVersion: 'v1',
  universalWasm: Object.freeze({
    fileName: 'world_universal_appliance.wasm',
    sha256: 'a79ae458d3cc5145660dadfc678736e75822c8c70558f8139861dc1103e84add',
    checksumSource: 'local World universal Appliance cache artifact selected by real Carrier conformance',
    releaseVerificationRequired: true,
  }),
  runtime: Object.freeze({
    moduleFormat: 'esm',
    runtimeDependencies: 0,
    allowsNativeWorldHelperProcess: false,
    allowsChildProcessProtocolEncoding: false,
  }),
});

export function assertCarrierManifest(manifest = carrierManifest) {
  if (manifest.supportedWorldRelease !== 'v0.1.0') {
    throw new Error('ERR_UNSUPPORTED_WORLD_RELEASE');
  }
  if (manifest.supportedBoundaryRelease !== 'v0.6.2') {
    throw new Error('ERR_UNSUPPORTED_BOUNDARY_RELEASE');
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.universalWasm.sha256)) {
    throw new Error('ERR_INVALID_UNIVERSAL_WASM_SHA256');
  }
  if (manifest.runtime.runtimeDependencies !== 0) {
    throw new Error('ERR_RUNTIME_DEPENDENCIES_FORBIDDEN');
  }
  if (manifest.runtime.allowsNativeWorldHelperProcess) {
    throw new Error('ERR_NATIVE_WORLD_HELPER_FORBIDDEN');
  }
  if (manifest.runtime.allowsChildProcessProtocolEncoding) {
    throw new Error('ERR_CHILD_PROCESS_PROTOCOL_ENCODING_FORBIDDEN');
  }
  return manifest;
}

export function carrierVersionSummary(manifest = carrierManifest) {
  assertCarrierManifest(manifest);
  return {
    carrierVersion: manifest.carrierVersion,
    world: manifest.supportedWorldRelease,
    boundary: manifest.supportedBoundaryRelease,
    applianceAbi: manifest.applianceAbiVersion,
    turnClosure: manifest.turnClosureFormatVersion,
    universalWasmSha256: manifest.universalWasm.sha256,
  };
}
