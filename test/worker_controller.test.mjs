import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { EffectRecoveryClass } from '../src/core/actuator.mjs';
import { createApplicationRecord } from '../src/core/application.mjs';
import { createEffectRecord, EffectState } from '../src/core/effect_journal.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../src/core/run.mjs';
import { RunController, WorldWorker, assertWarmWorkerBinding } from '../src/core/worker.mjs';
import { fromUtf8 } from '../src/core/store.mjs';
import { encodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';
import { wyhash64 } from '../src/protocol/world_loaded_value_codec.mjs';
import { summarizeTurnClosureForRunHead } from '../src/protocol/world_universal_appliance_codec.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';
import { BunWorldWorker } from '../src/bun/bun_worker.mjs';
import { GenericHttpJsonCapabilityDriver } from '../src/drivers/generic_http_json_capability_driver.mjs';

describe('RunController and WorldWorker', () => {
  it('advances a branch only after persisting the next closure blob', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const closureBytes = fixtureTurnClosureBytes();
    const controller = new RunController({ store, workerFactory: async () => new ScriptedWorker() });
    const result = await controller.advance(runId, branchId, {
      turnResult: turnResult(1),
    });

    assert.equal(result.status, 'advanced');
    assert.equal(result.nextHead.generation, 2);
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
      turnSequence: 2,
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

    const first = await controller.advance(runId, branchId, { turnResult: turnResult(1, { status: 1, turnSequenceNumber: 1n }) });
    const second = await controller.advance(runId, branchId, { turnResult: turnResult(2, { turnSequenceNumber: 2n }) });

    assert.equal(worker.loadCount, 1);
    assert.equal(first.workerStatus, 'cold');
    assert.equal(second.workerStatus, 'warm');
  });

  it('does not call restore hooks for genesis heads', async () => {
    const { store, runId, branchId } = await fixtureStore({ headStatus: 'genesis' });
    const worker = new RestoringWorker(fixtureTurnClosureBytes({ turnSequenceNumber: 0n }));
    const controller = new RunController({
      store,
      workerFactory: async () => worker,
    });

    const result = await controller.advance(runId, branchId);

    assert.equal(result.status, 'advanced');
    assert.equal(worker.restoreCount, 0);
  });

  it('rejects nonzero genesis heads before worker execution', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'genesis',
      headOverrides: { generation: 1 },
    });
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ turnSequenceNumber: 0n })),
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_GENESIS_HEAD_GENERATION_INVALID' },
    );
  });

  it('preflights installed application requirements before worker execution', async () => {
    const { store, runId, branchId } = await fixtureStore({
      applicationOverrides: {
        requiredActuators: [{ actuatorRef: 'sandbox:file' }],
      },
    });
    let workerCreated = false;
    const controller = new RunController({
      store,
      workerFactory: async () => {
        workerCreated = true;
        return new ScriptedWorker();
      },
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_CAPABILITY_PREFLIGHT_BLOCKED' },
    );
    assert.equal(workerCreated, false);
  });

  it('rejects terminal branch heads before creating a worker', async () => {
    const { store, runId, branchId } = await fixtureStore({
      closureBytes: fixtureTurnClosureBytes({ status: 2, turnSequenceNumber: 0n }),
    });
    let workerCreated = false;
    const controller = new RunController({
      store,
      workerFactory: async () => {
        workerCreated = true;
        return new ScriptedWorker();
      },
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_BRANCH_HEAD_NOT_CONTINUABLE' },
    );
    assert.equal(workerCreated, false);
  });

  it('rejects parent heads whose metadata does not match stored closure bytes', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headOverrides: { turnClosureWorldFingerprint: 'world:turn-closure:0000000000000bad' },
    });
    const controller = new RunController({ store, workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes()) });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_PARENT_HEAD_CLOSURE_MISMATCH' },
    );
  });

  it('rejects parent heads whose generation does not match stored closure bytes', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headOverrides: { generation: 99 },
    });
    const controller = new RunController({ store, workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes()) });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_PARENT_HEAD_CLOSURE_MISMATCH' },
    );
  });

  it('rejects stale parent head generations without inspected closure diagnostics', async () => {
    const { store, runId, branchId } = await fixtureStore({
      closureBytes: fixtureTurnClosureBytes({ status: 0, turnSequenceNumber: 1n }),
      headOverrides: { generation: 0 },
    });
    const controller = new RunController({ store, workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ turnSequenceNumber: 2n })) });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_PARENT_HEAD_CLOSURE_MISMATCH' },
    );
  });

  it('rejects parent closures from a different loaded appliance manifest', async () => {
    const { store, runId, branchId } = await fixtureStore({
      manifestBytes: fixtureApplianceManifestBytes({ manifestFingerprint: 0x999n }),
    });
    const controller = new RunController({
      store,
      workerFactory: async () => new ManifestCheckingWorker(fixtureTurnClosureBytes(), 0x999n),
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_PARENT_HEAD_CLOSURE_MISMATCH' },
    );
  });

  it('rejects corrupt stored appliance manifests for manifest-aware workers', async () => {
    const { store, runId, branchId } = await fixtureStore({ manifestBytes: fromUtf8('not-an-appliance-manifest') });
    const controller = new RunController({
      store,
      workerFactory: async () => new ManifestCheckingWorker(fixtureTurnClosureBytes(), 0x211n),
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_APPLICATION_MANIFEST_INVALID' },
    );
  });

  it('rejects decodable manifest mismatches despite host-generated install diagnostics', async () => {
    const { store, runId, branchId } = await fixtureStore({
      manifestBytes: fixtureApplianceManifestBytes({ manifestFingerprint: 0x999n }),
      applicationOverrides: {
        installationDiagnostics: { manifestSource: 'host-generated-install-summary' },
      },
    });
    const controller = new RunController({
      store,
      workerFactory: async () => new ManifestCheckingWorker(fixtureTurnClosureBytes(), 0x211n),
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_APPLICATION_MANIFEST_MISMATCH' },
    );
  });

  it('allows non-manifest host-generated install summaries for manifest-aware workers', async () => {
    const { store, runId, branchId } = await fixtureStore({
      manifestBytes: fromUtf8('world-host install summary'),
      applicationOverrides: {
        installationDiagnostics: { manifestSource: 'host-generated-install-summary' },
      },
    });
    const controller = new RunController({
      store,
      workerFactory: async () => new ManifestCheckingWorker(fixtureTurnClosureBytes(), 0x211n),
    });

    const result = await controller.advance(runId, branchId);

    assert.equal(result.status, 'advanced');
  });

  it('disposes dirty warm workers after failed turn submission before retry', async () => {
    const { store, runId, branchId } = await fixtureStore({ headStatus: 'genesis' });
    const workers = [];
    const controller = new RunController({
      store,
      workerFactory: async () => {
        const worker = workers.length === 0
          ? new ThrowingAfterSubmitWorker()
          : new ClosureOnlyWorker(fixtureTurnClosureBytes({ turnSequenceNumber: 0n }));
        workers.push(worker);
        return worker;
      },
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_TEST_SUBMIT_FAILED' },
    );
    assert.equal(workers[0].disposed, true);

    const retried = await controller.advance(runId, branchId);

    assert.equal(retried.status, 'advanced');
    assert.equal(workers.length, 2);
    assert.equal(workers[1].disposed, false);
  });

  it('disposes dirty warm workers after failed restore before retry', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const workers = [];
    const controller = new RunController({
      store,
      workerFactory: async () => {
        const worker = workers.length === 0
          ? new ThrowingRestoreWorker(fixtureTurnClosureBytes())
          : new RestoringWorker(fixtureTurnClosureBytes());
        workers.push(worker);
        return worker;
      },
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_TEST_RESTORE_FAILED' },
    );
    assert.equal(workers[0].disposed, true);

    const retried = await controller.advance(runId, branchId);

    assert.equal(retried.status, 'advanced');
    assert.equal(workers.length, 2);
    assert.equal(workers[1].restoreCount, 1);
    assert.equal(workers[1].disposed, false);
  });

  it('resolves pending host requests through EffectJournal before fallback turn input', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(),
    });
    let fallbackCalled = false;
    const driver = fixtureEffectDriver();
    const worker = new CaptureTurnInputWorker(fixtureTurnClosureBytes());
    const controller = new RunController({
      store,
      workerFactory: async () => worker,
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
    assert.equal(worker.submittedTurnInputBytes[4], 1);
    assert.equal(result.effects.length, 1);
    assert.equal(result.effects[0].state, EffectState.closureCommitted);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].state, EffectState.closureCommitted);
  });

  it('preserves the actual parent closure when run metadata is stale', async () => {
    const { store, runId, branchId, head } = await fixtureStore();
    const parentClosureBytes = fixtureTurnClosureBytes({ status: 1, turnSequenceNumber: 1n });
    const parentSummary = summarizeTurnClosureForRunHead(parentClosureBytes);
    const parentClosureRef = await store.putBlob(parentClosureBytes);
    const parentHead = createRunHead({
      generation: head.generation + 1,
      turnClosureRef: parentClosureRef,
      turnClosureWorldFingerprint: parentSummary.turnClosureWorldFingerprint,
      resultingStateFingerprint: parentSummary.resultingStateFingerprint,
      chronicleCursor: parentSummary.chronicleCursor,
      archiveMomentFingerprint: parentSummary.archiveMomentFingerprint,
      archiveSealFingerprint: parentSummary.archiveSealFingerprint,
      status: parentSummary.status,
    });
    const staged = await store.compareAndSwapHead(runId, branchId, head.generation, parentHead);
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ status: 2, turnSequenceNumber: 2n })),
    });

    const result = await controller.advance(runId, branchId);
    const branch = (await store.getRun(runId)).branches.find((candidate) => candidate.branchId === branchId);

    assert.equal(staged.ok, true);
    assert.equal(result.status, 'advanced');
    assert.equal(hasBlobRef(branch.diagnostics.historicalTurnClosureRefs, head.turnClosureRef), true);
    assert.equal(hasBlobRef(branch.diagnostics.historicalTurnClosureRefs, parentHead.turnClosureRef), true);
    assert.equal(branch.diagnostics.historicalRunHeads.some((item) => item.turnClosureWorldFingerprint === head.turnClosureWorldFingerprint), true);
    assert.equal(branch.diagnostics.historicalRunHeads.some((item) => item.turnClosureWorldFingerprint === parentHead.turnClosureWorldFingerprint), true);
  });

  it('submits but does not commit effects on CAS conflict', async () => {
    const { store, runId, branchId, head } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(),
    });
    const winningRef = await store.putBlob(fromUtf8('winner'));
    const winningHead = createRunHead({
      ...head,
      generation: head.generation + 1,
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
    assert.equal(result.submittedEffects.length, 1);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].state, EffectState.submitted);
  });

  it('does not commit effects missing from the returned TurnReceipt', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(),
    });
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ appliedHostReplyFingerprints: [] })),
      effectDrivers: [fixtureEffectDriver()],
    });

    const result = await controller.advance(runId, branchId);
    const effects = await store.listEffectRecords(runId);

    assert.equal(result.status, 'advanced');
    assert.equal(result.effects.length, 0);
    assert.deepEqual(result.nextHead.updateDiagnostics.committedEffectIds, []);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].state, EffectState.resolved);
  });

  it('does not commit effects when the TurnReceipt only names the HostRequest fingerprint', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(),
    });
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ appliedHostReplyFingerprints: [0xa01n] })),
      effectDrivers: [fixtureEffectDriver()],
    });

    const result = await controller.advance(runId, branchId);
    const effects = await store.listEffectRecords(runId);

    assert.equal(result.status, 'advanced');
    assert.equal(result.effects.length, 0);
    assert.deepEqual(result.nextHead.updateDiagnostics.committedEffectIds, []);
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

  it('enforces maximumConcurrentEffects across driver groups', async () => {
    const requests = [
      fixtureHostRequestBytes({ requestFingerprint: 0xa01n, requestOrdinal: 0, idempotencyKey: 'idempotency-key:1', idempotencyKeyFingerprint: 0xa09n }),
      fixtureHostRequestBytes({ requestFingerprint: 0xa02n, requestOrdinal: 1, idempotencyKey: 'idempotency-key:2', idempotencyKeyFingerprint: 0xa19n, expectedResponseDescriptorFingerprint: 0xa0cn }),
    ];
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(requests),
    });
    const tracker = { running: 0, maxRunning: 0 };
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes()),
      effectDrivers: [
        sharedConcurrencyDriver({ driverId: 'test.effect.driver.one', descriptorFingerprint: 'world:descriptor:0000000000000a0b', tracker }),
        sharedConcurrencyDriver({ driverId: 'test.effect.driver.two', descriptorFingerprint: 'world:descriptor:0000000000000a0c', tracker }),
      ],
      effectPolicy: { maximumConcurrentEffects: 1 },
    });

    const result = await controller.advance(runId, branchId);

    assert.equal(result.status, 'advanced');
    assert.equal(tracker.maxRunning, 1);
  });

  it('preserves independent driver concurrency within the global policy', async () => {
    const requests = [
      fixtureHostRequestBytes({ requestFingerprint: 0xa01n, requestOrdinal: 0, idempotencyKey: 'idempotency-key:1', idempotencyKeyFingerprint: 0xa09n }),
      fixtureHostRequestBytes({ requestFingerprint: 0xa02n, requestOrdinal: 1, idempotencyKey: 'idempotency-key:2', idempotencyKeyFingerprint: 0xa19n, expectedResponseDescriptorFingerprint: 0xa0cn }),
      fixtureHostRequestBytes({ requestFingerprint: 0xa03n, requestOrdinal: 2, idempotencyKey: 'idempotency-key:3', idempotencyKeyFingerprint: 0xa29n, expectedResponseDescriptorFingerprint: 0xa0cn }),
    ];
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(requests),
    });
    const slowTracker = { running: 0, maxRunning: 0 };
    const fastTracker = { running: 0, maxRunning: 0 };
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes()),
      effectDrivers: [
        sharedConcurrencyDriver({ driverId: 'test.effect.driver.slow', descriptorFingerprint: 'world:descriptor:0000000000000a0b', tracker: slowTracker, concurrencyLimit: 1 }),
        sharedConcurrencyDriver({ driverId: 'test.effect.driver.fast', descriptorFingerprint: 'world:descriptor:0000000000000a0c', tracker: fastTracker, concurrencyLimit: 2 }),
      ],
      effectPolicy: { maximumConcurrentEffects: 3 },
    });

    const result = await controller.advance(runId, branchId);

    assert.equal(result.status, 'advanced');
    assert.equal(slowTracker.maxRunning, 1);
    assert.equal(fastTracker.maxRunning, 2);
  });

  it('waits for already launched effects to settle after a batch failure', async () => {
    const requests = [
      fixtureHostRequestBytes({ requestFingerprint: 0xa01n, requestOrdinal: 0, idempotencyKey: 'idempotency-key:1', idempotencyKeyFingerprint: 0xa09n }),
      fixtureHostRequestBytes({ requestFingerprint: 0xa02n, requestOrdinal: 1, idempotencyKey: 'idempotency-key:2', idempotencyKeyFingerprint: 0xa19n }),
    ];
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(requests),
    });
    const driver = settlingFailureDriver();
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes()),
      effectDrivers: [driver],
      effectPolicy: { maximumConcurrentEffects: 2 },
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_TEST_EFFECT_FAILED' },
    );

    assert.equal(driver.slowSettled, true);
  });

  it('rejects reused effect resolutions targeting a different HostRequest', async () => {
    const requests = [
      fixtureHostRequestBytes({ requestFingerprint: 0xa01n, requestOrdinal: 0, idempotencyKey: 'idempotency-key:1', idempotencyKeyFingerprint: 0xa09n }),
    ];
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(requests),
    });
    const resolutionInputRef = await store.putBlob(encodeResolutionInputBytes({
      targetHostRequestFingerprint: 0xa02n,
      status: 0,
      responseValueImageBytes: fromUtf8('wrong-target'),
      hostClaimBytes: fromUtf8('claim'),
      attemptNumber: 1,
      metadata: fromUtf8('metadata'),
    }));
    await store.putEffectRecord(createEffectRecord({
      runId,
      branchId,
      parentTurnClosureFingerprint: 'world:closure:0',
      hostRequestFingerprint: 'world:host-request:0000000000000a01',
      idempotencyKey: {
        format: 'world-idempotency-key-bytes.hex',
        bytesHex: Buffer.from('idempotency-key:1').toString('hex'),
      },
      idempotencyKeyWorldFingerprint: 'world:idempotency-key:0000000000000a09',
      actuatorRef: 'world:actuator-ref:0000000000000a05',
      descriptorFingerprint: 'world:descriptor:0000000000000a0b',
      actuationClass: 'world:actuation-class:1',
      responseSchema: { status: 'responded' },
      requestBytesChecksum: `sha256:${sha256Hex(requests[0])}`,
      state: EffectState.resolved,
      driverRecoveryClass: EffectRecoveryClass.pure,
      resolutionInputRef,
    }));
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes()),
      effectDrivers: [fixtureEffectDriver()],
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH' },
    );
  });

  it('surfaces parked best-effort effects before decoding resolutions', async () => {
    const requests = [
      fixtureHostRequestBytes({ requestFingerprint: 0xa01n, requestOrdinal: 0, idempotencyKey: 'idempotency-key:1', idempotencyKeyFingerprint: 0xa09n }),
    ];
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes(requests),
    });
    await store.putEffectRecord(createEffectRecord({
      runId,
      branchId,
      parentTurnClosureFingerprint: 'world:closure:0',
      hostRequestFingerprint: 'world:host-request:0000000000000a01',
      idempotencyKey: {
        format: 'world-idempotency-key-bytes.hex',
        bytesHex: Buffer.from('idempotency-key:1').toString('hex'),
      },
      idempotencyKeyWorldFingerprint: 'world:idempotency-key:0000000000000a09',
      actuatorRef: 'world:actuator-ref:0000000000000a05',
      descriptorFingerprint: 'world:descriptor:0000000000000a0b',
      actuationClass: 'world:actuation-class:1',
      responseSchema: { status: 'responded' },
      requestBytesChecksum: `sha256:${sha256Hex(requests[0])}`,
      state: EffectState.operatorInterventionRequired,
      driverRecoveryClass: EffectRecoveryClass.bestEffort,
    }));
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes()),
      effectDrivers: [fixtureEffectDriver()],
      effectPolicy: { allowBestEffort: true },
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_EFFECT_OPERATOR_INTERVENTION_REQUIRED' },
    );
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

  it('rejects World host requests that do not allow responded resolutions', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({
        requestFingerprint: 0xa01n,
        allowedResponseStatuses: 0,
      })]),
    });
    const driver = fixtureEffectDriver();
    const controller = new RunController({
      store,
      workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
      effectDrivers: [driver],
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_WORLD_HOST_REQUEST_RESPONSE_STATUS_NOT_ALLOWED' },
    );
    assert.equal(driver.invocationCount, 0);
    assert.equal((await store.listEffectRecords(runId)).length, 0);
  });

  it('rejects unsupported World host request versions before driver selection', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({
        requestFingerprint: 0xa01n,
        requestFormatVersion: 5,
      })]),
      headSummary: needsHostHeadSummary(),
    });
    const driver = fixtureEffectDriver();
    const controller = new RunController({
      store,
      workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
      effectDrivers: [driver],
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_PARENT_HEAD_CLOSURE_UNDECODABLE' },
    );
    assert.equal(driver.invocationCount, 0);
    assert.equal((await store.listEffectRecords(runId)).length, 0);
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

  it('rejects receiver-policy-denied drivers before resolving effects', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({ requestFingerprint: 0xa01n })]),
    });
    const driver = policyDeniedHttpDriver();
    const controller = new RunController({
      store,
      workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
      effectDrivers: [driver],
      effectPolicy: {
        allowedAuthorityLabels: new Set(['network:http']),
        allowedHttpOrigins: new Set(['https://receiver.example']),
      },
      hostRequestMapper: () => ({
        actuatorRef: 'http:json',
        descriptorFingerprint: 'descriptor:http-json',
        actuationClass: 'http',
        responseSchema: { status: 'ok' },
        idempotencyKeyBytes: fromUtf8('http-idempotency-key'),
        idempotencyKeyWorldFingerprint: 'world:key:http',
        requestBytes: fromUtf8(JSON.stringify({ url: 'https://blocked.example/path' })),
        hostRequestFingerprint: 'world:host-request:0000000000000a01',
      }),
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_HOST_REQUEST_DRIVER_UNAVAILABLE' },
    );
    assert.equal(driver.invocationCount, 0);
    assert.equal((await store.listEffectRecords(runId)).length, 0);
  });

  it('requires selected needs_host drivers to carry required authority labels', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({ requestFingerprint: 0xa01n })]),
      applicationOverrides: {
        requiredHostAuthorityLabels: ['model:fixture'],
      },
    });
    const selected = fixtureEffectDriver({ authorityLabels: [] });
    const dummyAuthorityDriver = fixtureEffectDriver({
      driverId: 'dummy-authority',
      actuatorRef: 'world:actuator-ref:0000000000000bad',
      authorityLabels: ['model:fixture'],
    });
    const controller = new RunController({
      store,
      workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
      effectDrivers: [selected, dummyAuthorityDriver],
      effectPolicy: {
        allowedAuthorityLabels: ['model:fixture'],
      },
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      (error) => {
        assert.equal(error.code, 'ERR_CAPABILITY_PREFLIGHT_BLOCKED');
        assert.ok(error.details?.blockers?.includes('required-authority-unbound:model:fixture'));
        return true;
      },
    );
    assert.equal(selected.invocationCount, 0);
    assert.equal(dummyAuthorityDriver.invocationCount, 0);
    assert.equal((await store.listEffectRecords(runId)).length, 0);
  });

  it('prefers authority-bound needs_host drivers over earlier unlabeled matches', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({ requestFingerprint: 0xa01n })]),
      applicationOverrides: {
        requiredActuators: [{
          actuatorRef: 'world:actuator-ref:0000000000000a05',
          descriptorFingerprint: 'world:descriptor:0000000000000a0b',
        }],
        requiredHostAuthorityLabels: ['model:fixture'],
      },
    });
    const unlabeled = fixtureEffectDriver({ authorityLabels: [] });
    const labeled = fixtureEffectDriver({
      driverId: 'authority-bound-fixture',
      authorityLabels: ['model:fixture'],
    });
    const controller = new RunController({
      store,
      workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
      effectDrivers: [unlabeled, labeled],
      effectPolicy: {
        allowedAuthorityLabels: ['model:fixture'],
      },
    });

    const result = await controller.advance(runId, branchId);

    assert.equal(result.status, 'advanced');
    assert.equal(unlabeled.invocationCount, 0);
    assert.equal(labeled.invocationCount, 1);
  });

  it('does not prefer unrelated required authority labels for needs_host drivers', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({ requestFingerprint: 0xa01n })]),
      applicationOverrides: {
        requiredActuators: [
          {
            actuatorRef: 'world:actuator-ref:0000000000000a05',
            descriptorFingerprint: 'world:descriptor:0000000000000a0b',
          },
          {
            actuatorRef: 'world:actuator-ref:0000000000000bad',
            descriptorFingerprint: 'world:descriptor:0000000000000a0b',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture', 'file:sandbox'],
      },
    });
    const wrongLabel = fixtureEffectDriver({
      driverId: 'wrong-label-fixture',
      authorityLabels: ['file:sandbox'],
    });
    const modelAuthority = fixtureEffectDriver({
      driverId: 'model-authority-fixture',
      authorityLabels: ['model:fixture'],
    });
    const fileAuthority = fixtureEffectDriver({
      driverId: 'file-authority-fixture',
      actuatorRef: 'world:actuator-ref:0000000000000bad',
      authorityLabels: ['file:sandbox'],
    });
    const controller = new RunController({
      store,
      workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
      effectDrivers: [wrongLabel, modelAuthority, fileAuthority],
      effectPolicy: {
        allowedAuthorityLabels: ['model:fixture', 'file:sandbox'],
      },
    });

    const result = await controller.advance(runId, branchId);

    assert.equal(result.status, 'advanced');
    assert.equal(wrongLabel.invocationCount, 0);
    assert.equal(modelAuthority.invocationCount, 1);
    assert.equal(fileAuthority.invocationCount, 0);
  });

  it('rejects unlabeled active needs_host drivers despite cross-labeled inactive actuators', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({
        requestFingerprint: 0xa01n,
        actuatorRefFingerprint: 0xbadn,
      })]),
      applicationOverrides: {
        requiredActuators: [
          {
            actuatorRef: 'world:actuator-ref:0000000000000a05',
            descriptorFingerprint: 'world:descriptor:0000000000000a0b',
          },
          {
            actuatorRef: 'world:actuator-ref:0000000000000bad',
            descriptorFingerprint: 'world:descriptor:0000000000000a0b',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture', 'file:sandbox'],
      },
    });
    const crossLabeledModel = fixtureEffectDriver({
      driverId: 'cross-labeled-model',
      authorityLabels: ['model:fixture', 'file:sandbox'],
    });
    const unlabeledFile = fixtureEffectDriver({
      driverId: 'unlabeled-file',
      actuatorRef: 'world:actuator-ref:0000000000000bad',
      authorityLabels: [],
    });
    const controller = new RunController({
      store,
      workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
      effectDrivers: [crossLabeledModel, unlabeledFile],
      effectPolicy: {
        allowedAuthorityLabels: ['model:fixture', 'file:sandbox'],
      },
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      (error) => {
        assert.equal(error.code, 'ERR_CAPABILITY_PREFLIGHT_BLOCKED');
        assert.ok(error.details?.blockers?.includes('required-authority-unbound:file:sandbox'));
        return true;
      },
    );
    assert.equal(crossLabeledModel.invocationCount, 0);
    assert.equal(unlabeledFile.invocationCount, 0);
    assert.equal((await store.listEffectRecords(runId)).length, 0);
  });

  it('rejects HTTP requests outside the selected driver origin coverage', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({ requestFingerprint: 0xa01n })]),
    });
    const driver = policyDeniedHttpDriver({ origins: ['https://allowed.example'] });
    const controller = new RunController({
      store,
      workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
      effectDrivers: [driver],
      effectPolicy: {
        allowedAuthorityLabels: new Set(['network:http']),
        allowedHttpOrigins: new Set(['https://blocked.example']),
      },
      hostRequestMapper: () => ({
        actuatorRef: 'http:json',
        descriptorFingerprint: 'descriptor:http-json',
        actuationClass: 'http',
        responseSchema: { status: 'ok' },
        idempotencyKeyBytes: fromUtf8('http-idempotency-key'),
        idempotencyKeyWorldFingerprint: 'world:key:http',
        requestBytes: fromUtf8(JSON.stringify({ url: 'https://blocked.example/path' })),
        hostRequestFingerprint: 'world:host-request:0000000000000a01',
      }),
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_HOST_REQUEST_DRIVER_UNAVAILABLE' },
    );
    assert.equal(driver.invocationCount, 0);
    assert.equal((await store.listEffectRecords(runId)).length, 0);
  });

  it('skips HTTP drivers whose method coverage does not match the request', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({ requestFingerprint: 0xa01n })]),
    });
    const getOnly = policyDeniedHttpDriver({ origins: ['https://allowed.example'], methods: ['GET'] });
    const postCapable = {
      invocationCount: 0,
      manifest() {
        return {
          ...getOnly.manifest(),
          driverId: 'policy.http.post.driver',
          diagnostics: { origins: ['https://allowed.example'], methods: ['POST'] },
        };
      },
      async resolve() {
        this.invocationCount += 1;
        return {
          resolutionInputBytes: encodeResolutionInputBytes({
            targetHostRequestFingerprint: 0xa01n,
            status: 0,
            responseValueImageBytes: fixtureResponseValueBytes('response', 0xa01n),
            hostClaimBytes: fromUtf8('claim'),
            attemptNumber: 1,
            metadata: fromUtf8('metadata'),
          }),
        };
      },
    };
    const controller = new RunController({
      store,
      workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
      effectDrivers: [getOnly, postCapable],
      effectPolicy: {
        allowedAuthorityLabels: new Set(['network:http']),
        allowedHttpOrigins: new Set(['https://allowed.example']),
      },
      hostRequestMapper: () => ({
        actuatorRef: 'http:json',
        descriptorFingerprint: 'descriptor:http-json',
        actuationClass: 'http',
        responseSchema: { status: 'ok' },
        idempotencyKeyBytes: fromUtf8('http-idempotency-key'),
        idempotencyKeyWorldFingerprint: 'world:key:http',
        requestBytes: fromUtf8(JSON.stringify({ url: 'https://allowed.example/path', method: 'POST' })),
        hostRequestFingerprint: 'world:host-request:0000000000000a01',
      }),
    });

    const result = await controller.advance(runId, branchId);

    assert.equal(result.status, 'advanced');
    assert.equal(getOnly.invocationCount, 0);
    assert.equal(postCapable.invocationCount, 1);
  });

  it('uses configured HTTP driver defaults when request URLs omit methods', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({ requestFingerprint: 0xa01n })]),
    });
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    try {
      globalThis.fetch = async (url, options) => {
        fetchCount += 1;
        assert.equal(url, 'https://allowed.example/path');
        assert.equal(options.method, 'POST');
        return new Response('{"status":"ok"}', {
          status: 200,
          headers: { 'x-request-id': 'controller-http-default-method' },
        });
      };
      const controller = new RunController({
        store,
        workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
        effectDrivers: [new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://fallback.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example', 'https://fallback.example'],
          methods: ['POST'],
        })],
        effectPolicy: {
          allowedAuthorityLabels: new Set(['network:http']),
          allowedHttpOrigins: new Set(['https://allowed.example']),
        },
        hostRequestMapper: () => ({
          actuatorRef: 'http:json',
          descriptorFingerprint: 'descriptor:http-json',
          actuationClass: 'http',
          responseSchema: { status: 'ok' },
          idempotencyKeyBytes: fromUtf8('http-default-method-key'),
          idempotencyKeyWorldFingerprint: 'world:key:http-default-method',
          requestBytes: fromUtf8(JSON.stringify({ url: 'https://allowed.example/path', body: { prompt: 'hi' } })),
          hostRequestFingerprint: 'world:host-request:0000000000000a01',
        }),
      });

      const result = await controller.advance(runId, branchId);

      assert.equal(result.status, 'advanced');
      assert.equal(fetchCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('passes receiver policy into controller-driven configured HTTP capabilities', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({ requestFingerprint: 0xa01n })]),
    });
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    try {
      globalThis.fetch = async (url, options) => {
        fetchCount += 1;
        assert.equal(url, 'https://allowed.example/decide');
        assert.equal(options.method, 'POST');
        return new Response('{"status":"ok"}', {
          status: 200,
          headers: { 'x-request-id': 'controller-http' },
        });
      };
      const controller = new RunController({
        store,
        workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
        effectDrivers: [new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' })],
        effectPolicy: {
          allowedAuthorityLabels: new Set(['network:http']),
          allowedHttpOrigins: new Set(['https://allowed.example']),
        },
        hostRequestMapper: () => ({
          actuatorRef: 'http:json',
          descriptorFingerprint: 'descriptor:http-json',
          actuationClass: 'http',
          responseSchema: { status: 'ok' },
          idempotencyKeyBytes: fromUtf8('http-idempotency-key'),
          idempotencyKeyWorldFingerprint: 'world:key:http',
          requestBytes: fromUtf8(JSON.stringify({ body: { prompt: 'hi' } })),
          hostRequestFingerprint: 'world:host-request:0000000000000a01',
        }),
      });

      const result = await controller.advance(runId, branchId);

      assert.equal(result.status, 'advanced');
      assert.equal(fetchCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('requires receiver HTTP origins before configured HTTP capabilities resolve', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({ requestFingerprint: 0xa01n })]),
    });
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    try {
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      const controller = new RunController({
        store,
        workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
        effectDrivers: [new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' })],
        effectPolicy: {
          allowedAuthorityLabels: new Set(['network:http']),
        },
        hostRequestMapper: () => ({
          actuatorRef: 'http:json',
          descriptorFingerprint: 'descriptor:http-json',
          actuationClass: 'http',
          responseSchema: { status: 'ok' },
          idempotencyKeyBytes: fromUtf8('http-origin-required-key'),
          idempotencyKeyWorldFingerprint: 'world:key:http-origin-required',
          requestBytes: fromUtf8(JSON.stringify({ body: { prompt: 'hi' } })),
          hostRequestFingerprint: 'world:host-request:0000000000000a01',
        }),
      });

      await assert.rejects(
        () => controller.advance(runId, branchId),
        (error) => {
          assert.equal(error.code, 'ERR_CAPABILITY_PREFLIGHT_BLOCKED');
          assert.ok(error.details?.blockers?.includes('http-origin-allowlist-required'));
          return true;
        },
      );
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes fixed configured HTTP endpoints even when payloads contain url fields', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({ requestFingerprint: 0xa01n })]),
    });
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    try {
      globalThis.fetch = async (url, options) => {
        fetchCount += 1;
        assert.equal(url, 'https://allowed.example/decide');
        assert.equal(options.method, 'POST');
        return new Response('{"status":"ok"}', {
          status: 200,
          headers: { 'x-request-id': 'controller-http-fixed-endpoint' },
        });
      };
      const controller = new RunController({
        store,
        workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
        effectDrivers: [new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' })],
        effectPolicy: {
          allowedAuthorityLabels: new Set(['network:http']),
          allowedHttpOrigins: new Set(['https://allowed.example']),
        },
        hostRequestMapper: () => ({
          actuatorRef: 'http:json',
          descriptorFingerprint: 'descriptor:http-json',
          actuationClass: 'http',
          responseSchema: { status: 'ok' },
          idempotencyKeyBytes: fromUtf8('http-fixed-endpoint-key'),
          idempotencyKeyWorldFingerprint: 'world:key:http-fixed-endpoint',
          requestBytes: fromUtf8(JSON.stringify({ url: 'https://payload.example/not-target', body: { prompt: 'hi' } })),
          hostRequestFingerprint: 'world:host-request:0000000000000a01',
        }),
      });

      const result = await controller.advance(runId, branchId);

      assert.equal(result.status, 'advanced');
      assert.equal(fetchCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects drivers that exceed receiver byte limits before resolving effects', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({ requestFingerprint: 0xa01n })]),
    });
    const driver = fixtureEffectDriver();
    const controller = new RunController({
      store,
      workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
      effectDrivers: [driver],
      effectPolicy: {
        maximumRequestBytes: 4096,
        maximumResponseBytes: 1,
      },
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_HOST_REQUEST_DRIVER_UNAVAILABLE' },
    );
    assert.equal(driver.invocationCount, 0);
    assert.equal((await store.listEffectRecords(runId)).length, 0);
  });

  it('rejects file-capable drivers outside receiver root policy before resolving effects', async () => {
    const { store, runId, branchId } = await fixtureStore({
      headStatus: 'needs_host',
      closureBytes: fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes({ requestFingerprint: 0xa01n })]),
    });
    const driver = fixtureEffectDriver({
      driverId: 'mislabelled.file.driver',
      actuatorRef: 'sandbox:file',
      descriptorFingerprint: 'descriptor:sandbox-file',
      actuationClasses: ['file'],
      responseStatuses: ['ok'],
      authorityLabels: [],
      diagnostics: { root: '/blocked' },
    });
    const controller = new RunController({
      store,
      workerFactory: async () => new CaptureTurnInputWorker(fixtureTurnClosureBytes()),
      effectDrivers: [driver],
      effectPolicy: {
        allowedFileRoots: new Set(['/allowed']),
      },
      hostRequestMapper: () => ({
        actuatorRef: 'sandbox:file',
        descriptorFingerprint: 'descriptor:sandbox-file',
        actuationClass: 'file',
        responseSchema: { status: 'ok' },
        idempotencyKeyBytes: fromUtf8('file-idempotency-key'),
        idempotencyKeyWorldFingerprint: 'world:key:file',
        requestBytes: fromUtf8(JSON.stringify({ path: 'out.txt', operation: 'write', content: 'blocked' })),
        hostRequestFingerprint: 'world:host-request:0000000000000a01',
      }),
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_HOST_REQUEST_DRIVER_UNAVAILABLE' },
    );
    assert.equal(driver.invocationCount, 0);
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
      effectDrivers: [delayedBatchDriver({ coordinateFirstPair: false })],
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
      generation: head.generation + 1,
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

  it('preserves archive-less RunHead anchors across archive-less advances', async () => {
    const parentClosureBytes = fixtureTurnClosureBytes({ archiveLess: true, status: 1, turnSequenceNumber: 0n });
    const nextClosureBytes = fixtureTurnClosureBytes({ archiveLess: true, turnSequenceNumber: 1n });
    const { store, runId, branchId } = await fixtureStore({
      closureBytes: parentClosureBytes,
      headOverrides: {
        archiveMomentFingerprint: null,
        archiveSealFingerprint: null,
        status: 'yielded_budget',
      },
    });
    const controller = new RunController({ store, workerFactory: async () => new ClosureOnlyWorker(nextClosureBytes) });

    const result = await controller.advance(runId, branchId);

    assert.equal(result.status, 'advanced');
    assert.equal(result.nextHead.archiveMomentFingerprint, null);
    assert.equal(result.nextHead.archiveSealFingerprint, null);
  });

  it('maps World TurnClosure terminal statuses without shifting enum values', async () => {
    for (const [statusByte, statusLabel] of [
      [1, 'yielded_budget'],
      [3, 'failed'],
      [4, 'cancelled'],
      [5, 'inspected'],
    ]) {
      const { store, runId, branchId } = await fixtureStore({ runId: `run-status-${statusByte}` });
      const closureBytes = fixtureTurnClosureBytes({ status: statusByte });
      const controller = new RunController({ store, workerFactory: async () => new ClosureOnlyWorker(closureBytes) });

      const result = await controller.advance(runId, branchId);

      assert.equal(result.nextHead.status, statusLabel);
    }
  });

  it('fails closed instead of fabricating RunHead fingerprints for undecodable closure bytes', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const controller = new RunController({ store, workerFactory: async () => new ClosureOnlyWorker(fromUtf8('not-a-turn-closure')) });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_TURN_CLOSURE_INSPECTION_FAILED' },
    );
  });

  it('fails closed on TurnClosure bytes with trailing data', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const controller = new RunController({ store, workerFactory: async () => new ClosureOnlyWorker(concat([fixtureTurnClosureBytes(), Uint8Array.of(0)])) });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_TURN_CLOSURE_INSPECTION_FAILED' },
    );
  });

  it('fails closed on unsupported TurnClosure versions', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const controller = new RunController({ store, workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ formatVersion: 2 })) });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_TURN_CLOSURE_INSPECTION_FAILED' },
    );
  });

  it('fails closed on unsupported embedded TurnReceipt versions', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const controller = new RunController({ store, workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ receiptFormatVersion: 2 })) });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_TURN_CLOSURE_INSPECTION_FAILED' },
    );
  });

  it('fails closed on embedded TurnReceipt bytes with trailing data', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const controller = new RunController({ store, workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ extraReceiptBytes: Uint8Array.of(0) })) });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_TURN_CLOSURE_INSPECTION_FAILED' },
    );
  });

  it('fails closed when embedded TurnReceipt fields do not match the closure', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ receiptManifestFingerprint: 0x999n })),
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_TURN_CLOSURE_INSPECTION_FAILED' },
    );
  });

  it('fails closed when embedded TurnReceipt result fields diverge from the closure', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ receiptRootResultFingerprint: 0xbadn })),
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_TURN_CLOSURE_INSPECTION_FAILED' },
    );
  });

  it('fails closed when TurnClosure root result diverges from the embedded receipt', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ rootResultFingerprint: 0xbadn })),
    });

    await assert.rejects(
      () => controller.advance(runId, branchId),
      { code: 'ERR_TURN_CLOSURE_INSPECTION_FAILED' },
    );
  });

  it('accepts non-completed diagnostic root results when object refs match', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ status: 3 })),
    });

    const result = await controller.advance(runId, branchId);

    assert.equal(result.nextHead.status, 'failed');
  });

  it('fails closed when pending HostRequests are not receipt-emitted', () => {
    assert.throws(
      () => summarizeTurnClosureForRunHead(fixtureNeedsHostTurnClosureBytes(
        [fixtureHostRequestBytes({ requestFingerprint: 0xa02n })],
        { emittedHostRequestFingerprints: [0xa01n] },
      )),
      /TurnReceipt emitted HostRequests do not match TurnClosure pending requests/,
    );
  });

  it('fails closed on duplicate pending HostRequest fingerprints', () => {
    const duplicateRequest = fixtureHostRequestBytes({ requestFingerprint: 0xa01n });
    assert.throws(
      () => summarizeTurnClosureForRunHead(fixtureNeedsHostTurnClosureBytes(
        [duplicateRequest, duplicateRequest],
        { emittedHostRequestFingerprints: [0xa01n, 0xa01n] },
      )),
      /duplicate HostRequest fingerprints/,
    );
  });

  it('accepts real TurnReceipt status mapping for completed closures', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ status: 2, receiptStatus: 1 })),
    });

    const result = await controller.advance(runId, branchId);

    assert.equal(result.nextHead.status, 'completed');
  });

  it('fails closed when embedded TurnReceipt status does not map to the closure status', async () => {
    const { store, runId, branchId } = await fixtureStore();
    const controller = new RunController({
      store,
      workerFactory: async () => new ClosureOnlyWorker(fixtureTurnClosureBytes({ status: 2, receiptStatus: 2 })),
    });

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

  it('does not reinstantiate a disposed BunWorldWorker', async () => {
    const worker = new BunWorldWorker();
    worker.dispose();

    await assert.rejects(
      () => worker.instantiate(fromUtf8('not-wasm')),
      { code: 'ERR_WORKER_DISPOSED' },
    );
  });
});

async function fixtureStore(options = {}) {
  const store = new MemoryStore();
  const imageRef = await store.putBlob(fromUtf8('image'));
  const wasmRef = await store.putBlob(fromUtf8('wasm'));
  const manifestRef = await store.putBlob(options.manifestBytes ?? fixtureApplianceManifestBytes({ manifestFingerprint: 0x211n }));
  const closureBytes = options.closureBytes ?? (options.headStatus === 'genesis'
    ? fromUtf8('world-host:genesis')
    : fixtureTurnClosureBytes({ status: 1, turnSequenceNumber: 0n }));
  const closureRef = await store.putBlob(closureBytes);
  const closureSummary = options.headSummary ?? (options.headStatus === 'genesis' ? {
    turnClosureWorldFingerprint: 'world:turn-closure:genesis',
    resultingStateFingerprint: 'world:state:genesis',
    chronicleCursor: 'world:chronicle-cursor:genesis',
    archiveMomentFingerprint: 'world:archive-moment:genesis',
    archiveSealFingerprint: 'world:archive-seal:genesis',
    status: 'genesis',
  } : summarizeTurnClosureForRunHead(closureBytes));
  const archiveMomentFingerprint = closureSummary.archiveMomentFingerprint ?? 'world:archive-moment:retained';
  const archiveSealFingerprint = closureSummary.archiveSealFingerprint ?? 'world:archive-seal:retained';
  const application = createApplicationRecord({
    applicationId: 'app',
    universalWasmChecksum: `sha256:${wasmRef.checksum}`,
    universalWasmByteLength: wasmRef.byteLength,
    worldProtocolVersion: 'v0.1.0',
    applianceAbiVersion: 'v4',
    executableImageRef: imageRef,
    executableImageWorldFingerprint: 'world:image',
    applianceManifestRef: manifestRef,
    requiredActuators: options.applicationOverrides?.requiredActuators ?? [],
    requiredRuntimeLimits: options.applicationOverrides?.requiredRuntimeLimits ?? {},
    installationDiagnostics: {},
    ...options.applicationOverrides,
  });
  await store.createApplication(application);
  const head = createRunHead({
    generation: options.headStatus === 'genesis' ? 0 : (closureSummary.inspectionDiagnostics?.turnSequenceNumber ?? 0) + 1,
    turnClosureRef: closureRef,
    turnClosureWorldFingerprint: closureSummary.turnClosureWorldFingerprint,
    resultingStateFingerprint: closureSummary.resultingStateFingerprint,
    chronicleCursor: closureSummary.chronicleCursor,
    archiveMomentFingerprint,
    archiveSealFingerprint,
    status: options.headStatus ?? closureSummary.status,
    ...options.headOverrides,
  });
  const branch = createBranchRecord({ branchId: 'main', currentHead: head });
  const run = createRunRecord({ runId: 'run', applicationId: application.applicationId, branches: [branch], effectJournalNamespace: 'effects' });
  await store.createRun(run);
  return { store, runId: run.runId, branchId: branch.branchId, head };
}

function hasBlobRef(refs, expected) {
  return (refs ?? []).some((ref) => ref.checksum === expected.checksum && ref.byteLength === expected.byteLength);
}

function needsHostHeadSummary() {
  return {
    turnClosureWorldFingerprint: 'world:turn-closure:0000000000000111',
    resultingStateFingerprint: 'world:state:0000000000000302',
    chronicleCursor: 'world:chronicle-cursor:0000000000000304',
    archiveMomentFingerprint: null,
    archiveSealFingerprint: null,
    status: 'needs_host',
  };
}

function fixtureEffectDriver(options = {}) {
  return {
    invocationCount: 0,
    manifest() {
      return {
        driverId: options.driverId ?? 'test.effect.driver',
        supportedActuatorRefs: [options.actuatorRef ?? 'world:actuator-ref:0000000000000a05'],
        supportedDescriptorFingerprints: [options.descriptorFingerprint ?? 'world:descriptor:0000000000000a0b'],
        supportedActuationClasses: options.actuationClasses ?? ['world:actuation-class:1'],
        supportedResponseStatuses: options.responseStatuses ?? ['responded'],
        maximumRequestBytes: 4096,
        maximumResponseBytes: 4096,
        recoveryClass: EffectRecoveryClass.pure,
        concurrencyLimit: 1,
        authorityLabels: options.authorityLabels ?? ['test'],
        diagnostics: options.diagnostics ?? {},
      };
    },
    async resolve() {
      this.invocationCount += 1;
      return {
        resolutionInputBytes: encodeResolutionInputBytes({
          targetHostRequestFingerprint: 0xa01n,
          status: 0,
          responseValueImageBytes: fixtureResponseValueBytes('response', 0xa01n),
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

function delayedBatchDriver(options = {}) {
  let running = 0;
  let releaseFirst = null;
  let firstReady = null;
  const coordinateFirstPair = options.coordinateFirstPair !== false;
  const waitForFirst = new Promise((resolve) => {
    firstReady = resolve;
  });
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
        if (coordinateFirstPair && target === 'world:host-request:0000000000000a01') {
          await new Promise((resolve) => {
            releaseFirst = resolve;
            firstReady();
          });
        } else if (coordinateFirstPair && target === 'world:host-request:0000000000000a02') {
          await waitForFirst;
          releaseFirst?.();
        }
        this.completions.push(target);
        return {
          resolutionInputBytes: encodeResolutionInputBytes({
            targetHostRequestFingerprint: context.worldHostRequest.requestFingerprint,
            status: 0,
            responseValueImageBytes: fixtureResponseValueBytes(`response:${target.slice('world:host-request:'.length)}`, context.worldHostRequest.requestFingerprint),
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

function sharedConcurrencyDriver({ driverId, descriptorFingerprint, tracker, concurrencyLimit = 3 }) {
  return {
    manifest() {
      return {
        driverId,
        supportedActuatorRefs: ['world:actuator-ref:0000000000000a05'],
        supportedDescriptorFingerprints: [descriptorFingerprint],
        supportedActuationClasses: ['world:actuation-class:1'],
        supportedResponseStatuses: ['responded'],
        maximumRequestBytes: 4096,
        maximumResponseBytes: 4096,
        recoveryClass: EffectRecoveryClass.pure,
        concurrencyLimit,
        authorityLabels: ['test'],
      };
    },
    async resolve(context) {
      tracker.running += 1;
      tracker.maxRunning = Math.max(tracker.maxRunning, tracker.running);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          resolutionInputBytes: encodeResolutionInputBytes({
            targetHostRequestFingerprint: context.worldHostRequest.requestFingerprint,
            status: 0,
            responseValueImageBytes: fixtureResponseValueBytes(`response:${context.hostRequest.hostRequestFingerprint}`, context.worldHostRequest.requestFingerprint),
            hostClaimBytes: fromUtf8('claim'),
            attemptNumber: 1,
            metadata: fromUtf8('metadata'),
          }),
        };
      } finally {
        tracker.running -= 1;
      }
    },
  };
}

function settlingFailureDriver() {
  return {
    slowSettled: false,
    manifest() {
      return {
        driverId: 'settling.failure.driver',
        supportedActuatorRefs: ['world:actuator-ref:0000000000000a05'],
        supportedDescriptorFingerprints: ['world:descriptor:0000000000000a0b'],
        supportedActuationClasses: ['world:actuation-class:1'],
        supportedResponseStatuses: ['responded'],
        maximumRequestBytes: 4096,
        maximumResponseBytes: 4096,
        recoveryClass: EffectRecoveryClass.pure,
        concurrencyLimit: 2,
        authorityLabels: ['test'],
      };
    },
    async resolve(context) {
      if (context.hostRequest.hostRequestFingerprint === 'world:host-request:0000000000000a01') {
        const error = new Error('test effect failed');
        error.code = 'ERR_TEST_EFFECT_FAILED';
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.slowSettled = true;
      return {
        resolutionInputBytes: encodeResolutionInputBytes({
          targetHostRequestFingerprint: context.worldHostRequest.requestFingerprint,
          status: 0,
          responseValueImageBytes: fromUtf8('response:slow'),
          hostClaimBytes: fromUtf8('claim:slow'),
          attemptNumber: 1,
          metadata: fromUtf8('metadata'),
        }),
      };
    },
  };
}

function policyDeniedHttpDriver(options = {}) {
  return {
    invocationCount: 0,
    manifest() {
      return {
        driverId: 'policy.http.driver',
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 4096,
        maximumResponseBytes: 4096,
        recoveryClass: EffectRecoveryClass.idempotent,
        concurrencyLimit: 1,
        authorityLabels: ['network:http'],
        diagnostics: {
          ...(options.origins ? { origins: options.origins } : {}),
          ...(options.methods ? { methods: options.methods } : {}),
        },
      };
    },
    async resolve() {
      this.invocationCount += 1;
      throw new Error('policy-denied driver should not run');
    },
  };
}

function turnResult(index, options = {}) {
  return {
    turnClosureBytes: fixtureTurnClosureBytes(options),
    turnClosureWorldFingerprint: `world:closure:${index}`,
    resultingStateFingerprint: `world:state:${index}`,
    chronicleCursor: `cursor:${index}`,
    archiveMomentFingerprint: `archive:moment:${index}`,
    archiveSealFingerprint: `archive:seal:${index}`,
    status: options.status === 1 ? 'yielded_budget' : 'completed',
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

class ThrowingAfterSubmitWorker extends WorldWorker {
  async submitTurn() {
    this.lastTurnClosureBytes = fixtureTurnClosureBytes({ turnSequenceNumber: 0n });
    const error = new Error('test submit failed');
    error.code = 'ERR_TEST_SUBMIT_FAILED';
    throw error;
  }
}

class CountingLoadWorker extends ScriptedWorker {
  constructor() {
    super();
    this.loadCount = 0;
    this.submitCount = 0;
  }

  async loadExecutable(imageBytes) {
    this.loadCount += 1;
    return await super.loadExecutable(imageBytes);
  }

  async submitTurn() {
    this.submitCount += 1;
    return {
      status: this.submitCount === 1 ? 'yielded_budget' : 'completed',
      turnClosureBytes: fixtureTurnClosureBytes({
        status: this.submitCount === 1 ? 1 : 2,
        turnSequenceNumber: BigInt(this.submitCount),
      }),
    };
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

class ManifestCheckingWorker extends ClosureOnlyWorker {
  constructor(closureBytes, manifestFingerprint) {
    super(closureBytes);
    this.manifestFingerprint = manifestFingerprint;
  }

  readApplianceManifest() {
    return {
      decoded: {
        manifestFingerprint: this.manifestFingerprint,
      },
    };
  }
}

class CaptureTurnInputWorker extends ClosureOnlyWorker {
  async submitTurn(turnInputBytes) {
    this.submittedTurnInputBytes = turnInputBytes;
    return await super.submitTurn(turnInputBytes);
  }
}

class RestoringWorker extends ClosureOnlyWorker {
  constructor(closureBytes) {
    super(closureBytes);
    this.restoreCount = 0;
  }

  async restoreFromTurnClosure() {
    this.restoreCount += 1;
  }
}

class ThrowingRestoreWorker extends RestoringWorker {
  async restoreFromTurnClosure() {
    await super.restoreFromTurnClosure();
    const error = new Error('test restore failed');
    error.code = 'ERR_TEST_RESTORE_FAILED';
    throw error;
  }
}

function fixtureTurnClosureBytes(options = {}) {
  const closureStatus = options.status ?? 2;
  const rootResultBytes = rootResultValueBytes(options.rootResultValueFingerprint ?? 0xb01n);
  const rootResultRef = rootResultObjectRef(rootResultBytes);
  const turnReceiptBytes = concat([
    u32(options.receiptFormatVersion ?? 1),
    u32(options.receiptFingerprintVersion ?? 1),
    u64(0x701n),
    u64(options.receiptManifestFingerprint ?? 0x211n),
    u64(options.receiptTurnSequenceNumber ?? options.turnSequenceNumber ?? 1n),
    u64(0x301n),
    optionalU64(null),
    u64Slice(options.appliedHostReplyFingerprints ?? defaultAppliedHostReplyFingerprints()),
    u64Slice([]),
    optionalU64(null),
    u64(options.receiptResultingCapsuleFingerprint ?? 0x501n),
    optionalU64(options.receiptArchiveAppendBatchFingerprint ?? 0xa00n),
    optionalU64(options.receiptArchiveMomentFingerprint ?? (options.archiveLess ? null : 0xa01n)),
    optionalU64(options.receiptArchiveSealFingerprint ?? (options.archiveLess ? null : 0xa02n)),
    optionalU64(options.receiptChronicleCursorFingerprint ?? 0x304n),
    optionalU64(options.receiptRootResultFingerprint ?? 0xb01n),
    u8(options.receiptStatus ?? receiptStatusForClosureStatus(closureStatus)),
    optionalU64(null),
    u64(1n),
    u64(1n),
    ...(options.extraReceiptBytes ? [options.extraReceiptBytes] : []),
  ]);
  return concat([
    u32(options.formatVersion ?? 1),
    u32(options.fingerprintVersion ?? 1),
    u64(0x111n),
    u64(0x112n),
    u64(0x211n),
    optionalU64(null),
    u64(options.turnSequenceNumber ?? 1n),
    u64(0x301n),
    u64(0x302n),
    u64(0x303n),
    u64(0x304n),
    optionalU64(null),
    optionalU64(null),
    optionalU64(options.archiveLess ? null : 0xa01n),
    optionalU64(options.archiveLess ? null : 0xa02n),
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
    optionalU64(options.rootResultFingerprint ?? rootResultRef.objectFingerprint),
    bytes(rootResultBytes),
    optionalU64(options.rootResultValueRefFingerprint ?? rootResultRef.refFingerprint),
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
    u8(closureStatus),
  ]);
}

function fixtureApplianceManifestBytes(options = {}) {
  return concat([
    u32(3),
    u32(3),
    u64(options.manifestFingerprint ?? 0x211n),
    u32(4),
    u64(0x102n),
    u64(0x103n),
    u64(0x104n),
    u64(0n),
    u64(0n),
    u64(0n),
    u64Slice([]),
    u64Slice([]),
    u64(0n),
    u64Slice([]),
    u64Slice([]),
    u64Slice([]),
    u64Slice([]),
    u64Slice([]),
    u64Slice([]),
    u8Slice([]),
    u8Slice([]),
    u64(0n),
    u64Slice([]),
    u64(0n),
    u64(0n),
    u8(0),
    u16(0),
    u64(0x105n),
    u64(0x106n),
    u8(0),
    bytes(new Uint8Array()),
  ]);
}

function receiptStatusForClosureStatus(status) {
  if (status === 0) return 0;
  if (status === 1) return 3;
  if (status === 2) return 1;
  if (status === 3) return 2;
  if (status === 4) return 4;
  if (status === 5) return 5;
  return status;
}

function defaultAppliedHostReplyFingerprints() {
  const requestFingerprints = [0xa01n, 0xa02n, 0xa03n];
  const idempotencyKeyFingerprints = [0xa09n, 0xa19n, 0xa29n];
  return [
    fixtureHostReplyFingerprint({
      requestFingerprint: 0xa01n,
      idempotencyKeyFingerprint: 0xa09n,
      responseValueImageBytes: fixtureResponseValueBytes('response', 0xa01n),
      hostClaimBytes: fromUtf8('claim'),
      attemptNumber: 1,
    }),
    ...requestFingerprints.flatMap((requestFingerprint, index) => {
      const suffix = requestFingerprint.toString(16).padStart(16, '0');
      return [
        ...[1n, 2n, 3n].map((attemptNumber) => fixtureHostReplyFingerprint({
          requestFingerprint,
          idempotencyKeyFingerprint: idempotencyKeyFingerprints[index],
          responseValueImageBytes: fixtureResponseValueBytes(`response:${suffix}`, requestFingerprint),
          hostClaimBytes: fromUtf8(`claim:world:host-request:${suffix}`),
          attemptNumber,
        })),
        fixtureHostReplyFingerprint({
          requestFingerprint,
          idempotencyKeyFingerprint: idempotencyKeyFingerprints[index],
          responseValueImageBytes: fixtureResponseValueBytes(`response:world:host-request:${suffix}`, requestFingerprint),
          hostClaimBytes: fromUtf8('claim'),
          attemptNumber: 1n,
        }),
      ];
    }),
  ];
}

function fixtureHostReplyFingerprint({
  requestFingerprint,
  intentFingerprint = 0xa06n,
  envelopeFingerprint = 0xa07n,
  idempotencyKeyFingerprint,
  status = 0n,
  responseValueImageBytes,
  hostClaimBytes,
  attemptNumber,
  metadata = fromUtf8('metadata'),
}) {
  const responseFingerprint = valueImageFingerprint(responseValueImageBytes);
  const responseKind = status === 0n ? 1n : 0n;
  const outcomeFingerprint = nonzero(wyhash64(concat([
    hashBytes(fromUtf8('world.appliance.host_outcome.fingerprint')),
    u64(1n),
    u64(1n),
    u64(requestFingerprint),
    u64(intentFingerprint),
    u64(envelopeFingerprint),
    u64(idempotencyKeyFingerprint),
    u64(status),
    optionalHashU64(responseFingerprint),
    u64(responseKind),
    hashBytes(responseValueImageBytes),
    optionalHashU64(null),
    hashBytes(hostClaimBytes),
    u64(attemptNumber),
    hashBytes(metadata),
  ])));
  return nonzero(wyhash64(concat([
    hashBytes(fromUtf8('world.appliance.host_reply.fingerprint')),
    u64(1n),
    u64(1n),
    u64(requestFingerprint),
    u64(outcomeFingerprint),
    optionalHashU64(null),
    u64(0n),
    hashBytes(metadata),
  ])));
}

function fixtureResponseValueBytes(text, fingerprint) {
  const payload = fromUtf8(text);
  const out = new Uint8Array(16 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(8, Number(BigInt(fingerprint) & 0xffff_ffffn), true);
  view.setUint32(12, Number((BigInt(fingerprint) >> 32n) & 0xffff_ffffn), true);
  out.set(payload, 16);
  return out;
}

function valueImageFingerprint(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (BigInt(view.getUint32(12, true)) << 32n) | BigInt(view.getUint32(8, true));
}

function hashBytes(value) {
  return concat([u64(value.byteLength), value]);
}

function optionalHashU64(value) {
  return value == null ? u64(0n) : concat([u64(1n), u64(value)]);
}

function rootResultValueBytes(fingerprint) {
  const label = fromUtf8('world.appliance.root_result.value_image');
  return concat([u32(label.byteLength), label, u64(fingerprint)]);
}

function rootResultObjectRef(payload) {
  const objectFingerprint = wyhash64(concat([
    fromUtf8('world.continuity.object.payload'),
    u64(56n),
    u64(1n),
    u64(BigInt(payload.byteLength)),
    payload,
  ]));
  const refFingerprint = wyhash64(concat([
    fromUtf8('world.continuity.object.ref'),
    u64(1n),
    u64(56n),
    u64(1n),
    u64(objectFingerprint),
    u64(BigInt(payload.byteLength)),
  ]));
  return { objectFingerprint, refFingerprint };
}

function nonzero(value) {
  return value === 0n ? 1n : value;
}

function fixtureNeedsHostTurnClosureBytes(requests = [fixtureHostRequestBytes()], options = {}) {
  const emittedHostRequestFingerprints = options.emittedHostRequestFingerprints ?? requests.map(fixtureHostRequestFingerprint);
  const turnReceiptBytes = concat([
    u32(1),
    u32(1),
    u64(0x701n),
    u64(0x211n),
    u64(0n),
    u64(0x301n),
    optionalU64(null),
    u64Slice([]),
    u64Slice(emittedHostRequestFingerprints),
    optionalU64(null),
    u64(0x501n),
    optionalU64(null),
    optionalU64(null),
    optionalU64(null),
    optionalU64(0x304n),
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

function fixtureHostRequestFingerprint(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(8, true);
}

function fixtureHostRequestBytes(options = {}) {
  const requestFormatVersion = options.requestFormatVersion ?? 4;
  const requestFingerprintVersion = options.requestFingerprintVersion ?? 4;
  const requestFingerprint = options.requestFingerprint ?? 0xa01n;
  const requestOrdinal = options.requestOrdinal ?? 0;
  const idempotencyKey = options.idempotencyKey ?? 'idempotency-key';
  const idempotencyKeyFingerprint = options.idempotencyKeyFingerprint ?? 0xa09n;
  const actuatorRefFingerprint = options.actuatorRefFingerprint ?? 0xa05n;
  const actuationClass = options.actuationClass ?? 1;
  const expectedResponseDescriptorFingerprint = options.expectedResponseDescriptorFingerprint ?? 0xa0bn;
  const allowedResponseStatuses = options.allowedResponseStatuses ?? 1;
  return concat([
    u32(requestFormatVersion),
    u32(requestFingerprintVersion),
    u64(requestFingerprint),
    u64(0n),
    u32(requestOrdinal),
    u64(0xa02n),
    u64(0xa03n),
    u32(0),
    u64(0xa04n),
    u64(0xa05n),
    u64(actuatorRefFingerprint),
    u8(actuationClass),
    u8(allowedResponseStatuses),
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

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function u8(value) {
  return Uint8Array.of(Number(value) & 0xff);
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, Number(value), true);
  return out;
}

function u16(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, Number(value), true);
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

function u8Slice(values) {
  return concat([u64(values.length), Uint8Array.from(values)]);
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
