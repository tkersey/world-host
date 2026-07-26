#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pack = await packRoot(process.argv[2]);
const { checkAgentRuntimeV1Pack } = await import(
  pathToFileURL(path.join(pack, 'conformance/check-pack.mjs')).href
);
const check = await checkAgentRuntimeV1Pack(pack);
const host = await import(pathToFileURL(path.join(pack, 'host/src/v1/index.mjs')).href);
const capabilities = await import(pathToFileURL(path.join(pack, 'capabilities/src/v1/index.mjs')).href);
const applications = Object.fromEntries(await Promise.all(
  ['one-effect', 'skeleton-agent', 'fixture-agent', 'research-digest-agent'].map(async (name) => [
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
  const research = await proveResearchDigest();
  const negative = await proveResearchNegatives();
  const researchCli = await proveResearchCli(root);

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
      researchDigest: research.completed,
      researchCustomEffect: research.customEffect,
      researchInternalProvider: research.internalProvider,
      researchExternalCapability: research.externalCapability,
      researchFreshInstanceResume: research.freshInstanceResume,
      researchDeterministicRetry: research.deterministicRetry,
      researchCapabilityInvocations: research.capabilityInvocations,
      researchReplayFreshEffects: research.replayFreshEffects,
      researchBranchingChildren: research.branchingChildren,
      researchMigrationReceiverPreflight: research.migrationReceiverPreflight,
      researchNegativeCases: negative,
      researchCli: researchCli,
    },
    exactFixtureOutput: fixture.output,
    exactFixtureFinal: fixture.final,
    exactResearchDigest: research.digest,
    exactResearchItemCount: research.itemCount,
    sourceCheckoutRequired: false,
    sourceIndependentHost: true,
    capabilityAuthoredFrame: false,
    applicationSpecificHostLogic: false,
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

async function proveResearchDigest() {
  const wasmBytes = applications['research-digest-agent'];
  const initialArgsBytes = encodeResearchRequest({
    query: 'portable algebraic effects',
    maximumItems: 2n,
  });
  const blocks = new host.MemoryBlockStore();
  const heads = new host.MemoryBranchHeadStore();
  let lostFrameBytes = null;
  let loseFirstChild = true;
  const controller = await host.RunControllerV1.create({
    wasmBytes,
    blockStore: blocks,
    headStore: heads,
    faultInjector: async (stage, context) => {
      if (stage === 'after-world-step' && context.expectedHead !== null && loseFirstChild) {
        loseFirstChild = false;
        lostFrameBytes = Buffer.from(context.output.frameBytes);
        throw new Error('simulated lost child before head advancement');
      }
    },
  });
  const manifest = controller.manifest;
  const parent = await controller.initialize('research-retry', 'main', {
    initialArgsBytes,
    fuel: 100n,
  });
  assert.equal(parent.frame.status, host.FrameStatus.needsEffect);
  assert.equal(parent.frame.resourceCounters.internalHandlerCalls, 1n);
  assert.equal(parent.frame.pendingEffect.interfaceId.toString('hex'), capabilities.effectInterfaceId(
    capabilities.RESEARCH_LOOKUP_INTERFACE_LABEL,
  ).toString('hex'));

  const router = new capabilities.CapabilityRouterV1({
    bindings: [capabilities.researchLookupFixtureBinding()],
  });
  const context = {
    policy: { researchLookup: true },
    effectAttempted: 0,
    attempt: 1,
  };
  const resolution = await router.resolve(context, parent.frame.pendingEffect.encodedBytes);
  assert.equal(resolution.bindingId, 'research-lookup-fixture.v1');
  await assert.rejects(
    () => controller.advance('research-retry', 'main', {
      effectResult: resolution.result,
      fuel: 100n,
      effectMetadata: resolutionMetadata(resolution),
    }),
    /simulated lost child before head advancement/,
  );
  assert.equal((await controller.readCurrentFrame('research-retry', 'main')).head.frameId,
    parent.nextHead.frameId);

  const retried = await controller.advance('research-retry', 'main', { fuel: 100n });
  assert(lostFrameBytes !== null);
  assert.deepEqual(retried.frameBytes, lostFrameBytes);
  assert.equal(retried.frame.status, host.FrameStatus.completed);
  const digest = decodeDigestResult(retried.frame.finalResultBytes);
  assert.equal(digest.digest,
    'Static closure keeps authority external; canonical Frames keep continuation portable.');
  assert.equal(digest.itemCount, 2n);
  assert.equal(context.effectAttempted, 1);

  const replayInput = host.encodeStepInput({
    applicationId: manifest.applicationId,
    expectedParentFrameId: parent.frame.frameId,
    priorFrameBytes: parent.frameBytes,
    effectResult: resolution.result,
    fuel: 100n,
  }, manifest.limits);
  const replay = await freshStep(wasmBytes, replayInput);
  assert.deepEqual(replay.frameBytes, retried.frameBytes);

  const branch = await proveResearchBranching(wasmBytes, initialArgsBytes, resolution.result);
  const migration = await proveResearchMigration(wasmBytes, initialArgsBytes, resolution.result);
  return {
    completed: true,
    customEffect: true,
    internalProvider: true,
    externalCapability: true,
    freshInstanceResume: true,
    deterministicRetry: true,
    capabilityInvocations: context.effectAttempted,
    replayFreshEffects: 0,
    branchingChildren: branch.children,
    migrationReceiverPreflight: migration.receiverPreflight,
    digest: digest.digest,
    itemCount: digest.itemCount.toString(),
  };
}

async function proveResearchBranching(wasmBytes, initialArgsBytes, firstResult) {
  const blocks = new host.MemoryBlockStore();
  const heads = new host.MemoryBranchHeadStore();
  const controller = await host.RunControllerV1.create({ wasmBytes, blockStore: blocks, headStore: heads });
  const parent = await controller.initialize('research-branch', 'main', {
    initialArgsBytes,
    fuel: 100n,
  });
  const parentBytes = await blocks.getBlock(parent.frameRef);
  await controller.forkBranch('research-branch', 'main', 'alternate');
  const alternateResult = host.createEffectResult({
    requestId: parent.frame.pendingEffect.requestId,
    status: host.EffectStatus.ok,
    resultSchemaId: parent.frame.pendingEffect.resultSchemaId,
    resultBytes: capabilities.encodeResearchResponse({
      first: {
        title: 'A different research corpus',
        summary: 'The same parent may accept another valid result.',
      },
      second: {
        title: 'Branch isolation',
        summary: 'The parent Frame remains immutable.',
      },
      digestResult: {
        digest: 'Alternate valid research creates a distinct deterministic branch.',
        itemCount: 2n,
      },
    }),
  }, controller.manifest.limits);
  const main = await controller.advance('research-branch', 'main', {
    effectResult: firstResult,
    fuel: 100n,
  });
  const alternate = await controller.advance('research-branch', 'alternate', {
    effectResult: alternateResult,
    fuel: 100n,
  });
  assert.equal(main.previousHead.frameId, alternate.previousHead.frameId);
  assert.notEqual(main.nextHead.frameId, alternate.nextHead.frameId);
  assert.deepEqual(await blocks.getBlock(parent.frameRef), parentBytes);
  return { children: 2 };
}

async function proveResearchMigration(wasmBytes, initialArgsBytes, result) {
  const sourceBlocks = new host.MemoryBlockStore();
  const sourceHeads = new host.MemoryBranchHeadStore();
  let resultPersisted = false;
  const source = await host.RunControllerV1.create({
    wasmBytes,
    blockStore: sourceBlocks,
    headStore: sourceHeads,
    faultInjector: async (stage) => {
      if (stage === 'after-result-persistence' && !resultPersisted) {
        resultPersisted = true;
        throw new Error('simulated migration after result persistence');
      }
    },
  });
  await source.initialize('research-migration-source', 'main', {
    initialArgsBytes,
    fuel: 100n,
  });
  await assert.rejects(
    () => source.advance('research-migration-source', 'main', {
      effectResult: result,
      fuel: 100n,
    }),
    /simulated migration after result persistence/,
  );
  const bundle = await source.exportBranch('research-migration-source', 'main');
  assert(bundle.retainedEffectResultBytes !== null);

  const receiverBlocks = new host.MemoryBlockStore();
  const receiverHeads = new host.MemoryBranchHeadStore();
  let receiverPreflight = 0;
  const imported = await host.RunControllerV1.importBranch({
    bundle,
    runId: 'research-migration-receiver',
    branchId: 'main',
    blockStore: receiverBlocks,
    headStore: receiverHeads,
    preflight: async (manifest) => {
      receiverPreflight += 1;
      return {
        blockers: manifest.residualEffects.some((effect) =>
          effect.interfaceId.toString('hex') === capabilities.effectInterfaceId(
            capabilities.RESEARCH_LOOKUP_INTERFACE_LABEL,
          ).toString('hex'))
          ? []
          : ['research.lookup.v1 unavailable'],
      };
    },
  });
  const completed = await imported.controller.advance('research-migration-receiver', 'main', {
    fuel: 100n,
  });
  assert.equal(completed.frame.status, host.FrameStatus.completed);
  assert.equal(receiverPreflight, 1);
  return { receiverPreflight: true };
}

async function proveResearchNegatives() {
  const wasmBytes = applications['research-digest-agent'];
  const initialArgsBytes = encodeResearchRequest({
    query: 'portable algebraic effects',
    maximumItems: 2n,
  });
  const blocks = new host.MemoryBlockStore();
  const heads = new host.MemoryBranchHeadStore();
  const controller = await host.RunControllerV1.create({ wasmBytes, blockStore: blocks, headStore: heads });
  const parent = await controller.initialize('research-negative', 'main', {
    initialArgsBytes,
    fuel: 100n,
  });
  const request = parent.frame.pendingEffect;
  const router = new capabilities.CapabilityRouterV1({
    bindings: [capabilities.researchLookupFixtureBinding()],
  });
  const resolution = await router.resolve({
    policy: { researchLookup: true },
    effectAttempted: 0,
    attempt: 1,
  }, request.encodedBytes);

  const wrongTarget = host.createEffectResult({
    requestId: Buffer.alloc(32, 0xa5),
    status: host.EffectStatus.ok,
    resultSchemaId: request.resultSchemaId,
    resultBytes: resolution.result.resultBytes,
  }, controller.manifest.limits);
  await assert.rejects(
    () => controller.advance('research-negative', 'main', { effectResult: wrongTarget }),
    { code: 'ERR_APPLICATION_V1_RESULT_TARGET' },
  );

  const wrongSchema = host.createEffectResult({
    requestId: request.requestId,
    status: host.EffectStatus.ok,
    resultSchemaId: Buffer.alloc(32, 0x5a),
    resultBytes: resolution.result.resultBytes,
  }, controller.manifest.limits);
  await assert.rejects(
    () => controller.advance('research-negative', 'main', { effectResult: wrongSchema }),
    { code: 'ERR_APPLICATION_V1_RESULT_SCHEMA' },
  );
  assert.throws(
    () => host.createEffectResult({
      requestId: request.requestId,
      status: host.EffectStatus.ok,
      resultSchemaId: request.resultSchemaId,
      resultBytes: Buffer.alloc(controller.manifest.limits.maximumResultBytes + 1),
    }, controller.manifest.limits),
    { code: 'ERR_APPLICATION_V1_RESULT_LIMIT' },
  );

  await assert.rejects(
    () => host.RunControllerV1.create({
      wasmBytes,
      blockStore: new host.MemoryBlockStore(),
      headStore: new host.MemoryBranchHeadStore(),
      preflight: async () => ({ blockers: ['receiver result limit is insufficient'] }),
    }),
    { code: 'ERR_APPLICATION_V1_PREFLIGHT_BLOCKED' },
  );
  const missingRouter = new capabilities.CapabilityRouterV1({
    bindings: capabilities.fixtureAgentBindings(),
  });
  await assert.rejects(
    () => missingRouter.resolve({}, request.encodedBytes),
    { code: 'ERR_CAPABILITY_V1_INTERFACE_UNCOVERED' },
  );
  const deniedContext = { policy: { researchLookup: false }, effectAttempted: 0, attempt: 1 };
  const denied = await router.resolve(deniedContext, request.encodedBytes);
  assert.equal(denied.result.status, capabilities.EffectStatus.rejected);
  assert.equal(deniedContext.effectAttempted, 0);

  const altered = Buffer.from(wasmBytes);
  altered[0] ^= 0xff;
  await assert.rejects(
    () => host.RunControllerV1.create({
      wasmBytes: altered,
      blockStore: new host.MemoryBlockStore(),
      headStore: new host.MemoryBranchHeadStore(),
    }),
    { code: 'ERR_APPLICATION_V1_WASM_HEADER' },
  );

  const otherBlocks = new host.MemoryBlockStore();
  const sharedHeads = new host.MemoryBranchHeadStore();
  const other = await host.RunControllerV1.create({
    wasmBytes: applications['one-effect'],
    blockStore: otherBlocks,
    headStore: sharedHeads,
  });
  await other.initialize('other-application-frame', 'main', {
    initialArgsBytes: Buffer.alloc(0),
    fuel: 100n,
  });
  const researchOnOtherHead = await host.RunControllerV1.create({
    wasmBytes,
    blockStore: otherBlocks,
    headStore: sharedHeads,
  });
  await assert.rejects(
    () => researchOnOtherHead.advance('other-application-frame', 'main'),
    { code: 'ERR_APPLICATION_V1_HEAD_APPLICATION' },
  );

  await controller.effectJournal.persistResult({
    runId: 'research-negative',
    branchId: 'main',
    parentFrameId: parent.frame.frameId,
    request,
    result: resolution.result,
    limits: controller.manifest.limits,
    handlerId: 'research-negative-fixture',
    handlerConfigurationId: 'research-negative-fixture-v1',
    recoveryClass: 'replayable',
    fuel: 100n,
  });
  const conflictingBytes = Buffer.from(resolution.result.resultBytes);
  conflictingBytes[conflictingBytes.length - 1] ^= 1;
  const conflictingResult = host.createEffectResult({
    requestId: request.requestId,
    status: host.EffectStatus.ok,
    resultSchemaId: request.resultSchemaId,
    resultBytes: conflictingBytes,
  }, controller.manifest.limits);
  await assert.rejects(
    () => controller.advance('research-negative', 'main', {
      effectResult: conflictingResult,
      fuel: 100n,
    }),
    { code: 'ERR_APPLICATION_V1_EFFECT_RESULT_CONFLICT' },
  );
  assert.equal(
    (await controller.readCurrentFrame('research-negative', 'main')).frame.status,
    host.FrameStatus.needsEffect,
  );

  const completed = await controller.advance('research-negative', 'main', {
    effectResult: resolution.result,
    fuel: 100n,
  });
  assert.equal(completed.frame.status, host.FrameStatus.completed);

  const bundle = await controller.exportBranch('research-negative', 'main');
  const wrongManifest = {
    ...bundle,
    manifestBytes: Buffer.from(bundle.manifestBytes),
  };
  wrongManifest.manifestBytes[12] ^= 1;
  await assert.rejects(
    () => host.RunControllerV1.importBranch({
      bundle: wrongManifest,
      runId: 'wrong-manifest',
      branchId: 'main',
      blockStore: new host.MemoryBlockStore(),
      headStore: new host.MemoryBranchHeadStore(),
    }),
    { code: 'ERR_APPLICATION_V1_MIGRATION_MANIFEST' },
  );

  return {
    wrongApplicationManifest: true,
    wrongEffectResultTarget: true,
    staleOrDuplicateResult: true,
    wrongSchema: true,
    excessiveResponseBytes: true,
    insufficientReceiverLimits: true,
    missingCapability: true,
    capabilityPolicyDenial: true,
    alteredWasmBytes: true,
    frameForAnotherApplication: true,
  };
}

async function proveResearchCli(root) {
  const storeRoot = path.join(root, 'research-cli-store');
  const receiverRoot = path.join(root, 'research-cli-receiver');
  const initialArgsPath = path.join(root, 'research-initial-args.bin');
  const freshResultPath = path.join(root, 'research-fresh-result.bin');
  const alternateResultPath = path.join(root, 'research-alternate-result.bin');
  const migrationPath = path.join(root, 'research-migration.json');
  const wasmPath = path.join(pack, 'applications/research-digest-agent.world.wasm');
  await writeFile(initialArgsPath, encodeResearchRequest({
    query: 'portable algebraic effects',
    maximumItems: 2n,
  }));

  const inspectedApp = await packedCli(['inspect-app', wasmPath]);
  assert.equal(inspectedApp.inspectionMode, 'isolated-runtime');
  assert.equal(inspectedApp.application.name, 'research-digest-agent');
  assert.equal(inspectedApp.abi.application, 1);
  assert.equal(inspectedApp.abi.frame, 1);
  assert.equal(inspectedApp.wasm.importCount, 0);
  assert.equal(inspectedApp.residualEffects.length, 1);

  const installed = await packedCli([
    'install',
    '--store', storeRoot,
    '--name', 'research-digest-agent',
    '--wasm', wasmPath,
  ]);
  assert.equal(installed.application.name, 'research-digest-agent');
  const started = await packedCli([
    'run',
    '--store', storeRoot,
    '--app', 'research-digest-agent',
    '--run', 'research-cli-run',
    '--initial-args', initialArgsPath,
    '--fuel', '100',
  ]);
  assert.equal(started.frame.status, 'needsEffect');
  await packedCli([
    'branch',
    '--store', storeRoot,
    '--run', 'research-cli-run',
    '--branch', 'alternate',
  ]);

  const store = new host.DirectoryApplicationStoreV1(storeRoot);
  const head = await store.headStore.readHead('research-cli-run', 'main');
  const application = await store.applications.get(head.applicationId);
  const manifest = host.decodeApplicationManifest(await store.blockStore.getBlock(application.manifestRef));
  const parent = host.decodeFrame(await store.blockStore.getBlock(head.frameRef), manifest.limits);
  const router = new capabilities.CapabilityRouterV1({
    bindings: [capabilities.researchLookupFixtureBinding()],
  });
  const resolution = await router.resolve({
    policy: { researchLookup: true },
    effectAttempted: 0,
    attempt: 1,
  }, parent.pendingEffect.encodedBytes);
  await writeFile(freshResultPath, resolution.result.encodedBytes);
  await store.effectJournal.persistResult({
    runId: 'research-cli-run',
    branchId: 'main',
    parentFrameId: parent.frameId,
    request: parent.pendingEffect,
    result: resolution.result,
    limits: manifest.limits,
    fuel: 100n,
    ...resolutionMetadata(resolution),
  });
  await packedCli([
    'branch',
    '--store', storeRoot,
    '--run', 'research-cli-run',
    '--branch', 'replay',
  ]);
  for (const [command, branchId] of [['retry', 'main'], ['replay', 'replay']]) {
    const rejected = await packedCliFailure([
      command,
      '--store', storeRoot,
      '--run', 'research-cli-run',
      '--branch', branchId,
      '--effect-result', freshResultPath,
      '--fuel', '100',
    ]);
    assert.notEqual(rejected.exitCode, 0);
    assert.match(rejected.stderr, /ERR_APPLICATION_V1_CLI_OPTION/);
  }
  const retried = await packedCli([
    'retry',
    '--store', storeRoot,
    '--run', 'research-cli-run',
    '--fuel', '100',
  ]);
  const replayed = await packedCli([
    'replay',
    '--store', storeRoot,
    '--run', 'research-cli-run',
    '--branch', 'replay',
    '--fuel', '100',
  ]);
  assert.equal(retried.frame.status, 'completed');
  assert.equal(replayed.frame.status, 'completed');
  assert.equal(retried.frame.frameId, replayed.frame.frameId);

  const alternateResult = host.createEffectResult({
    requestId: parent.pendingEffect.requestId,
    status: host.EffectStatus.ok,
    resultSchemaId: parent.pendingEffect.resultSchemaId,
    resultBytes: capabilities.encodeResearchResponse({
      first: {
        title: 'CLI alternate research',
        summary: 'A second valid result advances an isolated branch.',
      },
      second: {
        title: 'Portable operator flow',
        summary: 'The host remains application-independent.',
      },
      digestResult: {
        digest: 'CLI branching preserves the parent and isolates the child.',
        itemCount: 2n,
      },
    }),
  }, manifest.limits);
  await writeFile(alternateResultPath, alternateResult.encodedBytes);
  const alternate = await packedCli([
    'resume',
    '--store', storeRoot,
    '--run', 'research-cli-run',
    '--branch', 'alternate',
    '--effect-result', alternateResultPath,
    '--fuel', '100',
  ]);
  assert.equal(alternate.frame.status, 'completed');
  assert.notEqual(alternate.frame.frameId, retried.frame.frameId);

  await packedCli([
    'export',
    '--store', storeRoot,
    '--run', 'research-cli-run',
    '--out', migrationPath,
  ]);
  const imported = await packedCli([
    'import',
    '--store', receiverRoot,
    '--in', migrationPath,
    '--run', 'research-cli-imported',
    '--name', 'research-digest-agent',
  ]);
  assert.equal(imported.receiverPreflightApplied, true);
  const inspectedRun = await packedCli([
    'inspect',
    '--store', receiverRoot,
    '--run', 'research-cli-imported',
  ]);
  assert.equal(inspectedRun.frame.status, 'completed');
  assert.equal(inspectedRun.frame.finalResult.byteLength > 0, true);
  const rendered = JSON.stringify({ inspectedApp, installed, started, retried, replayed, alternate, imported, inspectedRun });
  assert(!rendered.includes('portable algebraic effects'));
  assert(!rendered.includes('Static closure keeps authority external'));
  return {
    inspectApp: true,
    install: true,
    run: true,
    resume: true,
    retry: true,
    replay: true,
    retainedResultOnly: true,
    branch: true,
    export: true,
    import: true,
    payloadBytesExposed: false,
  };
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

function resolutionMetadata(resolution) {
  return {
    handlerId: resolution.handlerIdentity,
    handlerConfigurationId: resolution.handlerConfigurationIdentity,
    recoveryClass: resolution.recoveryClass,
  };
}

function encodeResearchRequest(value) {
  const query = Buffer.from(value.query, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(query.length);
  const maximumItems = Buffer.alloc(8);
  maximumItems.writeBigUInt64LE(value.maximumItems);
  return Buffer.concat([length, query, maximumItems]);
}

function decodeDigestResult(bytes) {
  const value = Buffer.from(bytes);
  const digestLength = value.readUInt32LE(0);
  const digestEnd = 4 + digestLength;
  assert.equal(digestEnd + 8, value.length);
  return {
    digest: value.subarray(4, digestEnd).toString('utf8'),
    itemCount: value.readBigUInt64LE(digestEnd),
  };
}

async function packedCli(args) {
  const result = await invokePackedCli(args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `world-host-v1 exited ${result.exitCode}`);
  }
  return JSON.parse(result.stdout);
}

async function packedCliFailure(args) {
  return await invokePackedCli(args);
}

async function invokePackedCli(args) {
  const child = Bun.spawn([
    process.execPath,
    path.join(pack, 'host/bin/world-host-v1.mjs'),
    ...args,
  ], {
    cwd: pack,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function packRoot(argument) {
  if (argument) return path.resolve(argument);
  const current = fileURLToPath(import.meta.url);
  if (path.basename(path.dirname(current)) === 'conformance') return path.resolve(path.dirname(current), '..');
  return path.resolve('agent-runtime-v1');
}
