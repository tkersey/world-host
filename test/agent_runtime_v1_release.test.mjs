import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { resolveWorldHostReleaseSourceCommit } from
  '../scripts/agent-runtime-v1-release-source.mjs';

describe('Agent Runtime v1 pack release identities', () => {
  it('builds and validates development packs without a Boundary checkout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-v1-development-'));
    const pack = path.join(root, 'agent-runtime-v1');
    try {
      const built = spawnSync(process.execPath, [
        path.resolve('scripts/build-agent-runtime-v1.mjs'),
        '--boundary-repo', path.join(root, 'missing-boundary'),
        '--out', pack,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      assert.equal(built.status, 0, built.stderr);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      assert.equal(manifest.releaseStatus, 'development');
      assert.equal(Object.prototype.hasOwnProperty.call(manifest.sourcePins, 'boundaryGitCommit'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(manifest.sourcePins, 'worldGitCommit'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects untracked files from released source paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-v1-untracked-'));
    const untracked = path.resolve('src/v1/untracked-release-source.mjs');
    try {
      await writeFile(untracked, 'export const untrackedReleaseSource = true;\n');
      const built = spawnSync(process.execPath, [
        path.resolve('scripts/build-agent-runtime-v1.mjs'),
        '--release-status', 'released',
        '--external-application-root', root,
        '--world-capabilities-runtime-archive', path.join(root, 'capabilities.tar.gz'),
        '--boundary-release-archive', path.join(root, 'boundary.tar.gz'),
        '--world-release-archive', path.join(root, 'world.tar.gz'),
        '--out', path.join(root, 'agent-runtime-v1'),
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      assert.notEqual(built.status, 0);
      assert.match(built.stderr, /release source changes must be committed before packing/);
      assert.match(built.stderr, /untracked-release-source\.mjs/);
    } finally {
      await rm(untracked, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps packaging-only commits outside executable source identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-v1-source-identity-'));
    try {
      await mkdir(path.join(root, 'src/v1'), { recursive: true });
      await mkdir(path.join(root, 'scripts'), { recursive: true });
      await writeFile(path.join(root, 'src/v1/index.mjs'), 'export const runtime = true;\n');
      await writeFile(path.join(root, 'scripts/build-agent-runtime-v1.mjs'), 'export const pack = 1;\n');
      git(root, ['init']);
      git(root, ['config', 'user.email', 'world-host-test@example.invalid']);
      git(root, ['config', 'user.name', 'world-host test']);
      git(root, ['add', '.']);
      git(root, ['commit', '-m', 'Add runtime']);
      const runtimeCommit = git(root, ['rev-parse', 'HEAD']).stdout.trim();

      await writeFile(path.join(root, 'scripts/build-agent-runtime-v1.mjs'), 'export const pack = 2;\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-m', 'Change packaging']);

      assert.equal(await resolveWorldHostReleaseSourceCommit(root), runtimeCommit);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a self-consistent receipt for the wrong capability corpus', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-v1-receipt-'));
    const pack = path.join(root, 'agent-runtime-v1');
    try {
      await cp(path.resolve('agent-runtime-v1'), pack, { recursive: true });
      const manifestPath = path.join(pack, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.sourcePins.boundaryGitCommit =
        '7f2472100454aa2cd5c62e07db0c1e23eaf46a77';
      manifest.sourcePins.worldGitCommit =
        '1bbd613ed4e9b1b6fbdaf79eec15cbff92d014ab';
      Object.assign(manifest.sourcePins.worldCapabilitiesRelease, reviewedCapabilityFiles());
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await rewriteOuterChecksum(pack, 'manifest.json');
      const receiptPath = path.join(
        pack,
        'capabilities/packages/research-lookup-fixture/conformance-receipt.json',
      );
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      receipt.corpusFingerprint = '0'.repeat(64);
      receipt.receiptFingerprint = receiptFingerprint(receipt);
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      await rewriteOuterChecksum(pack,
        'capabilities/packages/research-lookup-fixture/conformance-receipt.json');

      await assert.rejects(
        () => checkPack(pack),
        /released conformance receipt checksum mismatch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects altered release capability policy outside the pack fingerprint', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-v1-policy-'));
    const pack = path.join(root, 'agent-runtime-v1');
    try {
      await cp(path.resolve('agent-runtime-v1'), pack, { recursive: true });
      const outerManifestPath = path.join(pack, 'manifest.json');
      const outerManifest = JSON.parse(await readFile(outerManifestPath, 'utf8'));
      outerManifest.sourcePins.boundaryGitCommit =
        '7f2472100454aa2cd5c62e07db0c1e23eaf46a77';
      outerManifest.sourcePins.worldGitCommit =
        '1bbd613ed4e9b1b6fbdaf79eec15cbff92d014ab';
      Object.assign(outerManifest.sourcePins.worldCapabilitiesRelease, reviewedCapabilityFiles());
      await writeFile(outerManifestPath, `${JSON.stringify(outerManifest, null, 2)}\n`);
      await rewriteOuterChecksum(pack, 'manifest.json');

      const relative =
        'capabilities/packages/research-lookup-fixture/manifest.json';
      const capabilityManifestPath = path.join(pack, relative);
      const capabilityManifest = JSON.parse(await readFile(capabilityManifestPath, 'utf8'));
      capabilityManifest.authorityLabels = ['research.fixture', 'altered.authority'];
      await writeFile(capabilityManifestPath, `${JSON.stringify(capabilityManifest, null, 2)}\n`);
      await rewriteOuterChecksum(pack, relative);

      await assert.rejects(
        () => checkPack(pack),
        /manifest identity mismatch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a self-consistent unreviewed manifest for any bundled capability', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-v1-capability-manifest-'));
    const pack = path.join(root, 'agent-runtime-v1');
    try {
      await cp(path.resolve('agent-runtime-v1'), pack, { recursive: true });
      const outerManifestPath = path.join(pack, 'manifest.json');
      const outerManifest = JSON.parse(await readFile(outerManifestPath, 'utf8'));
      Object.assign(outerManifest.sourcePins.worldCapabilitiesRelease, reviewedCapabilityFiles());
      const capability = outerManifest.capabilities.find((candidate) =>
        candidate.packageName === '@tkersey/world-capabilities/generic-http-json');
      assert(capability);
      const relative = 'capabilities/packages/generic-http-json/manifest.json';
      const capabilityManifestPath = path.join(pack, relative);
      const capabilityManifest = JSON.parse(await readFile(capabilityManifestPath, 'utf8'));
      capabilityManifest.authorityLabels = [...capabilityManifest.authorityLabels, 'altered.authority'];
      const capabilityManifestBytes = Buffer.from(`${JSON.stringify(capabilityManifest, null, 2)}\n`);
      await writeFile(capabilityManifestPath, capabilityManifestBytes);
      capability.manifestSha256 = sha256(capabilityManifestBytes);
      await writeFile(outerManifestPath, `${JSON.stringify(outerManifest, null, 2)}\n`);
      await rewriteOuterChecksum(pack, relative);
      await rewriteOuterChecksum(pack, 'manifest.json');

      await assert.rejects(
        () => checkPack(pack),
        /reviewed manifest checksum mismatch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a self-consistent unreviewed world-host source commit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-v1-host-source-'));
    const pack = path.join(root, 'agent-runtime-v1');
    try {
      await cp(path.resolve('agent-runtime-v1'), pack, { recursive: true });
      const manifestPath = path.join(pack, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.sourcePins.worldHostGitCommit = '0'.repeat(40);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await rewriteOuterChecksum(pack, 'manifest.json');

      await assert.rejects(
        () => checkPack(pack),
        /reviewed world-host source commit mismatch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function checkPack(pack) {
  const checker = await import(
    pathToFileURL(path.join(pack, 'conformance/check-pack.mjs')).href
  );
  return checker.checkAgentRuntimeV1Pack(pack);
}

function reviewedCapabilityFiles() {
  return {
    researchManifestSha256:
      '696457f7134200bc294049bf92f7943bc89ca305038cf9a8c90d790e32bec2db',
    researchCorpusSha256:
      '485027cb5401bc12b84f3b9646c651214ee260881c8bc0f93ede5829efa24fc8',
    researchConformanceSha256:
      '51c401f45457984eba266483305ba1b7be3be9f5044ccabe573fa1544a4442e3',
    researchConformanceReceiptSha256:
      '8f0c70ea42a11ebfe91bb721639f53026b59babfa24b66abb0e5f7d800d7b5a3',
    capabilityManifestSha256: {
      '@tkersey/world-capabilities/fixture-model':
        '1b29784e303e9e54253ff701e99adf73650d8b47effb0e61559051bfd7f61645',
      '@tkersey/world-capabilities/generic-http-json':
        '8c83e794ad6f507f6c2cb9040b464d2e62b7880fcb047a46bf73e1e519adde3e',
      '@tkersey/world-capabilities/human-approval':
        '2afd6e5ad491d2c8b72be32176922186d48e151bd36c238afadd67c342a6991e',
      '@tkersey/world-capabilities/local-memory-kv':
        '5ba65a48e2a28c2b1b3cdcd27a433724997e915312dd5cd83560efee490106ee',
      '@tkersey/world-capabilities/research-lookup-fixture':
        '696457f7134200bc294049bf92f7943bc89ca305038cf9a8c90d790e32bec2db',
      '@tkersey/world-capabilities/sandbox-files':
        '7c087eeb01df5f8fed3dab1912a8cf14155c0dc23a88ba765c015c94bfbcb2eb',
    },
  };
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function receiptFingerprint(receipt) {
  return createHash('sha256')
    .update('world.effect-v1-conformance-receipt.v1')
    .update(Buffer.from([0]))
    .update(stableStringify({ ...receipt, receiptFingerprint: '' }))
    .digest('hex');
}

async function rewriteOuterChecksum(pack, relative) {
  const checksumPath = path.join(pack, 'checksums.sha256');
  const replacement = sha256(await readFile(path.join(pack, relative)));
  const lines = (await readFile(checksumPath, 'utf8')).trimEnd().split('\n');
  const index = lines.findIndex((line) => line.endsWith(`  ${relative}`));
  assert.notEqual(index, -1);
  lines[index] = `${replacement}  ${relative}`;
  await writeFile(checksumPath, `${lines.join('\n')}\n`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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
