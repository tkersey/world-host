#!/usr/bin/env bun
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  assertCapabilityConformanceReceipt,
  assertCapabilityPackChecksums,
  validateCapabilityPackManifest,
} from '../src/core/capability_pack.mjs';
import { defineCapabilityDriver } from '../src/core/capability_driver.mjs';

const trustedExecuteAdapters = process.argv.includes('--trusted-execute-adapters');
const root = path.resolve('capability-packs');
const names = (await readdir(root).catch(() => [])).filter((name) => name.startsWith('capability-pack-v0.2-')).sort();
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
  if (trustedExecuteAdapters) await assertAdapterManifestMatchesPack(checked, artifacts, name);
  const receipt = JSON.parse(await readPackFile(packRoot, 'conformance.json', 'utf8'));
  assertCapabilityConformanceReceipt(receipt);
  if (receipt.packFingerprint !== checked.packFingerprint) throw new Error(`ERR_CAPABILITY_CONFORMANCE_PACK_FINGERPRINT:${name}`);
  if (receipt.driverId !== checked.driverId) throw new Error(`ERR_CAPABILITY_CONFORMANCE_DRIVER:${name}`);
  if (receipt.corpusFingerprint !== checked.conformanceCorpusFingerprint) throw new Error(`ERR_CAPABILITY_CONFORMANCE_CORPUS:${name}`);
  results.push({
    pack: name,
    driverId: checked.driverId,
    packFingerprint: checked.packFingerprint,
    artifactCount: checked.checksums.length,
    trustedAdapterExecution: trustedExecuteAdapters,
  });
}

console.log(JSON.stringify({ capabilityPacks: results, status: 'passed' }, null, 2));

async function readPackFile(packRoot, relativePath, encoding = null) {
  const rootPath = await realpath(packRoot);
  const target = path.resolve(packRoot, relativePath);
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_UNSAFE:${relativePath}`);
  if (!info.isFile()) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_MISSING:${relativePath}`);
  const actual = await realpath(target);
  if (!pathInside(rootPath, actual)) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_UNSAFE:${relativePath}`);
  return encoding ? await readFile(actual, encoding) : await readFile(actual);
}

function pathInside(rootPath, target) {
  const relative = path.relative(rootPath, target);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function assertAdapterManifestMatchesPack(packManifest, artifacts, name) {
  if (packManifest.adapter.kind !== 'in_process') return;
  const module = await import(await adapterImportUrl(packManifest, artifacts));
  const Driver = module[packManifest.adapter.exportName];
  if (typeof Driver !== 'function') throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_EXPORT:${name}`);
  const driver = new Driver(adapterOptions(packManifest));
  const capabilityDriver = defineCapabilityDriver(driver);
  if (packManifest.canRecover === true && typeof driver.recover !== 'function') throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_RECOVER:${name}`);
  const driverManifest = capabilityDriver.manifest();
  if (driverManifest.packFingerprint !== packManifest.packFingerprint) throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_MANIFEST_MISMATCH:${name}:packFingerprint`);
  for (const field of [
    'driverId',
    'supportedActuatorRefs',
    'supportedDescriptorFingerprints',
    'supportedActuationClasses',
    'supportedResponseStatuses',
    'recoveryClass',
    'maximumRequestBytes',
    'maximumResponseBytes',
    'authorityLabels',
  ]) {
    assertSameManifestField(name, field, packManifest[field], driverManifest[field]);
  }
}

async function adapterImportUrl(packManifest, artifacts) {
  const checksum = packManifest.checksums.find((item) => item.path === packManifest.adapter.module)?.checksum;
  if (!checksum) throw new Error(`ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED:${packManifest.adapter.module}`);
  const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-adapter-imports-'));
  for (const item of packManifest.checksums) {
    const bytes = artifacts[item.path];
    if (!(bytes instanceof Uint8Array)) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_MISSING:${item.path}`);
    const target = path.resolve(root, item.path);
    if (!pathInside(root, target)) throw new Error(`ERR_CAPABILITY_HOST_PATH_FORBIDDEN:${item.path}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  return pathToFileURL(path.resolve(root, packManifest.adapter.module)).href;
}

function adapterOptions(packManifest) {
  const base = { packFingerprint: packManifest.packFingerprint };
  if (packManifest.driverId === 'generic-http-json') return { ...base, endpointUrl: 'https://example.invalid/decide' };
  return base;
}

function assertSameManifestField(name, field, packValue, driverValue) {
  if (JSON.stringify(packValue) !== JSON.stringify(driverValue)) {
    throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_MANIFEST_MISMATCH:${name}:${field}`);
  }
}
