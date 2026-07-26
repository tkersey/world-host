import { ApplicationWorker } from './application_worker.mjs';
import { assertBytes, fail } from './errors.mjs';
import { MemoryEffectJournalV1, admitJournalFuel } from './effect_journal.mjs';
import {
  FrameStatus,
  createEffectResult,
  decodeApplicationManifest,
  decodeEffectResult,
  decodeFrame,
  encodeStepInput,
} from './protocol.mjs';
import { makeHead } from './storage.mjs';

export class RunControllerV1 {
  #applicationBytes;
  #manifest;

  static async create({
    wasmBytes,
    blockStore,
    headStore,
    effectJournal = null,
    workerFactory = () => new ApplicationWorker(),
    preflight = async () => ({ blockers: [] }),
    faultInjector = async () => {},
  }) {
    if (!blockStore || !headStore) fail('ERR_APPLICATION_V1_CONTROLLER_STORE');
    const applicationBytes = Buffer.from(assertBytes(wasmBytes, 'wasmBytes'));
    const worker = await workerFactory();
    try {
      await worker.instantiate(applicationBytes);
      const manifest = worker.readManifest();
      const manifestBytes = Buffer.from(manifest.encodedBytes);
      const report = await preflight(manifest);
      if (!report || !Array.isArray(report.blockers)) fail('ERR_APPLICATION_V1_PREFLIGHT_REPORT');
      if (report.blockers.length !== 0) fail('ERR_APPLICATION_V1_PREFLIGHT_BLOCKED', 'receiver policy rejected application', { blockers: report.blockers });
      const retainedManifest = decodeApplicationManifest(manifestBytes);
      const wasmRef = await blockStore.putBlock(applicationBytes);
      const manifestRef = await blockStore.putBlock(retainedManifest.encodedBytes);
      return new RunControllerV1({
        applicationBytes,
        manifest: retainedManifest,
        wasmRef,
        manifestRef,
        blockStore,
        headStore,
        effectJournal: effectJournal ?? new MemoryEffectJournalV1({ blockStore }),
        workerFactory,
        faultInjector,
      });
    } finally {
      worker.dispose();
    }
  }

  static async importBranch({
    bundle,
    runId,
    branchId,
    blockStore,
    headStore,
    effectJournal = null,
    workerFactory = () => new ApplicationWorker(),
    preflight = async () => ({ blockers: [] }),
    faultInjector = async () => {},
  }) {
    const admitted = assertMigrationBundle(bundle);
    const journal = effectJournal ?? new MemoryEffectJournalV1({ blockStore });
    const controller = await RunControllerV1.create({
      wasmBytes: admitted.applicationWasmBytes,
      blockStore,
      headStore,
      effectJournal: journal,
      workerFactory,
      preflight,
      faultInjector,
    });
    if (!Buffer.from(controller.manifest.encodedBytes).equals(admitted.manifestBytes)) {
      fail('ERR_APPLICATION_V1_MIGRATION_MANIFEST');
    }
    if (hex(controller.manifest.applicationId) !== admitted.applicationId) {
      fail('ERR_APPLICATION_V1_MIGRATION_MANIFEST');
    }
    const frame = decodeFrame(admitted.frameBytes, controller.manifest.limits);
    if (hex(frame.applicationId) !== admitted.applicationId || hex(frame.frameId) !== admitted.frameId ||
        frame.status !== admitted.frameStatus) {
      fail('ERR_APPLICATION_V1_MIGRATION_FRAME');
    }
    const frameRef = await blockStore.putBlock(admitted.frameBytes);
    if (frameRef.checksum !== admitted.frameArtifactChecksum) fail('ERR_APPLICATION_V1_MIGRATION_FRAME');
    const head = makeHead({
      generation: 0,
      applicationId: admitted.applicationId,
      frameId: admitted.frameId,
      frameRef,
      status: admitted.frameStatus,
    });
    if (admitted.retainedEffectResultBytes !== null) {
      if (frame.status !== FrameStatus.needsEffect || frame.pendingEffect === null) fail('ERR_APPLICATION_V1_MIGRATION_RESULT');
      const result = decodeEffectResult(admitted.retainedEffectResultBytes, controller.manifest.limits);
      await journal.persistResult({
        runId,
        branchId,
        parentFrameId: frame.frameId,
        request: frame.pendingEffect,
        result,
        limits: controller.manifest.limits,
        handlerId: 'migration-import',
        handlerConfigurationId: 'receiver-independent-v1',
        recoveryClass: 'replayable',
        fuel: admitted.retainedEffectFuel,
      });
    }
    const advanced = await headStore.advanceHeadIfCurrent(runId, branchId, null, head);
    if (!advanced.advanced) fail('ERR_APPLICATION_V1_BRANCH_EXISTS');
    return Object.freeze({ controller, head: advanced.current });
  }

  constructor({
    applicationBytes,
    manifest,
    wasmRef,
    manifestRef,
    blockStore,
    headStore,
    effectJournal,
    workerFactory,
    faultInjector,
  }) {
    this.#applicationBytes = Buffer.from(applicationBytes);
    this.#manifest = manifest;
    this.wasmRef = wasmRef;
    this.manifestRef = manifestRef;
    this.blockStore = blockStore;
    this.headStore = headStore;
    this.effectJournal = effectJournal;
    this.workerFactory = workerFactory;
    this.faultInjector = faultInjector;
  }

  get manifest() {
    return decodeApplicationManifest(this.#manifest.encodedBytes, this.#manifest.limits);
  }

  get applicationWasmBytes() {
    return Buffer.from(this.#applicationBytes);
  }

  async initialize(runId, branchId, {
    initialArgsBytes,
    fuel = this.#manifest.limits.maximumFuelPerStep,
    hostMetadata = new Uint8Array(0),
  }) {
    const current = await this.headStore.readHead(runId, branchId);
    if (current !== null) fail('ERR_APPLICATION_V1_BRANCH_EXISTS');
    const input = encodeStepInput({
      applicationId: this.#manifest.applicationId,
      initialArgsBytes,
      fuel,
      hostMetadata,
    }, this.#manifest.limits);
    return this.#executeAndPublish(runId, branchId, null, input);
  }

  async advance(runId, branchId, {
    effectResult = null,
    fuel = null,
    hostMetadata = new Uint8Array(0),
    effectMetadata = {},
  } = {}) {
    const head = await this.headStore.readHead(runId, branchId);
    if (head === null) fail('ERR_APPLICATION_V1_BRANCH_NOT_FOUND');
    this.#assertHeadApplication(head);
    const parentBytes = await this.blockStore.getBlock(head.frameRef);
    const parent = decodeFrame(parentBytes, this.#manifest.limits);
    if (hex(parent.frameId) !== head.frameId || parent.status !== head.status) fail('ERR_APPLICATION_V1_HEAD_FRAME_MISMATCH');
    if (parent.status !== FrameStatus.needsEffect && parent.status !== FrameStatus.yieldedFuel) {
      fail('ERR_APPLICATION_V1_TERMINAL_FRAME');
    }

    let admittedResult = null;
    let stepFuel = fuel === null ? this.#manifest.limits.maximumFuelPerStep : fuel;
    if (parent.status === FrameStatus.needsEffect) {
      const request = parent.pendingEffect;
      if (effectResult !== null) {
        admittedResult = effectResult?.encodedBytes instanceof Uint8Array
          ? decodeEffectResult(effectResult.encodedBytes, this.#manifest.limits)
          : effectResult instanceof Uint8Array
            ? decodeEffectResult(effectResult, this.#manifest.limits)
            : createEffectResult(effectResult, this.#manifest.limits);
        const persisted = await this.effectJournal.persistResult({
          runId,
          branchId,
          parentFrameId: parent.frameId,
          request,
          result: admittedResult,
          limits: this.#manifest.limits,
          handlerId: effectMetadata.handlerId,
          handlerConfigurationId: effectMetadata.handlerConfigurationId,
          recoveryClass: effectMetadata.recoveryClass,
          externalTransactionRef: effectMetadata.externalTransactionRef,
          fuel: stepFuel,
        });
        await this.#fault('after-result-persistence', { runId, branchId, head, parent, persisted });
      } else {
        const retained = await this.effectJournal.readResult({
          runId,
          branchId,
          parentFrameId: parent.frameId,
          request,
          limits: this.#manifest.limits,
        });
        if (retained === null) fail('ERR_APPLICATION_V1_EFFECT_RESULT_REQUIRED');
        admittedResult = retained.result;
        if (retained.record.fuel === null) {
          if (fuel === null) fail('ERR_APPLICATION_V1_EFFECT_JOURNAL_FUEL_REQUIRED');
          stepFuel = BigInt(admitJournalFuel(fuel, this.#manifest.limits));
        } else {
          if (fuel !== null &&
              admitJournalFuel(fuel, this.#manifest.limits) !== retained.record.fuel) {
            fail('ERR_APPLICATION_V1_RETAINED_FUEL_MISMATCH');
          }
          stepFuel = BigInt(retained.record.fuel);
        }
      }
    } else if (effectResult !== null) {
      fail('ERR_APPLICATION_V1_UNEXPECTED_RESULT');
    }

    const input = encodeStepInput({
      applicationId: this.#manifest.applicationId,
      expectedParentFrameId: parent.frameId,
      priorFrameBytes: parentBytes,
      effectResult: admittedResult,
      fuel: stepFuel,
      hostMetadata,
    }, this.#manifest.limits);
    return this.#executeAndPublish(runId, branchId, head, input);
  }

  async forkBranch(runId, sourceBranchId, targetBranchId) {
    if (await this.headStore.readHead(runId, targetBranchId) !== null) {
      fail('ERR_APPLICATION_V1_BRANCH_EXISTS');
    }
    const current = await this.readCurrentFrame(runId, sourceBranchId);
    if (current === null) fail('ERR_APPLICATION_V1_BRANCH_NOT_FOUND');
    const source = current.head;
    const sourceFrame = current.frame;
    let copied = null;
    if (sourceFrame.status === FrameStatus.needsEffect) {
      copied = await this.effectJournal.copyResult({
        runId,
        sourceBranchId,
        targetBranchId,
        parentFrameId: sourceFrame.frameId,
        request: sourceFrame.pendingEffect,
        limits: this.#manifest.limits,
      });
      if (copied !== null) {
        await this.#fault('after-fork-result-persistence', {
          runId,
          sourceBranchId,
          targetBranchId,
          source,
          sourceFrame,
          copied,
        });
      }
    }
    const target = makeHead({ ...source, generation: 0 });
    const result = await this.headStore.advanceHeadIfCurrent(runId, targetBranchId, null, target);
    if (!result.advanced) fail('ERR_APPLICATION_V1_BRANCH_EXISTS');
    return result.current;
  }

  async exportBranch(runId, branchId) {
    const current = await this.readCurrentFrame(runId, branchId);
    if (current === null) fail('ERR_APPLICATION_V1_BRANCH_NOT_FOUND');
    let retainedEffectResultBytes = null;
    let retainedEffectFuel = null;
    if (current.frame.status === FrameStatus.needsEffect) {
      const retained = await this.effectJournal.readResult({
        runId,
        branchId,
        parentFrameId: current.frame.frameId,
        request: current.frame.pendingEffect,
        limits: this.#manifest.limits,
      });
      if (retained !== null) {
        retainedEffectResultBytes = Buffer.from(retained.result.encodedBytes);
        retainedEffectFuel = retained.record.fuel;
      }
    }
    return Object.freeze({
      bundleVersion: 'world-host.application-migration-v1',
      applicationId: hex(this.#manifest.applicationId),
      applicationWasmBytes: Buffer.from(this.#applicationBytes),
      manifestBytes: Buffer.from(this.#manifest.encodedBytes),
      sourceHeadGeneration: current.head.generation,
      frameId: hex(current.frame.frameId),
      frameArtifactChecksum: current.head.frameRef.checksum,
      frameStatus: current.frame.status,
      frameBytes: Buffer.from(current.frameBytes),
      retainedEffectResultBytes,
      retainedEffectFuel,
    });
  }

  async readCurrentFrame(runId, branchId) {
    const head = await this.headStore.readHead(runId, branchId);
    if (head === null) return null;
    this.#assertHeadApplication(head);
    const bytes = await this.blockStore.getBlock(head.frameRef);
    const frame = decodeFrame(bytes, this.#manifest.limits);
    if (hex(frame.frameId) !== head.frameId) fail('ERR_APPLICATION_V1_HEAD_FRAME_MISMATCH');
    return Object.freeze({ head, frameBytes: bytes, frame });
  }

  async #executeAndPublish(runId, branchId, expectedHead, inputBytes) {
    const worker = await this.workerFactory();
    let output;
    try {
      await worker.instantiate(this.#applicationBytes);
      output = worker.step(inputBytes);
    } finally {
      worker.dispose();
    }
    await this.#fault('after-world-step', { runId, branchId, expectedHead, output });
    const frameRef = await this.blockStore.putBlock(output.frameBytes);
    const requestRef = output.frame.pendingEffect === null
      ? null
      : await this.blockStore.putBlock(output.frame.pendingEffect.encodedBytes);
    const nextHead = makeHead({
      generation: expectedHead === null ? 0 : expectedHead.generation + 1,
      applicationId: hex(output.frame.applicationId),
      frameId: hex(output.frame.frameId),
      frameRef,
      status: output.frame.status,
    });
    await this.#fault('after-frame-persistence', { runId, branchId, expectedHead, output, frameRef, requestRef, nextHead });
    const advanced = await this.headStore.advanceHeadIfCurrent(runId, branchId, expectedHead, nextHead);
    if (!advanced.advanced) {
      return Object.freeze({
        status: 'conflict',
        expectedHead,
        currentHead: advanced.current,
        retainedFrameRef: frameRef,
        retainedFrame: output.frame,
      });
    }
    await this.#fault('after-head-advancement', { runId, branchId, previousHead: expectedHead, nextHead });
    return Object.freeze({
      status: 'advanced',
      previousHead: expectedHead,
      nextHead: advanced.current,
      frameRef,
      requestRef,
      frameBytes: output.frameBytes,
      frame: output.frame,
    });
  }

  async #fault(stage, context) {
    await this.faultInjector(stage, context);
  }

  #assertHeadApplication(head) {
    if (head.applicationId !== hex(this.#manifest.applicationId)) fail('ERR_APPLICATION_V1_HEAD_APPLICATION');
  }
}

function hex(value) {
  return Buffer.from(value).toString('hex');
}

function assertMigrationBundle(bundle) {
  if (!bundle || bundle.bundleVersion !== 'world-host.application-migration-v1' ||
      !/^[0-9a-f]{64}$/.test(bundle.applicationId) || !/^[0-9a-f]{64}$/.test(bundle.frameId) ||
      !/^[0-9a-f]{64}$/.test(bundle.frameArtifactChecksum) ||
      !Number.isSafeInteger(bundle.sourceHeadGeneration) || bundle.sourceHeadGeneration < 0 ||
      !Number.isInteger(bundle.frameStatus) || bundle.frameStatus < 0 || bundle.frameStatus > 4) {
    fail('ERR_APPLICATION_V1_MIGRATION_BUNDLE');
  }
  const retainedEffectResultBytes = bundle.retainedEffectResultBytes === null
    ? null
    : Buffer.from(assertBytes(bundle.retainedEffectResultBytes, 'retainedEffectResultBytes'));
  const retainedEffectFuel = bundle.retainedEffectFuel === null || bundle.retainedEffectFuel === undefined
    ? null
    : retainedFuel(bundle.retainedEffectFuel);
  if ((retainedEffectResultBytes === null) !== (retainedEffectFuel === null)) {
    fail('ERR_APPLICATION_V1_MIGRATION_RESULT');
  }
  return Object.freeze({
    bundleVersion: bundle.bundleVersion,
    applicationId: bundle.applicationId,
    applicationWasmBytes: Buffer.from(assertBytes(bundle.applicationWasmBytes, 'applicationWasmBytes')),
    manifestBytes: Buffer.from(assertBytes(bundle.manifestBytes, 'manifestBytes')),
    sourceHeadGeneration: bundle.sourceHeadGeneration,
    frameId: bundle.frameId,
    frameArtifactChecksum: bundle.frameArtifactChecksum,
    frameStatus: bundle.frameStatus,
    frameBytes: Buffer.from(assertBytes(bundle.frameBytes, 'frameBytes')),
    retainedEffectResultBytes,
    retainedEffectFuel,
  });
}

function retainedFuel(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || value.length > 20) {
    fail('ERR_APPLICATION_V1_MIGRATION_RESULT');
  }
  return value;
}
