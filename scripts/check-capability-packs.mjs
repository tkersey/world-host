#!/usr/bin/env bun
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { runBunCli } from '../src/bun/bun_cli.mjs';
import {
  assertCapabilityConformanceReceipt,
  assertCapabilityPackChecksums,
  capabilityConformanceReceiptFingerprint,
  validateCapabilityPackManifest,
} from '../src/core/capability_pack.mjs';

const trustedExecuteAdapters = process.argv.includes('--trusted-execute-adapters');
const root = path.resolve('capability-packs');
const safeRoot = await safePacksRoot(root);
const names = safeRoot == null ? [] : (await readdir(safeRoot)).filter((name) => name.startsWith('capability-pack-v0.2-')).sort();
if (!names.length) {
  console.error('no capability packs found');
  process.exit(1);
}

const results = [];
for (const name of names) {
  const packRoot = path.join(root, name);
  const manifest = JSON.parse(await readPackFile(packRoot, 'manifest.json', 'utf8'));
  if (!Array.isArray(manifest.checksums) || manifest.checksums.length === 0) throw new Error(`ERR_CAPABILITY_PACK_CHECKSUMS_REQUIRED:${name}`);
  const checked = await validateCapabilityPackManifest(manifest, { requirePackFingerprint: true, verifyFingerprint: true });
  const artifacts = {};
  for (const item of checked.checksums) artifacts[item.path] = new Uint8Array(await readPackFile(packRoot, item.path));
  await assertCapabilityPackChecksums(checked, artifacts);
  if (checked.conformanceCorpusFingerprint != null) {
    const receipt = JSON.parse(await readPackFile(packRoot, 'conformance.json', 'utf8'));
    assertCapabilityConformanceReceipt(receipt);
    if (receipt.packFingerprint !== checked.packFingerprint) throw new Error(`ERR_CAPABILITY_CONFORMANCE_PACK_FINGERPRINT:${name}`);
    if (receipt.driverId !== checked.driverId) throw new Error(`ERR_CAPABILITY_CONFORMANCE_DRIVER:${name}`);
    if (receipt.corpusFingerprint !== checked.conformanceCorpusFingerprint) throw new Error(`ERR_CAPABILITY_CONFORMANCE_CORPUS:${name}`);
    if (await capabilityConformanceReceiptFingerprint(receipt) !== checked.conformanceReceiptFingerprint) {
      throw new Error(`ERR_CAPABILITY_CONFORMANCE_RECEIPT_FINGERPRINT:${name}`);
    }
  }
  if (trustedExecuteAdapters) await assertAdapterManifestMatchesPack(name, packRoot);
  results.push({
    pack: name,
    driverId: checked.driverId,
    packFingerprint: checked.packFingerprint,
    artifactCount: checked.checksums.length,
    trustedAdapterExecution: trustedExecuteAdapters,
  });
}

console.log(JSON.stringify({ capabilityPacks: results, status: 'passed' }, null, 2));

async function safePacksRoot(rootPath) {
  let info;
  try {
    info = await lstat(rootPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`ERR_CAPABILITY_PACK_ROOT_UNSAFE:${rootPath}`);
  if (!info.isDirectory()) throw new Error(`ERR_CAPABILITY_PACK_ROOT_INVALID:${rootPath}`);
  return rootPath;
}

async function readPackFile(packRoot, relativePath, encoding = null) {
  const rootPath = await safePackRoot(packRoot);
  const target = path.resolve(packRoot, relativePath);
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_UNSAFE:${relativePath}`);
  if (!info.isFile()) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_MISSING:${relativePath}`);
  const actual = await realpath(target);
  if (!pathInside(rootPath, actual)) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_UNSAFE:${relativePath}`);
  return encoding ? await readFile(actual, encoding) : await readFile(actual);
}

async function safePackRoot(packRoot) {
  const normalizedRoot = path.resolve(packRoot);
  const info = await lstat(normalizedRoot);
  if (info.isSymbolicLink()) throw new Error(`ERR_CAPABILITY_PACK_ROOT_UNSAFE:${packRoot}`);
  if (!info.isDirectory()) throw new Error(`ERR_CAPABILITY_PACK_ROOT_INVALID:${packRoot}`);
  return await realpath(normalizedRoot);
}

function pathInside(rootPath, target) {
  const relative = path.relative(rootPath, target);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function assertAdapterManifestMatchesPack(name, packRoot) {
  const output = { stdout: '', stderr: '' };
  const code = await runBunCli([
    'capability',
    'check-pack',
    '--pack',
    packRoot,
    '--trusted-execute-adapters',
  ], {
    stdout: { write: (chunk) => { output.stdout += String(chunk); } },
    stderr: { write: (chunk) => { output.stderr += String(chunk); } },
  });
  if (code !== 0) {
    throw new Error(output.stderr.trim() || output.stdout.trim() || `ERR_CAPABILITY_PACK_ADAPTER_PROBE_PROCESS:${name}`);
  }
}
