import { afterEach, beforeEach, describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DirectoryApplicationStoreV1,
  EffectStatus,
  createEffectResult,
  decodeEffectRequest,
  makeHead,
} from '../src/v1/index.mjs';

const REQUEST_BYTES = Buffer.from('V1JMREVSUTEBAAAAzsv4PjOqIpx6fIhz3PpQIQfQBpBJgGPl/ZhB61sPIQ60PALu7Q1toJPlzqEcNzWLUTkSdG2wFdviJDPdp75bkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+PnsVNnMCk9QDrj7fk3SRRxHDJ8DAxdOz9pTKNio+HV23O/j1AZsz8DHR/oIjlOnjt+QHPbZ/H394AGV4uxYoW+JHLOqyVGCqBl1l5Nu/Snak4YmG3Lyvx64Rbugn7b+3Kp04wMkjDMXCwAAAAcAAABwYXlsb2Fk9+yRHaSj2v0yozJM8OeKhy9t02kvUfN8O1szV59ej9cBAAAAAAAAAAAAEAADAAAA', 'base64');

let root;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'world-host-application-v1-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('World application v1 directory blocks', () => {
  it('retains immutable bytes across store instances and rejects corruption', async () => {
    const first = new DirectoryApplicationStoreV1(root);
    const ref = await first.blockStore.putBlock(Buffer.from('frame'));
    const reopened = new DirectoryApplicationStoreV1(root);

    assert.deepEqual(await reopened.blockStore.getBlock(ref), Buffer.from('frame'));
    await writeFile(reopened.blockStore.blockPath(ref), Buffer.from('corrupt'));
    await assert.rejects(() => reopened.blockStore.getBlock(ref), { code: 'ERR_APPLICATION_V1_BLOCK_CORRUPT' });
  });
});

describe('World application v1 directory branch heads', () => {
  it('gives one exact-head winner across independent store instances', async () => {
    const first = new DirectoryApplicationStoreV1(root);
    const second = new DirectoryApplicationStoreV1(root);
    const genesis = await persistedHead(first, 0, 1);
    assert.equal((await first.headStore.advanceHeadIfCurrent('run', 'main', null, genesis)).advanced, true);
    const left = await persistedHead(first, 1, 2);
    const right = await persistedHead(first, 1, 3);

    const outcomes = await Promise.all([
      first.headStore.advanceHeadIfCurrent('run', 'main', genesis, left),
      second.headStore.advanceHeadIfCurrent('run', 'main', genesis, right),
    ]);

    assert.equal(outcomes.filter((outcome) => outcome.advanced).length, 1);
    const current = await new DirectoryApplicationStoreV1(root).headStore.readHead('run', 'main');
    assert.equal(current.generation, 1);
    assert([left.frameId, right.frameId].includes(current.frameId));
  });

  it('rejects publication when the referenced Frame block is absent', async () => {
    const store = new DirectoryApplicationStoreV1(root);
    const missing = makeHead({
      generation: 0,
      applicationId: '01'.repeat(32),
      frameId: '02'.repeat(32),
      frameRef: { algorithm: 'sha256', checksum: '03'.repeat(32), byteLength: 1 },
      status: 0,
    });

    await assert.rejects(
      () => store.headStore.advanceHeadIfCurrent('run', 'main', null, missing),
      { code: 'ERR_APPLICATION_V1_HEAD_FRAME_BLOCK_MISSING' },
    );
    assert.equal(await store.headStore.readHead('run', 'main'), null);
  });
});

describe('World application v1 directory effect journal', () => {
  it('reuses an identical persisted result and rejects a conflicting result after restart', async () => {
    const first = new DirectoryApplicationStoreV1(root);
    const request = decodeEffectRequest(REQUEST_BYTES);
    const result = createEffectResult({
      requestId: request.requestId,
      status: EffectStatus.ok,
      resultSchemaId: request.resultSchemaId,
      resultBytes: Buffer.from('first'),
    });
    await first.effectJournal.persistResult({
      runId: 'run',
      branchId: 'main',
      parentFrameId: request.parentFrameId,
      request,
      result,
      limits: firstLimits(),
    });

    const reopened = new DirectoryApplicationStoreV1(root);
    const retained = await reopened.effectJournal.readResult({
      runId: 'run',
      branchId: 'main',
      parentFrameId: request.parentFrameId,
      request,
      limits: firstLimits(),
    });
    assert.deepEqual(retained.result.encodedBytes, result.encodedBytes);
    assert.equal(retained.record.fuel, firstLimits().maximumFuelPerStep.toString());

    await assert.rejects(
      () => reopened.effectJournal.persistResult({
        runId: 'run',
        branchId: 'main',
        parentFrameId: request.parentFrameId,
        request,
        result,
        limits: firstLimits(),
        fuel: 1n,
      }),
      { code: 'ERR_APPLICATION_V1_EFFECT_JOURNAL_FUEL_CONFLICT' },
    );

    const conflict = createEffectResult({
      requestId: request.requestId,
      status: EffectStatus.ok,
      resultSchemaId: request.resultSchemaId,
      resultBytes: Buffer.from('second'),
    });
    await assert.rejects(
      () => reopened.effectJournal.persistResult({
        runId: 'run',
        branchId: 'main',
        parentFrameId: request.parentFrameId,
        request,
        result: conflict,
        limits: firstLimits(),
      }),
      { code: 'ERR_APPLICATION_V1_EFFECT_RESULT_CONFLICT' },
    );
  });
});

describe('World application v1 directory registry', () => {
  it('resolves one immutable installation by alias or application identity', async () => {
    const store = new DirectoryApplicationStoreV1(root);
    const wasmRef = await store.blockStore.putBlock(Buffer.from('wasm'));
    const manifestRef = await store.blockStore.putBlock(Buffer.from('manifest'));
    const record = await store.applications.register({
      name: 'fixture-agent',
      applicationId: '11'.repeat(32),
      applicationVersion: '1.0.0',
      wasmRef,
      manifestRef,
    });
    const reopened = new DirectoryApplicationStoreV1(root);

    assert.deepEqual(await reopened.applications.get('fixture-agent'), record);
    assert.deepEqual(await reopened.applications.get(record.applicationId), record);
    await assert.rejects(
      () => reopened.applications.register({ ...record, applicationId: '22'.repeat(32) }),
      { code: 'ERR_APPLICATION_V1_APPLICATION_EXISTS' },
    );
    await assert.rejects(
      () => reopened.applications.register({ ...record, name: 'alias-agent' }),
      { code: 'ERR_APPLICATION_V1_APPLICATION_EXISTS' },
    );
  });
});

async function persistedHead(store, generation, marker) {
  const bytes = Buffer.from([marker]);
  const frameRef = await store.blockStore.putBlock(bytes);
  return makeHead({
    generation,
    applicationId: '01'.repeat(32),
    frameId: marker.toString(16).padStart(2, '0').repeat(32),
    frameRef,
    status: 0,
  });
}

function firstLimits() {
  return {
    maximumManifestBytes: 1 << 20,
    maximumInitialArgsBytes: 1 << 20,
    maximumStateBytes: 1 << 20,
    maximumPayloadBytes: 1 << 20,
    maximumResultBytes: 1 << 20,
    maximumHostClaimBytes: 64 << 10,
    maximumHostMetadataBytes: 64 << 10,
    maximumFailureBytes: 64 << 10,
    maximumNameBytes: 4 << 10,
    maximumInternalHandlers: 256,
    maximumResidualEffects: 256,
    maximumFuelPerStep: 100_000n,
    maximumFrameDepth: 64,
    maximumProviderDepth: 8,
  };
}
