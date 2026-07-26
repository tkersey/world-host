import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
      await rewriteOuterChecksum(stagedPack, 'conformance/check-pack.mjs');
      const checked = spawnSync(process.execPath, [
        path.resolve('scripts/run-agent-runtime-v1-conformance.mjs'),
        stagedPack,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      assert.equal(checked.status, 0, checked.stderr);
      assert.equal(existsSync(marker), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds executable host bytes to the reviewed source commit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-v1-host-source-'));
    const stagedPack = path.join(root, 'agent-runtime-v1');
    try {
      await cp(path.resolve('agent-runtime-v1'), stagedPack, { recursive: true });
      const relative = 'host/src/v1/errors.mjs';
      await appendFile(path.join(stagedPack, relative), '\n// self-consistent tamper\n');
      await rewriteOuterChecksum(stagedPack, relative);
      const checked = spawnSync(process.execPath, [
        path.resolve('scripts/run-agent-runtime-v1-conformance.mjs'),
        stagedPack,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      assert.notEqual(checked.status, 0);
      assert.match(checked.stderr, /reviewed world-host source checksum mismatch/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function rewriteOuterChecksum(pack, relative) {
  const checksumPath = path.join(pack, 'checksums.sha256');
  const replacement = createHash('sha256')
    .update(await readFile(path.join(pack, relative)))
    .digest('hex');
  const lines = (await readFile(checksumPath, 'utf8')).trimEnd().split('\n');
  const index = lines.findIndex((line) => line.endsWith(`  ${relative}`));
  assert.notEqual(index, -1);
  lines[index] = `${replacement}  ${relative}`;
  await writeFile(checksumPath, `${lines.join('\n')}\n`);
}
