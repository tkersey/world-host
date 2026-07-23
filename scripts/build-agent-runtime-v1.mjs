#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ApplicationWorker } from '../src/v1/index.mjs';
import { checkAgentRuntimeV1Pack } from './check-agent-runtime-v1-pack.mjs';

const options = parseArgs(process.argv.slice(2));
const sourceCommits = options.releaseStatus === 'development'
  ? {}
  : Object.fromEntries(await Promise.all([
      ['boundaryGitCommit', sourceCommit(options.boundaryRepo, ['build.zig', 'build.zig.zon', 'src'])],
      ['worldGitCommit', sourceCommit(options.worldRepo, ['build.zig', 'build.zig.zon', 'src', 'examples'])],
      ['worldHostGitCommit', sourceCommit(options.worldHostRepo, [
        'bin/world-host-v1.mjs',
        'docs',
        'scripts/build-agent-runtime-v1.mjs',
        'scripts/check-agent-runtime-v1-pack.mjs',
        'scripts/run-agent-runtime-v1-conformance.mjs',
        'src/bun/application_v1_cli.mjs',
        'src/v1',
      ])],
      ['worldCapabilitiesGitCommit', sourceCommit(options.capabilitiesRepo, ['docs', 'packages', 'src/v1'])],
    ].map(async ([name, promise]) => [name, await promise])));
await buildWorldApplications(options.worldRepo);
await prepareOutput(options.out);

const applications = [];
for (const source of [
  { name: 'one-effect', wasm: path.join(options.worldRepo, 'zig-out/bin/one-effect.world.wasm') },
  { name: 'skeleton-agent', wasm: path.join(options.worldRepo, 'zig-out/world-apps/skeleton-agent.world.wasm') },
  { name: 'fixture-agent', wasm: path.join(options.worldRepo, 'zig-out/world-apps/fixture-agent.world.wasm') },
]) {
  applications.push(await copyApplication(source));
}

await copySelected(options.worldHostRepo, options.out, [
  'bin/world-host-v1.mjs',
  'src/bun/application_v1_cli.mjs',
  ...await filesBelow(options.worldHostRepo, 'src/v1'),
], 'host');
await writeFile(path.join(options.out, 'host/package.json'), `${JSON.stringify({
  name: '@tkersey/world-host-v1-runtime',
  version: '1.0.0-rc.1',
  private: true,
  type: 'module',
  dependencies: {},
}, null, 2)}\n`);

const capabilityPackages = [
  'fixture-model',
  'generic-http-json',
  'human-approval',
  'local-memory-kv',
  'sandbox-files',
];
await copySelected(options.capabilitiesRepo, options.out, [
  ...await filesBelow(options.capabilitiesRepo, 'src/v1'),
  ...(
    await Promise.all(capabilityPackages.map((name) => filesBelow(options.capabilitiesRepo, `packages/${name}`)))
  ).flat(),
], 'capabilities');
await writeFile(path.join(options.out, 'capabilities/package.json'), `${JSON.stringify({
  name: '@tkersey/world-capabilities-v1-runtime',
  version: '1.0.0-rc.1',
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
await copySelected(path.join(options.capabilitiesRepo, 'docs'), options.out, [
  'effect_protocol_v1.md',
  'agent_invoke_v1.md',
  'v0_v1_adapter.md',
], 'docs/world-capabilities');

await mkdir(path.join(options.out, 'conformance'), { recursive: true });
await copyFile(path.join(options.worldHostRepo, 'scripts/check-agent-runtime-v1-pack.mjs'), path.join(options.out, 'conformance/check-pack.mjs'));
await copyFile(path.join(options.worldHostRepo, 'scripts/run-agent-runtime-v1-conformance.mjs'), path.join(options.out, 'conformance/run.mjs'));

const capabilities = [];
for (const name of capabilityPackages) {
  const manifest = JSON.parse(await readFile(path.join(options.capabilitiesRepo, `packages/${name}/manifest.json`), 'utf8'));
  capabilities.push({
    packageName: manifest.packageName,
    path: `capabilities/packages/${name}`,
    packFingerprint: manifest.packFingerprint,
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
      'provider-parked',
      'retry',
      'branching',
    ],
  },
  sourcePins: {
    boundaryPackageVersion: reference.boundaryPackageVersion,
    boundaryStaticMachineAbiVersion: reference.boundaryStaticMachineAbiVersion,
    worldPackageVersion: reference.worldPackageVersion,
    worldApplicationAbiVersion: reference.worldApplicationAbiVersion,
    artifactIdentity: 'sha256',
    ...sourceCommits,
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

const receipt = await checkAgentRuntimeV1Pack(options.out);
process.stdout.write(`${JSON.stringify({
  command: 'build-agent-runtime-v1',
  output: options.out,
  releaseStatus: options.releaseStatus,
  applicationCount: receipt.applications.length,
  capabilityCount: receipt.capabilities.length,
  checksumCount: receipt.checksumCount,
  sourceCheckoutRequiredForConformance: false,
}, null, 2)}\n`);

async function copyApplication({ name, wasm }) {
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

async function buildWorldApplications(worldRepo) {
  const process = Bun.spawn([
    'zig',
    'build',
    'world-one-effect-application-wasm',
    'world-skeleton-agent-wasm',
    'world-fixture-agent-wasm',
  ], {
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

This pack contains three application-specific World WASM modules, the minimal
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
    worldRepo: path.resolve('../world'),
    worldHostRepo: path.resolve('.'),
    capabilitiesRepo: path.resolve('../world-capabilities'),
    out: path.resolve('agent-runtime-v1'),
    releaseStatus: 'development',
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--boundary-repo') result.boundaryRepo = path.resolve(requireValue(args, ++index, '--boundary-repo'));
    else if (args[index] === '--world-repo') result.worldRepo = path.resolve(requireValue(args, ++index, '--world-repo'));
    else if (args[index] === '--world-host-repo') result.worldHostRepo = path.resolve(requireValue(args, ++index, '--world-host-repo'));
    else if (args[index] === '--capabilities-repo') result.capabilitiesRepo = path.resolve(requireValue(args, ++index, '--capabilities-repo'));
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
