#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { emitReleaseReceipt, parseCommonArgs } from './agent_runtime_pack_lib.mjs';

const options = parseCommonArgs(process.argv.slice(2));
const pack = options.out ?? process.argv[2] ?? 'agent-runtime-v0.1';
const receiptPath = options.receiptOut ?? path.join(pack, 'manifest/agent-runtime-release-receipt.json');
const actual = JSON.parse(await readFile(receiptPath, 'utf8'));
const expected = await emitReleaseReceipt(pack);
if (actual.receiptFingerprint !== expected.receiptFingerprint) {
  throw new Error('ERR_AGENT_RUNTIME_RELEASE_RECEIPT_FINGERPRINT');
}
if (!actual.complete) throw new Error('ERR_AGENT_RUNTIME_RELEASE_RECEIPT_INCOMPLETE');
console.log(JSON.stringify({
  agent_runtime_release_receipt_valid: true,
  receipt: receiptPath,
  receipt_fingerprint: actual.receiptFingerprint,
}, null, 2));
