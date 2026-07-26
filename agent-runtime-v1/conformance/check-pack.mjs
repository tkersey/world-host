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
  'research-digest',
  'provider-parked',
  'fresh-instance-resume',
  'deterministic-retry',
  'replay',
  'branching',
  'migration',
  'negative',
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
    'applications/research-digest-agent.world.wasm',
    'applications/research-digest-agent.manifest.bin',
    'host/bin/world-host-v1.mjs',
    'host/src/v1/index.mjs',
    'capabilities/src/v1/index.mjs',
    'capabilities/packages/research-lookup-fixture/conformance-receipt.json',
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
    const manifestPath = path.posix.join(capability.path, 'manifest.json');
    const packManifestBytes = await readBytes(root, manifestPath);
    const packManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(packManifestBytes));
    assert.equal(sha256(packManifestBytes), capability.manifestSha256,
      `${capability.packageName}: manifest identity mismatch`);
    assert.equal(packManifest.packageName, capability.packageName);
    assert.equal(packManifest.packageVersion, capability.packageVersion);
    assert.equal(packManifest.packFingerprint, capability.packFingerprint);
    assert(packManifest.supportedWorldProtocolVersions.includes('world-effect-v1'));
    assert(Array.isArray(packManifest.effectProtocolV1?.interfaces) && packManifest.effectProtocolV1.interfaces.length > 0);
    assert(Array.isArray(packManifest.artifacts) && packManifest.artifacts.length > 0);
    for (const artifact of packManifest.artifacts) {
      assert(typeof artifact.path === 'string' && !path.posix.isAbsolute(artifact.path) &&
        !artifact.path.split('/').includes('..'), `${capability.packageName}: invalid artifact path`);
      const artifactBytes = await readBytes(root, path.posix.join(capability.path, artifact.path));
      assert.equal(sha256(artifactBytes), packManifest.checksums[artifact.path],
        `${capability.packageName}: artifact checksum mismatch`);
    }
    assert.equal(packManifest.packFingerprint, expectedCapabilityPackFingerprint(packManifest),
      `${capability.packageName}: pack fingerprint mismatch`);
    if (manifest.releaseStatus !== 'development') {
      assert.equal(
        capability.manifestSha256,
        manifest.sourcePins.worldCapabilitiesRelease.capabilityManifestSha256[capability.packageName],
        `${capability.packageName}: reviewed manifest checksum mismatch`,
      );
    }
    if (capability.packageName === '@tkersey/world-capabilities/research-lookup-fixture') {
      const corpusBytes = await readBytes(root, path.posix.join(capability.path, 'corpus.json'));
      const conformanceBytes = await readBytes(
        root,
        path.posix.join(capability.path, 'conformance.json'),
      );
      const conformance = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(conformanceBytes),
      );
      const receiptBytes = await readBytes(
        root,
        path.posix.join(capability.path, 'conformance-receipt.json'),
      );
      const receipt = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes),
      );
      if (manifest.releaseStatus !== 'development') {
        const release = manifest.sourcePins.worldCapabilitiesRelease;
        assert.equal(sha256(packManifestBytes), release.researchManifestSha256,
          `${capability.packageName}: released manifest checksum mismatch`);
        assert.equal(sha256(corpusBytes), release.researchCorpusSha256,
          `${capability.packageName}: released corpus checksum mismatch`);
        assert.equal(sha256(conformanceBytes), release.researchConformanceSha256,
          `${capability.packageName}: released conformance checksum mismatch`);
        assert.equal(sha256(receiptBytes), release.researchConformanceReceiptSha256,
          `${capability.packageName}: released conformance receipt checksum mismatch`);
      }
      assert.deepEqual(Object.keys(receipt).sort(), [
        'corpusFingerprint',
        'globalConformanceCorpusFingerprint',
        'packFingerprint',
        'receiptFingerprint',
        'schema',
        'vectors',
      ]);
      assert.equal(receipt.schema, 'effect-v1-conformance-receipt/v1');
      assert.equal(receipt.packFingerprint, packManifest.packFingerprint);
      assert.equal(receipt.corpusFingerprint, sha256(corpusBytes),
        `${capability.packageName}: receipt corpus fingerprint mismatch`);
      assert.equal(receipt.corpusFingerprint, packManifest.checksums['corpus.json'],
        `${capability.packageName}: receipt is not bound to the declared corpus artifact`);
      assert.equal(
        receipt.globalConformanceCorpusFingerprint,
        packManifest.conformanceCorpusFingerprint,
        `${capability.packageName}: receipt global corpus fingerprint mismatch`,
      );
      assert.equal(conformance.driverId, packManifest.driverId);
      assert.equal(
        conformance.corpusFingerprint,
        packManifest.conformanceCorpusFingerprint,
        `${capability.packageName}: conformance corpus fingerprint mismatch`,
      );
      assert(Array.isArray(conformance.vectors) && conformance.vectors.length > 0);
      assert(conformance.vectors.every((vector) =>
        vector && typeof vector.id === 'string' && vector.id.length > 0 && vector.passed === true));
      const conformanceVectors = conformance.vectors.map((vector) => vector.id);
      assert.equal(new Set(conformanceVectors).size, conformanceVectors.length,
        `${capability.packageName}: duplicate conformance vector`);
      assert.deepEqual(receipt.vectors, conformanceVectors,
        `${capability.packageName}: receipt vectors do not match conformance`);
      const expectedReceipt = { ...receipt, receiptFingerprint: '' };
      assert.equal(
        receipt.receiptFingerprint,
        createHash('sha256')
          .update('world.effect-v1-conformance-receipt.v1')
          .update(Buffer.from([0]))
          .update(stableStringify(expectedReceipt))
          .digest('hex'),
        `${capability.packageName}: conformance receipt fingerprint mismatch`,
      );
    }
    capabilityResults.push(Object.freeze({
      packageName: capability.packageName,
      packageVersion: capability.packageVersion,
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
  assert(Array.isArray(manifest.applications) && manifest.applications.length === 4);
  assert.deepEqual(manifest.applications.map((value) => value.name).sort(), [
    'fixture-agent',
    'one-effect',
    'research-digest-agent',
    'skeleton-agent',
  ]);
  for (const application of manifest.applications) {
    assert(typeof application.name === 'string' && application.name.length > 0);
    assert(/^[0-9a-f]{64}$/.test(application.applicationId));
    assert(/^[0-9a-f]{64}$/.test(application.wasmSha256));
    assert(/^[0-9a-f]{64}$/.test(application.manifestSha256));
    assert(application.wasmPath === `applications/${application.name}.world.wasm`);
    assert(application.manifestPath === `applications/${application.name}.manifest.bin`);
    assert(['coordinated-fixture', 'development-helper', 'external-clean-room'].includes(application.provenance));
  }
  const externalApplication = manifest.applications.find((value) => value.name === 'research-digest-agent');
  assert(externalApplication);
  assert(Array.isArray(manifest.capabilities) && manifest.capabilities.length >= 2);
  assert(manifest.capabilities.every((value) => typeof value.packageName === 'string' &&
    typeof value.packageVersion === 'string' && typeof value.path === 'string' &&
    /^[0-9a-f]{64}$/.test(value.packFingerprint) &&
    /^[0-9a-f]{64}$/.test(value.manifestSha256)));
  assert(manifest.conformance?.entrypoint === 'conformance/run.mjs');
  assert(Array.isArray(manifest.conformance.scenarios));
  assert(Array.isArray(manifest.nonClaims) && manifest.nonClaims.includes('no exactly-once effects'));
  assert(manifest.sourcePins && typeof manifest.sourcePins === 'object');
  assert.deepEqual(manifest.sourcePins.boundaryRelease, {
    tag: 'v0.7.0',
    packageHash: 'boundary-0.7.0-flclaCnjkABOSWaiSkxMBDQZsBEeA-Niai-l1u0q3A7_',
    url: 'https://github.com/tkersey/boundary/archive/refs/tags/v0.7.0.tar.gz',
  });
  assert.deepEqual(manifest.sourcePins.worldRelease, {
    tag: 'v1.0.0-rc.2',
    packageHash: 'world-1.0.0-rc.2-XXTUeOXYhwC1anDePj7Lr4SfwDCxG-ofPw92_-PGGyKv',
    url: 'https://github.com/tkersey/world/archive/refs/tags/v1.0.0-rc.2.tar.gz',
  });
  assert.deepEqual(manifest.sourcePins.worldCapabilitiesRelease, {
    tag: 'v1.0.0-rc.4',
    gitCommit: '45d023f2bd0658e377142eda9b5103589308870c',
    researchPackFingerprint: 'ff4cecaf449db1bf2032dd22e1b0dcca94c02091ba547719fe36089dd61c205e',
    researchPackAssetSha256: '96ea017436264f7574e1dd8e385df3acb0cde97babd855ca3b98ee43d56f4d1f',
    runtimeAssetSha256: 'b6b87dc78e90d5ba626f20489016bab4c0f3ff39ae1e9ce77c2ab76ed1150cfc',
    researchManifestSha256: 'd4dd78c9e33094c7a1b68f58503f57418dd82148274272a5ec0dd645280c6787',
    researchCorpusSha256: '93b00d2b93f035f03bf8ed645a4fc82a60029d2e7f34a05ef0accf315c8944a5',
    researchConformanceSha256: '51c401f45457984eba266483305ba1b7be3be9f5044ccabe573fa1544a4442e3',
    researchConformanceReceiptSha256: 'e7f067d21c38643ea436e1e4b22794b616f8ce69974048a881a537ad9e0e3eea',
    capabilityManifestSha256: {
      '@tkersey/world-capabilities/fixture-model': '1b29784e303e9e54253ff701e99adf73650d8b47effb0e61559051bfd7f61645',
      '@tkersey/world-capabilities/generic-http-json': '8c83e794ad6f507f6c2cb9040b464d2e62b7880fcb047a46bf73e1e519adde3e',
      '@tkersey/world-capabilities/human-approval': '2afd6e5ad491d2c8b72be32176922186d48e151bd36c238afadd67c342a6991e',
      '@tkersey/world-capabilities/local-memory-kv': '5ba65a48e2a28c2b1b3cdcd27a433724997e915312dd5cd83560efee490106ee',
      '@tkersey/world-capabilities/research-lookup-fixture': 'd4dd78c9e33094c7a1b68f58503f57418dd82148274272a5ec0dd645280c6787',
      '@tkersey/world-capabilities/sandbox-files': '7c087eeb01df5f8fed3dab1912a8cf14155c0dc23a88ba765c015c94bfbcb2eb',
    },
  });
  assert.deepEqual(manifest.sourcePins.externalApplicationRelease, {
    name: 'research-digest-agent',
    worldReleaseTag: 'v1.0.0-rc.2',
    wasmSha256: 'ced222d3537ca9b36165278190baef8b7ef79b091876d685a1dc24d5a926caca',
    manifestSha256: 'e48349346439a8b16040d9f98d90b8ab1e559e56be9a18ca10f7d4a1f1e32c4c',
  });
  const researchCapabilities = manifest.capabilities.filter((capability) =>
    capability.packageName === '@tkersey/world-capabilities/research-lookup-fixture');
  assert.equal(researchCapabilities.length, 1,
    'pack must contain exactly one research-lookup-fixture capability');
  if (manifest.releaseStatus !== 'development') {
    assert.equal(researchCapabilities[0].packFingerprint,
      manifest.sourcePins.worldCapabilitiesRelease.researchPackFingerprint,
      'research-lookup-fixture does not match the reviewed release fingerprint');
  }
  assert.equal(manifest.sourcePins.worldHostPackageVersion, '1.0.0-rc.2');
  assert.deepEqual(manifest.externality, {
    application: 'research-digest-agent',
    authoredOutsideSourceRepositories: manifest.releaseStatus === 'development'
      ? manifest.externality.authoredOutsideSourceRepositories
      : true,
    sourceCheckoutRequiredForConformance: false,
    capabilitySpecificHostLogic: false,
    hostAuthoredFrame: false,
  });
  if (manifest.externality.authoredOutsideSourceRepositories) {
    assert.equal(externalApplication.provenance, 'external-clean-room');
  }
  if (manifest.releaseStatus !== 'development') {
    assert.equal(manifest.sourcePins.boundaryGitCommit,
      '7f2472100454aa2cd5c62e07db0c1e23eaf46a77');
    assert.equal(manifest.sourcePins.worldGitCommit,
      'a79265906bdf75d432b8f5286159598ef2282da0');
    assert(/^[0-9a-f]{40}$/.test(manifest.sourcePins.worldHostGitCommit),
      'invalid source pin: worldHostGitCommit');
    assert.equal(manifest.sourcePins.worldCapabilitiesGitCommit,
      manifest.sourcePins.worldCapabilitiesRelease.gitCommit);
    assert.equal(externalApplication.wasmSha256,
      manifest.sourcePins.externalApplicationRelease.wasmSha256);
    assert.equal(externalApplication.manifestSha256,
      manifest.sourcePins.externalApplicationRelease.manifestSha256);
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

function expectedCapabilityPackFingerprint(manifest) {
  const material = {
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    driverId: manifest.driverId,
    driverAbiVersion: manifest.driverAbiVersion,
    conformanceCorpusFingerprint: manifest.conformanceCorpusFingerprint,
    artifacts: manifest.artifacts,
    checksums: manifest.checksums,
    ...(manifest.supportedWorldProtocolVersions?.includes('world-effect-v1')
      ? {
          supportedWorldProtocolVersions: manifest.supportedWorldProtocolVersions,
          effectProtocolV1: manifest.effectProtocolV1,
        }
      : {}),
  };
  return createHash('sha256').update(stableStringify(material)).digest('hex');
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value), null, 2);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
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
