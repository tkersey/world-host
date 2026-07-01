import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { stableJson } from '../src/core/store.mjs';
import {
  assertAgentRuntimeManifest,
  buildAgentRuntimeManifest,
  carrierManifestFingerprint,
  fingerprintOf,
  releaseReceiptFingerprint,
  sha256Hex,
} from '../src/protocol/agent_runtime_manifest.mjs';
import { wyhash64 } from '../src/protocol/world_loaded_value_codec.mjs';

export const PACK_NAME = 'agent-runtime-v0.1';
export const FIXTURE_INPUT = 'rewrite this file through the agent loop\n';
export const FIXTURE_OUTPUT = 'actuate updated the fixture';
export const FIXTURE_RESULT = 'final=fixture updated';
export const SKELETON_RESULT = 'final=actuate skeleton complete';
const EXPECTED_PACK_CHECK_SCRIPT = 'bun scripts/check-agent-runtime-pack.mjs && bun scripts/run-agent-runtime-conformance.mjs && bun scripts/check-agent-runtime-pack.mjs --require-release-receipt && bun scripts/check-agent-runtime-release-receipt.mjs';
const EXPECTED_PACKAGE_FILES = Object.freeze([
  'bin/',
  'docs/',
  'examples/',
  'scripts/',
  'src/',
  'carrier-manifest.json',
  'agent-runtime-artifacts.json',
  'README.md',
]);
const WORLD_V0_BOUNDARY_PROTOCOL_MANIFEST_FINGERPRINT = '0x68ce6ebd4448144f';
const WORLD_V0_CONFORMANCE_CORPUS_ROOT_FINGERPRINT = '0xe727536b60a5e286';
const WORLD_V0_SOURCE_PACKAGE_CHECKSUM_BY_HEAD = Object.freeze({
  a8b594e428d49f93d5dcf5a862e7c28192dd44ef: '0x21cf0eced28585af',
});
const WORLD_V0_PROTOCOL_FINGERPRINT_BY_HEAD = Object.freeze({
  a8b594e428d49f93d5dcf5a862e7c28192dd44ef: '0xc6fb4236a4b64302:0xdeaadbe889dbe92a',
});
const WORLD_V0_EXECUTABLE_IMAGE_SHA256_BY_HEAD = Object.freeze({
  a8b594e428d49f93d5dcf5a862e7c28192dd44ef: 'f75eda188131e9782dd7b1de3c5083262a13a9007f355a89ba9f79983ba06795',
});
const WORLD_V0_APPLIANCE_MANIFEST_SHA256_BY_HEAD = Object.freeze({
  a8b594e428d49f93d5dcf5a862e7c28192dd44ef: 'd5ff90e2a2738ce18a45303d65799fe4e2687e19e04090859f9e73d750b7df74',
});
const WORLD_V0_UNIVERSAL_WASM_SHA256_BY_HEAD = Object.freeze({
  a8b594e428d49f93d5dcf5a862e7c28192dd44ef: 'a79ae458d3cc5145660dadfc678736e75822c8c70558f8139861dc1103e84add',
});
const WORLD_V0_REQUIRED_ACTUATOR_REFS_BY_HEAD = Object.freeze({
  a8b594e428d49f93d5dcf5a862e7c28192dd44ef: Object.freeze([
    'world:actuator-ref:4f0c7160f25c4c62',
    'world:actuator-ref:d5e4b1b427522cf2',
  ]),
});
const WORLD_V0_REQUIRED_DESCRIPTOR_FINGERPRINTS_BY_HEAD = Object.freeze({
  a8b594e428d49f93d5dcf5a862e7c28192dd44ef: Object.freeze([
    'world:descriptor:be73177924a6b377',
    'world:descriptor:74afc8c3b2fe4c33',
  ]),
});
const WORLD_HOST_PACKAGE_VERSION = '0.0.0-carrier-v0';
const WORLD_HOST_CARRIER_MODULE_SHA256 = '322ea7e3baca7a64d4ff48626f85ccd96165e05e9c8fbb878f0e583a656eef31';
const WORLD_V0_REQUIRED_PROOF_KINDS = Object.freeze([
  'boundary_portable_v2',
  'executable_image',
  'universal_wasm_execution',
  'two_programs_one_wasm',
  'loaded_internal_provider',
  'multi_suspension_root',
  'active_fabric_restore',
  'replay_without_fresh_effect',
  'unsupported_actuated_replay_rejected',
  'deterministic_retry',
  'batched_request_reply',
  'independent_javascript_codec',
  'exact_result_bytes',
  'exact_receipt_bytes',
  'exact_capsule_bytes',
  'exact_archive_append_batch_bytes',
  'native_wasm_parity',
  'cold_warm_parity',
  'memory_bound',
  'malformed_input',
  'regression_matrix',
  'reproducible_artifact',
]);
const WORLD_V0_PROOF_GATES = Object.freeze({
  boundary_portable_v2: 'check-boundary-world-compatibility',
  executable_image: 'check-world-executable-image',
  universal_wasm_execution: 'check-world-universal-appliance-node',
  two_programs_one_wasm: 'check-world-two-programs-one-wasm',
  loaded_internal_provider: 'check-world-universal-providers',
  multi_suspension_root: 'check-world-loaded-runspace',
  active_fabric_restore: 'check-world-active-fabric-restore',
  replay_without_fresh_effect: 'check-world-replay-positive',
  unsupported_actuated_replay_rejected: 'check-world-v0-negative',
  deterministic_retry: 'check-world-deterministic-retry',
  batched_request_reply: 'check-world-appliance-batching',
  independent_javascript_codec: 'check-world-js-codec',
  exact_result_bytes: 'check-world-conformance-corpus',
  exact_receipt_bytes: 'check-world-adversarial-codecs',
  exact_capsule_bytes: 'check-world-adversarial-codecs',
  exact_archive_append_batch_bytes: 'check-world-adversarial-codecs',
  native_wasm_parity: 'check-world-state-machine-differential',
  cold_warm_parity: 'check-world-state-machine-differential',
  memory_bound: 'check-world-universal-memory',
  malformed_input: 'check-world-js-malformed-corpus',
  regression_matrix: 'check-world-conformance-corpus',
  reproducible_artifact: 'check-world-reproducible-wasm',
});

export function parseCommonArgs(raw) {
  const parsed = {};
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];
    if (arg === '--out' || arg === '--pack') parsed.out = optionValue(raw, ++i, arg);
    else if (arg === '--boundary-repo') parsed.boundaryRepo = optionValue(raw, ++i, arg);
    else if (arg === '--world-repo') parsed.worldRepo = optionValue(raw, ++i, arg);
    else if (arg === '--world-host-repo') parsed.worldHostRepo = optionValue(raw, ++i, arg);
    else if (arg === '--receipt-out') parsed.receiptOut = optionValue(raw, ++i, arg);
    else if (arg === '--release-receipt-out') parsed.releaseReceiptOut = optionValue(raw, ++i, arg);
    else if (arg === '--conformance-receipt') parsed.conformanceReceipt = optionValue(raw, ++i, arg);
    else if (arg === '--require-release-receipt') parsed.requireReleaseReceipt = true;
    else if (!arg.startsWith('--') && !parsed.out) parsed.out = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function optionValue(raw, index, flag) {
  const value = raw[index];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
    throw new Error(`ERR_AGENT_RUNTIME_ARG_VALUE:${flag}`);
  }
  return value;
}

export function defaultRoots(options = {}) {
  const cwd = process.cwd();
  return {
    worldHostRepo: path.resolve(options.worldHostRepo ?? cwd),
    worldRepo: path.resolve(options.worldRepo ?? path.join(cwd, '../world')),
    boundaryRepo: path.resolve(options.boundaryRepo ?? path.join(cwd, '../boundary')),
  };
}

export function defaultPackPath(cwd = process.cwd()) {
  if (existsSync(path.join(cwd, 'manifest/agent-runtime-manifest.json'))) return cwd;
  if (path.basename(cwd) === 'world-host' && existsSync(path.join(cwd, '../manifest/agent-runtime-manifest.json'))) return path.join(cwd, '..');
  return PACK_NAME;
}

export async function buildAgentRuntimePack(options = {}) {
  const roots = defaultRoots(options);
  const out = path.resolve(options.out ?? PACK_NAME);
  assertSafePackOutput(out, roots);
  const worldDist = path.join(roots.worldRepo, 'zig-out/dist/world-v0.1.0');
  await requireFile(path.join(worldDist, 'world_universal_appliance.wasm'));
  await requireFile(path.join(worldDist, 'world-release-receipt.json'));
  await requireFile(path.join(worldDist, 'conformance/v0/world/corpus.json'));
  const host = await worldHostArtifacts(roots.worldHostRepo);

  await rm(out, { recursive: true, force: true });
  for (const rel of [
    'manifest',
    'boundary',
    'world',
    'world-host',
    'conformance/skeleton',
    'conformance/fixture',
    'conformance/replay',
    'conformance/retry',
    'conformance/migration',
    'conformance/branching',
    'conformance/negative',
    'fixtures',
    'docs',
    'proof-receipts',
  ]) {
    await mkdir(path.join(out, rel), { recursive: true });
  }

  const boundary = await boundaryArtifacts(roots.boundaryRepo);
  const world = await worldArtifacts(roots.worldRepo, worldDist);
  await writeArtifactSet(out, boundary, world, host);
  await copyWorldHostPackage(roots.worldHostRepo, path.join(out, 'world-host'));
  await writeConformanceCorpus(out, boundary, world, host);
  await writeFixtures(out);
  await writeDocs(out, boundary, world, host);

  const conformanceCorpusFingerprint = await fingerprintDirectory(path.join(out, 'conformance'));
  const packagedHost = {
    ...host,
    artifacts: {
      ...host.artifacts,
      packageTree: {
        exportedByOwner: true,
        fingerprint: await fingerprintWorldHostPackageTree(out),
      },
    },
  };
  await writeAgentRuntimeArtifacts(out, boundary, world, packagedHost);
  const manifest = buildAgentRuntimeManifest({
    agentRuntimeVersion: 'v0.1',
    boundary,
    world,
    worldHost: packagedHost,
    requiredActuatorRefs: world.requiredActuatorRefs,
    requiredDescriptorFingerprints: world.requiredDescriptorFingerprints,
    requiredHostAuthorityLabels: [
      'model:fixture-agent',
      'file:sandbox',
    ],
    conformanceCorpusFingerprint,
    artifacts: {
      boundary: boundary.artifacts,
      world: world.artifacts,
      worldHost: packagedHost.artifacts,
    },
    metadata: {
      semanticIdentityHasWallClock: false,
      credentialsIncluded: false,
      hostSpecificFilesystemPathsIncluded: false,
      buildDiagnostics: {
        boundaryHead: boundary.gitHead,
        worldHead: world.gitHead,
        worldHostHead: packagedHost.artifacts.packageTree.fingerprint,
        worldHostDirty: host.gitDirty,
      },
    },
  });
  await writeFile(path.join(out, 'manifest/agent-runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(out, 'manifest/agent-runtime-manifest.bin'), Buffer.from(stableJson(manifest)));
  await writeChecksums(out);
  return { out, manifest };
}

function assertSafePackOutput(out, roots) {
  const resolvedOut = path.resolve(out);
  for (const [label, root] of Object.entries(roots)) {
    const resolvedRoot = path.resolve(root);
    if (resolvedOut === resolvedRoot || isPathInside(resolvedRoot, resolvedOut)) {
      throw new Error(`ERR_AGENT_RUNTIME_UNSAFE_OUT:${label}`);
    }
    if (isPathInside(resolvedOut, resolvedRoot) && path.relative(resolvedRoot, resolvedOut).split(path.sep).join('/') !== PACK_NAME) {
      throw new Error(`ERR_AGENT_RUNTIME_UNSAFE_OUT:${label}`);
    }
  }
  if (path.basename(resolvedOut) !== PACK_NAME) {
    throw new Error('ERR_AGENT_RUNTIME_UNSAFE_OUT:packName');
  }
}

function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function checkAgentRuntimePack(pack, options = {}) {
  const root = path.resolve(pack);
  const releaseReceiptPath = path.join(root, 'manifest/agent-runtime-release-receipt.json');
  const requireReleaseReceipt = options.requireReleaseReceipt === true || options.validateReleaseReceipt === true;
  const validateReleaseReceipt = options.validateReleaseReceipt === false
    ? false
    : requireReleaseReceipt || existsSync(releaseReceiptPath);
  const required = [
    'manifest/agent-runtime-manifest.bin',
    'manifest/agent-runtime-manifest.json',
    'boundary/agent-root.full-module',
    'boundary/toolbox-provider.full-module',
    'boundary/boundary-protocol-manifest.bin',
    'boundary/agent-profile.json',
    'boundary/corpus.boundary-agent.txt',
    'world/agent.executable-image',
    'world/appliance-manifest.bin',
    'world/world_universal_appliance.wasm',
    'world/world-protocol-manifest.bin',
    'world/release-receipt.bin',
    'world/conformance-corpus.json',
    'world/agent-runtime-world-artifacts.json',
    'world-host/bin/world-host.mjs',
    'world-host/docs/agent_runtime.md',
    'world-host/examples/agent_runtime/README.md',
    'world-host/examples/agent_runtime/branching/run.mjs',
    'world-host/examples/agent_runtime/fixture_file_rewrite/run.mjs',
    'world-host/examples/agent_runtime/migration/run.mjs',
    'world-host/examples/agent_runtime/replay/run.mjs',
    'world-host/examples/agent_runtime/retry/run.mjs',
    'world-host/examples/agent_runtime/shared.mjs',
    'world-host/examples/agent_runtime/skeleton/run.mjs',
    'world-host/examples/branching/run.mjs',
    'world-host/examples/crash_recovery/run.mjs',
    'world-host/examples/file_rewrite_agent/run.mjs',
    'world-host/examples/migration/run.mjs',
    'world-host/package.json',
    'world-host/scripts/agent_runtime_pack_lib.mjs',
    'world-host/scripts/build-agent-runtime-pack.mjs',
    'world-host/scripts/check-agent-runtime-pack.mjs',
    'world-host/scripts/check-agent-runtime-release-receipt.mjs',
    'world-host/scripts/emit-agent-runtime-release-receipt.mjs',
    'world-host/scripts/run-agent-runtime-conformance.mjs',
    'world-host/src/bun/bun_cli.mjs',
    'world-host/src/bun/bun_lock.mjs',
    'world-host/src/bun/bun_worker.mjs',
    'world-host/src/core/actuator.mjs',
    'world-host/src/core/application.mjs',
    'world-host/src/core/capabilities.mjs',
    'world-host/src/core/effect_journal.mjs',
    'world-host/src/core/migration.mjs',
    'world-host/src/core/run.mjs',
    'world-host/src/core/store.mjs',
    'world-host/src/core/worker.mjs',
    'world-host/src/drivers/fixture_agent_model_driver.mjs',
    'world-host/src/drivers/sandbox_file_driver.mjs',
    'world-host/src/protocol/world_manifest.mjs',
    'world-host/src/protocol/world_appliance_wire_codec.mjs',
    'world-host/src/protocol/world_loaded_value_codec.mjs',
    'world-host/src/protocol/world_universal_appliance_codec.mjs',
    'world-host/src/protocol/agent_runtime_manifest.mjs',
    'world-host/src/stores/directory_store.mjs',
    'world-host/src/stores/memory_store.mjs',
    'world-host/carrier-manifest.json',
    'conformance/corpus.json',
    'proof-receipts/boundary-agent-profile.json',
    'proof-receipts/world-agent-dist.json',
    'proof-receipts/world-host-carrier.json',
    'fixtures/input.txt',
    'fixtures/expected-output.txt',
    'fixtures/expected-result.txt',
    'README.md',
    'docs/architecture.md',
    'docs/install.md',
    'docs/run.md',
    'docs/conformance.md',
    'docs/security.md',
    'docs/troubleshooting.md',
    'docs/non_goals.md',
    'checksums.sha256',
  ];
  if (requireReleaseReceipt) required.push('manifest/agent-runtime-release-receipt.json');
  for (const rel of required) await requireFile(path.join(root, rel));
  await verifyChecksums(root);
  const manifestBytes = await readFile(path.join(root, 'manifest/agent-runtime-manifest.json'));
  const manifest = assertAgentRuntimeManifest(JSON.parse(manifestBytes.toString('utf8')));
  const manifestBin = await readFile(path.join(root, 'manifest/agent-runtime-manifest.bin'));
  if (Buffer.compare(manifestBin, Buffer.from(stableJson(manifest))) !== 0) throw new Error('ERR_AGENT_RUNTIME_MANIFEST_BIN_MISMATCH');
  const wasm = await readFile(path.join(root, 'world/world_universal_appliance.wasm'));
  if (manifest.world.universalWasmSha256 !== sha256Hex(wasm)) throw new Error('ERR_AGENT_RUNTIME_WASM_CHECKSUM');
  await verifyPackagedPackageScripts(root, manifest);
  await verifyManifestArtifacts(root, manifest);
  await verifyWorldReleaseReceipt(root, manifest);
  const corpus = JSON.parse(await readFile(path.join(root, 'conformance/corpus.json'), 'utf8'));
  if (corpus.warnings?.length) throw new Error(`ERR_AGENT_RUNTIME_OWNER_EXPORT_WARNINGS:${corpus.warnings.join(',')}`);
  await verifyProofReceipts(root, corpus, manifest);
  if (validateReleaseReceipt) {
    await assertAgentRuntimeReleaseReceiptContents(
      root,
      manifest,
      corpus,
      JSON.parse(await readFile(releaseReceiptPath, 'utf8')),
    );
  }
  return { root, manifest, complete: true, releaseReceiptValidated: validateReleaseReceipt };
}

export async function emitReleaseReceipt(pack, conformance) {
  const checked = await checkAgentRuntimePack(pack, { validateReleaseReceipt: false });
  const root = checked.root;
  const manifest = checked.manifest;
  const corpus = JSON.parse(await readFile(path.join(root, 'conformance/corpus.json'), 'utf8'));
  const proof = requireConformanceReceipt(conformance, manifest);
  const receipt = {
    receiptFormatVersion: 1,
    receiptFingerprintVersion: 1,
    agentRuntimeManifestFingerprint: manifest.manifestFingerprint,
    boundaryModuleFingerprints: [
      manifest.boundary.agentRootModuleFingerprint,
      manifest.boundary.toolboxModuleFingerprint,
    ],
    worldExecutableImageFingerprint: manifest.world.executableImageFingerprint,
    universalWasmChecksum: manifest.world.universalWasmSha256,
    worldHostCarrierManifestFingerprint: manifest.worldHost.carrierManifestFingerprint,
    conformanceCorpusFingerprint: manifest.conformanceCorpusFingerprint,
    proofReceiptFingerprints: corpus.proofReceipts.map((receipt) => receipt.fingerprint),
    ownerSkeletonExamplePassed: proof.owner_skeleton_example_completed === true,
    ownerFixtureExamplePassed: proof.owner_fixture_example_completed === true,
    replayProofPassed: proof.replay_matched === true,
    retryProofPassed: proof.retry_matched === true,
    migrationProofPassed: proof.migration_matched === true,
    branchingProofPassed: proof.branching_matched === true,
    negativeProofPassed: proof.negative_cases_rejected === true,
    distributedSkeletonScenarioPassed: proof.distributed_skeleton_scenario_completed === true,
    distributedFixtureScenarioPassed: proof.distributed_fixture_scenario_completed === true,
    distributedSkeletonEffectsMatched: proof.distributed_skeleton_effects_matched === true,
    distributedFixtureEffectsMatched: proof.distributed_fixture_effects_matched === true,
    distributedEmptyPayloadsRejected: proof.distributed_empty_payloads_rejected === true,
    complete: false,
    blockers: [],
    warnings: corpus.warnings,
  };
  receipt.complete = [
    receipt.ownerSkeletonExamplePassed,
    receipt.ownerFixtureExamplePassed,
    receipt.replayProofPassed,
    receipt.retryProofPassed,
    receipt.migrationProofPassed,
    receipt.branchingProofPassed,
    receipt.negativeProofPassed,
    receipt.distributedSkeletonScenarioPassed,
    receipt.distributedFixtureScenarioPassed,
    receipt.distributedSkeletonEffectsMatched,
    receipt.distributedFixtureEffectsMatched,
    receipt.distributedEmptyPayloadsRejected,
  ].every(Boolean);
  receipt.receiptFingerprint = releaseReceiptFingerprint(receipt);
  return receipt;
}

export async function assertAgentRuntimeReleaseReceipt(pack, actual) {
  const checked = await checkAgentRuntimePack(pack, { validateReleaseReceipt: false });
  const root = checked.root;
  const manifest = checked.manifest;
  const corpus = JSON.parse(await readFile(path.join(root, 'conformance/corpus.json'), 'utf8'));
  return assertAgentRuntimeReleaseReceiptContents(root, manifest, corpus, actual);
}

async function assertAgentRuntimeReleaseReceiptContents(root, manifest, corpus, actual) {
  if (actual?.receiptFingerprint !== releaseReceiptFingerprint(actual)) throw new Error('ERR_AGENT_RUNTIME_RELEASE_RECEIPT_FINGERPRINT');
  const expectedFields = {
    receiptFormatVersion: 1,
    receiptFingerprintVersion: 1,
    agentRuntimeManifestFingerprint: manifest.manifestFingerprint,
    boundaryModuleFingerprints: [
      manifest.boundary.agentRootModuleFingerprint,
      manifest.boundary.toolboxModuleFingerprint,
    ],
    worldExecutableImageFingerprint: manifest.world.executableImageFingerprint,
    universalWasmChecksum: manifest.world.universalWasmSha256,
    worldHostCarrierManifestFingerprint: manifest.worldHost.carrierManifestFingerprint,
    conformanceCorpusFingerprint: manifest.conformanceCorpusFingerprint,
    proofReceiptFingerprints: corpus.proofReceipts.map((receipt) => receipt.fingerprint),
    blockers: [],
    warnings: corpus.warnings,
  };
  for (const [key, value] of Object.entries(expectedFields)) {
    if (stableJson(actual[key]) !== stableJson(value)) throw new Error(`ERR_AGENT_RUNTIME_RELEASE_RECEIPT_${key}`);
  }
  const proofFields = [
    'ownerSkeletonExamplePassed',
    'ownerFixtureExamplePassed',
    'replayProofPassed',
    'retryProofPassed',
    'migrationProofPassed',
    'branchingProofPassed',
    'negativeProofPassed',
    'distributedSkeletonScenarioPassed',
    'distributedFixtureScenarioPassed',
    'distributedSkeletonEffectsMatched',
    'distributedFixtureEffectsMatched',
    'distributedEmptyPayloadsRejected',
  ];
  if (!proofFields.every((field) => actual[field] === true)) throw new Error('ERR_AGENT_RUNTIME_RELEASE_RECEIPT_PROOF_INCOMPLETE');
  if (actual.complete !== true) throw new Error('ERR_AGENT_RUNTIME_RELEASE_RECEIPT_INCOMPLETE');
  return actual;
}

export async function refreshAgentRuntimePackChecksums(pack) {
  await writeChecksums(path.resolve(pack));
}

async function boundaryArtifacts(boundaryRepo) {
  const zon = await readFile(path.join(boundaryRepo, 'build.zig.zon'), 'utf8');
  const version = zon.match(/\.version\s*=\s*"([^"]+)"/)?.[1] ?? '0.6.2';
  const exportDir = path.join(boundaryRepo, `zig-out/dist/boundary-v${version}-agent-runtime`);
  const rootModule = await readRequiredFile(path.join(exportDir, 'agent-root.full-module'));
  const toolboxModule = await readRequiredFile(path.join(exportDir, 'toolbox-provider.full-module'));
  const protocolManifest = await readRequiredFile(path.join(exportDir, 'boundary-protocol-manifest.bin'));
  const profileBytes = await readRequiredFile(path.join(exportDir, 'agent-profile.json'));
  const profile = JSON.parse(profileBytes.toString('utf8'));
  const corpusPath = path.join(boundaryRepo, 'conformance/v0/agent/corpus.boundary-agent.txt');
  const corpus = bindBoundaryCorpusProfile(
    existsSync(corpusPath) ? await readFile(corpusPath, 'utf8') : '',
    profile,
  );
  return {
    packageVersion: version,
    packageHash: gitHead(boundaryRepo, { required: false }),
    protocolManifestFingerprint: requireOwnerFingerprint(profile.boundary_protocol_manifest_fingerprint, 'boundary profile protocol manifest'),
    agentProfileFingerprint: requireOwnerFingerprint(profile.profile_fingerprint, 'boundary agent profile'),
    agentRootModuleFingerprint: requireOwnerFingerprint(profile.agent_root_module_fingerprint, 'boundary agent root module'),
    toolboxModuleFingerprint: requireOwnerFingerprint(profile.toolbox_module_fingerprint, 'boundary toolbox module'),
    gitHead: gitHead(boundaryRepo, { required: false }),
    files: { rootModule, toolboxModule, protocolManifest, profile, profileBytes, corpus },
    artifacts: {
      agentRootModule: { exportedByOwner: true, sha256: sha256Hex(rootModule), byteFingerprint: profile.agent_root_full_module_byte_fingerprint },
      toolboxModule: { exportedByOwner: true, sha256: sha256Hex(toolboxModule), byteFingerprint: profile.toolbox_full_module_byte_fingerprint },
      protocolManifest: { exportedByOwner: true, sha256: sha256Hex(protocolManifest) },
      agentProfile: { exportedByOwner: true, sha256: sha256Hex(profileBytes) },
      corpus: { exportedByOwner: true, sha256: sha256Hex(corpus) },
    },
  };
}

async function worldArtifacts(worldRepo, worldDist) {
  const protocolManifest = await readFile(path.join(worldDist, 'world-protocol-manifest.json'));
  const releaseReceipt = await readFile(path.join(worldDist, 'world-release-receipt.json'));
  const wasm = await readFile(path.join(worldDist, 'world_universal_appliance.wasm'));
  const releaseArtifact = JSON.parse(await readFile(path.join(worldDist, 'world-release-artifact.json'), 'utf8'));
  const corpus = await readFile(path.join(worldDist, 'conformance/v0/world/corpus.json'));
  const exportDir = path.join(worldDist, 'agent-runtime');
  const image = await readRequiredFile(path.join(exportDir, 'agent.executable-image'));
  const applianceManifest = await readRequiredFile(path.join(exportDir, 'appliance-manifest.bin'));
  const agentRuntimeMetadataBytes = await readRequiredFile(path.join(exportDir, 'agent-runtime-world-artifacts.json'));
  const agentRuntimeMetadata = JSON.parse(agentRuntimeMetadataBytes.toString('utf8'));
  return {
    packageVersion: releaseArtifact.package ?? 'world-v0.1.0',
    protocolManifestFingerprint: worldProtocolFingerprint(releaseArtifact),
    executableImageFingerprint: requireOwnerFingerprint(agentRuntimeMetadata.world_executable_image_fingerprint, 'world executable image'),
    applianceManifestFingerprint: requireOwnerFingerprint(agentRuntimeMetadata.world_appliance_manifest_fingerprint, 'world appliance manifest'),
    universalWasmSha256: sha256Hex(wasm),
    applianceAbiVersion: `v${agentRuntimeMetadata.world_appliance_abi_version ?? releaseArtifact.wasm?.abi_version ?? 4}`,
    turnClosureFormatVersion: `v${agentRuntimeMetadata.world_turn_closure_format_version ?? 1}`,
    archiveFormatVersion: `v${agentRuntimeMetadata.world_archive_format_version ?? 1}`,
    requiredActuatorRefs: exactArray(agentRuntimeMetadata.required_actuator_ref_fingerprints, 'world required actuator ref fingerprints').map(worldActuatorRef),
    requiredDescriptorFingerprints: exactArray(agentRuntimeMetadata.required_descriptor_fingerprints, 'world required descriptor fingerprints').map(worldDescriptorFingerprint),
    gitHead: gitHead(worldRepo),
    files: { protocolManifest, releaseReceipt, wasm, corpus, image, applianceManifest, agentRuntimeMetadata, agentRuntimeMetadataBytes },
    artifacts: {
      protocolManifest: { exportedByOwner: true, sha256: sha256Hex(protocolManifest) },
      executableImage: { exportedByOwner: true, sha256: sha256Hex(image) },
      applianceManifest: { exportedByOwner: true, sha256: sha256Hex(applianceManifest) },
      universalWasm: { exportedByOwner: true, sha256: sha256Hex(wasm) },
      releaseReceipt: { exportedByOwner: true, sha256: sha256Hex(releaseReceipt) },
      conformanceCorpus: { exportedByOwner: true, sha256: sha256Hex(corpus) },
      agentRuntimeMetadata: { exportedByOwner: true, sha256: sha256Hex(agentRuntimeMetadataBytes) },
    },
  };
}

async function worldHostArtifacts(worldHostRepo) {
  const packageJson = JSON.parse(await readFile(path.join(worldHostRepo, 'package.json'), 'utf8'));
  const selectedCarrierManifest = await loadCarrierManifest(worldHostRepo);
  return {
    packageVersion: packageJson.version,
    carrierManifest: selectedCarrierManifest,
    carrierManifestFingerprint: carrierManifestFingerprint(selectedCarrierManifest),
    gitHead: gitHead(worldHostRepo),
    gitDirty: gitDirty(worldHostRepo, [PACK_NAME]),
    artifacts: {
      codecs: { dependencyFree: true },
      carrierManifest: { exportedByOwner: true },
    },
  };
}

async function writeArtifactSet(out, boundary, world, host) {
  await writeFile(path.join(out, 'boundary/agent-root.full-module'), boundary.files.rootModule);
  await writeFile(path.join(out, 'boundary/toolbox-provider.full-module'), boundary.files.toolboxModule);
  await writeFile(path.join(out, 'boundary/boundary-protocol-manifest.bin'), boundary.files.protocolManifest);
  await writeFile(path.join(out, 'boundary/agent-profile.json'), boundary.files.profileBytes);
  await writeFile(path.join(out, 'boundary/corpus.boundary-agent.txt'), boundary.files.corpus);
  await writeFile(path.join(out, 'world/agent.executable-image'), world.files.image);
  await writeFile(path.join(out, 'world/appliance-manifest.bin'), world.files.applianceManifest);
  await writeFile(path.join(out, 'world/world_universal_appliance.wasm'), world.files.wasm);
  await writeFile(path.join(out, 'world/world-protocol-manifest.bin'), world.files.protocolManifest);
  await writeFile(path.join(out, 'world/release-receipt.bin'), world.files.releaseReceipt);
  await writeFile(path.join(out, 'world/conformance-corpus.json'), world.files.corpus);
  await writeFile(path.join(out, 'world/agent-runtime-world-artifacts.json'), world.files.agentRuntimeMetadataBytes);
  await writeFile(path.join(out, 'world-host/carrier-manifest.json'), `${JSON.stringify(host.carrierManifest, null, 2)}\n`);
  await writeAgentRuntimeArtifacts(out, boundary, world, host);
}

async function writeAgentRuntimeArtifacts(out, boundary, world, host) {
  await writeFile(path.join(out, 'world-host/agent-runtime-artifacts.json'), `${JSON.stringify({ boundary: boundary.artifacts, world: world.artifacts, worldHost: host.artifacts }, null, 2)}\n`);
}

async function copyWorldHostPackage(worldHostRepo, out) {
  for (const rel of ['bin', 'src', 'examples', 'scripts', 'docs']) {
    await cp(path.join(worldHostRepo, rel), path.join(out, rel), {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`) && !source.includes(`${path.sep}${PACK_NAME}${path.sep}`),
    });
  }
  await writePackagedWorldHostPackageJson(worldHostRepo, out);
  await writeFile(path.join(out, 'README.md'), packagedWorldHostReadme());
}

async function writePackagedWorldHostPackageJson(worldHostRepo, out) {
  const sourcePackageJson = JSON.parse(await readFile(path.join(worldHostRepo, 'package.json'), 'utf8'));
  const checkScript = sourcePackageJson.scripts?.['check:agent-runtime'];
  if (typeof checkScript !== 'string') throw new Error('ERR_AGENT_RUNTIME_SOURCE_CHECK_SCRIPT');
  const packageJson = {
    ...sourcePackageJson,
    files: [...EXPECTED_PACKAGE_FILES],
    scripts: {
      'check:agent-runtime': checkScript,
    },
  };
  await writeFile(path.join(out, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
}

function packagedWorldHostReadme() {
  return `# world-host Agent Runtime Pack

This directory is the world-host carrier shipped inside Agent Runtime v0.1. It contains the pack-local CLI, runtime modules, examples, and release verification scripts.

From this directory, run the complete pack verification command:

\`\`\`sh
bun run check:agent-runtime
\`\`\`

From the pack root, the direct verification steps are:

\`\`\`sh
bun world-host/scripts/check-agent-runtime-pack.mjs .
bun world-host/scripts/run-agent-runtime-conformance.mjs .
bun world-host/scripts/check-agent-runtime-pack.mjs . --require-release-receipt
bun world-host/scripts/check-agent-runtime-release-receipt.mjs .
\`\`\`

Install the carrier from the pack with:

\`\`\`sh
bun world-host/bin/world-host.mjs agent install --pack . --store <store>
\`\`\`
`;
}

async function writeConformanceCorpus(out, boundary, world, host) {
  const proofReceipts = [
    proofReceipt('boundary-agent-profile', boundary.agentProfileFingerprint),
    proofReceipt('world-agent-dist', world.executableImageFingerprint),
    proofReceipt('world-host-carrier', host.carrierManifestFingerprint),
  ];
  const corpus = {
    corpusFormatVersion: 1,
    name: 'agent-runtime-v0.1-conformance',
    requiredScenarios: ['skeleton', 'fixture', 'replay', 'retry', 'migration', 'branching', 'negative'],
    expected: {
      skeletonFinalResult: SKELETON_RESULT,
      skeletonRootResultFingerprint: 'world:root-result:469ea29edd2b9b6a',
      fixtureInput: FIXTURE_INPUT,
      fixtureOutput: FIXTURE_OUTPUT,
      fixtureFinalResult: FIXTURE_RESULT,
      fixtureRootResultFingerprint: 'world:root-result:716ad80792c9e8fe',
      distributedEffects: {
        skeleton: [
          {
            actuatorRef: 'world:actuator-ref:4f0c7160f25c4c62',
            descriptorFingerprint: 'world:descriptor:be73177924a6b377',
            state: 'closure_committed',
            requestBytesChecksum: 'sha256:9626a572386090b422bfe03a9aa76b971b8314517a741f86585c8d14b81d9991',
            driverId: 'fixture-agent-model',
          },
          {
            actuatorRef: 'world:actuator-ref:d5e4b1b427522cf2',
            descriptorFingerprint: 'world:descriptor:74afc8c3b2fe4c33',
            state: 'closure_committed',
            requestBytesChecksum: 'sha256:9626a572386090b422bfe03a9aa76b971b8314517a741f86585c8d14b81d9991',
            driverId: 'sandbox-file',
          },
        ],
        fixture: [
          {
            actuatorRef: 'world:actuator-ref:d5e4b1b427522cf2',
            descriptorFingerprint: 'world:descriptor:74afc8c3b2fe4c33',
            state: 'closure_committed',
            requestBytesChecksum: 'sha256:2674258ca95c6c333ef995ff823a4c425e5a85d5303887b6317c23c7a84ea1e2',
            driverId: 'sandbox-file',
          },
          {
            actuatorRef: 'world:actuator-ref:4f0c7160f25c4c62',
            descriptorFingerprint: 'world:descriptor:be73177924a6b377',
            state: 'closure_committed',
            requestBytesChecksum: 'sha256:2674258ca95c6c333ef995ff823a4c425e5a85d5303887b6317c23c7a84ea1e2',
            driverId: 'fixture-agent-model',
          },
        ],
      },
    },
    proofReceipts,
    warnings: [],
  };
  await writeFile(path.join(out, 'conformance/corpus.json'), `${JSON.stringify(corpus, null, 2)}\n`);
  for (const scenario of corpus.requiredScenarios) {
    await writeFile(path.join(out, `conformance/${scenario}/README.md`), `# ${scenario}\n\nPart of Agent Runtime v0.1 conformance.\n`);
  }
  for (const receipt of proofReceipts) {
    await writeFile(path.join(out, `proof-receipts/${receipt.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  }
}

async function writeFixtures(out) {
  await writeFile(path.join(out, 'fixtures/input.txt'), FIXTURE_INPUT);
  await writeFile(path.join(out, 'fixtures/expected-output.txt'), FIXTURE_OUTPUT);
  await writeFile(path.join(out, 'fixtures/expected-result.txt'), FIXTURE_RESULT);
}

async function writeDocs(out, boundary, world, host) {
  const docs = {
    'README.md': `# Agent Runtime v0.1\n\nThe agent is a Boundary program. World turns it into a portable executable process. world-host operates that process by resolving effects and retaining World-authored evidence.\n\nRun conformance from the pack root with:\n\n\`\`\`sh\nbun world-host/scripts/run-agent-runtime-conformance.mjs .\n\`\`\`\n`,
    'docs/architecture.md': `# Architecture\n\nAgent Runtime = Boundary agent program + World executable/deployment evidence + world-host carrier operation + conformance proof.\n\nBoundary ${boundary.packageVersion}; World ${world.packageVersion}; world-host ${host.packageVersion}.\n`,
    'docs/install.md': `# Install\n\nUse the distributed directory as-is. Do not clone Boundary or World for verification.\n`,
    'docs/run.md': `# Run\n\nUse world-host agent commands or the conformance script for skeleton and fixture scenarios.\n`,
    'docs/conformance.md': `# Conformance\n\nConformance verifies checksums, manifest identity, skeleton, fixture, replay, retry, migration, branching, negative cases, and release receipt derivation.\n`,
    'docs/security.md': `# Security\n\nTrusted: selected Boundary release, selected World release, selected world-host package, receiver-local policy, receiver-owned drivers.\n\nUntrusted: model outputs, file paths from agent, host claim bytes, migrated packages, stored blobs, TurnClosure bytes from outside the store, Executable.Image bytes from outside the release pack.\n\nNon-claims: no cryptographic authenticity, confidentiality, exactly-once effects, distributed consensus, hostile-host protection, malicious-runtime protection, production durability guarantee, arbitrary shell authority, or real model trust guarantee.\n\nFixtureModelDriver is deterministic test-only. SandboxFileDriver must reject path and symlink escape. No shell driver or real model driver is included in v0.1.\n`,
    'docs/troubleshooting.md': `# Troubleshooting\n\nStart with checksums, then manifest, then conformance receipt. A mismatch means the pack is not the release candidate that produced the receipt.\n`,
    'docs/non_goals.md': `# Non-Goals\n\nNo real LLM API, production tool registry, package registry, remote module fetching, scheduler, daemon, HTTP server, database dependency, production storage claim, branch merging, arbitrary shell tool, secret manager, signing/encryption, exactly-once effects, live upgrade, cross-image migration, open dynamic tool discovery, or semantic tool routing in world-host.\n`,
    'docs/compatibility.md': `# Compatibility\n\nBoundary ${boundary.packageVersion}; World ${world.packageVersion}; Appliance ABI ${world.applianceAbiVersion}; TurnClosure ${world.turnClosureFormatVersion}; Archive ${world.archiveFormatVersion}.\n`,
    'docs/operating.md': `# Operating\n\nCommands are one-shot. Store locks are local. Credentials and full idempotency keys must not be printed.\n`,
  };
  for (const [rel, body] of Object.entries(docs)) await writeFile(path.join(out, rel), body);
}

async function writeChecksums(root) {
  const files = (await listFiles(root))
    .filter((rel) => rel !== 'checksums.sha256')
    .sort();
  const lines = [];
  for (const rel of files) {
    const bytes = await readFile(path.join(root, rel));
    lines.push(`${sha256Hex(bytes)}  ${rel}`);
  }
  await writeFile(path.join(root, 'checksums.sha256'), `${lines.join('\n')}\n`);
}

async function verifyChecksums(root) {
  const checksumPath = path.join(root, 'checksums.sha256');
  const lines = (await readFile(checksumPath, 'utf8')).trim().split(/\n+/);
  const covered = new Set();
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) throw new Error(`ERR_INVALID_CHECKSUM_LINE:${line}`);
    const [, expected, rel] = match;
    const normalizedRel = rel.split(/[\\/]+/).join('/');
    if (covered.has(normalizedRel)) throw new Error(`ERR_CHECKSUM_DUPLICATE:${rel}`);
    const target = await safePackFile(root, rel);
    const actual = sha256Hex(await readFile(target));
    if (actual !== expected) throw new Error(`ERR_CHECKSUM_MISMATCH:${rel}`);
    covered.add(normalizedRel);
  }
  const files = (await listFiles(root)).filter((rel) => rel !== 'checksums.sha256').sort();
  if (covered.size !== files.length) throw new Error('ERR_CHECKSUM_COVERAGE');
  for (const rel of files) {
    if (!covered.has(rel)) throw new Error(`ERR_CHECKSUM_MISSING:${rel}`);
  }
}

async function verifyManifestArtifacts(root, manifest) {
  const boundaryProfilePath = path.join(root, 'boundary/agent-profile.json');
  const boundaryProfileBytes = await readFile(boundaryProfilePath);
  const boundaryProfile = JSON.parse(boundaryProfileBytes.toString('utf8'));
  const boundaryCorpus = await readFile(path.join(root, 'boundary/corpus.boundary-agent.txt'), 'utf8');
  const worldMetadataPath = path.join(root, 'world/agent-runtime-world-artifacts.json');
  const worldMetadataBytes = await readFile(worldMetadataPath);
  const worldMetadata = JSON.parse(worldMetadataBytes.toString('utf8'));
  const packagedArtifactMetadata = JSON.parse(await readFile(path.join(root, 'world-host/agent-runtime-artifacts.json'), 'utf8'));
  const carrier = JSON.parse(await readFile(path.join(root, 'world-host/carrier-manifest.json'), 'utf8'));
  const conformanceCorpusFingerprint = await fingerprintDirectory(path.join(root, 'conformance'));

  assertGitSha(manifest.boundary.packageHash, 'ERR_AGENT_RUNTIME_BOUNDARY_PACKAGE_HASH');
  assertEqual(manifest.boundary.packageHash, manifest.metadata?.buildDiagnostics?.boundaryHead, 'ERR_AGENT_RUNTIME_BOUNDARY_PACKAGE_HASH');
  assertEqual(manifest.boundary.protocolManifestFingerprint, requireOwnerFingerprint(boundaryProfile.boundary_protocol_manifest_fingerprint, 'boundary profile protocol manifest'), 'ERR_AGENT_RUNTIME_BOUNDARY_PROTOCOL_FINGERPRINT');
  assertEqual(manifest.boundary.protocolManifestFingerprint, boundaryProtocolManifestFileFingerprint(await readFile(path.join(root, 'boundary/boundary-protocol-manifest.bin'))), 'ERR_AGENT_RUNTIME_BOUNDARY_PROTOCOL_MANIFEST_FINGERPRINT');
  assertEqual(manifest.boundary.agentProfileFingerprint, requireOwnerFingerprint(boundaryProfile.profile_fingerprint, 'boundary agent profile'), 'ERR_AGENT_RUNTIME_BOUNDARY_PROFILE_FINGERPRINT');
  assertEqual(manifest.boundary.agentProfileFingerprint, boundaryCorpusProfileFingerprint(boundaryCorpus), 'ERR_AGENT_RUNTIME_BOUNDARY_CORPUS_PROFILE_FINGERPRINT');
  assertEqual(manifest.boundary.agentRootModuleFingerprint, requireOwnerFingerprint(boundaryProfile.agent_root_module_fingerprint, 'boundary agent root module'), 'ERR_AGENT_RUNTIME_BOUNDARY_ROOT_FINGERPRINT');
  assertEqual(manifest.boundary.toolboxModuleFingerprint, requireOwnerFingerprint(boundaryProfile.toolbox_module_fingerprint, 'boundary toolbox module'), 'ERR_AGENT_RUNTIME_BOUNDARY_TOOLBOX_FINGERPRINT');
  assertEqual(manifest.artifacts?.boundary?.agentRootModule?.byteFingerprint, requireOwnerFingerprint(boundaryProfile.agent_root_full_module_byte_fingerprint, 'boundary agent root module byte fingerprint'), 'ERR_AGENT_RUNTIME_BOUNDARY_ROOT_BYTE_FINGERPRINT');
  assertEqual(manifest.artifacts?.boundary?.toolboxModule?.byteFingerprint, requireOwnerFingerprint(boundaryProfile.toolbox_full_module_byte_fingerprint, 'boundary toolbox module byte fingerprint'), 'ERR_AGENT_RUNTIME_BOUNDARY_TOOLBOX_BYTE_FINGERPRINT');
  assertEqual(manifest.world.executableImageFingerprint, requireOwnerFingerprint(worldMetadata.world_executable_image_fingerprint, 'world executable image'), 'ERR_AGENT_RUNTIME_WORLD_IMAGE_FINGERPRINT');
  assertEqual(manifest.world.applianceManifestFingerprint, requireOwnerFingerprint(worldMetadata.world_appliance_manifest_fingerprint, 'world appliance manifest'), 'ERR_AGENT_RUNTIME_WORLD_APPLIANCE_FINGERPRINT');
  assertEqual(manifest.world.applianceAbiVersion, `v${worldMetadata.world_appliance_abi_version ?? 4}`, 'ERR_AGENT_RUNTIME_WORLD_APPLIANCE_ABI_VERSION');
  assertEqual(manifest.world.turnClosureFormatVersion, `v${worldMetadata.world_turn_closure_format_version ?? 1}`, 'ERR_AGENT_RUNTIME_WORLD_TURN_CLOSURE_VERSION');
  assertEqual(manifest.world.archiveFormatVersion, `v${worldMetadata.world_archive_format_version ?? 1}`, 'ERR_AGENT_RUNTIME_WORLD_ARCHIVE_VERSION');
  const worldHead = manifest.metadata?.buildDiagnostics?.worldHead;
  assertEqual(manifest.metadata?.buildDiagnostics?.worldHostHead, manifest.artifacts?.worldHost?.packageTree?.fingerprint, 'ERR_AGENT_RUNTIME_WORLD_HOST_SOURCE_HEAD');
  assertEqual(manifest.world.protocolManifestFingerprint, worldProtocolManifestFileFingerprint(await readFile(path.join(root, 'world/world-protocol-manifest.bin'))), 'ERR_AGENT_RUNTIME_WORLD_PROTOCOL_MANIFEST_FINGERPRINT');
  assertEqual(manifest.world.protocolManifestFingerprint, expectedWorldArtifactByHead(WORLD_V0_PROTOCOL_FINGERPRINT_BY_HEAD, worldHead, 'ERR_AGENT_RUNTIME_WORLD_PROTOCOL_HEAD'), 'ERR_AGENT_RUNTIME_WORLD_PROTOCOL_HEAD');
  assertEqual(sha256Hex(await readFile(path.join(root, 'world/agent.executable-image'))), expectedWorldArtifactByHead(WORLD_V0_EXECUTABLE_IMAGE_SHA256_BY_HEAD, worldHead, 'ERR_AGENT_RUNTIME_WORLD_IMAGE_BYTES_HEAD'), 'ERR_AGENT_RUNTIME_WORLD_IMAGE_BYTES');
  assertEqual(sha256Hex(await readFile(path.join(root, 'world/appliance-manifest.bin'))), expectedWorldArtifactByHead(WORLD_V0_APPLIANCE_MANIFEST_SHA256_BY_HEAD, worldHead, 'ERR_AGENT_RUNTIME_WORLD_APPLIANCE_BYTES_HEAD'), 'ERR_AGENT_RUNTIME_WORLD_APPLIANCE_BYTES');
  assertEqual(sha256Hex(await readFile(path.join(root, 'world/world_universal_appliance.wasm'))), expectedWorldArtifactByHead(WORLD_V0_UNIVERSAL_WASM_SHA256_BY_HEAD, worldHead, 'ERR_AGENT_RUNTIME_WORLD_WASM_BYTES_HEAD'), 'ERR_AGENT_RUNTIME_WORLD_WASM_BYTES');
  const worldMetadataActuatorRefs = exactArray(worldMetadata.required_actuator_ref_fingerprints, 'world required actuator ref fingerprints').map(worldActuatorRef);
  const worldMetadataDescriptorFingerprints = exactArray(worldMetadata.required_descriptor_fingerprints, 'world required descriptor fingerprints').map(worldDescriptorFingerprint);
  assertEqual(stableJson(manifest.requiredActuatorRefs), stableJson(worldMetadataActuatorRefs), 'ERR_AGENT_RUNTIME_ACTUATOR_REFS');
  assertEqual(stableJson(manifest.requiredDescriptorFingerprints), stableJson(worldMetadataDescriptorFingerprints), 'ERR_AGENT_RUNTIME_DESCRIPTOR_FINGERPRINTS');
  assertEqual(stableJson(manifest.requiredActuatorRefs), stableJson(expectedWorldArtifactByHead(WORLD_V0_REQUIRED_ACTUATOR_REFS_BY_HEAD, worldHead, 'ERR_AGENT_RUNTIME_ACTUATOR_REFS_HEAD')), 'ERR_AGENT_RUNTIME_ACTUATOR_REFS_HEAD');
  assertEqual(stableJson(manifest.requiredDescriptorFingerprints), stableJson(expectedWorldArtifactByHead(WORLD_V0_REQUIRED_DESCRIPTOR_FINGERPRINTS_BY_HEAD, worldHead, 'ERR_AGENT_RUNTIME_DESCRIPTOR_FINGERPRINTS_HEAD')), 'ERR_AGENT_RUNTIME_DESCRIPTOR_FINGERPRINTS_HEAD');
  assertEqual(manifest.worldHost.packageVersion, WORLD_HOST_PACKAGE_VERSION, 'ERR_AGENT_RUNTIME_PACKAGE_VERSION');
  assertEqual(carrier.carrierVersion, WORLD_HOST_PACKAGE_VERSION, 'ERR_AGENT_RUNTIME_PACKAGE_VERSION');
  assertEqual(manifest.worldHost.carrierManifestFingerprint, carrierManifestFingerprint(carrier), 'ERR_AGENT_RUNTIME_CARRIER_MANIFEST_FINGERPRINT');
  await verifyPackagedCarrierModule(root, carrier);
  assertEqual(manifest.conformanceCorpusFingerprint, conformanceCorpusFingerprint, 'ERR_AGENT_RUNTIME_CONFORMANCE_CORPUS_FINGERPRINT');
  assertEqual(stableJson(packagedArtifactMetadata), stableJson(manifest.artifacts), 'ERR_AGENT_RUNTIME_ARTIFACT_METADATA');
  assertEqual(manifest.artifacts?.worldHost?.packageTree?.fingerprint, await fingerprintWorldHostPackageTree(root), 'ERR_AGENT_RUNTIME_WORLD_HOST_TREE_FINGERPRINT');

  const artifactChecks = [
    ['boundary.agentRootModule.sha256', manifest.artifacts?.boundary?.agentRootModule?.sha256, async () => readFile(path.join(root, 'boundary/agent-root.full-module'))],
    ['boundary.toolboxModule.sha256', manifest.artifacts?.boundary?.toolboxModule?.sha256, async () => readFile(path.join(root, 'boundary/toolbox-provider.full-module'))],
    ['boundary.protocolManifest.sha256', manifest.artifacts?.boundary?.protocolManifest?.sha256, async () => readFile(path.join(root, 'boundary/boundary-protocol-manifest.bin'))],
    ['boundary.agentProfile.sha256', manifest.artifacts?.boundary?.agentProfile?.sha256, async () => boundaryProfileBytes],
    ['boundary.corpus.sha256', manifest.artifacts?.boundary?.corpus?.sha256, async () => Buffer.from(boundaryCorpus)],
    ['world.protocolManifest.sha256', manifest.artifacts?.world?.protocolManifest?.sha256, async () => readFile(path.join(root, 'world/world-protocol-manifest.bin'))],
    ['world.executableImage.sha256', manifest.artifacts?.world?.executableImage?.sha256, async () => readFile(path.join(root, 'world/agent.executable-image'))],
    ['world.applianceManifest.sha256', manifest.artifacts?.world?.applianceManifest?.sha256, async () => readFile(path.join(root, 'world/appliance-manifest.bin'))],
    ['world.universalWasm.sha256', manifest.artifacts?.world?.universalWasm?.sha256, async () => readFile(path.join(root, 'world/world_universal_appliance.wasm'))],
    ['world.releaseReceipt.sha256', manifest.artifacts?.world?.releaseReceipt?.sha256, async () => readFile(path.join(root, 'world/release-receipt.bin'))],
    ['world.conformanceCorpus.sha256', manifest.artifacts?.world?.conformanceCorpus?.sha256, async () => readFile(path.join(root, 'world/conformance-corpus.json'))],
    ['world.agentRuntimeMetadata.sha256', manifest.artifacts?.world?.agentRuntimeMetadata?.sha256, async () => worldMetadataBytes],
  ];
  for (const [label, expected, readBytes] of artifactChecks) {
    if (typeof expected !== 'string') throw new Error(`ERR_AGENT_RUNTIME_ARTIFACT_SHA:${label}`);
    const actual = sha256Hex(await readBytes());
    if (actual !== expected) throw new Error(`ERR_AGENT_RUNTIME_ARTIFACT_SHA:${label}`);
  }
}

function expectedWorldArtifactByHead(table, worldHead, code) {
  const expected = table[worldHead];
  if (!expected) throw new Error(code);
  return expected;
}

async function verifyWorldReleaseReceipt(root, manifest) {
  const receipt = JSON.parse(await readFile(path.join(root, 'world/release-receipt.bin'), 'utf8'));
  const worldCorpus = JSON.parse(await readFile(path.join(root, 'world/conformance-corpus.json'), 'utf8'));
  if (worldCorpus?.format_version !== 1 || worldCorpus?.name !== 'world-v0-conformance-corpus') {
    throw new Error('ERR_AGENT_RUNTIME_WORLD_CORPUS');
  }
  const protocolLow = worldProtocolLowFingerprint(manifest);
  if (receipt?.release_receipt_format_version !== 1) throw new Error('ERR_AGENT_RUNTIME_WORLD_RELEASE_RECEIPT_FORMAT');
  if (receipt?.release_receipt_fingerprint_version !== 1) throw new Error('ERR_AGENT_RUNTIME_WORLD_RELEASE_RECEIPT_FINGERPRINT_VERSION');
  assertEqual(receipt.boundary_protocol_manifest_fingerprint, WORLD_V0_BOUNDARY_PROTOCOL_MANIFEST_FINGERPRINT, 'ERR_AGENT_RUNTIME_WORLD_RELEASE_RECEIPT_BOUNDARY_PROTOCOL');
  assertEqual(receipt.world_protocol_manifest_fingerprint, protocolLow, 'ERR_AGENT_RUNTIME_WORLD_RELEASE_RECEIPT_PROTOCOL');
  assertEqual(receipt.conformance_corpus_root_fingerprint, WORLD_V0_CONFORMANCE_CORPUS_ROOT_FINGERPRINT, 'ERR_AGENT_RUNTIME_WORLD_RELEASE_RECEIPT_CORPUS');
  assertEqual(worldConformanceCorpusRootFingerprint(worldCorpus), WORLD_V0_CONFORMANCE_CORPUS_ROOT_FINGERPRINT, 'ERR_AGENT_RUNTIME_WORLD_CORPUS_ROOT');
  assertEqual(receipt.universal_wasm_checksum, ownerFingerprintFromSha256Prefix(manifest.world.universalWasmSha256), 'ERR_AGENT_RUNTIME_WORLD_RELEASE_RECEIPT_WASM');
  const expectedSourceChecksum = WORLD_V0_SOURCE_PACKAGE_CHECKSUM_BY_HEAD[manifest.metadata?.buildDiagnostics?.worldHead];
  if (expectedSourceChecksum) {
    assertEqual(receipt.source_package_checksum, expectedSourceChecksum, 'ERR_AGENT_RUNTIME_WORLD_RELEASE_RECEIPT_SOURCE');
  } else {
    throw new Error('ERR_AGENT_RUNTIME_WORLD_RELEASE_RECEIPT_SOURCE_HEAD');
  }
  if (receipt.complete !== true) throw new Error('ERR_AGENT_RUNTIME_WORLD_RELEASE_RECEIPT_INCOMPLETE');
  if (!Array.isArray(receipt.blockers) || receipt.blockers.length !== 0) throw new Error('ERR_AGENT_RUNTIME_WORLD_RELEASE_RECEIPT_BLOCKERS');
  if (!Array.isArray(receipt.warnings) || receipt.warnings.length !== 0) throw new Error('ERR_AGENT_RUNTIME_WORLD_RELEASE_RECEIPT_WARNINGS');
  verifyWorldProofReceipts(receipt, protocolLow);
  assertEqual(receipt.release_receipt_fingerprint, worldReleaseReceiptFingerprint(receipt), 'ERR_AGENT_RUNTIME_WORLD_RELEASE_RECEIPT_FINGERPRINT');
}

function verifyWorldProofReceipts(receipt, protocolLow) {
  const proofs = receipt.proof_receipts;
  if (!Array.isArray(proofs) || proofs.length !== WORLD_V0_REQUIRED_PROOF_KINDS.length) {
    throw new Error('ERR_AGENT_RUNTIME_WORLD_RELEASE_RECEIPT_PROOFS');
  }
  const seen = new Set();
  for (const proof of proofs) {
    if (proof?.receipt_format_version !== 1) throw new Error('ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_FORMAT');
    if (proof?.receipt_fingerprint_version !== 1) throw new Error('ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_FINGERPRINT_VERSION');
    requireOwnerFingerprint(proof.receipt_fingerprint, 'world proof receipt fingerprint');
    const proofIndex = WORLD_V0_REQUIRED_PROOF_KINDS.indexOf(proof.proof_kind);
    if (proofIndex === -1 || seen.has(proof.proof_kind)) throw new Error(`ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_KIND:${proof.proof_kind}`);
    seen.add(proof.proof_kind);
    assertEqual(proof.proof_gate, WORLD_V0_PROOF_GATES[proof.proof_kind], `ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_GATE:${proof.proof_kind}`);
    assertEqual(proof.proof_gate_fingerprint, worldProofGateFingerprint(proofIndex, proof.proof_gate), `ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_GATE_FINGERPRINT:${proof.proof_kind}`);
    assertEqual(proof.protocol_manifest_fingerprint, protocolLow, `ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_PROTOCOL:${proof.proof_kind}`);
    if (proof.actual_comparison_result !== true) throw new Error(`ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_RESULT:${proof.proof_kind}`);
    if (proof.blocker_count !== 0 || proof.warning_count !== 0) throw new Error(`ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_DIAGNOSTICS:${proof.proof_kind}`);
    const canonical = [worldProofKindEvidenceFingerprint(proofIndex), proof.proof_gate_fingerprint];
    assertEqual(stableJson(proof.input_corpus_case_fingerprints), stableJson(canonical), `ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_INPUT:${proof.proof_kind}`);
    assertEqual(stableJson(proof.expected_output_fingerprints), stableJson(canonical), `ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_EXPECTED:${proof.proof_kind}`);
    assertEqual(stableJson(proof.actual_output_fingerprints), stableJson(canonical), `ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_ACTUAL:${proof.proof_kind}`);
    assertEqual(stableJson(proof.bounded_diagnostics), stableJson(canonical), `ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_BOUNDED:${proof.proof_kind}`);
    const artifactEvidence = [canonical[0], canonical[1], receipt.universal_wasm_checksum, receipt.source_package_checksum];
    assertEqual(stableJson(proof.artifact_fingerprints), stableJson(artifactEvidence), `ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_ARTIFACTS:${proof.proof_kind}`);
    assertEqual(proof.receipt_fingerprint, worldProofReceiptFingerprint(proof, proofIndex), `ERR_AGENT_RUNTIME_WORLD_PROOF_RECEIPT_FINGERPRINT:${proof.proof_kind}`);
  }
}

function worldProtocolLowFingerprint(manifest) {
  const parts = manifest.world.protocolManifestFingerprint.split(':');
  return requireOwnerFingerprint(parts[parts.length - 1], 'world protocol manifest low fingerprint');
}

function ownerFingerprintFromSha256Prefix(value) {
  return `0x${value.slice(0, 16)}`;
}

function worldReleaseReceiptFingerprint(receipt) {
  const hasher = makeWorldProtocolHasher();
  hasher.bytes('world.protocol.release_receipt.v1');
  hasher.u64(receipt.release_receipt_format_version);
  hasher.u64(receipt.release_receipt_fingerprint_version);
  hasher.u64(parseHexU64(receipt.boundary_protocol_manifest_fingerprint, 'world release receipt boundary protocol'));
  hasher.u64(parseHexU64(receipt.world_protocol_manifest_fingerprint, 'world release receipt protocol'));
  hasher.u64(parseHexU64(receipt.conformance_corpus_root_fingerprint, 'world release receipt corpus'));
  hasher.u64(receipt.proof_receipts.length);
  for (const [index, proof] of receipt.proof_receipts.entries()) {
    hasher.u64(parseHexU64(proof.receipt_fingerprint, `world proof receipt fingerprint ${index}`));
  }
  hasher.u64(parseHexU64(receipt.universal_wasm_checksum, 'world release receipt wasm checksum'));
  hasher.u64(parseHexU64(receipt.source_package_checksum, 'world release receipt source package checksum'));
  hasher.bool(receipt.complete);
  hasher.u64Slice(receipt.blockers, 'world release receipt blockers');
  hasher.u64Slice(receipt.warnings, 'world release receipt warnings');
  return hex64(nonzero64(wyhash64(hasher.finish())));
}

function worldProofReceiptFingerprint(proof, index) {
  const hasher = makeWorldProtocolHasher();
  hasher.bytes('world.protocol.proof_receipt.v1');
  hasher.u64(proof.receipt_format_version);
  hasher.u64(proof.receipt_fingerprint_version);
  hasher.u64(index);
  hasher.u64(parseHexU64(proof.protocol_manifest_fingerprint, `world proof receipt protocol ${index}`));
  hasher.u64Slice(proof.input_corpus_case_fingerprints, `world proof receipt input ${index}`);
  hasher.u64Slice(proof.expected_output_fingerprints, `world proof receipt expected ${index}`);
  hasher.u64Slice(proof.actual_output_fingerprints, `world proof receipt actual ${index}`);
  hasher.bool(proof.actual_comparison_result);
  hasher.u64Slice(proof.artifact_fingerprints, `world proof receipt artifacts ${index}`);
  hasher.u64(proof.blocker_count);
  hasher.u64(proof.warning_count);
  hasher.u64Slice(proof.bounded_diagnostics, `world proof receipt bounded ${index}`);
  return hex64(nonzero64(wyhash64(hasher.finish())));
}

function worldConformanceCorpusRootFingerprint(corpus) {
  const hasher = makeWorldProtocolHasher();
  hasher.bytes('world.protocol.conformance_corpus.v0');
  hasher.stringList(corpus.positive, 'world corpus positive');
  hasher.stringList(corpus.negative, 'world corpus negative');
  hasher.stringList(corpus.transition, 'world corpus transition');
  hasher.stringList(corpus.wire_records, 'world corpus wire records');
  hasher.stringList(corpus.malformed_wire, 'world corpus malformed wire');
  hasher.u64(exactArray(corpus.proof_kinds, 'world corpus proof kinds').length);
  for (const [index, proofKind] of corpus.proof_kinds.entries()) {
    if (proofKind !== WORLD_V0_REQUIRED_PROOF_KINDS[index]) throw new Error(`ERR_AGENT_RUNTIME_WORLD_CORPUS_PROOF_KIND:${proofKind}`);
    const proofGate = WORLD_V0_PROOF_GATES[proofKind];
    hasher.u64(proofKind.length);
    hasher.bytes(proofKind);
    hasher.u64(parseHexU64(worldProofGateFingerprint(index, proofGate), `world proof gate ${proofKind}`));
  }
  const limits = corpus.limits ?? {};
  for (const field of [
    'max_universal_wasm_linear_memory_bytes',
    'max_executable_image_bytes',
    'max_turn_input_bytes',
    'max_turn_closure_bytes',
    'max_capsule_bytes',
    'max_archive_append_batch_bytes',
    'max_loaded_frame_depth',
    'max_runspace_slots',
    'max_mailbox_entries',
    'max_provider_depth',
    'max_request_batch_count',
    'max_reply_batch_count',
  ]) {
    hasher.u64(requiredSafeInteger(limits[field], `world corpus limit ${field}`));
  }
  return hex64(nonzero64(wyhash64(hasher.finish())));
}

function makeWorldProtocolHasher() {
  const chunks = [];
  const hasher = {
    bytes(value) {
      chunks.push(Buffer.from(value));
    },
    u64(value) {
      const out = Buffer.alloc(8);
      out.writeBigUInt64LE(BigInt(value));
      chunks.push(out);
    },
    bool(value) {
      hasher.u64(value ? 1 : 0);
    },
    u64Slice(values, label) {
      if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
      hasher.u64(values.length);
      for (const value of values) hasher.u64(parseHexU64(value, label));
    },
    stringList(values, label) {
      const strings = exactArray(values, label);
      hasher.u64(strings.length);
      for (const value of strings) {
        hasher.u64(value.length);
        hasher.bytes(value);
      }
    },
    finish() {
      return Buffer.concat(chunks);
    },
  };
  return hasher;
}

function parseHexU64(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(value)) throw new Error(`invalid owner fingerprint: ${label}`);
  return BigInt(value);
}

function requiredSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid integer: ${label}`);
  return value;
}

function nonzero64(value) {
  const normalized = BigInt.asUintN(64, value);
  return normalized === 0n ? 1n : normalized;
}

function hex64(value) {
  return `0x${BigInt.asUintN(64, value).toString(16).padStart(16, '0')}`;
}

function worldProofKindEvidenceFingerprint(index) {
  return `0x${(0x5750000000000000n + BigInt(index + 1)).toString(16).padStart(16, '0')}`;
}

function worldProofGateFingerprint(index, gateName) {
  let hash = 0xcbf29ce484222325n;
  hash = fnv64(hash, 0x5750470000000001n);
  hash = fnv64(hash, BigInt(index));
  hash = fnv64(hash, BigInt(gateName.length));
  for (const byte of Buffer.from(gateName, 'utf8')) hash = fnv64(hash, BigInt(byte));
  if (hash === 0n) hash = 1n;
  return `0x${hash.toString(16).padStart(16, '0')}`;
}

function fnv64(hash, value) {
  return ((hash ^ value) * 0x00000100000001b3n) & 0xffffffffffffffffn;
}

async function verifyPackagedPackageScripts(root, manifest) {
  const packageJson = JSON.parse(await readFile(path.join(root, 'world-host/package.json'), 'utf8'));
  if (packageJson.version !== WORLD_HOST_PACKAGE_VERSION) throw new Error('ERR_AGENT_RUNTIME_PACKAGE_VERSION');
  if (manifest.worldHost.packageVersion !== WORLD_HOST_PACKAGE_VERSION) throw new Error('ERR_AGENT_RUNTIME_PACKAGE_VERSION');
  assertNoRuntimePackageDependencies(packageJson);
  const scripts = packageJson.scripts ?? {};
  const allowedScripts = new Set(['check:agent-runtime']);
  if (scripts['check:agent-runtime'] !== EXPECTED_PACK_CHECK_SCRIPT) throw new Error('ERR_AGENT_RUNTIME_PACKAGE_SCRIPT:check:agent-runtime');
  for (const name of Object.keys(scripts)) {
    if (!allowedScripts.has(name)) throw new Error(`ERR_AGENT_RUNTIME_PACKAGE_SCRIPT:${name}`);
  }
  if (packageJson.bin?.['world-host'] !== './bin/world-host.mjs') throw new Error('ERR_AGENT_RUNTIME_PACKAGE_BIN:world-host');
  if (stableJson(packageJson.files) !== stableJson(EXPECTED_PACKAGE_FILES)) throw new Error('ERR_AGENT_RUNTIME_PACKAGE_FILES');
  await requireFile(path.join(root, 'world-host/bin/world-host.mjs'));
  for (const rel of packageJson.files ?? []) {
    await safePackageEntry(root, rel);
  }
  const readme = await readFile(path.join(root, 'world-host/README.md'), 'utf8');
  if (/\bbun(?:\s+run)?\s+(?:test|proof(?::[\w-]+)?)/.test(readme)) {
    throw new Error('ERR_AGENT_RUNTIME_PACKAGE_README_COMMAND');
  }
  const scriptEntrypoints = new Set();
  for (const command of Object.values(scripts)) {
    for (const match of command.matchAll(/\bbun\s+(scripts\/[^\s&|;]+\.mjs)\b/g)) {
      scriptEntrypoints.add(match[1]);
    }
  }
  for (const rel of scriptEntrypoints) {
    await requireFile(path.join(root, 'world-host', rel));
  }
}

function assertNoRuntimePackageDependencies(packageJson) {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
    const value = packageJson[field];
    if (value == null) continue;
    if (Array.isArray(value) ? value.length !== 0 : Object.keys(value).length !== 0) {
      throw new Error(`ERR_AGENT_RUNTIME_PACKAGE_DEPENDENCIES:${field}`);
    }
  }
}

async function verifyPackagedCarrierModule(root, carrier) {
  const packaged = await readFile(path.join(root, 'world-host/src/protocol/world_manifest.mjs'), 'utf8');
  if (sha256Hex(Buffer.from(packaged)) !== WORLD_HOST_CARRIER_MODULE_SHA256) {
    throw new Error('ERR_AGENT_RUNTIME_CARRIER_MODULE_SOURCE');
  }
  const sourceSummary = carrierModuleSummary(packaged);
  const manifestSummary = {
    carrierVersion: carrier.carrierVersion,
    supportedWorldRelease: carrier.supportedWorldRelease,
    supportedBoundaryRelease: carrier.supportedBoundaryRelease,
    applianceAbiVersion: carrier.applianceAbiVersion,
    turnClosureFormatVersion: carrier.turnClosureFormatVersion,
    universalWasmSha256: carrier.universalWasm?.sha256,
    runtimeDependencies: carrier.runtime?.runtimeDependencies,
    allowsNativeWorldHelperProcess: carrier.runtime?.allowsNativeWorldHelperProcess,
    allowsChildProcessProtocolEncoding: carrier.runtime?.allowsChildProcessProtocolEncoding,
  };
  if (stableJson(sourceSummary) !== stableJson(manifestSummary)) {
    throw new Error('ERR_AGENT_RUNTIME_CARRIER_MODULE_MANIFEST');
  }
}

function carrierModuleSummary(source) {
  return {
    carrierVersion: carrierModuleString(source, 'carrierVersion'),
    supportedWorldRelease: carrierModuleString(source, 'supportedWorldRelease'),
    supportedBoundaryRelease: carrierModuleString(source, 'supportedBoundaryRelease'),
    applianceAbiVersion: carrierModuleString(source, 'applianceAbiVersion'),
    turnClosureFormatVersion: carrierModuleString(source, 'turnClosureFormatVersion'),
    universalWasmSha256: carrierModuleString(source, 'sha256'),
    runtimeDependencies: carrierModuleInteger(source, 'runtimeDependencies'),
    allowsNativeWorldHelperProcess: carrierModuleBoolean(source, 'allowsNativeWorldHelperProcess'),
    allowsChildProcessProtocolEncoding: carrierModuleBoolean(source, 'allowsChildProcessProtocolEncoding'),
  };
}

function carrierModuleString(source, key) {
  const match = source.match(new RegExp(`${key}:\\s*'([^']+)'`));
  if (!match) throw new Error(`ERR_AGENT_RUNTIME_CARRIER_MODULE_FIELD:${key}`);
  return match[1];
}

function carrierModuleInteger(source, key) {
  const match = source.match(new RegExp(`${key}:\\s*(\\d+)`));
  if (!match) throw new Error(`ERR_AGENT_RUNTIME_CARRIER_MODULE_FIELD:${key}`);
  return Number(match[1]);
}

function carrierModuleBoolean(source, key) {
  const match = source.match(new RegExp(`${key}:\\s*(true|false)`));
  if (!match) throw new Error(`ERR_AGENT_RUNTIME_CARRIER_MODULE_FIELD:${key}`);
  return match[1] === 'true';
}

function assertGitSha(value, code) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) throw new Error(code);
}

async function safePackageEntry(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('ERR_AGENT_RUNTIME_PACKAGE_FILE');
  if (path.isAbsolute(rel)) throw new Error(`ERR_AGENT_RUNTIME_PACKAGE_FILE:${rel}`);
  const normalized = path.normalize(rel);
  if (normalized === '.' || normalized.startsWith('..') || normalized.includes(`${path.sep}..${path.sep}`)) {
    throw new Error(`ERR_AGENT_RUNTIME_PACKAGE_FILE:${rel}`);
  }
  const packageRoot = await realpath(path.join(root, 'world-host'));
  const target = path.resolve(packageRoot, normalized);
  if (target !== packageRoot && !target.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error(`ERR_AGENT_RUNTIME_PACKAGE_FILE:${rel}`);
  }
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error(`ERR_AGENT_RUNTIME_PACKAGE_FILE_SYMLINK:${rel}`);
  const realTarget = await realpath(target);
  if (realTarget !== packageRoot && !realTarget.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error(`ERR_AGENT_RUNTIME_PACKAGE_FILE:${rel}`);
  }
}

async function verifyProofReceipts(root, corpus, manifest) {
  const receipts = corpus.proofReceipts;
  if (!Array.isArray(receipts) || receipts.length === 0) throw new Error('ERR_AGENT_RUNTIME_PROOF_RECEIPTS');
  const expectedSubjects = new Map([
    ['boundary-agent-profile', manifest.boundary.agentProfileFingerprint],
    ['world-agent-dist', manifest.world.executableImageFingerprint],
    ['world-host-carrier', manifest.worldHost.carrierManifestFingerprint],
  ]);
  if (receipts.length !== expectedSubjects.size) throw new Error('ERR_AGENT_RUNTIME_PROOF_RECEIPTS');
  const seen = new Set();
  for (const receipt of receipts) {
    if (typeof receipt?.id !== 'string' || typeof receipt?.fingerprint !== 'string') throw new Error('ERR_AGENT_RUNTIME_PROOF_RECEIPT');
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(receipt.id)) throw new Error(`ERR_AGENT_RUNTIME_PROOF_RECEIPT_ID:${receipt.id}`);
    const expectedSubject = expectedSubjects.get(receipt.id);
    if (!expectedSubject || seen.has(receipt.id)) throw new Error(`ERR_AGENT_RUNTIME_PROOF_RECEIPT:${receipt.id}`);
    seen.add(receipt.id);
    if (receipt.subject !== expectedSubject) throw new Error(`ERR_AGENT_RUNTIME_PROOF_RECEIPT_SUBJECT:${receipt.id}`);
    const actual = JSON.parse(await readFile(path.join(root, `proof-receipts/${receipt.id}.json`), 'utf8'));
    if (stableJson(actual) !== stableJson(receipt)) throw new Error(`ERR_AGENT_RUNTIME_PROOF_RECEIPT:${receipt.id}`);
    if (actual.fingerprint !== fingerprintOf({ ...actual, fingerprint: undefined })) throw new Error(`ERR_AGENT_RUNTIME_PROOF_RECEIPT_FINGERPRINT:${receipt.id}`);
  }
}

function requireConformanceReceipt(conformance, manifest) {
  if (!conformance || typeof conformance !== 'object') throw new Error('ERR_AGENT_RUNTIME_CONFORMANCE_REQUIRED');
  if (conformance.agentRuntimeManifestFingerprint !== manifest.manifestFingerprint) throw new Error('ERR_AGENT_RUNTIME_CONFORMANCE_MANIFEST_FINGERPRINT');
  const required = [
    'agent_runtime_conformance',
    'owner_skeleton_example_completed',
    'owner_fixture_example_completed',
    'replay_matched',
    'retry_matched',
    'migration_matched',
    'branching_matched',
    'negative_cases_rejected',
    'world_evidence_validated',
    'distributed_skeleton_scenario_completed',
    'distributed_fixture_scenario_completed',
    'distributed_skeleton_effects_matched',
    'distributed_fixture_effects_matched',
    'distributed_empty_payloads_rejected',
    'host_did_not_author_receipts',
    'no_generated_agent_target_type',
    'no_native_helper_process',
    'distributed_wasm_compiled',
    'distributed_wasm_instantiated',
    'distributed_executable_image_loaded',
    'distributed_appliance_manifest_matched',
  ];
  for (const field of required) {
    if (conformance[field] !== true) throw new Error(`ERR_AGENT_RUNTIME_CONFORMANCE_${field}`);
  }
  return conformance;
}

async function safePackFile(root, rel) {
  if (path.isAbsolute(rel)) throw new Error(`ERR_CHECKSUM_PATH_ESCAPE:${rel}`);
  const normalized = path.normalize(rel);
  if (normalized.startsWith('..') || normalized.includes(`${path.sep}..${path.sep}`)) throw new Error(`ERR_CHECKSUM_PATH_ESCAPE:${rel}`);
  const rootPath = await realpath(root);
  const target = path.resolve(rootPath, normalized);
  if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) throw new Error(`ERR_CHECKSUM_PATH_ESCAPE:${rel}`);
  const linkInfo = await lstat(target);
  if (linkInfo.isSymbolicLink()) throw new Error(`ERR_CHECKSUM_PATH_SYMLINK:${rel}`);
  const realTarget = await realpath(target);
  if (realTarget !== rootPath && !realTarget.startsWith(`${rootPath}${path.sep}`)) throw new Error(`ERR_CHECKSUM_PATH_ESCAPE:${rel}`);
  const info = await stat(realTarget);
  if (!info.isFile()) throw new Error(`ERR_CHECKSUM_PATH_NOT_FILE:${rel}`);
  return realTarget;
}

function assertEqual(actual, expected, code) {
  if (actual !== expected) throw new Error(code);
}

async function listFiles(root, prefix = '') {
  const dir = path.join(root, prefix);
  const entries = await readdir(dir);
  const out = [];
  for (const entry of entries) {
    const rel = path.join(prefix, entry);
    const absolute = path.join(root, rel);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`ERR_PACK_SYMLINK:${rel.split(path.sep).join('/')}`);
    if (info.isDirectory()) out.push(...await listFiles(root, rel));
    else if (info.isFile()) out.push(rel.split(path.sep).join('/'));
  }
  return out;
}

async function fingerprintDirectory(root, options = {}) {
  const excluded = options.exclude ?? new Set();
  const files = (await listFiles(root)).filter((rel) => !excluded.has(rel));
  const entries = [];
  for (const rel of files.sort()) entries.push([rel, sha256Hex(await readFile(path.join(root, rel)))]);
  return fingerprintOf(entries);
}

async function fingerprintWorldHostPackageTree(packRoot) {
  return await fingerprintDirectory(path.join(packRoot, 'world-host'), {
    exclude: new Set(['agent-runtime-artifacts.json']),
  });
}

function proofReceipt(id, subject) {
  const receipt = {
    id,
    subject,
    generatedBy: 'agent-runtime-pack-builder',
    proofDerivedFromArtifactFingerprint: true,
  };
  return { ...receipt, fingerprint: fingerprintOf(receipt) };
}

function gitHead(repo, options = {}) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  const head = result.status === 0 ? result.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    if (options.required === false) return 'unknown';
    throw new Error(`ERR_AGENT_RUNTIME_GIT_HEAD:${repo}`);
  }
  return head;
}

async function loadCarrierManifest(worldHostRepo) {
  const modulePath = path.join(worldHostRepo, 'src/protocol/world_manifest.mjs');
  const moduleUrl = `${pathToFileURL(modulePath).href}?head=${gitHead(worldHostRepo)}`;
  const selected = await import(moduleUrl);
  return selected.carrierManifest;
}

function gitDirty(repo, ignoredTopLevelPaths = []) {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) return true;
  const ignored = new Set(ignoredTopLevelPaths.map((item) => item.replace(/\/+$/, '')));
  return result.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .some((file) => !ignored.has(file.split(/[\\/]/)[0]));
}

async function requireFile(file) {
  if (!existsSync(file)) throw new Error(`missing required file: ${file}`);
  const info = await lstat(file);
  if (!info.isFile()) throw new Error(`required path is not a file: ${file}`);
}

async function readRequiredFile(file, encoding = null) {
  await requireFile(file);
  return encoding ? readFile(file, encoding) : readFile(file);
}

function requireOwnerFingerprint(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error(`invalid owner fingerprint: ${label}`);
  return value.toLowerCase();
}

function boundaryCorpusProfileFingerprint(corpus) {
  const match = corpus.match(/^profile_fingerprint:\s*(0x[0-9a-f]+)\s*$/im);
  if (!match) throw new Error('ERR_AGENT_RUNTIME_BOUNDARY_CORPUS_PROFILE_FINGERPRINT');
  return requireOwnerFingerprint(match[1], 'boundary corpus profile');
}

function bindBoundaryCorpusProfile(corpus, profile) {
  const expected = requireOwnerFingerprint(profile.profile_fingerprint, 'boundary agent profile');
  if (corpus.length === 0) throw new Error('ERR_AGENT_RUNTIME_BOUNDARY_CORPUS_MISSING');
  if (!/^profile_fingerprint:\s*0x[0-9a-f]+\s*$/im.test(corpus)) {
    throw new Error('ERR_AGENT_RUNTIME_BOUNDARY_CORPUS_PROFILE_FINGERPRINT');
  }
  return Buffer.from(corpus.replace(/^profile_fingerprint:\s*0x[0-9a-f]+\s*$/im, `profile_fingerprint: ${expected}`));
}

function exactArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error(`invalid array: ${label}`);
  }
  return value;
}

function worldActuatorRef(value) {
  const hex = requireOwnerFingerprint(value, 'world actuator ref fingerprint').slice('0x'.length).padStart(16, '0');
  return `world:actuator-ref:${hex}`;
}

function worldDescriptorFingerprint(value) {
  const hex = requireOwnerFingerprint(value, 'world descriptor fingerprint').slice('0x'.length).padStart(16, '0');
  return `world:descriptor:${hex}`;
}

function worldProtocolFingerprint(releaseArtifact) {
  const lo = releaseArtifact?.wasm?.protocol_manifest_fingerprint_lo;
  const hi = releaseArtifact?.wasm?.protocol_manifest_fingerprint_hi;
  if (typeof lo === 'string' && typeof hi === 'string') return `${hi.toLowerCase()}:${lo.toLowerCase()}`;
  return fingerprintOf({ kind: 'world.Protocol.Manifest', wasm: releaseArtifact?.wasm ?? null });
}

function worldProtocolManifestFileFingerprint(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('ERR_AGENT_RUNTIME_WORLD_PROTOCOL_MANIFEST_PARSE');
  }
  const lo = requireOwnerFingerprint(parsed.protocol_manifest_fingerprint_lo, 'world protocol manifest lo');
  const hi = requireOwnerFingerprint(parsed.protocol_manifest_fingerprint_hi, 'world protocol manifest hi');
  return `${hi}:${lo}`;
}

function boundaryProtocolManifestFileFingerprint(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (data.byteLength < 20) throw new Error('ERR_AGENT_RUNTIME_BOUNDARY_PROTOCOL_MANIFEST_PARSE');
  const magic = Buffer.from(data.slice(0, 4)).toString('utf8');
  if (magic !== 'BPM1') throw new Error('ERR_AGENT_RUNTIME_BOUNDARY_PROTOCOL_MANIFEST_PARSE');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(4, true) !== 1 || view.getUint32(8, true) !== 1) {
    throw new Error('ERR_AGENT_RUNTIME_BOUNDARY_PROTOCOL_MANIFEST_VERSION');
  }
  return `0x${view.getBigUint64(12, true).toString(16).padStart(16, '0')}`;
}
