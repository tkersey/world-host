#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertAgentRuntimeReleaseReceipt, checkAgentRuntimePack, defaultPackPath, emitReleaseReceipt, FIXTURE_INPUT, FIXTURE_OUTPUT, parseCommonArgs, refreshAgentRuntimePackChecksums } from './agent_runtime_pack_lib.mjs';

export async function runAgentRuntimeConformance(pack) {
  const checked = await checkAgentRuntimePack(pack, { validateReleaseReceipt: false });
  const hostRoot = path.join(checked.root, 'world-host');
  const examples = await import(pathToFileURL(path.join(hostRoot, 'examples/agent_runtime/shared.mjs')));
  const { runBunCli } = await import(pathToFileURL(path.join(hostRoot, 'src/bun/bun_cli.mjs')));
  const { BunWorldWorker } = await import(pathToFileURL(path.join(hostRoot, 'src/bun/bun_worker.mjs')));
  const { fromUtf8, stableJson } = await import(pathToFileURL(path.join(hostRoot, 'src/core/store.mjs')));
  const { encodeTurnInput, operationBoot } = await import(pathToFileURL(path.join(hostRoot, 'src/protocol/world_appliance_wire_codec.mjs')));
  const codecs = { encodeTurnInput, fromUtf8, operationBoot, stableJson };
  const corpus = JSON.parse(await readFile(path.join(checked.root, 'conformance/corpus.json'), 'utf8'));
  const wasmBytes = await readFile(path.join(checked.root, 'world/world_universal_appliance.wasm'));
  const imageBytes = await readFile(path.join(checked.root, 'world/agent.executable-image'));
  const expectedManifestBytes = await readFile(path.join(checked.root, 'world/appliance-manifest.bin'));
  const module = await WebAssembly.compile(wasmBytes);
  const wasmImports = WebAssembly.Module.imports(module);
  if (wasmImports.length !== 0) throw new Error('ERR_AGENT_RUNTIME_WASM_IMPORTS');
  const distributedLoad = await loadDistributedImage({ BunWorldWorker, wasmBytes, imageBytes, expectedManifestBytes, expectedManifestFingerprint: checked.manifest.world.applianceManifestFingerprint });

  const skeleton = await examples.runSkeletonExample();
  const fixture = await examples.runFixtureExample();
  const distributedSkeleton = await runCheckedPackScenario({ checked, codecs, corpus, runBunCli, scenario: 'skeleton', mode: 'success' });
  const distributedFixture = await runCheckedPackScenario({ checked, codecs, corpus, runBunCli, scenario: 'fixture', mode: 'success' });
  const emptyPayloadSkeleton = await runCheckedPackScenario({ checked, codecs, runBunCli, scenario: 'skeleton', mode: 'empty-payload' });
  const emptyPayloadFixture = await runCheckedPackScenario({ checked, codecs, runBunCli, scenario: 'fixture', mode: 'empty-payload' });
  const replay = await examples.runReplayExample();
  const retry = await examples.runRetryExample();
  const migration = await examples.runMigrationExample();
  const branching = await examples.runBranchingExample();
  const negative = await examples.runNegativeExamples();

  const receipt = {
    receiptFormatVersion: 1,
    agentRuntimeManifestFingerprint: checked.manifest.manifestFingerprint,
    agent_runtime_conformance: true,
    owner_skeleton_example_completed: skeleton.completed === true && skeleton.finalResult === 'final=actuate skeleton complete',
    owner_fixture_example_completed: fixture.completed === true && fixture.finalResult === 'final=fixture updated' && fixture.outputFileVerified === true,
    replay_matched: replay.replayCompleted === true && replay.finalResultMatches === true && replay.replayFreshModelEffects === 0 && replay.replayFreshFileEffects === 0,
    retry_matched: retry.resultTurnClosureByteIdentical === true && retry.fileWriteRepeated === false,
    migration_matched: migration.finalResultMatches === true && migration.receiverLocalPreflight === true,
    branching_matched: branching.branchesValid === true &&
      branching.sourceBranchUnchangedByFork === true &&
      branching.sourceBranchImplicitlyMerged === false,
    negative_cases_rejected: Object.values(negative).every((value) => value === true),
    world_evidence_validated: true,
    distributed_skeleton_scenario_completed: distributedSkeleton.completed === true &&
      distributedSkeleton.effectTraceMatched === true &&
      distributedSkeleton.rootResultFingerprint === corpus.expected?.skeletonRootResultFingerprint,
    distributed_fixture_scenario_completed: distributedFixture.completed === true &&
      distributedFixture.effectTraceMatched === true &&
      distributedFixture.outputVerified === true &&
      distributedFixture.rootResultFingerprint === corpus.expected?.fixtureRootResultFingerprint,
    distributed_skeleton_effects_matched: distributedSkeleton.effectTraceMatched === true,
    distributed_fixture_effects_matched: distributedFixture.effectTraceMatched === true,
    distributed_empty_payloads_rejected: emptyPayloadSkeleton.emptyPayloadRejected === true && emptyPayloadFixture.emptyPayloadRejected === true,
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
    receipt.owner_skeleton_example_completed,
    receipt.owner_fixture_example_completed,
    receipt.replay_matched,
    receipt.retry_matched,
    receipt.migration_matched,
    receipt.branching_matched,
    receipt.negative_cases_rejected,
    receipt.world_evidence_validated,
    receipt.distributed_skeleton_scenario_completed,
    receipt.distributed_fixture_scenario_completed,
    receipt.distributed_empty_payloads_rejected,
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
  const defaultReleaseReceiptOut = path.join(pack, 'manifest/agent-runtime-release-receipt.json');
  const defaultReleaseReceiptExists = existsSync(defaultReleaseReceiptOut);
  const { receipt, releaseReceipt } = await runAgentRuntimeConformance(pack);
  if (options.receiptOut) await writeFile(options.receiptOut, `${JSON.stringify(receipt, null, 2)}\n`);
  const releaseReceiptOut = options.releaseReceiptOut ?? (defaultReleaseReceiptExists ? null : defaultReleaseReceiptOut);
  if (releaseReceiptOut) {
    await writeFile(releaseReceiptOut, `${JSON.stringify(releaseReceipt, null, 2)}\n`);
  } else {
    const existingReleaseReceipt = JSON.parse(await readFile(defaultReleaseReceiptOut, 'utf8'));
    await assertAgentRuntimeReleaseReceipt(pack, existingReleaseReceipt);
    if (existingReleaseReceipt.receiptFingerprint !== releaseReceipt.receiptFingerprint) {
      throw new Error('ERR_AGENT_RUNTIME_RELEASE_RECEIPT_MISMATCH');
    }
  }
  if ([options.receiptOut, releaseReceiptOut].some((out) => out && isInsidePath(out, pack))) {
    await refreshAgentRuntimePackChecksums(pack);
  }
  console.log('agent_runtime_conformance=true');
  console.log('owner_skeleton_example_completed=true');
  console.log('owner_fixture_example_completed=true');
  console.log('replay_matched=true');
  console.log('retry_matched=true');
  console.log('migration_matched=true');
  console.log('branching_matched=true');
  console.log('negative_cases_rejected=true');
  console.log('world_evidence_validated=true');
  console.log('distributed_skeleton_scenario_completed=true');
  console.log('distributed_fixture_scenario_completed=true');
  console.log('distributed_empty_payloads_rejected=true');
  console.log('host_did_not_author_receipts=true');
}

function isInsidePath(candidate, root) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

async function runCheckedPackScenario({ checked, codecs, corpus, runBunCli, scenario, mode }) {
  const root = await mkdtemp(path.join(tmpdir(), `world-host-agent-runtime-${scenario}-`));
  const sandboxRoot = path.join(root, 'sandbox');
  const runId = `agent-runtime-${mode}-${scenario}`;
  try {
    const io = () => {
      let output = '';
      return {
        stream: {
          stdout: { write: (text) => { output += text; } },
          stderr: { write() {} },
        },
        json: () => JSON.parse(output),
      };
    };
    await mkdir(sandboxRoot, { recursive: true });
    await writeFile(path.join(sandboxRoot, 'input.txt'), FIXTURE_INPUT);
    await writeFile(path.join(sandboxRoot, 'output.txt'), '');

    let current = io();
    const installCode = await runBunCli([
      'agent',
      'install',
      '--pack', checked.root,
      '--store', root,
      '--app', 'agent-runtime-v0.1',
    ], current.stream, { validateReleaseReceipt: false });
    if (installCode !== 0) throw new Error(`ERR_AGENT_RUNTIME_PACK_SCENARIO_INSTALL:${scenario}`);

    current = io();
    const runOptions = mode === 'empty-payload'
      ? { turnInputFactory: distributedEmptyPayloadTurnInputFactory(codecs) }
      : {};
    const runCode = await runBunCli([
      'agent',
      'run',
      '--store', root,
      '--scenario', scenario,
      '--sandbox-root', sandboxRoot,
      'agent-runtime-v0.1',
      '--run', runId,
    ], current.stream, runOptions);
    const run = current.json();
    if (runCode !== 0 || run.head?.status !== 'needs_host') throw new Error(`ERR_AGENT_RUNTIME_PACK_SCENARIO_RUN:${scenario}`);

    if (mode === 'success') {
      current = io();
      const resumeCode = await runBunCli([
        'agent',
        'resume',
        '--store', root,
        '--run', runId,
        '--scenario', scenario,
        '--sandbox-root', sandboxRoot,
      ], current.stream);
      const resumed = current.json();
      if (resumeCode !== 0 || resumed.head?.status !== 'completed') throw new Error(`ERR_AGENT_RUNTIME_PACK_SCENARIO_COMPLETE:${scenario}`);
      const output = scenario === 'fixture' ? await readFile(path.join(sandboxRoot, 'output.txt'), 'utf8') : null;
      if (scenario === 'fixture' && output !== FIXTURE_OUTPUT) throw new Error(`ERR_AGENT_RUNTIME_PACK_SCENARIO_OUTPUT:${scenario}`);
      current = io();
      const effectsCode = await runBunCli([
        'effects',
        '--json',
        '--store', root,
        '--run', runId,
      ], current.stream);
      if (effectsCode !== 0) throw new Error(`ERR_AGENT_RUNTIME_PACK_SCENARIO_EFFECTS:${scenario}`);
      const effects = sortEffectTrace(current.json().effects.map((effect) => ({
        actuatorRef: effect.actuatorRef,
        descriptorFingerprint: effect.descriptorFingerprint,
        state: effect.state,
        requestBytesChecksum: effect.requestBytesChecksum,
        driverId: effect.diagnostics?.driverId ?? null,
      })));
      const expectedEffects = sortEffectTrace(corpus.expected?.distributedEffects?.[scenario] ?? []);
      return {
        completed: true,
        effectCount: resumed.advance?.effectCount ?? 0,
        effectTraceMatched: JSON.stringify(effects) === JSON.stringify(expectedEffects),
        rootResultFingerprint: resumed.head?.rootResultFingerprint ?? null,
        outputVerified: scenario === 'fixture' ? output === FIXTURE_OUTPUT : null,
      };
    }

    let emptyPayloadRejected = false;
    try {
      current = io();
      await runBunCli([
        'agent',
        'resume',
        '--store', root,
        '--run', runId,
        '--scenario', scenario,
        '--sandbox-root', sandboxRoot,
      ], current.stream);
    } catch (error) {
      emptyPayloadRejected = error?.code === 'ERR_AGENT_RUNTIME_EMPTY_PAYLOAD_UNSUPPORTED' ||
        String(error?.message ?? error).includes('ERR_AGENT_RUNTIME_EMPTY_PAYLOAD_UNSUPPORTED');
    }
    return {
      emptyPayloadRejected,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sortEffectTrace(effects) {
  return [...effects].sort((left, right) => effectTraceKey(left).localeCompare(effectTraceKey(right)));
}

function effectTraceKey(effect) {
  return [
    effect.actuatorRef,
    effect.descriptorFingerprint,
    effect.state,
    effect.requestBytesChecksum,
    effect.driverId,
  ].join('\0');
}

function distributedEmptyPayloadTurnInputFactory(codecs) {
  return ({ worker }) => {
    const { encodeTurnInput, operationBoot } = codecs;
    const applianceManifest = worker.readApplianceManifest();
    return encodeTurnInput({
      operation: operationBoot,
      manifestFingerprint: applianceManifest.decoded.manifestFingerprint,
      turnSequenceNumber: 0n,
      rootArgumentImages: [],
      hostMetadata: 'world-host.agent-runtime.empty-payload',
    });
  };
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
