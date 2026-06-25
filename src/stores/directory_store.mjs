import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { ClosureStore, assertBlobRef, assertBytes, makeBlobRef, stableJson } from '../core/store.mjs';
import { fail } from '../core/store.mjs';
import { NodeStoreLock } from '../node/node_lock.mjs';

export class DirectoryStore extends ClosureStore {
  constructor(root) {
    super();
    this.root = root;
    this.lock = new NodeStoreLock(path.join(root, 'locks', 'store.lock'));
    this.headCasQueues = new Map();
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
    const written = await writeJsonNew(runPath(this.root, record.runId), record, 'ERR_RUN_EXISTS');
    for (const branch of record.branches ?? []) await this.writeHead(record.runId, branch.branchId, branch.currentHead);
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
    for (const blob of bundle.blobs ?? []) {
      if (Array.isArray(blob.bytes)) {
        const ref = await this.putBlob(Uint8Array.from(blob.bytes));
        if (ref.checksum !== blob.checksum || ref.byteLength !== blob.byteLength) fail('ERR_IMPORT_BLOB_CHECKSUM_MISMATCH');
      } else {
        assertBlobRef(blob);
      }
    }
    for (const ref of collectBlobRefs(bundle.run, bundle.application, bundle.head, bundle.effects ?? [])) {
      if (!await this.hasBlob(ref)) fail('ERR_IMPORT_BLOB_REF_MISSING');
    }
    if (bundle.application) {
      if (await exists(applicationPath(this.root, bundle.application.applicationId))) {
        const existing = await this.getApplication(bundle.application.applicationId);
        if (stableJson(existing) !== stableJson(bundle.application)) fail('ERR_IMPORT_APPLICATION_MISMATCH');
      } else {
        await this.createApplication(bundle.application);
      }
    }
    if (await exists(runPath(this.root, bundle.run.runId))) fail('ERR_IMPORT_RUN_EXISTS');
    if (await exists(this.headPath(bundle.run.runId, bundle.branchId))) fail('ERR_IMPORT_HEAD_EXISTS');
    await this.createRun(bundle.run);
    await this.writeHead(bundle.run.runId, bundle.branchId, bundle.head);
    for (const effect of bundle.effects ?? []) await this.putEffectRecord(effect);
    return await this.getRun(bundle.run.runId);
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

function collectBlobRefs(...values) {
  const refs = new Map();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (
      value.algorithm === 'sha256' &&
      /^[0-9a-f]{64}$/.test(value.checksum) &&
      Number.isSafeInteger(value.byteLength) &&
      value.byteLength >= 0
    ) {
      refs.set(`${value.checksum}:${value.byteLength}`, makeBlobRef(value.checksum, value.byteLength));
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const value of values) visit(value);
  return [...refs.values()];
}

async function writeJsonNew(file, value, existsCode) {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, 'wx').catch((error) => {
    if (error.code === 'EEXIST') fail(existsCode);
    throw error;
  });
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
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
