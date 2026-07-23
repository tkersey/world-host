import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

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
});
