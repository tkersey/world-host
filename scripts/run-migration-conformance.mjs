#!/usr/bin/env node
import assert from 'node:assert/strict';

import { createApplicationRecord } from '../src/core/application.mjs';
import { EffectRecoveryClass } from '../src/core/actuator.mjs';
import { exportCarrierRun, forkRunBranch, importCarrierRun } from '../src/core/migration.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../src/core/run.mjs';
import { fromUtf8 } from '../src/core/store.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';

await provesBranchIndependence();
await provesMigration();
await provesReceiverRejection();

console.log('migration_conformance=passed');

async function provesBranchIndependence() {
  const { store, run, head } = await fixtureStore();
  await forkRunBranch(store, { runId: run.runId, sourceBranchId: 'main', sourceClosureFingerprint: head.turnClosureWorldFingerprint, newBranchId: 'alternate' });
  assert.equal((await store.readHead(run.runId, 'main')).generation, 0);
  assert.equal((await store.readHead(run.runId, 'alternate')).turnClosureWorldFingerprint, head.turnClosureWorldFingerprint);
}

async function provesMigration() {
  const source = await fixtureStore();
  const exported = await exportCarrierRun(source.store, source.run.runId, 'main');
  const receiver = new MemoryStore();
  const imported = await importCarrierRun(receiver, exported, { runId: 'receiver-run', preflight: async () => ({ blockers: [] }) });
  assert.equal(imported.authorityImported, false);
  assert.equal((await receiver.readHead('receiver-run', 'main')).turnClosureWorldFingerprint, source.head.turnClosureWorldFingerprint);
}

async function provesReceiverRejection() {
  const source = await fixtureStore();
  const exported = await exportCarrierRun(source.store, source.run.runId, 'main');
  exported.bundle.effects.push({
    runId: source.run.runId,
    state: 'running',
    driverRecoveryClass: EffectRecoveryClass.bestEffort,
    idempotencyKey: { format: 'world-idempotency-key-bytes.hex', bytesHex: 'aa' },
  });
  const receiver = new MemoryStore();
  await assert.rejects(() => importCarrierRun(receiver, exported, { runId: 'receiver-run' }), { code: 'ERR_IMPORT_UNRECOVERABLE_EFFECT_RUNNING' });
}

async function fixtureStore() {
  const store = new MemoryStore();
  const imageRef = await store.putBlob(fromUtf8('image'));
  const manifestRef = await store.putBlob(fromUtf8('manifest'));
  const closureRef = await store.putBlob(fromUtf8('closure'));
  const app = createApplicationRecord({
    applicationId: 'app',
    universalWasmChecksum: 'sha256:fixture',
    worldProtocolVersion: 'v0.1.0',
    applianceAbiVersion: 'v3',
    executableImageRef: imageRef,
    executableImageWorldFingerprint: 'world:image',
    applianceManifestRef: manifestRef,
    requiredActuators: [],
    requiredRuntimeLimits: {},
  });
  await store.createApplication(app);
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
  const run = createRunRecord({ runId: 'run', applicationId: app.applicationId, branches: [createBranchRecord({ branchId: 'main', currentHead: head })], effectJournalNamespace: 'effects' });
  await store.createRun(run);
  return { store, run, head };
}
