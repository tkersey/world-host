import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createApplicationRecord } from '../src/core/application.mjs';
import { EffectJournal } from '../src/core/effect_journal.mjs';
import { exportCarrierRun, forkRunBranch, importCarrierRun } from '../src/core/migration.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../src/core/run.mjs';
import { fromUtf8, stableJson } from '../src/core/store.mjs';
import { RunController, WorldWorker } from '../src/core/worker.mjs';
import { BunStoreLock } from '../src/bun/bun_lock.mjs';
import { redact, runBunCli } from '../src/bun/bun_cli.mjs';
import { encodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';
import { summarizeTurnClosureForRunHead } from '../src/protocol/world_universal_appliance_codec.mjs';
import { DirectoryStore } from '../src/stores/directory_store.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';

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
      const { run, head } = await fixtureDirectoryStore(root, { closureOptions: { status: 0 } });
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
      assert.equal((await store.readHead(run.runId, 'historic')).generation, head.generation);
      assert.equal((await store.readHead(run.runId, 'main')).turnClosureWorldFingerprint, advancedHead.turnClosureWorldFingerprint);
      assert.equal((await store.getRun(run.runId)).branches.some((item) => item.branchId === 'historic'), true);

      const controller = new RunController({ store, workerFactory: async () => new DeterministicCliWorker('historic', { startSequence: 2n }) });
      const advancedHistoric = await controller.advance(run.runId, 'historic');
      assert.equal(advancedHistoric.status, 'advanced');
      assert.equal(advancedHistoric.nextHead.generation, head.generation + 1);
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
        worldProtocolVersion: 'v0.1.0',
        applianceAbiVersion: 'v3',
        executableImageRef: otherImageRef,
        executableImageWorldFingerprint: 'world:image:other-directory',
        applianceManifestRef: otherManifestRef,
        requiredActuators: [],
        requiredRuntimeLimits: {},
        installationDiagnostics: {
          wasmByteLength: otherWasmRef.byteLength,
        },
      });
      await store.createApplication(otherApp);
      const otherHead = createRunHead({
        generation: 1,
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('forks a sequence-zero boot closure after the branch advances again', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-sequence-zero-fork-'));
    try {
      const store = new DirectoryStore(root);
      const imageRef = await store.putBlob(fromUtf8('image'));
      const manifestRef = await store.putBlob(fromUtf8('manifest'));
      const genesisRef = await store.putBlob(fromUtf8('genesis'));
      const app = createApplicationRecord({
        applicationId: 'sequence-zero-app',
        universalWasmChecksum: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        worldProtocolVersion: 'v0.1.0',
        applianceAbiVersion: 'v3',
        executableImageRef: imageRef,
        executableImageWorldFingerprint: 'world:image:sequence-zero',
        applianceManifestRef: manifestRef,
        requiredActuators: [],
        requiredRuntimeLimits: {},
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
        { closureFingerprint: 0x901n, turnSequenceNumber: 1n, resultingStateFingerprint: 0x911n, chronicleResultingCursorFingerprint: 0x921n },
      ]);
      const controller = new RunController({ store, workerFactory: async () => worker });
      const bootAdvance = await controller.advance(run.runId, 'main');
      const secondAdvance = await controller.advance(run.runId, 'main');

      assert.equal(bootAdvance.nextHead.generation, 1);
      assert.equal(bootAdvance.nextHead.updateDiagnostics.inspectedTurnClosure.turnSequenceNumber, 0);
      assert.equal(secondAdvance.status, 'advanced');

      const branch = await forkRunBranch(store, {
        runId: run.runId,
        sourceBranchId: 'main',
        sourceClosureFingerprint: bootAdvance.nextHead.turnClosureWorldFingerprint,
        newBranchId: 'boot',
      });

      assert.equal(branch.forkedFromTurnClosureFingerprint, bootAdvance.nextHead.turnClosureWorldFingerprint);
      assert.equal((await store.readHead(run.runId, 'boot')).generation, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
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

  it('does not unlink a replacement store lock after stale break acquisition', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-lock-'));
    const lockPath = path.join(root, 'store.lock');
    const staleOwner = new BunStoreLock(lockPath);
    const replacement = new BunStoreLock(lockPath);
    const contender = new BunStoreLock(lockPath);
    const afterRelease = new BunStoreLock(lockPath);
    try {
      await staleOwner.acquire();
      await replacement.acquire({ breakStale: true });
      await staleOwner.release();
      await assert.rejects(() => contender.acquire(), { code: 'EEXIST' });
      await replacement.release();
      await afterRelease.acquire();
    } finally {
      await afterRelease.release();
      await contender.release();
      await replacement.release();
      await staleOwner.release();
      await rm(root, { recursive: true, force: true });
    }
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

  it('exports and imports with receiver-local run id and no authority transfer', async () => {
    const source = await fixtureStore();
    await forkRunBranch(source.store, {
      runId: source.run.runId,
      sourceBranchId: 'main',
      sourceClosureFingerprint: source.head.turnClosureWorldFingerprint,
      newBranchId: 'alternate',
    });
    const carrierExport = await exportCarrierRun(source.store, source.run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
    const receiver = new MemoryStore();
    const imported = await importCarrierRun(receiver, carrierExport, { runId: 'receiver-run', preflight: async () => ({ blockers: [] }) });
    assert.equal(imported.run.runId, 'receiver-run');
    assert.equal(imported.authorityImported, false);
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

  it('redacts credentials from CLI-shaped diagnostics', async () => {
    assert.equal(redact({ nested: { bearerToken: 'secret' } }).nested.bearerToken, '[redacted]');
    assert.equal(redact({ diagnostics: { apiKey: 'secret' } }).diagnostics.apiKey, '[redacted]');
    assert.equal(redact({ diagnostics: { access_key: 'secret' } }).diagnostics.access_key, '[redacted]');
    assert.equal(redact({ diagnostics: { privateKey: 'secret' } }).diagnostics.privateKey, '[redacted]');
    assert.equal(redact({ diagnostics: { error: 'driver failed with bearer token sk-test-secret' } }).diagnostics.error, '[redacted]');
    let output = '';
    const code = await runBunCli(['inspect', '--json'], { stdout: { write: (text) => { output += text; } }, stderr: { write() {} } });
    assert.equal(code, 0);
    assert.match(output, /"command": "inspect"/);
    assert.doesNotMatch(output, /secret|bearer/i);
    await assert.rejects(
      () => runBunCli(['inspect', '--json', '--store', '.world-carrier'], { stdout: { write() {} }, stderr: { write() {} } }),
      /missing required option: --run/,
    );
    await assert.rejects(
      () => runBunCli(['effects', '--json', '--store', '.world-carrier'], { stdout: { write() {} }, stderr: { write() {} } }),
      /missing required option: --run/,
    );
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
        assert.equal(app.worldProtocolVersion, 'v0.1.0');
        assert.equal(app.applianceAbiVersion, 'v3');
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
      await writeFile(wasmPath, fromUtf8('wasm:cli-run'));
      await writeFile(imagePath, fromUtf8('image:cli-run'));
      await runBunCli([
        'install',
        '--json',
        '--store', root,
        '--name', 'run-app',
        '--wasm', wasmPath,
        '--image', imagePath,
        '--image-fingerprint', 'world:image:run-app',
      ], {
        stdout: { write() {} },
        stderr: { write() {} },
      });

      let output = '';
      const runWorker = new DeterministicCliWorker('run');
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
          generation: 0,
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
      assert.equal(zeroResumed.head.generation, 1);
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
        applianceAbiVersion: 'v3',
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
        await receiverStore.createApplication(bundle.application);
        await receiverStore.createRun(bundle.run);
        assert.equal((await receiverStore.listEffectRecords(run.runId)).length, 0);

        await assert.rejects(() => receiverStore.importRun(bundle), { code: 'ERR_IMPORT_RUN_EXISTS' });
        assert.equal((await receiverStore.listEffectRecords(run.runId)).length, 0);
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
      await assert.rejects(
        () => runBunCli([
          'import',
          '--json',
          '--store', receiverRoot,
          '--package', blockedPackagePath,
          '--run', 'blocked-run',
        ], {
          stdout: { write() {} },
          stderr: { write() {} },
        }),
        { code: 'ERR_IMPORT_PREFLIGHT_BLOCKED' },
      );
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
    this.submitCount = 0;
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
  const turnReceiptBytes = concat([
    u32(1),
    u32(1),
    u64(0x701n),
    u64(0x211n),
    u64(options.turnSequenceNumber ?? 1n),
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
    u8(options.status ?? 2),
    optionalU64(null),
    u64(0n),
    u64(0n),
  ]);
  return concat([
    u32(1),
    u32(1),
    u64(options.closureFingerprint ?? 0x111n),
    u64(0x112n),
    u64(0x211n),
    optionalU64(null),
    u64(options.turnSequenceNumber ?? 1n),
    u64(0x301n),
    u64(options.resultingStateFingerprint ?? 0x302n),
    u64(0x303n),
    u64(options.chronicleResultingCursorFingerprint ?? 0x304n),
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
    u8(options.status ?? 2),
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

function blobEntryForBytes(value) {
  return {
    checksum: createHash('sha256').update(value).digest('hex'),
    byteLength: value.byteLength,
    bytes: [...value],
  };
}

function u8(value) {
  return Uint8Array.of(value);
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
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

function byteSlices(values) {
  return concat([u64(values.length), ...values.map(bytes)]);
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
  const manifestRef = await store.putBlob(fromUtf8('manifest'));
  const closureRef = await store.putBlob(fromUtf8('closure'));
  const app = createApplicationRecord({
    applicationId: 'app',
    universalWasmChecksum: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
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

async function fixtureDirectoryStore(root, options = {}) {
  const store = new DirectoryStore(root);
  await store.acquireLock();
  try {
    const imageRef = await store.putBlob(fromUtf8('image'));
    const wasmRef = await store.putBlob(fromUtf8('wasm'));
    const manifestRef = await store.putBlob(fromUtf8('manifest'));
    const closureBytes = fixtureTurnClosureBytes(options.closureOptions);
    const closureSummary = summarizeTurnClosureForRunHead(closureBytes);
    const closureRef = await store.putBlob(closureBytes);
    const app = createApplicationRecord({
      applicationId: 'directory-app',
      universalWasmChecksum: `sha256:${wasmRef.checksum}`,
      worldProtocolVersion: 'v0.1.0',
      applianceAbiVersion: 'v3',
      executableImageRef: imageRef,
      executableImageWorldFingerprint: 'world:image:directory',
      applianceManifestRef: manifestRef,
      requiredActuators: [],
      requiredRuntimeLimits: {},
      installationDiagnostics: {
        wasmByteLength: wasmRef.byteLength,
      },
    });
    await store.createApplication(app);
    const head = createRunHead({
      generation: 1,
      turnClosureRef: closureRef,
      turnClosureWorldFingerprint: closureSummary.turnClosureWorldFingerprint,
      resultingStateFingerprint: closureSummary.resultingStateFingerprint,
      chronicleCursor: closureSummary.chronicleCursor,
      archiveMomentFingerprint: closureSummary.archiveMomentFingerprint,
      archiveSealFingerprint: closureSummary.archiveSealFingerprint,
      status: closureSummary.status,
      updateDiagnostics: {
        parentTurnClosureFingerprint: 'world:closure:parent',
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
