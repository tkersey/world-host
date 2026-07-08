import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createApplicationRecord } from '../src/core/application.mjs';
import { EffectJournal, EffectState } from '../src/core/effect_journal.mjs';
import { exportCarrierRun, forkRunBranch, importCarrierRun } from '../src/core/migration.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../src/core/run.mjs';
import { fromUtf8, stableJson } from '../src/core/store.mjs';
import { RunController, WorldWorker } from '../src/core/worker.mjs';
import { BunStoreLock } from '../src/bun/bun_lock.mjs';
import { agentWorldHostRequestToEffectRequest, agentWorldRequestDriver, redact, runBunCli } from '../src/bun/bun_cli.mjs';
import { decodeApplianceManifest, decodeResolutionInputBytes, encodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';
import { encodeCanonicalValueImage, wyhash64 } from '../src/protocol/world_loaded_value_codec.mjs';
import { inspectTurnOutput, summarizeTurnClosureForRunHead } from '../src/protocol/world_universal_appliance_codec.mjs';
import { DirectoryStore } from '../src/stores/directory_store.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';
import { FixtureAgentModelDriver } from '../src/drivers/fixture_agent_model_driver.mjs';
import { SandboxFileDriver } from '../src/drivers/sandbox_file_driver.mjs';
import { refreshAgentRuntimePackChecksums } from '../scripts/agent_runtime_pack_lib.mjs';
import { capabilityPackFingerprint } from '../src/core/capability_pack.mjs';

describe('migration, branching, and CLI diagnostics', () => {
  it('forks a branch without mutating the source branch head', async () => {
    const { store, run, head } = await fixtureStore();
    const branch = await forkRunBranch(store, {
      runId: run.runId,
      sourceBranchId: 'main',
      sourceClosureFingerprint: head.turnClosureWorldFingerprint,
      newBranchId: 'alternate',
    });
    assert.equal(branch.parentBranchId, 'main');
    assert.equal((await store.readHead(run.runId, 'main')).generation, 0);
    assert.equal((await store.readHead(run.runId, 'alternate')).turnClosureWorldFingerprint, head.turnClosureWorldFingerprint);
    assert.equal((await store.getRun(run.runId)).branches.some((item) => item.branchId === 'alternate' && item.parentBranchId === 'main'), true);
    await assert.rejects(() => forkRunBranch(store, {
      runId: run.runId,
      sourceBranchId: 'main',
      sourceClosureFingerprint: head.turnClosureWorldFingerprint,
      newBranchId: 'alternate',
    }), { code: 'ERR_BRANCH_EXISTS' });
  });

  it('resumes fork metadata publication after matching branch head publication', async () => {
    const { store, run, head } = await fixtureStore();
    store.heads.set(stableJson([run.runId, 'alternate']), JSON.parse(JSON.stringify(head)));
    store.heads.set(stableJson([run.runId, 'main']), JSON.parse(JSON.stringify({
      ...head,
      generation: head.generation + 1,
      turnClosureWorldFingerprint: 'world:closure:advanced',
    })));

    const branch = await forkRunBranch(store, {
      runId: run.runId,
      sourceBranchId: 'main',
      sourceClosureFingerprint: head.turnClosureWorldFingerprint,
      newBranchId: 'alternate',
    });

    assert.equal(branch.parentBranchId, 'main');
    assert.equal(branch.forkedFromTurnClosureFingerprint, head.turnClosureWorldFingerprint);
    assert.equal((await store.getRun(run.runId)).branches.some((item) => item.branchId === 'alternate'), true);
  });

  it('forks a historical stored TurnClosure after the source branch advances', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-historical-fork-'));
    try {
      const { run, head } = await fixtureDirectoryStore(root, { closureOptions: { status: 1 } });
      const store = new DirectoryStore(root);
      const advancedBytes = fixtureTurnClosureBytes({
        closureFingerprint: 0x222n,
        turnSequenceNumber: 2n,
        resultingStateFingerprint: 0x402n,
        chronicleResultingCursorFingerprint: 0x404n,
      });
      const advancedSummary = summarizeTurnClosureForRunHead(advancedBytes);
      const advancedRef = await store.putBlob(advancedBytes);
      const advancedHead = createRunHead({
        generation: head.generation + 1,
        turnClosureRef: advancedRef,
        turnClosureWorldFingerprint: advancedSummary.turnClosureWorldFingerprint,
        resultingStateFingerprint: advancedSummary.resultingStateFingerprint,
        chronicleCursor: advancedSummary.chronicleCursor,
        archiveMomentFingerprint: advancedSummary.archiveMomentFingerprint,
        archiveSealFingerprint: advancedSummary.archiveSealFingerprint,
        status: advancedSummary.status,
      });
      await store.writeHead(run.runId, 'main', advancedHead);

      const branch = await forkRunBranch(store, {
        runId: run.runId,
        sourceBranchId: 'main',
        sourceClosureFingerprint: head.turnClosureWorldFingerprint,
        newBranchId: 'historic',
      });

      assert.equal(branch.forkedFromTurnClosureFingerprint, head.turnClosureWorldFingerprint);
      assert.equal((await store.readHead(run.runId, 'historic')).turnClosureWorldFingerprint, head.turnClosureWorldFingerprint);
      assert.equal((await store.readHead(run.runId, 'historic')).generation, 2);
      assert.equal((await store.readHead(run.runId, 'main')).turnClosureWorldFingerprint, advancedHead.turnClosureWorldFingerprint);
      assert.equal((await store.getRun(run.runId)).branches.some((item) => item.branchId === 'historic'), true);

      const controller = new RunController({ store, workerFactory: async () => new DeterministicCliWorker('historic', { startSequence: 2n }) });
      const advancedHistoric = await controller.advance(run.runId, 'historic');
      assert.equal(advancedHistoric.status, 'advanced');
      assert.equal(advancedHistoric.nextHead.generation, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves retained archive anchors when forking a historical archive-less closure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-historical-archive-less-fork-'));
    try {
      const { run, head } = await fixtureDirectoryStore(root, { closureOptions: { status: 1, archiveLess: true } });
      const store = new DirectoryStore(root);
      const retainedHead = createRunHead({
        ...head,
        archiveMomentFingerprint: 'world:archive-moment:retained',
        archiveSealFingerprint: 'world:archive-seal:retained',
      });
      const advancedBytes = fixtureTurnClosureBytes({
        closureFingerprint: 0x322n,
        turnSequenceNumber: 2n,
        resultingStateFingerprint: 0x432n,
        chronicleResultingCursorFingerprint: 0x434n,
      });
      const advancedSummary = summarizeTurnClosureForRunHead(advancedBytes);
      const advancedRef = await store.putBlob(advancedBytes);
      const advancedHead = createRunHead({
        generation: retainedHead.generation + 1,
        turnClosureRef: advancedRef,
        turnClosureWorldFingerprint: advancedSummary.turnClosureWorldFingerprint,
        resultingStateFingerprint: advancedSummary.resultingStateFingerprint,
        chronicleCursor: advancedSummary.chronicleCursor,
        archiveMomentFingerprint: advancedSummary.archiveMomentFingerprint,
        archiveSealFingerprint: advancedSummary.archiveSealFingerprint,
        status: advancedSummary.status,
      });
      await store.writeHead(run.runId, 'main', advancedHead);
      const currentRun = await store.getRun(run.runId);
      await store.writeRun(createRunRecord({
        ...currentRun,
        branches: currentRun.branches.map((branch) => branch.branchId === 'main'
          ? createBranchRecord({
              ...branch,
              currentHead: advancedHead,
              diagnostics: {
                ...branch.diagnostics,
                historicalTurnClosureFingerprints: [retainedHead.turnClosureWorldFingerprint],
                historicalTurnClosureRefs: [retainedHead.turnClosureRef],
                historicalRunHeads: [retainedHead],
              },
            })
          : branch),
      }));

      const branch = await forkRunBranch(store, {
        runId: run.runId,
        sourceBranchId: 'main',
        sourceClosureFingerprint: retainedHead.turnClosureWorldFingerprint,
        newBranchId: 'historic-retained',
      });
      const forkedHead = await store.readHead(run.runId, 'historic-retained');

      assert.equal(branch.forkedFromTurnClosureFingerprint, retainedHead.turnClosureWorldFingerprint);
      assert.equal(forkedHead.archiveMomentFingerprint, 'world:archive-moment:retained');
      assert.equal(forkedHead.archiveSealFingerprint, 'world:archive-seal:retained');
      assert.equal(forkedHead.updateDiagnostics.selectedStoredClosure, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects historical forks from another run in the same store', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-cross-run-fork-'));
    try {
      const { run } = await fixtureDirectoryStore(root, { closureOptions: { status: 0 } });
      const store = new DirectoryStore(root);
      const otherImageRef = await store.putBlob(fromUtf8('other-image'));
      const otherWasmRef = await store.putBlob(fromUtf8('other-wasm'));
      const otherManifestRef = await store.putBlob(fromUtf8('other-manifest'));
      const otherClosureBytes = fixtureTurnClosureBytes({
        closureFingerprint: 0x333n,
        turnSequenceNumber: 1n,
        resultingStateFingerprint: 0x433n,
        chronicleResultingCursorFingerprint: 0x434n,
      });
      const otherSummary = summarizeTurnClosureForRunHead(otherClosureBytes);
      const otherClosureRef = await store.putBlob(otherClosureBytes);
      const otherApp = createApplicationRecord({
        applicationId: 'other-directory-app',
        universalWasmChecksum: `sha256:${otherWasmRef.checksum}`,
        universalWasmByteLength: otherWasmRef.byteLength,
        worldProtocolVersion: 'v0.1.0',
        applianceAbiVersion: 'v4',
        executableImageRef: otherImageRef,
        executableImageWorldFingerprint: 'world:image:other-directory',
        applianceManifestRef: otherManifestRef,
        requiredActuators: [],
        requiredRuntimeLimits: {},
        installationDiagnostics: {},
      });
      await store.createApplication(otherApp);
      const otherHead = createRunHead({
        generation: otherSummary.inspectionDiagnostics.turnSequenceNumber + 1,
        turnClosureRef: otherClosureRef,
        turnClosureWorldFingerprint: otherSummary.turnClosureWorldFingerprint,
        resultingStateFingerprint: otherSummary.resultingStateFingerprint,
        chronicleCursor: otherSummary.chronicleCursor,
        archiveMomentFingerprint: otherSummary.archiveMomentFingerprint,
        archiveSealFingerprint: otherSummary.archiveSealFingerprint,
        status: otherSummary.status,
      });
      await store.createRun(createRunRecord({
        runId: 'other-directory-run',
        applicationId: otherApp.applicationId,
        branches: [createBranchRecord({ branchId: 'main', currentHead: otherHead })],
        effectJournalNamespace: 'other-directory-run:effects',
      }));

      await assert.rejects(() => forkRunBranch(store, {
        runId: run.runId,
        sourceBranchId: 'main',
        sourceClosureFingerprint: otherSummary.turnClosureWorldFingerprint,
        newBranchId: 'grafted',
      }), { code: 'ERR_FORK_SOURCE_CLOSURE_NOT_STORED' });
      await assert.rejects(() => store.readHead(run.runId, 'grafted'), { code: 'ERR_HEAD_NOT_FOUND' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('forks an intermediate closure recorded by normal branch advancement', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-advanced-fork-'));
    try {
      const { run } = await fixtureDirectoryStore(root, { closureOptions: { status: 1 } });
      const store = new DirectoryStore(root);
      const worker = new SequencedCliWorker([
        { closureFingerprint: 0x444n, turnSequenceNumber: 2n, resultingStateFingerprint: 0x504n, chronicleResultingCursorFingerprint: 0x604n, status: 1 },
        { closureFingerprint: 0x555n, turnSequenceNumber: 3n, resultingStateFingerprint: 0x505n, chronicleResultingCursorFingerprint: 0x605n },
      ]);
      const controller = new RunController({ store, workerFactory: async () => worker });
      const firstAdvance = await controller.advance(run.runId, 'main');
      const secondAdvance = await controller.advance(run.runId, 'main');

      assert.equal(firstAdvance.status, 'advanced');
      assert.equal(secondAdvance.status, 'advanced');
      assert.notEqual(firstAdvance.nextHead.turnClosureWorldFingerprint, secondAdvance.nextHead.turnClosureWorldFingerprint);

      const branch = await forkRunBranch(store, {
        runId: run.runId,
        sourceBranchId: 'main',
        sourceClosureFingerprint: firstAdvance.nextHead.turnClosureWorldFingerprint,
        newBranchId: 'midpoint',
      });

      assert.equal(branch.forkedFromTurnClosureFingerprint, firstAdvance.nextHead.turnClosureWorldFingerprint);
      assert.equal((await store.readHead(run.runId, 'midpoint')).turnClosureWorldFingerprint, firstAdvance.nextHead.turnClosureWorldFingerprint);
      const exported = await store.exportRun(run.runId, 'main');
      assert.equal(exported.blobs.some((blob) =>
        blob.checksum === firstAdvance.nextHead.turnClosureRef.checksum &&
        blob.byteLength === firstAdvance.nextHead.turnClosureRef.byteLength), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('forks a sequence-zero boot closure after the branch advances again', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-sequence-zero-fork-'));
    const receiverRoot = await mkdtemp(path.join(tmpdir(), 'world-host-sequence-one-fork-import-'));
    try {
      const store = new DirectoryStore(root);
      const imageRef = await store.putBlob(fromUtf8('image'));
      const wasmRef = await store.putBlob(fromUtf8('wasm'));
      const manifestRef = await store.putBlob(fixtureApplianceManifestBytes({ manifestFingerprint: 0x211n }));
      const genesisRef = await store.putBlob(fromUtf8('genesis'));
      const app = createApplicationRecord({
        applicationId: 'sequence-zero-app',
        universalWasmChecksum: `sha256:${wasmRef.checksum}`,
        universalWasmByteLength: wasmRef.byteLength,
        worldProtocolVersion: 'v0.1.0',
        applianceAbiVersion: 'v4',
        executableImageRef: imageRef,
        executableImageWorldFingerprint: 'world:image:sequence-zero',
        applianceManifestRef: manifestRef,
        requiredActuators: [],
        requiredRuntimeLimits: {},
        installationDiagnostics: { manifestSource: 'host-generated-install-summary' },
      });
      await store.createApplication(app);
      const genesisHead = createRunHead({
        generation: 0,
        turnClosureRef: genesisRef,
        turnClosureWorldFingerprint: 'world:turn-closure:genesis',
        resultingStateFingerprint: 'world:state:genesis',
        chronicleCursor: 'world:chronicle:genesis',
        archiveMomentFingerprint: 'world:archive-moment:genesis',
        archiveSealFingerprint: 'world:archive-seal:genesis',
        status: 'genesis',
      });
      const run = createRunRecord({
        runId: 'sequence-zero-run',
        applicationId: app.applicationId,
        branches: [createBranchRecord({ branchId: 'main', currentHead: genesisHead })],
        effectJournalNamespace: 'sequence-zero-run:effects',
      });
      await store.createRun(run);
      const worker = new SequencedCliWorker([
        { closureFingerprint: 0x900n, turnSequenceNumber: 0n, resultingStateFingerprint: 0x910n, chronicleResultingCursorFingerprint: 0x920n, status: 1 },
        { closureFingerprint: 0x901n, turnSequenceNumber: 1n, resultingStateFingerprint: 0x911n, chronicleResultingCursorFingerprint: 0x921n, status: 1 },
        { closureFingerprint: 0x902n, turnSequenceNumber: 2n, resultingStateFingerprint: 0x912n, chronicleResultingCursorFingerprint: 0x922n },
      ]);
      const controller = new RunController({ store, workerFactory: async () => worker });
      const bootAdvance = await controller.advance(run.runId, 'main');
      const secondAdvance = await controller.advance(run.runId, 'main');
      const thirdAdvance = await controller.advance(run.runId, 'main');

      assert.equal(bootAdvance.nextHead.generation, 1);
      assert.equal(bootAdvance.nextHead.updateDiagnostics.inspectedTurnClosure.turnSequenceNumber, 0);
      assert.equal(secondAdvance.status, 'advanced');
      assert.equal(secondAdvance.nextHead.generation, 2);
      assert.equal(thirdAdvance.status, 'advanced');

      const branch = await forkRunBranch(store, {
        runId: run.runId,
        sourceBranchId: 'main',
        sourceClosureFingerprint: bootAdvance.nextHead.turnClosureWorldFingerprint,
        newBranchId: 'boot',
      });

      assert.equal(branch.forkedFromTurnClosureFingerprint, bootAdvance.nextHead.turnClosureWorldFingerprint);
      assert.equal((await store.readHead(run.runId, 'boot')).generation, 1);

      const restoreBranch = await forkRunBranch(store, {
        runId: run.runId,
        sourceBranchId: 'main',
        sourceClosureFingerprint: secondAdvance.nextHead.turnClosureWorldFingerprint,
        newBranchId: 'restore',
      });
      const restoreHead = await store.readHead(run.runId, 'restore');
      assert.equal(restoreBranch.forkedFromTurnClosureFingerprint, secondAdvance.nextHead.turnClosureWorldFingerprint);
      assert.equal(restoreHead.generation, 2);

      const packagePath = path.join(receiverRoot, 'restore-export.json');
      let output = '';
      assert.equal(await runBunCli([
        'export',
        '--json',
        '--store', root,
        '--run', run.runId,
        '--branch', 'restore',
        '--out', packagePath,
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      }), 0);
      assert.doesNotMatch(output, /bytesHex/);

      output = '';
      assert.equal(await runBunCli([
        'import',
        '--json',
        '--store', receiverRoot,
        '--package', packagePath,
        '--run', 'receiver-restore-run',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      }), 0);
      assert.equal(JSON.parse(output).runId, 'receiver-restore-run');
      const receiverStore = new DirectoryStore(receiverRoot);
      const receiverHead = await receiverStore.readHead('receiver-restore-run', 'restore');
      assert.equal(receiverHead.generation, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(receiverRoot, { recursive: true, force: true });
    }
  });

  it('does not unlink another store lock after failed acquisition cleanup', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-lock-'));
    const lockPath = path.join(root, 'store.lock');
    const owner = new BunStoreLock(lockPath);
    const contender = new BunStoreLock(lockPath);
    const afterCleanup = new BunStoreLock(lockPath);
    try {
      await owner.acquire();
      await assert.rejects(() => contender.acquire(), { code: 'EEXIST' });
      await contender.release();
      await assert.rejects(() => afterCleanup.acquire(), { code: 'EEXIST' });
    } finally {
      await afterCleanup.release();
      await contender.release();
      await owner.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not break an active store lock owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-lock-'));
    const lockPath = path.join(root, 'store.lock');
    const owner = new BunStoreLock(lockPath);
    const replacement = new BunStoreLock(lockPath);
    const afterRelease = new BunStoreLock(lockPath);
    try {
      await owner.acquire();
      await assert.rejects(() => replacement.acquire({ breakStale: true }), { code: 'EEXIST' });
      await owner.release();
      await afterRelease.acquire();
    } finally {
      await afterRelease.release();
      await replacement.release();
      await owner.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('breaks a lock only when the recorded owner is not alive', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-dead-lock-'));
    const lockPath = path.join(root, 'store.lock');
    const replacement = new BunStoreLock(lockPath);
    const contender = new BunStoreLock(lockPath);
    try {
      await writeFile(lockPath, JSON.stringify({ ownerToken: 'dead-owner', pid: 999999999 }));
      await replacement.acquire({ breakStale: true });
      await assert.rejects(() => contender.acquire(), { code: 'EEXIST' });
    } finally {
      await contender.release();
      await replacement.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('breaks malformed stale lock metadata only during explicit recovery', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-malformed-lock-'));
    const lockPath = path.join(root, 'store.lock');
    const blocked = new BunStoreLock(lockPath);
    const replacement = new BunStoreLock(lockPath);
    try {
      await writeFile(lockPath, '{not-json');
      await assert.rejects(() => blocked.acquire(), { code: 'EEXIST' });
      await replacement.acquire({ breakStale: true });
    } finally {
      await replacement.release();
      await blocked.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('breaks falsy malformed stale lock metadata during explicit recovery', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-null-lock-'));
    const lockPath = path.join(root, 'store.lock');
    const replacement = new BunStoreLock(lockPath);
    try {
      await writeFile(lockPath, 'null');
      await replacement.acquire({ breakStale: true });
    } finally {
      await replacement.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects half-paired archive anchors and malformed receiver policy refs at run boundaries', async () => {
    const blobRef = { algorithm: 'sha256', checksum: '0'.repeat(64), byteLength: 0 };

    assert.throws(
      () => createRunHead({
        generation: 1,
        turnClosureRef: blobRef,
        turnClosureWorldFingerprint: 'world:closure',
        resultingStateFingerprint: 'world:state',
        chronicleCursor: 'world:chronicle',
        archiveMomentFingerprint: 'world:archive-moment',
        archiveSealFingerprint: null,
        status: 'needs_host',
      }),
      { code: 'ERR_ARCHIVE_ANCHOR_PAIR_REQUIRED' },
    );
    assert.throws(
      () => createRunRecord({
        runId: 'run',
        applicationId: 'app',
        branches: [],
        effectJournalNamespace: 'run:effects',
        receiverPolicyRef: 'local-policy-marker',
      }),
      { code: 'ERR_INVALID_BLOB_REF' },
    );
    assert.throws(
      () => createRunRecord({
        runId: 'run',
        applicationId: 'app',
        branches: [{ branchId: 'main' }],
        effectJournalNamespace: 'run:effects',
      }),
      { code: 'ERR_INVALID_RUN_HEAD' },
    );
  });

  it('serializes DirectoryStore head CAS across instances with the same root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-head-cas-'));
    try {
      const { run, head } = await fixtureDirectoryStore(root);
      const first = new DirectoryStore(root);
      const second = new DirectoryStore(root);
      const firstClosureRef = await first.putBlob(fromUtf8('next-one'));
      const secondClosureRef = await second.putBlob(fromUtf8('next-two'));
      const nextOne = createRunHead({
        ...head,
        generation: head.generation + 1,
        turnClosureRef: firstClosureRef,
        turnClosureWorldFingerprint: 'world:closure:next-one',
      });
      const nextTwo = createRunHead({
        ...head,
        generation: head.generation + 1,
        turnClosureRef: secondClosureRef,
        turnClosureWorldFingerprint: 'world:closure:next-two',
      });

      const results = await Promise.all([
        first.compareAndSwapHead(run.runId, 'main', head.generation, nextOne),
        second.compareAndSwapHead(run.runId, 'main', head.generation, nextTwo),
      ]);

      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.equal((await first.readHead(run.runId, 'main')).generation, head.generation + 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes a lock file when acquisition metadata write fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-lock-write-failure-'));
    const lockPath = path.join(root, 'store.lock');
    const failing = new BunStoreLock(lockPath, {
      writeMetadata: async () => {
        const error = new Error('test metadata write failed');
        error.code = 'ERR_TEST_LOCK_METADATA_WRITE_FAILED';
        throw error;
      },
    });
    const afterFailure = new BunStoreLock(lockPath);
    try {
      await assert.rejects(() => failing.acquire(), { code: 'ERR_TEST_LOCK_METADATA_WRITE_FAILED' });
      await afterFailure.acquire();
    } finally {
      await afterFailure.release();
      await failing.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not unlink a replacement lock after acquisition metadata write failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-lock-write-failure-replacement-'));
    const lockPath = path.join(root, 'store.lock');
    const replacement = new BunStoreLock(lockPath);
    const failing = new BunStoreLock(lockPath, {
      writeMetadata: async () => {
        await rm(lockPath, { force: true });
        await replacement.acquire();
        const error = new Error('test metadata write failed after replacement');
        error.code = 'ERR_TEST_LOCK_METADATA_WRITE_FAILED';
        throw error;
      },
    });
    const contender = new BunStoreLock(lockPath);
    const afterRelease = new BunStoreLock(lockPath);
    try {
      await assert.rejects(() => failing.acquire(), { code: 'ERR_TEST_LOCK_METADATA_WRITE_FAILED' });
      await assert.rejects(() => contender.acquire(), { code: 'EEXIST' });
      await replacement.release();
      await afterRelease.acquire();
    } finally {
      await afterRelease.release();
      await contender.release();
      await failing.release();
      await replacement.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exports and imports with receiver-local run id and no authority transfer', async () => {
    const source = await fixtureStore();
    const senderPolicyRef = await source.store.putBlob(fromUtf8('sender-local-policy'));
    const historicalDiagnosticBytes = fromUtf8('historical closure retained by branch diagnostics');
    const historicalDiagnosticRef = await source.store.putBlob(historicalDiagnosticBytes);
    const sourceApplication = await source.store.getApplication(source.run.applicationId);
    source.store.applications.set(sourceApplication.applicationId, JSON.parse(JSON.stringify(createApplicationRecord({
      ...sourceApplication,
      installationDiagnostics: {
        ...sourceApplication.installationDiagnostics,
        receiverPolicyRef: senderPolicyRef,
      },
    }))));
    const diagnosticHead = createRunHead({
      ...source.head,
      updateDiagnostics: {
        ...source.head.updateDiagnostics,
        receiverPolicyRef: senderPolicyRef,
        historicalTurnClosureRefs: [historicalDiagnosticRef],
      },
    });
    assert.equal((await source.store.compareAndSwapHead(source.run.runId, 'main', source.head.generation, diagnosticHead)).ok, true);
    await source.store.writeRun(createRunRecord({
      ...source.run,
      branches: source.run.branches.map((branch) => branch.branchId === 'main'
        ? createBranchRecord({
            ...branch,
            diagnostics: {
              ...branch.diagnostics,
              receiverPolicyRef: senderPolicyRef,
              historicalTurnClosureRefs: [historicalDiagnosticRef],
            },
          })
        : branch),
      creationMetadata: {
        ...source.run.creationMetadata,
        receiverPolicyRef: senderPolicyRef,
      },
      receiverPolicyRef: senderPolicyRef,
    }));
    const journal = new EffectJournal({
      store: source.store,
      runId: source.run.runId,
      branchId: 'main',
      parentTurnClosureFingerprint: 'world:closure:parent',
    });
    const resolved = await journal.resolve({}, {
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture',
      actuationClass: 'fixture',
      responseSchema: { status: 'ok' },
      idempotencyKeyBytes: fromUtf8('sender-policy-effect-key'),
      idempotencyKeyWorldFingerprint: 'world:key:sender-policy-effect',
      requestBytes: fromUtf8('request:sender-policy-effect'),
      hostRequestFingerprint: 'world:host-request:0000000000000c01',
    }, fixtureDriver());
    await source.store.putEffectRecord({
      ...resolved.record,
      diagnostics: {
        ...resolved.record.diagnostics,
        receiverPolicyRef: senderPolicyRef,
      },
    });
    await forkRunBranch(source.store, {
      runId: source.run.runId,
      sourceBranchId: 'main',
      sourceClosureFingerprint: source.head.turnClosureWorldFingerprint,
      newBranchId: 'alternate',
    });
    const carrierExport = await exportCarrierRun(source.store, source.run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
    const receiver = new MemoryStore();
    let preflightCandidate;
    const imported = await importCarrierRun(receiver, carrierExport, {
      runId: 'receiver-run',
      preflight: async (candidate) => {
        preflightCandidate = candidate;
        return { blockers: [] };
      },
    });
    assert.equal(imported.run.runId, 'receiver-run');
    assert.equal(imported.authorityImported, false);
    assert.equal(carrierExport.bundle.run.receiverPolicyRef.checksum, senderPolicyRef.checksum);
    assert.equal(preflightCandidate.selectedRunId, 'receiver-run');
    assert.equal(preflightCandidate.bundle.run.receiverPolicyRef, undefined);
    assert.equal(preflightCandidate.bundle.run.creationMetadata.receiverPolicyRef, undefined);
    assert.equal(preflightCandidate.bundle.run.branches[0].diagnostics.receiverPolicyRef, undefined);
    assert.equal(preflightCandidate.bundle.head.updateDiagnostics.receiverPolicyRef, undefined);
    assert.equal(preflightCandidate.bundle.effects[0].diagnostics.receiverPolicyRef, undefined);
    assert.equal(preflightCandidate.bundle.application.installationDiagnostics.receiverPolicyRef, undefined);
    assert.equal(imported.run.receiverPolicyRef, null);
    assert.equal(imported.run.creationMetadata.receiverPolicyRef, undefined);
    assert.equal(imported.run.branches[0].diagnostics.receiverPolicyRef, undefined);
    assert.equal((await receiver.readHead('receiver-run', 'main')).updateDiagnostics.receiverPolicyRef, undefined);
    assert.equal((await receiver.listEffectRecords('receiver-run'))[0].diagnostics.receiverPolicyRef, undefined);
    assert.equal((await receiver.getApplication(source.run.applicationId)).installationDiagnostics.receiverPolicyRef, undefined);
    await assert.rejects(() => receiver.getBlob(senderPolicyRef), { code: 'ERR_BLOB_NOT_FOUND' });
    assert.deepEqual([...await receiver.getBlob(historicalDiagnosticRef)], [...historicalDiagnosticBytes]);
    assert.equal(carrierExport.bundle.application.applicationId, source.run.applicationId);
    assert.deepEqual(carrierExport.bundle.run.branches.map((branch) => branch.branchId), ['main']);
    assert.equal((await receiver.getApplication(source.run.applicationId)).applicationId, source.run.applicationId);
    assert.equal((await receiver.readHead('receiver-run', 'main')).turnClosureWorldFingerprint, source.head.turnClosureWorldFingerprint);
    await assert.rejects(
      () => importCarrierRun(receiver, carrierExport, { runId: 'receiver-run', preflight: async () => ({ blockers: [] }) }),
      { code: 'ERR_IMPORT_RUN_EXISTS' },
    );
    const mismatchedRelease = JSON.parse(JSON.stringify(carrierExport));
    mismatchedRelease.release.world = 'v999.0.0';
    const rejectedMemory = new MemoryStore();
    await assert.rejects(
      () => importCarrierRun(rejectedMemory, mismatchedRelease, { runId: 'rejected-run' }),
      { code: 'ERR_IMPORT_RELEASE_MISMATCH' },
    );
    await assert.rejects(() => rejectedMemory.getRun('rejected-run'), { code: 'ERR_RUN_NOT_FOUND' });
    const rejectedRoot = await mkdtemp(path.join(tmpdir(), 'world-host-release-mismatch-'));
    try {
      const rejectedDirectory = new DirectoryStore(rejectedRoot);
      await assert.rejects(
        () => importCarrierRun(rejectedDirectory, mismatchedRelease, { runId: 'rejected-run' }),
        { code: 'ERR_IMPORT_RELEASE_MISMATCH' },
      );
      await assert.rejects(() => rejectedDirectory.getRun('rejected-run'), { code: 'ERR_RUN_NOT_FOUND' });
    } finally {
      await rm(rejectedRoot, { recursive: true, force: true });
    }
    const corrupt = JSON.parse(JSON.stringify(carrierExport.bundle));
    corrupt.blobs[0].byteLength += 1;
    await assert.rejects(() => new MemoryStore().importRun(corrupt), { code: 'ERR_IMPORT_BLOB_CHECKSUM_MISMATCH' });
    const malformedHead = JSON.parse(JSON.stringify(carrierExport.bundle));
    malformedHead.head = { turnClosureRef: malformedHead.head.turnClosureRef };
    malformedHead.run.branches[0].currentHead = malformedHead.head;
    await assertImportsReject(malformedHead, 'ERR_REQUIRED_INTEGER');
    const malformedEffect = JSON.parse(JSON.stringify(carrierExport.bundle));
    malformedEffect.effects = [{ runId: malformedEffect.run.runId, branchId: malformedEffect.branchId, state: 'not-an-effect-record' }];
    await assertImportsReject(malformedEffect, 'ERR_INVALID_EFFECT_RECORD');
    const missingResolutionInput = JSON.parse(JSON.stringify(carrierExport.bundle));
    missingResolutionInput.effects = [fixtureImportEffect(missingResolutionInput, { state: 'resolved' })];
    await assertImportsReject(missingResolutionInput, 'ERR_INVALID_EFFECT_RECORD');
    const missingRunningRequest = JSON.parse(JSON.stringify(carrierExport.bundle));
    missingRunningRequest.effects = [fixtureImportEffect(missingRunningRequest, { state: 'running', attemptCount: 1 })];
    await assertImportsReject(missingRunningRequest, 'ERR_INVALID_EFFECT_RECORD');
    const duplicateEffect = JSON.parse(JSON.stringify(carrierExport.bundle));
    duplicateEffect.effects = [
      fixtureImportEffect(duplicateEffect),
      fixtureImportEffect(duplicateEffect, { state: 'operator_intervention_required' }),
    ];
    await assertImportsReject(duplicateEffect, 'ERR_IMPORT_EFFECT_DUPLICATE');
  });

  it('applies receiver supervision policy during CLI import preflight', async () => {
    const manifestBytes = fixtureApplianceManifestBytes({ supervisionPolicyFingerprint: 0x901n });
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-supervision-import-'));
    const sourceRoot = path.join(root, 'source');
    const receiverRoot = path.join(root, 'receiver');
    const packagePath = path.join(root, 'carrier-export.json');
    try {
      const { run } = await fixtureDirectoryStore(sourceRoot, { closureOptions: { status: 1 } });
      const sourceStore = new DirectoryStore(sourceRoot);
      const carrierExport = await exportCarrierRun(sourceStore, run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
      const manifestBlob = blobEntryForBytes(manifestBytes);
      carrierExport.bundle.application.applianceManifestRef = {
        algorithm: 'sha256',
        checksum: manifestBlob.checksum,
        byteLength: manifestBlob.byteLength,
      };
      carrierExport.bundle.application.installationDiagnostics = { manifestSource: 'operator-supplied' };
      carrierExport.bundle.blobs.push({
        algorithm: 'sha256',
        checksum: manifestBlob.checksum,
        byteLength: manifestBlob.byteLength,
      }, manifestBlob);
      await writeFile(packagePath, `${JSON.stringify(carrierExport, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli([
          'import',
          '--store', receiverRoot,
          '--package', packagePath,
          '--run', 'receiver-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        (error) => {
          assert.equal(error.code, 'ERR_IMPORT_PREFLIGHT_BLOCKED');
          assert.deepEqual(error.details?.blockers, ['supervision-policy-rejected']);
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves partial CLI import mapper failures as unresolved requests', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-partial-import-mapper-'));
    const sourceRoot = path.join(root, 'source');
    const receiverRoot = path.join(root, 'receiver');
    const packagePath = path.join(root, 'carrier-export.json');
    try {
      const { run } = await fixtureDirectoryStore(sourceRoot, { closureOptions: { status: 1 } });
      const sourceStore = new DirectoryStore(sourceRoot);
      const carrierExport = await exportCarrierRun(sourceStore, run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
      const pendingExport = carrierExportWithPendingHead(
        carrierExport,
        fixtureNeedsHostTurnClosureBytes([fixtureHostRequestBytes(), agentModelHostRequestBytes()]),
      );
      await writeFile(packagePath, `${JSON.stringify(pendingExport, null, 2)}\n`);

      let mapperCalls = 0;
      let output = '';
      const code = await runBunCli([
        'import',
        '--store', receiverRoot,
        '--package', packagePath,
        '--run', 'partial-import-run',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      }, {
        effectDrivers: [
          agentWorldRequestDriver(new FixtureAgentModelDriver({
            actuatorRef: 'world:actuator-ref:4f0c7160f25c4c62',
            descriptorFingerprint: 'world:descriptor:be73177924a6b377',
          }), 'world:actuation-class:2'),
        ],
        effectPolicy: { allowPartialEffectBatch: true },
        hostRequestMapper(request) {
          mapperCalls += 1;
          if (mapperCalls === 1) {
            const error = new Error('mapper rejected request');
            error.code = 'ERR_WORLD_HOST_REQUEST_RESPONSE_STATUS_NOT_ALLOWED';
            throw error;
          }
          return { ...agentWorldHostRequestToEffectRequest(request), pendingRequestIndex: 0 };
        },
      });
      assert.equal(code, 0);
      assert.equal(mapperCalls, 2);
      assert.equal(JSON.parse(output).runId, 'partial-import-run');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects partial CLI imports with no selected effects', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-partial-import-empty-'));
    const sourceRoot = path.join(root, 'source');
    const receiverRoot = path.join(root, 'receiver');
    const packagePath = path.join(root, 'carrier-export.json');
    try {
      const { run } = await fixtureDirectoryStore(sourceRoot, { closureOptions: { status: 1 } });
      const sourceStore = new DirectoryStore(sourceRoot);
      const carrierExport = await exportCarrierRun(sourceStore, run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
      const pendingExport = carrierExportWithPendingHead(
        carrierExport,
        fixtureNeedsHostTurnClosureBytes([agentModelHostRequestBytes()]),
      );
      await writeFile(packagePath, `${JSON.stringify(pendingExport, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli([
          'import',
          '--store', receiverRoot,
          '--package', packagePath,
          '--run', 'empty-partial-import-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }, {
          effectPolicy: { allowPartialEffectBatch: true },
          hostRequestMapper() {
            const error = new Error('mapper rejected request');
            error.code = 'ERR_WORLD_HOST_REQUEST_RESPONSE_STATUS_NOT_ALLOWED';
            throw error;
          },
        }),
        { code: 'ERR_PARTIAL_EFFECT_BATCH_EMPTY' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not trust imported host-generated diagnostics to skip manifest preflight', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-untrusted-import-diagnostics-'));
    const sourceRoot = path.join(root, 'source');
    const receiverRoot = path.join(root, 'receiver');
    const packagePath = path.join(root, 'carrier-export.json');
    try {
      const { run } = await fixtureDirectoryStore(sourceRoot, { closureOptions: { status: 1 } });
      const sourceStore = new DirectoryStore(sourceRoot);
      const carrierExport = await exportCarrierRun(sourceStore, run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
      const manifestBlob = blobEntryForBytes(fromUtf8('not an ApplianceManifest'));
      carrierExport.bundle.application.applianceManifestRef = {
        algorithm: 'sha256',
        checksum: manifestBlob.checksum,
        byteLength: manifestBlob.byteLength,
      };
      carrierExport.bundle.application.installationDiagnostics = { manifestSource: 'host-generated-install-summary' };
      carrierExport.bundle.blobs.push(manifestBlob);
      await writeFile(packagePath, `${JSON.stringify(carrierExport, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli([
          'import',
          '--store', receiverRoot,
          '--package', packagePath,
          '--run', 'receiver-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_APPLIANCE_MANIFEST_INVALID' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports imported appliance manifest blob mismatches as manifest preflight errors', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-manifest-mismatch-import-'));
    const sourceRoot = path.join(root, 'source');
    const receiverRoot = path.join(root, 'receiver');
    const packagePath = path.join(root, 'carrier-export.json');
    try {
      const { run } = await fixtureDirectoryStore(sourceRoot, { closureOptions: { status: 1 } });
      const sourceStore = new DirectoryStore(sourceRoot);
      const carrierExport = await exportCarrierRun(sourceStore, run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
      const manifestRef = carrierExport.bundle.application.applianceManifestRef;
      const manifestBlob = carrierExport.bundle.blobs.find((blob) =>
        blob.checksum === manifestRef.checksum && blob.byteLength === manifestRef.byteLength);
      assert.ok(Array.isArray(manifestBlob?.bytes));
      manifestBlob.bytes = manifestBlob.bytes.map((byte, index) => index === 0 ? byte ^ 0xff : byte);
      await writeFile(packagePath, `${JSON.stringify(carrierExport, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli([
          'import',
          '--store', receiverRoot,
          '--package', packagePath,
          '--run', 'receiver-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_APPLIANCE_MANIFEST_MISMATCH' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds imported appliance manifest preflight to the selected closure manifest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-manifest-fingerprint-import-'));
    const sourceRoot = path.join(root, 'source');
    const receiverRoot = path.join(root, 'receiver');
    const packagePath = path.join(root, 'carrier-export.json');
    try {
      const { run } = await fixtureDirectoryStore(sourceRoot, { closureOptions: { status: 1 } });
      const sourceStore = new DirectoryStore(sourceRoot);
      const carrierExport = await exportCarrierRun(sourceStore, run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
      const manifestBlob = blobEntryForBytes(fixtureApplianceManifestBytes({ manifestFingerprint: 0x999n }));
      carrierExport.bundle.application.applianceManifestRef = {
        algorithm: 'sha256',
        checksum: manifestBlob.checksum,
        byteLength: manifestBlob.byteLength,
      };
      carrierExport.bundle.application.installationDiagnostics = { manifestSource: 'operator-supplied' };
      carrierExport.bundle.blobs.push(manifestBlob);
      await writeFile(packagePath, `${JSON.stringify(carrierExport, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli([
          'import',
          '--store', receiverRoot,
          '--package', packagePath,
          '--run', 'receiver-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_APPLIANCE_MANIFEST_MISMATCH' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('checks declared appliance manifests on terminal imports before bypassing app requirements', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-terminal-manifest-import-'));
    const sourceRoot = path.join(root, 'source');
    const receiverRoot = path.join(root, 'receiver');
    const packagePath = path.join(root, 'carrier-export.json');
    try {
      const { run } = await fixtureDirectoryStore(sourceRoot);
      const sourceStore = new DirectoryStore(sourceRoot);
      const carrierExport = await exportCarrierRun(sourceStore, run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
      const manifestBlob = blobEntryForBytes(fixtureApplianceManifestBytes({ supervisionPolicyFingerprint: 0x901n }));
      carrierExport.bundle.application.applianceManifestRef = {
        algorithm: 'sha256',
        checksum: manifestBlob.checksum,
        byteLength: manifestBlob.byteLength,
      };
      carrierExport.bundle.application.installationDiagnostics = { manifestSource: 'operator-supplied' };
      carrierExport.bundle.blobs.push(manifestBlob);
      await writeFile(packagePath, `${JSON.stringify(carrierExport, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli([
          'import',
          '--store', receiverRoot,
          '--package', packagePath,
          '--run', 'receiver-terminal-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        (error) => {
          assert.equal(error.code, 'ERR_IMPORT_PREFLIGHT_BLOCKED');
          assert.deepEqual(error.details?.blockers, ['supervision-policy-rejected']);
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires operator-supplied terminal manifest refs to resolve to ApplianceManifest bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-terminal-operator-manifest-import-'));
    const sourceRoot = path.join(root, 'source');
    const receiverRoot = path.join(root, 'receiver');
    const missingPackagePath = path.join(root, 'missing-manifest-export.json');
    const summaryPackagePath = path.join(root, 'summary-manifest-export.json');
    try {
      const { run } = await fixtureDirectoryStore(sourceRoot);
      const sourceStore = new DirectoryStore(sourceRoot);
      const carrierExport = await exportCarrierRun(sourceStore, run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
      const missingManifestBlob = blobEntryForBytes(fixtureApplianceManifestBytes({ manifestFingerprint: 0x912n }));
      const missingManifestExport = JSON.parse(JSON.stringify(carrierExport));
      missingManifestExport.bundle.application.applianceManifestRef = {
        algorithm: 'sha256',
        checksum: missingManifestBlob.checksum,
        byteLength: missingManifestBlob.byteLength,
      };
      missingManifestExport.bundle.application.installationDiagnostics = { manifestSource: 'operator-supplied' };
      await writeFile(missingPackagePath, `${JSON.stringify(missingManifestExport, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli([
          'import',
          '--store', receiverRoot,
          '--package', missingPackagePath,
          '--run', 'receiver-terminal-missing-manifest-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_APPLIANCE_MANIFEST_MISSING' },
      );

      const summaryBlob = blobEntryForBytes(fromUtf8(stableJson({
        kind: 'world-host.install-summary',
        source: 'host-generated-install-summary',
        worldAuthoredEvidence: false,
      })));
      const summaryManifestExport = JSON.parse(JSON.stringify(carrierExport));
      summaryManifestExport.bundle.application.applianceManifestRef = {
        algorithm: 'sha256',
        checksum: summaryBlob.checksum,
        byteLength: summaryBlob.byteLength,
      };
      summaryManifestExport.bundle.application.installationDiagnostics = { manifestSource: 'operator-supplied' };
      summaryManifestExport.bundle.blobs.push(summaryBlob);
      await writeFile(summaryPackagePath, `${JSON.stringify(summaryManifestExport, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli([
          'import',
          '--store', receiverRoot,
          '--package', summaryPackagePath,
          '--run', 'receiver-terminal-summary-manifest-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_APPLIANCE_MANIFEST_INVALID' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('imports terminal host-generated install summaries without requiring appliance manifest bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-terminal-summary-import-'));
    const sourceRoot = path.join(root, 'source');
    const receiverRoot = path.join(root, 'receiver');
    const packagePath = path.join(root, 'carrier-export.json');
    try {
      const { run } = await fixtureDirectoryStore(sourceRoot);
      const sourceStore = new DirectoryStore(sourceRoot);
      const carrierExport = await exportCarrierRun(sourceStore, run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
      const summaryBlob = blobEntryForBytes(fromUtf8(stableJson({
        kind: 'world-host.install-summary',
        source: 'host-generated-install-summary',
        worldAuthoredEvidence: false,
      })));
      carrierExport.bundle.application.applianceManifestRef = {
        algorithm: 'sha256',
        checksum: summaryBlob.checksum,
        byteLength: summaryBlob.byteLength,
      };
      carrierExport.bundle.application.installationDiagnostics = { manifestSource: 'host-generated-install-summary' };
      carrierExport.bundle.blobs.push(summaryBlob);
      await writeFile(packagePath, `${JSON.stringify(carrierExport, null, 2)}\n`);

      let output = '';
      const importCode = await runBunCli([
        'import',
        '--json',
        '--store', receiverRoot,
        '--package', packagePath,
        '--run', 'receiver-terminal-summary-run',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const imported = JSON.parse(output);
      assert.equal(importCode, 0);
      assert.equal(imported.runId, 'receiver-terminal-summary-run');
      assert.equal(imported.receiverPolicyApplied, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('imports terminal ref-only reusable effect and manifest blobs already present in the receiver store', async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'world-host-ref-only-import-source-'));
    const receiverRoot = await mkdtemp(path.join(tmpdir(), 'world-host-ref-only-import-receiver-'));
    const packagePath = path.join(sourceRoot, 'ref-only-export.json');
    try {
      const { run } = await fixtureDirectoryStore(sourceRoot);
      const sourceStore = new DirectoryStore(sourceRoot);
      const carrierExport = await exportCarrierRun(sourceStore, run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
      const resolutionEffect = carrierExport.bundle.effects.find((effect) => effect.resolutionInputRef);
      const resolutionRef = resolutionEffect?.resolutionInputRef;
      const resolutionBlob = carrierExport.bundle.blobs.find((blob) =>
        blob.checksum === resolutionRef?.checksum && blob.byteLength === resolutionRef?.byteLength);
      const manifestRef = carrierExport.bundle.application.applianceManifestRef;
      const manifestBlob = carrierExport.bundle.blobs.find((blob) =>
        blob.checksum === manifestRef.checksum && blob.byteLength === manifestRef.byteLength);
      assert.ok(Array.isArray(resolutionBlob?.bytes));
      assert.ok(Array.isArray(manifestBlob?.bytes));

      const receiverStore = new DirectoryStore(receiverRoot);
      await receiverStore.acquireLock();
      try {
        await receiverStore.putBlob(Uint8Array.from(resolutionBlob.bytes));
        await receiverStore.putBlob(Uint8Array.from(manifestBlob.bytes));
      } finally {
        await receiverStore.releaseLock();
      }

      const refOnlyExport = JSON.parse(JSON.stringify(carrierExport));
      const refOnlyResolutionBlob = refOnlyExport.bundle.blobs.find((blob) =>
        blob.checksum === resolutionRef.checksum && blob.byteLength === resolutionRef.byteLength);
      const refOnlyManifestBlob = refOnlyExport.bundle.blobs.find((blob) =>
        blob.checksum === manifestRef.checksum && blob.byteLength === manifestRef.byteLength);
      refOnlyResolutionBlob.algorithm = 'sha256';
      refOnlyManifestBlob.algorithm = 'sha256';
      delete refOnlyResolutionBlob.bytes;
      delete refOnlyManifestBlob.bytes;
      await writeFile(packagePath, JSON.stringify(refOnlyExport));

      let output = '';
      const importCode = await runBunCli([
        'import',
        '--json',
        '--store', receiverRoot,
        '--package', packagePath,
        '--run', 'receiver-ref-only-run',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const imported = JSON.parse(output);
      assert.equal(importCode, 0);
      assert.equal(imported.runId, 'receiver-ref-only-run');
      assert.equal(imported.receiverPolicyApplied, true);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(receiverRoot, { recursive: true, force: true });
    }
  });

  it('redacts credentials from CLI-shaped diagnostics', async () => {
    assert.equal(redact({ nested: { bearerToken: 'secret' } }).nested.bearerToken, '[redacted]');
    assert.equal(redact({ diagnostics: { apiKey: 'secret' } }).diagnostics.apiKey, '[redacted]');
    assert.equal(redact({ diagnostics: { access_key: 'secret' } }).diagnostics.access_key, '[redacted]');
    assert.equal(redact({ diagnostics: { privateKey: 'secret' } }).diagnostics.privateKey, '[redacted]');
    assert.equal(redact({ diagnostics: { error: 'driver failed with bearer token sk-test-secret' } }).diagnostics.error, '[redacted]');
    await assert.rejects(
      () => runBunCli(['inspect', '--json'], { stdout: { write() {} }, stderr: { write() {} } }),
      /missing required option: --store/,
    );
    await assert.rejects(
      () => runBunCli(['effects', '--json'], { stdout: { write() {} }, stderr: { write() {} } }),
      /missing required option: --store/,
    );
    await assert.rejects(
      () => runBunCli(['inspect', '--json', '--store', '.world-carrier'], { stdout: { write() {} }, stderr: { write() {} } }),
      /missing required option: --run/,
    );
    await assert.rejects(
      () => runBunCli(['effects', '--json', '--store', '.world-carrier'], { stdout: { write() {} }, stderr: { write() {} } }),
      /missing required option: --run/,
    );
  });

  it('rejects symlinked capability pack artifacts during CLI check-pack', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-symlink-'));
    const pack = path.join(root, 'capability-pack-v0.2-fixture');
    try {
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      const outsideAdapter = path.join(root, 'outside-adapter.mjs');
      await writeFile(outsideAdapter, 'export const outside = true;');
      await rm(path.join(pack, 'adapter.mjs'));
      await symlink(outsideAdapter, path.join(pack, 'adapter.mjs'));

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ARTIFACT_UNSAFE' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked capability pack roots during CLI check-pack', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-root-symlink-'));
    const pack = path.join(root, 'capability-pack-v0.2-fixture');
    const link = path.join(root, 'linked-pack');
    try {
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await symlink(pack, link);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', link, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ROOT_UNSAFE' },
      );
      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', `${link}${path.sep}`, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ROOT_UNSAFE' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked capability pack conformance receipts during proof script', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-proof-symlink-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      const outsideReceipt = path.join(root, 'outside-conformance.json');
      await writeFile(outsideReceipt, await readFile(path.join(pack, 'conformance.json')));
      await rm(path.join(pack, 'conformance.json'));
      await symlink(outsideReceipt, path.join(pack, 'conformance.json'));

      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs')], {
        cwd: root,
        encoding: 'utf8',
      });

      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ARTIFACT_UNSAFE:conformance\.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked capability pack roots during proof script', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-proof-root-symlink-'));
    const packs = path.join(root, 'capability-packs');
    const realPack = path.join(root, 'real-pack');
    const linkedPack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), realPack, { recursive: true });
      await symlink(realPack, linkedPack);

      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
      });

      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ROOT_UNSAFE:/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects stale capability conformance receipts during CLI check-pack', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-conformance-'));
    const pack = path.join(root, 'capability-pack-v0.2-fixture');
    try {
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      const receipt = JSON.parse(await readFile(path.join(pack, 'conformance.json'), 'utf8'));
      receipt.driverId = 'stale-driver';
      const receiptBytes = fromUtf8(`${JSON.stringify(receipt, null, 2)}\n`);
      await writeFile(path.join(pack, 'conformance.json'), receiptBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      manifest.checksums = manifest.checksums.map((item) => item.path === 'conformance.json'
        ? { ...item, checksum: `sha256:${createHash('sha256').update(receiptBytes).digest('hex')}` }
        : item);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_CONFORMANCE_RECEIPT_MISMATCH' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows receipt-less capability packs during CLI check-pack', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-receiptless-'));
    const pack = path.join(root, 'capability-pack-v0.2-fixture');
    try {
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums.filter((item) => item.path !== 'conformance.json');
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      let output = '';
      const code = await runBunCli(['capability', 'check-pack', '--pack', pack], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      assert.equal(code, 0);
      assert.equal(JSON.parse(output).packFingerprint, manifest.packFingerprint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds never-settling trusted capability pack probes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-probe-timeout-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    const previousTimeout = process.env.WORLD_HOST_CAPABILITY_PACK_PROBE_TIMEOUT_MS;
    try {
      process.env.WORLD_HOST_CAPABILITY_PACK_PROBE_TIMEOUT_MS = '50';
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const adapterBytes = fromUtf8(`
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'fixture-agent-model',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['fixture:agent-model'],
              supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
              supportedActuationClasses: ['model'],
              supportedResponseStatuses: ['ok', 'final'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'pure',
              concurrencyLimit: 1,
              authorityLabels: ['model:fixture-agent']
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() { return { wouldInvoke: false }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve() { return new Promise(() => {}); }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_PROBE_TIMEOUT' },
      );
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, WORLD_HOST_CAPABILITY_PACK_PROBE_TIMEOUT_MS: '50' },
        timeout: 2000,
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ADAPTER_PROBE_TIMEOUT:resolve:50/);

      const syncLoopAdapterBytes = fromUtf8(`
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'fixture-agent-model',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['fixture:agent-model'],
              supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
              supportedActuationClasses: ['model'],
              supportedResponseStatuses: ['ok', 'final'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'pure',
              concurrencyLimit: 1,
              authorityLabels: ['model:fixture-agent']
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() { return { wouldInvoke: false }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve() { for (;;) {} }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), syncLoopAdapterBytes);
      const syncLoopManifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      syncLoopManifest.checksums = syncLoopManifest.checksums.map((item) => item.path === 'adapter.mjs'
        ? { ...item, checksum: `sha256:${createHash('sha256').update(syncLoopAdapterBytes).digest('hex')}` }
        : item);
      syncLoopManifest.packFingerprint = await capabilityPackFingerprint(syncLoopManifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(syncLoopManifest, null, 2)}\n`);
      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_PROBE_TIMEOUT' },
      );
    } finally {
      if (previousTimeout == null) {
        delete process.env.WORLD_HOST_CAPABILITY_PACK_PROBE_TIMEOUT_MS;
      } else {
        process.env.WORLD_HOST_CAPABILITY_PACK_PROBE_TIMEOUT_MS = previousTimeout;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds trusted capability pack probe child output buffers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-probe-output-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    const previousOutputLimit = process.env.WORLD_HOST_CAPABILITY_PACK_PROBE_OUTPUT_BYTES;
    try {
      process.env.WORLD_HOST_CAPABILITY_PACK_PROBE_OUTPUT_BYTES = '1024';
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const adapterBytes = fromUtf8(`
        console.log('x'.repeat(2048));
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'fixture-agent-model',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['fixture:agent-model'],
              supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
              supportedActuationClasses: ['model'],
              supportedResponseStatuses: ['ok', 'final'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'pure',
              concurrencyLimit: 1,
              authorityLabels: ['model:fixture-agent']
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() { return { wouldInvoke: false }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve() { return { responseStatus: 'ok', resolutionInputBytes: new Uint8Array([123,125]) }; }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        (error) => {
          assert.equal(error.code, 'ERR_CAPABILITY_PACK_ADAPTER_PROBE_OUTPUT_TOO_LARGE');
          assert.equal(error.details?.stream, 'stdout');
          assert.equal(error.details?.limitBytes, 1024);
          return true;
        },
      );
    } finally {
      if (previousOutputLimit == null) {
        delete process.env.WORLD_HOST_CAPABILITY_PACK_PROBE_OUTPUT_BYTES;
      } else {
        process.env.WORLD_HOST_CAPABILITY_PACK_PROBE_OUTPUT_BYTES = previousOutputLimit;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not execute capability pack adapters during default CLI check-pack', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-no-exec-'));
    const pack = path.join(root, 'capability-pack-v0.2-fixture');
    try {
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      const sideEffectPath = path.join(root, 'adapter-executed.txt');
      const adapterBytes = fromUtf8(`
        await Bun.write(${JSON.stringify(sideEffectPath)}, 'executed');
        export class CapabilityDriver {
          manifest() {
            return {
              driverId: 'fixture-agent-model',
              packFingerprint: ${JSON.stringify('placeholder')},
              supportedActuatorRefs: ['fixture:agent-model'],
              supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
              supportedActuationClasses: ['model'],
              supportedResponseStatuses: ['ok', 'final'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'pure',
              concurrencyLimit: 1,
              authorityLabels: ['model:fixture-agent']
            };
          }
          preflight() { return { accepted: true }; }
          dryRun() { return { wouldInvoke: false }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          async resolve() { return { resolutionInputBytes: new Uint8Array(), hostClaimBytes: new Uint8Array() }; }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      manifest.checksums = manifest.checksums.map((item) => item.path === 'adapter.mjs'
        ? { ...item, checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` }
        : item);
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      const receipt = JSON.parse(await readFile(path.join(pack, 'conformance.json'), 'utf8'));
      receipt.packFingerprint = manifest.packFingerprint;
      const receiptBytes = fromUtf8(`${JSON.stringify(receipt, null, 2)}\n`);
      await writeFile(path.join(pack, 'conformance.json'), receiptBytes);
      manifest.checksums = manifest.checksums.map((item) => item.path === 'conformance.json'
        ? { ...item, checksum: `sha256:${createHash('sha256').update(receiptBytes).digest('hex')}` }
        : item);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
      );
      await assert.rejects(() => readFile(sideEffectPath), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes sidecar adapters during trusted CLI check-pack', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-cli-sidecar-'));
    const pack = path.join(root, 'capability-pack-v0.2-fixture');
    try {
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      const sidecarBytes = fromUtf8("throw new Error('sidecar startup failed');\n");
      await writeFile(path.join(pack, 'sidecar.mjs'), sidecarBytes);
      await rm(path.join(pack, 'adapter.mjs'));
      await rm(path.join(pack, 'conformance.json'));
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      manifest.adapter = { kind: 'sidecar', command: ['bun', 'sidecar.mjs'] };
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => item.path !== 'adapter.mjs' && item.path !== 'conformance.json')
        .concat({ path: 'sidecar.mjs', checksum: `sha256:${createHash('sha256').update(sidecarBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_SIDECAR_EXIT' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects manifest-only sidecars during trusted capability pack checks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-sidecar-abi-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'adapter.mjs'));
      await rm(path.join(pack, 'conformance.json'));

      async function writeSidecarPack(sidecarBytes, manifestOverrides = {}) {
        await writeFile(path.join(pack, 'sidecar.mjs'), sidecarBytes);
        const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
        Object.assign(manifest, manifestOverrides);
        manifest.adapter = { kind: 'sidecar', command: ['bun', 'sidecar.mjs'] };
        manifest.conformanceCorpusFingerprint = null;
        manifest.checksums = manifest.checksums
          .filter((item) => !['adapter.mjs', 'conformance.json', 'sidecar.mjs'].includes(item.path))
          .concat({ path: 'sidecar.mjs', checksum: `sha256:${createHash('sha256').update(sidecarBytes).digest('hex')}` });
        manifest.packFingerprint = await capabilityPackFingerprint(manifest);
        await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      }

      const invalidResolveSidecarBytes = fromUtf8(`
        const input = await new Response(Bun.stdin.stream()).text();
        const frame = JSON.parse(input);
        const driverManifest = {
          driverId: 'fixture-agent-model',
          supportedActuatorRefs: ['fixture:agent-model'],
          supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
          supportedActuationClasses: ['model'],
          supportedResponseStatuses: ['ok', 'final'],
          maximumRequestBytes: 1048576,
          maximumResponseBytes: 1048576,
          recoveryClass: 'pure',
          concurrencyLimit: 1,
          authorityLabels: ['model:fixture-agent'],
          packFingerprint: frame.payload?.packFingerprint
        };
        const responses = {
          manifest: driverManifest,
          preflight: { accepted: true, blockers: [] },
          'dry-run': { wouldInvoke: false },
          shadow: { liveInvoked: false, schemaAccepted: false },
          resolve: {},
          recover: { operatorInterventionRequired: true }
        };
        process.stdout.write(JSON.stringify({ command: frame.command, payload: responses[frame.command] ?? driverManifest }) + '\\n');
      `);
      await writeSidecarPack(invalidResolveSidecarBytes);
      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_EXPECTED_BYTES' },
      );
      let result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_EXPECTED_BYTES|resolutionInputBytes must be Uint8Array/);

      const wrongTargetResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xdefn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('wrong-target-sidecar'),
      })).toString('base64');
      const wrongTargetSidecarBytes = fromUtf8(`
        const input = await new Response(Bun.stdin.stream()).text();
        const frame = JSON.parse(input);
        const driverManifest = {
          driverId: 'fixture-agent-model',
          supportedActuatorRefs: ['fixture:agent-model'],
          supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
          supportedActuationClasses: ['model'],
          supportedResponseStatuses: ['ok', 'final'],
          maximumRequestBytes: 1048576,
          maximumResponseBytes: 1048576,
          recoveryClass: 'pure',
          concurrencyLimit: 1,
          authorityLabels: ['model:fixture-agent'],
          packFingerprint: frame.payload?.packFingerprint
        };
        const resolution = {
          resolutionInputBytes: {
            __world_host_sidecar_type: 'bytes',
            base64: '${wrongTargetResolutionBase64}'
          }
        };
        const responses = {
          manifest: driverManifest,
          preflight: { accepted: true, blockers: [] },
          'dry-run': { wouldInvoke: false },
          shadow: { liveInvoked: false, schemaAccepted: false },
          resolve: resolution,
          recover: { operatorInterventionRequired: true }
        };
        process.stdout.write(JSON.stringify({ command: frame.command, payload: responses[frame.command] ?? driverManifest }) + '\\n');
      `);
      await writeSidecarPack(wrongTargetSidecarBytes);
      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH' },
      );
      result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_EFFECT_RESOLUTION_TARGET_MISMATCH/);

      const noResolveSidecarBytes = fromUtf8(`
        const input = await new Response(Bun.stdin.stream()).text();
        const frame = JSON.parse(input);
        const driverManifest = {
          driverId: 'fixture-agent-model',
          supportedActuatorRefs: ['fixture:agent-model'],
          supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
          supportedActuationClasses: ['model'],
          supportedResponseStatuses: ['ok', 'final'],
          maximumRequestBytes: 1048576,
          maximumResponseBytes: 1048576,
          recoveryClass: 'pure',
          concurrencyLimit: 1,
          authorityLabels: ['model:fixture-agent'],
          packFingerprint: frame.payload?.packFingerprint
        };
        const responses = {
          manifest: driverManifest,
          preflight: { accepted: true, blockers: [] },
          'dry-run': { wouldInvoke: false },
          shadow: { liveInvoked: false, schemaAccepted: false },
          recover: { operatorInterventionRequired: true }
        };
        const payload = responses[frame.command] ?? driverManifest;
        const command = Object.hasOwn(responses, frame.command) ? frame.command : 'manifest';
        process.stdout.write(JSON.stringify({ command, payload }) + '\\n');
      `);
      await writeSidecarPack(noResolveSidecarBytes);
      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_SIDECAR_RESPONSE_COMMAND' },
      );
      result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_SIDECAR_RESPONSE_COMMAND/);

      const manifestOnlySidecarBytes = fromUtf8(`
        const input = await new Response(Bun.stdin.stream()).text();
        const frame = JSON.parse(input);
        process.stdout.write(JSON.stringify({
          command: 'manifest',
          payload: {
            driverId: 'fixture-agent-model',
            supportedActuatorRefs: ['fixture:agent-model'],
            supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
            supportedActuationClasses: ['model'],
            supportedResponseStatuses: ['ok', 'final'],
            maximumRequestBytes: 1048576,
            maximumResponseBytes: 1048576,
            recoveryClass: 'pure',
            concurrencyLimit: 1,
            authorityLabels: ['model:fixture-agent'],
            packFingerprint: frame.payload?.packFingerprint
          }
        }) + '\\n');
      `);
      await writeSidecarPack(manifestOnlySidecarBytes);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_SIDECAR_RESPONSE_COMMAND' },
      );
      result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_SIDECAR_RESPONSE_COMMAND/);

    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects network sidecar probes during trusted capability pack checks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-network-sidecar-probe-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'adapter.mjs'));
      await rm(path.join(pack, 'conformance.json'));
      const sidecarBytes = fromUtf8(`
        throw new Error('network sidecar command should not run');
        const frame = {};
        const driverManifest = {
          driverId: 'generic-http-json',
          supportedActuatorRefs: ['fixture:agent-model', 'http:json'],
          supportedDescriptorFingerprints: ['descriptor:fixture-agent-model', 'descriptor:http-json'],
          supportedActuationClasses: ['model', 'http'],
          supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
          maximumRequestBytes: 1048576,
          maximumResponseBytes: 1048576,
          recoveryClass: 'idempotent',
          concurrencyLimit: 1,
          authorityLabels: ['network:http'],
          packFingerprint: frame.payload?.packFingerprint,
          diagnostics: {
            origins: ['https://example.invalid'],
            methods: ['POST'],
            configuredEndpointUrl: 'https://example.invalid/decide',
            configuredOrigin: 'https://example.invalid',
            defaultMethod: 'POST'
          }
        };
        const responses = {
          manifest: driverManifest,
          preflight: { accepted: true, blockers: [] },
          'dry-run': { wouldInvoke: true },
          shadow: { liveInvoked: false, schemaAccepted: false },
          resolve: {},
          recover: {}
        };
        process.stdout.write(JSON.stringify({ command: frame.command, payload: responses[frame.command] ?? driverManifest }) + '\\n');
      `);
      await writeFile(path.join(pack, 'sidecar.mjs'), sidecarBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      Object.assign(manifest, {
        driverId: 'generic-http-json',
        supportedActuatorRefs: ['fixture:agent-model', 'http:json'],
        supportedDescriptorFingerprints: ['descriptor:fixture-agent-model', 'descriptor:http-json'],
        supportedActuationClasses: ['model', 'http'],
        supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
        recoveryClass: 'idempotent',
        authorityLabels: ['network:http'],
        policyRequirements: { allowLiveEffects: true, allowNetworkEffects: true },
      });
      manifest.adapter = { kind: 'sidecar', command: ['bun', 'sidecar.mjs'] };
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json', 'sidecar.mjs'].includes(item.path))
        .concat({ path: 'sidecar.mjs', checksum: `sha256:${createHash('sha256').update(sidecarBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED' },
      );
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED/);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /network sidecar command should not run/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stubs captured in-process network fetches during trusted capability pack checks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-network-fetch-probe-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const validResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('captured-network-fetch-probe'),
      })).toString('base64');
      const adapterBytes = fromUtf8(`
        const capturedFetch = fetch;
        const capturedWebSocket = WebSocket;
        const capturedEventSource = typeof EventSource === 'undefined' ? null : EventSource;
        const resolutionInputBytes = new Uint8Array(Buffer.from('${validResolutionBase64}', 'base64'));
        async function assertDeterministicFetch(fetchFn) {
          const response = await fetchFn('https://example.invalid/world-host-capability-pack-abi-probe');
          const payload = await response.json();
          if (payload.worldHostCapabilityPackAbiProbe !== true) throw new Error('non-deterministic probe fetch');
        }
        function assertDeterministicNetworkConstructors() {
          const socket = new capturedWebSocket('wss://example.invalid/world-host-capability-pack-abi-probe');
          if (socket.worldHostCapabilityPackAbiProbe !== true) throw new Error('non-deterministic probe WebSocket');
          socket.close();
          if (capturedEventSource) {
            const events = new capturedEventSource('https://example.invalid/world-host-capability-pack-abi-probe/events');
            if (events.worldHostCapabilityPackAbiProbe !== true) throw new Error('non-deterministic probe EventSource');
            events.close();
          }
        }
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'generic-http-json',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['http:json'],
              supportedDescriptorFingerprints: ['descriptor:http-json'],
              supportedActuationClasses: ['http'],
              supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'idempotent',
              concurrencyLimit: 1,
              authorityLabels: ['network:http'],
              diagnostics: {
                origins: ['https://example.invalid'],
                methods: ['POST'],
                configuredEndpointUrl: 'https://example.invalid/decide',
                configuredOrigin: 'https://example.invalid',
                defaultMethod: 'POST'
              }
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() { return { wouldInvoke: true }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          async resolve() {
            assertDeterministicNetworkConstructors();
            await assertDeterministicFetch(capturedFetch);
            return { resolutionInputBytes };
          }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      Object.assign(manifest, {
        driverId: 'generic-http-json',
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
        recoveryClass: 'idempotent',
        authorityLabels: ['network:http'],
        policyRequirements: { allowLiveEffects: true, allowNetworkEffects: true },
      });
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      assert.equal(await runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
        stdout: { write() {} },
        stderr: { write() {} },
      }), 0);
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects post-resolution async timer network effects during trusted capability pack checks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-post-resolution-network-probe-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const validResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('post-resolution-network-probe'),
      })).toString('base64');
      const adapterBytes = fromUtf8(`
        const capturedFetch = fetch;
        const resolutionInputBytes = new Uint8Array(Buffer.from('${validResolutionBase64}', 'base64'));
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'generic-http-json',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['http:json'],
              supportedDescriptorFingerprints: ['descriptor:http-json'],
              supportedActuationClasses: ['http'],
              supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'idempotent',
              concurrencyLimit: 1,
              authorityLabels: ['network:http'],
              diagnostics: {
                origins: ['https://example.invalid'],
                methods: ['POST'],
                configuredEndpointUrl: 'https://example.invalid/decide',
                configuredOrigin: 'https://example.invalid',
                defaultMethod: 'POST'
              }
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() { return { wouldInvoke: true }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          async resolve() {
            await Promise.resolve();
            setTimeout(() => {
              capturedFetch('https://example.invalid/world-host-capability-pack-abi-probe-after-resolution');
            }, 0);
            return { resolutionInputBytes };
          }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      Object.assign(manifest, {
        driverId: 'generic-http-json',
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
        recoveryClass: 'idempotent',
        authorityLabels: ['network:http'],
        policyRequirements: { allowLiveEffects: true, allowNetworkEffects: true },
      });
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED' },
      );
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects post-resolution setImmediate network effects during trusted capability pack checks', async () => {
    assert.equal(typeof globalThis.setImmediate, 'function');
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-post-immediate-network-probe-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const validResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('post-immediate-network-probe'),
      })).toString('base64');
      const adapterBytes = fromUtf8(`
        const capturedFetch = fetch;
        const capturedSetImmediate = setImmediate;
        const resolutionInputBytes = new Uint8Array(Buffer.from('${validResolutionBase64}', 'base64'));
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'generic-http-json',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['http:json'],
              supportedDescriptorFingerprints: ['descriptor:http-json'],
              supportedActuationClasses: ['http'],
              supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'idempotent',
              concurrencyLimit: 1,
              authorityLabels: ['network:http'],
              diagnostics: {
                origins: ['https://example.invalid'],
                methods: ['POST'],
                configuredEndpointUrl: 'https://example.invalid/decide',
                configuredOrigin: 'https://example.invalid',
                defaultMethod: 'POST'
              }
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() { return { wouldInvoke: true }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          async resolve() {
            await Promise.resolve();
            capturedSetImmediate(() => {
              capturedFetch('https://example.invalid/world-host-capability-pack-abi-probe-after-immediate');
            });
            return { resolutionInputBytes };
          }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      Object.assign(manifest, {
        driverId: 'generic-http-json',
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
        recoveryClass: 'idempotent',
        authorityLabels: ['network:http'],
        policyRequirements: { allowLiveEffects: true, allowNetworkEffects: true },
      });
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED' },
      );
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects post-resolution Bun.sleep network effects during trusted capability pack checks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-post-sleep-network-probe-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const validResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('post-sleep-network-probe'),
      })).toString('base64');
      const adapterBytes = fromUtf8(`
        const capturedFetch = fetch;
        const capturedSleep = Bun.sleep;
        const resolutionInputBytes = new Uint8Array(Buffer.from('${validResolutionBase64}', 'base64'));
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'generic-http-json',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['http:json'],
              supportedDescriptorFingerprints: ['descriptor:http-json'],
              supportedActuationClasses: ['http'],
              supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'idempotent',
              concurrencyLimit: 1,
              authorityLabels: ['network:http'],
              diagnostics: {
                origins: ['https://example.invalid'],
                methods: ['POST'],
                configuredEndpointUrl: 'https://example.invalid/decide',
                configuredOrigin: 'https://example.invalid',
                defaultMethod: 'POST'
              }
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() { return { wouldInvoke: true }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve() {
            capturedSleep(100).then(() => {
              capturedFetch('https://example.invalid/world-host-capability-pack-abi-probe-after-sleep');
            });
            return { resolutionInputBytes };
          }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      Object.assign(manifest, {
        driverId: 'generic-http-json',
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
        recoveryClass: 'idempotent',
        authorityLabels: ['network:http'],
        policyRequirements: { allowLiveEffects: true, allowNetworkEffects: true },
      });
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED' },
      );
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects post-resolution microtask network effects during trusted capability pack checks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-post-microtask-network-probe-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const validResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('post-microtask-network-probe'),
      })).toString('base64');
      const adapterBytes = fromUtf8(`
        const capturedFetch = fetch;
        const resolutionInputBytes = new Uint8Array(Buffer.from('${validResolutionBase64}', 'base64'));
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'generic-http-json',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['http:json'],
              supportedDescriptorFingerprints: ['descriptor:http-json'],
              supportedActuationClasses: ['http'],
              supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'idempotent',
              concurrencyLimit: 1,
              authorityLabels: ['network:http'],
              diagnostics: {
                origins: ['https://example.invalid'],
                methods: ['POST'],
                configuredEndpointUrl: 'https://example.invalid/decide',
                configuredOrigin: 'https://example.invalid',
                defaultMethod: 'POST'
              }
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() { return { wouldInvoke: true }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve() {
            Promise.resolve().then(() => {
              capturedFetch('https://example.invalid/world-host-capability-pack-abi-probe-after-microtask');
            });
            queueMicrotask(() => {
              capturedFetch('https://example.invalid/world-host-capability-pack-abi-probe-after-queued-microtask');
            });
            return { resolutionInputBytes };
          }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      Object.assign(manifest, {
        driverId: 'generic-http-json',
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
        recoveryClass: 'idempotent',
        authorityLabels: ['network:http'],
        policyRequirements: { allowLiveEffects: true, allowNetworkEffects: true },
      });
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED' },
      );
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects native Promise network effects after trusted probe resolution settles', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-native-promise-network-probe-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const validResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('post-native-promise-network-probe'),
      })).toString('base64');
      const adapterBytes = fromUtf8(`
        const capturedFetch = fetch;
        const resolutionInputBytes = new Uint8Array(Buffer.from('${validResolutionBase64}', 'base64'));
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'generic-http-json',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['http:json'],
              supportedDescriptorFingerprints: ['descriptor:http-json'],
              supportedActuationClasses: ['http'],
              supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'idempotent',
              concurrencyLimit: 1,
              authorityLabels: ['network:http'],
              diagnostics: {
                origins: ['https://example.invalid'],
                methods: ['POST'],
                configuredEndpointUrl: 'https://example.invalid/decide',
                configuredOrigin: 'https://example.invalid',
                defaultMethod: 'POST'
              }
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() { return { wouldInvoke: true }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve() {
            return new Promise((resolve) => {
              resolve({ resolutionInputBytes });
              new Promise((queue) => queue()).then(() => {
                capturedFetch('https://example.invalid/world-host-capability-pack-abi-probe-after-native-promise');
              });
            });
          }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      Object.assign(manifest, {
        driverId: 'generic-http-json',
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
        recoveryClass: 'idempotent',
        authorityLabels: ['network:http'],
        policyRequirements: { allowLiveEffects: true, allowNetworkEffects: true },
      });
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED' },
      );
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows model network-authority probes to use deterministic network', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-model-http-json-probe-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const validResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('model-http-json-probe'),
      })).toString('base64');
      const adapterBytes = fromUtf8(`
        const capturedFetch = fetch;
        const resolutionInputBytes = new Uint8Array(Buffer.from('${validResolutionBase64}', 'base64'));
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'fixture-agent-model',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['fixture:agent-model'],
              supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
              supportedActuationClasses: ['model'],
              supportedResponseStatuses: ['ok', 'final'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'pure',
              concurrencyLimit: 1,
              authorityLabels: ['network:openai']
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() { return { wouldInvoke: true }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve() {
            return Promise.resolve().then(async () => {
              const caught = await Promise.resolve()
                .then(() => { throw new Error('expected adapter rejection'); })
                .catch(() => true);
              if (caught !== true) throw new Error('adapter promise rejection was not preserved');
              const response = await capturedFetch('https://example.invalid/world-host-capability-pack-abi-probe');
              const payload = await response.json();
              if (payload.worldHostCapabilityPackAbiProbe !== true) throw new Error('non-deterministic model fetch');
              return { resolutionInputBytes };
            });
          }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      Object.assign(manifest, {
        driverId: 'fixture-agent-model',
        supportedActuatorRefs: ['fixture:agent-model'],
        supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
        supportedActuationClasses: ['model'],
        supportedResponseStatuses: ['ok', 'final'],
        recoveryClass: 'pure',
        authorityLabels: ['network:openai'],
        policyRequirements: { allowLiveEffects: true, allowNetworkEffects: true },
      });
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      assert.equal(await runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
        stdout: { write() {} },
        stderr: { write() {} },
      }), 0);
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('isolates trusted network probe globals from concurrent CLI helpers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-concurrent-probe-lock-'));
    const networkPack = path.join(root, 'network-pack');
    const fixturePack = path.join(root, 'fixture-pack');
    const hostSetTimeout = globalThis.setTimeout;
    const quiet = {
      stdout: { write() {} },
      stderr: { write() {} },
    };
    try {
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), networkPack, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), fixturePack, { recursive: true });
      await rm(path.join(networkPack, 'conformance.json'));
      await rm(path.join(fixturePack, 'conformance.json'));
      const networkResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('concurrent-network-probe'),
      })).toString('base64');
      const fixtureResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('concurrent-fixture-probe'),
      })).toString('base64');
      const networkAdapterBytes = fromUtf8(`
        const resolutionInputBytes = new Uint8Array(Buffer.from('${networkResolutionBase64}', 'base64'));
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'generic-http-json',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['http:json'],
              supportedDescriptorFingerprints: ['descriptor:http-json'],
              supportedActuationClasses: ['http'],
              supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'idempotent',
              concurrencyLimit: 1,
              authorityLabels: ['network:http'],
              diagnostics: {
                origins: ['https://example.invalid'],
                methods: ['POST'],
                configuredEndpointUrl: 'https://example.invalid/decide',
                configuredOrigin: 'https://example.invalid',
                defaultMethod: 'POST'
              }
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() { return { wouldInvoke: true }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve() {
            return Promise.resolve()
              .then(() => new Promise((resolve) => setTimeout(resolve, 150)))
              .then(() => ({ resolutionInputBytes }));
          }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      const fixtureAdapterBytes = fromUtf8(`
        const capturedTimerSource = String(setTimeout);
        const resolutionInputBytes = new Uint8Array(Buffer.from('${fixtureResolutionBase64}', 'base64'));
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'fixture-agent-model',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['fixture:agent-model'],
              supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
              supportedActuationClasses: ['model'],
              supportedResponseStatuses: ['ok', 'final'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'pure',
              concurrencyLimit: 1,
              authorityLabels: ['model:fixture-agent']
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() { return { wouldInvoke: true }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve() {
            if (capturedTimerSource.includes('pendingTimeouts') || capturedTimerSource.includes('scheduledPhase')) {
              throw new Error('captured deterministic probe timer');
            }
            return { resolutionInputBytes };
          }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(networkPack, 'adapter.mjs'), networkAdapterBytes);
      await writeFile(path.join(fixturePack, 'adapter.mjs'), fixtureAdapterBytes);

      const networkManifest = JSON.parse(await readFile(path.join(networkPack, 'manifest.json'), 'utf8'));
      Object.assign(networkManifest, {
        driverId: 'generic-http-json',
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
        recoveryClass: 'idempotent',
        authorityLabels: ['network:http'],
        policyRequirements: { allowLiveEffects: true, allowNetworkEffects: true },
      });
      networkManifest.conformanceCorpusFingerprint = null;
      networkManifest.checksums = networkManifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(networkAdapterBytes).digest('hex')}` });
      networkManifest.packFingerprint = await capabilityPackFingerprint(networkManifest);
      await writeFile(path.join(networkPack, 'manifest.json'), `${JSON.stringify(networkManifest, null, 2)}\n`);

      const fixtureManifest = JSON.parse(await readFile(path.join(fixturePack, 'manifest.json'), 'utf8'));
      fixtureManifest.conformanceCorpusFingerprint = null;
      fixtureManifest.checksums = fixtureManifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(fixtureAdapterBytes).digest('hex')}` });
      fixtureManifest.packFingerprint = await capabilityPackFingerprint(fixtureManifest);
      await writeFile(path.join(fixturePack, 'manifest.json'), `${JSON.stringify(fixtureManifest, null, 2)}\n`);

      const networkRun = runBunCli(['capability', 'check-pack', '--pack', networkPack, '--trusted-execute-adapters'], quiet)
        .then((result) => ({ result }), (error) => ({ error }));
      const fixtureRun = runBunCli(['capability', 'check-pack', '--pack', fixturePack, '--trusted-execute-adapters'], quiet)
        .then((result) => ({ result }), (error) => ({ error }));
      let unrelatedTimerFired = false;
      hostSetTimeout(() => {
        unrelatedTimerFired = true;
      }, 10);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        assert.equal(globalThis.setTimeout, hostSetTimeout);
        await new Promise((resolve) => hostSetTimeout(resolve, 5));
      }
      assert.equal(globalThis.setTimeout, hostSetTimeout);
      assert.equal(unrelatedTimerFired, true);
      const [networkResult, fixtureResult] = await Promise.all([networkRun, fixtureRun]);
      if (networkResult.error) throw networkResult.error;
      if (fixtureResult.error) throw fixtureResult.error;
      assert.equal(networkResult.result, 0);
      assert.equal(fixtureResult.result, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects network fetches when a multi-class trusted probe selects a non-network request', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-non-network-selected-probe-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const validResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('selected-non-network-probe'),
      })).toString('base64');
      const adapterBytes = fromUtf8(`
        const capturedFetch = fetch;
        const resolutionInputBytes = new Uint8Array(Buffer.from('${validResolutionBase64}', 'base64'));
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'generic-http-json',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['fixture:agent-model', 'http:json'],
              supportedDescriptorFingerprints: ['descriptor:fixture-agent-model', 'descriptor:http-json'],
              supportedActuationClasses: ['model', 'http'],
              supportedResponseStatuses: ['ok', 'final', 'http_error', 'failed', 'deferred'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'idempotent',
              concurrencyLimit: 1,
              authorityLabels: ['model:fixture-agent'],
              diagnostics: {
                origins: ['https://example.invalid'],
                methods: ['POST'],
                configuredEndpointUrl: 'https://example.invalid/decide',
                configuredOrigin: 'https://example.invalid',
                defaultMethod: 'POST'
              }
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() { return { wouldInvoke: true }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          async resolve() {
            await capturedFetch('https://example.invalid/world-host-capability-pack-abi-probe');
            return { resolutionInputBytes };
          }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      Object.assign(manifest, {
        driverId: 'generic-http-json',
        supportedActuatorRefs: ['fixture:agent-model', 'http:json'],
        supportedDescriptorFingerprints: ['descriptor:fixture-agent-model', 'descriptor:http-json'],
        supportedActuationClasses: ['model', 'http'],
        supportedResponseStatuses: ['ok', 'final', 'http_error', 'failed', 'deferred'],
        recoveryClass: 'idempotent',
        authorityLabels: ['model:fixture-agent'],
        policyRequirements: { allowLiveEffects: true, allowNetworkEffects: true },
      });
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED' },
      );
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects in-process network fetches before resolve during trusted capability pack checks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-network-dry-run-probe-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const validResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('captured-network-dry-run-probe'),
      })).toString('base64');
      const adapterBytes = fromUtf8(`
        const capturedFetch = fetch;
        const resolutionInputBytes = new Uint8Array(Buffer.from('${validResolutionBase64}', 'base64'));
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'generic-http-json',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['http:json'],
              supportedDescriptorFingerprints: ['descriptor:http-json'],
              supportedActuationClasses: ['http'],
              supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'idempotent',
              concurrencyLimit: 1,
              authorityLabels: ['network:http'],
              diagnostics: {
                origins: ['https://example.invalid'],
                methods: ['POST'],
                configuredEndpointUrl: 'https://example.invalid/decide',
                configuredOrigin: 'https://example.invalid',
                defaultMethod: 'POST'
              }
            };
          }
          preflight() { return { accepted: true, blockers: [] }; }
          dryRun() {
            setTimeout(() => {
              try {
                capturedFetch('https://example.invalid/world-host-capability-pack-abi-probe-dry-run');
              } catch {}
              try {
                globalThis.fetch('https://example.invalid/world-host-capability-pack-abi-probe-dry-run-global');
              } catch {}
            }, 0);
            return { wouldInvoke: true };
          }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve() { return { resolutionInputBytes }; }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      Object.assign(manifest, {
        driverId: 'generic-http-json',
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
        recoveryClass: 'idempotent',
        authorityLabels: ['network:http'],
        policyRequirements: { allowLiveEffects: true, allowNetworkEffects: true },
      });
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED' },
      );
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps deterministic network installed after trusted probe failures', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-network-failure-probe-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const adapterBytes = fromUtf8(`
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'generic-http-json',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['http:json'],
              supportedDescriptorFingerprints: ['descriptor:http-json'],
              supportedActuationClasses: ['http'],
              supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'idempotent',
              concurrencyLimit: 1,
              authorityLabels: ['network:http'],
              diagnostics: {
                origins: ['https://example.invalid'],
                methods: ['POST'],
                configuredEndpointUrl: 'https://example.invalid/decide',
                configuredOrigin: 'https://example.invalid',
                defaultMethod: 'POST'
              }
            };
          }
          preflight() {
            try {
              Bun.sleep(100).then(() => globalThis.fetch('https://example.invalid/world-host-capability-pack-abi-probe-sleep'));
            } catch {}
            setTimeout(() => {
              try {
                globalThis.fetch('https://example.invalid/world-host-capability-pack-abi-probe-failure');
              } catch {}
            }, 100);
            throw new Error('preflight failed after scheduling network');
          }
          dryRun() { return { wouldInvoke: true }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve() { return { operatorInterventionRequired: true }; }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      Object.assign(manifest, {
        driverId: 'generic-http-json',
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
        recoveryClass: 'idempotent',
        authorityLabels: ['network:http'],
        policyRequirements: { allowLiveEffects: true, allowNetworkEffects: true },
      });
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED' },
      );
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects sidecar preflight and intervention payload failures during trusted checks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-sidecar-abi-boundary-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'adapter.mjs'));
      await rm(path.join(pack, 'conformance.json'));

      async function writeSidecarPack(sidecarBytes) {
        await writeFile(path.join(pack, 'sidecar.mjs'), sidecarBytes);
        const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
        manifest.adapter = { kind: 'sidecar', command: ['bun', 'sidecar.mjs'] };
        manifest.conformanceCorpusFingerprint = null;
        manifest.checksums = manifest.checksums
          .filter((item) => !['adapter.mjs', 'conformance.json', 'sidecar.mjs'].includes(item.path))
          .concat({ path: 'sidecar.mjs', checksum: `sha256:${createHash('sha256').update(sidecarBytes).digest('hex')}` });
        manifest.packFingerprint = await capabilityPackFingerprint(manifest);
        await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      }

      const preflightDeniedSidecarBytes = fromUtf8(`
        const input = await new Response(Bun.stdin.stream()).text();
        const frame = JSON.parse(input);
        const driverManifest = {
          driverId: 'fixture-agent-model',
          supportedActuatorRefs: ['fixture:agent-model'],
          supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
          supportedActuationClasses: ['model'],
          supportedResponseStatuses: ['ok', 'final'],
          maximumRequestBytes: 1048576,
          maximumResponseBytes: 1048576,
          recoveryClass: 'pure',
          concurrencyLimit: 1,
          authorityLabels: ['model:fixture-agent'],
          packFingerprint: frame.payload?.packFingerprint
        };
        const responses = {
          manifest: driverManifest,
          preflight: { accepted: false, blockers: ['probe-denied'] },
          'dry-run': { wouldInvoke: false },
          shadow: { liveInvoked: false, schemaAccepted: false },
          resolve: {},
          recover: { operatorInterventionRequired: true }
        };
        process.stdout.write(JSON.stringify({ command: frame.command, payload: responses[frame.command] ?? driverManifest }) + '\\n');
      `);
      await writeSidecarPack(preflightDeniedSidecarBytes);
      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_PREFLIGHT' },
      );
      let result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ADAPTER_PREFLIGHT/);

      const acceptedWithBlockersSidecarBytes = fromUtf8((await bytesToUtf8(preflightDeniedSidecarBytes)).replace(
        "preflight: { accepted: false, blockers: ['probe-denied'] }",
        "preflight: { accepted: true, blockers: ['probe-denied'] }",
      ));
      await writeSidecarPack(acceptedWithBlockersSidecarBytes);
      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_PREFLIGHT' },
      );
      result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ADAPTER_PREFLIGHT/);

      const validResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('valid-sidecar-probe'),
      })).toString('base64');
      const forbiddenRecoverInterventionSidecarBytes = fromUtf8(`
        const input = await new Response(Bun.stdin.stream()).text();
        const frame = JSON.parse(input);
        const driverManifest = {
          driverId: 'fixture-agent-model',
          supportedActuatorRefs: ['fixture:agent-model'],
          supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
          supportedActuationClasses: ['model'],
          supportedResponseStatuses: ['ok', 'final'],
          maximumRequestBytes: 1048576,
          maximumResponseBytes: 1048576,
          recoveryClass: 'pure',
          concurrencyLimit: 1,
          authorityLabels: ['model:fixture-agent'],
          packFingerprint: frame.payload?.packFingerprint
        };
        const resolution = {
          resolutionInputBytes: {
            __world_host_sidecar_type: 'bytes',
            base64: '${validResolutionBase64}'
          }
        };
        const responses = {
          manifest: driverManifest,
          preflight: { accepted: true, blockers: [] },
          'dry-run': { wouldInvoke: false },
          shadow: { liveInvoked: false, schemaAccepted: false },
          resolve: resolution,
          recover: { operatorInterventionRequired: true, turnClosureBytes: 'forbidden-world-evidence' }
        };
        process.stdout.write(JSON.stringify({ command: frame.command, payload: responses[frame.command] ?? driverManifest }) + '\\n');
      `);
      await writeSidecarPack(forbiddenRecoverInterventionSidecarBytes);
      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN' },
      );
      result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects sidecar manifest mismatches before trusted probes run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-sidecar-manifest-order-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'adapter.mjs'));
      await rm(path.join(pack, 'conformance.json'));
      const sidecarBytes = fromUtf8(`
        const input = await new Response(Bun.stdin.stream()).text();
        const frame = JSON.parse(input);
        if (frame.command !== 'manifest') {
          process.stderr.write('probe command should not run before manifest match\\n');
          process.stdout.write(JSON.stringify({ command: frame.command, payload: { accepted: true, blockers: [] } }) + '\\n');
        } else {
          process.stdout.write(JSON.stringify({
            command: 'manifest',
            payload: {
              driverId: 'fixture-agent-model-mismatch',
              supportedActuatorRefs: ['fixture:agent-model'],
              supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
              supportedActuationClasses: ['model'],
              supportedResponseStatuses: ['ok', 'final'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'pure',
              concurrencyLimit: 1,
              authorityLabels: ['model:fixture-agent'],
              packFingerprint: frame.payload?.packFingerprint
            }
          }) + '\\n');
        }
      `);
      await writeFile(path.join(pack, 'sidecar.mjs'), sidecarBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      manifest.adapter = { kind: 'sidecar', command: ['bun', 'sidecar.mjs'] };
      manifest.conformanceCorpusFingerprint = null;
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json', 'sidecar.mjs'].includes(item.path))
        .concat({ path: 'sidecar.mjs', checksum: `sha256:${createHash('sha256').update(sidecarBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_CAPABILITY_PACK_ADAPTER_MANIFEST_MISMATCH' },
      );
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ERR_CAPABILITY_PACK_ADAPTER_MANIFEST_MISMATCH/);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /probe command should not run/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts sidecar ok probe resolutions when non-success statuses are listed first', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-sidecar-status-order-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'adapter.mjs'));
      await rm(path.join(pack, 'conformance.json'));
      const validResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('status-order-sidecar'),
      })).toString('base64');
      const sidecarBytes = fromUtf8(`
        const input = await new Response(Bun.stdin.stream()).text();
        const frame = JSON.parse(input);
        const driverManifest = {
          driverId: 'fixture-agent-model',
          supportedActuatorRefs: ['fixture:agent-model'],
          supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
          supportedActuationClasses: ['model'],
          supportedResponseStatuses: ['failed', 'ok'],
          maximumRequestBytes: 1048576,
          maximumResponseBytes: 1048576,
          recoveryClass: 'pure',
          concurrencyLimit: 1,
          authorityLabels: ['model:fixture-agent'],
          packFingerprint: frame.payload?.packFingerprint
        };
        const resolution = {
          resolutionInputBytes: {
            __world_host_sidecar_type: 'bytes',
            base64: '${validResolutionBase64}'
          }
        };
        const responses = {
          manifest: driverManifest,
          preflight: { accepted: true, blockers: [] },
          'dry-run': { wouldInvoke: false },
          shadow: { liveInvoked: false, schemaAccepted: false },
          resolve: resolution,
          recover: { operatorInterventionRequired: true }
        };
        process.stdout.write(JSON.stringify({ command: frame.command, payload: responses[frame.command] ?? driverManifest }) + '\\n');
      `);
      await writeFile(path.join(pack, 'sidecar.mjs'), sidecarBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      manifest.adapter = { kind: 'sidecar', command: ['bun', 'sidecar.mjs'] };
      manifest.conformanceCorpusFingerprint = null;
      manifest.supportedResponseStatuses = ['failed', 'ok'];
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json', 'sidecar.mjs'].includes(item.path))
        .concat({ path: 'sidecar.mjs', checksum: `sha256:${createHash('sha256').update(sidecarBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      assert.equal(await runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
        stdout: { write() {} },
        stderr: { write() {} },
      }), 0);
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('matches in-process adapter probe bytes to the selected actuation class', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-adapter-selected-class-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      await rm(path.join(pack, 'conformance.json'));
      const validResolutionBase64 = Buffer.from(encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xabcn,
        status: 0,
        responseValueImageBytes: fromUtf8('probe-response'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: fromUtf8('selected-class-adapter'),
      })).toString('base64');
      const adapterBytes = fromUtf8(`
        function decodedBytes(value) {
          return new TextDecoder().decode(value ?? new Uint8Array());
        }
        const resolutionInputBytes = new Uint8Array(Buffer.from('${validResolutionBase64}', 'base64'));
        function modelProbe(hostRequest) {
          return hostRequest?.actuationClass === 'model' &&
            decodedBytes(hostRequest?.requestBytes).includes('boundary.Agent.DecisionPrompt.v0');
        }
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'fixture-agent-model',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['fixture:agent-model'],
              supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
              supportedActuationClasses: ['model', 'http'],
              supportedResponseStatuses: ['ok', 'final'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'pure',
              concurrencyLimit: 1,
              authorityLabels: ['model:fixture-agent']
            };
          }
          preflight(context, hostRequest) {
            return modelProbe(hostRequest)
              ? { accepted: true, blockers: [] }
              : { accepted: false, blockers: ['selected-class-probe-mismatch'] };
          }
          dryRun() { return { wouldInvoke: false }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve(context, hostRequest) {
            return modelProbe(hostRequest)
              ? { resolutionInputBytes }
              : { resolutionInputBytes: new Uint8Array() };
          }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      manifest.conformanceCorpusFingerprint = null;
      manifest.supportedActuationClasses = ['model', 'http'];
      manifest.checksums = manifest.checksums
        .filter((item) => !['adapter.mjs', 'conformance.json'].includes(item.path))
        .concat({ path: 'adapter.mjs', checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` });
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      assert.equal(await runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
        stdout: { write() {} },
        stderr: { write() {} },
      }), 0);
      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects capability pack adapters that do not satisfy the runtime ABI during proof', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-abi-'));
    const packs = path.join(root, 'capability-packs');
    const pack = path.join(packs, 'capability-pack-v0.2-fixture');
    try {
      await mkdir(packs, { recursive: true });
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      const adapterBytes = fromUtf8(`
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'fixture-agent-model',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['fixture:agent-model'],
              supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
              supportedActuationClasses: ['model'],
              supportedResponseStatuses: ['ok', 'final'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'pure',
              concurrencyLimit: 1,
              authorityLabels: ['model:fixture-agent']
            };
          }
          preflight() { return { accepted: true }; }
          dryRun() { return { wouldInvoke: false }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve() { return { resolutionInputBytes: new Uint8Array() }; }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      const manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      manifest.checksums = manifest.checksums.map((item) => item.path === 'adapter.mjs'
        ? { ...item, checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` }
        : item);
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      const receipt = JSON.parse(await readFile(path.join(pack, 'conformance.json'), 'utf8'));
      receipt.packFingerprint = manifest.packFingerprint;
      const receiptBytes = fromUtf8(`${JSON.stringify(receipt, null, 2)}\n`);
      await writeFile(path.join(pack, 'conformance.json'), receiptBytes);
      manifest.checksums = manifest.checksums.map((item) => item.path === 'conformance.json'
        ? { ...item, checksum: `sha256:${createHash('sha256').update(receiptBytes).digest('hex')}` }
        : item);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      const result = spawnSync('bun', [path.resolve('scripts/check-capability-packs.mjs'), '--trusted-execute-adapters'], {
        cwd: root,
        encoding: 'utf8',
      });

      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /truncated wire bytes/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects capability pack adapters that do not satisfy the runtime ABI during trusted CLI check-pack', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-pack-cli-abi-'));
    const pack = path.join(root, 'capability-pack-v0.2-fixture');
    try {
      await cp(path.resolve('capability-packs/capability-pack-v0.2-fixture'), pack, { recursive: true });
      assert.equal(await runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
        stdout: { write() {} },
        stderr: { write() {} },
      }), 0);
      const helperBytes = fromUtf8(`
        export function fixtureManifest(packFingerprint) {
          return {
            driverId: 'fixture-agent-model',
            packFingerprint,
            supportedActuatorRefs: ['fixture:agent-model'],
            supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
            supportedActuationClasses: ['model'],
            supportedResponseStatuses: ['ok', 'final'],
            maximumRequestBytes: 1048576,
            maximumResponseBytes: 1048576,
            recoveryClass: 'pure',
            concurrencyLimit: 1,
            authorityLabels: ['model:fixture-agent']
          };
        }
      `);
      const importedAdapterBytes = fromUtf8(`
        import { fixtureManifest } from './helper.mjs';
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() { return fixtureManifest(this.packFingerprint); }
          preflight() { return { accepted: true }; }
          dryRun() { return { wouldInvoke: false }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          resolve() { return { resolutionInputBytes: new Uint8Array() }; }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'helper.mjs'), helperBytes);
      await writeFile(path.join(pack, 'adapter.mjs'), importedAdapterBytes);
      let manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      manifest.checksums = [
        ...manifest.checksums
          .filter((item) => item.path !== 'helper.mjs')
          .map((item) => item.path === 'adapter.mjs'
            ? { ...item, checksum: `sha256:${createHash('sha256').update(importedAdapterBytes).digest('hex')}` }
            : item),
        { path: 'helper.mjs', checksum: `sha256:${createHash('sha256').update(helperBytes).digest('hex')}` },
      ];
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      let receipt = JSON.parse(await readFile(path.join(pack, 'conformance.json'), 'utf8'));
      receipt.packFingerprint = manifest.packFingerprint;
      let receiptBytes = fromUtf8(`${JSON.stringify(receipt, null, 2)}\n`);
      await writeFile(path.join(pack, 'conformance.json'), receiptBytes);
      manifest.checksums = manifest.checksums.map((item) => item.path === 'conformance.json'
        ? { ...item, checksum: `sha256:${createHash('sha256').update(receiptBytes).digest('hex')}` }
        : item);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        /truncated wire bytes/,
      );
      const adapterBytes = fromUtf8(`
        export class CapabilityDriver {
          constructor(options = {}) { this.packFingerprint = options.packFingerprint; }
          manifest() {
            return {
              driverId: 'fixture-agent-model',
              packFingerprint: this.packFingerprint,
              supportedActuatorRefs: ['fixture:agent-model'],
              supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
              supportedActuationClasses: ['model'],
              supportedResponseStatuses: ['ok', 'final'],
              maximumRequestBytes: 1048576,
              maximumResponseBytes: 1048576,
              recoveryClass: 'pure',
              concurrencyLimit: 1,
              authorityLabels: ['model:fixture-agent']
            };
          }
          preflight() { return { accepted: true }; }
          dryRun() { return { wouldInvoke: false }; }
          shadow() { return { liveInvoked: false, schemaAccepted: false }; }
          recover() { return { operatorInterventionRequired: true }; }
        }
      `);
      await writeFile(path.join(pack, 'adapter.mjs'), adapterBytes);
      manifest = JSON.parse(await readFile(path.join(pack, 'manifest.json'), 'utf8'));
      manifest.checksums = manifest.checksums.map((item) => item.path === 'adapter.mjs'
        ? { ...item, checksum: `sha256:${createHash('sha256').update(adapterBytes).digest('hex')}` }
        : item);
      manifest.packFingerprint = await capabilityPackFingerprint(manifest);
      receipt = JSON.parse(await readFile(path.join(pack, 'conformance.json'), 'utf8'));
      receipt.packFingerprint = manifest.packFingerprint;
      receiptBytes = fromUtf8(`${JSON.stringify(receipt, null, 2)}\n`);
      await writeFile(path.join(pack, 'conformance.json'), receiptBytes);
      manifest.checksums = manifest.checksums.map((item) => item.path === 'conformance.json'
        ? { ...item, checksum: `sha256:${createHash('sha256').update(receiptBytes).digest('hex')}` }
        : item);
      await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      await assert.rejects(
        () => runBunCli(['capability', 'check-pack', '--pack', pack, '--trusted-execute-adapters'], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_ACTUATOR_DRIVER_RESOLVE_REQUIRED' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('installs DirectoryStore application records from immutable CLI bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-cli-install-'));
    try {
      const wasmPath = path.join(root, 'world_universal_appliance.wasm');
      const imagePath = path.join(root, 'file-agent.world-executable');
      await writeFile(wasmPath, fromUtf8('wasm:install'));
      await writeFile(imagePath, fromUtf8('image-bytes-install'));

      let output = '';
      const installCode = await runBunCli([
        'install',
        '--json',
        '--store', root,
        '--name', 'installed-app',
        '--wasm', wasmPath,
        '--image', imagePath,
        '--image-fingerprint', 'world:image:installed',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const installed = JSON.parse(output);

      assert.equal(installCode, 0);
      assert.equal(installed.command, 'install');
      assert.equal(installed.applicationId, 'installed-app');
      assert.equal(installed.executableImageWorldFingerprint, 'world:image:installed');
      assert.equal(installed.universalWasmChecksum, `sha256:${installed.blobs.wasm.checksum}`);
      assert.equal(installed.universalWasmByteLength, installed.blobs.wasm.byteLength);
      assert.equal(installed.diagnostics.authorityCarried, false);
      assert.equal(installed.diagnostics.worldFingerprintSource, '--image-fingerprint');
      assert.equal(installed.diagnostics.worldFingerprintDerivedFromSha256, false);
      assert.equal(installed.diagnostics.workerExecuted, false);
      assert.equal(installed.diagnostics.driversInvoked, false);
      assert.equal(installed.diagnostics.runCreated, false);
      assert.equal(installed.diagnostics.worldEvidenceAuthored, false);
      assert.doesNotMatch(output, /bytesHex|wasm:install|image-bytes-install/);

      const store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        const app = await store.getApplication('installed-app');
        assert.equal(app.applicationId, 'installed-app');
        assert.equal(app.universalWasmChecksum, `sha256:${installed.blobs.wasm.checksum}`);
        assert.equal(app.universalWasmByteLength, installed.blobs.wasm.byteLength);
        assert.equal(app.worldProtocolVersion, 'v0.1.0');
        assert.equal(app.applianceAbiVersion, 'v4');
        assert.equal(app.executableImageWorldFingerprint, 'world:image:installed');
        assert.equal(app.installationDiagnostics.wasmPath, undefined);
        assert.equal(app.installationDiagnostics.imagePath, undefined);
        assert.deepEqual([...await store.getBlob(app.executableImageRef)], [...fromUtf8('image-bytes-install')]);
        assert.deepEqual([...await store.getBlob({ algorithm: 'sha256', checksum: installed.blobs.wasm.checksum, byteLength: installed.blobs.wasm.byteLength })], [...fromUtf8('wasm:install')]);
        const manifest = JSON.parse(await bytesToUtf8(await store.getBlob(app.applianceManifestRef)));
        assert.equal(manifest.kind, 'world-host.install-summary');
        assert.equal(manifest.worldAuthoredEvidence, false);
        assert.equal(manifest.diagnostics.worldFingerprintDerivedFromSha256, false);
        await assert.rejects(() => store.getRun('installed-app'), /ERR_RUN_NOT_FOUND/);
      } finally {
        await store.releaseLock();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves checked agent pack actuator requirements during CLI install', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-cli-install-'));
    try {
      let output = '';
      const installCode = await runBunCli([
        'agent',
        'install',
        '--pack', path.resolve('agent-runtime-v0.1'),
        '--store', root,
        '--app', 'agent-runtime-v0.1',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });

      assert.equal(installCode, 0);
      assert.equal(JSON.parse(output).applicationId, 'agent-runtime-v0.1');
      const store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        const app = await store.getApplication('agent-runtime-v0.1');
        assert.deepEqual(app.requiredActuators, [
          {
            actuatorRef: 'world:actuator-ref:4f0c7160f25c4c62',
            descriptorFingerprint: 'world:descriptor:be73177924a6b377',
          },
          {
            actuatorRef: 'world:actuator-ref:d5e4b1b427522cf2',
            descriptorFingerprint: 'world:descriptor:74afc8c3b2fe4c33',
          },
        ]);
        assert.deepEqual(app.requiredHostAuthorityLabels, ['model:fixture-agent', 'file:sandbox']);
      } finally {
        await store.releaseLock();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs installed agent pack resumes with seeded scenario payloads', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-cli-run-resume-'));
    try {
      await runBunCli([
        'agent',
        'install',
        '--pack', path.resolve('agent-runtime-v0.1'),
        '--store', root,
        '--app', 'agent-runtime-v0.1',
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      });
      await mkdir(path.join(root, 'sandbox'), { recursive: true });
      await writeFile(path.join(root, 'sandbox/input.txt'), 'rewrite this file through the agent loop\n');
      await writeFile(path.join(root, 'sandbox/output.txt'), '');

      await assert.rejects(
        () => runBunCli([
          'agent',
          'run',
          '--store', root,
          'agent-runtime-v0.1',
          '--run', 'agent-cli-missing-sandbox',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_AGENT_RUNTIME_SANDBOX_ROOT_REQUIRED' },
      );

      let output = '';
      const runCode = await runBunCli([
        'agent',
        'run',
        '--store', root,
        '--scenario', 'fixture',
        '--sandbox-root', path.join(root, 'sandbox'),
        'agent-runtime-v0.1',
        '--run', 'agent-cli-run',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const run = JSON.parse(output);

      assert.equal(runCode, 0);
      assert.equal(run.head.status, 'needs_host');
      assert.equal(run.advance.effectCount, 0);
      assert.equal(run.diagnostics.driversInvokedByCli, false);
      await assert.rejects(
        () => runBunCli([
          'agent',
          'replay',
          '--store', root,
          '--run', 'agent-cli-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_AGENT_RUNTIME_REPLAY_HEAD_INCOMPLETE' },
      );
      output = '';
      const resumeCode = await runBunCli([
        'agent',
        'resume',
        '--store', root,
        '--run', 'agent-cli-run',
        '--scenario', 'fixture',
        '--sandbox-root', path.join(root, 'sandbox'),
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const resumed = JSON.parse(output);

      assert.equal(resumeCode, 0);
      assert.equal(resumed.head.status, 'completed');
      assert.equal(resumed.advance.effectCount, 2);
      assert.equal(resumed.diagnostics.driversInvokedByCli, true);
      assert.equal(await readFile(path.join(root, 'sandbox/output.txt'), 'utf8'), 'actuate updated the fixture');

      output = '';
      const replayCode = await runBunCli([
        'agent',
        'replay',
        '--store', root,
        '--run', 'agent-cli-run',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const replayed = JSON.parse(output);

      assert.equal(replayCode, 0);
      assert.equal(replayed.command, 'replay');
      assert.equal(replayed.replay.completed, true);
      assert.equal(replayed.replay.retainedEffectCount, 2);
      assert.equal(replayed.replay.freshEffectCount, 0);
      assert.equal(replayed.diagnostics.driversInvoked, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects replay heads without committed effect id diagnostics', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-replay-diagnostics-'));
    try {
      const { run, head } = await fixtureDirectoryStore(root);
      const store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        await store.writeHead(run.runId, 'main', createRunHead({
          ...head,
          updateDiagnostics: {
            parentTurnClosureFingerprint: head.updateDiagnostics.parentTurnClosureFingerprint,
          },
        }));
      } finally {
        await store.releaseLock();
      }

      await assert.rejects(() => runBunCli([
        'agent',
        'replay',
        '--store', root,
        '--run', run.runId,
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      }), { code: 'ERR_AGENT_RUNTIME_REPLAY_EFFECT_IDS_REQUIRED' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects replay heads with duplicate committed effect id diagnostics', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-replay-duplicate-diagnostics-'));
    try {
      const { run, head } = await fixtureDirectoryStore(root);
      const store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        const committedEffectIds = head.updateDiagnostics.committedEffectIds;
        await store.writeHead(run.runId, 'main', createRunHead({
          ...head,
          updateDiagnostics: {
            ...head.updateDiagnostics,
            committedEffectIds: [committedEffectIds[0], committedEffectIds[0]],
          },
        }));
      } finally {
        await store.releaseLock();
      }

      await assert.rejects(() => runBunCli([
        'agent',
        'replay',
        '--store', root,
        '--run', run.runId,
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      }), { code: 'ERR_AGENT_RUNTIME_REPLAY_EFFECT_IDS_DUPLICATE' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns nonzero when replay cannot retain every committed effect', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-replay-incomplete-'));
    try {
      const { run, head } = await fixtureDirectoryStore(root, {
        closureOptions: {
          appliedHostReplyFingerprints: [0xa01n],
        },
      });
      const store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        await store.writeHead(run.runId, 'main', createRunHead({
          ...head,
          updateDiagnostics: {
            ...head.updateDiagnostics,
            committedEffectIds: ['world:key:missing'],
          },
        }));
      } finally {
        await store.releaseLock();
      }

      let output = '';
      const replayCode = await runBunCli([
        'agent',
        'replay',
        '--store', root,
        '--run', run.runId,
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const replayed = JSON.parse(output);

      assert.equal(replayCode, 1);
      assert.equal(replayed.ok, false);
      assert.deepEqual(replayed.replay.missingEffectIds, ['world:key:missing']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects replay effects that are not applied by the TurnReceipt', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-replay-receipt-mismatch-'));
    try {
      const { run } = await fixtureDirectoryStore(root, {
        closureOptions: {
          appliedHostReplyFingerprints: [0xdeadn],
        },
      });
      const store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        const [effect] = await store.listEffectRecords(run.runId);
        const resolutionInputRef = await store.putBlob(encodeResolutionInputBytes({
          targetHostRequestFingerprint: 0xa01n,
          status: 0,
          responseValueImageBytes: encodeCanonicalValueImage({
            bytes: fromUtf8('receipt mismatch response'),
            dynamicSize: true,
          }),
          hostClaimBytes: new Uint8Array(),
          attemptNumber: 1,
          metadata: new Uint8Array(),
        }));
        await store.putEffectRecord({
          ...effect,
          resolutionInputRef,
          diagnostics: {
            ...effect.diagnostics,
            worldHostReplyBinding: {
              requestFingerprint: '0000000000000a01',
              intentFingerprint: '0000000000000a06',
              envelopeFingerprint: '0000000000000a07',
              idempotencyKeyFingerprint: '0000000000000a09',
            },
          },
        });
      } finally {
        await store.releaseLock();
      }

      await assert.rejects(() => runBunCli([
        'agent',
        'replay',
        '--store', root,
        '--run', run.runId,
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      }), { code: 'ERR_AGENT_RUNTIME_REPLAY_EFFECT_RECEIPT_MISMATCH' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects replay HostReply binding diagnostics copied from another HostRequest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-replay-binding-target-'));
    const copiedBinding = {
      requestFingerprint: '0000000000000b02',
      intentFingerprint: '0000000000000b06',
      envelopeFingerprint: '0000000000000b07',
      idempotencyKeyFingerprint: '0000000000000b09',
    };
    const resolutionInputBytes = encodeResolutionInputBytes({
      targetHostRequestFingerprint: 0xa01n,
      status: 0,
      responseValueImageBytes: encodeCanonicalValueImage({
        bytes: fromUtf8('copied binding response'),
        dynamicSize: true,
      }),
      hostClaimBytes: new Uint8Array(),
      attemptNumber: 1,
      metadata: new Uint8Array(),
    });
    try {
      const { run } = await fixtureDirectoryStore(root, {
        closureOptions: {
          appliedHostReplyFingerprints: [fixtureHostReplyFingerprint(copiedBinding, resolutionInputBytes)],
        },
      });
      const store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        const [effect] = await store.listEffectRecords(run.runId);
        const resolutionInputRef = await store.putBlob(resolutionInputBytes);
        await store.putEffectRecord({
          ...effect,
          resolutionInputRef,
          diagnostics: {
            ...effect.diagnostics,
            worldHostReplyBinding: copiedBinding,
          },
        });
      } finally {
        await store.releaseLock();
      }

      await assert.rejects(() => runBunCli([
        'agent',
        'replay',
        '--store', root,
        '--run', run.runId,
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      }), { code: 'ERR_AGENT_RUNTIME_REPLAY_EFFECT_RECEIPT_TARGET_MISMATCH' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects replay when a retained ResolutionInput blob is missing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-replay-missing-resolution-'));
    try {
      const { run } = await fixtureDirectoryStore(root, {
        closureOptions: {
          appliedHostReplyFingerprints: [0xa01n],
        },
      });
      const store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        const [effect] = await store.listEffectRecords(run.runId);
        await store.putEffectRecord({
          ...effect,
          resolutionInputRef: {
            algorithm: 'sha256',
            checksum: '0'.repeat(64),
            byteLength: 1,
          },
        });
      } finally {
        await store.releaseLock();
      }

      await assert.rejects(() => runBunCli([
        'agent',
        'replay',
        '--store', root,
        '--run', run.runId,
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      }), { code: 'ERR_AGENT_RUNTIME_REPLAY_EFFECT_RESOLUTION_MISSING' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed canonical agent runtime payload framing', () => {
    const malformedPayload = new Uint8Array(encodeCanonicalValueImage({
      bytes: fromUtf8('agent runtime request'),
      dynamicSize: true,
    }));
    malformedPayload[16] = 2;

    assert.throws(() => agentWorldHostRequestToEffectRequest({
      requestFingerprint: 0xa17n,
      idempotencyKeyBytes: fromUtf8('malformed-agent-runtime-payload'),
      idempotencyKeyFingerprint: 0xa18n,
      actuatorRefFingerprint: 0xa19n,
      expectedResponseDescriptorFingerprint: 0xa20n,
      actuationClass: 2,
      allowedResponseStatuses: 1,
      hostRequestBytes: fromUtf8('host-request-envelope'),
      payloadValueImageBytes: malformedPayload,
    }), { code: 'ERR_AGENT_RUNTIME_VALUE_IMAGE_MALFORMED' });
  });

  it('rejects canonical agent runtime payload fingerprint and ref mismatches', () => {
    const payload = new Uint8Array(encodeCanonicalValueImage({
      boundaryValueFingerprint: 0xa21n,
      bytes: fromUtf8('agent runtime request'),
      dynamicSize: true,
    }));
    const tamperedFingerprint = new Uint8Array(payload);
    tamperedFingerprint[8] ^= 0xff;
    const baseRequest = {
      requestFingerprint: 0xa17n,
      idempotencyKeyBytes: fromUtf8('agent-runtime-payload-fingerprint'),
      idempotencyKeyFingerprint: 0xa18n,
      actuatorRefFingerprint: 0xa19n,
      expectedResponseDescriptorFingerprint: 0xa20n,
      actuationClass: 2,
      allowedResponseStatuses: 1,
      hostRequestBytes: fromUtf8('host-request-envelope'),
    };

    assert.throws(() => agentWorldHostRequestToEffectRequest({
      ...baseRequest,
      payloadValueImageBytes: tamperedFingerprint,
      payloadValueRefFingerprint: 0xa21n,
    }), { code: 'ERR_AGENT_RUNTIME_VALUE_IMAGE_FINGERPRINT' });

    assert.throws(() => agentWorldHostRequestToEffectRequest({
      ...baseRequest,
      payloadValueImageBytes: payload,
      payloadValueRefFingerprint: 0xa22n,
    }), { code: 'ERR_AGENT_RUNTIME_VALUE_IMAGE_PAYLOAD_REF' });

    const schemaPayload = new Uint8Array(encodeCanonicalValueImage({
      codecSchemaDescriptorFingerprint: 0xa23n,
      bytes: fromUtf8('agent runtime request'),
      dynamicSize: true,
    }));
    assert.throws(() => agentWorldHostRequestToEffectRequest({
      ...baseRequest,
      payloadValueImageBytes: schemaPayload,
      payloadSchemaRefFingerprint: 0xa24n,
    }), { code: 'ERR_AGENT_RUNTIME_VALUE_IMAGE_PAYLOAD_SCHEMA_REF' });
  });

  it('rejects legacy agent runtime payload wrapper mismatches', () => {
    const payload = encodeLegacyAgentRuntimePayload({
      commandFingerprint: 0xa04n,
      bindingFingerprint: 0xa03n,
      worldPortId: 0,
      rootArgumentImageBytes: fromUtf8('agent runtime request'),
    });
    const baseRequest = {
      requestFingerprint: 0xa17n,
      pendingPortFingerprint: 0xa03n,
      targetRefFingerprint: 0xa04n,
      frameRequestBytes: encodeAgentRuntimeFrameRequest({
        commandFingerprint: 0xa04n,
        bindingFingerprint: 0xa03n,
        worldPortId: 0,
      }),
      worldPortId: 0,
      idempotencyKeyBytes: fromUtf8('legacy-agent-runtime-payload'),
      idempotencyKeyFingerprint: 0xa18n,
      actuatorRefFingerprint: 0xa19n,
      expectedResponseDescriptorFingerprint: 0xa20n,
      actuationClass: 2,
      allowedResponseStatuses: 1,
      hostRequestBytes: fromUtf8('host-request-envelope'),
    };

    assert.deepEqual(agentWorldHostRequestToEffectRequest({
      ...baseRequest,
      payloadValueImageBytes: payload,
    }).requestBytes, fromUtf8('agent runtime request'));

    assert.deepEqual(agentWorldHostRequestToEffectRequest({
      ...baseRequest,
      targetRefFingerprint: 0xb04n,
      payloadValueImageBytes: payload,
    }).requestBytes, fromUtf8('agent runtime request'));

    assert.deepEqual(agentWorldHostRequestToEffectRequest({
      ...baseRequest,
      pendingPortFingerprint: 0xb03n,
      payloadValueImageBytes: payload,
    }).requestBytes, fromUtf8('agent runtime request'));

    assert.throws(() => agentWorldHostRequestToEffectRequest({
      ...baseRequest,
      commandFingerprint: 0xb04n,
      bindingFingerprint: 0xa03n,
      payloadValueImageBytes: payload,
    }), { code: 'ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_COMMAND_REF' });

    assert.throws(() => agentWorldHostRequestToEffectRequest({
      ...baseRequest,
      commandFingerprint: 0xa04n,
      bindingFingerprint: 0xb03n,
      payloadValueImageBytes: payload,
    }), { code: 'ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_BINDING_REF' });

    assert.throws(() => agentWorldHostRequestToEffectRequest({
      ...baseRequest,
      payloadValueImageBytes: encodeLegacyAgentRuntimePayload({
        commandFingerprint: 0xb04n,
        bindingFingerprint: 0xa03n,
        worldPortId: 0,
        rootArgumentImageBytes: fromUtf8('agent runtime request'),
      }),
    }), { code: 'ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_COMMAND_REF' });

    assert.throws(() => agentWorldHostRequestToEffectRequest({
      ...baseRequest,
      payloadValueImageBytes: encodeLegacyAgentRuntimePayload({
        commandFingerprint: 0xa04n,
        bindingFingerprint: 0xb03n,
        worldPortId: 0,
        rootArgumentImageBytes: fromUtf8('agent runtime request'),
      }),
    }), { code: 'ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_BINDING_REF' });

    assert.throws(() => agentWorldHostRequestToEffectRequest({
      ...baseRequest,
      payloadValueImageBytes: encodeLegacyAgentRuntimePayload({
        commandFingerprint: 0xa04n,
        bindingFingerprint: 0xa03n,
        worldPortId: 1,
        rootArgumentImageBytes: fromUtf8('agent runtime request'),
      }),
    }), { code: 'ERR_AGENT_RUNTIME_PAYLOAD_VALUE_IMAGE_WORLD_PORT' });

    assert.throws(() => agentWorldHostRequestToEffectRequest({
      ...baseRequest,
      frameRequestBytes: baseRequest.frameRequestBytes.slice(0, -8),
      payloadValueImageBytes: payload,
    }), { code: 'ERR_AGENT_RUNTIME_FRAME_REQUEST_MALFORMED' });

    assert.throws(() => agentWorldHostRequestToEffectRequest({
      ...baseRequest,
      frameRequestBytes: concat([baseRequest.frameRequestBytes, new Uint8Array([0])]),
      payloadValueImageBytes: payload,
    }), { code: 'ERR_AGENT_RUNTIME_FRAME_REQUEST_MALFORMED' });
  });

  it('requires shipped release receipts before agent installs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-install-receipt-'));
    const pack = path.join(root, 'agent-runtime-v0.1');
    try {
      await cp(path.resolve('agent-runtime-v0.1'), pack, { recursive: true });
      await rm(path.join(pack, 'manifest/agent-runtime-release-receipt.json'));
      await refreshAgentRuntimePackChecksums(pack);

      await assert.rejects(
        () => runBunCli([
          'agent',
          'install',
          '--pack', pack,
          '--store', path.join(root, 'store'),
          '--app', 'agent-runtime-v0.1',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        /missing required file: .*agent-runtime-release-receipt\.json/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists release receipts from agent conformance before install', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-conformance-receipt-'));
    const pack = path.join(root, 'agent-runtime-v0.1');
    try {
      await cp(path.resolve('agent-runtime-v0.1'), pack, { recursive: true });
      const receiptPath = path.join(pack, 'manifest/agent-runtime-release-receipt.json');
      await rm(receiptPath);
      await refreshAgentRuntimePackChecksums(pack);

      const conformanceCode = await runBunCli([
        'agent',
        'conformance',
        '--pack', pack,
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      });
      assert.equal(conformanceCode, 0);
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      assert.equal(receipt.complete, true);

      const installCode = await runBunCli([
        'agent',
        'install',
        '--pack', pack,
        '--store', path.join(root, 'store'),
        '--app', 'agent-runtime-v0.1',
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      });
      assert.equal(installCode, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('imports installed agent exports with receiver-local agent drivers', async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'world-host-agent-import-source-'));
    const receiverRoot = await mkdtemp(path.join(tmpdir(), 'world-host-agent-import-receiver-'));
    const noPendingReceiverRoot = await mkdtemp(path.join(tmpdir(), 'world-host-agent-import-complete-receiver-'));
    const highLimitReceiverRoot = await mkdtemp(path.join(tmpdir(), 'world-host-agent-import-high-limit-receiver-'));
    const packagePath = path.join(receiverRoot, 'agent-export.json');
    try {
      await runBunCli([
        'agent',
        'install',
        '--pack', path.resolve('agent-runtime-v0.1'),
        '--store', sourceRoot,
        '--app', 'agent-runtime-v0.1',
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      });
      const runCode = await runBunCli([
        'agent',
        'run',
        '--no-execute',
        '--store', sourceRoot,
        'agent-runtime-v0.1',
        '--run', 'agent-import-source',
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      });
      assert.equal(runCode, 0);

      const exportCode = await runBunCli([
        'agent',
        'migrate',
        '--store', sourceRoot,
        '--run', 'agent-import-source',
        '--out', packagePath,
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      });
      assert.equal(exportCode, 0);

      const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
      const packageManifestFingerprint = carrierBundleApplianceManifest(packageJson.bundle).manifestFingerprint;
      let noPendingOutput = '';
      const noPendingImportCode = await runBunCli([
        'agent',
        'import',
        '--store', noPendingReceiverRoot,
        '--package', packagePath,
        '--run', 'receiver-agent-import-no-pending',
      ], {
        stdout: { write: (text) => { noPendingOutput += text; } },
        stderr: { write() {} },
      });
      const noPendingImported = JSON.parse(noPendingOutput);
      assert.equal(noPendingImportCode, 0);
      assert.equal(noPendingImported.runId, 'receiver-agent-import-no-pending');
      assert.equal(noPendingImported.receiverPolicyApplied, true);

      let genericNoPendingOutput = '';
      const genericNoPendingImportCode = await runBunCli([
        'import',
        '--store', noPendingReceiverRoot,
        '--package', packagePath,
        '--run', 'generic-agent-import-no-pending',
      ], {
        stdout: { write: (text) => { genericNoPendingOutput += text; } },
        stderr: { write() {} },
      });
      const genericNoPendingImported = JSON.parse(genericNoPendingOutput);
      assert.equal(genericNoPendingImportCode, 0);
      assert.equal(genericNoPendingImported.runId, 'generic-agent-import-no-pending');
      assert.equal(genericNoPendingImported.receiverPolicyApplied, true);

      const completedBytes = fixtureTurnClosureBytes({
        status: 2,
        turnSequenceNumber: 9n,
        closureFingerprint: 0x919n,
        manifestFingerprint: packageManifestFingerprint,
      });
      const completedSummary = summarizeTurnClosureForRunHead(completedBytes);
      const completedBlob = blobEntryForBytes(completedBytes);
      const highLimitCompletedPackage = {
        ...packageJson,
        bundle: {
          ...packageJson.bundle,
          application: {
            ...packageJson.bundle.application,
            requiredRuntimeLimits: {
              maximumConcurrentEffects: 99,
              maximumRequestBytes: 99 * 1024 * 1024,
              maximumResponseBytes: 99 * 1024 * 1024,
            },
          },
          head: {
            ...packageJson.bundle.head,
            generation: completedSummary.inspectionDiagnostics.turnSequenceNumber + 1,
            status: 'completed',
            turnClosureRef: {
              algorithm: 'sha256',
              checksum: completedBlob.checksum,
              byteLength: completedBlob.byteLength,
            },
            turnClosureWorldFingerprint: completedSummary.turnClosureWorldFingerprint,
            resultingStateFingerprint: completedSummary.resultingStateFingerprint,
            chronicleCursor: completedSummary.chronicleCursor,
            archiveMomentFingerprint: completedSummary.archiveMomentFingerprint,
            archiveSealFingerprint: completedSummary.archiveSealFingerprint,
          },
          blobs: [...packageJson.bundle.blobs, completedBlob],
        },
      };
      const highLimitCompletedPackagePath = path.join(receiverRoot, 'agent-completed-high-limits-export.json');
      await writeFile(highLimitCompletedPackagePath, JSON.stringify(highLimitCompletedPackage));
      let highLimitCompletedOutput = '';
      const highLimitCompletedImportCode = await runBunCli([
        'agent',
        'import',
        '--store', highLimitReceiverRoot,
        '--package', highLimitCompletedPackagePath,
        '--run', 'receiver-agent-import-high-limit-completed',
      ], {
        stdout: { write: (text) => { highLimitCompletedOutput += text; } },
        stderr: { write() {} },
      });
      const highLimitCompletedImported = JSON.parse(highLimitCompletedOutput);
      assert.equal(highLimitCompletedImportCode, 0);
      assert.equal(highLimitCompletedImported.runId, 'receiver-agent-import-high-limit-completed');

      const pendingClosureBytes = fixtureNeedsHostTurnClosureBytes([agentModelHostRequestBytes()], 0, { manifestFingerprint: packageManifestFingerprint });
      const pendingClosureSummary = summarizeTurnClosureForRunHead(pendingClosureBytes);
      const pendingClosureBlob = blobEntryForBytes(pendingClosureBytes);
      const pendingPackagePath = path.join(receiverRoot, 'agent-pending-export.json');
      await writeFile(pendingPackagePath, JSON.stringify({
        ...packageJson,
        bundle: {
          ...packageJson.bundle,
          head: {
            ...packageJson.bundle.head,
            generation: pendingClosureSummary.inspectionDiagnostics.turnSequenceNumber + 1,
            status: 'needs_host',
            turnClosureRef: {
              algorithm: 'sha256',
              checksum: pendingClosureBlob.checksum,
              byteLength: pendingClosureBlob.byteLength,
            },
            turnClosureWorldFingerprint: pendingClosureSummary.turnClosureWorldFingerprint,
            resultingStateFingerprint: pendingClosureSummary.resultingStateFingerprint,
            chronicleCursor: pendingClosureSummary.chronicleCursor,
            archiveMomentFingerprint: pendingClosureSummary.archiveMomentFingerprint,
            archiveSealFingerprint: pendingClosureSummary.archiveSealFingerprint,
          },
          blobs: [...packageJson.bundle.blobs, pendingClosureBlob],
        },
      }));

      await assert.rejects(
        () => runBunCli([
          'import',
          '--store', receiverRoot,
          '--package', pendingPackagePath,
          '--run', 'generic-agent-import',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_BLOCKED' },
      );

      const sandboxRoot = path.join(receiverRoot, 'sandbox');
      const requestlessNeedsHostBytes = fixtureNeedsHostTurnClosureBytes([], 0, { manifestFingerprint: packageManifestFingerprint });
      const requestlessNeedsHostSummary = summarizeTurnClosureForRunHead(requestlessNeedsHostBytes);
      const requestlessNeedsHostBlob = blobEntryForBytes(requestlessNeedsHostBytes);
      const requestlessNeedsHostPackagePath = path.join(receiverRoot, 'agent-requestless-needs-host-export.json');
      await writeFile(requestlessNeedsHostPackagePath, JSON.stringify({
        ...packageJson,
        bundle: {
          ...packageJson.bundle,
          head: {
            ...packageJson.bundle.head,
            generation: requestlessNeedsHostSummary.inspectionDiagnostics.turnSequenceNumber + 1,
            status: 'needs_host',
            turnClosureRef: {
              algorithm: 'sha256',
              checksum: requestlessNeedsHostBlob.checksum,
              byteLength: requestlessNeedsHostBlob.byteLength,
            },
            turnClosureWorldFingerprint: requestlessNeedsHostSummary.turnClosureWorldFingerprint,
            resultingStateFingerprint: requestlessNeedsHostSummary.resultingStateFingerprint,
            chronicleCursor: requestlessNeedsHostSummary.chronicleCursor,
            archiveMomentFingerprint: requestlessNeedsHostSummary.archiveMomentFingerprint,
            archiveSealFingerprint: requestlessNeedsHostSummary.archiveSealFingerprint,
          },
          blobs: [...packageJson.bundle.blobs, requestlessNeedsHostBlob],
        },
      }));
      await assert.rejects(
        () => runBunCli([
          'agent',
          'import',
          '--store', receiverRoot,
          '--package', requestlessNeedsHostPackagePath,
          '--run', 'receiver-agent-import-requestless-needs-host',
          '--sandbox-root', sandboxRoot,
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_NEEDS_HOST_REQUESTS_EMPTY' },
      );

      const yieldedBudgetBytes = fixtureNeedsHostTurnClosureBytes([], 1, { manifestFingerprint: packageManifestFingerprint });
      const yieldedBudgetSummary = summarizeTurnClosureForRunHead(yieldedBudgetBytes);
      const yieldedBudgetBlob = blobEntryForBytes(yieldedBudgetBytes);
      const yieldedBudgetPackagePath = path.join(receiverRoot, 'agent-yielded-budget-export.json');
      await writeFile(yieldedBudgetPackagePath, JSON.stringify({
        ...packageJson,
        bundle: {
          ...packageJson.bundle,
          head: {
            ...packageJson.bundle.head,
            generation: yieldedBudgetSummary.inspectionDiagnostics.turnSequenceNumber + 1,
            status: 'yielded_budget',
            turnClosureRef: {
              algorithm: 'sha256',
              checksum: yieldedBudgetBlob.checksum,
              byteLength: yieldedBudgetBlob.byteLength,
            },
            turnClosureWorldFingerprint: yieldedBudgetSummary.turnClosureWorldFingerprint,
            resultingStateFingerprint: yieldedBudgetSummary.resultingStateFingerprint,
            chronicleCursor: yieldedBudgetSummary.chronicleCursor,
            archiveMomentFingerprint: yieldedBudgetSummary.archiveMomentFingerprint,
            archiveSealFingerprint: yieldedBudgetSummary.archiveSealFingerprint,
          },
          blobs: [...packageJson.bundle.blobs, yieldedBudgetBlob],
        },
      }));
      await assert.rejects(
        () => runBunCli([
          'agent',
          'import',
          '--store', receiverRoot,
          '--package', yieldedBudgetPackagePath,
          '--run', 'receiver-agent-import-yielded-budget',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_AGENT_RUNTIME_SANDBOX_ROOT_REQUIRED' },
      );

      await mkdir(sandboxRoot, { recursive: true });
      let output = '';
      const importCode = await runBunCli([
        'agent',
        'import',
        '--store', receiverRoot,
        '--package', pendingPackagePath,
        '--run', 'receiver-agent-import',
        '--sandbox-root', sandboxRoot,
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const imported = JSON.parse(output);
      assert.equal(importCode, 0);
      assert.equal(imported.runId, 'receiver-agent-import');
      assert.equal(imported.receiverPolicyApplied, true);
      assert.equal(imported.diagnostics.workerExecuted, false);

      const malformedResolutionBytes = fromUtf8('not a ResolutionInput');
      const malformedResolutionBlob = blobEntryForBytes(malformedResolutionBytes);
      const pendingRequest = agentWorldHostRequestToEffectRequest(inspectTurnOutput(pendingClosureBytes).hostRequests[0], { scenario: 'skeleton', sandboxRoot });
      const pendingRequestBytesBlob = blobEntryForBytes(pendingRequest.requestBytes);
      const malformedResolutionPackagePath = path.join(receiverRoot, 'agent-malformed-resolution-export.json');
      const pendingPackageJson = JSON.parse(await readFile(pendingPackagePath, 'utf8'));
      const malformedResolutionPackage = {
        ...pendingPackageJson,
        bundle: {
          ...pendingPackageJson.bundle,
        },
      };
      malformedResolutionPackage.bundle.effects = [{
        runId: malformedResolutionPackage.bundle.run.runId,
        branchId: 'main',
        parentTurnClosureFingerprint: 'world:closure:parent',
        hostRequestFingerprint: pendingRequest.hostRequestFingerprint,
        idempotencyKey: {
          format: 'world-idempotency-key-bytes.hex',
          bytesHex: Buffer.from(pendingRequest.idempotencyKeyBytes).toString('hex'),
        },
        idempotencyKeyWorldFingerprint: pendingRequest.idempotencyKeyWorldFingerprint,
        actuatorRef: pendingRequest.actuatorRef,
        descriptorFingerprint: pendingRequest.descriptorFingerprint,
        actuationClass: pendingRequest.actuationClass,
        responseSchema: pendingRequest.responseSchema,
        requestBytesChecksum: `sha256:${pendingRequestBytesBlob.checksum}`,
        requestBytesRef: {
          algorithm: 'sha256',
          checksum: pendingRequestBytesBlob.checksum,
          byteLength: pendingRequestBytesBlob.byteLength,
        },
        state: 'resolved',
        attemptCount: 1,
        driverRecoveryClass: 'pure',
        resolutionInputRef: {
          algorithm: 'sha256',
          checksum: malformedResolutionBlob.checksum,
          byteLength: malformedResolutionBlob.byteLength,
        },
        diagnostics: {},
      }];
      malformedResolutionPackage.bundle.blobs = [
        ...malformedResolutionPackage.bundle.blobs.filter((blob) =>
          blob.checksum !== malformedResolutionBlob.checksum && blob.checksum !== pendingRequestBytesBlob.checksum),
        pendingRequestBytesBlob,
        malformedResolutionBlob,
      ];
      await writeFile(malformedResolutionPackagePath, JSON.stringify(malformedResolutionPackage));
      let malformedResolutionOutput = '';
      const malformedResolutionImportCode = await runBunCli([
        'agent',
        'import',
        '--store', receiverRoot,
        '--package', malformedResolutionPackagePath,
        '--run', 'receiver-agent-import-malformed-resolution',
        '--sandbox-root', sandboxRoot,
      ], {
        stdout: { write: (text) => { malformedResolutionOutput += text; } },
        stderr: { write() {} },
      });
      const malformedResolutionImported = JSON.parse(malformedResolutionOutput);
      assert.equal(malformedResolutionImportCode, 0);
      assert.equal(malformedResolutionImported.runId, 'receiver-agent-import-malformed-resolution');
      assert.equal(malformedResolutionImported.receiverPolicyApplied, true);

      const receiverStore = new DirectoryStore(receiverRoot);
      await receiverStore.acquireLock();
      try {
        const app = await receiverStore.getApplication('agent-runtime-v0.1');
        assert.deepEqual(app.requiredActuators, [
          {
            actuatorRef: 'world:actuator-ref:4f0c7160f25c4c62',
            descriptorFingerprint: 'world:descriptor:be73177924a6b377',
          },
          {
            actuatorRef: 'world:actuator-ref:d5e4b1b427522cf2',
            descriptorFingerprint: 'world:descriptor:74afc8c3b2fe4c33',
          },
        ]);
        assert.deepEqual(app.requiredHostAuthorityLabels, ['model:fixture-agent', 'file:sandbox']);
      } finally {
        await receiverStore.releaseLock();
      }
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(receiverRoot, { recursive: true, force: true });
      await rm(noPendingReceiverRoot, { recursive: true, force: true });
      await rm(highLimitReceiverRoot, { recursive: true, force: true });
    }
  });

  it('rebinds recovered agent runtime model responses to expected World refs', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({
      store,
      runId: 'agent-runtime-recover',
      branchId: 'main',
      parentTurnClosureFingerprint: 'world:turn-closure:agent-runtime-parent',
    });
    const driver = agentWorldRequestDriver(new FixtureAgentModelDriver({
      scenario: 'skeleton',
      actuatorRef: 'world:actuator-ref:4f0c7160f25c4c62',
      descriptorFingerprint: 'world:descriptor:be73177924a6b377',
    }), 'world:actuation-class:2');
    const hostRequest = {
      hostRequestFingerprint: 'world:host-request:0000000000000a17',
      idempotencyKeyBytes: fromUtf8('agent-runtime-recover-key'),
      actuatorRef: 'world:actuator-ref:4f0c7160f25c4c62',
      descriptorFingerprint: 'world:descriptor:be73177924a6b377',
      actuationClass: 'world:actuation-class:2',
      responseSchema: { status: 'responded' },
      requestBytes: fromUtf8(JSON.stringify({
        schema: 'boundary.Agent.DecisionPrompt.v0',
        observation: 'goal=invoke',
      })),
      expectedResponseValueRefFingerprint: '0x0000000000000abc',
      expectedResponseSchemaRefFingerprint: '0x0000000000000def',
      diagnostics: {
        agentRuntimeExpectedResponseValueRefFingerprint: '0x0000000000000abc',
        agentRuntimeExpectedResponseSchemaRefFingerprint: '0x0000000000000def',
      },
    };
    const observed = await journal.observe(hostRequest, { manifest: driver.manifest() });
    await store.putEffectRecord({
      ...observed,
      state: EffectState.running,
      attemptCount: 1,
      diagnostics: { ...observed.diagnostics, driverId: 'fixture-agent-model' },
    });

    const recovered = await journal.resolve({}, hostRequest, driver);
    const resolution = decodeResolutionInputBytes(recovered.resolutionInputBytes);
    const refs = decodeValueImageResponseRefs(resolution.responseValueImageBytes);

    assert.equal(recovered.record.diagnostics.recovered, true);
    assert.equal(recovered.record.diagnostics.agentRuntimeResponseBoundToExpectedRefs, true);
    assert.equal(refs.boundaryValueFingerprint, '0x0000000000000abc');
    assert.equal(refs.codecSchemaDescriptorFingerprint, '0x0000000000000def');
  });

  it('translates missing sandbox file reads into agent runtime responses', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-missing-file-'));
    try {
      const driver = agentWorldRequestDriver(new SandboxFileDriver({
        root,
        actuatorRef: 'world:actuator-ref:d5e4b1b427522cf2',
        descriptorFingerprint: 'world:descriptor:74afc8c3b2fe4c33',
      }), 'world:actuation-class:3');
      const result = await driver.resolve({}, {
        hostRequestFingerprint: 'world:host-request:0000000000000f17',
        idempotencyKeyBytes: fromUtf8('agent-runtime-missing-file-key'),
        idempotencyKeyWorldFingerprint: 'world:idempotency-key:0000000000000f18',
        actuatorRef: 'world:actuator-ref:d5e4b1b427522cf2',
        descriptorFingerprint: 'world:descriptor:74afc8c3b2fe4c33',
        actuationClass: 'world:actuation-class:3',
        responseSchema: { status: 'responded' },
        requestBytes: fromUtf8(JSON.stringify({ operation: 'read', path: 'missing.txt' })),
        expectedResponseValueRefFingerprint: '0x0000000000000f19',
        expectedResponseSchemaRefFingerprint: '0x0000000000000f20',
      });
      const resolution = decodeResolutionInputBytes(result.resolutionInputBytes);
      const refs = decodeValueImageResponseRefs(resolution.responseValueImageBytes);

      assert.equal(resolution.status, 0);
      assert.equal(result.diagnostics.agentRuntimeTranslatedResponseStatus, 'not_found');
      assert.equal(result.diagnostics.agentRuntimeResponseBoundToExpectedRefs, true);
      assert.equal(refs.boundaryValueFingerprint, '0x0000000000000f19');
      assert.equal(refs.codecSchemaDescriptorFingerprint, '0x0000000000000f20');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid agent packs during CLI install', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-cli-invalid-install-'));
    try {
      const pack = path.join(root, 'agent-runtime-v0.1');
      await cp(path.resolve('agent-runtime-v0.1'), pack, { recursive: true });
      await writeFile(path.join(pack, 'world/world_universal_appliance.wasm'), 'tampered');
      await assert.rejects(
        () => runBunCli([
          'agent',
          'install',
          '--pack', pack,
          '--store', root,
          '--app', 'agent-runtime-v0.1',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        /ERR_CHECKSUM_MISMATCH:world\/world_universal_appliance\.wasm/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs agent apps with option-first positional app names', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-agent-cli-run-position-'));
    try {
      const wasmPath = path.join(root, 'world_universal_appliance.wasm');
      const imagePath = path.join(root, 'agent.world-executable');
      await writeFile(wasmPath, fromUtf8('wasm:agent-run'));
      await writeFile(imagePath, fromUtf8('image:agent-run'));
      await runBunCli([
        'install',
        '--store', root,
        '--name', 'agent-app',
        '--wasm', wasmPath,
        '--image', imagePath,
        '--image-fingerprint', 'world:image:agent-app',
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      });

      let output = '';
      const code = await runBunCli([
        'agent',
        'run',
        '--store', root,
        'agent-app',
        '--run', 'agent-cli-run',
        '--no-execute',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });

      assert.equal(code, 0);
      const result = JSON.parse(output);
      assert.equal(result.run.runId, 'agent-cli-run');
      assert.equal(result.run.applicationId, 'agent-app');
      assert.equal(result.run.created, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses relative store paths for lock creation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-cli-relative-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      const wasmPath = path.join(root, 'world_universal_appliance.wasm');
      const imagePath = path.join(root, 'file-agent.world-executable');
      await writeFile(wasmPath, fromUtf8('wasm:relative'));
      await writeFile(imagePath, fromUtf8('image:relative'));
      let output = '';
      const code = await runBunCli([
        'install',
        '--json',
        '--store', 'relative-store',
        '--name', 'relative-app',
        '--wasm', wasmPath,
        '--image', imagePath,
        '--image-fingerprint', 'world:image:relative',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });

      assert.equal(code, 0);
      assert.equal(JSON.parse(output).applicationId, 'relative-app');
      assert.equal((await readFile(path.join(root, 'relative-store', 'applications', 'relative-app.json'), 'utf8')).includes('relative-app'), true);
    } finally {
      process.chdir(previousCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates and resumes DirectoryStore runs through RunController-backed CLI paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-cli-run-'));
    const receiverRoot = await mkdtemp(path.join(tmpdir(), 'world-host-cli-genesis-import-'));
    try {
      const wasmPath = path.join(root, 'world_universal_appliance.wasm');
      const imagePath = path.join(root, 'file-agent.world-executable');
      const manifestPath = path.join(root, 'appliance-manifest.bin');
      await writeFile(wasmPath, fromUtf8('wasm:cli-run'));
      await writeFile(imagePath, fromUtf8('image:cli-run'));
      await writeFile(manifestPath, fixtureApplianceManifestBytes({ manifestFingerprint: 0x211n }));
      await runBunCli([
        'install',
        '--json',
        '--store', root,
        '--name', 'run-app',
        '--wasm', wasmPath,
        '--image', imagePath,
        '--image-fingerprint', 'world:image:run-app',
        '--manifest', manifestPath,
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      });

      let output = '';
      const runWorker = new DeterministicCliWorker('run', { manifestFingerprint: 0x211n });
      const runCode = await runBunCli([
        'run',
        'run-app',
        '--json',
        '--store', root,
        '--run', 'cli-run',
        '--branch', 'main',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      }, {
        workerFactory: async () => runWorker,
      });
      const ran = JSON.parse(output);
      assert.equal(runCode, 0);
      assert.equal(ran.run.runId, 'cli-run');
      assert.equal(ran.run.applicationId, 'run-app');
      assert.equal(ran.run.created, true);
      assert.equal(ran.head.generation, 1);
      assert.equal(ran.head.status, 'completed');
      assert.equal(ran.advance.status, 'advanced');
      assert.equal(ran.advance.workerStatus, 'cold');
      assert.equal(ran.advance.unresolvedHostRequestCount, 0);
      assert.equal(ran.diagnostics.workerExecuted, true);
      assert.equal(ran.diagnostics.runHeadMutatedDirectlyByCli, false);
      assert.equal(ran.diagnostics.worldEvidenceAuthored, false);
      assert.doesNotMatch(output, /wasm:cli-run|image:cli-run|closure-bytes:run/);

      let store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        const head = await store.readHead('cli-run', 'main');
        assert.equal(head.generation, 1);
        assert.deepEqual([...await store.getBlob(head.turnClosureRef)], [...fixtureTurnClosureBytes({ turnSequenceNumber: 0n })]);
      } finally {
        await store.releaseLock();
      }

      output = '';
      const createOnlyCode = await runBunCli([
        'run',
        'run-app',
        '--json',
        '--store', root,
        '--run', 'cli-resume',
        '--branch', 'main',
        '--no-execute',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const createOnly = JSON.parse(output);
      assert.equal(createOnlyCode, 0);
      assert.equal(createOnly.run.created, true);
      assert.equal(createOnly.head.generation, 0);
      assert.equal(createOnly.diagnostics.workerExecuted, false);

      const genesisPackagePath = path.join(root, 'genesis-export.json');
      output = '';
      const exportGenesisCode = await runBunCli([
        'export',
        '--json',
        '--store', root,
        '--run', 'cli-resume',
        '--branch', 'main',
        '--out', genesisPackagePath,
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const exportedGenesis = JSON.parse(output);
      assert.equal(exportGenesisCode, 0);
      assert.equal(exportedGenesis.blobCount >= 3, true);

      output = '';
      const importGenesisCode = await runBunCli([
        'import',
        '--json',
        '--store', receiverRoot,
        '--package', genesisPackagePath,
        '--run', 'receiver-genesis',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const importedGenesis = JSON.parse(output);
      assert.equal(importGenesisCode, 0);
      assert.equal(importedGenesis.runId, 'receiver-genesis');
      store = new DirectoryStore(receiverRoot);
      await store.acquireLock();
      try {
        const genesisHead = await store.readHead('receiver-genesis', 'main');
        assert.equal(genesisHead.status, 'genesis');
        assert.deepEqual([...await store.getBlob(genesisHead.turnClosureRef)], [...fromUtf8('world-host:genesis')]);
      } finally {
        await store.releaseLock();
      }

      const tamperedGenesisPackagePath = path.join(root, 'tampered-genesis-export.json');
      const tamperedGenesisPackage = JSON.parse(await readFile(genesisPackagePath, 'utf8'));
      tamperedGenesisPackage.bundle.head.turnClosureWorldFingerprint = 'world:turn-closure:evil';
      await writeFile(tamperedGenesisPackagePath, JSON.stringify(tamperedGenesisPackage));
      await assert.rejects(
        () => runBunCli([
          'import',
          '--json',
          '--store', receiverRoot,
          '--package', tamperedGenesisPackagePath,
          '--run', 'receiver-genesis-tampered',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_GENESIS_MISMATCH' },
      );

      output = '';
      const recoverGenesisCode = await runBunCli([
        'recover',
        '--json',
        '--store', root,
        '--run', 'cli-resume',
        '--branch', 'main',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const recoveredGenesis = JSON.parse(output);
      assert.equal(recoverGenesisCode, 0);
      assert.equal(recoveredGenesis.effectReconciliation.committedCount, 0);
      assert.equal(recoveredGenesis.effectReconciliation.parentTurnClosureFingerprint, null);

      output = '';
      const resumeWorker = new DecodableCliWorker({ status: 1 });
      const resumeCode = await runBunCli([
        'resume',
        '--json',
        '--store', root,
        '--run', 'cli-resume',
        '--branch', 'main',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      }, {
        workerFactory: async () => resumeWorker,
      });
      const resumed = JSON.parse(output);
      assert.equal(resumeCode, 0);
      assert.equal(resumed.run.runId, 'cli-resume');
      assert.equal(resumed.run.created, false);
      assert.equal(resumed.head.generation, 1);
      assert.equal(resumed.advance.status, 'advanced');
      assert.equal(resumed.diagnostics.workerExecuted, true);
      assert.equal(resumed.diagnostics.worldEvidenceAuthored, false);

      store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        const head = await store.readHead('cli-resume', 'main');
        assert.equal(head.generation, 1);
        assert.deepEqual([...await store.getBlob(head.turnClosureRef)], [...fixtureTurnClosureBytes({ status: 1, turnSequenceNumber: 0n })]);
      } finally {
        await store.releaseLock();
      }

      store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        const zeroClosureBytes = fixtureTurnClosureBytes({ status: 1, turnSequenceNumber: 0n });
        const zeroClosureSummary = summarizeTurnClosureForRunHead(zeroClosureBytes);
        const zeroClosureRef = await store.putBlob(zeroClosureBytes);
        const zeroHead = createRunHead({
          generation: zeroClosureSummary.inspectionDiagnostics.turnSequenceNumber + 1,
          turnClosureRef: zeroClosureRef,
          turnClosureWorldFingerprint: zeroClosureSummary.turnClosureWorldFingerprint,
          resultingStateFingerprint: zeroClosureSummary.resultingStateFingerprint,
          chronicleCursor: zeroClosureSummary.chronicleCursor,
          archiveMomentFingerprint: zeroClosureSummary.archiveMomentFingerprint,
          archiveSealFingerprint: zeroClosureSummary.archiveSealFingerprint,
          status: zeroClosureSummary.status,
        });
        await store.createRun(createRunRecord({
          runId: 'cli-real-zero',
          applicationId: 'run-app',
          branches: [createBranchRecord({ branchId: 'main', currentHead: zeroHead })],
          effectJournalNamespace: 'effects',
        }));
      } finally {
        await store.releaseLock();
      }

      output = '';
      const zeroWorker = new DecodableCliWorker({ turnSequenceNumber: 1n });
      const zeroResumeCode = await runBunCli([
        'resume',
        '--json',
        '--store', root,
        '--run', 'cli-real-zero',
        '--branch', 'main',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      }, {
        workerFactory: async () => zeroWorker,
      });
      const zeroResumed = JSON.parse(output);
      assert.equal(zeroResumeCode, 0);
      assert.equal(zeroResumed.head.generation, 2);
      assert.equal(zeroWorker.submittedTurnInputBytes[4], 1);

      output = '';
      const secondResumeWorker = new DeterministicCliWorker('resume-second', { startSequence: 1n });
      const secondResumeCode = await runBunCli([
        'resume',
        '--json',
        '--store', root,
        '--run', 'cli-resume',
        '--branch', 'main',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      }, {
        workerFactory: async () => secondResumeWorker,
      });
      const secondResumed = JSON.parse(output);
      assert.equal(secondResumeCode, 0);
      assert.equal(secondResumed.head.generation, 2);
      assert.equal(secondResumed.advance.status, 'advanced');
      assert.equal(secondResumed.diagnostics.workerExecuted, true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(receiverRoot, { recursive: true, force: true });
    }
  });

  it('rejects unsafe DirectoryStore path segment ids', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-cli-unsafe-id-'));
    try {
      const store = new DirectoryStore(root);
      const app = {
        applicationId: '../escape',
        worldProtocolVersion: 'v0.1.0',
        applianceAbiVersion: 'v4',
        universalWasmChecksum: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        executableImageWorldFingerprint: 'world:image',
      };
      await assert.rejects(() => store.createApplication(app), { code: 'ERR_STORE_ID_PATH_UNSAFE' });
      await assert.rejects(() => store.getRun('bad/run'), { code: 'ERR_STORE_ID_PATH_UNSAFE' });
      await assert.rejects(() => store.readHead('run', 'bad/branch'), { code: 'ERR_STORE_ID_PATH_UNSAFE' });
      const closureRef = await store.putBlob(fromUtf8('closure'));
      const head = createRunHead({
        generation: 0,
        turnClosureRef: closureRef,
        turnClosureWorldFingerprint: 'world:closure:unsafe',
        resultingStateFingerprint: 'world:state:unsafe',
        chronicleCursor: 'cursor:unsafe',
        archiveMomentFingerprint: 'archive:moment:unsafe',
        archiveSealFingerprint: 'archive:seal:unsafe',
        status: 'completed',
      });
      await assert.rejects(
        () => store.createRun(createRunRecord({
          runId: 'unsafe-run',
          applicationId: 'app',
          branches: [createBranchRecord({ branchId: 'bad/branch', currentHead: head })],
          effectJournalNamespace: 'effects',
        })),
        { code: 'ERR_STORE_ID_PATH_UNSAFE' },
      );
      await assert.rejects(() => store.getRun('unsafe-run'), { code: 'ERR_RUN_NOT_FOUND' });

      await assert.rejects(
        () => store.createRun(createRunRecord({
          runId: 'atomic-unsafe-run',
          applicationId: 'app',
          branches: [
            createBranchRecord({ branchId: 'main', currentHead: head }),
            createBranchRecord({ branchId: 'bad/branch', currentHead: head }),
          ],
          effectJournalNamespace: 'effects',
        })),
        { code: 'ERR_STORE_ID_PATH_UNSAFE' },
      );
      await assert.rejects(() => store.readHead('atomic-unsafe-run', 'main'), { code: 'ERR_HEAD_NOT_FOUND' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes DirectoryStore run records only after initial branch heads are durable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-cli-create-run-order-'));
    try {
      const store = new DirectoryStore(root);
      const closureRef = await store.putBlob(fixtureTurnClosureBytes());
      const head = createRunHead({
        generation: 0,
        turnClosureRef: closureRef,
        turnClosureWorldFingerprint: 'world:closure:create-run-order',
        resultingStateFingerprint: 'world:state:create-run-order',
        chronicleCursor: 'cursor:create-run-order',
        archiveMomentFingerprint: 'archive:moment:create-run-order',
        archiveSealFingerprint: 'archive:seal:create-run-order',
        status: 'completed',
      });
      await store.writeHead('partial-run', 'main', head);

      await store.createRun(createRunRecord({
        runId: 'partial-run',
        applicationId: 'app',
        branches: [createBranchRecord({ branchId: 'main', currentHead: head })],
        effectJournalNamespace: 'effects',
      }));

      assert.equal((await store.getRun('partial-run')).runId, 'partial-run');
      assert.deepEqual(await store.readHead('partial-run', 'main'), head);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed on corrupt persisted effect records', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-cli-corrupt-effect-'));
    try {
      const { run } = await fixtureDirectoryStore(root);
      const store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        const [effect] = await store.listEffectRecords(run.runId);
        const [effectFile] = await readdir(path.join(root, 'effects', run.runId));
        await writeFile(path.join(root, 'effects', run.runId, effectFile), '{"truncated"');
        await assert.rejects(() => store.getEffectRecord(run.runId, effect.idempotencyKey), SyntaxError);
      } finally {
        await store.releaseLock();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('inspects DirectoryStore run and effect diagnostics without exposing key bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-cli-store-'));
    try {
      const { run, head } = await fixtureDirectoryStore(root);
      const store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        const [effect] = await store.listEffectRecords(run.runId);
        await store.putEffectRecord({
          ...effect,
          diagnostics: {
            idempotencyKey: {
              format: 'world-idempotency-key-bytes.hex',
              bytesHex: Buffer.from('complete-world-idempotency-key').toString('hex'),
            },
          },
        });
        await store.putEffectRecord({
          ...effect,
          branchId: 'alternate',
          state: 'submitted',
        });
      } finally {
        await store.releaseLock();
      }
      let output = '';
      const inspectCode = await runBunCli(['inspect', '--json', '--store', root, '--run', run.runId, '--branch', 'main'], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const inspected = JSON.parse(output);

      assert.equal(inspectCode, 0);
      assert.equal(inspected.run.runId, run.runId);
      assert.equal(inspected.run.applicationId, run.applicationId);
      assert.equal(inspected.head.generation, head.generation);
      assert.equal(inspected.head.turnClosureWorldFingerprint, head.turnClosureWorldFingerprint);
      assert.equal(inspected.head.closureByteSize > 0, true);
      assert.equal(inspected.effects.total, 1);
      assert.equal(inspected.effects.states.closure_committed, 1);
      assert.equal(inspected.diagnostics.workerExecuted, false);
      assert.equal(inspected.diagnostics.driversInvoked, false);

      output = '';
      const effectsCode = await runBunCli(['effects', '--json', '--store', root, '--run', run.runId], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const effects = JSON.parse(output);

      assert.equal(effectsCode, 0);
      assert.equal(effects.effects.length, 2);
      assert.equal(effects.effects[0].completeIdempotencyKeyBytesOmitted, true);
      assert.equal(effects.effects[0].idempotencyKeyWorldFingerprint, 'world:key:cli');
      assert.equal(effects.diagnostics.workerExecuted, false);
      assert.doesNotMatch(output, /bytesHex|complete-world-idempotency-key/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers DirectoryStore scanner diagnostics and reconciles submitted effects without key bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-cli-recover-'));
    try {
      const { run } = await fixtureDirectoryStore(root, { effectState: 'submitted' });
      let output = '';
      const recoverCode = await runBunCli(['recover', '--json', '--store', root, '--run', run.runId, '--branch', 'main'], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const recovered = JSON.parse(output);

      assert.equal(recoverCode, 0);
      assert.equal(recovered.command, 'recover');
      assert.equal(recovered.scan.garbageCollected, false);
      assert.equal(recovered.scan.multiProcessWriterSupport, false);
      assert.equal(recovered.scan.orphanBlobCount >= 0, true);
      assert.equal(recovered.effectReconciliation.runId, run.runId);
      assert.equal(recovered.effectReconciliation.branchId, 'main');
      assert.equal(recovered.effectReconciliation.committedCount, 1);
      assert.equal(recovered.diagnostics.workerExecuted, false);
      assert.equal(recovered.diagnostics.driversInvoked, false);
      assert.equal(recovered.diagnostics.runHeadMutated, false);
      assert.equal(recovered.diagnostics.worldEvidenceAuthored, false);
      assert.doesNotMatch(output, /bytesHex|complete-world-idempotency-key/);

      const store = new DirectoryStore(root);
      await store.acquireLock();
      try {
        const app = await store.getApplication(run.applicationId);
        const effects = await store.listEffectRecords(run.runId);
        assert.equal(effects.length, 1);
        assert.equal(effects[0].state, 'closure_committed');
        assert.equal(recovered.scan.orphanBlobs.some((ref) => ref.checksum === app.executableImageRef.checksum), false);
        assert.equal(recovered.scan.orphanBlobs.some((ref) => ref.checksum === effects[0].resolutionInputRef.checksum), false);
      } finally {
        await store.releaseLock();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resumes DirectoryStore imports after run and head publication', async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'world-host-import-source-'));
    const receiverRoot = await mkdtemp(path.join(tmpdir(), 'world-host-import-receiver-'));
    try {
      const { run } = await fixtureDirectoryStore(sourceRoot);
      const sourceStore = new DirectoryStore(sourceRoot);
      const bundle = await sourceStore.exportRun(run.runId, 'main');
      const receiverStore = new DirectoryStore(receiverRoot);
      await receiverStore.acquireLock();
      try {
        for (const blob of bundle.blobs) await receiverStore.putBlob(Uint8Array.from(blob.bytes));
        const legacyApplication = { ...bundle.application };
        delete legacyApplication.requiredHostAuthorityLabels;
        await receiverStore.createApplication(legacyApplication);
        await receiverStore.createRun(bundle.run);
        assert.equal((await receiverStore.listEffectRecords(run.runId)).length, 0);

        await receiverStore.importRun(bundle);
        assert.equal((await receiverStore.listEffectRecords(run.runId)).length, bundle.effects.length);
        await assert.rejects(() => receiverStore.importRun(bundle), { code: 'ERR_IMPORT_RUN_EXISTS' });
      } finally {
        await receiverStore.releaseLock();
      }
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(receiverRoot, { recursive: true, force: true });
    }
  });

  it('exports creation metadata input blobs after branch heads advance', async () => {
    const memory = await fixtureStore();
    const memoryInputBytes = fromUtf8('memory-creation-input');
    const memoryInputRef = await memory.store.putBlob(memoryInputBytes);
    const memoryPolicyBytes = fromUtf8('memory-receiver-policy');
    const memoryPolicyRef = await memory.store.putBlob(memoryPolicyBytes);
    await memory.store.writeRun({
      ...memory.run,
      creationMetadata: {
        source: 'test.creation',
        inputRef: memoryInputRef,
      },
      receiverPolicyRef: memoryPolicyRef,
    });
    const memoryBundle = await memory.store.exportRun(memory.run.runId, 'main');
    assert.equal(memoryBundle.blobs.some((blob) => blob.checksum === memoryInputRef.checksum), true);
    assert.equal(memoryBundle.blobs.some((blob) => blob.checksum === memoryPolicyRef.checksum), true);
    const importedMemory = new MemoryStore();
    await importedMemory.importRun(memoryBundle);
    assert.deepEqual([...await importedMemory.getBlob(memoryInputRef)], [...memoryInputBytes]);
    assert.deepEqual([...await importedMemory.getBlob(memoryPolicyRef)], [...memoryPolicyBytes]);

    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'world-host-creation-export-source-'));
    const receiverRoot = await mkdtemp(path.join(tmpdir(), 'world-host-creation-export-receiver-'));
    try {
      const { run } = await fixtureDirectoryStore(sourceRoot);
      const sourceStore = new DirectoryStore(sourceRoot);
      await sourceStore.acquireLock();
      let directoryInputRef;
      let directoryPolicyRef;
      try {
        const runRecord = await sourceStore.getRun(run.runId);
        const inputBytes = fromUtf8('directory-creation-input');
        const policyBytes = fromUtf8('directory-receiver-policy');
        directoryInputRef = await sourceStore.putBlob(inputBytes);
        directoryPolicyRef = await sourceStore.putBlob(policyBytes);
        await sourceStore.writeRun({
          ...runRecord,
          creationMetadata: {
            source: 'test.creation',
            inputRef: directoryInputRef,
          },
          receiverPolicyRef: directoryPolicyRef,
        });
      } finally {
        await sourceStore.releaseLock();
      }

      const bundle = await sourceStore.exportRun(run.runId, 'main');
      assert.equal(bundle.blobs.some((blob) => blob.checksum === directoryInputRef.checksum), true);
      assert.equal(bundle.blobs.some((blob) => blob.checksum === directoryPolicyRef.checksum), true);

      const receiverStore = new DirectoryStore(receiverRoot);
      await receiverStore.importRun(bundle);
      assert.deepEqual([...await receiverStore.getBlob(directoryInputRef)], [...fromUtf8('directory-creation-input')]);
      assert.deepEqual([...await receiverStore.getBlob(directoryPolicyRef)], [...fromUtf8('directory-receiver-policy')]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(receiverRoot, { recursive: true, force: true });
    }
  });

  it('exports, imports, and forks DirectoryStore runs through redacted CLI operations', async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'world-host-cli-migrate-source-'));
    const receiverRoot = await mkdtemp(path.join(tmpdir(), 'world-host-cli-migrate-receiver-'));
    const blockedReceiverRoot = await mkdtemp(path.join(tmpdir(), 'world-host-cli-migrate-terminal-receiver-'));
    const packagePath = path.join(receiverRoot, 'carrier-export.json');
    let diagnosticRef = null;
    let retainedDiagnosticRef = null;
    let unreferencedRef = null;
    try {
      const { run, head } = await fixtureDirectoryStore(sourceRoot, { closureOptions: { turnSequenceNumber: 0n } });
      let output = '';
      const forkCode = await runBunCli([
        'fork',
        '--json',
        '--store', sourceRoot,
        '--run', run.runId,
        '--source-branch', 'main',
        '--from', head.turnClosureWorldFingerprint,
        '--branch', 'alternate',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const forked = JSON.parse(output);
      assert.equal(forkCode, 0);
      assert.equal(forked.newBranchId, 'alternate');
      assert.equal(forked.forkedFromTurnClosureFingerprint, head.turnClosureWorldFingerprint);
      assert.equal(forked.sourceBranchMutated, false);
      assert.equal(forked.diagnostics.workerExecuted, false);
      const sourceStore = new DirectoryStore(sourceRoot);
      await sourceStore.acquireLock();
      try {
        assert.equal((await sourceStore.readHead(run.runId, 'main')).turnClosureWorldFingerprint, head.turnClosureWorldFingerprint);
        assert.equal((await sourceStore.readHead(run.runId, 'alternate')).turnClosureWorldFingerprint, head.turnClosureWorldFingerprint);
        const alternateJournal = new EffectJournal({
          store: sourceStore,
          runId: run.runId,
          branchId: 'alternate',
          parentTurnClosureFingerprint: 'world:closure:parent',
        });
        await alternateJournal.resolve({}, {
          actuatorRef: 'fixture:model',
          descriptorFingerprint: 'descriptor:fixture',
          actuationClass: 'fixture',
          responseSchema: { status: 'ok' },
          idempotencyKeyBytes: fromUtf8('alternate-world-idempotency-key'),
          idempotencyKeyWorldFingerprint: 'world:key:alternate',
          requestBytes: fromUtf8('request:alternate'),
          hostRequestFingerprint: 'world:host-request:0000000000000b01',
        }, fixtureDriver());
        diagnosticRef = await sourceStore.putBlob(fromUtf8('diagnostic-input'));
        retainedDiagnosticRef = await sourceStore.putBlob(fromUtf8('retained-diagnostic-input'));
        unreferencedRef = await sourceStore.putBlob(fromUtf8('unrelated-secret'));
        const mainHead = await sourceStore.readHead(run.runId, 'main');
        await sourceStore.writeHead(run.runId, 'main', {
          ...mainHead,
          updateDiagnostics: {
            ...mainHead.updateDiagnostics,
            archiveAppendBatchRef: retainedDiagnosticRef,
          },
        });
        const [mainEffect] = await sourceStore.listEffectRecords(run.runId);
        await sourceStore.putEffectRecord({
          ...mainEffect,
          diagnostics: { externalChecksumLikeObject: diagnosticRef },
        });
      } finally {
        await sourceStore.releaseLock();
      }

      output = '';
      const exportCode = await runBunCli([
        'export',
        '--json',
        '--store', sourceRoot,
        '--run', run.runId,
        '--branch', 'main',
        '--out', packagePath,
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const exported = JSON.parse(output);
      const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
      assert.equal(exportCode, 0);
      assert.equal(exported.carrierExportVersion, 'CarrierExport-v0');
      assert.equal(exported.authorityCarried, false);
      assert.equal(exported.blobCount >= 3, true);
      assert.equal(packageJson.authorityCarried, false);
      assert.equal(packageJson.bundle.application.applicationId, run.applicationId);
      assert.equal(Array.isArray(packageJson.bundle.blobs[0].bytes), true);
      assert.equal(packageJson.bundle.blobs.some((blob) => blob.checksum === retainedDiagnosticRef.checksum), true);
      assert.equal(packageJson.bundle.blobs.some((blob) => blob.checksum === diagnosticRef.checksum), false);
      assert.equal(packageJson.bundle.blobs.some((blob) => blob.checksum === unreferencedRef.checksum), false);
      assert.equal(packageJson.bundle.effects.every((effect) => effect.branchId === 'main'), true);
      assert.doesNotMatch(output, /bytesHex|complete-world-idempotency-key/);
      packageJson.bundle.run.branches.push(createBranchRecord({
        branchId: 'alternate',
        currentHead: { ...packageJson.bundle.head, generation: 99 },
      }));
      packageJson.bundle.effects.push({
        ...packageJson.bundle.effects[0],
        branchId: 'alternate',
        idempotencyKey: { format: 'world-idempotency-key-bytes.hex', bytesHex: '616c7465726e617465' },
        idempotencyKeyWorldFingerprint: 'world:key:alternate-import',
      });
      await writeFile(packagePath, JSON.stringify(packageJson));
      const blockedPackagePath = path.join(sourceRoot, 'blocked-package.json');
      await writeFile(blockedPackagePath, JSON.stringify({
        ...packageJson,
        bundle: {
          ...packageJson.bundle,
          application: {
            ...packageJson.bundle.application,
            requiredActuators: [{ actuatorRef: 'sandbox:file' }],
          },
        },
      }));
      let blockedOutput = '';
      const blockedCode = await runBunCli([
        'import',
        '--json',
        '--store', blockedReceiverRoot,
        '--package', blockedPackagePath,
        '--run', 'blocked-run',
      ], {
        stdout: { write: (text) => { blockedOutput += text; } },
        stderr: { write() {} },
      });
      assert.equal(blockedCode, 0);
      assert.equal(JSON.parse(blockedOutput).runId, 'blocked-run');
      const pendingClosureBytes = fixtureNeedsHostTurnClosureBytes();
      const pendingClosureSummary = summarizeTurnClosureForRunHead(pendingClosureBytes);
      const pendingClosureBlob = blobEntryForBytes(pendingClosureBytes);
      const pendingPackagePath = path.join(sourceRoot, 'pending-package.json');
      await writeFile(pendingPackagePath, JSON.stringify({
        ...packageJson,
        bundle: {
          ...packageJson.bundle,
          head: {
            ...packageJson.bundle.head,
            status: 'needs_host',
            turnClosureRef: {
              algorithm: 'sha256',
              checksum: pendingClosureBlob.checksum,
              byteLength: pendingClosureBlob.byteLength,
            },
            turnClosureWorldFingerprint: pendingClosureSummary.turnClosureWorldFingerprint,
            resultingStateFingerprint: pendingClosureSummary.resultingStateFingerprint,
            chronicleCursor: pendingClosureSummary.chronicleCursor,
            archiveMomentFingerprint: pendingClosureSummary.archiveMomentFingerprint,
            archiveSealFingerprint: pendingClosureSummary.archiveSealFingerprint,
          },
          blobs: [...packageJson.bundle.blobs, pendingClosureBlob],
        },
      }));
      await assert.rejects(
        () => runBunCli([
          'import',
          '--json',
          '--store', receiverRoot,
          '--package', pendingPackagePath,
          '--run', 'pending-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_BLOCKED' },
      );
      const tamperedStatusPackagePath = path.join(sourceRoot, 'tampered-status-package.json');
      await writeFile(tamperedStatusPackagePath, JSON.stringify({
        ...packageJson,
        bundle: {
          ...packageJson.bundle,
          head: {
            ...packageJson.bundle.head,
            status: 'completed',
            turnClosureRef: {
              algorithm: 'sha256',
              checksum: pendingClosureBlob.checksum,
              byteLength: pendingClosureBlob.byteLength,
            },
            turnClosureWorldFingerprint: pendingClosureSummary.turnClosureWorldFingerprint,
            resultingStateFingerprint: pendingClosureSummary.resultingStateFingerprint,
            chronicleCursor: pendingClosureSummary.chronicleCursor,
            archiveMomentFingerprint: pendingClosureSummary.archiveMomentFingerprint,
            archiveSealFingerprint: pendingClosureSummary.archiveSealFingerprint,
          },
          blobs: [...packageJson.bundle.blobs, pendingClosureBlob],
        },
      }));
      await assert.rejects(
        () => runBunCli([
          'import',
          '--json',
          '--store', receiverRoot,
          '--package', tamperedStatusPackagePath,
          '--run', 'tampered-status-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_HEAD_STATUS_MISMATCH' },
      );

      const tamperedGenesisPackagePath = path.join(sourceRoot, 'tampered-genesis-package.json');
      await writeFile(tamperedGenesisPackagePath, JSON.stringify({
        ...packageJson,
        bundle: {
          ...packageJson.bundle,
          head: {
            ...packageJson.bundle.head,
            status: 'genesis',
          },
        },
      }));
      await assert.rejects(
        () => runBunCli([
          'import',
          '--json',
          '--store', receiverRoot,
          '--package', tamperedGenesisPackagePath,
          '--run', 'tampered-genesis-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_GENESIS_MISMATCH' },
      );

      const tamperedFingerprintPackagePath = path.join(sourceRoot, 'tampered-fingerprint-package.json');
      await writeFile(tamperedFingerprintPackagePath, JSON.stringify({
        ...packageJson,
        bundle: {
          ...packageJson.bundle,
          head: {
            ...packageJson.bundle.head,
            turnClosureWorldFingerprint: 'world:turn-closure:tampered',
          },
        },
      }));
      await assert.rejects(
        () => runBunCli([
          'import',
          '--json',
          '--store', receiverRoot,
          '--package', tamperedFingerprintPackagePath,
          '--run', 'tampered-fingerprint-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_HEAD_CLOSURE_MISMATCH' },
      );

      const tamperedGenerationPackagePath = path.join(sourceRoot, 'tampered-generation-package.json');
      await writeFile(tamperedGenerationPackagePath, JSON.stringify({
        ...packageJson,
        bundle: {
          ...packageJson.bundle,
          head: {
            ...packageJson.bundle.head,
            generation: packageJson.bundle.head.generation - 1,
          },
        },
      }));
      await assert.rejects(
        () => runBunCli([
          'import',
          '--json',
          '--store', receiverRoot,
          '--package', tamperedGenerationPackagePath,
          '--run', 'tampered-generation-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_HEAD_GENERATION_MISMATCH' },
      );

      output = '';
      const importCode = await runBunCli([
        'import',
        '--json',
        '--store', receiverRoot,
        '--package', packagePath,
        '--run', 'receiver-run',
      ], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const imported = JSON.parse(output);
      assert.equal(importCode, 0);
      assert.equal(imported.runId, 'receiver-run');
      assert.equal(imported.authorityImported, false);
      assert.equal(imported.receiverPolicyApplied, true);
      assert.equal(imported.diagnostics.workerExecuted, false);
      assert.doesNotMatch(output, /bytesHex|complete-world-idempotency-key/);

      const receiverStore = new DirectoryStore(receiverRoot);
      await receiverStore.acquireLock();
      try {
        assert.equal((await receiverStore.getApplication(run.applicationId)).applicationId, run.applicationId);
        const receiverHead = await receiverStore.readHead('receiver-run', 'main');
        assert.equal(receiverHead.turnClosureWorldFingerprint, head.turnClosureWorldFingerprint);
        assert.deepEqual([...await receiverStore.getBlob(receiverHead.turnClosureRef)], [...fixtureTurnClosureBytes({ turnSequenceNumber: 0n })]);
        assert.deepEqual([...await receiverStore.getBlob(receiverHead.updateDiagnostics.archiveAppendBatchRef)], [...fromUtf8('retained-diagnostic-input')]);
        await assert.rejects(() => receiverStore.getBlob(diagnosticRef), { code: 'ERR_BLOB_NOT_FOUND' });
        await assert.rejects(
          () => receiverStore.readHead('receiver-run', 'alternate'),
          { code: 'ERR_HEAD_NOT_FOUND' },
        );
        const receiverRun = await receiverStore.getRun('receiver-run');
        assert.deepEqual(receiverRun.branches.map((branch) => branch.branchId), ['main']);
        const receiverEffects = await receiverStore.listEffectRecords('receiver-run');
        assert.equal(receiverEffects.length, 1);
        assert.equal(receiverEffects[0].branchId, 'main');
      } finally {
        await receiverStore.releaseLock();
      }
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(receiverRoot, { recursive: true, force: true });
      await rm(blockedReceiverRoot, { recursive: true, force: true });
    }
  });

  it('rejects imports that collide with local run or application identity', async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'world-host-cli-import-source-'));
    const receiverRoot = await mkdtemp(path.join(tmpdir(), 'world-host-cli-import-receiver-'));
    try {
      const { run } = await fixtureDirectoryStore(sourceRoot);
      const sourceStore = new DirectoryStore(sourceRoot);
      const carrierExport = await exportCarrierRun(sourceStore, run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
      const wasmChecksum = carrierExport.bundle.application.universalWasmChecksum.slice('sha256:'.length);
      assert.equal(carrierExport.bundle.blobs.some((blob) => blob.checksum === wasmChecksum), true);

      const receiverStore = new DirectoryStore(receiverRoot);
      await receiverStore.acquireLock();
      try {
        await receiverStore.importRun(carrierExport.bundle);
        await assert.rejects(() => receiverStore.importRun(carrierExport.bundle), { code: 'ERR_IMPORT_RUN_EXISTS' });
      } finally {
        await receiverStore.releaseLock();
      }

      const runCollisionRoot = await mkdtemp(path.join(tmpdir(), 'world-host-cli-import-run-collision-'));
      try {
        const runCollisionStore = new DirectoryStore(runCollisionRoot);
        await runCollisionStore.acquireLock();
        try {
          await runCollisionStore.createRun(carrierExport.bundle.run);
          await assert.rejects(() => runCollisionStore.importRun(carrierExport.bundle), { code: 'ERR_IMPORT_RUN_EXISTS' });
          await assert.rejects(
            () => runCollisionStore.getApplication(carrierExport.bundle.application.applicationId),
            { code: 'ERR_APPLICATION_NOT_FOUND' },
          );
        } finally {
          await runCollisionStore.releaseLock();
        }
      } finally {
        await rm(runCollisionRoot, { recursive: true, force: true });
      }

      const effectCollisionRoot = await mkdtemp(path.join(tmpdir(), 'world-host-cli-import-effect-collision-'));
      try {
        const effectCollisionStore = new DirectoryStore(effectCollisionRoot);
        await effectCollisionStore.acquireLock();
        try {
          const effectCollisionBundle = JSON.parse(JSON.stringify(carrierExport.bundle));
          await effectCollisionStore.putEffectRecord({ ...effectCollisionBundle.effects[0], diagnostics: { existing: true } });
          await assert.rejects(() => effectCollisionStore.importRun(effectCollisionBundle), { code: 'ERR_IMPORT_EFFECT_EXISTS' });
          await assert.rejects(
            () => effectCollisionStore.getApplication(effectCollisionBundle.application.applicationId),
            { code: 'ERR_APPLICATION_NOT_FOUND' },
          );
          await assert.rejects(() => effectCollisionStore.getRun(effectCollisionBundle.run.runId), { code: 'ERR_RUN_NOT_FOUND' });
          const firstBlob = effectCollisionBundle.blobs.find((blob) => Array.isArray(blob.bytes));
          assert.equal(await effectCollisionStore.hasBlob({ algorithm: 'sha256', checksum: firstBlob.checksum, byteLength: firstBlob.byteLength }), false);
        } finally {
          await effectCollisionStore.releaseLock();
        }
      } finally {
        await rm(effectCollisionRoot, { recursive: true, force: true });
      }

      const mismatchRoot = await mkdtemp(path.join(tmpdir(), 'world-host-cli-import-mismatch-'));
      try {
        const mismatchStore = new DirectoryStore(mismatchRoot);
        await mismatchStore.acquireLock();
        try {
          await mismatchStore.createApplication({ ...carrierExport.bundle.application, executableImageWorldFingerprint: 'world:image:other' });
          await assert.rejects(() => mismatchStore.importRun(carrierExport.bundle), { code: 'ERR_IMPORT_APPLICATION_MISMATCH' });
        } finally {
          await mismatchStore.releaseLock();
        }
      } finally {
        await rm(mismatchRoot, { recursive: true, force: true });
      }

      const missingApplicationBundle = JSON.parse(JSON.stringify(carrierExport.bundle));
      delete missingApplicationBundle.application;
      await assertImportsReject(missingApplicationBundle, 'ERR_IMPORT_APPLICATION_REQUIRED');

      const invalidApplicationBundle = JSON.parse(JSON.stringify(carrierExport.bundle));
      delete invalidApplicationBundle.application.worldProtocolVersion;
      await assertImportsReject(invalidApplicationBundle, 'ERR_REQUIRED_FIELD');

      const runApplicationMismatchBundle = JSON.parse(JSON.stringify(carrierExport.bundle));
      runApplicationMismatchBundle.run.applicationId = 'receiver-local-app';
      await assertImportsReject(runApplicationMismatchBundle, 'ERR_IMPORT_APPLICATION_MISMATCH');

      const effectScopeMismatchBundle = JSON.parse(JSON.stringify(carrierExport.bundle));
      effectScopeMismatchBundle.effects[0].runId = 'receiver-local-run';
      await assertImportsReject(effectScopeMismatchBundle, 'ERR_IMPORT_EFFECT_SCOPE_MISMATCH');

      const memoryEffectCollision = new MemoryStore();
      const memoryEffectCollisionBundle = JSON.parse(JSON.stringify(carrierExport.bundle));
      await memoryEffectCollision.putEffectRecord({ ...memoryEffectCollisionBundle.effects[0], diagnostics: { existing: true } });
      await assert.rejects(() => memoryEffectCollision.importRun(memoryEffectCollisionBundle), { code: 'ERR_IMPORT_EFFECT_EXISTS' });
      await assert.rejects(() => memoryEffectCollision.getRun(memoryEffectCollisionBundle.run.runId), { code: 'ERR_RUN_NOT_FOUND' });

      const memoryPartialImport = new MemoryStore();
      await memoryPartialImport.createApplication(carrierExport.bundle.application);
      await memoryPartialImport.createRun(carrierExport.bundle.run);
      await memoryPartialImport.importRun(carrierExport.bundle);
      assert.equal((await memoryPartialImport.listEffectRecords(carrierExport.bundle.run.runId)).length, carrierExport.bundle.effects.length);

      const selectedHeadMismatchBundle = JSON.parse(JSON.stringify(carrierExport.bundle));
      selectedHeadMismatchBundle.run.branches[0].currentHead = {
        ...selectedHeadMismatchBundle.head,
        generation: selectedHeadMismatchBundle.head.generation + 1,
      };
      await assertImportsReject(selectedHeadMismatchBundle, 'ERR_IMPORT_BRANCH_HEAD_MISMATCH');

      const corruptRoot = await mkdtemp(path.join(tmpdir(), 'world-host-cli-import-corrupt-'));
      try {
        const corruptStore = new DirectoryStore(corruptRoot);
        const corruptExport = JSON.parse(JSON.stringify(carrierExport));
        corruptExport.bundle.blobs[0].byteLength += 1;
        await corruptStore.acquireLock();
        try {
          await assert.rejects(() => corruptStore.importRun(corruptExport.bundle), { code: 'ERR_IMPORT_BLOB_CHECKSUM_MISMATCH' });
        } finally {
          await corruptStore.releaseLock();
        }
      } finally {
        await rm(corruptRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await rm(receiverRoot, { recursive: true, force: true });
    }
  });

  it('propagates executable CLI return codes to the process', async () => {
    const bun = bunExecutable();
    const result = spawnSync(bun, [path.resolve('bin/world-host.mjs'), 'run-example', 'missing-example'], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown example: missing-example/);

    const unknown = spawnSync(bun, [path.resolve('bin/world-host.mjs'), 'resum'], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
    });
    assert.equal(unknown.status, 2);

    const exportWithoutStore = spawnSync(bun, [
      path.resolve('bin/world-host.mjs'),
      'export',
      '--run', 'r',
      '--out', 'pkg.json',
      '--json',
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
    });
    assert.equal(exportWithoutStore.status, 1);
    assert.match(exportWithoutStore.stderr, /missing required option: --store/);

    const malformedRoot = await mkdtemp(path.join(tmpdir(), 'world-host-cli-malformed-'));
    try {
      const malformed = spawnSync(bun, [
        path.resolve('bin/world-host.mjs'),
        'run',
        'app',
        '--store',
        '--run',
        'r',
        '--no-execute',
        '--json',
      ], {
        cwd: malformedRoot,
        encoding: 'utf8',
      });
      assert.equal(malformed.status, 1);
      assert.match(malformed.stderr, /missing required option: --store/);
      assert.equal((await readdir(malformedRoot)).includes('--run'), false);
    } finally {
      await rm(malformedRoot, { recursive: true, force: true });
    }
  });
});

function bunExecutable() {
  assert.equal(typeof process.versions.bun, 'string');
  assert.match(process.execPath, /bun(?:\.exe)?$/);
  return process.execPath;
}

class DeterministicCliWorker extends WorldWorker {
  constructor(label, options = {}) {
    super();
    this.label = label;
    this.startSequence = options.startSequence ?? 0n;
    this.manifestFingerprint = options.manifestFingerprint ?? null;
    this.submitCount = 0;
  }

  readApplianceManifest() {
    if (this.manifestFingerprint == null) return super.readApplianceManifest();
    return { decoded: { manifestFingerprint: this.manifestFingerprint } };
  }

  async submitTurn(turnInputBytes) {
    assert.equal(turnInputBytes.byteLength > 0, true);
    this.submitCount += 1;
    this.lastTurnClosureBytes = fixtureTurnClosureBytes({ turnSequenceNumber: this.startSequence + BigInt(this.submitCount - 1) });
    return {
      turnClosureBytes: new Uint8Array(this.lastTurnClosureBytes),
      turnClosureWorldFingerprint: `world:closure:${this.label}:${this.submitCount}`,
      resultingStateFingerprint: `world:state:${this.label}:${this.submitCount}`,
      chronicleCursor: `world:chronicle:${this.label}:${this.submitCount}`,
      archiveMomentFingerprint: `world:archive-moment:${this.label}:${this.submitCount}`,
      archiveSealFingerprint: `world:archive-seal:${this.label}:${this.submitCount}`,
      status: 'completed',
    };
  }
}

class SequencedCliWorker extends WorldWorker {
  constructor(sequence) {
    super();
    this.sequence = [...sequence];
    this.index = 0;
  }

  async submitTurn(turnInputBytes) {
    assert.equal(turnInputBytes.byteLength > 0, true);
    const next = this.sequence[this.index];
    this.index += 1;
    if (!next) throw new Error('sequence exhausted');
    return {
      turnClosureBytes: fixtureTurnClosureBytes(next),
    };
  }
}

class DecodableCliWorker extends WorldWorker {
  constructor(options = {}) {
    super();
    this.options = options;
  }

  async submitTurn(turnInputBytes) {
    assert.equal(turnInputBytes.byteLength > 0, true);
    this.submittedTurnInputBytes = turnInputBytes;
    return {
      turnClosureBytes: fixtureTurnClosureBytes({
        status: this.options.status,
        turnSequenceNumber: this.options.turnSequenceNumber ?? 0n,
      }),
      turnClosureWorldFingerprint: 'world:closure:decodable',
      resultingStateFingerprint: 'world:state:decodable',
      chronicleCursor: 'world:chronicle:decodable',
      archiveMomentFingerprint: 'world:archive-moment:decodable',
      archiveSealFingerprint: 'world:archive-seal:decodable',
      status: 'completed',
    };
  }
}

async function bytesToUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

function fixtureTurnClosureBytes(options = {}) {
  const closureStatus = options.status ?? 2;
  const manifestFingerprint = options.manifestFingerprint ?? 0x211n;
  const rootResultBytes = rootResultValueBytes(options.rootResultValueFingerprint ?? 0xb01n);
  const rootResultRef = rootResultObjectRef(rootResultBytes);
  const turnReceiptBytes = concat([
    u32(1),
    u32(1),
    u64(0x701n),
    u64(manifestFingerprint),
    u64(options.turnSequenceNumber ?? 1n),
    u64(0x301n),
    optionalU64(null),
    u64Slice(options.appliedHostReplyFingerprints ?? []),
    u64Slice([]),
    optionalU64(null),
    u64(0x501n),
    optionalU64(0xa00n),
    optionalU64(0xa01n),
    optionalU64(0xa02n),
    optionalU64(options.chronicleResultingCursorFingerprint ?? 0x304n),
    optionalU64(0xb01n),
    u8(receiptStatusForClosureStatus(closureStatus)),
    optionalU64(null),
    u64(0n),
    u64(0n),
  ]);
  return concat([
    u32(1),
    u32(1),
    u64(options.closureFingerprint ?? 0x111n),
    u64(0x112n),
    u64(manifestFingerprint),
    optionalU64(null),
    u64(options.turnSequenceNumber ?? 1n),
    u64(0x301n),
    u64(options.resultingStateFingerprint ?? 0x302n),
    u64(0x303n),
    u64(options.chronicleResultingCursorFingerprint ?? 0x304n),
    optionalU64(null),
    optionalU64(null),
    optionalU64(0xa01n),
    optionalU64(0xa02n),
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

function receiptStatusForClosureStatus(status) {
  if (status === 0) return 0;
  if (status === 1) return 3;
  if (status === 2) return 1;
  if (status === 3) return 2;
  if (status === 4) return 4;
  if (status === 5) return 5;
  return status;
}

function fixtureNeedsHostTurnClosureBytes(requests = [fixtureHostRequestBytes()], status = 0, options = {}) {
  const manifestFingerprint = options.manifestFingerprint ?? 0x211n;
  const turnReceiptBytes = concat([
    u32(1),
    u32(1),
    u64(0x701n),
    u64(manifestFingerprint),
    u64(0n),
    u64(0x301n),
    optionalU64(null),
    u64Slice([]),
    u64Slice(requests.map(fixtureHostRequestFingerprint)),
    optionalU64(null),
    u64(0x501n),
    optionalU64(null),
    optionalU64(null),
    optionalU64(null),
    optionalU64(0x304n),
    optionalU64(null),
    u8(receiptStatusForClosureStatus(status)),
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
    u64(manifestFingerprint),
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
    u8(status),
  ]);
}

function encodeLegacyAgentRuntimePayload({ commandFingerprint, bindingFingerprint, worldPortId, rootArgumentImageBytes }) {
  return concat([
    bytes(fromUtf8('world.appliance.payload_value_image.v1')),
    u64(commandFingerprint),
    u64(bindingFingerprint),
    u32(worldPortId),
    bytes(rootArgumentImageBytes),
  ]);
}

function encodeAgentRuntimeFrameRequest({ commandFingerprint, bindingFingerprint, worldPortId }) {
  return concat([
    bytes(fromUtf8('world.appliance.frame_request.v1')),
    u64(0xa01n),
    u64(commandFingerprint),
    u64(0),
    u64(0),
    u32(worldPortId),
    u64(bindingFingerprint),
    u64(0xa20n),
    u64(0xa21n),
    u64(0xa22n),
  ]);
}

function fixtureHostRequestFingerprint(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getBigUint64(8, true);
}

function fixtureHostRequestBytes() {
  return concat([
    u32(4),
    u32(4),
    u64(0xa01n),
    u64(0n),
    u32(0),
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
    u64(0xa0bn),
    u64(0xa09n),
    optionalU64(null),
    bytes(fromUtf8('metadata')),
    bytes(fromUtf8('frame')),
    bytes(fromUtf8('payload')),
    optionalU64(0xa0cn),
    optionalU64(0xa0dn),
    optionalU64(0xa0en),
    optionalU64(0xa0fn),
    bytes(fromUtf8('prepared')),
    bytes(fromUtf8('idempotency-key')),
  ]);
}

function agentModelHostRequestBytes() {
  return concat([
    u32(4),
    u32(4),
    u64(0xa17n),
    u64(0n),
    u32(0),
    u64(0xa18n),
    u64(0xa19n),
    u32(0),
    u64(0xa20n),
    u64(0xa21n),
    u64(0x4f0c7160f25c4c62n),
    u8(2),
    u8(1),
    u64(0xa22n),
    u64(0xa23n),
    u64(0xa24n),
    u64(0xbe73177924a6b377n),
    u64(0xa25n),
    optionalU64(null),
    bytes(fromUtf8('metadata')),
    bytes(fromUtf8('frame')),
    bytes(encodeCanonicalValueImage({
      bytes: fromUtf8(JSON.stringify({
        schema: 'boundary.Agent.DecisionPrompt.v0',
        observation: 'goal=invoke',
      })),
      dynamicSize: true,
    })),
    optionalU64(null),
    optionalU64(null),
    optionalU64(null),
    optionalU64(null),
    bytes(fromUtf8('prepared')),
    bytes(fromUtf8('agent-model-idempotency-key')),
  ]);
}

function blobEntryForBytes(value) {
  return {
    checksum: createHash('sha256').update(value).digest('hex'),
    byteLength: value.byteLength,
    bytes: [...value],
  };
}

function carrierExportWithPendingHead(carrierExport, closureBytes) {
  const summary = summarizeTurnClosureForRunHead(closureBytes);
  const blob = blobEntryForBytes(closureBytes);
  return {
    ...carrierExport,
    bundle: {
      ...carrierExport.bundle,
      head: {
        ...carrierExport.bundle.head,
        generation: summary.inspectionDiagnostics.turnSequenceNumber + 1,
        status: summary.status,
        turnClosureRef: {
          algorithm: 'sha256',
          checksum: blob.checksum,
          byteLength: blob.byteLength,
        },
        turnClosureWorldFingerprint: summary.turnClosureWorldFingerprint,
        resultingStateFingerprint: summary.resultingStateFingerprint,
        chronicleCursor: summary.chronicleCursor,
        archiveMomentFingerprint: summary.archiveMomentFingerprint,
        archiveSealFingerprint: summary.archiveSealFingerprint,
      },
      blobs: [...carrierExport.bundle.blobs, blob],
    },
  };
}

function carrierBundleApplianceManifest(bundle) {
  const manifestRef = bundle.application.applianceManifestRef;
  const manifestBlob = bundle.blobs.find((blob) =>
    blob.checksum === manifestRef.checksum && blob.byteLength === manifestRef.byteLength);
  assert.ok(Array.isArray(manifestBlob?.bytes));
  return decodeApplianceManifest(Uint8Array.from(manifestBlob.bytes));
}

function u8(value) {
  return Uint8Array.of(value);
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u16(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

function optionalU64(value) {
  return value === null ? u8(0) : concat([u8(1), u64(value)]);
}

function bytes(value) {
  return concat([u32(value.byteLength), value]);
}

function u64Slice(values) {
  return concat([u64(values.length), ...values.map(u64)]);
}

function u8Slice(values) {
  return concat([u64(values.length), Uint8Array.from(values)]);
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
    u64(options.supervisionPolicyFingerprint ?? 0n),
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

function fixtureHostReplyFingerprint(binding, resolutionInputBytes) {
  const request = {
    requestFingerprint: fingerprintValue(binding.requestFingerprint),
    intentFingerprint: fingerprintValue(binding.intentFingerprint),
    envelopeFingerprint: fingerprintValue(binding.envelopeFingerprint),
    idempotencyKeyFingerprint: fingerprintValue(binding.idempotencyKeyFingerprint),
  };
  const resolution = decodeResolutionInputBytes(resolutionInputBytes);
  const responseFingerprint = resolution.status === 0 ? fixtureValueImageFingerprint(resolution.responseValueImageBytes) : null;
  const responseKind = resolution.status === 0 ? 1n : 0n;
  const outcomeFingerprint = nonzero(wyhash64(concat([
    replyHashBytes(fromUtf8('world.appliance.host_outcome.fingerprint')),
    u64(1n),
    u64(1n),
    u64(request.requestFingerprint),
    u64(request.intentFingerprint),
    u64(request.envelopeFingerprint),
    u64(request.idempotencyKeyFingerprint),
    u64(resolution.status),
    replyOptionalU64(responseFingerprint),
    u64(responseKind),
    replyHashBytes(resolution.responseValueImageBytes),
    replyOptionalU64(null),
    replyHashBytes(resolution.hostClaimBytes),
    u64(resolution.attemptNumber),
    replyHashBytes(resolution.metadata),
  ])));
  return nonzero(wyhash64(concat([
    replyHashBytes(fromUtf8('world.appliance.host_reply.fingerprint')),
    u64(1n),
    u64(1n),
    u64(request.requestFingerprint),
    u64(outcomeFingerprint),
    replyOptionalU64(null),
    u64(0n),
    replyHashBytes(resolution.metadata),
  ])));
}

function fingerprintValue(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  const bare = String(value).includes(':') ? String(value).slice(String(value).lastIndexOf(':') + 1) : String(value).replace(/^0x/i, '');
  return BigInt(`0x${bare}`);
}

function fixtureValueImageFingerprint(value) {
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return (BigInt(view.getUint32(12, true)) << 32n) | BigInt(view.getUint32(8, true));
}

function replyHashBytes(value) {
  return concat([u64(value.byteLength), value]);
}

function replyOptionalU64(value) {
  return value == null ? u64(0n) : concat([u64(1n), u64(value)]);
}

function nonzero(value) {
  return value === 0n ? 1n : value;
}

function byteSlices(values) {
  return concat([u64(values.length), ...values.map(bytes)]);
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

function concat(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fixtureStore() {
  const store = new MemoryStore();
  const imageRef = await store.putBlob(fromUtf8('image'));
  const wasmRef = await store.putBlob(fromUtf8('wasm'));
  const manifestRef = await store.putBlob(fromUtf8('manifest'));
  const closureRef = await store.putBlob(fromUtf8('closure'));
  const app = createApplicationRecord({
    applicationId: 'app',
    universalWasmChecksum: `sha256:${wasmRef.checksum}`,
    universalWasmByteLength: wasmRef.byteLength,
    worldProtocolVersion: 'v0.1.0',
    applianceAbiVersion: 'v4',
    executableImageRef: imageRef,
    executableImageWorldFingerprint: 'world:image',
    applianceManifestRef: manifestRef,
    requiredActuators: [],
    requiredRuntimeLimits: {},
    installationDiagnostics: { manifestSource: 'host-generated-install-summary' },
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

async function fixtureDirectoryStore(root, options = {}) {
  const store = new DirectoryStore(root);
  await store.acquireLock();
  try {
    const imageRef = await store.putBlob(fromUtf8('image'));
    const wasmRef = await store.putBlob(fromUtf8('wasm'));
    const manifestRef = await store.putBlob(options.manifestBytes ?? fixtureApplianceManifestBytes({ manifestFingerprint: 0x211n }));
    const closureBytes = fixtureTurnClosureBytes(options.closureOptions);
    const closureSummary = summarizeTurnClosureForRunHead(closureBytes);
    const closureRef = await store.putBlob(closureBytes);
    const app = createApplicationRecord({
      applicationId: 'directory-app',
      universalWasmChecksum: `sha256:${wasmRef.checksum}`,
      universalWasmByteLength: wasmRef.byteLength,
      worldProtocolVersion: 'v0.1.0',
      applianceAbiVersion: 'v4',
      executableImageRef: imageRef,
      executableImageWorldFingerprint: 'world:image:directory',
      applianceManifestRef: manifestRef,
      requiredActuators: [],
      requiredRuntimeLimits: {},
      installationDiagnostics: { manifestSource: 'host-generated-install-summary' },
    });
    await store.createApplication(app);
    const head = createRunHead({
      generation: closureSummary.inspectionDiagnostics.turnSequenceNumber + 1,
      turnClosureRef: closureRef,
      turnClosureWorldFingerprint: closureSummary.turnClosureWorldFingerprint,
      resultingStateFingerprint: closureSummary.resultingStateFingerprint,
      chronicleCursor: closureSummary.chronicleCursor,
      archiveMomentFingerprint: closureSummary.archiveMomentFingerprint,
      archiveSealFingerprint: closureSummary.archiveSealFingerprint,
      status: closureSummary.status,
      updateDiagnostics: {
        parentTurnClosureFingerprint: 'world:closure:parent',
        committedEffectIds: ['world:key:cli'],
      },
    });
    const run = createRunRecord({
      runId: 'directory-run',
      applicationId: app.applicationId,
      branches: [createBranchRecord({ branchId: 'main', currentHead: head })],
      effectJournalNamespace: 'directory-run:effects',
    });
    await store.createRun(run);
    const journal = new EffectJournal({
      store,
      runId: run.runId,
      branchId: 'main',
      parentTurnClosureFingerprint: 'world:closure:parent',
    });
    const resolved = await journal.resolve({}, {
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture',
      actuationClass: 'fixture',
      responseSchema: { status: 'ok' },
      idempotencyKeyBytes: fromUtf8('complete-world-idempotency-key'),
      idempotencyKeyWorldFingerprint: 'world:key:cli',
      requestBytes: fromUtf8('request:cli'),
      hostRequestFingerprint: 'world:host-request:0000000000000a01',
    }, fixtureDriver());
    if (options.effectState === 'submitted') {
      await journal.markSubmitted(resolved.record);
    } else {
      await journal.markClosureCommitted(resolved.record);
    }
    return { run, head };
  } finally {
    await store.releaseLock();
  }
}

async function assertImportsReject(bundle, code) {
  await assert.rejects(() => new MemoryStore().importRun(JSON.parse(JSON.stringify(bundle))), { code });
  const root = await mkdtemp(path.join(tmpdir(), 'world-host-import-reject-'));
  try {
    const directory = new DirectoryStore(root);
    const rejected = JSON.parse(JSON.stringify(bundle));
    await assert.rejects(() => directory.importRun(rejected), { code });
    if (rejected.application) await assert.rejects(() => directory.getApplication(rejected.application.applicationId), { code: 'ERR_APPLICATION_NOT_FOUND' });
    await assert.rejects(() => directory.getRun(rejected.run.runId), { code: 'ERR_RUN_NOT_FOUND' });
    await assert.rejects(() => directory.readHead(rejected.run.runId, rejected.branchId), { code: 'ERR_HEAD_NOT_FOUND' });
    const firstImportedBlob = rejected.blobs?.find((blob) => Array.isArray(blob.bytes));
    if (firstImportedBlob) {
      assert.equal(await directory.hasBlob({ algorithm: 'sha256', checksum: firstImportedBlob.checksum, byteLength: firstImportedBlob.byteLength }), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fixtureImportEffect(bundle, overrides = {}) {
  return {
    runId: bundle.run.runId,
    branchId: bundle.branchId,
    parentTurnClosureFingerprint: 'world:closure:parent',
    hostRequestFingerprint: 'world:host-request:0000000000000001',
    idempotencyKey: { format: 'world-idempotency-key-bytes.hex', bytesHex: '00' },
    idempotencyKeyWorldFingerprint: 'world:key:import-fixture',
    actuatorRef: 'fixture:model',
    descriptorFingerprint: 'descriptor:fixture',
    actuationClass: 'fixture',
    responseSchema: { status: 'ok' },
    requestBytesChecksum: 'sha256:fixture',
    state: 'observed',
    attemptCount: 0,
    driverRecoveryClass: 'pure',
    diagnostics: {},
    ...overrides,
  };
}

function decodeValueImageResponseRefs(bytes) {
  let offset = 0;
  const view = (length) => {
    const result = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
    offset += length;
    return result;
  };
  const u8 = () => view(1).getUint8(0);
  const u32 = () => view(4).getUint32(0, true);
  const u64 = () => view(8).getBigUint64(0, true);
  const optionalU32 = () => (u8() === 1 ? u32() : null);
  const optionalU64 = () => (u8() === 1 ? u64() : null);
  assert.equal(u32(), 1);
  assert.equal(u32(), 1);
  u64();
  optionalU32();
  return {
    boundaryValueFingerprint: fingerprintHex(optionalU64()),
    codecSchemaDescriptorFingerprint: fingerprintHex(optionalU64()),
  };
}

function fingerprintHex(value) {
  return value == null ? null : `0x${value.toString(16).padStart(16, '0')}`;
}

function fixtureDriver() {
  return {
    manifest() {
      return {
        driverId: 'cli-fixture',
        supportedActuatorRefs: ['fixture:model'],
        supportedDescriptorFingerprints: ['descriptor:fixture'],
        supportedActuationClasses: ['fixture'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024,
        maximumResponseBytes: 1024,
        recoveryClass: 'idempotent',
        concurrencyLimit: 1,
        authorityLabels: ['fixture'],
      };
    },
    async resolve(_context, hostRequest) {
      return { resolutionInputBytes: fixtureResolutionInputBytes(hostRequest, fromUtf8('resolution:cli')) };
    },
  };
}

function fixtureResolutionInputBytes(hostRequest, responseValueImageBytes) {
  return encodeResolutionInputBytes({
    targetHostRequestFingerprint: requestTargetFingerprint(hostRequest),
    status: 0,
    responseValueImageBytes,
    hostClaimBytes: new Uint8Array(),
    attemptNumber: 1,
    metadata: new Uint8Array(),
  });
}

function requestTargetFingerprint(hostRequest) {
  const value = hostRequest.hostRequestFingerprint;
  if (typeof value === 'bigint' || typeof value === 'number') return BigInt(value);
  const match = String(value ?? '').match(/(?:0x)?([0-9a-f]+)$/i);
  return BigInt(`0x${match[1]}`);
}
