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
    const key = effectKey(record.runId, record.idempotencyKey);
    this.effects.set(key, clone(record));
    return clone(record);
  }

  async getEffectRecord(runId, idempotencyKey) {
    const record = this.effects.get(effectKey(runId, idempotencyKey));
    return record ? clone(record) : null;
  }

  async listEffectRecords(runId) {
    return [...this.effects.entries()]
      .filter(([key]) => key.startsWith(`${runId}\0`))
      .map(([, value]) => clone(value));
  }

  async exportRun(runId, branchId) {
    const run = await this.getRun(runId);
    const head = await this.readHead(runId, branchId);
    const effects = await this.listEffectRecords(runId);
    return {
      run,
      branchId,
      head,
      effects,
      blobs: [...this.blobs.entries()].map(([checksum, bytes]) => ({ checksum, bytes: [...bytes] })),
    };
  }

  async importRun(bundle) {
    for (const blob of bundle.blobs ?? []) this.blobs.set(blob.checksum, Uint8Array.from(blob.bytes));
    if (!this.runs.has(bundle.run.runId)) this.runs.set(bundle.run.runId, clone(bundle.run));
    this.heads.set(headKey(bundle.run.runId, bundle.branchId), clone(bundle.head));
    for (const effect of bundle.effects ?? []) await this.putEffectRecord(effect);
    return await this.getRun(bundle.run.runId);
  }
}

function headKey(runId, branchId) {
  return `${runId}\0${branchId}`;
}

function effectKey(runId, idempotencyKey) {
  return `${runId}\0${stableJson(idempotencyKey)}`;
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
