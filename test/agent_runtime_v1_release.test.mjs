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
        /receipt corpus fingerprint mismatch/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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
