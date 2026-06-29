import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  assertAgentRuntimeReleaseReceipt,
  buildAgentRuntimePack,
  checkAgentRuntimePack,
  emitReleaseReceipt,
} from '../scripts/agent_runtime_pack_lib.mjs';
import {
  assertAgentRuntimeManifest,
  buildAgentRuntimeManifest,
  carrierManifestFingerprint,
  releaseReceiptFingerprint,
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
      await assert.rejects(() => emitReleaseReceipt(pack), /ERR_AGENT_RUNTIME_CONFORMANCE_REQUIRED/);
      const receipt = await emitReleaseReceipt(pack, passingConformanceReceipt(checked.manifest));
      const corpus = JSON.parse(await readFile(path.join(pack, 'conformance/corpus.json'), 'utf8'));

      assert.equal(checked.complete, true);
      assert.equal(checked.manifest.manifestFingerprint, built.manifest.manifestFingerprint);
      assert.equal(assertAgentRuntimeManifest(checked.manifest), checked.manifest);
      assert.equal(receipt.complete, true);
      await assertAgentRuntimeReleaseReceipt(pack, receipt);
      const tamperedReceipt = {
        ...receipt,
        universalWasmChecksum: '0'.repeat(64),
      };
      tamperedReceipt.receiptFingerprint = releaseReceiptFingerprint(tamperedReceipt);
      await assert.rejects(
        () => assertAgentRuntimeReleaseReceipt(pack, tamperedReceipt),
        /ERR_AGENT_RUNTIME_RELEASE_RECEIPT_universalWasmChecksum/,
      );
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

  it('canonicalizes owner-exported actuator refs in the manifest', () => {
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
      requiredActuatorRefs: ['sandbox:file', 'fixture:agent-model'],
      requiredDescriptorFingerprints: ['descriptor:fixture-agent-model', 'descriptor:sandbox-file'],
      requiredHostAuthorityLabels: ['model:fixture-agent', 'file:sandbox'],
      conformanceCorpusFingerprint: 'agent-runtime:corpus',
      releaseReceiptFingerprint: 'agent-runtime:receipt',
    });

    assert.deepEqual(manifest.requiredActuatorRefs, ['fixture:agent-model', 'sandbox:file']);
  });
});

function passingConformanceReceipt(manifest) {
  return {
    receiptFormatVersion: 1,
    agentRuntimeManifestFingerprint: manifest.manifestFingerprint,
    agent_runtime_conformance: true,
    skeleton_completed: true,
    fixture_completed: true,
    replay_matched: true,
    retry_matched: true,
    migration_matched: true,
    branching_matched: true,
    negative_cases_rejected: true,
    world_evidence_validated: true,
    host_did_not_author_receipts: true,
    no_generated_agent_target_type: true,
    no_native_helper_process: true,
    distributed_wasm_compiled: true,
    distributed_wasm_instantiated: true,
    distributed_executable_image_loaded: true,
    distributed_appliance_manifest_matched: true,
  };
}
