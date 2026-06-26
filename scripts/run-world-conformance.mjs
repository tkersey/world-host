#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { EffectRecoveryClass } from '../src/core/actuator.mjs';
import { createApplicationRecord } from '../src/core/application.mjs';
import { EffectJournal, EffectState } from '../src/core/effect_journal.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../src/core/run.mjs';
import { RunController, WorldWorker, assertWarmWorkerBinding, worldHostRequestToEffectRequest } from '../src/core/worker.mjs';
import { fromUtf8 } from '../src/core/store.mjs';
import { encodeBootTurnInput, encodeContinueTurnInput, encodeResolutionInput, encodeResolutionInputBytes, encodeRestoreTurnInput } from '../src/protocol/world_appliance_wire_codec.mjs';
import { inspectTurnOutput, summarizeTurnClosureForRunHead } from '../src/protocol/world_universal_appliance_codec.mjs';
import { NodeWorldWorker, applianceStatus } from '../src/node/node_worker.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';

const args = parseArgs(process.argv.slice(2));

class DeterministicWorker extends WorldWorker {
  async submitTurn() {
    return turnResult(1);
  }
}

class TrackingNodeWorldWorker extends NodeWorldWorker {
  async submitTurn(turnInputBytes) {
    const result = await super.submitTurn(turnInputBytes);
    this.lastSubmitResult = {
      status: result.status,
      turnClosureBytes: new Uint8Array(result.turnClosureBytes),
    };
    return result;
  }
}

await workerIdentityConformance();
await controllerReplayConformance();
await deterministicRetryConformance();
if (args.worldRepo) await realWorldUniversalConformance(args.worldRepo);

console.log('world_conformance=passed');

async function workerIdentityConformance() {
  const worker = new WorldWorker();
  await worker.instantiate(fromUtf8('placeholder'));
  worker.bind(binding(0));
  assert.equal(assertWarmWorkerBinding(worker, binding(0)), true);
  assert.throws(() => assertWarmWorkerBinding(worker, binding(1)), { code: 'ERR_WARM_WORKER_IDENTITY_MISMATCH' });
  worker.dispose();
  assert.throws(() => worker.readRuntimeManifest(), /ERR_WORKER_DISPOSED/);
}

async function controllerReplayConformance() {
  const { store, runId, branchId } = await fixtureStore();
  const controller = new RunController({ store, workerFactory: async () => new DeterministicWorker() });
  const first = await controller.advance(runId, branchId, { turnResult: turnResult(1) });
  assert.equal(first.status, 'advanced');
  assert.equal((await store.readHead(runId, branchId)).turnClosureWorldFingerprint, 'world:turn-closure:0000000000000111');
}

async function deterministicRetryConformance() {
  const a = await fixtureStore('a');
  const b = await fixtureStore('b');
  const first = new RunController({ store: a.store, workerFactory: async () => new DeterministicWorker() });
  const second = new RunController({ store: b.store, workerFactory: async () => new DeterministicWorker() });
  const left = await first.advance(a.runId, a.branchId, { turnResult: turnResult(1) });
  const right = await second.advance(b.runId, b.branchId, { turnResult: turnResult(1) });
  assert.equal(left.nextHead.turnClosureWorldFingerprint, right.nextHead.turnClosureWorldFingerprint);
  assert.deepEqual(await a.store.getBlob(left.nextHead.turnClosureRef), await b.store.getBlob(right.nextHead.turnClosureRef));
}

async function realWorldUniversalConformance(worldRepo) {
  const candidates = await locateWorldArtifactCandidates(worldRepo);
  let selected = null;
  let lastError = null;
  for (const artifacts of candidates) {
    try {
      selected = await runRealWorldUniversalCandidate(artifacts);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!selected) {
    throw new Error(`no compatible World universal Appliance artifact pair found; last error: ${lastError?.stack ?? lastError}`);
  }

  const { artifacts, wasmBytes, proof, resultA, resultB } = selected;
  assert.equal(resultA.completed, true);
  assert.equal(resultA.hostRequestReady, true);
  assert.equal(resultA.rootResultReady, true);
  assert.equal(resultA.archiveAppendReady, true);
  assert.equal(resultB.completed, true);
  assert.equal(resultB.rootResultReady, true);
  assert.equal(resultB.archiveAppendReady, true);
  assert.equal(resultB.hostRequestReady, false);
  assert.equal(proof.programPlanANotEqualB, true);
  assert.equal(proof.rootModuleANotEqualB, true);
  assert.equal(proof.dispatchANotEqualB, true);
  assert.equal(proof.manifestANotEqualB, true);
  assert.equal(proof.imageAOnePort, true);
  assert.equal(proof.imageBLoadedProvider, true);
  const storeBackedBoot = await runRealStoreBackedRunControllerBoot(artifacts, wasmBytes);
  assert.equal(storeBackedBoot.advanced, true);
  assert.equal(storeBackedBoot.completed, true);
  assert.equal(storeBackedBoot.committedClosureMatchesWorkerOutput, true);
  assert.equal(storeBackedBoot.runheadFromTurnClosureInspection, true);
  const coldRestore = await runRealColdRestoreRunControllerConformance(artifacts, wasmBytes);
  assert.equal(coldRestore.advancedFromColdWorker, true);
  assert.equal(coldRestore.committedClosureMatchesFreshWorkerOutput, true);
  assert.equal(coldRestore.boundExactParentEvidence, true);
  const guestAllocation = await runRealWorkerGuestAllocationConformance(artifacts, wasmBytes);
  assert.equal(guestAllocation.exportReadBufferFreed, true);
  const journaledHostRequest = await runRealJournaledHostRequestRunControllerConformance(artifacts, wasmBytes);
  assert.equal(journaledHostRequest.bootedNeedsHost, true);
  assert.equal(journaledHostRequest.driverInvokedOnce, true);
  assert.equal(journaledHostRequest.reusedPersistedResolution, true);
  assert.equal(journaledHostRequest.completedAfterJournaledResolution, true);
  assert.equal(journaledHostRequest.committedClosureMatchesWorkerOutput, true);
  assert.equal(journaledHostRequest.effectClosureCommitted, true);

  console.log('actual_external_runtime_executed=true');
  console.log('empty_imports=true');
  console.log('native_helper_used=false');
  console.log('child_process_protocol_encoding=false');
  console.log('javascript_codec_independent=true');
  console.log(`universal_wasm_sha256=${sha256Hex(wasmBytes)}`);
  console.log(`universal_wasm_path=${artifacts.wasmPath}`);
  console.log(`fixture_dir=${path.dirname(artifacts.imageAPath)}`);
  console.log(`image_a_completed_output_sha256=${resultA.completedOutputSha256}`);
  console.log(`image_b_completed_output_sha256=${resultB.completedOutputSha256}`);
  console.log('root_result_bytes_ready=true');
  console.log('archive_append_batch_bytes_ready=true');
  console.log('store_backed_runcontroller_boot_advance=true');
  console.log('runhead_from_turnclosure_inspection=true');
  console.log('cold_restore_from_committed_turnclosure=true');
  console.log('guest_export_read_buffer_freed=true');
  console.log('journaled_host_request_continue=true');
  console.log('journaled_resolution_reused=true');
}

async function runRealWorldUniversalCandidate(artifacts) {
  const wasmBytes = await readFile(artifacts.wasmPath);
  const imageA = await readFile(artifacts.imageAPath);
  const imageB = await readFile(artifacts.imageBPath);
  const proof = inspectTwoProgramProof(await readFile(artifacts.proofPath, 'utf8'));
  const worker = new NodeWorldWorker();
  await worker.instantiate(wasmBytes);
  const manifest = worker.readRuntimeManifest();
  assert.equal(manifest.importCount, 0);
  assert.equal(manifest.abiVersion, 'v3');
  assert.equal(manifest.nativeHelperProcess, false);
  assert.equal(manifest.childProcessProtocolEncoding, false);

  const resultA = await loadAndRunImage(worker, imageA, 'carrier.fixture.a.reply');
  worker.unload();
  const resultB = await loadAndRunImage(worker, imageB, 'carrier.fixture.b.reply');
  worker.unload();
  worker.dispose();
  return { artifacts, wasmBytes, proof, resultA, resultB };
}

async function runRealStoreBackedRunControllerBoot(artifacts, wasmBytes) {
  const imageBytes = await readFile(artifacts.imageBPath);
  const manifestBytes = await readApplianceManifestBytes(wasmBytes, imageBytes);
  const store = new MemoryStore();
  const imageRef = await store.putBlob(imageBytes);
  const manifestRef = await store.putBlob(manifestBytes);
  const genesisClosureRef = await store.putBlob(fromUtf8('world-host:genesis'));
  const application = createApplicationRecord({
    applicationId: 'real-world-image-b',
    universalWasmChecksum: `sha256:${sha256Hex(wasmBytes)}`,
    worldProtocolVersion: 'v0.1.0',
    applianceAbiVersion: 'v3',
    executableImageRef: imageRef,
    executableImageWorldFingerprint: `world:executable-image:${sha256Hex(imageBytes)}`,
    applianceManifestRef: manifestRef,
    requiredActuators: [],
    requiredRuntimeLimits: {},
    installationDiagnostics: {
      proof: 'store-backed-runcontroller-boot',
    },
  });
  await store.createApplication(application);
  const parentHead = createRunHead({
    generation: 0,
    turnClosureRef: genesisClosureRef,
    turnClosureWorldFingerprint: 'world:turn-closure:genesis',
    resultingStateFingerprint: 'world:state:genesis',
    chronicleCursor: 'world:chronicle-cursor:genesis',
    archiveMomentFingerprint: 'world:archive-moment:genesis',
    archiveSealFingerprint: 'world:archive-seal:genesis',
    status: 'genesis',
  });
  const branch = createBranchRecord({ branchId: 'main', currentHead: parentHead });
  const run = createRunRecord({
    runId: 'real-world-runcontroller-boot',
    applicationId: application.applicationId,
    branches: [branch],
    effectJournalNamespace: 'real-world-runcontroller-boot:effects',
    diagnostics: {
      proof: 'store-backed-runcontroller-boot',
    },
  });
  await store.createRun(run);

  let trackingWorker = null;
  const controller = new RunController({
    store,
    wasmBytes,
    workerFactory: async () => {
      trackingWorker = new TrackingNodeWorldWorker();
      return trackingWorker;
    },
    turnInputFactory: async ({ worker }) => {
      assert.equal(worker, trackingWorker);
      const applianceManifest = worker.readApplianceManifest();
      assert.deepEqual(applianceManifest.bytes, manifestBytes);
      return encodeBootTurnInput({
        manifestFingerprint: applianceManifest.decoded.manifestFingerprint,
        metadata: 'carrier.store-backed.boot',
      });
    },
  });
  const advance = await controller.advance(run.runId, branch.branchId);
  assert.equal(advance.status, 'advanced');
  const nextHead = await store.readHead(run.runId, branch.branchId);
  const committedClosureBytes = await store.getBlob(nextHead.turnClosureRef);
  const committedSummary = inspectTurnOutput(committedClosureBytes);
  assert.deepEqual(committedClosureBytes, trackingWorker.lastSubmitResult.turnClosureBytes);
  assert.equal(nextHead.status, 'completed');
  assert.equal(committedSummary.hostRequestCount, 0);
  assert.equal(committedSummary.rootResultFingerprint !== null, true);
  assert.equal(nextHead.updateDiagnostics.inspectedTurnClosure.hostRequestCount, 0);
  assert.equal(nextHead.updateDiagnostics.inspectedTurnClosure.rootResultFingerprint !== null, true);
  trackingWorker.dispose();
  return {
    advanced: true,
    completed: true,
    committedClosureMatchesWorkerOutput: true,
    runheadFromTurnClosureInspection: nextHead.turnClosureWorldFingerprint.startsWith('world:turn-closure:'),
    committedClosureSha256: sha256Hex(committedClosureBytes),
  };
}

async function runRealColdRestoreRunControllerConformance(artifacts, wasmBytes) {
  const imageBytes = await readFile(artifacts.imageBPath);
  const manifestBytes = await readApplianceManifestBytes(wasmBytes, imageBytes);
  const store = new MemoryStore();
  const imageRef = await store.putBlob(imageBytes);
  const manifestRef = await store.putBlob(manifestBytes);
  const genesisClosureRef = await store.putBlob(fromUtf8('world-host:genesis'));
  const application = createApplicationRecord({
    applicationId: 'real-world-cold-restore-image-b',
    universalWasmChecksum: `sha256:${sha256Hex(wasmBytes)}`,
    worldProtocolVersion: 'v0.1.0',
    applianceAbiVersion: 'v3',
    executableImageRef: imageRef,
    executableImageWorldFingerprint: `world:executable-image:${sha256Hex(imageBytes)}`,
    applianceManifestRef: manifestRef,
    requiredActuators: [],
    requiredRuntimeLimits: {},
    installationDiagnostics: {
      proof: 'cold-restore-runcontroller',
    },
  });
  await store.createApplication(application);
  const genesisHead = createRunHead({
    generation: 0,
    turnClosureRef: genesisClosureRef,
    turnClosureWorldFingerprint: 'world:turn-closure:genesis',
    resultingStateFingerprint: 'world:state:genesis',
    chronicleCursor: 'world:chronicle-cursor:genesis',
    archiveMomentFingerprint: 'world:archive-moment:genesis',
    archiveSealFingerprint: 'world:archive-seal:genesis',
    status: 'genesis',
  });
  const branch = createBranchRecord({ branchId: 'main', currentHead: genesisHead });
  const run = createRunRecord({
    runId: 'real-world-cold-restore',
    applicationId: application.applicationId,
    branches: [branch],
    effectJournalNamespace: 'real-world-cold-restore:effects',
    diagnostics: {
      proof: 'cold-restore-runcontroller',
    },
  });
  await store.createRun(run);

  let bootWorker = null;
  const bootController = new RunController({
    store,
    wasmBytes,
    workerFactory: async () => {
      bootWorker = new TrackingNodeWorldWorker();
      return bootWorker;
    },
    turnInputFactory: async ({ worker }) => {
      assert.equal(worker, bootWorker);
      const applianceManifest = worker.readApplianceManifest();
      return encodeBootTurnInput({
        manifestFingerprint: applianceManifest.decoded.manifestFingerprint,
        metadata: 'carrier.cold-restore.boot',
      });
    },
  });
  const bootAdvance = await bootController.advance(run.runId, branch.branchId);
  assert.equal(bootAdvance.status, 'advanced');
  const bootHead = await store.readHead(run.runId, branch.branchId);
  const parentClosureBytes = await store.getBlob(bootHead.turnClosureRef);
  assert.deepEqual(parentClosureBytes, bootWorker.lastSubmitResult.turnClosureBytes);
  bootWorker.dispose();

  let restoreWorker = null;
  let boundExactParentEvidence = false;
  const restoreController = new RunController({
    store,
    wasmBytes,
    workerFactory: async () => {
      restoreWorker = new TrackingNodeWorldWorker();
      return restoreWorker;
    },
    turnInputFactory: async ({ worker, parentHead, parentClosureBytes: currentParentClosureBytes }) => {
      assert.equal(worker, restoreWorker);
      assert.notEqual(worker, bootWorker);
      assert.equal(parentHead.generation, 1);
      assert.deepEqual(currentParentClosureBytes, parentClosureBytes);
      const applianceManifest = worker.readApplianceManifest();
      assert.deepEqual(applianceManifest.bytes, manifestBytes);
      const parentSummary = inspectTurnOutput(currentParentClosureBytes);
      boundExactParentEvidence =
        parentSummary.closureFingerprint !== 0n &&
        parentSummary.resultingStateFingerprint !== 0n &&
        parentSummary.turnReceipt.receiptFingerprint !== 0n &&
        parentSummary.turnSequenceNumber + 1n === 1n;
      return encodeRestoreTurnInput({
        manifestFingerprint: applianceManifest.decoded.manifestFingerprint,
        parentTurnClosureBytes: currentParentClosureBytes,
        expectedParentClosureFingerprint: parentSummary.closureFingerprint,
        expectedParentStateFingerprint: parentSummary.resultingStateFingerprint,
        previousTurnReceiptFingerprint: parentSummary.turnReceipt.receiptFingerprint,
        turnSequenceNumber: parentSummary.turnSequenceNumber + 1n,
        metadata: 'carrier.cold-restore.restore',
      });
    },
  });
  const restoreAdvance = await restoreController.advance(run.runId, branch.branchId);
  assert.equal(restoreAdvance.status, 'advanced');
  const restoredHead = await store.readHead(run.runId, branch.branchId);
  const restoredClosureBytes = await store.getBlob(restoredHead.turnClosureRef);
  const restoredSummary = inspectTurnOutput(restoredClosureBytes);
  assert.equal(restoredHead.generation, 2);
  assert.equal(restoredSummary.turnSequenceNumber, 1n);
  assert.deepEqual(restoredClosureBytes, restoreWorker.lastSubmitResult.turnClosureBytes);
  assert.notDeepEqual(restoredClosureBytes, parentClosureBytes);
  const advancedFromColdWorker = bootWorker.disposed === true && restoreWorker !== bootWorker;
  restoreWorker.dispose();
  return {
    advancedFromColdWorker,
    committedClosureMatchesFreshWorkerOutput: true,
    boundExactParentEvidence,
    restoredClosureSha256: sha256Hex(restoredClosureBytes),
  };
}

async function runRealWorkerGuestAllocationConformance(artifacts, wasmBytes) {
  const imageBytes = await readFile(artifacts.imageAPath);
  const worker = new NodeWorldWorker();
  await worker.instantiate(wasmBytes);
  await worker.loadExecutable(imageBytes);
  const manifestLen = worker.instance.exports.world_appliance_manifest_len();
  const ptr = worker.instance.exports.world_appliance_alloc(manifestLen);
  assert.notEqual(ptr, 0);
  worker.instance.exports.world_appliance_free(ptr, manifestLen);
  worker.readApplianceManifest();
  const reusedPtr = worker.instance.exports.world_appliance_alloc(manifestLen);
  worker.instance.exports.world_appliance_free(reusedPtr, manifestLen);
  worker.dispose();
  return {
    exportReadBufferFreed: reusedPtr === ptr,
  };
}

async function runRealJournaledHostRequestRunControllerConformance(artifacts, wasmBytes) {
  const imageBytes = await readFile(artifacts.imageAPath);
  const manifestBytes = await readApplianceManifestBytes(wasmBytes, imageBytes);
  const store = new MemoryStore();
  const imageRef = await store.putBlob(imageBytes);
  const manifestRef = await store.putBlob(manifestBytes);
  const genesisClosureRef = await store.putBlob(fromUtf8('world-host:genesis'));
  const application = createApplicationRecord({
    applicationId: 'real-world-journaled-host-request-image-a',
    universalWasmChecksum: `sha256:${sha256Hex(wasmBytes)}`,
    worldProtocolVersion: 'v0.1.0',
    applianceAbiVersion: 'v3',
    executableImageRef: imageRef,
    executableImageWorldFingerprint: `world:executable-image:${sha256Hex(imageBytes)}`,
    applianceManifestRef: manifestRef,
    requiredActuators: [],
    requiredRuntimeLimits: {},
    installationDiagnostics: {
      proof: 'journaled-host-request-runcontroller',
    },
  });
  await store.createApplication(application);
  const genesisHead = createRunHead({
    generation: 0,
    turnClosureRef: genesisClosureRef,
    turnClosureWorldFingerprint: 'world:turn-closure:genesis',
    resultingStateFingerprint: 'world:state:genesis',
    chronicleCursor: 'world:chronicle-cursor:genesis',
    archiveMomentFingerprint: 'world:archive-moment:genesis',
    archiveSealFingerprint: 'world:archive-seal:genesis',
    status: 'genesis',
  });
  const branch = createBranchRecord({ branchId: 'main', currentHead: genesisHead });
  const run = createRunRecord({
    runId: 'real-world-journaled-host-request',
    applicationId: application.applicationId,
    branches: [branch],
    effectJournalNamespace: 'real-world-journaled-host-request:effects',
    diagnostics: {
      proof: 'journaled-host-request-runcontroller',
    },
  });
  await store.createRun(run);

  let activeWorker = null;
  const controller = new RunController({
    store,
    wasmBytes,
    effectDrivers: [],
    workerFactory: async () => {
      activeWorker = new TrackingNodeWorldWorker();
      return activeWorker;
    },
    turnInputFactory: async ({ parentHead, parentClosureBytes }) => {
      if (parentHead.generation === 0) {
        const applianceManifest = activeWorker.readApplianceManifest();
        assert.deepEqual(applianceManifest.bytes, manifestBytes);
        return encodeBootTurnInput({
          manifestFingerprint: applianceManifest.decoded.manifestFingerprint,
          metadata: 'carrier.journaled-host-request.boot',
        });
      }

      throw new Error(`unexpected fallback turnInputFactory call for generation ${parentHead.generation}`);
    },
  });

  const bootAdvance = await controller.advance(run.runId, branch.branchId);
  assert.equal(bootAdvance.status, 'advanced');
  const needsHostHead = await store.readHead(run.runId, branch.branchId);
  const needsHostClosureBytes = await store.getBlob(needsHostHead.turnClosureRef);
  const needsHostSummary = inspectTurnOutput(needsHostClosureBytes);
  assert.equal(needsHostSummary.hostRequestCount, 1);
  assert.equal(needsHostHead.status, 'needs_host');
  const request = needsHostSummary.hostRequests[0];
  const journalRequest = worldHostRequestToEffectRequest(request);
  let driverInvocationCount = 0;
  const driver = {
    manifest() {
      return {
        driverId: 'carrier.conformance.journaled-host-request',
        supportedActuatorRefs: [journalRequest.actuatorRef],
        supportedDescriptorFingerprints: [journalRequest.descriptorFingerprint],
        supportedActuationClasses: [journalRequest.actuationClass],
        supportedResponseStatuses: [journalRequest.responseSchema.status],
        maximumRequestBytes: 4096,
        maximumResponseBytes: 4096,
        recoveryClass: EffectRecoveryClass.pure,
        concurrencyLimit: 1,
        authorityLabels: ['fixture'],
        diagnostics: {
          proof: 'journaled-host-request-runcontroller',
        },
      };
    },
    async resolve() {
      driverInvocationCount += 1;
      return {
        resolutionInputBytes: encodeResolutionInputBytes(encodeResolutionInput({
          request,
          responseFingerprint: 0x600d0001n,
          metadata: 'carrier.journaled-host-request.response',
        })),
        diagnostics: {
          driverInvocationCount,
        },
      };
    },
  };
  const journal = new EffectJournal({
    store,
    runId: run.runId,
    branchId: branch.branchId,
    parentTurnClosureFingerprint: needsHostHead.turnClosureWorldFingerprint,
  });
  const firstResolution = await journal.resolve({ proof: 'first-resolution' }, journalRequest, driver);
  assert.equal(firstResolution.reused, false);

  controller.effectDrivers = [driver];
  const continueAdvance = await controller.advance(run.runId, branch.branchId);
  assert.equal(continueAdvance.status, 'advanced');
  assert.equal(driverInvocationCount, 1);
  const completedHead = await store.readHead(run.runId, branch.branchId);
  const completedClosureBytes = await store.getBlob(completedHead.turnClosureRef);
  const completedSummary = inspectTurnOutput(completedClosureBytes);
  assert.equal(completedSummary.hostRequestCount, 0);
  assert.equal(completedHead.status, 'completed');
  assert.equal(completedSummary.rootResultFingerprint !== null, true);
  assert.equal(completedSummary.archiveAppendFingerprint !== null, true);
  assert.deepEqual(completedClosureBytes, activeWorker.lastSubmitResult.turnClosureBytes);
  const listedEffects = await journal.list();
  assert.equal(listedEffects.length, 1);
  const committedEffect = listedEffects[0];
  assert.equal(committedEffect.state, EffectState.closureCommitted);
  assert.deepEqual(await store.getBlob(committedEffect.resolutionInputRef), firstResolution.resolutionInputBytes);
  activeWorker.dispose();
  return {
    bootedNeedsHost: true,
    driverInvokedOnce: driverInvocationCount === 1,
    reusedPersistedResolution: driverInvocationCount === 1,
    completedAfterJournaledResolution: completedHead.status === 'completed',
    committedClosureMatchesWorkerOutput: true,
    effectClosureCommitted: committedEffect.state === EffectState.closureCommitted,
    completedClosureSha256: sha256Hex(completedClosureBytes),
  };
}

async function readApplianceManifestBytes(wasmBytes, imageBytes) {
  const worker = new NodeWorldWorker();
  await worker.instantiate(wasmBytes);
  await worker.loadExecutable(imageBytes);
  const manifest = worker.readApplianceManifest();
  worker.dispose();
  return manifest.bytes;
}

async function loadAndRunImage(worker, imageBytes, replyMetadata) {
  await worker.loadExecutable(imageBytes);
  const applianceManifest = worker.readApplianceManifest().decoded;
  const bootTurn = encodeBootTurnInput({
    manifestFingerprint: applianceManifest.manifestFingerprint,
    metadata: `${replyMetadata}:boot`,
  });
  const boot = await worker.submitTurn(bootTurn);
  if (boot.status === applianceStatus.completed) {
    return completedRunSummary(boot.turnClosureBytes, inspectTurnOutput(boot.turnClosureBytes), false);
  }
  assert.equal(boot.status, applianceStatus.needsHost);
  const needsHostSummary = inspectTurnOutput(boot.turnClosureBytes);
  assert.equal(needsHostSummary.hostRequestCount > 0, true);
  const resolution = encodeResolutionInput({
    request: needsHostSummary.hostRequests[0],
    responseFingerprint: 0x600d0001n,
    metadata: replyMetadata,
  });
  const continueTurn = encodeContinueTurnInput({
    manifestFingerprint: needsHostSummary.manifestFingerprint,
    previousTurnReceiptFingerprint: needsHostSummary.turnReceipt.receiptFingerprint,
    turnSequenceNumber: needsHostSummary.turnSequenceNumber + 1n,
    resolutions: [resolution],
    metadata: `${replyMetadata}:continue`,
  });
  const reply = await worker.submitTurn(continueTurn);
  assert.equal(reply.status, applianceStatus.completed);
  return completedRunSummary(reply.turnClosureBytes, inspectTurnOutput(reply.turnClosureBytes), true);
}

function completedRunSummary(completedOutput, completedSummary, hostRequestReady) {
  return {
    outputReady: true,
    hostRequestReady,
    completed: completedSummary.status === 2 && completedSummary.hostRequestCount === 0,
    rootResultReady: completedSummary.rootResultFingerprint !== null && completedSummary.rootResultBytesLen > 0,
    archiveAppendReady: completedSummary.archiveAppendFingerprint !== null && completedSummary.archiveAppendBytesLen > 0,
    completedOutputSha256: sha256Hex(completedOutput),
    rootResultFingerprint: fingerprintString(completedSummary.rootResultFingerprint),
    archiveAppendFingerprint: fingerprintString(completedSummary.archiveAppendFingerprint),
  };
}

async function locateWorldArtifactCandidates(worldRepo) {
  const root = path.resolve(worldRepo);
  const cacheRoot = path.join(root, '.zig-cache/o');
  const wasmPaths = await findNamedFiles(cacheRoot, 'world_universal_appliance.wasm');
  const installedWasm = path.join(root, 'zig-out/bin/world_universal_appliance.wasm');
  if (await isReadableFile(installedWasm)) wasmPaths.unshift(installedWasm);
  if (wasmPaths.length === 0) {
    throw new Error(`World universal WASM not found under ${root}; run zig build check-world-universal-appliance-node in the World repo`);
  }
  const fixtureDirs = await fixtureDirectories(cacheRoot);
  const candidates = [];
  for (const wasmPath of wasmPaths) {
    for (const fixtureDir of fixtureDirs) {
      candidates.push({
        wasmPath,
        imageAPath: path.join(fixtureDir, 'world-universal-image-a.bin'),
        commandAPath: path.join(fixtureDir, 'world-universal-command-a.bin'),
        imageBPath: path.join(fixtureDir, 'world-universal-image-b.bin'),
        commandBPath: path.join(fixtureDir, 'world-universal-command-b.bin'),
        proofPath: path.join(fixtureDir, 'world-universal-proof.txt'),
      });
    }
  }
  return candidates;
}

async function fixtureDirectories(cacheRoot) {
  const dirs = [];
  for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(cacheRoot, entry.name);
    const required = [
      'world-universal-image-a.bin',
      'world-universal-command-a.bin',
      'world-universal-image-b.bin',
      'world-universal-command-b.bin',
      'world-universal-proof.txt',
    ];
    const stats = await Promise.all(required.map((name) => stat(path.join(dir, name)).catch(() => null)));
    if (stats.every(Boolean)) dirs.push({ dir, mtimeMs: Math.max(...stats.map((item) => item.mtimeMs)) });
  }
  if (dirs.length === 0) {
    throw new Error(`real World fixture artifacts not found under ${cacheRoot}; run zig build check-world-universal-appliance-node in the World repo`);
  }
  dirs.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return dirs.map((entry) => entry.dir);
}

async function findNamedFiles(root, name) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...await findNamedFiles(fullPath, name));
    } else if (entry.isFile() && entry.name === name) {
      found.push(fullPath);
    }
  }
  found.sort();
  return found;
}

async function isReadableFile(filePath) {
  const fileStat = await stat(filePath).catch(() => null);
  return fileStat?.isFile() === true;
}

function inspectTwoProgramProof(text) {
  const facts = parseProofFacts(text);
  const read = (key) => {
    const value = facts.get(key);
    if (value === undefined || value.length === 0) throw new Error(`missing proof fact ${key}`);
    return value;
  };
  const readInt = (key) => {
    const value = Number(read(key));
    if (!Number.isSafeInteger(value)) throw new Error(`invalid numeric proof fact ${key}`);
    return value;
  };
  return {
    programPlanANotEqualB: read('program_plan_a_hash') !== read('program_plan_b_hash'),
    rootModuleANotEqualB: read('root_module_a_fingerprint') !== read('root_module_b_fingerprint'),
    dispatchANotEqualB: read('dispatch_a_fingerprint') !== read('dispatch_b_fingerprint'),
    manifestANotEqualB: read('manifest_a_fingerprint') !== read('manifest_b_fingerprint'),
    imageAOnePort:
      readInt('module_count_a') === 1 &&
      readInt('external_binding_count_a') === 1 &&
      readInt('route_count_a') === 0,
    imageBLoadedProvider:
      readInt('module_count_b') > 1 &&
      readInt('external_binding_count_b') === 0 &&
      readInt('route_count_b') > 0 &&
      readInt('provider_module_count_b') > 0,
  };
}

function parseProofFacts(text) {
  const facts = new Map();
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) throw new Error(`malformed proof fact: ${line}`);
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1);
    if (facts.has(key)) throw new Error(`duplicate proof fact: ${key}`);
    facts.set(key, value);
  }
  return facts;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fingerprintString(value) {
  return value === null ? null : value.toString(16).padStart(16, '0');
}

function parseArgs(values) {
  const parsed = { worldRepo: null };
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === '--world-repo') {
      parsed.worldRepo = values[++i];
      if (!parsed.worldRepo) throw new Error('--world-repo requires a path');
      continue;
    }
    throw new Error(`unknown argument: ${value}`);
  }
  return parsed;
}

async function fixtureStore(prefix = 'run') {
  const store = new MemoryStore();
  const imageRef = await store.putBlob(fromUtf8(`${prefix}:image`));
  const manifestRef = await store.putBlob(fromUtf8(`${prefix}:manifest`));
  const closureBytes = fixtureTurnClosureBytes();
  const closureSummary = summarizeTurnClosureForRunHead(closureBytes);
  const closureRef = await store.putBlob(closureBytes);
  const application = createApplicationRecord({
    applicationId: `${prefix}:app`,
    universalWasmChecksum: 'sha256:fixture',
    worldProtocolVersion: 'v0.1.0',
    applianceAbiVersion: 'v3',
    executableImageRef: imageRef,
    executableImageWorldFingerprint: 'world:image',
    applianceManifestRef: manifestRef,
    requiredActuators: [],
    requiredRuntimeLimits: {},
    installationDiagnostics: {},
  });
  await store.createApplication(application);
  const head = createRunHead({
    generation: 0,
    turnClosureRef: closureRef,
    turnClosureWorldFingerprint: closureSummary.turnClosureWorldFingerprint,
    resultingStateFingerprint: closureSummary.resultingStateFingerprint,
    chronicleCursor: closureSummary.chronicleCursor,
    archiveMomentFingerprint: closureSummary.archiveMomentFingerprint,
    archiveSealFingerprint: closureSummary.archiveSealFingerprint,
    status: closureSummary.status,
  });
  const branch = createBranchRecord({ branchId: 'main', currentHead: head });
  const run = createRunRecord({ runId: `${prefix}:run`, applicationId: application.applicationId, branches: [branch], effectJournalNamespace: `${prefix}:effects` });
  await store.createRun(run);
  return { store, runId: run.runId, branchId: branch.branchId };
}

function binding(turnSequence) {
  return {
    applicationId: 'app',
    branchId: 'main',
    turnClosureWorldFingerprint: 'world:closure:0',
    resultingStateFingerprint: 'world:state:0',
    turnSequence,
  };
}

function turnResult(index) {
  return {
    turnClosureBytes: fixtureTurnClosureBytes(),
    turnClosureWorldFingerprint: `world:closure:${index}`,
    resultingStateFingerprint: `world:state:${index}`,
    chronicleCursor: `cursor:${index}`,
    archiveMomentFingerprint: `archive:moment:${index}`,
    archiveSealFingerprint: `archive:seal:${index}`,
    status: 'completed',
  };
}

function fixtureTurnClosureBytes() {
  const turnReceiptBytes = concat([
    u32(1),
    u32(1),
    u64(0x701n),
    u64(0x211n),
    u64(1n),
    u64(0x301n),
    optionalU64(null),
    u64Slice([]),
    u64Slice([]),
    optionalU64(null),
    u64(0xc01n),
    optionalU64(0xa00n),
    optionalU64(0xa01n),
    optionalU64(0xa02n),
    optionalU64(0xa03n),
    optionalU64(0xb01n),
    u8(2),
    optionalU64(null),
    u64(0n),
    u64(0n),
  ]);
  return concat([
    u32(1),
    u32(1),
    u64(0x111n),
    u64(0x112n),
    u64(0x211n),
    optionalU64(null),
    u64(1n),
    u64(0x301n),
    u64(0x302n),
    u64(0x303n),
    u64(0x304n),
    optionalU64(null),
    optionalU64(null),
    optionalU64(null),
    optionalU64(null),
    u64(0x401n),
    bytes(new Uint8Array()),
    u64(0x501n),
    bytes(new Uint8Array()),
    u64(0x601n),
    bytes(turnReceiptBytes),
    bytes(new Uint8Array()),
    optionalU64(0xa00n),
    bytes(Uint8Array.of(1, 2, 3)),
    bytes(new Uint8Array()),
    optionalU64(0xb01n),
    bytes(Uint8Array.of(4)),
    optionalU64(null),
    optionalU64(null),
    bytes(new Uint8Array()),
    u64Slice([]),
    byteSlices([]),
    u64Slice([]),
    byteSlices([]),
    u64Slice([]),
    u64Slice([]),
    u64Slice([]),
    bytes(new Uint8Array()),
    u8(2),
  ]);
}

function u8(value) {
  return Uint8Array.of(Number(value) & 0xff);
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, Number(value), true);
  return out;
}

function u64(value) {
  const out = new Uint8Array(8);
  const actual = BigInt.asUintN(64, BigInt(value));
  const view = new DataView(out.buffer);
  view.setUint32(0, Number(actual & 0xffff_ffffn), true);
  view.setUint32(4, Number((actual >> 32n) & 0xffff_ffffn), true);
  return out;
}

function optionalU64(value) {
  return value == null ? u8(0) : concat([u8(1), u64(value)]);
}

function bytes(value) {
  return concat([u32(value.length), value]);
}

function u64Slice(values) {
  return concat([u64(values.length), ...values.map(u64)]);
}

function byteSlices(values) {
  return concat([u64(values.length), ...values.map(bytes)]);
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
