#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createApplicationRecord } from '../src/core/application.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../src/core/run.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';
import { DirectoryStore } from '../src/stores/directory_store.mjs';

const text = new TextEncoder();

await runStore('MemoryStore', async () => new MemoryStore());
await runStore('DirectoryStore', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'world-host-store-'));
  const store = new DirectoryStore(root);
  await store.acquireLock();
  return Object.assign(store, {
    async cleanup() {
      await store.releaseLock();
      await rm(root, { recursive: true, force: true });
    },
  });
});

console.log('store_conformance=passed');

async function runStore(name, makeStore) {
  const store = await makeStore();
  try {
    const imageRef = await store.putBlob(text.encode(`${name}:image`));
    const wasmRef = await store.putBlob(text.encode(`${name}:wasm`));
    const manifestRef = await store.putBlob(text.encode(`${name}:manifest`));
    const closureRef = await store.putBlob(text.encode(`${name}:closure:0`));
    const orphanRef = await store.putBlob(text.encode(`${name}:orphan`));

    assert.deepEqual(await store.getBlob(imageRef), text.encode(`${name}:image`), `${name} blob roundtrip`);
    assert.equal(await store.hasBlob(imageRef), true, `${name} has blob`);
    await assert.rejects(() => store.getBlob({ ...imageRef, byteLength: imageRef.byteLength + 1 }), /ERR_BLOB_CHECKSUM_MISMATCH|ERR_BLOB_NOT_FOUND/);
    const concurrentBlobBytes = text.encode(`${name}:same-blob`);
    const concurrentBlobs = await Promise.all([store.putBlob(concurrentBlobBytes), store.putBlob(concurrentBlobBytes)]);
    assert.deepEqual(concurrentBlobs[0], concurrentBlobs[1], `${name} concurrent identical blob writes share a ref`);

    const app = createApplicationRecord({
      applicationId: `${name}-app`,
      universalWasmChecksum: `sha256:${wasmRef.checksum}`,
      universalWasmByteLength: wasmRef.byteLength,
      worldProtocolVersion: 'v0.1.0',
      applianceAbiVersion: 'v4',
      executableImageRef: imageRef,
      executableImageWorldFingerprint: 'world:image:fingerprint',
      applianceManifestRef: manifestRef,
      requiredActuators: [],
      requiredRuntimeLimits: { maxBytes: 1024 },
      installationDiagnostics: { store: name, manifestSource: 'host-generated-install-summary' },
    });
    await store.createApplication(app);
    assert.equal((await store.getApplication(app.applicationId)).applicationId, app.applicationId);

    const head = createRunHead({
      generation: 0,
      turnClosureRef: closureRef,
      turnClosureWorldFingerprint: 'world:closure:0',
      resultingStateFingerprint: 'world:state:0',
      chronicleCursor: 'cursor:0',
      archiveMomentFingerprint: 'archive:moment:0',
      archiveSealFingerprint: 'archive:seal:0',
      status: 'needs_host',
    });
    const branch = createBranchRecord({ branchId: 'main', currentHead: head });
    const run = createRunRecord({
      runId: `${name}-run`,
      applicationId: app.applicationId,
      branches: [branch],
      effectJournalNamespace: `${name}-effects`,
    });
    await store.createRun(run);
    assert.equal((await store.readHead(run.runId, branch.branchId)).generation, 0);

    const nextClosureRef = await store.putBlob(text.encode(`${name}:closure:1`));
    const nextHead = createRunHead({
      ...head,
      generation: 1,
      turnClosureRef: nextClosureRef,
      turnClosureWorldFingerprint: 'world:closure:1',
      resultingStateFingerprint: 'world:state:1',
      chronicleCursor: 'cursor:1',
      archiveMomentFingerprint: 'archive:moment:1',
      archiveSealFingerprint: 'archive:seal:1',
      status: 'completed',
    });
    assert.equal((await store.compareAndSwapHead(run.runId, branch.branchId, 0, nextHead)).ok, true, `${name} CAS success`);
    assert.equal((await store.compareAndSwapHead(run.runId, branch.branchId, 0, nextHead)).ok, false, `${name} CAS conflict`);

    await assert.rejects(() => store.compareAndSwapHead(run.runId, branch.branchId, 1, { ...nextHead, turnClosureRef: { algorithm: 'sha256', checksum: '0'.repeat(64), byteLength: 1 } }), /ERR_HEAD_CLOSURE_BLOB_MISSING|ERR_BLOB_NOT_FOUND/);

    const concurrentClosureRefA = await store.putBlob(text.encode(`${name}:closure:2a`));
    const concurrentClosureRefB = await store.putBlob(text.encode(`${name}:closure:2b`));
    const concurrentA = createRunHead({
      ...nextHead,
      generation: 2,
      turnClosureRef: concurrentClosureRefA,
      turnClosureWorldFingerprint: 'world:closure:2a',
    });
    const concurrentB = createRunHead({
      ...nextHead,
      generation: 2,
      turnClosureRef: concurrentClosureRefB,
      turnClosureWorldFingerprint: 'world:closure:2b',
    });
    const concurrent = await Promise.all([
      store.compareAndSwapHead(run.runId, branch.branchId, 1, concurrentA),
      store.compareAndSwapHead(run.runId, branch.branchId, 1, concurrentB),
    ]);
    assert.equal(concurrent.filter((result) => result.ok).length, 1, `${name} concurrent CAS has one winner`);
    assert.equal(concurrent.filter((result) => !result.ok).length, 1, `${name} concurrent CAS has one conflict`);

    const effect = {
      runId: run.runId,
      branchId: branch.branchId,
      parentTurnClosureFingerprint: 'world:closure:1',
      hostRequestFingerprint: 'world:host-request:00000000000000a1',
      idempotencyKey: { format: 'world-idempotency-key-bytes.hex', bytesHex: '66756c6c2d776f726c642d6b6579' },
      idempotencyKeyWorldFingerprint: 'world:idempotency-key:store-conformance',
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture',
      actuationClass: 'fixture',
      responseSchema: { status: 'ok' },
      requestBytesChecksum: 'sha256:req',
      resolutionInputRef: await store.putBlob(text.encode(`${name}:resolution-input`)),
      state: 'resolved',
      attemptCount: 1,
      driverRecoveryClass: 'idempotent',
    };
    await store.putEffectRecord(effect);
    assert.equal((await store.getEffectRecord(run.runId, effect.idempotencyKey)).state, 'resolved');
    assert.equal((await store.listEffectRecords(run.runId)).length, 1);

    const bundle = await store.exportRun(run.runId, branch.branchId);
    assert.equal(bundle.head.generation, 2);
    assert.equal(bundle.effects.length, 1, `${name} exports selected branch effects`);
    assert.ok(bundle.blobs.length >= 3);
    const receiver = await makeStore();
    try {
      await receiver.importRun(bundle);
      assert.equal((await receiver.readHead(run.runId, branch.branchId)).generation, 2);
      assert.equal((await receiver.listEffectRecords(run.runId)).length, 1, `${name} imports selected branch effects`);
    } finally {
      await receiver.cleanup?.();
    }

    if (store instanceof DirectoryStore) {
      await writeFile(path.join(store.root, 'tmp', 'partial.tmp'), 'partial');
      const recovery = await store.recover();
      assert.ok(recovery.temporaryFilesIgnored.includes('partial.tmp'));
      assert.ok(recovery.orphanBlobs.some((ref) => ref.checksum === orphanRef.checksum));
      const second = new DirectoryStore(store.root);
      await assert.rejects(() => second.acquireLock(), /EEXIST/);
    }
  } finally {
    await store.cleanup?.();
  }
}
