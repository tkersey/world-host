import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { checkAgentRuntimeV1Pack } from '../scripts/check-agent-runtime-v1-pack.mjs';

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

  it('rejects untracked files from release-candidate source paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-v1-untracked-'));
    const untracked = path.resolve('src/v1/untracked-release-source.mjs');
    try {
      await writeFile(untracked, 'export const untrackedReleaseSource = true;\n');
      const built = spawnSync(process.execPath, [
        path.resolve('scripts/build-agent-runtime-v1.mjs'),
        '--release-status', 'release-candidate',
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
        'a79265906bdf75d432b8f5286159598ef2282da0';
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
        () => checkAgentRuntimeV1Pack(pack),
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
        'a79265906bdf75d432b8f5286159598ef2282da0';
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
        () => checkAgentRuntimeV1Pack(pack),
        /released manifest checksum mismatch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function reviewedCapabilityFiles() {
  return {
    researchManifestSha256:
      '93615f2d1cfaa1150ce197f28ce11bf1bbaffc18f4617472897be788abfde35c',
    researchCorpusSha256:
      '93b00d2b93f035f03bf8ed645a4fc82a60029d2e7f34a05ef0accf315c8944a5',
    researchConformanceSha256:
      '51c401f45457984eba266483305ba1b7be3be9f5044ccabe573fa1544a4442e3',
    researchConformanceReceiptSha256:
      'ee082050534f58cc70d65677e001085e1f8a10e0bf96aa4d7894dad050b229ca',
  };
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
