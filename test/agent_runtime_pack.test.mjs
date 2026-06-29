import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  assertAgentRuntimeReleaseReceipt,
  buildAgentRuntimePack,
  checkAgentRuntimePack,
  emitReleaseReceipt,
  refreshAgentRuntimePackChecksums,
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
      const blockedReceipt = {
        ...receipt,
        blockers: ['blocked'],
      };
      blockedReceipt.receiptFingerprint = releaseReceiptFingerprint(blockedReceipt);
      await assert.rejects(
        () => assertAgentRuntimeReleaseReceipt(pack, blockedReceipt),
        /ERR_AGENT_RUNTIME_RELEASE_RECEIPT_blockers/,
      );
      assert.equal(corpus.requiredScenarios.includes('skeleton'), true);
      assert.equal(corpus.requiredScenarios.includes('fixture'), true);
      assert.deepEqual(corpus.warnings, []);
      assert.equal(checked.manifest.artifacts.boundary.agentRootModule.exportedByOwner, true);
      assert.equal(checked.manifest.artifacts.world.executableImage.exportedByOwner, true);

      const incompletePack = path.join(root, 'agent-runtime-v0.1-missing-runtime');
      await cp(pack, incompletePack, { recursive: true });
      await rm(path.join(incompletePack, 'world-host/src/core/store.mjs'));
      await refreshAgentRuntimePackChecksums(incompletePack);
      await assert.rejects(
        () => checkAgentRuntimePack(incompletePack),
        /missing required file: .*world-host\/src\/core\/store\.mjs/,
      );

      const missingConformancePack = path.join(root, 'agent-runtime-v0.1-missing-conformance-script');
      await cp(pack, missingConformancePack, { recursive: true });
      await rm(path.join(missingConformancePack, 'world-host/scripts/run-agent-runtime-conformance.mjs'));
      await refreshAgentRuntimePackChecksums(missingConformancePack);
      await assert.rejects(
        () => checkAgentRuntimePack(missingConformancePack),
        /missing required file: .*world-host\/scripts\/run-agent-runtime-conformance\.mjs/,
      );

      const staleBoundaryCorpusPack = path.join(root, 'agent-runtime-v0.1-stale-boundary-corpus');
      await cp(pack, staleBoundaryCorpusPack, { recursive: true });
      const boundaryCorpusPath = path.join(staleBoundaryCorpusPack, 'boundary/corpus.boundary-agent.txt');
      const staleCorpus = (await readFile(boundaryCorpusPath, 'utf8')).replace(
        /^profile_fingerprint:\s*0x[0-9a-f]+\s*$/im,
        'profile_fingerprint: 0x1111111111111111',
      );
      await writeFile(boundaryCorpusPath, staleCorpus);
      await refreshAgentRuntimePackChecksums(staleBoundaryCorpusPack);
      await assert.rejects(
        () => checkAgentRuntimePack(staleBoundaryCorpusPack),
        /ERR_AGENT_RUNTIME_BOUNDARY_CORPUS_PROFILE_FINGERPRINT/,
      );
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
      requiredActuatorRefs: ['world:actuator-ref:4f0c7160f25c4c62', 'world:actuator-ref:d5e4b1b427522cf2'],
      requiredDescriptorFingerprints: ['world:descriptor:be73177924a6b377', 'world:descriptor:74afc8c3b2fe4c33'],
      requiredHostAuthorityLabels: ['model:fixture-agent', 'file:sandbox'],
      conformanceCorpusFingerprint: 'agent-runtime:corpus',
      releaseReceiptFingerprint: 'agent-runtime:receipt',
    });
    assert.throws(() => assertAgentRuntimeManifest({ ...manifest, agentRuntimeVersion: 'v0.2' }), /ERR_AGENT_RUNTIME_MANIFEST_FINGERPRINT/);
  });

  it('rejects source roots as pack build output targets', async () => {
    await assert.rejects(
      () => buildAgentRuntimePack({ out: process.cwd(), worldHostRepo: process.cwd() }),
      /ERR_AGENT_RUNTIME_UNSAFE_OUT:worldHostRepo/,
    );
  });

  it('accepts owner-exported actuator fingerprint refs in the manifest', () => {
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
      requiredActuatorRefs: ['world:actuator-ref:4f0c7160f25c4c62', 'world:actuator-ref:d5e4b1b427522cf2'],
      requiredDescriptorFingerprints: ['world:descriptor:be73177924a6b377', 'world:descriptor:74afc8c3b2fe4c33'],
      requiredHostAuthorityLabels: ['model:fixture-agent', 'file:sandbox'],
      conformanceCorpusFingerprint: 'agent-runtime:corpus',
      releaseReceiptFingerprint: 'agent-runtime:receipt',
    });

    assert.deepEqual(manifest.requiredActuatorRefs, ['world:actuator-ref:4f0c7160f25c4c62', 'world:actuator-ref:d5e4b1b427522cf2']);
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
