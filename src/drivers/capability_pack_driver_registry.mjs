import { fail } from '../core/store.mjs';
import { assertRequiredSecretsAvailable, scopeSecretProvider } from '../core/secrets.mjs';
import { GenericHttpJsonCapabilityDriver } from './generic_http_json_capability_driver.mjs';
import { HumanApprovalCapabilityDriver } from './human_approval_capability_driver.mjs';
import { FixtureAgentModelCapabilityDriver, GenericHttpJsonModelDriver } from './model_capability_driver.mjs';

const RECEIVER_DRIVER_FACTORIES = new Map([
  ['fixture-agent-model', (options) => new FixtureAgentModelCapabilityDriver(options)],
  ['generic-http-json', (options) => new GenericHttpJsonCapabilityDriver(options)],
  ['generic-http-json-model', (options) => new GenericHttpJsonModelDriver(options)],
  ['human-approval', (options) => new HumanApprovalCapabilityDriver(options)],
]);

const RECEIVER_DRIVER_MANIFEST_FIELDS = Object.freeze([
  'driverId',
  'supportedActuatorRefs',
  'supportedDescriptorFingerprints',
  'supportedActuationClasses',
  'supportedResponseStatuses',
  'recoveryClass',
  'maximumRequestBytes',
  'maximumResponseBytes',
  'authorityLabels',
]);

export function assertReceiverCapabilityPackDriverRegistered(packManifest) {
  if (packManifest?.adapter?.kind !== 'receiver') return true;
  if (!RECEIVER_DRIVER_FACTORIES.has(packManifest.driverId)) {
    fail('ERR_CAPABILITY_PACK_RECEIVER_DRIVER_UNKNOWN', `unknown receiver capability driver: ${packManifest.driverId}`, {
      driverId: packManifest.driverId,
    });
  }
  return true;
}

export function assertReceiverCapabilityPackDriverManifestMatches(packManifest) {
  if (packManifest?.adapter?.kind !== 'receiver') return true;
  instantiateReceiverCapabilityPackDriver(
    packManifest,
    receiverDriverManifestCheckOptions(packManifest),
    { bindReceiverAuthority: false },
  );
  return true;
}

export function assertCapabilityPackDriverManifestMatches(packManifest, driverManifest) {
  if (driverManifest.packFingerprint !== packManifest.packFingerprint) {
    fail('ERR_CAPABILITY_PACK_ADAPTER_MANIFEST_MISMATCH', 'adapter manifest field mismatch: packFingerprint');
  }
  for (const field of RECEIVER_DRIVER_MANIFEST_FIELDS) {
    if (JSON.stringify(packManifest[field]) !== JSON.stringify(driverManifest[field])) {
      fail('ERR_CAPABILITY_PACK_ADAPTER_MANIFEST_MISMATCH', `adapter manifest field mismatch: ${field}`);
    }
  }
  return true;
}

export function createReceiverCapabilityPackDriver(packManifest, options = {}) {
  return instantiateReceiverCapabilityPackDriver(packManifest, options, { bindReceiverAuthority: true });
}

function instantiateReceiverCapabilityPackDriver(packManifest, options, { bindReceiverAuthority }) {
  if (packManifest?.adapter?.kind !== 'receiver') {
    fail('ERR_CAPABILITY_PACK_RECEIVER_ADAPTER_REQUIRED', 'capability pack must select a receiver-owned driver');
  }
  assertReceiverCapabilityPackDriverRegistered(packManifest);
  const factory = RECEIVER_DRIVER_FACTORIES.get(packManifest.driverId);
  const receiverOptions = bindReceiverAuthority
    ? bindReceiverCapabilityPackOptions(packManifest, options)
    : options;
  const driver = factory({
    ...receiverOptions,
    packFingerprint: packManifest.packFingerprint,
  });
  const driverManifest = driver.manifest();
  assertCapabilityPackDriverManifestMatches(packManifest, driverManifest);
  if (bindReceiverAuthority) assertReceiverCapabilityPackPolicyBounds(packManifest, driverManifest);
  return driver;
}

function bindReceiverCapabilityPackOptions(packManifest, options) {
  const descriptors = packManifest.requiredSecrets ?? [];
  const required = descriptors.filter((descriptor) => descriptor?.required !== false);
  const secretProvider = options.secretProvider ?? null;
  if (secretProvider == null) {
    if (required.length > 0) fail('ERR_SECRET_PROVIDER_REQUIRED', 'required capability-pack secrets need a receiver-local provider');
    return { ...options };
  }
  const scopedSecretProvider = scopeSecretProvider(secretProvider, descriptors);
  assertRequiredSecretsAvailable(scopedSecretProvider, descriptors);
  return { ...options, secretProvider: scopedSecretProvider };
}

function assertReceiverCapabilityPackPolicyBounds(packManifest, driverManifest) {
  assertReceiverCapabilityPackPolicyListBound(
    packManifest,
    driverManifest,
    'allowedOrigins',
    'origins',
    normalizeHttpOrigin,
  );
  assertReceiverCapabilityPackPolicyListBound(
    packManifest,
    driverManifest,
    'allowedMethods',
    'methods',
    normalizeHttpMethod,
  );
}

function assertReceiverCapabilityPackPolicyListBound(packManifest, driverManifest, requirementField, diagnosticField, normalize) {
  const bounds = packManifest.policyRequirements?.[requirementField] ?? [];
  if (!Array.isArray(bounds) || bounds.length === 0) return;
  const configured = driverManifest.diagnostics?.[diagnosticField];
  const normalizedBounds = bounds.map(normalize);
  const normalizedConfigured = Array.isArray(configured) ? configured.map(normalize) : null;
  if (
    normalizedConfigured == null ||
    normalizedBounds.some((value) => value == null) ||
    normalizedConfigured.some((value) => value == null || !normalizedBounds.includes(value))
  ) {
    fail(
      'ERR_CAPABILITY_PACK_ADAPTER_MANIFEST_MISMATCH',
      `receiver driver exceeds pack policy requirements: ${requirementField}`,
    );
  }
}

function normalizeHttpOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function normalizeHttpMethod(value) {
  return typeof value === 'string' && value.length > 0 ? value.toUpperCase() : null;
}

function receiverDriverManifestCheckOptions(packManifest) {
  if (packManifest.driverId === 'generic-http-json' || packManifest.driverId === 'generic-http-json-model') {
    return { endpointUrl: 'https://example.invalid/decide' };
  }
  return {};
}
