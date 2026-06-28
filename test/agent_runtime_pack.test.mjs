import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildAgentRuntimePack,
  checkAgentRuntimePack,
  emitReleaseReceipt,
} from '../scripts/agent_runtime_pack_lib.mjs';
import {
  assertAgentRuntimeManifest,
  buildAgentRuntimeManifest,
  carrierManifestFingerprint,
} from '../src/protocol/agent_runtime_manifest.mjs';

describe('Agent Runtime pack', () => {
  it('builds a checksum-covered pack with a self-validating manifest', async () => {
    if (!existsSync(path.resolve('../world/zig-out/dist/world-v0.1.0/world_universal_appliance.wasm'))) return;
    if (!existsSync(path.resolve('../world/zig-out/dist/world-v0.1.0/agent-runtime/agent.executable-image'))) return;
    if (!existsSync(path.resolve('../boundary/zig-out/dist/boundary-v0.6.2-agent-runtime/agent-root.full-module'))) return;
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-pack-test-'));
    try {
      const pack = path.join(root, 'agent-runtime-v0.1');
      const built = await buildAgentRuntimePack({
        out: pack,
        boundaryRepo: path.resolve('../boundary'),
        worldRepo: path.resolve('../world'),
        worldHostRepo: process.cwd(),
      });
      const checked = await checkAgentRuntimePack(pack);
      const receipt = await emitReleaseReceipt(pack);
      const corpus = JSON.parse(await readFile(path.join(pack, 'conformance/corpus.json'), 'utf8'));

      assert.equal(checked.complete, true);
      assert.equal(checked.manifest.manifestFingerprint, built.manifest.manifestFingerprint);
      assert.equal(assertAgentRuntimeManifest(checked.manifest), checked.manifest);
      assert.equal(receipt.complete, true);
      assert.equal(corpus.requiredScenarios.includes('skeleton'), true);
      assert.equal(corpus.requiredScenarios.includes('fixture'), true);
      assert.deepEqual(corpus.warnings, []);
      assert.equal(checked.manifest.artifacts.boundary.agentRootModule.exportedByOwner, true);
      assert.equal(checked.manifest.artifacts.world.executableImage.exportedByOwner, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects manifest fingerprint drift', () => {
    const manifest = buildAgentRuntimeManifest({
      agentRuntimeVersion: 'v0.1',
      boundary: {
        packageVersion: '0.6.2',
        packageHash: 'abc',
        protocolManifestFingerprint: 'boundary:protocol',
        agentProfileFingerprint: 'boundary:profile',
        agentRootModuleFingerprint: 'boundary:root',
        toolboxModuleFingerprint: 'boundary:toolbox',
      },
      world: {
        packageVersion: 'world-v0.1.0',
        protocolManifestFingerprint: 'world:protocol',
        executableImageFingerprint: 'world:image',
        applianceManifestFingerprint: 'world:appliance',
        universalWasmSha256: '0'.repeat(64),
        applianceAbiVersion: 'v4',
        turnClosureFormatVersion: 'v1',
        archiveFormatVersion: 'v1',
      },
      worldHost: {
        packageVersion: '0.0.0-carrier-v0',
        carrierManifestFingerprint: carrierManifestFingerprint(),
      },
      requiredDescriptorFingerprints: ['descriptor:fixture-agent-model', 'descriptor:sandbox-file'],
      requiredHostAuthorityLabels: ['model:fixture-agent', 'file:sandbox'],
      conformanceCorpusFingerprint: 'agent-runtime:corpus',
      releaseReceiptFingerprint: 'agent-runtime:receipt',
    });
    assert.throws(() => assertAgentRuntimeManifest({ ...manifest, agentRuntimeVersion: 'v0.2' }), /ERR_AGENT_RUNTIME_MANIFEST_FINGERPRINT/);
  });
});
