#!/usr/bin/env bun
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assertCapabilityConformanceReceipt,
  assertCapabilityPackChecksums,
  validateCapabilityPackManifest,
} from '../src/core/capability_pack.mjs';

const root = path.resolve('capability-packs');
const names = (await readdir(root).catch(() => [])).filter((name) => name.startsWith('capability-pack-v0.2-')).sort();
if (!names.length) {
  console.error('no capability packs found');
  process.exit(1);
}

const results = [];
for (const name of names) {
  const packRoot = path.join(root, name);
  const manifest = JSON.parse(await readFile(path.join(packRoot, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.checksums) || manifest.checksums.length === 0) throw new Error(`ERR_CAPABILITY_PACK_CHECKSUMS_REQUIRED:${name}`);
  const checked = await validateCapabilityPackManifest(manifest, { requirePackFingerprint: true, verifyFingerprint: true });
  const artifacts = {};
  for (const item of checked.checksums) artifacts[item.path] = new Uint8Array(await readFile(path.join(packRoot, item.path)));
  await assertCapabilityPackChecksums(checked, artifacts);
  const receipt = JSON.parse(await readFile(path.join(packRoot, 'conformance.json'), 'utf8'));
  assertCapabilityConformanceReceipt(receipt);
  if (receipt.packFingerprint !== checked.packFingerprint) throw new Error(`ERR_CAPABILITY_CONFORMANCE_PACK_FINGERPRINT:${name}`);
  results.push({
    pack: name,
    driverId: checked.driverId,
    packFingerprint: checked.packFingerprint,
    artifactCount: checked.checksums.length,
  });
}

console.log(JSON.stringify({ capabilityPacks: results, status: 'passed' }, null, 2));
