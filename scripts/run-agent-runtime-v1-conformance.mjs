#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pack = await packRoot(process.argv[2]);
const { checkAgentRuntimeV1Pack } = await import(checkerUrl());
const check = await checkAgentRuntimeV1Pack(pack);
const host = await import(pathToFileURL(path.join(pack, 'host/src/v1/index.mjs')).href);
const capabilities = await import(pathToFileURL(path.join(pack, 'capabilities/src/v1/index.mjs')).href);
const applications = Object.fromEntries(await Promise.all(
  ['one-effect', 'skeleton-agent', 'fixture-agent'].map(async (name) => [
    name,
    await readFile(path.join(pack, `applications/${name}.world.wasm`)),
  ]),
));

const oneEffect = await proveOneEffect();
const root = await mkdtemp(path.join(tmpdir(), 'agent-runtime-v1-conformance-'));
try {
  const router = new capabilities.CapabilityRouterV1({ bindings: capabilities.fixtureAgentBindings() });
  const skeleton = await proveSkeleton(router);
  const fixture = await proveFixture(router, root);
  const branching = await proveBranching();
  const migration = await proveMigration();

  const receipt = {
    receiptVersion: 'agent-runtime-v1-conformance/v1',
    packFormatVersion: check.packFormatVersion,
    releaseStatus: check.releaseStatus,
    applicationsChecked: check.applications.map((application) => application.name),
    scenarios: {
      oneEffect: oneEffect.completed,
      skeletonAgent: skeleton.completed,
      fixtureAgent: fixture.completed,
      providerParked: fixture.providerParked,
      deterministicRetry: fixture.byteIdenticalRetry,
      replayFreshEffects: fixture.replayFreshEffects,
      branchingChildren: branching.children,
      migrationReceiverPreflight: migration.receiverPreflight,
    },
    exactFixtureOutput: fixture.output,
    exactFixtureFinal: fixture.final,
    sourceCheckoutRequired: false,
    capabilityAuthoredFrame: false,
    v0RuntimeArtifactPresent: false,
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function proveOneEffect() {
  const wasmBytes = applications['one-effect'];
  const genesis = await initialStep(wasmBytes, Buffer.alloc(0));
  assert.equal(genesis.frame.status, host.FrameStatus.needsEffect);
  const resultBytes = Buffer.alloc(8);
  resultBytes.writeBigInt64LE(41n);
  const result = host.createEffectResult({
    requestId: genesis.frame.pendingEffect.requestId,
    status: host.EffectStatus.ok,
    resultSchemaId: genesis.frame.pendingEffect.resultSchemaId,
    resultBytes,
  }, genesis.manifest.limits);
  const input = host.encodeStepInput({
    applicationId: genesis.manifest.applicationId,
    expectedParentFrameId: genesis.frame.frameId,
    priorFrameBytes: genesis.frameBytes,
    effectResult: result,
    fuel: 100n,
  }, genesis.manifest.limits);
  const first = await freshStep(wasmBytes, input);
  const retry = await freshStep(wasmBytes, input);
  assert.deepEqual(retry.frameBytes, first.frameBytes);
  assert.equal(first.frame.status, host.FrameStatus.completed);
  assert.equal(first.frame.finalResultBytes.readBigInt64LE(), 41n);
  return { completed: true };
}

async function proveSkeleton(router) {
  const context = {
    policy: { fileWrite: false },
    approval: { approved: true },
    effectAttempted: 0,
    attempt: 1,
  };
  const result = await runStringApplication({
    wasmBytes: applications['skeleton-agent'],
    initial: 'goal=invoke',
    router,
    context,
    retainedResults: new Map(),
  });
  assert.equal(result.final, 'final=actuate skeleton complete');
  assert.deepEqual(result.bindingIds, ['fixture-agent.model.v1', 'fixture-agent.model.v1']);
  assert(result.maximumInternalHandlerCalls >= 1n);
  return { completed: true };
}

async function proveFixture(router, fixtureRoot) {
  await writeFile(path.join(fixtureRoot, 'fixture-input.txt'), 'rewrite this file through the agent loop\n');
  const context = {
    fixtureRoot,
    policy: { fileWrite: true },
    approval: { approved: true },
    effectAttempted: 0,
    attempt: 1,
  };
  const retainedResults = new Map();
  const first = await runStringApplication({
    wasmBytes: applications['fixture-agent'],
    initial: 'goal=fixture',
    router,
    context,
    retainedResults,
    checkRetryBinding: 'fixture-agent.file-write.v1',
  });
  assert.deepEqual(first.bindingIds, [
    'fixture-agent.model.v1',
    'fixture-agent.file-read.v1',
    'fixture-agent.model.v1',
    'fixture-agent.file-write.v1',
    'fixture-agent.model.v1',
  ]);
  assert.equal(first.final, 'final=fixture updated');
  const output = await readFile(path.join(fixtureRoot, 'fixture-output.txt'), 'utf8');
  assert.equal(output, 'actuate updated the fixture');
  assert(first.providerParked);
  assert.equal(context.effectAttempted, 2);

  const beforeReplay = context.effectAttempted;
  const replay = await runStringApplication({
    wasmBytes: applications['fixture-agent'],
    initial: 'goal=fixture',
    router,
    context,
    retainedResults,
    replay: true,
  });
  assert.equal(replay.final, 'final=fixture updated');
  assert.equal(context.effectAttempted, beforeReplay);
  return {
    completed: true,
    providerParked: true,
    byteIdenticalRetry: first.byteIdenticalRetry,
    replayFreshEffects: context.effectAttempted - beforeReplay,
    output,
    final: first.final,
  };
}

async function proveBranching() {
  const wasmBytes = applications['fixture-agent'];
  const blocks = new host.MemoryBlockStore();
  const heads = new host.MemoryBranchHeadStore();
  const controller = await host.RunControllerV1.create({ wasmBytes, blockStore: blocks, headStore: heads });
  const manifest = controller.manifest;
  const parent = await controller.initialize('branch-run', 'main', {
    initialArgsBytes: capabilities.encodeStringValue('goal=fixture'),
    fuel: 100n,
  });
  await controller.forkBranch('branch-run', 'main', 'alternate');
  const main = await controller.advance('branch-run', 'main', {
    effectResult: stringResult(parent.frame.pendingEffect, manifest, 'fixture-input.txt'),
    fuel: 100n,
  });
  const alternate = await controller.advance('branch-run', 'alternate', {
    effectResult: stringResult(parent.frame.pendingEffect, manifest, 'alternate-input.txt'),
    fuel: 100n,
  });
  assert.equal(main.previousHead.frameId, alternate.previousHead.frameId);
  assert.notEqual(main.nextHead.frameId, alternate.nextHead.frameId);
  assert.equal(main.frame.status, host.FrameStatus.needsEffect);
  assert.equal(alternate.frame.status, host.FrameStatus.needsEffect);
  return { children: 2 };
}

async function proveMigration() {
  const wasmBytes = applications['skeleton-agent'];
  const sourceBlocks = new host.MemoryBlockStore();
  const sourceHeads = new host.MemoryBranchHeadStore();
  const source = await host.RunControllerV1.create({
    wasmBytes,
    blockStore: sourceBlocks,
    headStore: sourceHeads,
  });
  const parent = await source.initialize('migration-source', 'main', {
    initialArgsBytes: capabilities.encodeStringValue('goal=invoke'),
    fuel: 100n,
  });
  const bundle = await source.exportBranch('migration-source', 'main');
  const receiverBlocks = new host.MemoryBlockStore();
  const receiverHeads = new host.MemoryBranchHeadStore();
  let receiverPreflight = 0;
  const imported = await host.RunControllerV1.importBranch({
    bundle,
    runId: 'migration-receiver',
    branchId: 'main',
    blockStore: receiverBlocks,
    headStore: receiverHeads,
    preflight: async () => {
      receiverPreflight += 1;
      return { blockers: [] };
    },
  });
  assert.equal(imported.head.frameId, Buffer.from(parent.frame.frameId).toString('hex'));
  assert.deepEqual((await imported.controller.readCurrentFrame('migration-receiver', 'main')).frameBytes, parent.frameBytes);
  assert.equal(receiverPreflight, 1);
  return { receiverPreflight: true };
}

async function runStringApplication({
  wasmBytes,
  initial,
  router,
  context,
  retainedResults,
  replay = false,
  checkRetryBinding = null,
}) {
  let current = await initialStep(wasmBytes, capabilities.encodeStringValue(initial));
  const bindingIds = [];
  let maximumInternalHandlerCalls = current.frame.resourceCounters.internalHandlerCalls;
  let providerParked = false;
  let byteIdenticalRetry = checkRetryBinding === null;
  while (current.frame.status === host.FrameStatus.needsEffect) {
    const requestKey = Buffer.from(current.frame.pendingEffect.requestId).toString('hex');
    let result = retainedResults.get(requestKey) ?? null;
    let bindingId = null;
    if (!replay) {
      const resolution = await router.resolve(context, current.frame.pendingEffect.encodedBytes);
      result = resolution.result;
      bindingId = resolution.bindingId;
      bindingIds.push(bindingId);
      retainedResults.set(requestKey, result);
    } else {
      assert(result, `missing replay result: ${requestKey}`);
    }
    const input = host.encodeStepInput({
      applicationId: current.manifest.applicationId,
      expectedParentFrameId: current.frame.frameId,
      priorFrameBytes: current.frameBytes,
      effectResult: result.encodedBytes,
      fuel: 100n,
    }, current.manifest.limits);
    const next = await freshStep(wasmBytes, input);
    if (bindingId === checkRetryBinding) {
      assert.deepEqual((await freshStep(wasmBytes, input)).frameBytes, next.frameBytes);
      byteIdenticalRetry = true;
    }
    current = { ...next, manifest: current.manifest };
    if (current.frame.resourceCounters.internalHandlerCalls > maximumInternalHandlerCalls) {
      maximumInternalHandlerCalls = current.frame.resourceCounters.internalHandlerCalls;
    }
    if (current.frame.status === host.FrameStatus.needsEffect &&
        current.frame.resourceCounters.internalHandlerCalls > 0n &&
        [2n, 4n].includes(current.frame.pendingEffect.authorityRequirements)) {
      providerParked = true;
    }
  }
  assert.equal(current.frame.status, host.FrameStatus.completed);
  return {
    final: capabilities.decodeStringValue(current.frame.finalResultBytes),
    bindingIds,
    maximumInternalHandlerCalls,
    providerParked,
    byteIdenticalRetry,
  };
}

async function initialStep(wasmBytes, initialArgsBytes) {
  const worker = new host.ApplicationWorker();
  try {
    await worker.instantiate(wasmBytes);
    const manifest = worker.readManifest();
    const input = host.encodeStepInput({
      applicationId: manifest.applicationId,
      initialArgsBytes,
      fuel: 100n,
    }, manifest.limits);
    return { ...worker.step(input), manifest };
  } finally {
    worker.dispose();
  }
}

async function freshStep(wasmBytes, input) {
  const worker = new host.ApplicationWorker();
  try {
    await worker.instantiate(wasmBytes);
    return worker.step(input);
  } finally {
    worker.dispose();
  }
}

function stringResult(request, manifest, value) {
  return host.createEffectResult({
    requestId: request.requestId,
    status: host.EffectStatus.ok,
    resultSchemaId: request.resultSchemaId,
    resultBytes: capabilities.encodeStringValue(value),
  }, manifest.limits);
}

async function packRoot(argument) {
  if (argument) return path.resolve(argument);
  const current = fileURLToPath(import.meta.url);
  if (path.basename(path.dirname(current)) === 'conformance') return path.resolve(path.dirname(current), '..');
  return path.resolve('agent-runtime-v1');
}

function checkerUrl() {
  const current = fileURLToPath(import.meta.url);
  const filename = path.basename(path.dirname(current)) === 'conformance'
    ? 'check-pack.mjs'
    : 'check-agent-runtime-v1-pack.mjs';
  return pathToFileURL(path.join(path.dirname(current), filename)).href;
}
