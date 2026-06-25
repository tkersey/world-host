import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EffectRecoveryClass } from '../src/core/actuator.mjs';
import { createApplicationRecord } from '../src/core/application.mjs';
import { EffectState } from '../src/core/effect_journal.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../src/core/run.mjs';
import { RunController, WorldWorker, assertWarmWorkerBinding } from '../src/core/worker.mjs';
import { fromUtf8 } from '../src/core/store.mjs';
import { encodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';

describe('RunController and WorldWorker', () => {
  it('advances a branch only after persisting the next closure blob', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const closureBytes = fixtureTurnClosureBytes();
    const controller = new RunController({ store, workerFactory: async () => new ScriptedWorker() });
    const result = await controller.advance(runId, branchId, {
      turnResult: turnResult(1),
    });

    assert.equal(result.status, 'advanced');
    assert.equal(result.nextHead.generation, 1);
    assert.deepEqual(await store.getBlob(result.nextHead.turnClosureRef), closureBytes);
  });

  it('rebinds the warm worker to the committed branch head after CAS success', async () => {
    const { store, runId, branchId } = await fixtureStore();
    let worker = null;
    const controller = new RunController({
      store,
      workerFactory: async () => {
        worker = new ScriptedWorker();
        return worker;
      },
    });

    const result = await controller.advance(runId, branchId, {
      turnResult: turnResult(1),
    });

    assert.equal(result.status, 'advanced');
    assert.equal(assertWarmWorkerBinding(worker, binding({
      turnClosureWorldFingerprint: 'world:turn-closure:0000000000000111',
      resultingStateFingerprint: 'world:state:0000000000000302',
      turnSequence: 1,
    })), true);
  });

  it('does not reload an unchanged executable on a valid warm worker', async () => {
    const { store, runId, branchId } = await fixtureStore();
    let worker = null;
    const controller = new RunController({
      store,
      workerFactory: async () => {
        worker = new CountingLoadWorker();
        return worker;
      },
    });

    await controller.advance(runId, branchId, { turnResult: turnResult(1) });
    await controller.advance(runId, branchId, { turnResult: turnResult(2) });

    assert.equal(worker.loadCount, 1);
  });

  it('resolves pending host requests through EffectJournal before fallback turn input', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(),
    });
    let fallbackCalled = false;
    const driver = fixtureEffectDriver();
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes()),
      effectDrivers: [driver],
      turnInputFactory: async () => {
        fallbackCalled = true;
        throw new Error('fallback should not be called');
      },
    });

    const result = await controller.advance(runId, branchId);
    const effects = await store.listEffectRecords(runId);

    assert.equal(result.status, 'advanced');
    assert.equal(fallbackCalled, false);
    assert.equal(driver.invocationCount, 1);
    assert.equal(result.effects.length, 1);
    assert.equal(result.effects[0].state, EffectState.closureCommitted);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].state, EffectState.closureCommitted);
  });

  it('does not mark resolved effects closure_committed on CAS conflict', async () => {
    const { store, runId, branchId, head } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(),
    });
    const winningRef = await store.putBlob(fromUtf8('winner'));
    const winningHead = createRunHead({
      ...head,
      generation: 1,
      turnClosureRef: winningRef,
      turnClosureWorldFingerprint: 'world:closure:winner',
      resultingStateFingerprint: 'world:state:winner',
    });
    const controller = new RunController({
      store: conflictStore(store, winningHead),
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes()),
      effectDrivers: [fixtureEffectDriver()],
    });

    const result = await controller.advance(runId, branchId);
    const effects = await store.listEffectRecords(runId);

    assert.equal(result.status, 'branch_conflict');
    assert.equal(result.submittedEffects.length, 0);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].state, EffectState.resolved);
  });

  it('batches host requests with bounded concurrency and canonical resolution order', async () => {
    const requests = [
      fixtureHostRequestBytes({ requestFingerprint: 0xa01n, requestOrdinal: 0, idempotencyKey: 'idempotency-key:1', idempotencyKeyFingerprint: 0xa09n }),
      fixtureHostRequestBytes({ requestFingerprint: 0xa02n, requestOrdinal: 1, idempotencyKey: 'idempotency-key:2', idempotencyKeyFingerprint: 0xa19n }),
      fixtureHostRequestBytes({ requestFingerprint: 0xa03n, requestOrdinal: 2, idempotencyKey: 'idempotency-key:3', idempotencyKeyFingerprint: 0xa29n }),
    ];
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(requests),
    });
    const worker = new CaptureTurnInputWorker(fixtureTurnClosureBytes());
    const driver = delayedBatchDriver();
    const controller = new RunController({
      store,
      workerFactory: async () => worker,
      effectDrivers: [driver],
      effectPolicy: { maximumConcurrentEffects: 2 },
    });

    const result = await controller.advance(runId, branchId);
    const effects = await store.listEffectRecords(runId);

    assert.equal(result.status, 'advanced');
    assert.equal(driver.maxRunning, 2);
    assert.deepEqual(driver.completions, ['world:host-request:0000000000000a02', 'world:host-request:0000000000000a01', 'world:host-request:0000000000000a03']);
    assert.equal(effects.length, 3);
    assert.equal(effects.every((record) => record.state === EffectState.closureCommitted), true);
    assert.equal(indexOfBytes(worker.submittedTurnInputBytes, fromUtf8('response:0000000000000a01')) < indexOfBytes(worker.submittedTurnInputBytes, fromUtf8('response:0000000000000a02')), true);
    assert.equal(indexOfBytes(worker.submittedTurnInputBytes, fromUtf8('response:0000000000000a02')) < indexOfBytes(worker.submittedTurnInputBytes, fromUtf8('response:0000000000000a03')), true);
  });

  it('skips ineligible effect drivers before selecting a resolver', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({ requestFingerprint: 0xa01n })]),
    });
    const worker = new CaptureTurnInputWorker(fixtureTurnClosureBytes());
    const selected = fixtureEffectDriver();
    const controller = new RunController({
      store,
      workerFactory: async () => worker,
      effectDrivers: [tooSmallEffectDriver(), selected],
    });

    const result = await controller.advance(runId, branchId);

    assert.equal(result.status, 'advanced');
    assert.equal(selected.invocationCount, 1);
  });

  it('fails closed on uncovered host requests unless partial batches are allowed', async () => {
    const requests = [
      fixtureHostRequestBytes({ requestFingerprint: 0xa01n, requestOrdinal: 0, idempotencyKey: 'idempotency-key:1', idempotencyKeyFingerprint: 0xa09n }),
      fixtureHostRequestBytes({ requestFingerprint: 0xa02n, requestOrdinal: 1, idempotencyKey: 'idempotency-key:2', idempotencyKeyFingerprint: 0xa19n, expectedResponseDescriptorFingerprint: 0xa0cn }),
    ];
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(requests),
    });
    const controller = new RunController({
      store,
      workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
      effectDrivers: [fixtureEffectDriver()],
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_HOST_REQUEST_DRIVER_UNAVAILABLE' },
    );
    assert.equal((await store.listEffectRecords(runId)).length, 0);
  });

  it('fails closed on needs_host heads when no effect drivers are configured', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes()]),
    });
    const controller = new RunController({
      store,
      workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
      effectDrivers: [],
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_HOST_REQUEST_DRIVER_UNAVAILABLE' },
    );
  });

  it('submits covered host effects as a partial batch only under policy', async () => {
    const requests = [
      fixtureHostRequestBytes({ requestFingerprint: 0xa01n, requestOrdinal: 0, idempotencyKey: 'idempotency-key:1', idempotencyKeyFingerprint: 0xa09n }),
      fixtureHostRequestBytes({ requestFingerprint: 0xa02n, requestOrdinal: 1, idempotencyKey: 'idempotency-key:2', idempotencyKeyFingerprint: 0xa19n, expectedResponseDescriptorFingerprint: 0xa0cn }),
    ];
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(requests),
    });
    const worker = new CaptureTurnInputWorker(fixtureTurnClosureBytes());
    const controller = new RunController({
      store,
      workerFactory: async () => worker,
      effectDrivers: [fixtureEffectDriver()],
      effectPolicy: { allowPartialEffectBatch: true },
    });

    const result = await controller.advance(runId, branchId);
    const effects = await store.listEffectRecords(runId);

    assert.equal(result.status, 'advanced');
    assert.equal(result.effects.length, 1);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].state, EffectState.closureCommitted);
    assert.equal(result.unresolvedHostRequests.length, 1);
    assert.equal(result.unresolvedHostRequests[0].descriptorFingerprint, 'world:descriptor:0000000000000a0c');
    assert.equal(result.nextHead.updateDiagnostics.unresolvedHostRequestCount, 1);
    assert.notEqual(indexOfBytes(worker.submittedTurnInputBytes, fromUtf8('response')), -1);
    assert.equal(indexOfBytes(worker.submittedTurnInputBytes, fromUtf8('response:0000000000000a02')), -1);
  });

  it('keeps partial batch resolutions dense when uncovered requests come first', async () => {
    const requests = [
      fixtureHostRequestBytes({ requestFingerprint: 0xa01n, requestOrdinal: 0, idempotencyKey: 'idempotency-key:1', idempotencyKeyFingerprint: 0xa09n, expectedResponseDescriptorFingerprint: 0xa0cn }),
      fixtureHostRequestBytes({ requestFingerprint: 0xa02n, requestOrdinal: 1, idempotencyKey: 'idempotency-key:2', idempotencyKeyFingerprint: 0xa19n }),
    ];
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(requests),
    });
    const worker = new CaptureTurnInputWorker(fixtureTurnClosureBytes());
    const controller = new RunController({
      store,
      workerFactory: async () => worker,
      effectDrivers: [delayedBatchDriver()],
      effectPolicy: { allowPartialEffectBatch: true },
    });

    const result = await controller.advance(runId, branchId);
    const effects = await store.listEffectRecords(runId);

    assert.equal(result.status, 'advanced');
    assert.equal(result.effects.length, 1);
    assert.equal(effects.length, 1);
    assert.equal(result.unresolvedHostRequests.length, 1);
    assert.equal(result.unresolvedHostRequests[0].descriptorFingerprint, 'world:descriptor:0000000000000a0c');
    assert.notEqual(indexOfBytes(worker.submittedTurnInputBytes, fromUtf8('response:0000000000000a02')), -1);
    assert.equal(indexOfBytes(worker.submittedTurnInputBytes, fromUtf8('response:0000000000000a01')), -1);
  });

  it('preserves an orphan closure and does not overwrite a winning head on CAS conflict', async () => {
    const { store, runId, branchId, head } = await fixtureStore();
    const winningRef = await store.putBlob(fromUtf8('winner'));
    const winningHead = createRunHead({
      ...head,
      generation: 1,
      turnClosureRef: winningRef,
      turnClosureWorldFingerprint: 'world:closure:winner',
      resultingStateFingerprint: 'world:state:winner',
    });
    const controller = new RunController({ store: conflictStore(store, winningHead), workerFactory: async () => new ScriptedWorker() });

    const conflict = await controller.advance(runId, branchId, { turnResult: turnResult(2) });
    assert.equal(conflict.status, 'branch_conflict');
    assert.deepEqual(await store.getBlob(conflict.orphanClosureRef), fixtureTurnClosureBytes());
    assert.equal((await store.readHead(runId, branchId)).turnClosureWorldFingerprint, 'world:closure:winner');
  });

  it('ignores worker-supplied RunHead metadata and derives it from closure bytes', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const controller = new RunController({ store, workerFactory: async () => new ScriptedWorker() });

    const result = await controller.advance(runId, branchId, { turnResult: turnResult(99) });

    assert.equal(result.nextHead.turnClosureWorldFingerprint, 'world:turn-closure:0000000000000111');
    assert.equal(result.nextHead.resultingStateFingerprint, 'world:state:0000000000000302');
    assert.notEqual(result.nextHead.turnClosureWorldFingerprint, 'world:closure:99');
  });

  it('derives RunHead fields from decodable World TurnClosure bytes', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const closureBytes = fixtureTurnClosureBytes();
    const controller = new RunController({ store, workerFactory: async () => new ClosureOnlyWorker(closureBytes) });

    const result = await controller.advance(runId, branchId);

    assert.equal(result.status, 'advanced');
    assert.equal(result.nextHead.turnClosureWorldFingerprint, 'world:turn-closure:0000000000000111');
    assert.equal(result.nextHead.resultingStateFingerprint, 'world:state:0000000000000302');
    assert.equal(result.nextHead.chronicleCursor, 'world:chronicle-cursor:0000000000000304');
    assert.equal(result.nextHead.archiveMomentFingerprint, 'world:archive-moment:0000000000000a01');
    assert.equal(result.nextHead.archiveSealFingerprint, 'world:archive-seal:0000000000000a02');
    assert.equal(result.nextHead.status, 'completed');
    assert.equal(result.nextHead.updateDiagnostics.inspectedTurnClosure.hostRequestCount, 0);
    assert.deepEqual(await store.getBlob(result.nextHead.turnClosureRef), closureBytes);
  });

  it('fails closed instead of fabricating RunHead fingerprints for undecodable closure bytes', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const controller = new RunController({ store, workerFactory: async () => new ClosureOnlyWorker(fromUtf8('not-a-turn-closure')) });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_TURN_CLOSURE_INSPECTION_FAILED' },
    );
  });

  it('rejects mismatched warm-worker identity before reuse', async () => {
    const worker = new WorldWorker();
    await worker.instantiate(fromUtf8('placeholder'));
    worker.bind(binding({ turnSequence: 0 }));

    assert.equal(assertWarmWorkerBinding(worker, binding({ turnSequence: 0 })), true);
    assert.throws(() => assertWarmWorkerBinding(worker, binding({ turnSequence: 1 })), { code: 'ERR_WARM_WORKER_IDENTITY_MISMATCH' });
  });
});

async function fixtureStore(options = {}) {
  const store = new MemoryStore();
  const imageRef = await store.putBlob(fromUtf8('image'));
  const manifestRef = await store.putBlob(fromUtf8('manifest'));
  const closureRef = await store.putBlob(options.closureBytes ?? fromUtf8('closure:0'));
  const application = createApplicationRecord({
    applicationId: 'app',
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
    turnClosureWorldFingerprint: 'world:closure:0',
    resultingStateFingerprint: 'world:state:0',
    chronicleCursor: 'cursor:0',
    archiveMomentFingerprint: 'archive:moment:0',
    archiveSealFingerprint: 'archive:seal:0',
    status: options.headStatus ?? 'completed',
  });
  const branch = createBranchRecord({ branchId: 'main', currentHead: head });
  const run = createRunRecord({ runId: 'run', applicationId: application.applicationId, branches: [branch], effectJournalNamespace: 'effects' });
  await store.createRun(run);
  return { store, runId: run.runId, branchId: branch.branchId, head };
}

function fixtureEffectDriver() {
  return {
    invocationCount: 0,
    manifest() {
      return {
        driverId: 'test.effect.driver',
        supportedActuatorRefs: ['world:actuator-ref:0000000000000a05'],
        supportedDescriptorFingerprints: ['world:descriptor:0000000000000a0b'],
        supportedActuationClasses: ['world:actuation-class:1'],
        supportedResponseStatuses: ['responded'],
        maximumRequestBytes: 4096,
        maximumResponseBytes: 4096,
        recoveryClass: EffectRecoveryClass.pure,
        concurrencyLimit: 1,
        authorityLabels: ['test'],
      };
    },
    async resolve() {
      this.invocationCount += 1;
      return {
        resolutionInputBytes: encodeResolutionInputBytes({
          targetHostRequestFingerprint: 0xa01n,
          status: 0,
          responseValueImageBytes: fromUtf8('response'),
          hostClaimBytes: fromUtf8('claim'),
          attemptNumber: this.invocationCount,
          metadata: fromUtf8('metadata'),
        }),
      };
    },
  };
}

function tooSmallEffectDriver() {
  return {
    manifest() {
      return {
        ...fixtureEffectDriver().manifest(),
        driverId: 'too-small.effect.driver',
        maximumRequestBytes: 1,
      };
    },
    async resolve() {
      throw new Error('too-small driver should not be selected');
    },
  };
}

function delayedBatchDriver() {
  let running = 0;
  let releaseFirst = null;
  return {
    invocationCount: 0,
    maxRunning: 0,
    completions: [],
    manifest() {
      return {
        driverId: 'test.effect.driver',
        supportedActuatorRefs: ['world:actuator-ref:0000000000000a05'],
        supportedDescriptorFingerprints: ['world:descriptor:0000000000000a0b'],
        supportedActuationClasses: ['world:actuation-class:1'],
        supportedResponseStatuses: ['responded'],
        maximumRequestBytes: 4096,
        maximumResponseBytes: 4096,
        recoveryClass: EffectRecoveryClass.pure,
        concurrencyLimit: 3,
        authorityLabels: ['test'],
      };
    },
    async resolve(context) {
      this.invocationCount += 1;
      running += 1;
      this.maxRunning = Math.max(this.maxRunning, running);
      const target = context.hostRequest.hostRequestFingerprint;
      try {
        if (target === 'world:host-request:0000000000000a01') {
          await new Promise((resolve) => {
            releaseFirst = resolve;
          });
        } else if (target === 'world:host-request:0000000000000a02') {
          releaseFirst?.();
        }
        this.completions.push(target);
        return {
          resolutionInputBytes: encodeResolutionInputBytes({
            targetHostRequestFingerprint: context.worldHostRequest.requestFingerprint,
            status: 0,
            responseValueImageBytes: fromUtf8(`response:${target.slice('world:host-request:'.length)}`),
            hostClaimBytes: fromUtf8(`claim:${target}`),
            attemptNumber: this.invocationCount,
            metadata: fromUtf8('metadata'),
          }),
        };
      } finally {
        running -= 1;
      }
    },
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

function binding(overrides = {}) {
  return {
    applicationId: 'app',
    branchId: 'main',
    turnClosureWorldFingerprint: 'world:closure:0',
    resultingStateFingerprint: 'world:state:0',
    turnSequence: 0,
    ...overrides,
  };
}

class ScriptedWorker extends WorldWorker {
  async submitTurn() {
    return turnResult(1);
  }
}

class CountingLoadWorker extends ScriptedWorker {
  constructor() {
    super();
    this.loadCount = 0;
  }

  async loadExecutable(imageBytes) {
    this.loadCount += 1;
    return await super.loadExecutable(imageBytes);
  }
}

class ClosureOnlyWorker extends WorldWorker {
  constructor(closureBytes) {
    super();
    this.closureBytes = closureBytes;
  }

  async submitTurn() {
    return { status: 'completed', turnClosureBytes: this.closureBytes };
  }
}

class CaptureTurnInputWorker extends ClosureOnlyWorker {
  async submitTurn(turnInputBytes) {
    this.submittedTurnInputBytes = turnInputBytes;
    return await super.submitTurn(turnInputBytes);
  }
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

function fixtureNeedsHostTurnClosureBytes(requests = [fixtureHostRequestBytes()]) {
  const turnReceiptBytes = concat([
    u32(1),
    u32(1),
    u64(0x701n),
    u64(0x211n),
    u64(0n),
    u64(0x301n),
    optionalU64(null),
    u64Slice([]),
    u64Slice([0xa01n]),
    optionalU64(null),
    u64(0xc01n),
    optionalU64(null),
    optionalU64(null),
    optionalU64(0xa03n),
    optionalU64(0xa04n),
    optionalU64(null),
    u8(0),
    optionalU64(null),
    u64(0n),
    u64(0n),
  ]);
  const pendingHostRequests = concat([u64(BigInt(requests.length)), ...requests]);
  return concat([
    u32(1),
    u32(1),
    u64(0x111n),
    u64(0x112n),
    u64(0x211n),
    optionalU64(null),
    u64(0n),
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
    optionalU64(null),
    bytes(new Uint8Array()),
    bytes(pendingHostRequests),
    optionalU64(null),
    bytes(new Uint8Array()),
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
    u8(0),
  ]);
}

function fixtureHostRequestBytes(options = {}) {
  const requestFingerprint = options.requestFingerprint ?? 0xa01n;
  const requestOrdinal = options.requestOrdinal ?? 0;
  const idempotencyKey = options.idempotencyKey ?? 'idempotency-key';
  const idempotencyKeyFingerprint = options.idempotencyKeyFingerprint ?? 0xa09n;
  const expectedResponseDescriptorFingerprint = options.expectedResponseDescriptorFingerprint ?? 0xa0bn;
  return concat([
    u32(4),
    u32(4),
    u64(requestFingerprint),
    u64(0n),
    u32(requestOrdinal),
    u64(0xa02n),
    u64(0xa03n),
    u32(0),
    u64(0xa04n),
    u64(0xa05n),
    u64(0xa05n),
    u8(1),
    u8(1),
    u64(0xa06n),
    u64(0xa07n),
    u64(0xa08n),
    u64(expectedResponseDescriptorFingerprint),
    u64(idempotencyKeyFingerprint),
    optionalU64(null),
    bytes(fromUtf8('metadata')),
    bytes(fromUtf8('frame')),
    bytes(fromUtf8('payload')),
    optionalU64(0xa0cn),
    optionalU64(0xa0dn),
    optionalU64(0xa0en),
    optionalU64(0xa0fn),
    bytes(fromUtf8('prepared')),
    bytes(fromUtf8(idempotencyKey)),
  ]);
}

function indexOfBytes(haystack, needle) {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
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

function conflictStore(store, winningHead) {
  let injected = false;
  return new Proxy(store, {
    get(target, property) {
      if (property !== 'compareAndSwapHead') return target[property];
      return async (runId, branchId, expectedGeneration, nextHead) => {
        if (!injected) {
          injected = true;
          await target.compareAndSwapHead(runId, branchId, expectedGeneration, winningHead);
        }
        return await target.compareAndSwapHead(runId, branchId, expectedGeneration, nextHead);
      };
    },
  });
}
