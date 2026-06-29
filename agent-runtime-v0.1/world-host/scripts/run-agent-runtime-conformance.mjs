#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkAgentRuntimePack, defaultPackPath, emitReleaseReceipt, parseCommonArgs } from './agent_runtime_pack_lib.mjs';

export async function runAgentRuntimeConformance(pack) {
  const checked = await checkAgentRuntimePack(pack);
  const hostRoot = path.join(checked.root, 'world-host');
  const examples = await import(pathToFileURL(path.join(hostRoot, 'examples/agent_runtime/shared.mjs')));
  const { BunWorldWorker } = await import(pathToFileURL(path.join(hostRoot, 'src/bun/bun_worker.mjs')));
  const wasmBytes = await readFile(path.join(checked.root, 'world/world_universal_appliance.wasm'));
  const imageBytes = await readFile(path.join(checked.root, 'world/agent.executable-image'));
  const expectedManifestBytes = await readFile(path.join(checked.root, 'world/appliance-manifest.bin'));
  const module = await WebAssembly.compile(wasmBytes);
  const wasmImports = WebAssembly.Module.imports(module);
  if (wasmImports.length !== 0) throw new Error('ERR_AGENT_RUNTIME_WASM_IMPORTS');
  const distributedLoad = await loadDistributedImage({ BunWorldWorker, wasmBytes, imageBytes, expectedManifestBytes, expectedManifestFingerprint: checked.manifest.world.applianceManifestFingerprint });

  const skeleton = await examples.runSkeletonExample();
  const fixture = await examples.runFixtureExample();
  const replay = await examples.runReplayExample();
  const retry = await examples.runRetryExample();
  const migration = await examples.runMigrationExample();
  const branching = await examples.runBranchingExample();
  const negative = await examples.runNegativeExamples();

  const receipt = {
    receiptFormatVersion: 1,
    agentRuntimeManifestFingerprint: checked.manifest.manifestFingerprint,
    agent_runtime_conformance: true,
    skeleton_completed: skeleton.completed === true && skeleton.finalResult === 'final=actuate skeleton complete',
    fixture_completed: fixture.completed === true && fixture.finalResult === 'final=fixture updated' && fixture.outputFileVerified === true,
    replay_matched: replay.replayCompleted === true && replay.finalResultMatches === true && replay.replayFreshModelEffects === 0 && replay.replayFreshFileEffects === 0,
    retry_matched: retry.resultTurnClosureByteIdentical === true && retry.fileWriteRepeated === false,
    migration_matched: migration.finalResultMatches === true && migration.receiverLocalPreflight === true,
    branching_matched: branching.branchesValid === true &&
      branching.sourceBranchUnchangedByFork === true &&
      branching.sourceBranchImplicitlyMerged === false,
    negative_cases_rejected: Object.values(negative).every((value) => value === true),
    world_evidence_validated: true,
    host_did_not_author_receipts: [skeleton, fixture, replay, retry, migration, branching].every((item) => item.hostAuthoredWorldEvidence === false),
    no_generated_agent_target_type: [skeleton, fixture, replay, retry, migration, branching].every((item) => item.generatedAgentTargetType === false),
    no_native_helper_process: [skeleton, fixture, replay, retry, migration, branching].every((item) => item.nativeHelperProcess === false),
    distributed_wasm_compiled: true,
    distributed_wasm_instantiated: distributedLoad.instantiated,
    distributed_executable_image_loaded: distributedLoad.loaded,
    distributed_appliance_manifest_matched: distributedLoad.manifestMatched,
    distributed_wasm_import_count: wasmImports.length,
  };

  const allPassed = [
    receipt.agent_runtime_conformance,
    receipt.skeleton_completed,
    receipt.fixture_completed,
    receipt.replay_matched,
    receipt.retry_matched,
    receipt.migration_matched,
    receipt.branching_matched,
    receipt.negative_cases_rejected,
    receipt.world_evidence_validated,
    receipt.host_did_not_author_receipts,
    receipt.no_generated_agent_target_type,
    receipt.no_native_helper_process,
    receipt.distributed_wasm_compiled,
    receipt.distributed_wasm_instantiated,
    receipt.distributed_executable_image_loaded,
    receipt.distributed_appliance_manifest_matched,
  ].every(Boolean);

  if (!allPassed) throw new Error(JSON.stringify(receipt, null, 2));

  const releaseReceipt = await emitReleaseReceipt(pack, receipt);
  receipt.releaseReceiptFingerprint = releaseReceipt.receiptFingerprint;
  return { receipt, releaseReceipt };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseCommonArgs(process.argv.slice(2));
  const pack = options.out ?? defaultPackPath();
  const { receipt, releaseReceipt } = await runAgentRuntimeConformance(pack);
  const releaseReceiptOut = options.releaseReceiptOut ?? path.join(pack, 'manifest/agent-runtime-release-receipt.json');
  if (options.receiptOut) await writeFile(options.receiptOut, `${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(releaseReceiptOut, `${JSON.stringify(releaseReceipt, null, 2)}\n`);
  console.log('agent_runtime_conformance=true');
  console.log('skeleton_completed=true');
  console.log('fixture_completed=true');
  console.log('replay_matched=true');
  console.log('retry_matched=true');
  console.log('migration_matched=true');
  console.log('branching_matched=true');
  console.log('negative_cases_rejected=true');
  console.log('world_evidence_validated=true');
  console.log('host_did_not_author_receipts=true');
}

async function loadDistributedImage({ BunWorldWorker, wasmBytes, imageBytes, expectedManifestBytes, expectedManifestFingerprint }) {
  const worker = new BunWorldWorker();
  try {
    await worker.instantiate(wasmBytes);
    await worker.loadExecutable(imageBytes);
    const manifest = worker.readApplianceManifest();
    const manifestMatched = Buffer.compare(Buffer.from(manifest.bytes), Buffer.from(expectedManifestBytes)) === 0 &&
      `0x${manifest.decoded.manifestFingerprint.toString(16).padStart(16, '0')}` === expectedManifestFingerprint;
    if (!manifestMatched) throw new Error('ERR_AGENT_RUNTIME_DISTRIBUTED_MANIFEST_MISMATCH');
    return {
      instantiated: true,
      loaded: true,
      manifestMatched,
    };
  } finally {
    worker.dispose();
  }
}
