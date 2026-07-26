#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAXIMUM_FILE_BYTES = 64 << 20;
const REVIEWED_WORLD_HOST_GIT_COMMIT = 'b66324515577323325deccf532efd85e370f51b3';
const REVIEWED_WORLD_HOST_SOURCE_SHA256 = {"host/bin/world-host-v1.mjs":"93900063f5069de8afb94c1e9e59a5ad6cba9a3dd14533f69b69b388d55e3f25","host/src/bun/application_v1_cli.mjs":"b998b46adf937d62c622c724a276e0e05f878cf8c95eb8e85e70084dd227431a","host/src/bun/application_v1_inspection_worker.mjs":"949c101c92010e3e55d2feaea30e01c64a3ff16ea6a112ad2ea882a6a18d633f","host/src/v1/application_worker.mjs":"34fa722e47e550a5405df7a6db965d999f58fb51447a9bd179de88f694e11e50","host/src/v1/directory_storage.mjs":"45b08e986ba63ac332012cdd4c8bebc60880368961f6884ba5c9a31a5754e92c","host/src/v1/effect_journal.mjs":"fc1d390229e07110940d294e844e94a6963fb2ee60cef1bac34a801fd5f58453","host/src/v1/errors.mjs":"d6bf2c3d68347ed3730f1594f652521558b5b4e43ef2333259312a7015180427","host/src/v1/index.mjs":"e033d4c61ede2b28bcaa75f60f3e9f0c5b94a02847fb1320b9cf5da25b85dc20","host/src/v1/protocol.mjs":"63d6f7e79e41b0401d4cf3740dbcb26a2173946e99533e6bf6d48f4ec2cdcabc","host/src/v1/run_controller.mjs":"9f1afbb90f9b6725abdfbf138f204eb541dd2e3b7c84199e508f17275ac0b5fb","host/src/v1/storage.mjs":"0493514c9190637868f5c57cc8e7dbb4891cba48f5106d2037fac89678bf090b","host/src/v1/wasm_module.mjs":"ca87d67c5b58c2f736de2c0af7a392ff7b11a9f830258967bc1114bcd6632d0f"};
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
  await assertReviewedWorldHostSource(root, files, manifest, options);
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
    tag: 'v1.0.0',
    packageHash: 'world-1.0.0-XXTUeF0tiAC_5jqj2oVDvgGmmh8c7CRCnuaG8p2i9Zk_',
    url: 'https://github.com/tkersey/world/archive/refs/tags/v1.0.0.tar.gz',
  });
  assert.deepEqual(manifest.sourcePins.worldCapabilitiesRelease, {
    tag: 'v1.0.0',
    gitCommit: 'bb5ed3ebd695b0343d58e5ae2ff658653ff69997',
    researchPackFingerprint: 'c3106b770e2d14237c981b4671da3d42dfbaed33eed81ccc78c257a42419354e',
    researchPackAssetSha256: '99e57ec54d8c39f305aa162e4ba334d102f358eba3ccb78469662bd676e0b6c4',
    runtimeAssetSha256: '1d9011faf1932de66ca4f7f24dcfaea41671175999bf278683bda4702854e0ca',
    researchManifestSha256: '696457f7134200bc294049bf92f7943bc89ca305038cf9a8c90d790e32bec2db',
    researchCorpusSha256: '485027cb5401bc12b84f3b9646c651214ee260881c8bc0f93ede5829efa24fc8',
    researchConformanceSha256: '51c401f45457984eba266483305ba1b7be3be9f5044ccabe573fa1544a4442e3',
    researchConformanceReceiptSha256: '8f0c70ea42a11ebfe91bb721639f53026b59babfa24b66abb0e5f7d800d7b5a3',
    capabilityManifestSha256: {
      '@tkersey/world-capabilities/fixture-model': '1b29784e303e9e54253ff701e99adf73650d8b47effb0e61559051bfd7f61645',
      '@tkersey/world-capabilities/generic-http-json': '8c83e794ad6f507f6c2cb9040b464d2e62b7880fcb047a46bf73e1e519adde3e',
      '@tkersey/world-capabilities/human-approval': '2afd6e5ad491d2c8b72be32176922186d48e151bd36c238afadd67c342a6991e',
      '@tkersey/world-capabilities/local-memory-kv': '5ba65a48e2a28c2b1b3cdcd27a433724997e915312dd5cd83560efee490106ee',
      '@tkersey/world-capabilities/research-lookup-fixture': '696457f7134200bc294049bf92f7943bc89ca305038cf9a8c90d790e32bec2db',
      '@tkersey/world-capabilities/sandbox-files': '7c087eeb01df5f8fed3dab1912a8cf14155c0dc23a88ba765c015c94bfbcb2eb',
    },
  });
  assert.deepEqual(manifest.sourcePins.externalApplicationRelease, {
    name: 'research-digest-agent',
    worldReleaseTag: 'v1.0.0',
    wasmSha256: 'c5cb0bdde50f88165fa24dfad31baa46e5719e911a4ca77d39c5e88df6f5074d',
    manifestSha256: 'fd9298888aee141948cc62477dc3bbb4ccf89d60a9ad4ac2207ed59832a67f87',
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
  assert.equal(manifest.sourcePins.worldHostPackageVersion, '1.0.0');
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
      '1bbd613ed4e9b1b6fbdaf79eec15cbff92d014ab');
    assert.equal(manifest.sourcePins.worldCapabilitiesGitCommit,
      manifest.sourcePins.worldCapabilitiesRelease.gitCommit);
    assert.equal(externalApplication.wasmSha256,
      manifest.sourcePins.externalApplicationRelease.wasmSha256);
    assert.equal(externalApplication.manifestSha256,
      manifest.sourcePins.externalApplicationRelease.manifestSha256);
  }
}

async function assertReviewedWorldHostSource(root, files, manifest, options) {
  if (manifest.releaseStatus === 'development') return;
  const expectedCommit = options.expectedWorldHostGitCommit ?? REVIEWED_WORLD_HOST_GIT_COMMIT;
  assert(/^[0-9a-f]{40}$/.test(expectedCommit),
    'release checker is not bound to a reviewed world-host source commit');
  assert.equal(
    manifest.sourcePins.worldHostGitCommit,
    expectedCommit,
    'reviewed world-host source commit mismatch',
  );
  const expectedFiles =
    options.expectedWorldHostSourceSha256 ?? REVIEWED_WORLD_HOST_SOURCE_SHA256;
  assert(expectedFiles && typeof expectedFiles === 'object' && !Array.isArray(expectedFiles),
    'release checker is not bound to reviewed world-host source files');
  const hostSourceFiles = files.filter((file) =>
    file.startsWith('host/bin/') || file.startsWith('host/src/'));
  assert.deepEqual(Object.keys(expectedFiles).sort(), hostSourceFiles,
    'reviewed world-host source file coverage mismatch');
  for (const file of hostSourceFiles) {
    assert(/^[0-9a-f]{64}$/.test(expectedFiles[file]),
      `invalid reviewed world-host source checksum: ${file}`);
    assert.equal(
      sha256(await readBytes(root, file)),
      expectedFiles[file],
      `reviewed world-host source checksum mismatch: ${file}`,
    );
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
    else if (args[index] === '--require-released') result.requiredReleaseStatus = 'released';
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
  const current = fileURLToPath(import.meta.url);
  if (path.basename(path.dirname(current)) !== 'conformance') {
    const { worldHostReleaseSourceEvidence } = await import(
      pathToFileURL(path.join(path.dirname(current), 'agent-runtime-v1-release-source.mjs')).href
    );
    Object.assign(
      options,
      await worldHostReleaseSourceEvidence(path.resolve(path.dirname(current), '..')),
    );
  }
  const receipt = await checkAgentRuntimeV1Pack(options.packPath, options);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
