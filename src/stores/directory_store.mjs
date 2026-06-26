import { link, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { createApplicationRecord } from '../core/application.mjs';
import { assertEffectRecord } from '../core/effect_journal.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from '../core/run.mjs';
import { ClosureStore, assertBlobRef, assertBytes, makeBlobRef, stableJson } from '../core/store.mjs';
import { fail } from '../core/store.mjs';
import { BunStoreLock } from '../bun/bun_lock.mjs';

const headCasQueuesByRoot = new Map();

export class DirectoryStore extends ClosureStore {
  constructor(root) {
    super();
    this.root = root;
    this.concurrencyKey = `directory:${path.resolve(root)}`;
    this.lock = new BunStoreLock(path.join(root, 'locks', 'store.lock'));
    this.headCasQueues = headCasQueueForRoot(this.concurrencyKey);
  }

  async acquireLock(options) {
    return await this.lock.acquire(options);
  }

  async releaseLock() {
    await this.lock.release();
  }

  async putBlob(bytes) {
    const input = assertBytes(bytes);
    const checksum = sha256(input);
    const ref = makeBlobRef(checksum, input.byteLength);
    const finalPath = this.blobPath(ref);
    await mkdir(path.dirname(finalPath), { recursive: true });
    if (await exists(finalPath)) {
      await this.getBlob(ref);
      return ref;
    }
    const tmp = path.join(this.root, 'tmp', `${checksum}.${Date.now()}.${randomUUID()}.tmp`);
    await mkdir(path.dirname(tmp), { recursive: true });
    const handle = await open(tmp, 'wx');
    try {
      await handle.writeFile(input);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const written = await readFile(tmp);
    if (written.byteLength !== ref.byteLength || sha256(written) !== ref.checksum) fail('ERR_BLOB_WRITE_VERIFY_FAILED');
    await rename(tmp, finalPath);
    await fsyncDir(path.dirname(finalPath));
    return ref;
  }

  async getBlob(ref) {
    assertBlobRef(ref);
    const bytes = await readFile(this.blobPath(ref)).catch(() => fail('ERR_BLOB_NOT_FOUND'));
    if (bytes.byteLength !== ref.byteLength || sha256(bytes) !== ref.checksum) fail('ERR_BLOB_CHECKSUM_MISMATCH');
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
    return await writeJsonNew(applicationPath(this.root, record.applicationId), record, 'ERR_APPLICATION_EXISTS');
  }

  async getApplication(id) {
    return await readJson(applicationPath(this.root, id), 'ERR_APPLICATION_NOT_FOUND');
  }

  async createRun(record) {
    const targetRunPath = runPath(this.root, record.runId);
    if (await exists(targetRunPath)) fail('ERR_RUN_EXISTS');
    for (const branch of record.branches ?? []) this.headPath(record.runId, branch.branchId);
    for (const branch of record.branches ?? []) await this.writeInitialHead(record.runId, branch.branchId, branch.currentHead);
    const written = await writeJsonNew(targetRunPath, record, 'ERR_RUN_EXISTS');
    return written;
  }

  async getRun(id) {
    return await readJson(runPath(this.root, id), 'ERR_RUN_NOT_FOUND');
  }

  async writeRun(record) {
    await writeJsonReplace(runPath(this.root, record.runId), record);
    return record;
  }

  async readHead(runId, branchId) {
    return await readJson(this.headPath(runId, branchId), 'ERR_HEAD_NOT_FOUND');
  }

  async compareAndSwapHead(runId, branchId, expectedGeneration, nextHead) {
    const key = this.headPath(runId, branchId);
    return await this.#withHeadCas(key, async () => {
      if (!await this.hasBlob(nextHead.turnClosureRef)) fail('ERR_HEAD_CLOSURE_BLOB_MISSING');
      const current = await this.readHead(runId, branchId);
      if (current.generation !== expectedGeneration) return { ok: false, current };
      await this.writeHead(runId, branchId, nextHead);
      return { ok: true, current: nextHead };
    });
  }

  async putEffectRecord(record) {
    const key = effectFileKey(record.branchId, record.idempotencyKey);
    const file = path.join(effectsDir(this.root, record.runId), `${key}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeJsonReplace(file, record);
    return record;
  }

  async getEffectRecord(runId, idempotencyKey, branchId = null) {
    if (!branchId) {
      return (await this.listEffectRecords(runId)).find((record) => stableJson(record.idempotencyKey) === stableJson(idempotencyKey)) ?? null;
    }
    const file = path.join(effectsDir(this.root, runId), `${effectFileKey(branchId, idempotencyKey)}.json`);
    try {
      return await readJson(file, null);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async listEffectRecords(runId) {
    const dir = effectsDir(this.root, runId);
    const names = await readdir(dir).catch(() => []);
    return await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readJson(path.join(dir, name))));
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
      blobs: await Promise.all(blobRefs.map(async (ref) => ({
        checksum: ref.checksum,
        byteLength: ref.byteLength,
        bytes: [...await this.getBlob(ref)],
      }))),
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
    const importedBlobBytes = new Map();
    for (const blob of bundle.blobs ?? []) {
      if (!requiredBlobChecksums.has(blob.checksum)) fail('ERR_IMPORT_BLOB_UNREFERENCED');
      if (Array.isArray(blob.bytes)) {
        const bytes = Uint8Array.from(blob.bytes);
        if (sha256(bytes) !== blob.checksum || bytes.byteLength !== blob.byteLength) fail('ERR_IMPORT_BLOB_CHECKSUM_MISMATCH');
        importedBlobBytes.set(blob.checksum, bytes);
      } else {
        assertBlobRef(blob);
      }
    }
    for (const ref of requiredBlobRefs) {
      const imported = importedBlobBytes.get(ref.checksum);
      if (imported) {
        if (imported.byteLength !== ref.byteLength) fail('ERR_IMPORT_BLOB_REF_MISSING');
      } else if (!await this.hasBlob(ref)) {
        fail('ERR_IMPORT_BLOB_REF_MISSING');
      }
    }
    const runExists = await exists(runPath(this.root, runRecord.runId));
    const headExists = await exists(this.headPath(runRecord.runId, bundle.branchId));
    if (application) {
      if (await exists(applicationPath(this.root, application.applicationId))) {
        const existing = await this.getApplication(application.applicationId);
        if (stableJson(existing) !== stableJson(application)) fail('ERR_IMPORT_APPLICATION_MISMATCH');
      } else if (runExists || headExists) {
        fail('ERR_IMPORT_RUN_EXISTS');
      }
    }
    let missingEffect = false;
    for (const record of effectRecords) {
      const existing = await this.getEffectRecord(record.runId, record.idempotencyKey, record.branchId);
      if (!existing) {
        missingEffect = true;
      } else if (stableJson(existing) !== stableJson(record)) {
        fail('ERR_IMPORT_EFFECT_EXISTS');
      }
    }
    if (runExists) {
      const existing = await this.getRun(runRecord.runId);
      if (stableJson(existing) !== stableJson(runRecord)) fail('ERR_IMPORT_RUN_EXISTS');
    }
    if (headExists) {
      const existing = await this.readHead(runRecord.runId, bundle.branchId);
      if (stableJson(existing) !== stableJson(headRecord)) fail('ERR_IMPORT_HEAD_EXISTS');
    }
    if (runExists && headExists) fail('ERR_IMPORT_RUN_EXISTS');
    for (const bytes of importedBlobBytes.values()) await this.putBlob(bytes);
    if (application && !await exists(applicationPath(this.root, application.applicationId))) {
      await this.createApplication(application);
    }
    if (!runExists && !headExists) {
      await this.createRun(runRecord);
    } else {
      if (!headExists) await this.writeHead(runRecord.runId, bundle.branchId, headRecord);
      if (!runExists) await writeJsonNew(runPath(this.root, runRecord.runId), runRecord, 'ERR_IMPORT_RUN_EXISTS');
    }
    for (const record of effectRecords) await this.putEffectRecord(record);
    return await this.getRun(runRecord.runId);
  }

  async recover() {
    const tmp = await readdir(path.join(this.root, 'tmp')).catch(() => []);
    const referenced = new Set();
    for (const ref of collectBlobRefs(
      await this.allApplications(),
      await this.allRuns(),
      await this.allHeads(),
      await this.allEffectRecords(),
    )) {
      referenced.add(ref.checksum);
    }
    const orphanBlobs = (await this.listBlobRefs()).filter((ref) => !referenced.has(ref.checksum));
    return {
      temporaryFilesIgnored: tmp.filter((name) => name.endsWith('.tmp')),
      orphanBlobs,
      garbageCollected: false,
      multiProcessWriterSupport: false,
    };
  }

  blobPath(ref) {
    return path.join(this.root, 'blobs', 'sha256', ref.checksum);
  }

  headPath(runId, branchId) {
    return path.join(this.root, 'heads', safePathSegment(runId, 'runId'), `${safePathSegment(branchId, 'branchId')}.json`);
  }

  async writeHead(runId, branchId, head) {
    await writeJsonReplace(this.headPath(runId, branchId), head);
  }

  async writeInitialHead(runId, branchId, head) {
    const file = this.headPath(runId, branchId);
    try {
      return await writeJsonNew(file, head, 'ERR_HEAD_EXISTS');
    } catch (error) {
      if (error?.code !== 'ERR_HEAD_EXISTS') throw error;
      const existing = await readJson(file, 'ERR_HEAD_NOT_FOUND');
      if (stableJson(existing) !== stableJson(head)) throw error;
      return existing;
    }
  }

  async listBlobRefs() {
    const dir = path.join(this.root, 'blobs', 'sha256');
    const names = await readdir(dir).catch(() => []);
    const refs = [];
    for (const checksum of names) {
      if (!/^[0-9a-f]{64}$/.test(checksum)) continue;
      const file = path.join(dir, checksum);
      const info = await stat(file);
      refs.push(makeBlobRef(checksum, info.size));
    }
    return refs;
  }

  async allHeads() {
    const root = path.join(this.root, 'heads');
    const runs = await readdir(root).catch(() => []);
    const heads = [];
    for (const runId of runs) {
      const dir = path.join(root, runId);
      const entries = await readdir(dir).catch(() => []);
      for (const entry of entries) {
        if (entry.endsWith('.json')) heads.push(await readJson(path.join(dir, entry)));
      }
    }
    return heads;
  }

  async allApplications() {
    const dir = path.join(this.root, 'applications');
    const entries = await readdir(dir).catch(() => []);
    return await Promise.all(entries.filter((name) => name.endsWith('.json')).map((name) => readJson(path.join(dir, name))));
  }

  async allRuns() {
    const dir = path.join(this.root, 'runs');
    const entries = await readdir(dir).catch(() => []);
    return await Promise.all(entries.filter((name) => name.endsWith('.json')).map((name) => readJson(path.join(dir, name))));
  }

  async allEffectRecords() {
    const root = path.join(this.root, 'effects');
    const runs = await readdir(root).catch(() => []);
    const effects = [];
    for (const runId of runs) {
      const dir = path.join(root, runId);
      const entries = await readdir(dir).catch(() => []);
      for (const entry of entries) {
        if (entry.endsWith('.json')) effects.push(await readJson(path.join(dir, entry)));
      }
    }
    return effects;
  }

  async #withHeadCas(key, action) {
    const previous = this.headCasQueues.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current, () => current);
    this.headCasQueues.set(key, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.headCasQueues.get(key) === queued) this.headCasQueues.delete(key);
    }
  }
}

function headCasQueueForRoot(rootKey) {
  let queues = headCasQueuesByRoot.get(rootKey);
  if (!queues) {
    queues = new Map();
    headCasQueuesByRoot.set(rootKey, queues);
  }
  return queues;
}

function applicationPath(root, applicationId) {
  return path.join(root, 'applications', `${safePathSegment(applicationId, 'applicationId')}.json`);
}

function runPath(root, runId) {
  return path.join(root, 'runs', `${safePathSegment(runId, 'runId')}.json`);
}

function effectsDir(root, runId) {
  return path.join(root, 'effects', safePathSegment(runId, 'runId'));
}

function effectFileKey(branchId, idempotencyKey) {
  return sha256(Buffer.from(stableJson({ branchId, idempotencyKey })));
}

function safePathSegment(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    fail('ERR_STORE_ID_PATH_UNSAFE', `${label} must be a single path segment`, { label });
  }
  return value;
}

function assertUniqueEffectRecords(records) {
  const seen = new Set();
  for (const record of records) {
    const key = effectFileKey(record.branchId, record.idempotencyKey);
    if (seen.has(key)) fail('ERR_IMPORT_EFFECT_DUPLICATE');
    seen.add(key);
  }
}

function collectBlobRefs(...values) {
  const refs = new Map();
  const add = (ref) => {
    if (!ref) return;
    const actual = assertBlobRef(ref);
    refs.set(`${actual.checksum}:${actual.byteLength}`, makeBlobRef(actual.checksum, actual.byteLength));
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
    add(value.receiverPolicyRef);
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

async function writeJsonNew(file, value, existsCode) {
  await mkdir(path.dirname(file), { recursive: true });
  if (await exists(file)) fail(existsCode);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${Date.now()}.${randomUUID()}.tmp`);
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tmp, file);
  } catch (error) {
    if (error.code === 'EEXIST') fail(existsCode);
    throw error;
  } finally {
    await rm(tmp, { force: true });
  }
  await fsyncDir(path.dirname(file));
  return value;
}

async function writeJsonReplace(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${Date.now()}.${randomUUID()}.tmp`);
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
  await fsyncDir(path.dirname(file));
  return value;
}

async function readJson(file, missingCode = 'ERR_JSON_NOT_FOUND') {
  const text = await readFile(file, 'utf8').catch((error) => {
    if (missingCode) fail(missingCode);
    throw error;
  });
  return JSON.parse(text);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function exists(file) {
  return !!await stat(file).catch(() => false);
}

async function fsyncDir(dir) {
  const handle = await open(dir, 'r').catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => {});
  } finally {
    await handle.close();
  }
}
