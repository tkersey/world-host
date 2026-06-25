import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createApplicationRecord } from '../src/core/application.mjs';
import { EffectJournal } from '../src/core/effect_journal.mjs';
import { exportCarrierRun, forkRunBranch, importCarrierRun } from '../src/core/migration.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../src/core/run.mjs';
import { fromUtf8 } from '../src/core/store.mjs';
import { WorldWorker } from '../src/core/worker.mjs';
import { redact, runNodeCli } from '../src/node/node_cli.mjs';
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
    await assert.rejects(() => forkRunBranch(store, {
      runId: run.runId,
      sourceBranchId: 'main',
      sourceClosureFingerprint: head.turnClosureWorldFingerprint,
      newBranchId: 'alternate',
    }), { code: 'ERR_BRANCH_EXISTS' });
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
    const corrupt = JSON.parse(JSON.stringify(carrierExport.bundle));
    corrupt.blobs[0].byteLength += 1;
    await assert.rejects(() => new MemoryStore().importRun(corrupt), { code: 'ERR_IMPORT_BLOB_CHECKSUM_MISMATCH' });
  });

  it('redacts credentials from CLI-shaped diagnostics', async () => {
    assert.equal(redact({ nested: { bearerToken: 'secret' } }).nested.bearerToken, '[redacted]');
    let output = '';
    const code = await runNodeCli(['inspect', '--json', '--store', '.world-carrier'], { stdout: { write: (text) => { output += text; } }, stderr: { write() {} } });
    assert.equal(code, 0);
    assert.match(output, /"command": "inspect"/);
    assert.doesNotMatch(output, /secret|bearer/i);
  });

  it('installs DirectoryStore application records from immutable CLI bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-cli-install-'));
    try {
      const wasmPath = path.join(root, 'world_universal_appliance.wasm');
      const imagePath = path.join(root, 'file-agent.world-executable');
      await writeFile(wasmPath, fromUtf8('wasm:install'));
      await writeFile(imagePath, fromUtf8('image-bytes-install'));

      let output = '';
      const installCode = await runNodeCli([
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
      const code = await runNodeCli([
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
    try {
      const wasmPath = path.join(root, 'world_universal_appliance.wasm');
      const imagePath = path.join(root, 'file-agent.world-executable');
      await writeFile(wasmPath, fromUtf8('wasm:cli-run'));
      await writeFile(imagePath, fromUtf8('image:cli-run'));
      await runNodeCli([
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
      const runCode = await runNodeCli([
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
      assert.equal(ran.advance.workerStatus, 'warm');
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
        assert.deepEqual([...await store.getBlob(head.turnClosureRef)], [...fromUtf8('closure-bytes:run:1')]);
      } finally {
        await store.releaseLock();
      }

      output = '';
      const createOnlyCode = await runNodeCli([
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

      output = '';
      const resumeWorker = new DecodableCliWorker();
      const resumeCode = await runNodeCli([
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
        assert.deepEqual([...await store.getBlob(head.turnClosureRef)], [...fixtureTurnClosureBytes()]);
      } finally {
        await store.releaseLock();
      }

      output = '';
      const secondResumeWorker = new DeterministicCliWorker('resume-second');
      const secondResumeCode = await runNodeCli([
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
        universalWasmChecksum: 'sha256:00',
        executableImageWorldFingerprint: 'world:image',
      };
      await assert.rejects(() => store.createApplication(app), { code: 'ERR_STORE_ID_PATH_UNSAFE' });
      await assert.rejects(() => store.getRun('bad/run'), { code: 'ERR_STORE_ID_PATH_UNSAFE' });
      await assert.rejects(() => store.readHead('run', 'bad/branch'), { code: 'ERR_STORE_ID_PATH_UNSAFE' });
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
      let output = '';
      const inspectCode = await runNodeCli(['inspect', '--json', '--store', root, '--run', run.runId, '--branch', 'main'], {
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
      const effectsCode = await runNodeCli(['effects', '--json', '--store', root, '--run', run.runId], {
        stdout: { write: (text) => { output += text; } },
        stderr: { write() {} },
      });
      const effects = JSON.parse(output);

      assert.equal(effectsCode, 0);
      assert.equal(effects.effects.length, 1);
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
      const recoverCode = await runNodeCli(['recover', '--json', '--store', root, '--run', run.runId, '--branch', 'main'], {
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

  it('exports, imports, and forks DirectoryStore runs through redacted CLI operations', async () => {
      const sourceRoot = await mkdtemp(path.join(tmpdir(), 'world-host-cli-migrate-source-'));
      const receiverRoot = await mkdtemp(path.join(tmpdir(), 'world-host-cli-migrate-receiver-'));
      const packagePath = path.join(receiverRoot, 'carrier-export.json');
      let unrelatedRef = null;
      try {
      const { run, head } = await fixtureDirectoryStore(sourceRoot);
      let output = '';
      const forkCode = await runNodeCli([
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
        }, fixtureDriver());
        unrelatedRef = await sourceStore.putBlob(fromUtf8('unrelated-secret'));
      } finally {
        await sourceStore.releaseLock();
      }

      output = '';
      const exportCode = await runNodeCli([
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
      assert.equal(packageJson.bundle.blobs.some((blob) => blob.checksum === unrelatedRef.checksum), false);
      assert.equal(packageJson.bundle.effects.every((effect) => effect.branchId === 'main'), true);
      assert.doesNotMatch(output, /bytesHex|complete-world-idempotency-key/);

      output = '';
      const importCode = await runNodeCli([
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
        assert.deepEqual([...await receiverStore.getBlob(receiverHead.turnClosureRef)], [...fromUtf8('closure')]);
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

      const receiverStore = new DirectoryStore(receiverRoot);
      await receiverStore.acquireLock();
      try {
        await receiverStore.importRun(carrierExport.bundle);
        await assert.rejects(() => receiverStore.importRun(carrierExport.bundle), { code: 'ERR_IMPORT_RUN_EXISTS' });
      } finally {
        await receiverStore.releaseLock();
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

  it('propagates executable CLI return codes to the process', () => {
    const result = spawnSync(process.execPath, [path.resolve('bin/world-host.mjs'), 'run-example', 'missing-example'], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown example: missing-example/);
  });
});

class DeterministicCliWorker extends WorldWorker {
  constructor(label) {
    super();
    this.label = label;
    this.submitCount = 0;
  }

  async submitTurn(turnInputBytes) {
    assert.equal(turnInputBytes.byteLength > 0, true);
    this.submitCount += 1;
    this.lastTurnClosureBytes = fromUtf8(`closure-bytes:${this.label}:${this.submitCount}`);
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

class DecodableCliWorker extends WorldWorker {
  async submitTurn(turnInputBytes) {
    assert.equal(turnInputBytes.byteLength > 0, true);
    return {
      turnClosureBytes: fixtureTurnClosureBytes(),
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

async function fixtureDirectoryStore(root, options = {}) {
  const store = new DirectoryStore(root);
  await store.acquireLock();
  try {
    const imageRef = await store.putBlob(fromUtf8('image'));
    const manifestRef = await store.putBlob(fromUtf8('manifest'));
    const closureRef = await store.putBlob(fromUtf8('closure'));
    const app = createApplicationRecord({
      applicationId: 'directory-app',
      universalWasmChecksum: 'sha256:fixture',
      worldProtocolVersion: 'v0.1.0',
      applianceAbiVersion: 'v3',
      executableImageRef: imageRef,
      executableImageWorldFingerprint: 'world:image:directory',
      applianceManifestRef: manifestRef,
      requiredActuators: [],
      requiredRuntimeLimits: {},
    });
    await store.createApplication(app);
    const head = createRunHead({
      generation: 1,
      turnClosureRef: closureRef,
      turnClosureWorldFingerprint: 'world:closure:directory',
      resultingStateFingerprint: 'world:state:directory',
      chronicleCursor: 'cursor:directory',
      archiveMomentFingerprint: 'archive:moment:directory',
      archiveSealFingerprint: 'archive:seal:directory',
      status: 'completed',
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
    async resolve() {
      return { resolutionInputBytes: fromUtf8('resolution:cli') };
    },
  };
}
