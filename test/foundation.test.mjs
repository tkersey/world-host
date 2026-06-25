import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createCarrierFoundation } from '../src/core/carrier.mjs';
import { assertCarrierManifest, carrierManifest, carrierVersionSummary } from '../src/protocol/world_manifest.mjs';
import { assertWireCodecBoundary, requireReleasedWireCodec } from '../src/protocol/world_appliance_wire_codec.mjs';
import { assertLoadedValueCodecBoundary, requireReleasedLoadedValueCodec } from '../src/protocol/world_loaded_value_codec.mjs';

const root = new URL('../', import.meta.url);

describe('repository foundation', () => {
  it('declares an ESM package with zero runtime dependencies', async () => {
    const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    assert.equal(packageJson.type, 'module');
    assert.deepEqual(packageJson.dependencies, {});
    assert.deepEqual(packageJson.devDependencies, {});
    assert.equal(packageJson.scripts.test, 'node --test');
  });

  it('creates the requested source layout', async () => {
    const required = [
      'bin/world-host.mjs',
      'src/core/carrier.mjs',
      'src/protocol/world_manifest.mjs',
      'src/protocol/world_appliance_wire_codec.mjs',
      'src/protocol/world_loaded_value_codec.mjs',
      'src/node/node_cli.mjs',
      'src/stores/memory_store.mjs',
      'src/stores/directory_store.mjs',
      'src/node/node_lock.mjs',
      'src/stores',
      'src/drivers',
      'examples',
      'test',
    ];
    for (const relative of required) {
      const url = new URL(relative, root);
      assert.ok(url.pathname.endsWith(path.normalize(relative)), relative);
      await readFile(url).catch((error) => {
        if (error.code === 'EISDIR') return null;
        throw error;
      });
    }
  });

  it('pins the reviewed World surface and requires release checksum verification', () => {
    const manifest = assertCarrierManifest();
    assert.equal(manifest.supportedWorldRelease, 'v0.1.0');
    assert.equal(manifest.supportedBoundaryRelease, 'v0.5.0');
    assert.equal(manifest.applianceAbiVersion, 'v3');
    assert.equal(manifest.turnClosureFormatVersion, 'v1');
    assert.match(manifest.universalWasm.sha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.universalWasm.releaseVerificationRequired, true);
  });

  it('keeps documented pinned checksum aligned with the manifest', async () => {
    const readme = await readFile(new URL('README.md', root), 'utf8');
    const distribution = await readFile(new URL('docs/distribution.md', root), 'utf8');
    assert.match(readme, new RegExp(`Universal WASM SHA-256: \`${carrierManifest.universalWasm.sha256}\``));
    assert.match(distribution, new RegExp(`universal WASM SHA-256: \`${carrierManifest.universalWasm.sha256}\``));
  });

  it('keeps workers non-authoritative at the foundation boundary', () => {
    const foundation = createCarrierFoundation();
    assert.equal(foundation.storageAuthority, 'RunHead');
    assert.equal(foundation.workerAuthority, 'cache-only');
    assert.equal(foundation.worldCoreMutationAllowed, false);
    assert.equal(carrierVersionSummary().universalWasmSha256, carrierManifest.universalWasm.sha256);
  });

  it('forbids native helper and child-process protocol encoding boundaries', () => {
    assert.equal(assertWireCodecBoundary().worldEvidenceAuthority, false);
    assert.equal(assertLoadedValueCodecBoundary().worldEvidenceAuthority, false);
    assert.throws(() => assertWireCodecBoundary({ nativeWorldHelperProcess: true }), /ERR_NATIVE_WORLD_HELPER_FORBIDDEN/);
    assert.throws(() => assertLoadedValueCodecBoundary({ childProcessProtocolEncoding: true }), /ERR_CHILD_PROCESS_PROTOCOL_ENCODING_FORBIDDEN/);
    assert.throws(() => assertWireCodecBoundary({ constructsWorldEvidence: true }), /ERR_WORLD_EVIDENCE_FORBIDDEN/);
  });

  it('does not silently substitute missing released codecs with host-authored evidence logic', () => {
    const wire = requireReleasedWireCodec();
    const loaded = requireReleasedLoadedValueCodec();
    assert.equal(wire.boundary.worldEvidenceAuthority, false);
    assert.equal(loaded.boundary.worldEvidenceAuthority, false);
    assert.equal(typeof wire.encodeBootTurnInput, 'function');
    assert.equal(typeof loaded.encodeCanonicalValueImage, 'function');
  });
});
