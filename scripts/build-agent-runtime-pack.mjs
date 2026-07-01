#!/usr/bin/env bun
import { buildAgentRuntimePack, parseCommonArgs } from './agent_runtime_pack_lib.mjs';

const options = parseCommonArgs(process.argv.slice(2));
const result = await buildAgentRuntimePack(options);
console.log(JSON.stringify({
  agent_runtime_pack_built: true,
  pack: result.out,
  manifest_fingerprint: result.manifest.manifestFingerprint,
}, null, 2));
