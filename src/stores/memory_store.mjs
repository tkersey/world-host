import { createApplicationRecord } from '../core/application.mjs';
import { assertEffectRecord } from '../core/effect_journal.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../core/run.mjs';
import { ClosureStore, assertBlobRef, assertBytes, fromUtf8, makeBlobRef, sameBlobRef, stableJson, toHex } from '../core/store.mjs';
import { fail } from '../core/store.mjs';

export class MemoryStore extends ClosureStore {
  constructor() {
    super();
    this.blobs = new Map();
    this.applications = new Map();
    this.runs = new Map();
    this.heads = new Map();
    this.effects = new Map();
  }

  async putBlob(bytes) {
    const input = assertBytes(bytes);
    const checksum = await sha256(input);
    const ref = makeBlobRef(checksum, input.byteLength);
    this.blobs.set(ref.checksum, new Uint8Array(input));
    return ref;
  }

  async getBlob(ref) {
    assertBlobRef(ref);
    const bytes = this.blobs.get(ref.checksum);
    if (!bytes) fail('ERR_BLOB_NOT_FOUND');
    if (bytes.byteLength !== ref.byteLength || await sha256(bytes) !== ref.checksum) fail('ERR_BLOB_CHECKSUM_MISMATCH');
    return new Uint8Array(bytes);
  }

  async hasBlob(ref) {
    try {
      await this.getBlob(ref);
      return true;
    } catch {
      return false;
    }
  }

  async createApplication(record) {
    if (this.applications.has(record.applicationId)) fail('ERR_APPLICATION_EXISTS');
    this.applications.set(record.applicationId, clone(record));
    return clone(record);
  }

  async getApplication(id) {
    return requiredClone(this.applications, id, 'ERR_APPLICATION_NOT_FOUND');
  }

  async createRun(record) {
    if (this.runs.has(record.runId)) fail('ERR_RUN_EXISTS');
    this.runs.set(record.runId, clone(record));
    for (const branch of record.branches ?? []) {
      this.heads.set(headKey(record.runId, branch.branchId), clone(branch.currentHead));
    }
    return clone(record);
  }

  async getRun(id) {
    return requiredClone(this.runs, id, 'ERR_RUN_NOT_FOUND');
  }

  async writeRun(record) {
    this.runs.set(record.runId, clone(record));
    return clone(record);
  }

  async readHead(runId, branchId) {
    return requiredClone(this.heads, headKey(runId, branchId), 'ERR_HEAD_NOT_FOUND');
  }

  async compareAndSwapHead(runId, branchId, expectedGeneration, nextHead) {
    if (!await this.hasBlob(nextHead.turnClosureRef)) fail('ERR_HEAD_CLOSURE_BLOB_MISSING');
    const key = headKey(runId, branchId);
    const current = this.heads.get(key);
    if (!current) fail('ERR_HEAD_NOT_FOUND');
    if (current.generation !== expectedGeneration) return { ok: false, current: clone(current) };
    this.heads.set(key, clone(nextHead));
    return { ok: true, current: clone(nextHead) };
  }

  async putEffectRecord(record) {
    const key = effectKey(record.runId, record.branchId, record.idempotencyKey);
    this.effects.set(key, clone(record));
    return clone(record);
  }

  async getEffectRecord(runId, idempotencyKey, branchId = null) {
    if (branchId) {
      const record = this.effects.get(effectKey(runId, branchId, idempotencyKey));
      return record ? clone(record) : null;
    }
    const idempotencyKeyJson = stableJson(idempotencyKey);
    const record = [...this.effects.values()]
      .find((value) => value.runId === runId && stableJson(value.idempotencyKey) === idempotencyKeyJson);
    return record ? clone(record) : null;
  }

  async listEffectRecords(runId) {
    return [...this.effects.values()]
      .filter((value) => value.runId === runId)
      .map((value) => clone(value));
  }

  async exportRun(runId, branchId) {
    const run = await this.getRun(runId);
    const head = await this.readHead(runId, branchId);
    const application = await this.getApplication(run.applicationId);
    const effects = (await this.listEffectRecords(runId)).filter((effect) => effect.branchId === branchId);
    const selectedBranch = (run.branches ?? []).find((branch) => branch.branchId === branchId);
    const exportedRun = {
      ...run,
      branches: [{ ...(selectedBranch ?? { branchId }), currentHead: head }],
    };
    const blobRefs = collectBlobRefs(exportedRun, application, head, effects);
    return {
      run: exportedRun,
      application,
      branchId,
      head,
      effects,
      blobs: blobRefs.map((ref) => ({ checksum: ref.checksum, byteLength: ref.byteLength, bytes: [...this.blobs.get(ref.checksum)] })),
    };
  }

  async importRun(bundle) {
    const application = assertBundleApplicationMatchesRun(bundle);
    const runRecord = createImportRunRecord(bundle.run);
    const headRecord = createRunHead(bundle.head);
    const normalizedBundle = { ...bundle, application, run: runRecord, head: headRecord };
    assertBundleEffectsScoped(normalizedBundle);
    assertBundleSelectedHeadMatchesRun(normalizedBundle);
    const effectRecords = (bundle.effects ?? []).map((effect) => assertEffectRecord(effect));
    assertUniqueEffectRecords(effectRecords);
    const requiredBlobRefs = collectBlobRefs(runRecord, application, headRecord, effectRecords);
    const requiredBlobChecksums = new Set(requiredBlobRefs.map((ref) => ref.checksum));
    const importedBlobs = new Map();
    for (const blob of bundle.blobs ?? []) {
      if (!requiredBlobChecksums.has(blob.checksum)) fail('ERR_IMPORT_BLOB_UNREFERENCED');
      if (Array.isArray(blob.bytes)) {
        const bytes = Uint8Array.from(blob.bytes);
        const checksum = await sha256(bytes);
        if (checksum !== blob.checksum || bytes.byteLength !== blob.byteLength) fail('ERR_IMPORT_BLOB_CHECKSUM_MISMATCH');
        importedBlobs.set(blob.checksum, bytes);
      } else {
        assertBlobRef(blob);
      }
    }
    if (application && this.applications.has(application.applicationId)) {
      const existing = this.applications.get(application.applicationId);
      if (stableJson(existing) !== stableJson(application)) fail('ERR_IMPORT_APPLICATION_MISMATCH');
    }
    if (this.runs.has(runRecord.runId)) fail('ERR_IMPORT_RUN_EXISTS');
    if (this.heads.has(headKey(runRecord.runId, bundle.branchId))) fail('ERR_IMPORT_HEAD_EXISTS');
    for (const record of effectRecords) {
      const existing = await this.getEffectRecord(record.runId, record.idempotencyKey, record.branchId);
      if (existing && stableJson(existing) !== stableJson(record)) fail('ERR_IMPORT_EFFECT_EXISTS');
    }
    for (const ref of requiredBlobRefs) {
      const bytes = importedBlobs.get(ref.checksum) ?? this.blobs.get(ref.checksum);
      if (!bytes || bytes.byteLength !== ref.byteLength) fail('ERR_IMPORT_BLOB_REF_MISSING');
    }
    for (const [checksum, bytes] of importedBlobs) this.blobs.set(checksum, new Uint8Array(bytes));
    if (application && !this.applications.has(application.applicationId)) this.applications.set(application.applicationId, clone(application));
    this.runs.set(runRecord.runId, clone(runRecord));
    this.heads.set(headKey(runRecord.runId, bundle.branchId), clone(headRecord));
    for (const effect of effectRecords) await this.putEffectRecord(effect);
    return await this.getRun(runRecord.runId);
  }
}

function headKey(runId, branchId) {
  return stableJson([runId, branchId]);
}

function effectKey(runId, branchId, idempotencyKey) {
  return stableJson([runId, branchId, idempotencyKey]);
}

function assertUniqueEffectRecords(records) {
  const seen = new Set();
  for (const record of records) {
    const key = effectKey(record.runId, record.branchId, record.idempotencyKey);
    if (seen.has(key)) fail('ERR_IMPORT_EFFECT_DUPLICATE');
    seen.add(key);
  }
}

function collectBlobRefs(...values) {
  const refs = new Map();
  const add = (ref) => {
    if (!ref) return;
    const actual = assertBlobRef(ref);
    refs.set(`${actual.checksum}:${actual.byteLength}`, actual);
  };
  for (const value of values) collectOwnedRefs(value);
  return [...refs.values()];

  function collectOwnedRefs(value) {
    if (Array.isArray(value)) {
      for (const child of value) collectOwnedRefs(child);
      return;
    }
    if (!value || typeof value !== 'object') return;
    add(value.executableImageRef);
    add(value.applianceManifestRef);
    add(value.turnClosureRef);
    add(value.requestBytesRef);
    add(value.resolutionInputRef);
    add(value.hostClaimRef);
    add(universalWasmRef(value));
    collectDiagnosticBlobRefs(value.diagnostics);
    collectDiagnosticBlobRefs(value.installationDiagnostics);
    collectDiagnosticBlobRefs(value.creationMetadata);
    collectDiagnosticBlobRefs(value.metadata);
    collectDiagnosticBlobRefs(value.updateDiagnostics);
    for (const branch of value.branches ?? []) collectOwnedRefs(branch.currentHead);
  }

  function collectDiagnosticBlobRefs(value, key = '') {
    if (Array.isArray(value)) {
      for (const child of value) collectDiagnosticBlobRefs(child, key.endsWith('Refs') ? 'Ref' : '');
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (key.endsWith('Ref')) addIfBlobRef(value);
    for (const [childKey, child] of Object.entries(value)) collectDiagnosticBlobRefs(child, childKey);
  }

  function addIfBlobRef(value) {
    try {
      add(value);
    } catch {
      return;
    }
  }
}

function universalWasmRef(value) {
  const checksum = value?.universalWasmChecksum;
  const byteLength = value?.installationDiagnostics?.wasmByteLength;
  if (
    typeof checksum !== 'string' ||
    !checksum.startsWith('sha256:') ||
    !/^[0-9a-f]{64}$/.test(checksum.slice('sha256:'.length)) ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    return null;
  }
  return makeBlobRef(checksum.slice('sha256:'.length), byteLength);
}

function assertBundleApplicationMatchesRun(bundle) {
  const application = bundle?.application;
  if (!application) fail('ERR_IMPORT_APPLICATION_REQUIRED');
  const record = createApplicationRecord(application);
  if (bundle.run?.applicationId !== application.applicationId) fail('ERR_IMPORT_APPLICATION_MISMATCH');
  return record;
}

function createImportRunRecord(run) {
  return createRunRecord({
    ...run,
    branches: (run?.branches ?? []).map((branch) => createBranchRecord(branch)),
  });
}

function assertBundleSelectedHeadMatchesRun(bundle) {
  if ((bundle?.run?.branches ?? []).length !== 1) fail('ERR_IMPORT_BRANCH_SCOPE_MISMATCH');
  const branch = bundle?.run?.branches?.find((item) => item.branchId === bundle.branchId);
  if (!branch || stableJson(branch.currentHead) !== stableJson(bundle.head)) fail('ERR_IMPORT_BRANCH_HEAD_MISMATCH');
}

function assertBundleEffectsScoped(bundle) {
  for (const effect of bundle.effects ?? []) {
    if (effect.runId !== bundle.run?.runId || effect.branchId !== bundle.branchId) {
      fail('ERR_IMPORT_EFFECT_SCOPE_MISMATCH');
    }
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requiredClone(map, key, code) {
  const value = map.get(key);
  if (!value) fail(code);
  return clone(value);
}

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}
