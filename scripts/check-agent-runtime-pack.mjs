#!/usr/bin/env bun
import { checkAgentRuntimePack, defaultPackPath, parseCommonArgs } from './agent_runtime_pack_lib.mjs';

const options = parseCommonArgs(process.argv.slice(2));
const pack = options.out ?? defaultPackPath();
const result = await checkAgentRuntimePack(pack, {
  requireReleaseReceipt: options.requireReleaseReceipt === true,
});
console.log(JSON.stringify({
  agent_runtime_pack_valid: true,
  pack: result.root,
  manifest_fingerprint: result.manifest.manifestFingerprint,
  release_receipt_validated: result.releaseReceiptValidated,
}, null, 2));
