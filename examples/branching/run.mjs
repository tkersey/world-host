import { createApplicationRecord } from '../../src/core/application.mjs';
import { forkRunBranch } from '../../src/core/migration.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../../src/core/run.mjs';
import { fromUtf8 } from '../../src/core/store.mjs';
import { carrierVersionSummary } from '../../src/protocol/world_manifest.mjs';
import { MemoryStore } from '../../src/stores/memory_store.mjs';

export async function runExample() {
  const store = new MemoryStore();
  const imageRef = await store.putBlob(fromUtf8('image'));
  const wasmRef = await store.putBlob(fromUtf8('wasm'));
  const manifestRef = await store.putBlob(fromUtf8('manifest'));
  const closureRef = await store.putBlob(fromUtf8('closure:0'));
  const app = createApplicationRecord({ applicationId: 'app', universalWasmChecksum: `sha256:${wasmRef.checksum}`, universalWasmByteLength: wasmRef.byteLength, worldProtocolVersion: 'v0.1.0', applianceAbiVersion: carrierVersionSummary().applianceAbi, executableImageRef: imageRef, executableImageWorldFingerprint: 'world:image', applianceManifestRef: manifestRef, requiredActuators: [], requiredRuntimeLimits: {} });
  await store.createApplication(app);
  const head = createRunHead({ generation: 0, turnClosureRef: closureRef, turnClosureWorldFingerprint: 'world:closure:0', resultingStateFingerprint: 'world:state:0', chronicleCursor: 'cursor:0', archiveMomentFingerprint: 'archive:moment:0', archiveSealFingerprint: 'archive:seal:0', status: 'needs_host' });
  const run = createRunRecord({ runId: 'run', applicationId: app.applicationId, branches: [createBranchRecord({ branchId: 'main', currentHead: head })], effectJournalNamespace: 'effects' });
  await store.createRun(run);
  await forkRunBranch(store, { runId: run.runId, sourceBranchId: 'main', sourceClosureFingerprint: head.turnClosureWorldFingerprint, newBranchId: 'alternate' });
  const mainNextRef = await store.putBlob(fromUtf8('closure:main'));
  const altNextRef = await store.putBlob(fromUtf8('closure:alternate'));
  await store.compareAndSwapHead(run.runId, 'main', 0, createRunHead({ ...head, generation: 1, turnClosureRef: mainNextRef, turnClosureWorldFingerprint: 'world:closure:main', resultingStateFingerprint: 'world:state:main' }));
  await store.compareAndSwapHead(run.runId, 'alternate', 0, createRunHead({ ...head, generation: 1, turnClosureRef: altNextRef, turnClosureWorldFingerprint: 'world:closure:alternate', resultingStateFingerprint: 'world:state:alternate' }));
  return {
    example: 'branching',
    main: (await store.readHead(run.runId, 'main')).turnClosureWorldFingerprint,
    alternate: (await store.readHead(run.runId, 'alternate')).turnClosureWorldFingerprint,
    sourceMutatedByFork: false,
  };
}
