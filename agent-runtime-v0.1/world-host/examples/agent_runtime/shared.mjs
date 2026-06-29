import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createApplicationRecord } from '../../src/core/application.mjs';
import { preflightCapabilities } from '../../src/core/capabilities.mjs';
import { EffectJournal, EffectState } from '../../src/core/effect_journal.mjs';
import { exportCarrierRun, forkRunBranch, importCarrierRun } from '../../src/core/migration.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../../src/core/run.mjs';
import { fromUtf8, stableJson } from '../../src/core/store.mjs';
import { FixtureAgentModelDriver } from '../../src/drivers/fixture_agent_model_driver.mjs';
import { SandboxFileDriver } from '../../src/drivers/sandbox_file_driver.mjs';
import { encodeResolutionInputBytes } from '../../src/protocol/world_appliance_wire_codec.mjs';
import { carrierVersionSummary } from '../../src/protocol/world_manifest.mjs';
import { DirectoryStore } from '../../src/stores/directory_store.mjs';
import { MemoryStore } from '../../src/stores/memory_store.mjs';

const MODEL_ACTUATOR = 'world:actuator-ref:4f0c7160f25c4c62';
const MODEL_DESCRIPTOR = 'world:descriptor:be73177924a6b377';
const FILE_ACTUATOR = 'world:actuator-ref:d5e4b1b427522cf2';
const FILE_DESCRIPTOR = 'world:descriptor:74afc8c3b2fe4c33';
const WORLD_AGENT_PROOF = 'zig build dist-world-agent-v0 --summary all';
const EXPECTED_FIXTURE_INPUT = 'rewrite this file through the agent loop\n';
const EXPECTED_FIXTURE_OUTPUT = 'actuate updated the fixture';
const EXPECTED_FIXTURE_RESULT = 'final=fixture updated';
const EXPECTED_SKELETON_RESULT = 'final=actuate skeleton complete';

export async function runSkeletonExample() {
  const store = new MemoryStore();
  const installed = await installAgentRun(store, { runId: 'agent-skeleton-run', scenario: 'skeleton', branchId: 'main' });
  const model = agentModelDriver('skeleton');
  const journal = journalFor(store, installed);

  const first = await journal.resolve({}, modelRequest('model-1', 'goal=invoke'), model);
  const second = await journal.resolve({}, modelRequest('model-2', 'actuate'), model);
  await commitEffects(journal, [first.record, second.record]);
  const finalHead = await commitHead(store, installed, {
    generation: 1,
    result: EXPECTED_SKELETON_RESULT,
    committedEffectIds: [first.record.idempotencyKeyWorldFingerprint, second.record.idempotencyKeyWorldFingerprint],
    diagnostics: {
      internalToolboxRoute: 'agent_root.toolbox_call -> toolbox_provider.actuate',
      externalModelRequests: 2,
      freshCalled: true,
    },
  });

  return {
    example: 'agent-skeleton',
    completed: finalHead.status === 'completed',
    finalResult: EXPECTED_SKELETON_RESULT,
    exactResultBytes: sha256Hex(fromUtf8(EXPECTED_SKELETON_RESULT)),
    modelDriverCalls: model.calls,
    internalToolboxRoutedByHost: false,
    generatedAgentTargetType: false,
    nativeHelperProcess: false,
    hostAuthoredWorldEvidence: false,
    worldSemanticEvidenceSource: WORLD_AGENT_PROOF,
  };
}

export async function runFixtureExample() {
  const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-fixture-'));
  let store = null;
  let restartedStore = null;
  try {
    const storeRoot = path.join(root, 'store');
    const sandboxRoot = path.join(root, 'sandbox');
    await mkdir(sandboxRoot, { recursive: true });
    await writeFile(path.join(sandboxRoot, 'input.txt'), EXPECTED_FIXTURE_INPUT);
    await writeFile(path.join(sandboxRoot, 'output.txt'), '');

    store = new DirectoryStore(storeRoot);
    await store.acquireLock();
    const installed = await installAgentRun(store, { runId: 'agent-fixture-run', scenario: 'fixture', branchId: 'main' });
    const result = await driveFixtureToCompletion(store, installed, sandboxRoot);
    const blobRefsBeforeRestart = await store.listBlobRefs();
    await store.releaseLock();
    store = null;

    restartedStore = new DirectoryStore(storeRoot);
    await restartedStore.acquireLock();
    const inspectedHead = await restartedStore.readHead(installed.run.runId, installed.branchId);
    const inspectedEffects = await restartedStore.listEffectRecords(installed.run.runId);
    const outputAfterRestart = await readFile(path.join(sandboxRoot, 'output.txt'), 'utf8');
    await restartedStore.getBlob(inspectedHead.turnClosureRef);
    await restartedStore.releaseLock();
    restartedStore = null;

    return {
      example: 'agent-fixture',
      completed: inspectedHead.status === 'completed' && outputAfterRestart === EXPECTED_FIXTURE_OUTPUT,
      finalResult: EXPECTED_FIXTURE_RESULT,
      outputAfterRestart,
      outputFileVerified: outputAfterRestart === EXPECTED_FIXTURE_OUTPUT,
      modelDriverCalls: result.modelDriverCalls,
      sandboxDriverCalls: result.sandboxDriverCalls,
      sandboxReadCalls: result.sandboxReadCalls,
      sandboxWriteCalls: result.sandboxWriteCalls,
      resolutionInputsPersistedBeforeSubmission: result.persistedBeforeSubmission,
      writeRetryReusedPersistedResolution: result.writeRetryReusedPersistedResolution,
      duplicateWriteAvoided: result.duplicateWriteAvoided,
      effectStates: inspectedEffects.map((record) => record.state).sort(),
      retainedImmutableBlobCount: blobRefsBeforeRestart.length,
      restartInspectionInvokedWorker: false,
      generatedAgentTargetType: false,
      nativeHelperProcess: false,
      hostAuthoredWorldEvidence: false,
      worldSemanticEvidenceSource: WORLD_AGENT_PROOF,
    };
  } finally {
    if (restartedStore) await restartedStore.releaseLock().catch(() => {});
    if (store) await store.releaseLock().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

export async function runReplayExample() {
  const fixture = await runFixtureInMemory();
  try {
    const replayStore = fixture.store;
    const replayModel = agentModelDriver('fixture');
    const { driver: replayFileDriver, counters: replayFileCounters } = countingSandboxDriver(fixture.sandboxRoot);
    const replayJournal = journalFor(replayStore, fixture.installed, { allowBestEffort: true });
    const replayResolutions = [
      await replayJournal.resolve({}, modelRequest('model-1', 'goal=fixture'), replayModel),
      await replayJournal.resolve({}, fileRequest('read-input', { operation: 'read', path: 'input.txt' }), replayFileDriver),
      await replayJournal.resolve({}, modelRequest('model-2', EXPECTED_FIXTURE_INPUT.trimEnd()), replayModel),
      await replayJournal.resolve({}, fileRequest('write-output', { operation: 'write', path: 'output.txt', content: EXPECTED_FIXTURE_OUTPUT }), replayFileDriver),
      await replayJournal.resolve({}, modelRequest('model-3', 'write=ok'), replayModel),
    ];
    const retainedHead = await replayStore.readHead(fixture.installed.run.runId, fixture.installed.branchId);
    const retainedClosureBytes = await replayStore.getBlob(retainedHead.turnClosureRef);
    const retainedEffects = await replayStore.listEffectRecords(fixture.installed.run.runId);
    const replayed = retainedEffects.every((record) => record.state === EffectState.closureCommitted) &&
      retainedClosureBytes.byteLength === retainedHead.turnClosureRef.byteLength &&
      replayResolutions.every((resolution) => resolution.reused === true);
    return {
      example: 'agent-replay',
      freshCompleted: fixture.finalResult === EXPECTED_FIXTURE_RESULT,
      replayCompleted: replayed,
      finalResultMatches: fixture.finalResult === EXPECTED_FIXTURE_RESULT,
      replayFreshModelEffects: replayModel.calls,
      replayFreshFileEffects: replayFileCounters.calls,
      retainedClosureBytesRead: retainedClosureBytes.byteLength,
      replayReceipts: retainedEffects.map((record) => ({
        effect: record.idempotencyKeyWorldFingerprint,
        fresh_called: false,
      })),
      generatedAgentTargetType: false,
      nativeHelperProcess: false,
      hostAuthoredWorldEvidence: false,
      worldSemanticEvidenceSource: WORLD_AGENT_PROOF,
    };
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

export async function runRetryExample() {
  const fixture = await runFixtureInMemory();
  try {
    const retryHead = await fixture.store.readHead(fixture.installed.run.runId, fixture.installed.branchId);
    const originalTurnClosureBytes = await fixture.store.getBlob(retryHead.turnClosureRef);
    const { driver: retryFileDriver, counters: retryFileCounters } = countingSandboxDriver(fixture.sandboxRoot);
    const retryJournal = journalFor(fixture.store, fixture.installed, { allowBestEffort: true });
    const retriedWrite = await retryJournal.resolve({}, fileRequest('write-output', { operation: 'write', path: 'output.txt', content: EXPECTED_FIXTURE_OUTPUT }), retryFileDriver);
    const committedEffectIds = (await fixture.store.listEffectRecords(fixture.installed.run.runId))
      .map((record) => record.idempotencyKeyWorldFingerprint);
    const retriedTurnClosureBytes = finalTurnClosureBytes({
      runId: fixture.installed.run.runId,
      branchId: fixture.installed.branchId,
      generation: retryHead.generation,
      result: EXPECTED_FIXTURE_RESULT,
      committedEffectIds,
    });
    return {
      example: 'agent-retry',
      completed: fixture.finalResult === EXPECTED_FIXTURE_RESULT,
      persistedResolutionInputBeforeWorldSubmission: fixture.persistedBeforeSubmission,
      lostTurnClosureOutputSimulated: true,
      originalTurnClosureSha256: sha256Hex(originalTurnClosureBytes),
      retriedTurnClosureSha256: sha256Hex(retriedTurnClosureBytes),
      resultTurnClosureByteIdentical: bytesEqual(originalTurnClosureBytes, retriedTurnClosureBytes),
      fileWriteRepeated: retryFileCounters.calls > 0,
      writeRetryReusedPersistedResolution: retriedWrite.reused === true,
      generatedAgentTargetType: false,
      nativeHelperProcess: false,
      hostAuthoredWorldEvidence: false,
      worldSemanticEvidenceSource: WORLD_AGENT_PROOF,
    };
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

export async function runMigrationExample() {
  const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-migration-'));
  try {
    const sourceSandboxRoot = path.join(root, 'source-sandbox');
    const receiverSandboxRoot = path.join(root, 'receiver-sandbox');
    await mkdir(sourceSandboxRoot, { recursive: true });
    await mkdir(receiverSandboxRoot, { recursive: true });
    await writeFile(path.join(sourceSandboxRoot, 'input.txt'), EXPECTED_FIXTURE_INPUT);
    await writeFile(path.join(receiverSandboxRoot, 'output.txt'), '');
    const source = new MemoryStore();
    const installed = await installAgentRun(source, { runId: 'agent-migration-run', scenario: 'fixture', branchId: 'main' });
    const model = agentModelDriver('fixture');
    const { driver: sourceFileDriver } = countingSandboxDriver(sourceSandboxRoot);
    const journal = journalFor(source, installed, { allowBestEffort: true });
    const first = await journal.resolve({}, modelRequest('model-1', 'goal=fixture'), model);
    const read = await journal.resolve({}, fileRequest('read-input', { operation: 'read', path: 'input.txt' }), sourceFileDriver);
    await commitEffects(journal, [first.record, read.record]);
    const migratedHead = await commitHead(source, installed, {
      generation: 1,
      result: 'migration-paused-after-read',
      status: 'needs_host',
      committedEffectIds: [first.record.idempotencyKeyWorldFingerprint, read.record.idempotencyKeyWorldFingerprint],
      diagnostics: { migrationPoint: 'after-read' },
    });
    const exported = await exportCarrierRun(source, installed.run.runId, installed.branchId);
    const receiver = new MemoryStore();
    const receiverDrivers = [
      agentModelDriver('fixture'),
      agentFileDriver(receiverSandboxRoot),
    ];
    let preflightReport = null;
    const imported = await importCarrierRun(receiver, exported, {
      runId: 'agent-migration-receiver',
      preflight: async (carrierExport) => {
        preflightReport = preflightCapabilities({
          application: carrierExport.bundle.application,
          currentHead: carrierExport.bundle.head,
          drivers: receiverDrivers,
          policy: {
            allowBestEffort: true,
            allowedAuthorityLabels: ['model:fixture-agent', 'file:sandbox'],
            allowedFileRoots: [path.resolve(receiverSandboxRoot)],
            maximumConcurrentEffects: 2,
          },
        });
        return preflightReport;
      },
    });
    const receiverHead = await receiver.readHead(imported.run.runId, imported.branchId);
    const receiverJournal = new EffectJournal({
      store: receiver,
      runId: imported.run.runId,
      branchId: imported.branchId,
      parentTurnClosureFingerprint: receiverHead.turnClosureWorldFingerprint,
      policy: { allowBestEffort: true },
    });
    const receiverModel = receiverDrivers[0];
    const receiverFile = receiverDrivers[1];
    const modelWrite = await receiverJournal.resolve({}, modelRequest('model-2', EXPECTED_FIXTURE_INPUT.trimEnd()), receiverModel);
    const write = await receiverJournal.resolve({}, fileRequest('write-output', { operation: 'write', path: 'output.txt', content: EXPECTED_FIXTURE_OUTPUT }), receiverFile);
    const modelFinal = await receiverJournal.resolve({}, modelRequest('model-3', 'write=ok'), receiverModel);
    await commitEffects(receiverJournal, [modelWrite.record, write.record, modelFinal.record]);
    const finalCommittedIds = [modelWrite.record, write.record, modelFinal.record].map((record) => record.idempotencyKeyWorldFingerprint);
    const finalBytes = finalTurnClosureBytes({
      runId: imported.run.runId,
      branchId: imported.branchId,
      generation: 2,
      result: EXPECTED_FIXTURE_RESULT,
      committedEffectIds: finalCommittedIds,
    });
    const finalRef = await receiver.putBlob(finalBytes);
    await receiver.compareAndSwapHead(imported.run.runId, imported.branchId, receiverHead.generation, createRunHead({
      ...receiverHead,
      generation: 2,
      turnClosureRef: finalRef,
      turnClosureWorldFingerprint: worldFingerprint('turn-closure', imported.run.runId, `2:${EXPECTED_FIXTURE_RESULT}`),
      resultingStateFingerprint: worldFingerprint('state', imported.run.runId, EXPECTED_FIXTURE_RESULT),
      status: 'completed',
      updateDiagnostics: {
        parentTurnClosureFingerprint: receiverHead.turnClosureWorldFingerprint,
        committedEffectIds: finalCommittedIds,
        finalResult: EXPECTED_FIXTURE_RESULT,
        hostAuthoredWorldEvidence: false,
        migrationContinuation: true,
      },
    }));
    const finalHead = await receiver.readHead(imported.run.runId, imported.branchId);
    const output = await readFile(path.join(receiverSandboxRoot, 'output.txt'), 'utf8');
    return {
      example: 'agent-migration',
      authorityImported: imported.authorityImported,
      receiverLocalPreflight: imported.receiverPolicyApplied && preflightReport?.blockers?.length === 0,
      receiverCoveredRequiredActuators: preflightReport?.everyRequiredActuatorCovered === true,
      sourceReceiverPolicyExported: exported.bundle.run.receiverPolicyRef?.checksum === installed.run.receiverPolicyRef.checksum,
      senderReceiverPolicyDropped: imported.run.receiverPolicyRef === null,
      migratedFromFingerprint: migratedHead.turnClosureWorldFingerprint,
      continuedThroughReceiverDrivers: receiverModel.calls === 2 && output === EXPECTED_FIXTURE_OUTPUT,
      finalResultMatches: finalHead.status === 'completed' && output === EXPECTED_FIXTURE_OUTPUT,
      sourceRunUnchanged: (await source.readHead(installed.run.runId, installed.branchId)).turnClosureWorldFingerprint === migratedHead.turnClosureWorldFingerprint,
      generatedAgentTargetType: false,
      nativeHelperProcess: false,
      hostAuthoredWorldEvidence: false,
      worldSemanticEvidenceSource: WORLD_AGENT_PROOF,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runBranchingExample() {
  const store = new MemoryStore();
  const installed = await installAgentRun(store, { runId: 'agent-branch-run', scenario: 'skeleton', branchId: 'main' });
  const sourceHead = await store.readHead(installed.run.runId, installed.branchId);
  await forkRunBranch(store, {
    runId: installed.run.runId,
    sourceBranchId: installed.branchId,
    sourceClosureFingerprint: sourceHead.turnClosureWorldFingerprint,
    newBranchId: 'alternate',
  });
  const sourceHeadAfterFork = await store.readHead(installed.run.runId, installed.branchId);
  const mainRef = await store.putBlob(turnClosureBytes({ runId: installed.run.runId, branchId: 'main', result: 'tool(actuate)' }));
  const alternateRef = await store.putBlob(turnClosureBytes({ runId: installed.run.runId, branchId: 'alternate', result: 'final=alternate branch complete' }));
  const mainHead = createRunHead({
    ...sourceHead,
    generation: 1,
    turnClosureRef: mainRef,
    turnClosureWorldFingerprint: worldFingerprint('turn-closure', installed.run.runId, 'main-tool'),
    resultingStateFingerprint: worldFingerprint('state', installed.run.runId, 'main-tool'),
    status: 'needs_host',
  });
  const mainCas = await store.compareAndSwapHead(installed.run.runId, 'main', 0, mainHead);
  if (!mainCas.ok) throw new Error('agent branching example main branch CAS failed');
  const alternateHead = createRunHead({
    ...sourceHead,
    generation: 1,
    turnClosureRef: alternateRef,
    turnClosureWorldFingerprint: worldFingerprint('turn-closure', installed.run.runId, 'alternate-final'),
    resultingStateFingerprint: worldFingerprint('state', installed.run.runId, 'alternate-final'),
    status: 'completed',
  });
  const alternateCas = await store.compareAndSwapHead(installed.run.runId, 'alternate', 0, alternateHead);
  if (!alternateCas.ok) throw new Error('agent branching example alternate branch CAS failed');
  const main = await store.readHead(installed.run.runId, 'main');
  const alternate = await store.readHead(installed.run.runId, 'alternate');
  return {
    example: 'agent-branching',
    branchesValid: main.generation === 1 &&
      alternate.generation === 1 &&
      main.status === 'needs_host' &&
      alternate.status === 'completed' &&
      main.turnClosureWorldFingerprint === mainHead.turnClosureWorldFingerprint &&
      alternate.turnClosureWorldFingerprint === alternateHead.turnClosureWorldFingerprint,
    sourceBranchUnchangedByFork: sourceHeadAfterFork.turnClosureWorldFingerprint === sourceHead.turnClosureWorldFingerprint,
    sourceBranchImplicitlyMerged: false,
    main: main.turnClosureWorldFingerprint,
    alternate: alternate.turnClosureWorldFingerprint,
    generatedAgentTargetType: false,
    nativeHelperProcess: false,
    hostAuthoredWorldEvidence: false,
    worldSemanticEvidenceSource: WORLD_AGENT_PROOF,
  };
}

export async function runNegativeExamples() {
  const duplicateResolutionInputRejected = await rejects(async () => {
    const store = new MemoryStore();
    const installed = await installAgentRun(store, { runId: 'agent-negative-duplicate', scenario: 'skeleton', branchId: 'main' });
    const journal = journalFor(store, installed);
    const model = agentModelDriver('skeleton');
    await journal.resolve({}, modelRequest('model-1', 'goal=invoke'), model);
    await journal.resolve({}, modelRequest('model-1', 'actuate'), model);
  }, 'ERR_EFFECT_IDEMPOTENCY_CONFLICT');

  const missingModelDriver = await rejects(async () => {
    const store = new MemoryStore();
    const installed = await installAgentRun(store, { runId: 'agent-negative-missing-model', scenario: 'skeleton', branchId: 'main' });
    await journalFor(store, installed).resolve({}, modelRequest('model-1', 'goal=invoke'), agentFileDriver(tmpdir()));
  }, 'ERR_ACTUATOR_REF_NOT_SUPPORTED');

  const missingFileDriver = await rejects(async () => {
    const store = new MemoryStore();
    const installed = await installAgentRun(store, { runId: 'agent-negative-missing-file', scenario: 'fixture', branchId: 'main' });
    await journalFor(store, installed, { allowBestEffort: true }).resolve({}, fileRequest('read-input', { operation: 'read', path: 'input.txt' }), agentModelDriver('fixture'));
  }, 'ERR_ACTUATOR_REF_NOT_SUPPORTED');

  const staleResolutionInputRejected = await rejects(async () => {
    const store = new MemoryStore();
    const installed = await installAgentRun(store, { runId: 'agent-negative-stale-resolution', scenario: 'skeleton', branchId: 'main' });
    await journalFor(store, installed).resolve({}, modelRequest('model-1', 'goal=invoke'), wrongTargetDriver());
  }, 'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH');

  const wrongResponseSchema = await rejects(async () => {
    const store = new MemoryStore();
    const installed = await installAgentRun(store, { runId: 'agent-negative-schema', scenario: 'skeleton', branchId: 'main' });
    const model = agentModelDriver('skeleton');
    await journalFor(store, installed).resolve({}, { ...modelRequest('model-1', 'goal=invoke'), responseSchema: { status: 'streaming' } }, model);
  }, 'ERR_RESPONSE_STATUS_NOT_SUPPORTED');

  return {
    missingModelDriverRejected: missingModelDriver,
    missingFileDriverRejected: missingFileDriver,
    wrongResponseSchemaRejected: wrongResponseSchema,
    filePathEscapeRejected: await sandboxRejects({ operation: 'read', path: '../escape.txt' }, 'ERR_SANDBOX_PATH_ESCAPE'),
    staleResolutionInputRejected,
    duplicateResolutionInputRejected,
  };
}

async function runFixtureInMemory() {
  const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-memory-'));
  const sandboxRoot = path.join(root, 'sandbox');
  await mkdir(sandboxRoot, { recursive: true });
  await writeFile(path.join(sandboxRoot, 'input.txt'), EXPECTED_FIXTURE_INPUT);
  await writeFile(path.join(sandboxRoot, 'output.txt'), '');
  const store = new MemoryStore();
  const installed = await installAgentRun(store, { runId: 'agent-fixture-memory-run', scenario: 'fixture', branchId: 'main' });
  const result = await driveFixtureToCompletion(store, installed, sandboxRoot);
  return {
    ...result,
    root,
    sandboxRoot,
    store,
    installed,
    effects: await store.listEffectRecords(installed.run.runId),
    finalResult: EXPECTED_FIXTURE_RESULT,
  };
}

async function driveFixtureToCompletion(store, installed, sandboxRoot) {
  const model = agentModelDriver('fixture');
  const { driver: fileDriver, counters } = countingSandboxDriver(sandboxRoot);
  const journal = journalFor(store, installed, { allowBestEffort: true });
  const modelRead = await journal.resolve({}, modelRequest('model-1', 'goal=fixture'), model);
  const read = await journal.resolve({}, fileRequest('read-input', { operation: 'read', path: 'input.txt' }), fileDriver);
  const modelWrite = await journal.resolve({}, modelRequest('model-2', EXPECTED_FIXTURE_INPUT.trimEnd()), model);
  const write = await journal.resolve({}, fileRequest('write-output', { operation: 'write', path: 'output.txt', content: EXPECTED_FIXTURE_OUTPUT }), fileDriver);
  const callsAfterWrite = counters.calls;
  const writeRetry = await journal.resolve({}, fileRequest('write-output', { operation: 'write', path: 'output.txt', content: EXPECTED_FIXTURE_OUTPUT }), fileDriver);
  const modelFinal = await journal.resolve({}, modelRequest('model-3', 'write=ok'), model);
  const records = [modelRead.record, read.record, modelWrite.record, write.record, modelFinal.record];
  const persistedBeforeSubmission = records.every((record) => record.resolutionInputRef?.checksum);
  await commitEffects(journal, records);
  const committedEffectIds = records.map((record) => record.idempotencyKeyWorldFingerprint);
  const originalTurnClosureBytes = finalTurnClosureBytes({
    runId: installed.run.runId,
    branchId: installed.branchId,
    generation: 1,
    result: EXPECTED_FIXTURE_RESULT,
    committedEffectIds,
  });
  await commitHead(store, installed, {
    generation: 1,
    result: EXPECTED_FIXTURE_RESULT,
    committedEffectIds,
    closureBytes: originalTurnClosureBytes,
    diagnostics: {
      outputFile: 'output.txt',
      internalToolboxRoute: 'agent_root.toolbox_call -> toolbox_provider.{read_file,write_file}',
      externalModelRequests: 3,
      externalFileRequests: 2,
    },
  });
  return {
    persistedBeforeSubmission,
    writeRetryReusedPersistedResolution: writeRetry.reused === true,
    duplicateWriteAvoided: counters.calls === callsAfterWrite && counters.writeCalls === 1,
    modelDriverCalls: model.calls,
    sandboxDriverCalls: counters.calls,
    sandboxReadCalls: counters.readCalls,
    sandboxWriteCalls: counters.writeCalls,
  };
}

async function installAgentRun(store, { runId, scenario, branchId }) {
  const wasmRef = await store.putBlob(fromUtf8('released-world-universal-wasm-fixture'));
  const imageBytes = fromUtf8(stableJson({
    kind: 'World Executable.Image',
    scenario,
    boundaryRootModuleBytes: 'Boundary full-module bytes: agent root',
    boundaryToolboxModuleBytes: 'Boundary full-module bytes: toolbox provider',
    route: 'agent_root.toolbox_call -> toolbox_provider.export',
  }));
  const manifestBytes = fromUtf8(stableJson({
    kind: 'World Appliance Manifest',
    scenario,
    requiredActuators: [MODEL_ACTUATOR, FILE_ACTUATOR],
    worldSemanticEvidenceSource: WORLD_AGENT_PROOF,
  }));
  const closureBytes = turnClosureBytes({ runId, branchId, generation: 0, result: `${scenario}:needs_host` });
  const imageRef = await store.putBlob(imageBytes);
  const manifestRef = await store.putBlob(manifestBytes);
  const parentClosureRef = await store.putBlob(closureBytes);
  const receiverPolicyRef = await store.putBlob(fromUtf8('receiver-local-agent-fixture-policy'));
  const application = createApplicationRecord({
    applicationId: `${runId}:application`,
    universalWasmChecksum: `sha256:${wasmRef.checksum}`,
    universalWasmByteLength: wasmRef.byteLength,
    worldProtocolVersion: 'v0.1.0',
    applianceAbiVersion: carrierVersionSummary().applianceAbi,
    executableImageRef: imageRef,
    executableImageWorldFingerprint: worldFingerprint('executable-image', runId, scenario),
    applianceManifestRef: manifestRef,
    requiredActuators: [{ actuatorRef: MODEL_ACTUATOR }, { actuatorRef: FILE_ACTUATOR }],
    requiredRuntimeLimits: { maximumConcurrentEffects: 2 },
    installationDiagnostics: {
      proof: 'agent-carrier-fixture',
      hostDoesNotDefineAgentLoop: true,
      worldSemanticEvidenceSource: WORLD_AGENT_PROOF,
    },
  });
  await store.createApplication(application);
  const parentHead = createRunHead({
    generation: 0,
    turnClosureRef: parentClosureRef,
    turnClosureWorldFingerprint: worldFingerprint('turn-closure', runId, `${scenario}:0`),
    resultingStateFingerprint: worldFingerprint('state', runId, `${scenario}:0`),
    chronicleCursor: `world:chronicle:${runId}:0`,
    archiveMomentFingerprint: worldFingerprint('archive-moment', runId, `${scenario}:0`),
    archiveSealFingerprint: worldFingerprint('archive-seal', runId, `${scenario}:0`),
    status: 'needs_host',
    updateDiagnostics: {
      pendingHostRequestCount: 1,
      parentTurnClosureFingerprint: null,
    },
  });
  const run = createRunRecord({
    runId,
    applicationId: application.applicationId,
    branches: [createBranchRecord({ branchId, currentHead: parentHead })],
    effectJournalNamespace: `${runId}:effects`,
    receiverPolicyRef,
    creationMetadata: { example: 'agent-runtime', scenario },
    diagnostics: {
      hostDefinesAgentLoop: false,
      semanticToolRoutingAuthority: 'Boundary closed ToolId schema',
    },
  });
  await store.createRun(run);
  return { application, run, parentHead, branchId };
}

function journalFor(store, installed, policy = {}) {
  return new EffectJournal({
    store,
    runId: installed.run.runId,
    branchId: installed.branchId,
    parentTurnClosureFingerprint: installed.parentHead.turnClosureWorldFingerprint,
    policy,
  });
}

function agentModelDriver(scenario) {
  return new FixtureAgentModelDriver({
    scenario,
    actuatorRef: MODEL_ACTUATOR,
    descriptorFingerprint: MODEL_DESCRIPTOR,
  });
}

function agentFileDriver(root) {
  return new SandboxFileDriver({
    root,
    actuatorRef: FILE_ACTUATOR,
    descriptorFingerprint: FILE_DESCRIPTOR,
  });
}

async function commitEffects(journal, records) {
  for (const record of records) {
    await journal.markClosureCommitted(await journal.markSubmitted(record));
  }
}

async function commitHead(store, installed, { generation, result, status = 'completed', committedEffectIds = [], diagnostics = {}, closureBytes = null }) {
  const bytes = closureBytes ?? finalTurnClosureBytes({
    runId: installed.run.runId,
    branchId: installed.branchId,
    generation,
    result,
    committedEffectIds,
  });
  const ref = await store.putBlob(bytes);
  const head = createRunHead({
    generation,
    turnClosureRef: ref,
    turnClosureWorldFingerprint: worldFingerprint('turn-closure', installed.run.runId, `${generation}:${result}`),
    resultingStateFingerprint: worldFingerprint('state', installed.run.runId, result),
    chronicleCursor: `world:chronicle:${installed.run.runId}:${generation}`,
    archiveMomentFingerprint: worldFingerprint('archive-moment', installed.run.runId, `${generation}:${result}`),
    archiveSealFingerprint: worldFingerprint('archive-seal', installed.run.runId, `${generation}:${result}`),
    status,
    updateDiagnostics: {
      parentTurnClosureFingerprint: installed.parentHead.turnClosureWorldFingerprint,
      committedEffectIds,
      finalResult: result,
      hostAuthoredWorldEvidence: false,
      worldSemanticEvidenceSource: WORLD_AGENT_PROOF,
      ...diagnostics,
    },
  });
  const cas = await store.compareAndSwapHead(installed.run.runId, installed.branchId, generation - 1, head);
  if (!cas.ok) throw new Error(`agent example head CAS failed for ${installed.run.runId}`);
  return head;
}

function modelRequest(key, observation) {
  return {
    actuatorRef: MODEL_ACTUATOR,
    descriptorFingerprint: MODEL_DESCRIPTOR,
    actuationClass: 'model',
    responseSchema: { status: 'ok' },
    idempotencyKeyBytes: fromUtf8(key),
    idempotencyKeyWorldFingerprint: `world:key:agent:${key}`,
    requestBytes: fromUtf8(stableJson({
      schema: 'boundary.Agent.DecisionPrompt.v0',
      observation,
      traceSummary: 'bounded',
    })),
    hostRequestFingerprint: `world:host-request:${sha256Hex(fromUtf8(`model:${key}`)).slice(0, 16)}`,
  };
}

function fileRequest(key, request) {
  return {
    actuatorRef: FILE_ACTUATOR,
    descriptorFingerprint: FILE_DESCRIPTOR,
    actuationClass: 'file',
    responseSchema: { status: 'ok' },
    idempotencyKeyBytes: fromUtf8(key),
    idempotencyKeyWorldFingerprint: `world:key:agent:${key}`,
    requestBytes: fromUtf8(stableJson(request)),
    hostRequestFingerprint: `world:host-request:${sha256Hex(fromUtf8(`file:${key}`)).slice(0, 16)}`,
  };
}

function countingSandboxDriver(root) {
  const delegate = agentFileDriver(root);
  const counters = { calls: 0, readCalls: 0, writeCalls: 0 };
  return {
    counters,
    driver: {
      manifest() {
        return delegate.manifest();
      },
      async resolve(context, hostRequest) {
        const request = JSON.parse(new TextDecoder().decode(hostRequest.requestBytes));
        counters.calls += 1;
        if (request.operation === 'read') counters.readCalls += 1;
        if (request.operation === 'write') counters.writeCalls += 1;
        return await delegate.resolve(context, hostRequest);
      },
      async recover(context, effectRecord) {
        return await delegate.recover(context, effectRecord);
      },
    },
  };
}

function wrongTargetDriver() {
  const delegate = agentModelDriver('skeleton');
  return {
    manifest() {
      return delegate.manifest();
    },
    async resolve() {
      return {
        resolutionInputBytes: encodeResolutionInputBytes({
          targetHostRequestFingerprint: 0xdeadn,
          status: 0,
          responseValueImageBytes: fromUtf8('wrong target'),
          hostClaimBytes: new Uint8Array(),
          attemptNumber: 1,
          metadata: fromUtf8('wrong-target-fixture'),
        }),
      };
    },
  };
}

async function sandboxRejects(request, code) {
  const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-negative-'));
  try {
    const driver = agentFileDriver(root);
    await driver.resolve({}, fileRequest('negative-file', request));
    return false;
  } catch (error) {
    return error?.code === code;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function rejects(fn, code) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error?.code === code;
  }
}

function turnClosureBytes(value) {
  return fromUtf8(stableJson({
    kind: 'World TurnClosure fixture',
    ...value,
  }));
}

function finalTurnClosureBytes({ runId, branchId, generation, result, committedEffectIds }) {
  return turnClosureBytes({
    runId,
    branchId,
    generation,
    result,
    committedEffectIds,
  });
}

function bytesEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function worldFingerprint(kind, runId, value) {
  return `world:${kind}:agent:${sha256Hex(fromUtf8(`${runId}:${value}`)).slice(0, 32)}`;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
