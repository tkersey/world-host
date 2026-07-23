#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAXIMUM_FILE_BYTES = 64 << 20;
const REQUIRED_SCENARIOS = [
  'one-effect',
  'skeleton-agent',
  'fixture-agent',
  'provider-parked',
  'retry',
  'branching',
];
const FORBIDDEN_RUNTIME_PATHS = [
  /boundary-module/i,
  /executable-image/i,
  /turn-closure/i,
  /world[_-]universal/i,
];

export async function checkAgentRuntimeV1Pack(packPath, options = {}) {
  const root = await safeRoot(packPath);
  const files = await listFiles(root);
  const required = [
    'manifest.json',
    'checksums.sha256',
    'applications/one-effect.world.wasm',
    'applications/one-effect.manifest.bin',
    'applications/skeleton-agent.world.wasm',
    'applications/skeleton-agent.manifest.bin',
    'applications/fixture-agent.world.wasm',
    'applications/fixture-agent.manifest.bin',
    'host/bin/world-host-v1.mjs',
    'host/src/v1/index.mjs',
    'capabilities/src/v1/index.mjs',
    'conformance/check-pack.mjs',
    'conformance/run.mjs',
    'README.md',
  ];
  for (const file of required) assert(files.includes(file), `missing pack file: ${file}`);
  for (const file of files) {
    assert(!FORBIDDEN_RUNTIME_PATHS.some((pattern) => pattern.test(file)), `forbidden v0 runtime artifact: ${file}`);
  }

  const declaredChecksums = parseChecksums(await readText(root, 'checksums.sha256'));
  const coveredFiles = files.filter((file) => file !== 'checksums.sha256');
  assert.deepEqual([...declaredChecksums.keys()].sort(), coveredFiles, 'checksum coverage mismatch');
  for (const file of coveredFiles) {
    const bytes = await readBytes(root, file);
    assert.equal(sha256(bytes), declaredChecksums.get(file), `checksum mismatch: ${file}`);
  }

  const manifest = JSON.parse(await readText(root, 'manifest.json'));
  assertPackManifest(manifest);
  if (options.requiredReleaseStatus !== undefined) {
    assert.equal(manifest.releaseStatus, options.requiredReleaseStatus, 'release status mismatch');
  }
  assert.deepEqual([...manifest.conformance.scenarios].sort(), [...REQUIRED_SCENARIOS].sort());

  const host = await importFresh(path.join(root, 'host', 'src', 'v1', 'index.mjs'));
  const applicationResults = [];
  for (const application of manifest.applications) {
    const wasmBytes = await readBytes(root, application.wasmPath);
    const manifestBytes = await readBytes(root, application.manifestPath);
    assert.equal(sha256(wasmBytes), application.wasmSha256, `${application.name}: WASM identity`);
    assert.equal(sha256(manifestBytes), application.manifestSha256, `${application.name}: manifest identity`);
    const worker = new host.ApplicationWorker();
    try {
      const runtime = await worker.instantiate(wasmBytes);
      const embedded = worker.readManifest();
      assert.deepEqual(embedded.encodedBytes, manifestBytes, `${application.name}: embedded manifest mismatch`);
      assert.equal(Buffer.from(embedded.applicationId).toString('hex'), application.applicationId);
      assert.equal(embedded.applicationName, application.name);
      assert.equal(runtime.importCount, 0);
      applicationResults.push(Object.freeze({
        name: application.name,
        applicationId: application.applicationId,
        wasmSha256: application.wasmSha256,
        wasmBytes: wasmBytes.length,
        initialMemoryBytes: runtime.initialMemoryBytes,
        maximumMemoryBytes: runtime.maximumMemoryBytes,
      }));
    } finally {
      worker.dispose();
    }
  }

  const capabilityResults = [];
  for (const capability of manifest.capabilities) {
    const packManifest = JSON.parse(await readText(root, path.posix.join(capability.path, 'manifest.json')));
    assert.equal(packManifest.packageName, capability.packageName);
    assert.equal(packManifest.packFingerprint, capability.packFingerprint);
    assert(packManifest.supportedWorldProtocolVersions.includes('world-effect-v1'));
    assert(Array.isArray(packManifest.effectProtocolV1?.interfaces) && packManifest.effectProtocolV1.interfaces.length > 0);
    capabilityResults.push(Object.freeze({
      packageName: capability.packageName,
      packFingerprint: capability.packFingerprint,
      interfaceCount: packManifest.effectProtocolV1.interfaces.length,
      adapterExecuted: false,
    }));
  }

  return Object.freeze({
    receiptVersion: 'agent-runtime-v1-pack-check/v1',
    packFormatVersion: manifest.formatVersion,
    releaseStatus: manifest.releaseStatus,
    applicationAbiVersion: manifest.protocols.applicationAbiVersion,
    frameFormatVersion: manifest.protocols.frameFormatVersion,
    effectProtocolVersion: manifest.protocols.effectProtocolVersion,
    applications: applicationResults,
    capabilities: capabilityResults,
    checksumCount: declaredChecksums.size,
    sourceCheckoutRequired: false,
    v0RuntimeArtifactPresent: false,
  });
}

function assertPackManifest(manifest) {
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest));
  assert.equal(manifest.formatVersion, 'agent-runtime-v1-pack/v1');
  assert(['development', 'release-candidate', 'released'].includes(manifest.releaseStatus));
  assert.deepEqual(manifest.protocols, {
    applicationAbiVersion: 1,
    frameFormatVersion: 1,
    effectProtocolVersion: 'world-effect-v1',
  });
  assert.deepEqual(manifest.host, {
    entrypoint: 'host/bin/world-host-v1.mjs',
    profile: 'application-v1',
    runtimeDependencies: 0,
  });
  assert(Array.isArray(manifest.applications) && manifest.applications.length === 3);
  assert.deepEqual(manifest.applications.map((value) => value.name).sort(), ['fixture-agent', 'one-effect', 'skeleton-agent']);
  for (const application of manifest.applications) {
    assert(typeof application.name === 'string' && application.name.length > 0);
    assert(/^[0-9a-f]{64}$/.test(application.applicationId));
    assert(/^[0-9a-f]{64}$/.test(application.wasmSha256));
    assert(/^[0-9a-f]{64}$/.test(application.manifestSha256));
    assert(application.wasmPath === `applications/${application.name}.world.wasm`);
    assert(application.manifestPath === `applications/${application.name}.manifest.bin`);
  }
  assert(Array.isArray(manifest.capabilities) && manifest.capabilities.length >= 2);
  assert(manifest.capabilities.every((value) => typeof value.packageName === 'string' &&
    typeof value.path === 'string' && /^[0-9a-f]{64}$/.test(value.packFingerprint)));
  assert(manifest.conformance?.entrypoint === 'conformance/run.mjs');
  assert(Array.isArray(manifest.conformance.scenarios));
  assert(Array.isArray(manifest.nonClaims) && manifest.nonClaims.includes('no exactly-once effects'));
  assert(manifest.sourcePins && typeof manifest.sourcePins === 'object');
  if (manifest.releaseStatus !== 'development') {
    for (const field of [
      'boundaryGitCommit',
      'worldGitCommit',
      'worldHostGitCommit',
      'worldCapabilitiesGitCommit',
    ]) {
      assert(/^[0-9a-f]{40}$/.test(manifest.sourcePins[field]), `invalid source pin: ${field}`);
    }
  }
}

async function safeRoot(packPath) {
  assert(typeof packPath === 'string' && packPath.length > 0, 'pack path is required');
  const info = await lstat(packPath);
  assert(!info.isSymbolicLink() && info.isDirectory(), 'pack root must be a real directory');
  return await realpath(packPath);
}

async function listFiles(root, directory = root, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const info = await lstat(absolute);
    assert(!info.isSymbolicLink(), `symlink rejected: ${relative}`);
    if (info.isDirectory()) await listFiles(root, absolute, result);
    else if (info.isFile()) {
      assert(info.size <= MAXIMUM_FILE_BYTES, `oversized pack file: ${relative}`);
      result.push(relative);
    } else {
      assert.fail(`unsupported pack entry: ${relative}`);
    }
  }
  return result.sort();
}

function parseChecksums(text) {
  const result = new Map();
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const match = /^([0-9a-f]{64})  ([^\0\r\n]+)$/.exec(line);
    assert(match, `invalid checksum line: ${line}`);
    assert(!result.has(match[2]), `duplicate checksum path: ${match[2]}`);
    result.set(match[2], match[1]);
  }
  return result;
}

async function readBytes(root, relative) {
  const absolute = path.resolve(root, relative);
  const actual = await realpath(absolute);
  assert(pathInside(root, actual), `pack path escapes root: ${relative}`);
  const info = await lstat(actual);
  assert(info.isFile() && !info.isSymbolicLink(), `pack path is not a regular file: ${relative}`);
  assert(info.size <= MAXIMUM_FILE_BYTES, `oversized pack file: ${relative}`);
  return await readFile(actual);
}

async function readText(root, relative) {
  return new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(root, relative));
}

async function importFresh(file) {
  const url = pathToFileURL(file);
  url.searchParams.set('check', `${Date.now()}-${Math.random()}`);
  return await import(url.href);
}

function pathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function commandOptions() {
  const current = fileURLToPath(import.meta.url);
  const embedded = path.basename(path.dirname(current)) === 'conformance';
  const args = process.argv.slice(2);
  const result = {
    packPath: embedded ? path.resolve(path.dirname(current), '..') : path.resolve('agent-runtime-v1'),
    requiredReleaseStatus: undefined,
  };
  let packPathProvided = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--require-release-candidate') result.requiredReleaseStatus = 'release-candidate';
    else if (!args[index].startsWith('-') && !packPathProvided) {
      result.packPath = path.resolve(args[index]);
      packPathProvided = true;
    } else {
      throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  return result;
}

if (import.meta.main) {
  const options = commandOptions();
  const receipt = await checkAgentRuntimeV1Pack(options.packPath, options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
