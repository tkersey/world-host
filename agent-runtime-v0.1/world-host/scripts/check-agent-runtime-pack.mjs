#!/usr/bin/env bun
import { checkAgentRuntimePack, parseCommonArgs } from './agent_runtime_pack_lib.mjs';

const options = parseCommonArgs(process.argv.slice(2));
const pack = options.out ?? process.argv[2] ?? 'agent-runtime-v0.1';
const result = await checkAgentRuntimePack(pack);
console.log(JSON.stringify({
  agent_runtime_pack_valid: true,
  pack: result.root,
  manifest_fingerprint: result.manifest.manifestFingerprint,
}, null, 2));
