#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { defaultPackPath, emitReleaseReceipt, parseCommonArgs } from './agent_runtime_pack_lib.mjs';

const options = parseCommonArgs(process.argv.slice(2));
const pack = options.out ?? defaultPackPath();
const conformancePath = options.conformanceReceipt;
if (!conformancePath) throw new Error('ERR_AGENT_RUNTIME_CONFORMANCE_REQUIRED');
const conformance = JSON.parse(await readFile(conformancePath, 'utf8'));
const receipt = await emitReleaseReceipt(pack, conformance);
const out = options.receiptOut ?? path.join(pack, 'manifest/agent-runtime-release-receipt.json');
await writeFile(out, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({
  agent_runtime_release_receipt_emitted: true,
  receipt: out,
  receipt_fingerprint: receipt.receiptFingerprint,
  complete: receipt.complete,
}, null, 2));
