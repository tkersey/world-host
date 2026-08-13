#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PUBLIC_RUNTIME_ARCHIVE, extractRuntimeArchive, parseChecksumSidecar, sha256, verifyRuntimeTree } from './public-runtime-v1.mjs';

const archive = valueAfter('--archive');
const rootArgument = valueAfter('--root');
assert((archive === null) !== (rootArgument === null), 'provide exactly one of --archive or --root');
const temporary = archive === null ? null : await mkdtemp(path.join(tmpdir(), 'world-host-public-runtime-check-'));
try {
  const root = archive === null ? path.resolve(rootArgument) : temporary;
  let extraction = null;
  if (archive !== null) {
    const archiveBytes = await readFile(path.resolve(archive));
    const checksum = valueAfter('--checksum');
    if (checksum !== null) {
      const expected = parseChecksumSidecar(await readFile(path.resolve(checksum), 'utf8'), path.basename(archive));
      assert.equal(sha256(archiveBytes), expected, 'release asset checksum mismatch');
    }
    extraction = await extractRuntimeArchive(path.resolve(archive), root);
  }
  const receipt = await verifyRuntimeTree(root);
  let packagedVerifier = null;
  if (archive !== null) {
    const child = Bun.spawn(['bun', path.join(root, 'conformance/check-runtime.mjs'), '--root', root], {
      cwd: root,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(exitCode, 0, stderr || 'packaged runtime verifier failed');
    packagedVerifier = JSON.parse(stdout);
    assert.equal(packagedVerifier.schema, 'world-host-public-runtime-check/v1');
    assert.equal(packagedVerifier.sourceCheckoutRequired, false);
  }
  process.stdout.write(`${JSON.stringify({ schema: 'world-host-public-runtime-check/v1', ...receipt, archive: extraction, packagedVerifier }, null, 2)}\n`);
} finally {
  if (temporary !== null) await rm(temporary, { recursive: true, force: true });
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  if (index + 1 >= process.argv.length) throw new Error(`${flag} requires a value`);
  return process.argv[index + 1];
}
