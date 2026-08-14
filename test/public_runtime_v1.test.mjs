import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { PUBLIC_RUNTIME_ARCHIVE, PUBLIC_RUNTIME_ROOT, buildRuntimeTree, extractRuntimeArchive, runtimeSourcePaths, sha256, verifyRuntimeTree, writeDeterministicArchive } from '../scripts/public-runtime-v1.mjs';

const repository = path.resolve(import.meta.dir, '..');

describe('public world-host v1 runtime', () => {
  it('builds reproducible, host-only, source-independent bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-public-runtime-test-'));
    try {
      const firstTree = path.join(root, 'first', PUBLIC_RUNTIME_ROOT);
      const secondTree = path.join(root, 'second', PUBLIC_RUNTIME_ROOT);
      await buildRuntimeTree(repository, firstTree);
      await buildRuntimeTree(repository, secondTree);
      const firstArchive = path.join(root, 'first', PUBLIC_RUNTIME_ARCHIVE);
      const secondArchive = path.join(root, 'second', PUBLIC_RUNTIME_ARCHIVE);
      const first = await writeDeterministicArchive(firstTree, firstArchive);
      const second = await writeDeterministicArchive(secondTree, secondArchive);
      assert.equal(first.sha256, second.sha256);
      assert.deepEqual(await readFile(firstArchive), await readFile(secondArchive));
      assert.equal((await readFile(firstArchive))[9], 0xff);
      assert.equal((await verifyRuntimeTree(firstTree)).sourceCheckoutRequired, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves every released v1.0.0 executable runtime byte', async () => {
    const currentPaths = await runtimeSourcePaths(repository);
    const releasedPaths = gitLines(['ls-tree', '-r', '--name-only', 'v1.0.0', '--', 'bin/world-host-v1.mjs', 'src/bun/application_v1_cli.mjs', 'src/bun/application_v1_inspection_worker.mjs', 'src/v1']);
    assert.deepEqual(currentPaths.filter((value) => value !== 'LICENSE'), releasedPaths);
    for (const relative of releasedPaths) {
      const released = gitBytes(['show', `v1.0.0:${relative}`]);
      assert.equal(sha256(await readFile(path.join(repository, relative))), sha256(released), relative);
    }
  });

  it('rejects traversal, links, duplicate paths, unexpected roots, and checksum drift', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-public-runtime-negative-'));
    try {
      for (const mutation of ['traversal', 'backslash-traversal', 'symlink', 'duplicate', 'wrong-root', 'entrypoint-mode']) {
        const archive = path.join(root, `${mutation}.tar.gz`);
        await writeFile(archive, adversarialArchive(mutation));
        await assert.rejects(() => extractRuntimeArchive(archive, path.join(root, mutation)));
      }
      const tree = path.join(root, 'tree');
      await buildRuntimeTree(repository, tree);
      await writeFile(path.join(tree, 'README.md'), 'tampered\n');
      await assert.rejects(() => verifyRuntimeTree(tree), /checksum mismatch/);

      const inventory = path.join(root, 'inventory');
      await buildRuntimeTree(repository, inventory);
      await rm(path.join(inventory, 'src/v1/protocol.mjs'));
      await assert.rejects(() => verifyRuntimeTree(inventory), /runtime file inventory mismatch/);

      const canonical = path.join(root, 'canonical');
      await buildRuntimeTree(repository, canonical);
      const canonicalArchive = path.join(root, 'canonical.tar.gz');
      await writeDeterministicArchive(canonical, canonicalArchive);
      const trailing = path.join(root, 'trailing.tar.gz');
      await writeFile(trailing, gzipSync(Buffer.concat([gunzipSync(await readFile(canonicalArchive)), Buffer.alloc(512, 0x41)])));
      await assert.rejects(
        () => extractRuntimeArchive(trailing, path.join(root, 'trailing')),
        /non-zero data follows tar terminator/,
      );

      const missingChecksum = Bun.spawn(['bun', 'scripts/check-public-runtime-v1.mjs', '--archive', canonicalArchive], {
        cwd: repository,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [missingChecksumError, missingChecksumExit] = await Promise.all([
        new Response(missingChecksum.stderr).text(),
        missingChecksum.exited,
      ]);
      assert.notEqual(missingChecksumExit, 0);
      assert.match(missingChecksumError, /--checksum is required with --archive/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function gitLines(args) { return new TextDecoder().decode(gitBytes(args)).trim().split('\n').filter(Boolean); }
function gitBytes(args) {
  const result = Bun.spawnSync(['git', ...args], { cwd: repository, stdout: 'pipe', stderr: 'pipe' });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return Buffer.from(result.stdout);
}

function adversarialArchive(kind) {
  const { gzipSync } = require('node:zlib');
  const names = kind === 'duplicate' ? [`${PUBLIC_RUNTIME_ROOT}/README.md`, `${PUBLIC_RUNTIME_ROOT}/README.md`] : [
    kind === 'traversal' ? `${PUBLIC_RUNTIME_ROOT}/../escape`
      : kind === 'backslash-traversal' ? `${PUBLIC_RUNTIME_ROOT}/..\\escape`
        : kind === 'wrong-root' ? 'wrong-root/README.md'
          : kind === 'entrypoint-mode' ? `${PUBLIC_RUNTIME_ROOT}/bin/world-host-v1.mjs`
            : `${PUBLIC_RUNTIME_ROOT}/link`,
  ];
  const chunks = [];
  for (const name of names) {
    const header = Buffer.alloc(512);
    Buffer.from(name).copy(header);
    octal(header, 100, 8, 0o644); octal(header, 108, 8, 0); octal(header, 116, 8, 0); octal(header, 124, 12, 0); octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156); header[156] = kind === 'symlink' ? 0x32 : 0x30; Buffer.from('ustar\0').copy(header, 257); Buffer.from('00').copy(header, 263);
    octal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0)); chunks.push(header);
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { mtime: 0 });
}

function octal(buffer, offset, width, value) { const encoded = value.toString(8).padStart(width - 2, '0'); buffer.write(encoded, offset); buffer[offset + width - 2] = 0; buffer[offset + width - 1] = 0x20; }
