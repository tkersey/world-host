import { createHash } from 'node:crypto';

import { stableJson } from '../core/store.mjs';
import { carrierManifest } from './world_manifest.mjs';

export const agentRuntimeManifestFormatVersion = 1;
export const agentRuntimeManifestFingerprintVersion = 1;
export const agentRuntimeReleaseReceiptFormatVersion = 1;
export const agentRuntimeReleaseReceiptFingerprintVersion = 1;

const REQUIRED_SCENARIOS = Object.freeze([
  'skeleton',
  'fixture',
  'replay',
  'retry',
  'migration',
  'branching',
  'negative',
]);

const REQUIRED_DRIVER_IDS = Object.freeze([
  'fixture:agent-model',
  'sandbox:file',
]);

const REQUIRED_ACTUATOR_REFS = Object.freeze([
  'fixture:agent-model',
  'sandbox:file',
]);

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(bytes) {
  return `sha256:${sha256Hex(bytes)}`;
}

export function fingerprintOf(value) {
  return `agent-runtime:${sha256Hex(Buffer.from(stableJson(value))).slice(0, 32)}`;
}

export function buildAgentRuntimeManifest(input) {
  const artifacts = input.artifacts ?? {};
  const manifest = {
    manifestFormatVersion: agentRuntimeManifestFormatVersion,
    manifestFingerprintVersion: agentRuntimeManifestFingerprintVersion,
    agentRuntimeVersion: requiredString(input.agentRuntimeVersion, 'agentRuntimeVersion'),
    boundary: {
      packageVersion: requiredString(input.boundary?.packageVersion, 'boundary.packageVersion'),
      packageHash: requiredString(input.boundary?.packageHash, 'boundary.packageHash'),
      protocolManifestFingerprint: requiredString(input.boundary?.protocolManifestFingerprint, 'boundary.protocolManifestFingerprint'),
      agentProfileFingerprint: requiredString(input.boundary?.agentProfileFingerprint, 'boundary.agentProfileFingerprint'),
      agentRootModuleFingerprint: requiredString(input.boundary?.agentRootModuleFingerprint, 'boundary.agentRootModuleFingerprint'),
      toolboxModuleFingerprint: requiredString(input.boundary?.toolboxModuleFingerprint, 'boundary.toolboxModuleFingerprint'),
    },
    world: {
      packageVersion: requiredString(input.world?.packageVersion, 'world.packageVersion'),
      protocolManifestFingerprint: requiredString(input.world?.protocolManifestFingerprint, 'world.protocolManifestFingerprint'),
      executableImageFingerprint: requiredString(input.world?.executableImageFingerprint, 'world.executableImageFingerprint'),
      applianceManifestFingerprint: requiredString(input.world?.applianceManifestFingerprint, 'world.applianceManifestFingerprint'),
      universalWasmSha256: requiredSha256(input.world?.universalWasmSha256, 'world.universalWasmSha256'),
      applianceAbiVersion: requiredString(input.world?.applianceAbiVersion, 'world.applianceAbiVersion'),
      turnClosureFormatVersion: requiredString(input.world?.turnClosureFormatVersion, 'world.turnClosureFormatVersion'),
      archiveFormatVersion: requiredString(input.world?.archiveFormatVersion, 'world.archiveFormatVersion'),
    },
    worldHost: {
      packageVersion: requiredString(input.worldHost?.packageVersion, 'worldHost.packageVersion'),
      carrierManifestFingerprint: requiredString(input.worldHost?.carrierManifestFingerprint, 'worldHost.carrierManifestFingerprint'),
    },
    requiredDriverIds: exactStringList(input.requiredDriverIds ?? REQUIRED_DRIVER_IDS, REQUIRED_DRIVER_IDS, 'requiredDriverIds'),
    requiredActuatorRefs: exactStringList(input.requiredActuatorRefs ?? REQUIRED_ACTUATOR_REFS, REQUIRED_ACTUATOR_REFS, 'requiredActuatorRefs'),
    requiredDescriptorFingerprints: nonemptyStringList(input.requiredDescriptorFingerprints, 'requiredDescriptorFingerprints'),
    requiredHostAuthorityLabels: nonemptyStringList(input.requiredHostAuthorityLabels, 'requiredHostAuthorityLabels'),
    supportedExampleScenarios: exactStringList(input.supportedExampleScenarios ?? REQUIRED_SCENARIOS, REQUIRED_SCENARIOS, 'supportedExampleScenarios'),
    conformanceCorpusFingerprint: requiredString(input.conformanceCorpusFingerprint, 'conformanceCorpusFingerprint'),
    releaseReceiptFingerprint: requiredString(input.releaseReceiptFingerprint, 'releaseReceiptFingerprint'),
    artifacts,
    metadata: input.metadata ?? {},
  };
  manifest.manifestFingerprint = fingerprintOf(withoutFingerprint(manifest));
  return Object.freeze(manifest);
}

export function assertAgentRuntimeManifest(manifest) {
  if (manifest?.manifestFormatVersion !== agentRuntimeManifestFormatVersion) throw new Error('ERR_AGENT_RUNTIME_MANIFEST_FORMAT');
  if (manifest?.manifestFingerprintVersion !== agentRuntimeManifestFingerprintVersion) throw new Error('ERR_AGENT_RUNTIME_MANIFEST_FINGERPRINT_VERSION');
  const expected = fingerprintOf(withoutFingerprint(manifest));
  if (manifest.manifestFingerprint !== expected) throw new Error('ERR_AGENT_RUNTIME_MANIFEST_FINGERPRINT');
  requiredString(manifest.agentRuntimeVersion, 'agentRuntimeVersion');
  requiredString(manifest.boundary?.packageVersion, 'boundary.packageVersion');
  requiredString(manifest.world?.packageVersion, 'world.packageVersion');
  requiredSha256(manifest.world?.universalWasmSha256, 'world.universalWasmSha256');
  exactStringList(manifest.requiredDriverIds, REQUIRED_DRIVER_IDS, 'requiredDriverIds');
  exactStringList(manifest.requiredActuatorRefs, REQUIRED_ACTUATOR_REFS, 'requiredActuatorRefs');
  exactStringList(manifest.supportedExampleScenarios, REQUIRED_SCENARIOS, 'supportedExampleScenarios');
  return manifest;
}

export function carrierManifestFingerprint(manifest = carrierManifest) {
  return fingerprintOf(manifest);
}

export function releaseReceiptFingerprint(receipt) {
  return fingerprintOf({ ...receipt, receiptFingerprint: undefined });
}

function withoutFingerprint(manifest) {
  const copy = { ...manifest };
  delete copy.manifestFingerprint;
  return copy;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`ERR_REQUIRED_${label}`);
  return value;
}

function requiredSha256(value, label) {
  const text = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`ERR_INVALID_SHA256_${label}`);
  return text;
}

function nonemptyStringList(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`ERR_REQUIRED_LIST_${label}`);
  }
  return Object.freeze([...value]);
}

function exactStringList(value, expected, label) {
  nonemptyStringList(value, label);
  if (value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    throw new Error(`ERR_UNEXPECTED_LIST_${label}`);
  }
  return Object.freeze([...value]);
}
