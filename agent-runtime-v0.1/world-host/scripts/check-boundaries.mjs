#!/usr/bin/env bun
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const violations = [];

await checkArea('src/core', [
  '../bun/',
  '../stores/',
  '../drivers/',
  'bun:',
  'node:fs',
  'node:child_process',
]);
await checkArea('src/protocol', [
  '../bun/',
  '../stores/',
  '../drivers/',
  '../core/application',
  '../core/effect_journal',
  'bun:',
  'node:fs',
  'node:child_process',
]);

if (violations.length > 0) {
  for (const violation of violations) console.error(`${violation.file}: forbidden import ${violation.pattern}`);
  process.exit(1);
}

console.log('host_kit_boundaries=passed');

async function checkArea(rel, forbidden) {
  const dir = path.join(root, rel);
  for (const file of await listFiles(dir)) {
    const text = await readFile(file, 'utf8');
    for (const pattern of forbidden) {
      if (text.includes(pattern)) violations.push({ file: path.relative(root, file), pattern });
    }
  }
}

async function listFiles(dir) {
  const entries = await readdir(dir);
  const out = [];
  for (const entry of entries) {
    const file = path.join(dir, entry);
    const info = await stat(file);
    if (info.isDirectory()) out.push(...await listFiles(file));
    else if (info.isFile() && file.endsWith('.mjs')) out.push(file);
  }
  return out;
}
