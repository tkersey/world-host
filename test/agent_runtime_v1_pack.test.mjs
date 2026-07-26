import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

  it('validates a selected pack before importing its checker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-v1-untrusted-checker-'));
    const stagedPack = path.join(root, 'agent-runtime-v1');
    const marker = path.join(root, 'checker-executed');
    try {
      await cp(path.resolve('agent-runtime-v1'), stagedPack, { recursive: true });
      await appendFile(
        path.join(stagedPack, 'conformance/check-pack.mjs'),
        `\nawait Bun.write(${JSON.stringify(marker)}, 'executed');\n`,
      );
      const checked = spawnSync(process.execPath, [
        path.resolve('scripts/run-agent-runtime-v1-conformance.mjs'),
        stagedPack,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      assert.notEqual(checked.status, 0);
      assert.match(checked.stderr, /checksum mismatch: conformance\/check-pack\.mjs/);
      assert.equal(existsSync(marker), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
