#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { extractRuntimeArchive, parseChecksumSidecar, sha256, verifyRuntimeTree } from './public-runtime-v1.mjs';

const archive = required('--archive');
const checksum = required('--checksum');
const fixturePack = required('--fixture-pack');
const temporary = await mkdtemp(path.join(tmpdir(), 'world-host-public-runtime-conformance-'));
try {
  const archivePath = path.resolve(archive);
  const archiveBytes = await readFile(archivePath);
  const expected = parseChecksumSidecar(await readFile(path.resolve(checksum), 'utf8'), path.basename(archivePath));
  assert.equal(sha256(archiveBytes), expected, 'release asset checksum mismatch');
  const runtimeParent = path.join(temporary, 'runtime');
  const extraction = await extractRuntimeArchive(archivePath, runtimeParent);
  const runtime = runtimeParent;
  await verifyRuntimeTree(runtime);
  const pack = path.join(temporary, 'fixture-pack');
  await cp(path.resolve(fixturePack), pack, { recursive: true });
  await rm(path.join(pack, 'host'), { recursive: true, force: true });
  await cp(runtime, path.join(pack, 'host'), { recursive: true });
  // The public runtime has the same v1 executable source as v1.0.0. Only its
  // generated package metadata and verification files differ, so rebuild the
  // outer fixture checksum list before invoking the released lifecycle proof.
  const files = await listFiles(pack);
  const lines = [];
  for (const relative of files.filter((value) => value !== 'checksums.sha256')) {
    lines.push(`${sha256(await readFile(path.join(pack, relative)))}  ${relative}`);
  }
  await writeFile(path.join(pack, 'checksums.sha256'), `${lines.join('\n')}\n`);
  const command = Bun.spawn(['bun', path.join(pack, 'conformance/run.mjs'), pack], {
    cwd: temporary,
    env: anonymousEnvironment(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ]);
  assert.equal(exitCode, 0, stderr || 'public runtime lifecycle failed');
  const lifecycle = JSON.parse(stdout);
  process.stdout.write(`${JSON.stringify({
    schema: 'world-host-public-runtime-conformance/v1',
    runtimeArchiveSha256: extraction.sha256,
    sourceCheckoutRequired: false,
    githubAuthenticationRequired: false,
    githubCliRequired: false,
    zigRequiredAtRuntime: false,
    lifecycle,
  }, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function required(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) throw new Error(`${flag} is required`);
  return process.argv[index + 1];
}

async function listFiles(root, relative = '') {
  const { lstat, readdir } = await import('node:fs/promises');
  const output = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const child = path.posix.join(relative, name);
    const info = await lstat(path.join(root, child));
    assert(!info.isSymbolicLink(), `fixture pack symlink is forbidden: ${child}`);
    if (info.isDirectory()) output.push(...await listFiles(root, child));
    else if (info.isFile()) output.push(child);
  }
  return output;
}

function anonymousEnvironment() {
  const env = { ...process.env };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY']) delete env[key];
  env.PATH = path.dirname(process.execPath);
  return env;
}
