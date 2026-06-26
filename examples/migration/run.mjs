import { createApplicationRecord } from '../../src/core/application.mjs';
import { exportCarrierRun, importCarrierRun } from '../../src/core/migration.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../../src/core/run.mjs';
import { fromUtf8 } from '../../src/core/store.mjs';
import { MemoryStore } from '../../src/stores/memory_store.mjs';

export async function runExample() {
  const source = await fixtureStore('source');
  const exported = await exportCarrierRun(source.store, source.run.runId, 'main');
  const receiver = new MemoryStore();
  const imported = await importCarrierRun(receiver, exported, { runId: 'receiver-run', preflight: async () => ({ blockers: [] }) });
  return {
    example: 'migration',
    authorityImported: imported.authorityImported,
    receiverRunId: imported.run.runId,
    sameHead: (await receiver.readHead('receiver-run', 'main')).turnClosureWorldFingerprint === source.head.turnClosureWorldFingerprint,
  };
}

async function fixtureStore(prefix) {
  const store = new MemoryStore();
  const imageRef = await store.putBlob(fromUtf8('image'));
  const manifestRef = await store.putBlob(fromUtf8('manifest'));
  const closureRef = await store.putBlob(fromUtf8('closure'));
  const app = createApplicationRecord({ applicationId: `${prefix}:app`, universalWasmChecksum: 'sha256:0000000000000000000000000000000000000000000000000000000000000000', worldProtocolVersion: 'v0.1.0', applianceAbiVersion: 'v3', executableImageRef: imageRef, executableImageWorldFingerprint: 'world:image', applianceManifestRef: manifestRef, requiredActuators: [], requiredRuntimeLimits: {} });
  await store.createApplication(app);
  const head = createRunHead({ generation: 0, turnClosureRef: closureRef, turnClosureWorldFingerprint: 'world:closure:0', resultingStateFingerprint: 'world:state:0', chronicleCursor: 'cursor:0', archiveMomentFingerprint: 'archive:moment:0', archiveSealFingerprint: 'archive:seal:0', status: 'needs_host' });
  const run = createRunRecord({ runId: `${prefix}:run`, applicationId: app.applicationId, branches: [createBranchRecord({ branchId: 'main', currentHead: head })], effectJournalNamespace: `${prefix}:effects` });
  await store.createRun(run);
  return { store, run, head };
}
