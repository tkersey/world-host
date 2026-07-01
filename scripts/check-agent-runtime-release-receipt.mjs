#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertAgentRuntimeReleaseReceipt, defaultPackPath, parseCommonArgs } from './agent_runtime_pack_lib.mjs';

const options = parseCommonArgs(process.argv.slice(2));
const pack = options.out ?? defaultPackPath();
const receiptPath = options.releaseReceiptOut ?? options.receiptOut ?? path.join(pack, 'manifest/agent-runtime-release-receipt.json');
const actual = JSON.parse(await readFile(receiptPath, 'utf8'));
await assertAgentRuntimeReleaseReceipt(pack, actual);
console.log(JSON.stringify({
  agent_runtime_release_receipt_valid: true,
  receipt: receiptPath,
  receipt_fingerprint: actual.receiptFingerprint,
}, null, 2));
