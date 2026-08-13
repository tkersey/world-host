#!/usr/bin/env bun
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLIC_RUNTIME_ARCHIVE, PUBLIC_RUNTIME_ROOT, buildRuntimeTree, writeDeterministicArchive } from './public-runtime-v1.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(valueAfter('--output-dir') ?? 'zig-out/public-runtime');
const temporary = await mkdtemp(path.join(tmpdir(), 'world-host-public-runtime-'));
try {
  const tree = path.join(temporary, PUBLIC_RUNTIME_ROOT);
  await buildRuntimeTree(repository, tree);
  const archive = path.join(outputDir, PUBLIC_RUNTIME_ARCHIVE);
  const result = await writeDeterministicArchive(tree, archive);
  await writeFile(`${archive}.sha256`, `${result.sha256}  ${PUBLIC_RUNTIME_ARCHIVE}\n`);
  process.stdout.write(`${JSON.stringify({ schema: 'world-host-public-runtime-build/v1', archive, ...result }, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  if (index + 1 >= process.argv.length) throw new Error(`${flag} requires a value`);
  return process.argv[index + 1];
}
