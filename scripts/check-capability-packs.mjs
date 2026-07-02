#!/usr/bin/env bun
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertCapabilityConformanceReceipt,
  assertCapabilityPackChecksums,
  validateCapabilityPackManifest,
} from '../src/core/capability_pack.mjs';
import { defineCapabilityDriver } from '../src/core/capability_driver.mjs';

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
  await assertAdapterManifestMatchesPack(packRoot, checked, name);
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

async function assertAdapterManifestMatchesPack(packRoot, packManifest, name) {
  if (packManifest.adapter.kind !== 'in_process') return;
  const adapterPath = path.join(packRoot, packManifest.adapter.module);
  const module = await import(pathToFileURL(adapterPath).href);
  const Driver = module[packManifest.adapter.exportName];
  if (typeof Driver !== 'function') throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_EXPORT:${name}`);
  const driver = new Driver(adapterOptions(packManifest.driverId));
  const capabilityDriver = defineCapabilityDriver(driver);
  if (packManifest.canRecover === true && typeof driver.recover !== 'function') throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_RECOVER:${name}`);
  const driverManifest = capabilityDriver.manifest();
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

function adapterOptions(driverId) {
  if (driverId === 'generic-http-json') return { endpointUrl: 'https://example.invalid/decide' };
  return {};
}

function assertSameManifestField(name, field, packValue, driverValue) {
  if (JSON.stringify(packValue) !== JSON.stringify(driverValue)) {
    throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_MANIFEST_MISMATCH:${name}:${field}`);
  }
}
