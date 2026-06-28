import { assertCarrierManifest, carrierManifest } from '../protocol/world_manifest.mjs';
export { createApplicationRecord } from './application.mjs';
export { createBranchRecord, createRunHead, createRunRecord } from './run.mjs';
export { ClosureStore, makeBlobRef, sameBlobRef } from './store.mjs';
export { createCarrierProofBundle, exportCarrierRun, forkRunBranch, importCarrierRun } from './migration.mjs';

export function createCarrierFoundation(options = {}) {
  const manifest = assertCarrierManifest(options.manifest ?? carrierManifest);
  return Object.freeze({
    kind: 'world-host.carrier-foundation',
    manifest,
    storageAuthority: 'RunHead',
    workerAuthority: 'cache-only',
    worldCoreMutationAllowed: false,
  });
}
