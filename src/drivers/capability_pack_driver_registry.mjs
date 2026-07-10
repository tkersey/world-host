import { fail } from '../core/store.mjs';
import { GenericHttpJsonCapabilityDriver } from './generic_http_json_capability_driver.mjs';
import { HumanApprovalCapabilityDriver } from './human_approval_capability_driver.mjs';
import { FixtureAgentModelCapabilityDriver } from './model_capability_driver.mjs';

const RECEIVER_DRIVER_FACTORIES = new Map([
  ['fixture-agent-model', (options) => new FixtureAgentModelCapabilityDriver(options)],
  ['generic-http-json', (options) => new GenericHttpJsonCapabilityDriver(options)],
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
  createReceiverCapabilityPackDriver(packManifest, receiverDriverManifestCheckOptions(packManifest));
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
  if (packManifest?.adapter?.kind !== 'receiver') {
    fail('ERR_CAPABILITY_PACK_RECEIVER_ADAPTER_REQUIRED', 'capability pack must select a receiver-owned driver');
  }
  assertReceiverCapabilityPackDriverRegistered(packManifest);
  const factory = RECEIVER_DRIVER_FACTORIES.get(packManifest.driverId);
  const driver = factory({
    ...options,
    packFingerprint: packManifest.packFingerprint,
  });
  assertCapabilityPackDriverManifestMatches(packManifest, driver.manifest());
  return driver;
}

function receiverDriverManifestCheckOptions(packManifest) {
  if (packManifest.driverId === 'generic-http-json') {
    return { endpointUrl: 'https://example.invalid/decide' };
  }
  return {};
}
