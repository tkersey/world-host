import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createApplicationRecord } from '../../src/core/application.mjs';
import { EffectJournal, EffectState } from '../../src/core/effect_journal.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../../src/core/run.mjs';
import { fromUtf8, stableJson } from '../../src/core/store.mjs';
import { SandboxFileDriver } from '../../src/drivers/sandbox_file_driver.mjs';
import { DirectoryStore } from '../../src/stores/directory_store.mjs';

const RUN_ID = 'file-agent-run';
const BRANCH_ID = 'main';
const APPLICATION_ID = 'file-agent';
const PARENT_CLOSURE_FINGERPRINT = 'world:turn-closure:file-agent:0';
const FINAL_CONTENT = 'world carrier updated the fixture';

export async function runExample() {
  const root = await mkdtemp(path.join(tmpdir(), 'world-host-file-agent-'));
  const storeRoot = path.join(root, 'carrier-store');
  const sandboxRoot = path.join(root, 'sandbox');
  let store = null;
  let restartedStore = null;
  try {
    await mkdir(sandboxRoot, { recursive: true });
    await writeFile(path.join(sandboxRoot, 'input.txt'), 'rewrite this file through the agent loop\n');
    store = new DirectoryStore(storeRoot);
    await store.acquireLock();

    const { parentHead } = await installFixtureRun(store);
    const { driver, counters } = countingSandboxDriver(sandboxRoot);
    const journal = new EffectJournal({
      store,
      runId: RUN_ID,
      branchId: BRANCH_ID,
      parentTurnClosureFingerprint: parentHead.turnClosureWorldFingerprint,
    });

    const read = await journal.resolve({}, fileRequest('read-input', {
      operation: 'read',
      path: 'input.txt',
    }), driver);
    const write = await journal.resolve({}, fileRequest('write-output', {
      operation: 'write',
      path: 'output.txt',
      content: FINAL_CONTENT,
    }), driver);
    const callsAfterWrite = counters.calls;
    const writeRetry = await journal.resolve({}, fileRequest('write-output', {
      operation: 'write',
      path: 'output.txt',
      content: FINAL_CONTENT,
    }), driver);

    const submittedRead = await journal.markSubmitted(read.record);
    const submittedWrite = await journal.markSubmitted(write.record);
    await journal.markClosureCommitted(submittedRead);
    await journal.markClosureCommitted(submittedWrite);

    const archiveAppendBatchRef = await store.putBlob(fromUtf8(stableJson({
      archiveAppendBatch: 'host-fixture-retained',
      effects: ['read-input', 'write-output'],
    })));
    const finalClosureBytes = fromUtf8(stableJson({
      turnClosure: 'host-fixture-final',
      parent: parentHead.turnClosureWorldFingerprint,
      output: FINAL_CONTENT,
      archiveAppendBatchChecksum: archiveAppendBatchRef.checksum,
    }));
    const finalClosureRef = await store.putBlob(finalClosureBytes);
    const finalHead = createRunHead({
      generation: 1,
      turnClosureRef: finalClosureRef,
      turnClosureWorldFingerprint: `world:turn-closure:file-agent:${sha256Hex(finalClosureBytes)}`,
      resultingStateFingerprint: `world:state:file-agent:${sha256Hex(fromUtf8(FINAL_CONTENT))}`,
      chronicleCursor: 'world:chronicle:file-agent:1',
      archiveMomentFingerprint: `world:archive-moment:file-agent:${archiveAppendBatchRef.checksum}`,
      archiveSealFingerprint: `world:archive-seal:file-agent:${archiveAppendBatchRef.checksum}`,
      status: 'completed',
      updateDiagnostics: {
        parentTurnClosureFingerprint: parentHead.turnClosureWorldFingerprint,
        archiveAppendBatchRef,
        hostFixtureOnly: true,
        worldSemanticEvidenceSource: 'node scripts/run-world-conformance.mjs --world-repo ../world',
      },
    });
    const cas = await store.compareAndSwapHead(RUN_ID, BRANCH_ID, parentHead.generation, finalHead);
    if (!cas.ok) throw new Error('file rewrite example head CAS failed');
    const committedEffects = await journal.list();
    const blobRefsBeforeRestart = await store.listBlobRefs();
    const output = await readFile(path.join(sandboxRoot, 'output.txt'), 'utf8');
    await store.releaseLock();
    store = null;

    restartedStore = new DirectoryStore(storeRoot);
    await restartedStore.acquireLock();
    const inspectedRun = await restartedStore.getRun(RUN_ID);
    const inspectedHead = await restartedStore.readHead(RUN_ID, BRANCH_ID);
    const inspectedEffects = await restartedStore.listEffectRecords(RUN_ID);
    const inspectedClosureBytes = await restartedStore.getBlob(inspectedHead.turnClosureRef);
    const inspectedArchiveBytes = await restartedStore.getBlob(inspectedHead.updateDiagnostics.archiveAppendBatchRef);
    const outputAfterRestart = await readFile(path.join(sandboxRoot, 'output.txt'), 'utf8');
    await restartedStore.releaseLock();
    restartedStore = null;

    return {
      example: 'file-rewrite-agent',
      completed: inspectedHead.status === 'completed' && outputAfterRestart === FINAL_CONTENT,
      output,
      outputAfterRestart,
      finalOutputSha256: sha256Hex(fromUtf8(outputAfterRestart)),
      runId: inspectedRun.runId,
      branchId: BRANCH_ID,
      headGeneration: inspectedHead.generation,
      turnClosureWorldFingerprint: inspectedHead.turnClosureWorldFingerprint,
      resultingStateFingerprint: inspectedHead.resultingStateFingerprint,
      archiveAppendBatchRetained: inspectedArchiveBytes.byteLength > 0,
      retainedImmutableBlobCount: blobRefsBeforeRestart.length,
      effectStates: inspectedEffects.map((record) => record.state).sort(),
      effectCount: inspectedEffects.length,
      committedEffectCount: committedEffects.filter((record) => record.state === EffectState.closureCommitted).length,
      sandboxDriverCalls: counters.calls,
      sandboxDriverWriteCalls: counters.writeCalls,
      writeRetryReusedPersistedResolution: writeRetry.reused === true,
      duplicateWriteAvoided: counters.calls === callsAfterWrite && counters.writeCalls === 1,
      restartInspectionInvokedDriver: false,
      restartInspectedCommittedClosure: sha256Hex(inspectedClosureBytes) === inspectedHead.turnClosureRef.checksum,
      hostFixtureOnly: true,
      worldSemanticEvidenceSource: 'node scripts/run-world-conformance.mjs --world-repo ../world',
    };
  } finally {
    if (restartedStore) await restartedStore.releaseLock().catch(() => {});
    if (store) await store.releaseLock().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

async function installFixtureRun(store) {
  const imageBytes = fromUtf8('sealed executable image fixture');
  const manifestBytes = fromUtf8(stableJson({
    applianceManifest: 'file-agent-fixture',
    requiredActuators: ['sandbox:file'],
  }));
  const parentClosureBytes = fromUtf8(stableJson({
    turnClosure: 'host-fixture-needs-file-effects',
    pendingRequests: ['read-input', 'write-output'],
  }));
  const imageRef = await store.putBlob(imageBytes);
  const manifestRef = await store.putBlob(manifestBytes);
  const parentClosureRef = await store.putBlob(parentClosureBytes);
  const application = createApplicationRecord({
    applicationId: APPLICATION_ID,
    universalWasmChecksum: 'sha256:host-fixture',
    worldProtocolVersion: 'v0.1.0',
    applianceAbiVersion: 'v3',
    executableImageRef: imageRef,
    executableImageWorldFingerprint: `world:executable-image:file-agent:${sha256Hex(imageBytes)}`,
    applianceManifestRef: manifestRef,
    requiredActuators: [{ actuatorRef: 'sandbox:file' }],
    requiredRuntimeLimits: { maximumConcurrentEffects: 2 },
    installationDiagnostics: {
      proof: 'file-rewrite-agent-directory-store-fixture',
      hostFixtureOnly: true,
    },
  });
  await store.createApplication(application);
  const parentHead = createRunHead({
    generation: 0,
    turnClosureRef: parentClosureRef,
    turnClosureWorldFingerprint: PARENT_CLOSURE_FINGERPRINT,
    resultingStateFingerprint: 'world:state:file-agent:0',
    chronicleCursor: 'world:chronicle:file-agent:0',
    archiveMomentFingerprint: 'world:archive-moment:file-agent:0',
    archiveSealFingerprint: 'world:archive-seal:file-agent:0',
    status: 'needs_host',
    updateDiagnostics: {
      pendingHostRequestCount: 2,
    },
  });
  const run = createRunRecord({
    runId: RUN_ID,
    applicationId: application.applicationId,
    branches: [createBranchRecord({ branchId: BRANCH_ID, currentHead: parentHead })],
    effectJournalNamespace: `${RUN_ID}:effects`,
    creationMetadata: { example: 'file-rewrite-agent' },
    receiverPolicyRef: 'local-sandbox-only',
    diagnostics: { hostFixtureOnly: true },
  });
  await store.createRun(run);
  return { application, run, parentHead };
}

function countingSandboxDriver(root) {
  const delegate = new SandboxFileDriver({ root });
  const counters = { calls: 0, readCalls: 0, writeCalls: 0 };
  return {
    counters,
    driver: {
      manifest() {
        return delegate.manifest();
      },
      async resolve(context, hostRequest) {
        const request = JSON.parse(new TextDecoder().decode(hostRequest.requestBytes));
        counters.calls += 1;
        if (request.operation === 'read') counters.readCalls += 1;
        if (request.operation === 'write') counters.writeCalls += 1;
        return await delegate.resolve(context, hostRequest);
      },
      async recover(context, effectRecord) {
        return await delegate.recover(context, effectRecord);
      },
    },
  };
}

function fileRequest(key, request) {
  return {
    actuatorRef: 'sandbox:file',
    descriptorFingerprint: 'descriptor:sandbox-file',
    actuationClass: 'file',
    responseSchema: { status: 'ok' },
    idempotencyKeyBytes: fromUtf8(key),
    idempotencyKeyWorldFingerprint: `world:key:${key}`,
    requestBytes: fromUtf8(stableJson(request)),
  };
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
