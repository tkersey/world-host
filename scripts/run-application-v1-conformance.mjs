import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ApplicationWorker,
  EffectStatus,
  FrameStatus,
  MemoryBlockStore,
  MemoryBranchHeadStore,
  MemoryEffectJournalV1,
  RunControllerV1,
  createEffectResult,
  encodeStepInput,
} from '../src/v1/index.mjs';

const options = parseArgs(process.argv.slice(2));
const wasmPath = path.resolve(options.wasm ?? path.join(options.worldRepo, 'zig-out/bin/one-effect.world.wasm'));
const wasmBytes = await readFile(wasmPath);

const genesisWorker = new ApplicationWorker();
const runtime = await genesisWorker.instantiate(wasmBytes);
const manifest = genesisWorker.readManifest();
const genesisInput = encodeStepInput({
  applicationId: manifest.applicationId,
  initialArgsBytes: new Uint8Array(0),
  fuel: 100n,
}, manifest.limits);
const parent = genesisWorker.step(genesisInput);
assert.equal(parent.frame.status, FrameStatus.needsEffect);
assert.equal(parent.frame.pendingEffect.payloadBytes.toString('hex'), '070000007061796c6f6164');
genesisWorker.dispose();

const value = Buffer.alloc(8);
value.writeBigInt64LE(41n);
const effectResult = createEffectResult({
  requestId: parent.frame.pendingEffect.requestId,
  status: EffectStatus.ok,
  resultSchemaId: parent.frame.pendingEffect.resultSchemaId,
  resultBytes: value,
  attempt: 1,
}, manifest.limits);
const continuationInput = encodeStepInput({
  applicationId: manifest.applicationId,
  expectedParentFrameId: parent.frame.frameId,
  priorFrameBytes: parent.frameBytes,
  effectResult,
  fuel: 100n,
}, manifest.limits);
const wrongRequestResult = createEffectResult({
  requestId: Buffer.alloc(32, 0x7f),
  status: EffectStatus.ok,
  resultSchemaId: parent.frame.pendingEffect.resultSchemaId,
  resultBytes: value,
  attempt: 1,
}, manifest.limits);
const wrongRequestInput = encodeStepInput({
  applicationId: manifest.applicationId,
  expectedParentFrameId: parent.frame.frameId,
  priorFrameBytes: parent.frameBytes,
  effectResult: wrongRequestResult,
  fuel: 100n,
}, manifest.limits);
await assert.rejects(
  () => freshStep(wasmBytes, wrongRequestInput),
  { code: 'ERR_APPLICATION_V1_RESULT_TARGET' },
);

const firstChild = await freshStep(wasmBytes, continuationInput);
const retryChild = await freshStep(wasmBytes, continuationInput);
assert.equal(firstChild.frame.status, FrameStatus.completed);
assert.equal(firstChild.frame.finalResultBytes.readBigInt64LE(), 41n);
assert.deepEqual(retryChild.frameBytes, firstChild.frameBytes);

const blockStore = new MemoryBlockStore();
const headStore = new MemoryBranchHeadStore();
const effectJournal = new MemoryEffectJournalV1({ blockStore });
let crashAfterResult = true;
const crashingController = await RunControllerV1.create({
  wasmBytes,
  blockStore,
  headStore,
  effectJournal,
  faultInjector: async (stage) => {
    if (stage === 'after-result-persistence' && crashAfterResult) {
      crashAfterResult = false;
      throw new Error('injected crash after result persistence');
    }
  },
});
const initialized = await crashingController.initialize('run-retry', 'main', {
  initialArgsBytes: new Uint8Array(0),
  fuel: 100n,
});
assert.deepEqual(initialized.frameBytes, parent.frameBytes);
await assert.rejects(
  () => crashingController.advance('run-retry', 'main', { effectResult, fuel: 100n }),
  /injected crash after result persistence/,
);
assert.equal((await crashingController.readCurrentFrame('run-retry', 'main')).frame.status, FrameStatus.needsEffect);

const resumedController = await RunControllerV1.create({
  wasmBytes,
  blockStore,
  headStore,
  effectJournal,
});
const recovered = await resumedController.advance('run-retry', 'main', { fuel: 100n });
assert.equal(recovered.status, 'advanced');
assert.deepEqual(recovered.frameBytes, firstChild.frameBytes);
assert.equal((await blockStore.getBlock(recovered.frameRef)).equals(recovered.frameBytes), true);
assert.equal((await headStore.readHead('run-retry', 'main')).frameId, recovered.frame.frameId.toString('hex'));

const preflightMutationController = await RunControllerV1.create({
  wasmBytes,
  blockStore: new MemoryBlockStore(),
  headStore: new MemoryBranchHeadStore(),
  preflight: async (candidate) => {
    candidate.applicationId.fill(0);
    candidate.limits.maximumFuelPerStep = 1n;
    return { blockers: [] };
  },
});
assert.deepEqual(preflightMutationController.manifest.applicationId, manifest.applicationId);
assert.equal(preflightMutationController.manifest.limits.maximumFuelPerStep, manifest.limits.maximumFuelPerStep);
await preflightMutationController.initialize('run-preflight-alias', 'main', {
  initialArgsBytes: new Uint8Array(0),
  fuel: 100n,
});

const branchHead = await resumedController.forkBranch('run-retry', 'main', 'inspection');
assert.equal(branchHead.frameId, recovered.frame.frameId.toString('hex'));
assert.equal(branchHead.generation, 0);

const branchBlocks = new MemoryBlockStore();
const branchHeads = new MemoryBranchHeadStore();
const branchJournal = new MemoryEffectJournalV1({ blockStore: branchBlocks });
const branchController = await RunControllerV1.create({
  wasmBytes,
  blockStore: branchBlocks,
  headStore: branchHeads,
  effectJournal: branchJournal,
});
const branchParent = await branchController.initialize('run-branch', 'main', {
  initialArgsBytes: new Uint8Array(0),
  fuel: 100n,
});
await branchController.forkBranch('run-branch', 'main', 'alternate');
const alternateValue = Buffer.alloc(8);
alternateValue.writeBigInt64LE(42n);
const alternateResult = createEffectResult({
  requestId: branchParent.frame.pendingEffect.requestId,
  status: EffectStatus.ok,
  resultSchemaId: branchParent.frame.pendingEffect.resultSchemaId,
  resultBytes: alternateValue,
  attempt: 1,
}, manifest.limits);
const mainChild = await branchController.advance('run-branch', 'main', { effectResult, fuel: 100n });
const alternateChild = await branchController.advance('run-branch', 'alternate', { effectResult: alternateResult, fuel: 100n });
assert.equal(mainChild.frame.finalResultBytes.readBigInt64LE(), 41n);
assert.equal(alternateChild.frame.finalResultBytes.readBigInt64LE(), 42n);
assert.equal(mainChild.previousHead.frameId, alternateChild.previousHead.frameId);
assert.notEqual(mainChild.nextHead.frameId, alternateChild.nextHead.frameId);

const frameCrashBlocks = new MemoryBlockStore();
const frameCrashHeads = new MemoryBranchHeadStore();
const frameCrashJournal = new MemoryEffectJournalV1({ blockStore: frameCrashBlocks });
let persistedChildBytes = null;
const frameCrashController = await RunControllerV1.create({
  wasmBytes,
  blockStore: frameCrashBlocks,
  headStore: frameCrashHeads,
  effectJournal: frameCrashJournal,
  faultInjector: async (stage, context) => {
    if (stage === 'after-frame-persistence' && context.expectedHead !== null && persistedChildBytes === null) {
      persistedChildBytes = Buffer.from(context.output.frameBytes);
      throw new Error('injected crash after Frame persistence');
    }
  },
});
await frameCrashController.initialize('run-frame-crash', 'main', {
  initialArgsBytes: new Uint8Array(0),
  fuel: 100n,
});
await assert.rejects(
  () => frameCrashController.advance('run-frame-crash', 'main', { effectResult, fuel: 100n }),
  /injected crash after Frame persistence/,
);
assert.equal((await frameCrashController.readCurrentFrame('run-frame-crash', 'main')).frame.status, FrameStatus.needsEffect);
const frameCrashResumed = await RunControllerV1.create({
  wasmBytes,
  blockStore: frameCrashBlocks,
  headStore: frameCrashHeads,
  effectJournal: frameCrashJournal,
});
const frameCrashRecovered = await frameCrashResumed.advance('run-frame-crash', 'main', { fuel: 100n });
assert.deepEqual(frameCrashRecovered.frameBytes, persistedChildBytes);

const migrationBlocks = new MemoryBlockStore();
const migrationHeads = new MemoryBranchHeadStore();
const migrationJournal = new MemoryEffectJournalV1({ blockStore: migrationBlocks });
let stopForMigration = true;
const migrationSource = await RunControllerV1.create({
  wasmBytes,
  blockStore: migrationBlocks,
  headStore: migrationHeads,
  effectJournal: migrationJournal,
  faultInjector: async (stage) => {
    if (stage === 'after-result-persistence' && stopForMigration) {
      stopForMigration = false;
      throw new Error('stop after retained migration result');
    }
  },
});
await migrationSource.initialize('run-migration-source', 'main', {
  initialArgsBytes: new Uint8Array(0),
  fuel: 100n,
});
await assert.rejects(
  () => migrationSource.advance('run-migration-source', 'main', { effectResult, fuel: 100n }),
  /stop after retained migration result/,
);
const migrationBundle = await migrationSource.exportBranch('run-migration-source', 'main');
assert.notEqual(migrationBundle.retainedEffectResultBytes, null);

const receiverBlocks = new MemoryBlockStore();
const receiverHeads = new MemoryBranchHeadStore();
const receiverJournal = new MemoryEffectJournalV1({ blockStore: receiverBlocks });
let receiverPreflight = 0;
await assert.rejects(
  () => RunControllerV1.importBranch({
    bundle: { ...migrationBundle, applicationId: '00'.repeat(32) },
    runId: 'run-migration-mismatched-application',
    branchId: 'main',
    blockStore: new MemoryBlockStore(),
    headStore: new MemoryBranchHeadStore(),
  }),
  { code: 'ERR_APPLICATION_V1_MIGRATION_MANIFEST' },
);
const imported = await RunControllerV1.importBranch({
  bundle: migrationBundle,
  runId: 'run-migration-receiver',
  branchId: 'main',
  blockStore: receiverBlocks,
  headStore: receiverHeads,
  effectJournal: receiverJournal,
  preflight: async () => {
    receiverPreflight += 1;
    return { blockers: [] };
  },
});
assert.equal(receiverPreflight, 1);
const migratedChild = await imported.controller.advance('run-migration-receiver', 'main', { fuel: 100n });
assert.deepEqual(migratedChild.frameBytes, firstChild.frameBytes);

const malformedWorker = new ApplicationWorker();
await malformedWorker.instantiate(wasmBytes);
assert.throws(() => malformedWorker.step(new Uint8Array(0)), { code: 'ERR_APPLICATION_V1_TRUNCATED' });
malformedWorker.dispose();

console.log(`application=${manifest.applicationName}`);
console.log(`wasm_bytes=${wasmBytes.length}`);
console.log(`imports=${runtime.importCount}`);
console.log(`initial_memory_bytes=${runtime.initialMemoryBytes}`);
console.log(`maximum_memory_bytes=${runtime.maximumMemoryBytes}`);
console.log('fresh_instance_continuation=true');
console.log('byte_identical_retry=true');
console.log('result_before_step=true');
console.log('conditional_head=true');
console.log('branch_fork=true');
console.log('branch_children=2');
console.log('frame_persisted_before_head=true');
console.log('migration_receiver_preflight=true');
console.log('preflight_cannot_mutate_manifest=true');
console.log('final_result=41');

async function freshStep(bytes, input) {
  const worker = new ApplicationWorker();
  await worker.instantiate(bytes);
  const result = worker.step(input);
  worker.dispose();
  return result;
}

function parseArgs(args) {
  const result = { worldRepo: path.resolve('../world'), wasm: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--world-repo') result.worldRepo = path.resolve(requireValue(args, ++index, '--world-repo'));
    else if (args[index] === '--wasm') result.wasm = requireValue(args, ++index, '--wasm');
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  return result;
}

function requireValue(args, index, flag) {
  if (index >= args.length) throw new Error(`${flag} requires a value`);
  return args[index];
}
