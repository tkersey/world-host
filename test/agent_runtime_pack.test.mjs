import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  assertAgentRuntimeReleaseReceipt,
  buildAgentRuntimePack,
  checkAgentRuntimePack,
  emitReleaseReceipt,
  parseCommonArgs,
  refreshAgentRuntimePackChecksums,
} from '../scripts/agent_runtime_pack_lib.mjs';
import { runAgentRuntimeConformance } from '../scripts/run-agent-runtime-conformance.mjs';
import {
  assertAgentRuntimeManifest,
  buildAgentRuntimeManifest,
  carrierManifestFingerprint,
  fingerprintOf,
  releaseReceiptFingerprint,
  sha256Hex,
} from '../src/protocol/agent_runtime_manifest.mjs';
import { stableJson } from '../src/core/store.mjs';

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
      const preReceiptChecked = await checkAgentRuntimePack(pack);
      assert.equal(preReceiptChecked.releaseReceiptValidated, false);
      const builtReceipt = await emitReleaseReceipt(pack, passingConformanceReceipt(built.manifest));
      await writeFile(path.join(pack, 'manifest/agent-runtime-release-receipt.json'), `${JSON.stringify(builtReceipt, null, 2)}\n`);
      await refreshAgentRuntimePackChecksums(pack);
      const checked = await checkAgentRuntimePack(pack);
      await assert.rejects(() => emitReleaseReceipt(pack), /ERR_AGENT_RUNTIME_CONFORMANCE_REQUIRED/);
      const receipt = await emitReleaseReceipt(pack, passingConformanceReceipt(checked.manifest));
      const corpus = JSON.parse(await readFile(path.join(pack, 'conformance/corpus.json'), 'utf8'));
      const staleConformance = passingConformanceReceipt(checked.manifest);
      delete staleConformance.distributed_skeleton_scenario_completed;
      await assert.rejects(
        () => emitReleaseReceipt(pack, staleConformance),
        /ERR_AGENT_RUNTIME_CONFORMANCE_distributed_skeleton_scenario_completed/,
      );

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
      assert.equal(corpus.expected.skeletonRootResultFingerprint, 'world:root-result:469ea29edd2b9b6a');
      assert.equal(corpus.expected.fixtureRootResultFingerprint, 'world:root-result:716ad80792c9e8fe');
      assert.deepEqual(corpus.warnings, []);
      assert.equal(checked.manifest.artifacts.boundary.agentRootModule.exportedByOwner, true);
      assert.equal(checked.manifest.artifacts.world.executableImage.exportedByOwner, true);
      const packagedPackageJson = JSON.parse(await readFile(path.join(pack, 'world-host/package.json'), 'utf8'));
      assert.deepEqual(Object.keys(packagedPackageJson.scripts).sort(), ['check:agent-runtime']);
      assert.equal(packagedPackageJson.files.includes('test/'), false);
      assert.equal(packagedPackageJson.files.includes('carrier-manifest.json'), true);
      const packagedReadme = await readFile(path.join(pack, 'world-host/README.md'), 'utf8');
      assert.equal(/\bbun(?:\s+run)?\s+(?:test|proof(?::[\w-]+)?)/.test(packagedReadme), false);

      const cliPreservationPack = path.join(root, 'cli-preservation', 'agent-runtime-v0.1');
      await cp(path.resolve('agent-runtime-v0.1'), cliPreservationPack, { recursive: true });
      const releaseReceiptPath = path.join(cliPreservationPack, 'manifest/agent-runtime-release-receipt.json');
      const checksumsPath = path.join(cliPreservationPack, 'checksums.sha256');
      const releaseReceiptBeforeCliConformance = await readFile(releaseReceiptPath, 'utf8');
      const checksumsBeforeCliConformance = await readFile(checksumsPath, 'utf8');
      const cliConformance = spawnSync(process.execPath, [path.resolve('scripts/run-agent-runtime-conformance.mjs'), cliPreservationPack], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      assert.equal(cliConformance.status, 0, cliConformance.stderr);
      assert.equal(await readFile(releaseReceiptPath, 'utf8'), releaseReceiptBeforeCliConformance);
      assert.equal(await readFile(checksumsPath, 'utf8'), checksumsBeforeCliConformance);

      const tamperedCliConformancePack = path.join(root, 'tampered-cli-conformance', 'agent-runtime-v0.1');
      await cp(path.resolve('agent-runtime-v0.1'), tamperedCliConformancePack, { recursive: true });
      const tamperedCliReceiptPath = path.join(tamperedCliConformancePack, 'manifest/agent-runtime-release-receipt.json');
      const tamperedCliReceipt = JSON.parse(await readFile(tamperedCliReceiptPath, 'utf8'));
      tamperedCliReceipt.receiptFingerprint = 'agent-runtime:tampered';
      await writeFile(tamperedCliReceiptPath, `${JSON.stringify(tamperedCliReceipt, null, 2)}\n`);
      await refreshAgentRuntimePackChecksums(tamperedCliConformancePack);
      const tamperedCliConformance = spawnSync(process.execPath, [
        path.resolve('bin/world-host.mjs'),
        'agent',
        'conformance',
        '--pack',
        tamperedCliConformancePack,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      assert.notEqual(tamperedCliConformance.status, 0);
      assert.match(tamperedCliConformance.stderr, /ERR_AGENT_RUNTIME_RELEASE_RECEIPT_FINGERPRINT/);

      const freshConformancePack = path.join(root, 'fresh-conformance', 'agent-runtime-v0.1');
      await cp(path.resolve('agent-runtime-v0.1'), freshConformancePack, { recursive: true });
      await rm(path.join(freshConformancePack, 'manifest/agent-runtime-release-receipt.json'), { force: true });
      await refreshAgentRuntimePackChecksums(freshConformancePack);
      const fresh = await runAgentRuntimeConformance(freshConformancePack);
      assert.equal(fresh.receipt.distributed_skeleton_scenario_completed, true);
      assert.equal(fresh.receipt.distributed_fixture_scenario_completed, true);
      await assertAgentRuntimeReleaseReceipt(freshConformancePack, fresh.releaseReceipt);

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

      const missingWorldCorpusPack = path.join(root, 'agent-runtime-v0.1-missing-world-corpus');
      await cp(pack, missingWorldCorpusPack, { recursive: true });
      await rm(path.join(missingWorldCorpusPack, 'world/conformance-corpus.json'));
      await refreshAgentRuntimePackChecksums(missingWorldCorpusPack);
      await assert.rejects(
        () => checkAgentRuntimePack(missingWorldCorpusPack),
        /missing required file: .*world\/conformance-corpus\.json/,
      );

      const sourceOnlyScriptPack = path.join(root, 'agent-runtime-v0.1-source-only-script');
      await cp(pack, sourceOnlyScriptPack, { recursive: true });
      const sourceOnlyPackagePath = path.join(sourceOnlyScriptPack, 'world-host/package.json');
      const sourceOnlyPackage = JSON.parse(await readFile(sourceOnlyPackagePath, 'utf8'));
      sourceOnlyPackage.scripts.proof = 'bun test';
      await writeFile(sourceOnlyPackagePath, `${JSON.stringify(sourceOnlyPackage, null, 2)}\n`);
      await refreshAgentRuntimePackChecksums(sourceOnlyScriptPack);
      await assert.rejects(
        () => checkAgentRuntimePack(sourceOnlyScriptPack),
        /ERR_AGENT_RUNTIME_PACKAGE_SCRIPT:proof/,
      );

      const directoryStoreModulePack = path.join(root, 'agent-runtime-v0.1-directory-store-module');
      await cp(pack, directoryStoreModulePack, { recursive: true });
      const storeModulePath = path.join(directoryStoreModulePack, 'world-host/src/core/store.mjs');
      await rm(storeModulePath);
      await mkdir(storeModulePath);
      await writeFile(path.join(storeModulePath, 'nested.txt'), 'not a module');
      await refreshAgentRuntimePackChecksums(directoryStoreModulePack);
      await assert.rejects(
        () => checkAgentRuntimePack(directoryStoreModulePack),
        /required path is not a file: .*world-host\/src\/core\/store\.mjs/,
      );

      const staleWorldProtocolPack = path.join(root, 'agent-runtime-v0.1-stale-world-protocol');
      await cp(pack, staleWorldProtocolPack, { recursive: true });
      const protocolPath = path.join(staleWorldProtocolPack, 'world/world-protocol-manifest.bin');
      const protocol = JSON.parse(await readFile(protocolPath, 'utf8'));
      protocol.protocol_manifest_fingerprint_lo = '0x1111111111111111';
      await writeFile(protocolPath, `${JSON.stringify(protocol, null, 2)}\n`);
      await rewriteManifestArtifactSha(staleWorldProtocolPack, 'world', 'protocolManifest', await readFile(protocolPath));
      await refreshAgentRuntimePackChecksums(staleWorldProtocolPack);
      await assert.rejects(
        () => checkAgentRuntimePack(staleWorldProtocolPack),
        /ERR_AGENT_RUNTIME_WORLD_PROTOCOL_MANIFEST_FINGERPRINT/,
      );

      const staleBoundaryProtocolPack = path.join(root, 'agent-runtime-v0.1-stale-boundary-protocol');
      await cp(pack, staleBoundaryProtocolPack, { recursive: true });
      const boundaryProtocolPath = path.join(staleBoundaryProtocolPack, 'boundary/boundary-protocol-manifest.bin');
      const boundaryProtocol = new Uint8Array(await readFile(boundaryProtocolPath));
      boundaryProtocol[12] ^= 0xff;
      await writeFile(boundaryProtocolPath, boundaryProtocol);
      await rewriteManifestArtifactSha(staleBoundaryProtocolPack, 'boundary', 'protocolManifest', boundaryProtocol);
      await refreshAgentRuntimePackChecksums(staleBoundaryProtocolPack);
      await assert.rejects(
        () => checkAgentRuntimePack(staleBoundaryProtocolPack),
        /ERR_AGENT_RUNTIME_BOUNDARY_PROTOCOL_MANIFEST_FINGERPRINT/,
      );

      const reserializedProfilePack = path.join(root, 'agent-runtime-v0.1-reserialized-profile');
      await cp(pack, reserializedProfilePack, { recursive: true });
      const profilePath = path.join(reserializedProfilePack, 'boundary/agent-profile.json');
      const profile = JSON.parse(await readFile(profilePath, 'utf8'));
      await writeFile(profilePath, JSON.stringify(profile));
      await rewriteManifestArtifactSha(reserializedProfilePack, 'boundary', 'agentProfile', Buffer.from(stableJson(profile)));
      await refreshAgentRuntimePackChecksums(reserializedProfilePack);
      await assert.rejects(
        () => checkAgentRuntimePack(reserializedProfilePack),
        /ERR_AGENT_RUNTIME_ARTIFACT_SHA:boundary\.agentProfile\.sha256/,
      );

      const missingReleaseReceiptPack = path.join(root, 'agent-runtime-v0.1-missing-release-receipt');
      await cp(pack, missingReleaseReceiptPack, { recursive: true });
      await rm(path.join(missingReleaseReceiptPack, 'manifest/agent-runtime-release-receipt.json'));
      await refreshAgentRuntimePackChecksums(missingReleaseReceiptPack);
      await assert.rejects(
        () => checkAgentRuntimePack(missingReleaseReceiptPack, { requireReleaseReceipt: true }),
        /missing required file: .*manifest\/agent-runtime-release-receipt\.json/,
      );

      const unsafeProofReceiptPack = path.join(root, 'agent-runtime-v0.1-unsafe-proof-receipt');
      await cp(pack, unsafeProofReceiptPack, { recursive: true });
      const unsafeCorpusPath = path.join(unsafeProofReceiptPack, 'conformance/corpus.json');
      const unsafeCorpus = JSON.parse(await readFile(unsafeCorpusPath, 'utf8'));
      unsafeCorpus.proofReceipts[0] = { ...unsafeCorpus.proofReceipts[0], id: '../escape' };
      await writeFile(unsafeCorpusPath, `${JSON.stringify(unsafeCorpus, null, 2)}\n`);
      await rewriteManifestConformanceFingerprint(unsafeProofReceiptPack);
      await refreshAgentRuntimePackChecksums(unsafeProofReceiptPack);
      await assert.rejects(
        () => checkAgentRuntimePack(unsafeProofReceiptPack),
        /ERR_AGENT_RUNTIME_PROOF_RECEIPT_ID:\.\.\/escape/,
      );

      const wrongProofSubjectPack = path.join(root, 'agent-runtime-v0.1-wrong-proof-subject');
      await cp(pack, wrongProofSubjectPack, { recursive: true });
      const wrongCorpusPath = path.join(wrongProofSubjectPack, 'conformance/corpus.json');
      const wrongCorpus = JSON.parse(await readFile(wrongCorpusPath, 'utf8'));
      wrongCorpus.proofReceipts[0] = proofReceiptForTest(wrongCorpus.proofReceipts[0].id, 'agent-runtime:wrong-subject');
      await writeFile(wrongCorpusPath, `${JSON.stringify(wrongCorpus, null, 2)}\n`);
      await writeFile(
        path.join(wrongProofSubjectPack, `proof-receipts/${wrongCorpus.proofReceipts[0].id}.json`),
        `${JSON.stringify(wrongCorpus.proofReceipts[0], null, 2)}\n`,
      );
      await rewriteManifestConformanceFingerprint(wrongProofSubjectPack);
      await refreshAgentRuntimePackChecksums(wrongProofSubjectPack);
      await assert.rejects(
        () => checkAgentRuntimePack(wrongProofSubjectPack),
        /ERR_AGENT_RUNTIME_PROOF_RECEIPT_SUBJECT:boundary-agent-profile/,
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
    assert.throws(() => assertAgentRuntimeManifest({
      ...buildAgentRuntimeManifest({
        ...manifest,
        requiredHostAuthorityLabels: [],
      }),
      requiredHostAuthorityLabels: [],
    }), /requiredHostAuthorityLabels/);
  });

  it('rejects symlinked paths while checking pack checksum coverage', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-pack-symlink-'));
    try {
      const pack = path.join(root, 'agent-runtime-v0.1');
      await cp(path.resolve('agent-runtime-v0.1'), pack, { recursive: true });
      await symlink(root, path.join(pack, 'conformance/escape'), 'dir');
      await assert.rejects(
        () => checkAgentRuntimePack(pack),
        /ERR_PACK_SYMLINK:conformance\/escape/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects source roots as pack build output targets', async () => {
    await assert.rejects(
      () => buildAgentRuntimePack({ out: process.cwd(), worldHostRepo: process.cwd() }),
      /ERR_AGENT_RUNTIME_UNSAFE_OUT:worldHostRepo/,
    );
  });

  it('rejects missing values for valued pack CLI options', () => {
    assert.throws(() => parseCommonArgs(['--out']), /ERR_AGENT_RUNTIME_ARG_VALUE:--out/);
    assert.throws(() => parseCommonArgs(['--world-repo', '--boundary-repo', '../boundary']), /ERR_AGENT_RUNTIME_ARG_VALUE:--world-repo/);
    assert.deepEqual(parseCommonArgs(['--require-release-receipt']), { requireReleaseReceipt: true });
  });

  it('rejects non-pack build output directories before removal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-pack-unsafe-out-'));
    try {
      const marker = path.join(root, 'marker.txt');
      await writeFile(marker, 'keep');
      await assert.rejects(
        () => buildAgentRuntimePack({ out: root, worldHostRepo: process.cwd() }),
        /ERR_AGENT_RUNTIME_UNSAFE_OUT:packName/,
      );
      assert.equal(await readFile(marker, 'utf8'), 'keep');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it('uses the parsed Boundary package version when reading owner artifacts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-pack-boundary-version-'));
    try {
      const boundaryRepo = path.join(root, 'boundary');
      const worldRepo = path.join(root, 'world');
      const pack = path.join(root, 'agent-runtime-v0.1');
      await writeBoundaryRepoForPackTest(boundaryRepo, '0.7.1');
      await writeWorldRepoForPackTest(worldRepo);

      const built = await buildAgentRuntimePack({
        out: pack,
        boundaryRepo,
        worldRepo,
        worldHostRepo: process.cwd(),
      });

      assert.equal(built.manifest.boundary.packageVersion, '0.7.1');
      assert.equal(
        await readFile(path.join(pack, 'boundary/agent-root.full-module'), 'utf8'),
        'boundary-root-module-v0.7.1',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function passingConformanceReceipt(manifest) {
  return {
    receiptFormatVersion: 1,
    agentRuntimeManifestFingerprint: manifest.manifestFingerprint,
    agent_runtime_conformance: true,
    owner_skeleton_example_completed: true,
    owner_fixture_example_completed: true,
    replay_matched: true,
    retry_matched: true,
    migration_matched: true,
    branching_matched: true,
    negative_cases_rejected: true,
    world_evidence_validated: true,
    distributed_empty_payloads_rejected: true,
    distributed_skeleton_scenario_completed: true,
    distributed_fixture_scenario_completed: true,
    host_did_not_author_receipts: true,
    no_generated_agent_target_type: true,
    no_native_helper_process: true,
    distributed_wasm_compiled: true,
    distributed_wasm_instantiated: true,
    distributed_executable_image_loaded: true,
    distributed_appliance_manifest_matched: true,
  };
}

async function rewriteManifestArtifactSha(pack, group, artifact, bytes) {
  const manifestPath = path.join(pack, 'manifest/agent-runtime-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.artifacts[group][artifact].sha256 = sha256Hex(bytes);
  await writeManifest(pack, manifest);
}

async function rewriteManifestConformanceFingerprint(pack) {
  const manifestPath = path.join(pack, 'manifest/agent-runtime-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.conformanceCorpusFingerprint = await fingerprintDirectoryForTest(path.join(pack, 'conformance'));
  await writeManifest(pack, manifest);
}

async function writeManifest(pack, manifest) {
  const manifestPath = path.join(pack, 'manifest/agent-runtime-manifest.json');
  const withoutFingerprint = { ...manifest };
  delete withoutFingerprint.manifestFingerprint;
  manifest.manifestFingerprint = fingerprintOf(withoutFingerprint);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(pack, 'manifest/agent-runtime-manifest.bin'), Buffer.from(stableJson(manifest)));
}

async function fingerprintDirectoryForTest(root, prefix = '') {
  const dir = path.join(root, prefix);
  const entries = [];
  for (const entry of await readdir(dir)) {
    const rel = path.join(prefix, entry);
    const absolute = path.join(root, rel);
    const info = await lstat(absolute);
    if (info.isDirectory()) entries.push(...await fingerprintDirectoryEntriesForTest(root, rel));
    else if (info.isFile()) entries.push([rel.split(path.sep).join('/'), sha256Hex(await readFile(absolute))]);
  }
  return fingerprintOf(entries.sort(([left], [right]) => left.localeCompare(right)));
}

async function fingerprintDirectoryEntriesForTest(root, prefix) {
  const dir = path.join(root, prefix);
  const entries = [];
  for (const entry of await readdir(dir)) {
    const rel = path.join(prefix, entry);
    const absolute = path.join(root, rel);
    const info = await lstat(absolute);
    if (info.isDirectory()) entries.push(...await fingerprintDirectoryEntriesForTest(root, rel));
    else if (info.isFile()) entries.push([rel.split(path.sep).join('/'), sha256Hex(await readFile(absolute))]);
  }
  return entries;
}

function proofReceiptForTest(id, subject) {
  const receipt = {
    id,
    subject,
    generatedBy: 'agent-runtime-pack-builder',
    proofDerivedFromArtifactFingerprint: true,
  };
  return { ...receipt, fingerprint: fingerprintOf(receipt) };
}

async function writeBoundaryRepoForPackTest(root, version) {
  const exportDir = path.join(root, `zig-out/dist/boundary-v${version}-agent-runtime`);
  await mkdir(path.join(root, 'conformance/v0/agent'), { recursive: true });
  await mkdir(exportDir, { recursive: true });
  await writeFile(path.join(root, 'build.zig.zon'), `.version = "${version}",\n`);
  await writeFile(path.join(exportDir, 'agent-root.full-module'), `boundary-root-module-v${version}`);
  await writeFile(path.join(exportDir, 'toolbox-provider.full-module'), `boundary-toolbox-module-v${version}`);
  await writeFile(path.join(exportDir, 'boundary-protocol-manifest.bin'), boundaryProtocolManifestBytesForTest(0x1111n));
  await writeFile(path.join(exportDir, 'agent-profile.json'), `${JSON.stringify({
    boundary_protocol_manifest_fingerprint: '0x1111',
    profile_fingerprint: '0x2222',
    agent_root_module_fingerprint: '0x3333',
    toolbox_module_fingerprint: '0x4444',
    agent_root_full_module_byte_fingerprint: '0x5555',
    toolbox_full_module_byte_fingerprint: '0x6666',
  }, null, 2)}\n`);
  await writeFile(path.join(root, 'conformance/v0/agent/corpus.boundary-agent.txt'), 'profile_fingerprint: 0x0000\n');
}

function boundaryProtocolManifestBytesForTest(fingerprint) {
  const bytes = new Uint8Array(20);
  bytes.set(Buffer.from('BPM1'), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, 1, true);
  view.setBigUint64(12, fingerprint, true);
  return bytes;
}

async function writeWorldRepoForPackTest(root) {
  const dist = path.join(root, 'zig-out/dist/world-v0.1.0');
  const agentRuntime = path.join(dist, 'agent-runtime');
  await mkdir(path.join(dist, 'conformance/v0/world'), { recursive: true });
  await mkdir(agentRuntime, { recursive: true });
  await writeFile(path.join(dist, 'world_universal_appliance.wasm'), 'world-wasm');
  await writeFile(path.join(dist, 'world-release-receipt.json'), '{"world_release":true}\n');
  await writeFile(path.join(dist, 'conformance/v0/world/corpus.json'), '{"world_corpus":true}\n');
  await writeFile(path.join(dist, 'world-release-artifact.json'), `${JSON.stringify({
    package: 'world-v0.1.0',
    wasm: {
      protocol_manifest_fingerprint_hi: '0xaaaa',
      protocol_manifest_fingerprint_lo: '0xbbbb',
      abi_version: 4,
    },
  }, null, 2)}\n`);
  await writeFile(path.join(dist, 'world-protocol-manifest.json'), '{"world_protocol":true}\n');
  await writeFile(path.join(agentRuntime, 'agent.executable-image'), 'world-agent-image');
  await writeFile(path.join(agentRuntime, 'appliance-manifest.bin'), 'world-appliance-manifest');
  await writeFile(path.join(agentRuntime, 'agent-runtime-world-artifacts.json'), `${JSON.stringify({
    world_executable_image_fingerprint: '0x7777',
    world_appliance_manifest_fingerprint: '0x8888',
    world_appliance_abi_version: 4,
    world_turn_closure_format_version: 1,
    world_archive_format_version: 1,
    required_actuator_ref_fingerprints: ['0x4f0c7160f25c4c62', '0xd5e4b1b427522cf2'],
    required_descriptor_fingerprints: ['0xbe73177924a6b377', '0x74afc8c3b2fe4c33'],
  }, null, 2)}\n`);
}
