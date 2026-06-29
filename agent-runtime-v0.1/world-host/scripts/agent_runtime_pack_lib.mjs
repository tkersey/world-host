import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
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
import { carrierManifest } from '../src/protocol/world_manifest.mjs';

export const PACK_NAME = 'agent-runtime-v0.1';
export const FIXTURE_INPUT = 'rewrite this file through the agent loop\n';
export const FIXTURE_OUTPUT = 'actuate updated the fixture';
export const FIXTURE_RESULT = 'final=fixture updated';
export const SKELETON_RESULT = 'final=actuate skeleton complete';

export function parseCommonArgs(raw) {
  const parsed = {};
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];
    if (arg === '--out' || arg === '--pack') parsed.out = raw[++i];
    else if (arg === '--boundary-repo') parsed.boundaryRepo = raw[++i];
    else if (arg === '--world-repo') parsed.worldRepo = raw[++i];
    else if (arg === '--world-host-repo') parsed.worldHostRepo = raw[++i];
    else if (arg === '--receipt-out') parsed.receiptOut = raw[++i];
    else if (arg === '--release-receipt-out') parsed.releaseReceiptOut = raw[++i];
    else if (arg === '--conformance-receipt') parsed.conformanceReceipt = raw[++i];
    else if (!arg.startsWith('--') && !parsed.out) parsed.out = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
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
  const manifest = buildAgentRuntimeManifest({
    agentRuntimeVersion: 'v0.1',
    boundary,
    world,
    worldHost: host,
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
      worldHost: host.artifacts,
    },
    metadata: {
      semanticIdentityHasWallClock: false,
      credentialsIncluded: false,
      hostSpecificFilesystemPathsIncluded: false,
      buildDiagnostics: {
        boundaryHead: boundary.gitHead,
        worldHead: world.gitHead,
        worldHostHead: host.gitHead,
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
}

function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function checkAgentRuntimePack(pack) {
  const root = path.resolve(pack);
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
  for (const rel of required) await requireFile(path.join(root, rel));
  await verifyChecksums(root);
  const manifestBytes = await readFile(path.join(root, 'manifest/agent-runtime-manifest.json'));
  const manifest = assertAgentRuntimeManifest(JSON.parse(manifestBytes.toString('utf8')));
  const manifestBin = await readFile(path.join(root, 'manifest/agent-runtime-manifest.bin'));
  if (Buffer.compare(manifestBin, Buffer.from(stableJson(manifest))) !== 0) throw new Error('ERR_AGENT_RUNTIME_MANIFEST_BIN_MISMATCH');
  const wasm = await readFile(path.join(root, 'world/world_universal_appliance.wasm'));
  if (manifest.world.universalWasmSha256 !== sha256Hex(wasm)) throw new Error('ERR_AGENT_RUNTIME_WASM_CHECKSUM');
  await verifyManifestArtifacts(root, manifest);
  const corpus = JSON.parse(await readFile(path.join(root, 'conformance/corpus.json'), 'utf8'));
  if (corpus.warnings?.length) throw new Error(`ERR_AGENT_RUNTIME_OWNER_EXPORT_WARNINGS:${corpus.warnings.join(',')}`);
  return { root, manifest, complete: true };
}

export async function emitReleaseReceipt(pack, conformance) {
  const checked = await checkAgentRuntimePack(pack);
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
    skeletonProofPassed: proof.skeleton_completed === true,
    fixtureProofPassed: proof.fixture_completed === true,
    replayProofPassed: proof.replay_matched === true,
    retryProofPassed: proof.retry_matched === true,
    migrationProofPassed: proof.migration_matched === true,
    branchingProofPassed: proof.branching_matched === true,
    negativeProofPassed: proof.negative_cases_rejected === true,
    complete: false,
    blockers: [],
    warnings: corpus.warnings,
  };
  receipt.complete = [
    receipt.skeletonProofPassed,
    receipt.fixtureProofPassed,
    receipt.replayProofPassed,
    receipt.retryProofPassed,
    receipt.migrationProofPassed,
    receipt.branchingProofPassed,
    receipt.negativeProofPassed,
  ].every(Boolean);
  receipt.receiptFingerprint = releaseReceiptFingerprint(receipt);
  return receipt;
}

export async function assertAgentRuntimeReleaseReceipt(pack, actual) {
  const checked = await checkAgentRuntimePack(pack);
  const root = checked.root;
  const manifest = checked.manifest;
  const corpus = JSON.parse(await readFile(path.join(root, 'conformance/corpus.json'), 'utf8'));
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
    'skeletonProofPassed',
    'fixtureProofPassed',
    'replayProofPassed',
    'retryProofPassed',
    'migrationProofPassed',
    'branchingProofPassed',
    'negativeProofPassed',
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
  const exportDir = path.join(boundaryRepo, 'zig-out/dist/boundary-v0.6.2-agent-runtime');
  const rootModule = await readRequiredFile(path.join(exportDir, 'agent-root.full-module'));
  const toolboxModule = await readRequiredFile(path.join(exportDir, 'toolbox-provider.full-module'));
  const protocolManifest = await readRequiredFile(path.join(exportDir, 'boundary-protocol-manifest.bin'));
  const profile = JSON.parse(await readRequiredFile(path.join(exportDir, 'agent-profile.json'), 'utf8'));
  const corpusPath = path.join(boundaryRepo, 'conformance/v0/agent/corpus.boundary-agent.txt');
  const corpus = bindBoundaryCorpusProfile(
    existsSync(corpusPath) ? await readFile(corpusPath, 'utf8') : '',
    profile,
  );
  return {
    packageVersion: version,
    packageHash: gitHead(boundaryRepo),
    protocolManifestFingerprint: requireOwnerFingerprint(profile.boundary_protocol_manifest_fingerprint, 'boundary profile protocol manifest'),
    agentProfileFingerprint: requireOwnerFingerprint(profile.profile_fingerprint, 'boundary agent profile'),
    agentRootModuleFingerprint: requireOwnerFingerprint(profile.agent_root_module_fingerprint, 'boundary agent root module'),
    toolboxModuleFingerprint: requireOwnerFingerprint(profile.toolbox_module_fingerprint, 'boundary toolbox module'),
    gitHead: gitHead(boundaryRepo),
    files: { rootModule, toolboxModule, protocolManifest, profile, corpus },
    artifacts: {
      agentRootModule: { exportedByOwner: true, sha256: sha256Hex(rootModule), byteFingerprint: profile.agent_root_full_module_byte_fingerprint },
      toolboxModule: { exportedByOwner: true, sha256: sha256Hex(toolboxModule), byteFingerprint: profile.toolbox_full_module_byte_fingerprint },
      protocolManifest: { exportedByOwner: true, sha256: sha256Hex(protocolManifest) },
      agentProfile: { exportedByOwner: true, sha256: sha256Hex(Buffer.from(stableJson(profile))) },
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
  const agentRuntimeMetadata = JSON.parse(await readRequiredFile(path.join(exportDir, 'agent-runtime-world-artifacts.json'), 'utf8'));
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
    files: { protocolManifest, releaseReceipt, wasm, corpus, image, applianceManifest, agentRuntimeMetadata },
    artifacts: {
      executableImage: { exportedByOwner: true, sha256: sha256Hex(image) },
      applianceManifest: { exportedByOwner: true, sha256: sha256Hex(applianceManifest) },
      universalWasm: { exportedByOwner: true, sha256: sha256Hex(wasm) },
      releaseReceipt: { exportedByOwner: true, sha256: sha256Hex(releaseReceipt) },
      agentRuntimeMetadata: { exportedByOwner: true, sha256: sha256Hex(Buffer.from(stableJson(agentRuntimeMetadata))) },
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
  await writeFile(path.join(out, 'boundary/agent-profile.json'), `${JSON.stringify(boundary.files.profile, null, 2)}\n`);
  await writeFile(path.join(out, 'boundary/corpus.boundary-agent.txt'), boundary.files.corpus);
  await writeFile(path.join(out, 'world/agent.executable-image'), world.files.image);
  await writeFile(path.join(out, 'world/appliance-manifest.bin'), world.files.applianceManifest);
  await writeFile(path.join(out, 'world/world_universal_appliance.wasm'), world.files.wasm);
  await writeFile(path.join(out, 'world/world-protocol-manifest.bin'), world.files.protocolManifest);
  await writeFile(path.join(out, 'world/release-receipt.bin'), world.files.releaseReceipt);
  await writeFile(path.join(out, 'world/conformance-corpus.json'), world.files.corpus);
  await writeFile(path.join(out, 'world/agent-runtime-world-artifacts.json'), `${JSON.stringify(world.files.agentRuntimeMetadata, null, 2)}\n`);
  await writeFile(path.join(out, 'world-host/carrier-manifest.json'), `${JSON.stringify(host.carrierManifest, null, 2)}\n`);
  await writeFile(path.join(out, 'world-host/agent-runtime-artifacts.json'), `${JSON.stringify({ boundary: boundary.artifacts, world: world.artifacts, worldHost: host.artifacts }, null, 2)}\n`);
}

async function copyWorldHostPackage(worldHostRepo, out) {
  for (const rel of ['bin', 'src', 'examples', 'scripts', 'docs']) {
    await cp(path.join(worldHostRepo, rel), path.join(out, rel), {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`) && !source.includes(`${path.sep}${PACK_NAME}${path.sep}`),
    });
  }
  for (const rel of ['package.json', 'README.md']) {
    await cp(path.join(worldHostRepo, rel), path.join(out, rel));
  }
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
      fixtureInput: FIXTURE_INPUT,
      fixtureOutput: FIXTURE_OUTPUT,
      fixtureFinalResult: FIXTURE_RESULT,
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
  const boundaryProfile = JSON.parse(await readFile(path.join(root, 'boundary/agent-profile.json'), 'utf8'));
  const boundaryCorpus = await readFile(path.join(root, 'boundary/corpus.boundary-agent.txt'), 'utf8');
  const worldMetadata = JSON.parse(await readFile(path.join(root, 'world/agent-runtime-world-artifacts.json'), 'utf8'));
  const carrier = JSON.parse(await readFile(path.join(root, 'world-host/carrier-manifest.json'), 'utf8'));
  const conformanceCorpusFingerprint = await fingerprintDirectory(path.join(root, 'conformance'));

  assertEqual(manifest.boundary.protocolManifestFingerprint, requireOwnerFingerprint(boundaryProfile.boundary_protocol_manifest_fingerprint, 'boundary profile protocol manifest'), 'ERR_AGENT_RUNTIME_BOUNDARY_PROTOCOL_FINGERPRINT');
  assertEqual(manifest.boundary.agentProfileFingerprint, requireOwnerFingerprint(boundaryProfile.profile_fingerprint, 'boundary agent profile'), 'ERR_AGENT_RUNTIME_BOUNDARY_PROFILE_FINGERPRINT');
  assertEqual(manifest.boundary.agentProfileFingerprint, boundaryCorpusProfileFingerprint(boundaryCorpus), 'ERR_AGENT_RUNTIME_BOUNDARY_CORPUS_PROFILE_FINGERPRINT');
  assertEqual(manifest.boundary.agentRootModuleFingerprint, requireOwnerFingerprint(boundaryProfile.agent_root_module_fingerprint, 'boundary agent root module'), 'ERR_AGENT_RUNTIME_BOUNDARY_ROOT_FINGERPRINT');
  assertEqual(manifest.boundary.toolboxModuleFingerprint, requireOwnerFingerprint(boundaryProfile.toolbox_module_fingerprint, 'boundary toolbox module'), 'ERR_AGENT_RUNTIME_BOUNDARY_TOOLBOX_FINGERPRINT');
  assertEqual(manifest.world.executableImageFingerprint, requireOwnerFingerprint(worldMetadata.world_executable_image_fingerprint, 'world executable image'), 'ERR_AGENT_RUNTIME_WORLD_IMAGE_FINGERPRINT');
  assertEqual(manifest.world.applianceManifestFingerprint, requireOwnerFingerprint(worldMetadata.world_appliance_manifest_fingerprint, 'world appliance manifest'), 'ERR_AGENT_RUNTIME_WORLD_APPLIANCE_FINGERPRINT');
  assertEqual(stableJson(manifest.requiredActuatorRefs), stableJson(exactArray(worldMetadata.required_actuator_ref_fingerprints, 'world required actuator ref fingerprints').map(worldActuatorRef)), 'ERR_AGENT_RUNTIME_ACTUATOR_REFS');
  assertEqual(stableJson(manifest.requiredDescriptorFingerprints), stableJson(exactArray(worldMetadata.required_descriptor_fingerprints, 'world required descriptor fingerprints').map(worldDescriptorFingerprint)), 'ERR_AGENT_RUNTIME_DESCRIPTOR_FINGERPRINTS');
  assertEqual(manifest.worldHost.carrierManifestFingerprint, carrierManifestFingerprint(carrier), 'ERR_AGENT_RUNTIME_CARRIER_MANIFEST_FINGERPRINT');
  assertEqual(manifest.conformanceCorpusFingerprint, conformanceCorpusFingerprint, 'ERR_AGENT_RUNTIME_CONFORMANCE_CORPUS_FINGERPRINT');

  const artifactChecks = [
    ['boundary.agentRootModule.sha256', manifest.artifacts?.boundary?.agentRootModule?.sha256, async () => readFile(path.join(root, 'boundary/agent-root.full-module'))],
    ['boundary.toolboxModule.sha256', manifest.artifacts?.boundary?.toolboxModule?.sha256, async () => readFile(path.join(root, 'boundary/toolbox-provider.full-module'))],
    ['boundary.protocolManifest.sha256', manifest.artifacts?.boundary?.protocolManifest?.sha256, async () => readFile(path.join(root, 'boundary/boundary-protocol-manifest.bin'))],
    ['boundary.agentProfile.sha256', manifest.artifacts?.boundary?.agentProfile?.sha256, async () => Buffer.from(stableJson(boundaryProfile))],
    ['boundary.corpus.sha256', manifest.artifacts?.boundary?.corpus?.sha256, async () => Buffer.from(boundaryCorpus)],
    ['world.executableImage.sha256', manifest.artifacts?.world?.executableImage?.sha256, async () => readFile(path.join(root, 'world/agent.executable-image'))],
    ['world.applianceManifest.sha256', manifest.artifacts?.world?.applianceManifest?.sha256, async () => readFile(path.join(root, 'world/appliance-manifest.bin'))],
    ['world.universalWasm.sha256', manifest.artifacts?.world?.universalWasm?.sha256, async () => readFile(path.join(root, 'world/world_universal_appliance.wasm'))],
    ['world.releaseReceipt.sha256', manifest.artifacts?.world?.releaseReceipt?.sha256, async () => readFile(path.join(root, 'world/release-receipt.bin'))],
    ['world.agentRuntimeMetadata.sha256', manifest.artifacts?.world?.agentRuntimeMetadata?.sha256, async () => Buffer.from(stableJson(worldMetadata))],
  ];
  for (const [label, expected, readBytes] of artifactChecks) {
    if (typeof expected !== 'string') throw new Error(`ERR_AGENT_RUNTIME_ARTIFACT_SHA:${label}`);
    const actual = sha256Hex(await readBytes());
    if (actual !== expected) throw new Error(`ERR_AGENT_RUNTIME_ARTIFACT_SHA:${label}`);
  }
}

function requireConformanceReceipt(conformance, manifest) {
  if (!conformance || typeof conformance !== 'object') throw new Error('ERR_AGENT_RUNTIME_CONFORMANCE_REQUIRED');
  if (conformance.agentRuntimeManifestFingerprint !== manifest.manifestFingerprint) throw new Error('ERR_AGENT_RUNTIME_CONFORMANCE_MANIFEST_FINGERPRINT');
  const required = [
    'agent_runtime_conformance',
    'skeleton_completed',
    'fixture_completed',
    'replay_matched',
    'retry_matched',
    'migration_matched',
    'branching_matched',
    'negative_cases_rejected',
    'world_evidence_validated',
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
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, normalized);
  if (target !== rootPath && !target.startsWith(`${rootPath}${path.sep}`)) throw new Error(`ERR_CHECKSUM_PATH_ESCAPE:${rel}`);
  const info = await lstat(target);
  if (!info.isFile()) throw new Error(`ERR_CHECKSUM_PATH_NOT_FILE:${rel}`);
  return target;
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
    const info = await stat(absolute);
    if (info.isDirectory()) out.push(...await listFiles(root, rel));
    else if (info.isFile()) out.push(rel.split(path.sep).join('/'));
  }
  return out;
}

async function fingerprintDirectory(root) {
  const files = await listFiles(root);
  const entries = [];
  for (const rel of files.sort()) entries.push([rel, sha256Hex(await readFile(path.join(root, rel)))]);
  return fingerprintOf(entries);
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

function gitHead(repo) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
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
