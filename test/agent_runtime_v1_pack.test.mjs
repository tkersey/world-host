import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('Agent Runtime v1 standalone pack', () => {
  it('checks an explicitly selected pack instead of the checker source pack', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-v1-explicit-pack-'));
    const stagedPack = path.join(root, 'agent-runtime-v1');
    try {
      await cp(path.resolve('agent-runtime-v1'), stagedPack, { recursive: true });
      await appendFile(path.join(stagedPack, 'README.md'), '\ntampered\n');
      const checked = spawnSync(process.execPath, [
        path.resolve('agent-runtime-v1/conformance/check-pack.mjs'),
        stagedPack,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      assert.notEqual(checked.status, 0);
      assert.match(checked.stderr, /checksum mismatch: README\.md/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
