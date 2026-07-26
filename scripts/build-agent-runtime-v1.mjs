#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ApplicationWorker } from '../src/v1/index.mjs';
import { checkAgentRuntimeV1Pack } from './check-agent-runtime-v1-pack.mjs';

const BOUNDARY_RELEASE = Object.freeze({
  tag: 'v0.7.0',
  packageHash: 'boundary-0.7.0-flclaCnjkABOSWaiSkxMBDQZsBEeA-Niai-l1u0q3A7_',
  url: 'https://github.com/tkersey/boundary/archive/refs/tags/v0.7.0.tar.gz',
});
const BOUNDARY_RELEASE_GIT_COMMIT = '7f2472100454aa2cd5c62e07db0c1e23eaf46a77';
const WORLD_RELEASE = Object.freeze({
  tag: 'v1.0.0-rc.2',
  packageHash: 'world-1.0.0-rc.2-XXTUeOXYhwC1anDePj7Lr4SfwDCxG-ofPw92_-PGGyKv',
  url: 'https://github.com/tkersey/world/archive/refs/tags/v1.0.0-rc.2.tar.gz',
});
const WORLD_RELEASE_GIT_COMMIT = 'a79265906bdf75d432b8f5286159598ef2282da0';
const CAPABILITY_RELEASE = Object.freeze({
  tag: 'v1.0.0-rc.4',
  gitCommit: '45d023f2bd0658e377142eda9b5103589308870c',
  researchPackFingerprint: 'ff4cecaf449db1bf2032dd22e1b0dcca94c02091ba547719fe36089dd61c205e',
  researchPackAssetSha256: '96ea017436264f7574e1dd8e385df3acb0cde97babd855ca3b98ee43d56f4d1f',
  runtimeAssetSha256: 'b6b87dc78e90d5ba626f20489016bab4c0f3ff39ae1e9ce77c2ab76ed1150cfc',
  researchManifestSha256: 'd4dd78c9e33094c7a1b68f58503f57418dd82148274272a5ec0dd645280c6787',
  researchCorpusSha256: '93b00d2b93f035f03bf8ed645a4fc82a60029d2e7f34a05ef0accf315c8944a5',
  researchConformanceSha256: '51c401f45457984eba266483305ba1b7be3be9f5044ccabe573fa1544a4442e3',
  researchConformanceReceiptSha256: 'e7f067d21c38643ea436e1e4b22794b616f8ce69974048a881a537ad9e0e3eea',
  capabilityManifestSha256: Object.freeze({
    '@tkersey/world-capabilities/fixture-model': '1b29784e303e9e54253ff701e99adf73650d8b47effb0e61559051bfd7f61645',
    '@tkersey/world-capabilities/generic-http-json': '8c83e794ad6f507f6c2cb9040b464d2e62b7880fcb047a46bf73e1e519adde3e',
    '@tkersey/world-capabilities/human-approval': '2afd6e5ad491d2c8b72be32176922186d48e151bd36c238afadd67c342a6991e',
    '@tkersey/world-capabilities/local-memory-kv': '5ba65a48e2a28c2b1b3cdcd27a433724997e915312dd5cd83560efee490106ee',
    '@tkersey/world-capabilities/research-lookup-fixture': 'd4dd78c9e33094c7a1b68f58503f57418dd82148274272a5ec0dd645280c6787',
    '@tkersey/world-capabilities/sandbox-files': '7c087eeb01df5f8fed3dab1912a8cf14155c0dc23a88ba765c015c94bfbcb2eb',
  }),
});
const EXTERNAL_APPLICATION_RELEASE = Object.freeze({
  name: 'research-digest-agent',
  worldReleaseTag: WORLD_RELEASE.tag,
  wasmSha256: 'ced222d3537ca9b36165278190baef8b7ef79b091876d685a1dc24d5a926caca',
  manifestSha256: 'e48349346439a8b16040d9f98d90b8ab1e559e56be9a18ca10f7d4a1f1e32c4c',
});

const options = parseArgs(process.argv.slice(2));
const temporaryRoots = new Set();
process.on('exit', () => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});
if (options.releaseStatus === 'release-candidate') {
  assert(options.externalApplicationRoot !== null,
    'release-candidate builds require --external-application-root from the clean-room World release proof');
  assert(options.capabilitiesRuntimeArchive !== null,
    'release-candidate builds require --world-capabilities-runtime-archive from the reviewed release');
  assert(options.boundaryReleaseArchive !== null,
    'release-candidate builds require --boundary-release-archive from the reviewed release');
  assert(options.worldReleaseArchive !== null,
    'release-candidate builds require --world-release-archive from the reviewed release');
}
const sourceCommits = options.releaseStatus === 'development'
  ? {}
  : {
      boundaryGitCommit: BOUNDARY_RELEASE_GIT_COMMIT,
      worldGitCommit: WORLD_RELEASE_GIT_COMMIT,
      worldHostGitCommit: await sourceCommit(options.worldHostRepo, [
        'bin/world-host-v1.mjs',
        'docs',
        'scripts/build-agent-runtime-v1.mjs',
        'scripts/check-agent-runtime-v1-pack.mjs',
        'scripts/run-agent-runtime-v1-conformance.mjs',
        'src/bun/application_v1_cli.mjs',
        'src/bun/application_v1_inspection_worker.mjs',
        'src/v1',
      ]),
      worldCapabilitiesGitCommit: CAPABILITY_RELEASE.gitCommit,
    };
const worldReleaseMaterialization = options.releaseStatus === 'release-candidate'
  ? await materializeWorldRelease(options.boundaryReleaseArchive, options.worldReleaseArchive)
  : null;
const capabilityMaterialization = options.releaseStatus === 'release-candidate'
  ? await materializeCapabilityRuntime(options.capabilitiesRuntimeArchive)
  : null;
const capabilitiesRepo = capabilityMaterialization?.packageRoot ?? options.capabilitiesRepo;
const worldRepo = worldReleaseMaterialization?.packageRoot ?? options.worldRepo;
const externalApplication = options.releaseStatus === 'release-candidate'
  ? await verifyExternalApplicationRoot({
      externalApplicationRoot: options.externalApplicationRoot,
      sourceRoots: [
        { path: worldReleaseMaterialization.temporaryRoot, optional: false },
        { path: capabilityMaterialization.temporaryRoot, optional: false },
        { path: options.worldHostRepo, optional: false },
        { path: options.boundaryRepo, optional: true },
        { path: options.worldRepo, optional: true },
        { path: options.capabilitiesRepo, optional: true },
      ],
    })
  : Object.freeze({
      root: options.externalApplicationRoot ??
        path.join(options.worldRepo, 'conformance/external-build-helper/zig-out/world-apps'),
      verified: false,
    });
await buildWorldApplications(worldRepo, worldReleaseMaterialization);
await prepareOutput(options.out);

const applications = [];
for (const source of [
  { name: 'one-effect', wasm: path.join(worldRepo, 'zig-out/bin/one-effect.world.wasm') },
  { name: 'skeleton-agent', wasm: path.join(worldRepo, 'zig-out/world-apps/skeleton-agent.world.wasm') },
  { name: 'fixture-agent', wasm: path.join(worldRepo, 'zig-out/world-apps/fixture-agent.world.wasm') },
  {
    name: 'research-digest-agent',
    wasm: path.join(externalApplication.root, 'research-digest-agent.world.wasm'),
    manifest: path.join(externalApplication.root, 'research-digest-agent.manifest.bin'),
    provenance: externalApplication.verified ? 'external-clean-room' : 'development-helper',
  },
]) {
  applications.push(await copyApplication(source));
}

await copySelected(options.worldHostRepo, options.out, [
  'bin/world-host-v1.mjs',
  'src/bun/application_v1_cli.mjs',
  'src/bun/application_v1_inspection_worker.mjs',
  ...await filesBelow(options.worldHostRepo, 'src/v1'),
], 'host');
await writeFile(path.join(options.out, 'host/package.json'), `${JSON.stringify({
  name: '@tkersey/world-host-v1-runtime',
  version: '1.0.0-rc.2',
  private: true,
  type: 'module',
  dependencies: {},
}, null, 2)}\n`);

const capabilityPackages = [
  'fixture-model',
  'generic-http-json',
  'human-approval',
  'local-memory-kv',
  'research-lookup-fixture',
  'sandbox-files',
];
await copySelected(capabilitiesRepo, options.out, [
  ...await filesBelow(capabilitiesRepo, 'src/v1'),
  ...(
    await Promise.all(capabilityPackages.map((name) => filesBelow(capabilitiesRepo, `packages/${name}`)))
  ).flat(),
], 'capabilities');
await writeFile(path.join(options.out, 'capabilities/package.json'), `${JSON.stringify({
  name: '@tkersey/world-capabilities-v1-runtime',
  version: '1.0.0-rc.4',
  private: true,
  type: 'module',
  dependencies: {},
}, null, 2)}\n`);

await copySelected(path.join(options.worldHostRepo, 'docs'), options.out, [
  'application_wasm_hosting.md',
  'frame_storage.md',
  'agent_runtime_v1_pack.md',
  'agent_runtime_v1_performance.md',
  'v1_replay_retry.md',
  'v1_migration.md',
  'v0_v1_profiles.md',
], 'docs/world-host');
await copySelected(path.join(capabilitiesRepo, 'docs'), options.out, [
  'effect_protocol_v1.md',
  'agent_invoke_v1.md',
  'v0_v1_adapter.md',
], 'docs/world-capabilities');

await mkdir(path.join(options.out, 'conformance'), { recursive: true });
const checkerSource = await readFile(
  path.join(options.worldHostRepo, 'scripts/check-agent-runtime-v1-pack.mjs'),
  'utf8',
);
const checkerCommitToken = "'__WORLD_HOST_GIT_COMMIT__'";
assert.equal(checkerSource.split(checkerCommitToken).length, 2,
  'pack checker must contain exactly one world-host source commit token');
const packagedChecker = options.releaseStatus === 'development'
  ? checkerSource
  : checkerSource.replace(
      checkerCommitToken,
      `'${sourceCommits.worldHostGitCommit}'`,
    );
await writeFile(path.join(options.out, 'conformance/check-pack.mjs'), packagedChecker);
await copyFile(path.join(options.worldHostRepo, 'scripts/run-agent-runtime-v1-conformance.mjs'), path.join(options.out, 'conformance/run.mjs'));

const capabilities = [];
for (const name of capabilityPackages) {
  const manifestBytes = await readFile(path.join(capabilitiesRepo, `packages/${name}/manifest.json`));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  capabilities.push({
    packageName: manifest.packageName,
    path: `capabilities/packages/${name}`,
    packFingerprint: manifest.packFingerprint,
    packageVersion: manifest.packageVersion,
    manifestSha256: sha256(manifestBytes),
  });
}

const reference = applications[0].manifest;
for (const application of applications) {
  assert.equal(application.manifest.boundaryPackageVersion, reference.boundaryPackageVersion);
  assert.equal(application.manifest.boundaryStaticMachineAbiVersion, reference.boundaryStaticMachineAbiVersion);
  assert.equal(application.manifest.worldPackageVersion, reference.worldPackageVersion);
  assert.equal(application.manifest.worldApplicationAbiVersion, reference.worldApplicationAbiVersion);
}

const packManifest = {
  formatVersion: 'agent-runtime-v1-pack/v1',
  releaseStatus: options.releaseStatus,
  protocols: {
    applicationAbiVersion: 1,
    frameFormatVersion: 1,
    effectProtocolVersion: 'world-effect-v1',
  },
  host: {
    entrypoint: 'host/bin/world-host-v1.mjs',
    profile: 'application-v1',
    runtimeDependencies: 0,
  },
  applications: applications.map(({ manifest, ...application }) => application),
  capabilities,
  conformance: {
    entrypoint: 'conformance/run.mjs',
    scenarios: [
      'one-effect',
      'skeleton-agent',
      'fixture-agent',
      'research-digest',
      'provider-parked',
      'fresh-instance-resume',
      'deterministic-retry',
      'replay',
      'branching',
      'migration',
      'negative',
    ],
  },
  sourcePins: {
    boundaryPackageVersion: reference.boundaryPackageVersion,
    boundaryStaticMachineAbiVersion: reference.boundaryStaticMachineAbiVersion,
    worldPackageVersion: reference.worldPackageVersion,
    worldApplicationAbiVersion: reference.worldApplicationAbiVersion,
    artifactIdentity: 'sha256',
    boundaryRelease: BOUNDARY_RELEASE,
    worldRelease: WORLD_RELEASE,
    worldCapabilitiesRelease: CAPABILITY_RELEASE,
    externalApplicationRelease: EXTERNAL_APPLICATION_RELEASE,
    worldHostPackageVersion: '1.0.0-rc.2',
    ...sourceCommits,
  },
  externality: {
    application: 'research-digest-agent',
    authoredOutsideSourceRepositories: externalApplication.verified,
    sourceCheckoutRequiredForConformance: false,
    capabilitySpecificHostLogic: false,
    hostAuthoredFrame: false,
  },
  nonClaims: [
    'no cryptographic authenticity',
    'no confidentiality',
    'no exactly-once effects',
    'no distributed consensus',
    'no v0 state migration',
  ],
};
await writeFile(path.join(options.out, 'manifest.json'), `${JSON.stringify(packManifest, null, 2)}\n`);
await writeFile(path.join(options.out, 'README.md'), packReadme(packManifest));
await writeChecksums(options.out);
if (capabilityMaterialization !== null) {
  await rm(capabilityMaterialization.temporaryRoot, { recursive: true, force: true });
  temporaryRoots.delete(capabilityMaterialization.temporaryRoot);
}
if (worldReleaseMaterialization !== null) {
  await rm(worldReleaseMaterialization.temporaryRoot, { recursive: true, force: true });
  temporaryRoots.delete(worldReleaseMaterialization.temporaryRoot);
}

const receipt = await checkAgentRuntimeV1Pack(options.out, {
  expectedWorldHostGitCommit: sourceCommits.worldHostGitCommit,
});
process.stdout.write(`${JSON.stringify({
  command: 'build-agent-runtime-v1',
  output: options.out,
  releaseStatus: options.releaseStatus,
  applicationCount: receipt.applications.length,
  capabilityCount: receipt.capabilities.length,
  checksumCount: receipt.checksumCount,
  sourceCheckoutRequiredForConformance: false,
}, null, 2)}\n`);

async function copyApplication({ name, wasm, manifest: declaredManifest = null, provenance = 'coordinated-fixture' }) {
  const wasmBytes = await readFile(wasm);
  const worker = new ApplicationWorker();
  let manifest;
  try {
    await worker.instantiate(wasmBytes);
    manifest = worker.readManifest();
  } finally {
    worker.dispose();
  }
  assert.equal(manifest.applicationName, name);
  if (declaredManifest !== null) {
    assert.deepEqual(await readFile(declaredManifest), manifest.encodedBytes,
      `${name}: supplied manifest differs from embedded manifest`);
  }
  const wasmPath = `applications/${name}.world.wasm`;
  const manifestPath = `applications/${name}.manifest.bin`;
  await mkdir(path.join(options.out, 'applications'), { recursive: true });
  await writeFile(path.join(options.out, wasmPath), wasmBytes);
  await writeFile(path.join(options.out, manifestPath), manifest.encodedBytes);
  return {
    name,
    applicationId: Buffer.from(manifest.applicationId).toString('hex'),
    applicationVersion: manifest.applicationVersion,
    wasmPath,
    wasmSha256: sha256(wasmBytes),
    manifestPath,
    manifestSha256: sha256(manifest.encodedBytes),
    provenance,
    manifest,
  };
}

async function copySelected(sourceRoot, outputRoot, relativeFiles, prefix) {
  for (const relative of relativeFiles) {
    const source = path.join(sourceRoot, relative);
    const info = await lstat(source);
    assert(info.isFile() && !info.isSymbolicLink(), `source must be a regular file: ${source}`);
    const destination = path.join(outputRoot, prefix, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

async function filesBelow(root, relativeDirectory) {
  const result = [];
  const directory = path.join(root, relativeDirectory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(relativeDirectory, entry.name);
    const info = await lstat(path.join(root, relative));
    assert(!info.isSymbolicLink(), `symlinked source rejected: ${relative}`);
    if (info.isDirectory()) result.push(...await filesBelow(root, relative));
    else if (info.isFile()) result.push(relative);
  }
  return result.sort();
}

async function prepareOutput(output) {
  const parent = path.dirname(output);
  await mkdir(parent, { recursive: true });
  try {
    const info = await lstat(output);
    assert(info.isDirectory() && !info.isSymbolicLink(), 'output must be a real directory');
    const existing = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
    assert.equal(existing.formatVersion, 'agent-runtime-v1-pack/v1', 'refusing to replace a non-pack directory');
    await rm(output, { recursive: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(output, { recursive: true });
}

async function buildWorldApplications(worldRepo, releaseMaterialization = null) {
  const args = [
    'zig',
    'build',
    'world-one-effect-application-wasm',
    'world-skeleton-agent-wasm',
    'world-fixture-agent-wasm',
    ...(options.externalApplicationRoot === null ? ['check-world-external-build-helper'] : []),
  ];
  if (releaseMaterialization !== null) {
    args.push(
      '--cache-dir', releaseMaterialization.localCache,
      '--global-cache-dir', releaseMaterialization.globalCache,
    );
  }
  const process = Bun.spawn(args, {
    cwd: worldRepo,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await process.exited;
  assert.equal(exitCode, 0, 'World application artifact build failed');
}

async function writeChecksums(root) {
  const files = (await allFiles(root)).filter((file) => file !== 'checksums.sha256');
  const lines = [];
  for (const file of files) lines.push(`${sha256(await readFile(path.join(root, file)))}  ${file}`);
  await writeFile(path.join(root, 'checksums.sha256'), `${lines.join('\n')}\n`);
}

async function allFiles(root, directory = root, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await allFiles(root, absolute, result);
    else if (entry.isFile()) result.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
  return result.sort();
}

function packReadme(manifest) {
  return `# Agent Runtime v1 ${manifest.releaseStatus} pack

This pack contains four application-specific World WASM modules, including one
clean-room Research Digest application, the minimal
World Application Host v1 profile, receiver-side Effect protocol v1 handlers,
standalone conformance, documentation, and exact SHA-256 checksums.

It requires Bun but no Boundary, World, world-host, or world-capabilities source
checkout. It contains no Boundary Module, Executable.Image, TurnClosure, or
universal World runtime.

Release status: \`${manifest.releaseStatus}\`.

\`\`\`sh
bun conformance/check-pack.mjs
bun conformance/run.mjs
bun host/bin/world-host-v1.mjs help
\`\`\`

Application and capability manifests declare requirements; they grant no
receiver authority. Configure policy, secrets, storage, and live capabilities
at the receiving host.
`;
}

function parseArgs(args) {
  const result = {
    boundaryRepo: path.resolve('../boundary'),
    boundaryReleaseArchive: null,
    worldRepo: path.resolve('../world'),
    worldReleaseArchive: null,
    worldHostRepo: path.resolve('.'),
    capabilitiesRepo: path.resolve('../world-capabilities'),
    capabilitiesRuntimeArchive: null,
    externalApplicationRoot: null,
    out: path.resolve('agent-runtime-v1'),
    releaseStatus: 'development',
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--boundary-repo') result.boundaryRepo = path.resolve(requireValue(args, ++index, '--boundary-repo'));
    else if (args[index] === '--boundary-release-archive') {
      result.boundaryReleaseArchive = path.resolve(requireValue(args, ++index, '--boundary-release-archive'));
    }
    else if (args[index] === '--world-repo') result.worldRepo = path.resolve(requireValue(args, ++index, '--world-repo'));
    else if (args[index] === '--world-release-archive') {
      result.worldReleaseArchive = path.resolve(requireValue(args, ++index, '--world-release-archive'));
    }
    else if (args[index] === '--world-host-repo') result.worldHostRepo = path.resolve(requireValue(args, ++index, '--world-host-repo'));
    else if (args[index] === '--capabilities-repo') result.capabilitiesRepo = path.resolve(requireValue(args, ++index, '--capabilities-repo'));
    else if (args[index] === '--world-capabilities-runtime-archive') {
      result.capabilitiesRuntimeArchive = path.resolve(
        requireValue(args, ++index, '--world-capabilities-runtime-archive'),
      );
    }
    else if (args[index] === '--external-application-root') {
      result.externalApplicationRoot = path.resolve(requireValue(args, ++index, '--external-application-root'));
    }
    else if (args[index] === '--world-capabilities-git-commit') {
      const commit = requireValue(args, ++index, '--world-capabilities-git-commit');
      assert.equal(commit, CAPABILITY_RELEASE.gitCommit,
        'World capabilities git commit does not match the reviewed release');
    }
    else if (args[index] === '--out') result.out = path.resolve(requireValue(args, ++index, '--out'));
    else if (args[index] === '--release-status') {
      result.releaseStatus = requireValue(args, ++index, '--release-status');
      assert(['development', 'release-candidate'].includes(result.releaseStatus), 'unsupported release status');
    } else {
      throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  return result;
}

async function materializeCapabilityRuntime(archivePath) {
  const info = await lstat(archivePath);
  assert(info.isFile() && !info.isSymbolicLink(),
    'World capabilities runtime archive must be a regular file');
  const archiveBytes = await readFile(archivePath);
  assert.equal(sha256(archiveBytes), CAPABILITY_RELEASE.runtimeAssetSha256,
    'World capabilities runtime archive checksum does not match the reviewed release');

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'world-capabilities-runtime-'));
  temporaryRoots.add(temporaryRoot);
  const extraction = Bun.spawn(['tar', '-xzf', archivePath, '-C', temporaryRoot], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const extractionError = await new Response(extraction.stderr).text();
  assert.equal(await extraction.exited, 0,
    extractionError || 'cannot extract World capabilities runtime archive');

  const entries = (await readdir(temporaryRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory());
  assert.equal(entries.length, 1,
    'World capabilities runtime archive must contain one package root');
  const packageRoot = path.join(temporaryRoot, entries[0].name);
  for (const required of [
    'package.json',
    'docs/effect_protocol_v1.md',
    'src/v1/index.mjs',
    'packages/research-lookup-fixture/manifest.json',
  ]) {
    const requiredInfo = await lstat(path.join(packageRoot, required));
    assert(requiredInfo.isFile() && !requiredInfo.isSymbolicLink(),
      `World capabilities runtime archive is missing ${required}`);
  }
  return Object.freeze({ temporaryRoot, packageRoot });
}

async function materializeWorldRelease(boundaryArchivePath, worldArchivePath) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'world-release-runtime-'));
  temporaryRoots.add(temporaryRoot);
  const globalCache = path.join(temporaryRoot, 'global-cache');
  const localCache = path.join(temporaryRoot, 'local-cache');
  const extractionRoot = path.join(temporaryRoot, 'world-source');
  await mkdir(globalCache, { recursive: true });
  await mkdir(localCache, { recursive: true });
  await mkdir(extractionRoot, { recursive: true });
  await writeFile(
    path.join(temporaryRoot, 'build.zig'),
    'const std = @import("std");\npub fn build(_: *std.Build) void {}\n',
  );

  await verifyZigReleaseArchive(
    boundaryArchivePath,
    BOUNDARY_RELEASE,
    globalCache,
    temporaryRoot,
    'Boundary',
  );
  await verifyZigReleaseArchive(
    worldArchivePath,
    WORLD_RELEASE,
    globalCache,
    temporaryRoot,
    'World',
  );
  const extraction = Bun.spawn(['tar', '-xzf', worldArchivePath, '-C', extractionRoot], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const extractionError = await new Response(extraction.stderr).text();
  assert.equal(await extraction.exited, 0,
    extractionError || 'cannot extract World release archive');
  const entries = (await readdir(extractionRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory());
  assert.equal(entries.length, 1, 'World release archive must contain one package root');
  const packageRoot = path.join(extractionRoot, entries[0].name);
  for (const required of ['build.zig', 'build.zig.zon', 'src/world.zig']) {
    const requiredInfo = await lstat(path.join(packageRoot, required));
    assert(requiredInfo.isFile() && !requiredInfo.isSymbolicLink(),
      `World release archive is missing ${required}`);
  }
  return Object.freeze({ temporaryRoot, packageRoot, globalCache, localCache });
}

async function verifyZigReleaseArchive(archivePath, release, globalCache, cwd, label) {
  const info = await lstat(archivePath);
  assert(info.isFile() && !info.isSymbolicLink(), `${label} release archive must be a regular file`);
  const fetch = Bun.spawn([
    'zig',
    'fetch',
    '--global-cache-dir',
    globalCache,
    archivePath,
  ], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, errorOutput, exitCode] = await Promise.all([
    new Response(fetch.stdout).text(),
    new Response(fetch.stderr).text(),
    fetch.exited,
  ]);
  assert.equal(exitCode, 0, errorOutput || `cannot inspect ${label} release archive`);
  assert.equal(output.trim(), release.packageHash,
    `${label} release archive package hash does not match ${release.tag}`);
}

async function verifyExternalApplicationRoot({
  externalApplicationRoot,
  sourceRoots,
}) {
  const rootInfo = await lstat(externalApplicationRoot);
  assert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(),
    'external application root must be a real directory');
  const resolvedRoot = await realpath(externalApplicationRoot);
  for (const repository of sourceRoots) {
    let resolvedRepository;
    try {
      resolvedRepository = await realpath(repository.path);
    } catch (error) {
      if (repository.optional && error?.code === 'ENOENT') continue;
      throw error;
    }
    assert(!isSameOrBelow(resolvedRepository, resolvedRoot),
      `external application root is inside a source repository: ${repository.path}`);
  }

  const artifacts = [
    ['research-digest-agent.world.wasm', EXTERNAL_APPLICATION_RELEASE.wasmSha256],
    ['research-digest-agent.manifest.bin', EXTERNAL_APPLICATION_RELEASE.manifestSha256],
  ];
  for (const [name, expectedSha256] of artifacts) {
    const artifactPath = path.join(resolvedRoot, name);
    const artifactInfo = await lstat(artifactPath);
    assert(artifactInfo.isFile() && !artifactInfo.isSymbolicLink(),
      `external application artifact must be a regular file: ${name}`);
    const resolvedArtifact = await realpath(artifactPath);
    assert(isSameOrBelow(resolvedRoot, resolvedArtifact),
      `external application artifact escapes its root: ${name}`);
    assert.equal(sha256(await readFile(resolvedArtifact)), expectedSha256,
      `external application artifact checksum does not match the reviewed clean-room proof: ${name}`);
  }
  return Object.freeze({ root: resolvedRoot, verified: true });
}

function isSameOrBelow(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function sourceCommit(repository, sourcePaths) {
  const status = Bun.spawn([
    'git',
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...sourcePaths,
  ], {
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [statusOutput, statusError, statusCode] = await Promise.all([
    new Response(status.stdout).text(),
    new Response(status.stderr).text(),
    status.exited,
  ]);
  assert.equal(statusCode, 0, statusError || `cannot inspect source state: ${repository}`);
  assert.equal(statusOutput, '', `release source changes must be committed before packing: ${repository}\n${statusOutput}`);

  const revision = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = await new Response(revision.stdout).text();
  assert.equal(await revision.exited, 0, `cannot resolve source commit: ${repository}`);
  const commit = output.trim();
  assert(/^[0-9a-f]{40}$/.test(commit), `invalid source commit: ${repository}`);
  return commit;
}

function requireValue(args, index, flag) {
  if (index >= args.length) throw new Error(`${flag} requires a value`);
  return args[index];
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
