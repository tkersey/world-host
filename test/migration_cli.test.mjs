import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  });

  it('exports and imports with receiver-local run id and no authority transfer', async () => {
    const source = await fixtureStore();
    const carrierExport = await exportCarrierRun(source.store, source.run.runId, 'main', { exportedAt: '2026-06-25T00:00:00Z' });
    const receiver = new MemoryStore();
    const imported = await importCarrierRun(receiver, carrierExport, { runId: 'receiver-run', preflight: async () => ({ blockers: [] }) });
    assert.equal(imported.run.runId, 'receiver-run');
    assert.equal(imported.authorityImported, false);
    assert.equal((await receiver.readHead('receiver-run', 'main')).turnClosureWorldFingerprint, source.head.turnClosureWorldFingerprint);
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
      const resumeWorker = new DeterministicCliWorker('resume');
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
        assert.deepEqual([...await store.getBlob(head.turnClosureRef)], [...fromUtf8('closure-bytes:resume:1')]);
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
        const effects = await store.listEffectRecords(run.runId);
        assert.equal(effects.length, 1);
        assert.equal(effects[0].state, 'closure_committed');
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

async function bytesToUtf8(bytes) {
  return new TextDecoder().decode(bytes);
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
