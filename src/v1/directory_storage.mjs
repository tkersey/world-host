import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  EffectJournalV1,
  admitEffectJournalResult,
  cloneEffectJournalRecord,
  createEffectJournalRecord,
  effectJournalKey,
  readEffectJournalResult,
} from './effect_journal.mjs';
import { assertBytes, fail } from './errors.mjs';
import {
  BlockStore,
  BranchHeadStore,
  assertBlockRef,
  blockRef,
  makeHead,
} from './storage.mjs';

const STORE_VERSION = 'world-host.application-directory-v1';

export class DirectoryBlockStore extends BlockStore {
  constructor(root) {
    super();
    this.root = requiredRoot(root);
  }

  async putBlock(blockBytes) {
    const bytes = Buffer.from(assertBytes(blockBytes, 'blockBytes'));
    const ref = blockRef(bytes);
    const file = this.blockPath(ref);
    try {
      return await this.#validateExisting(ref);
    } catch (error) {
      if (error?.code !== 'ERR_APPLICATION_V1_BLOCK_NOT_FOUND') throw error;
    }

    await mkdir(path.dirname(file), { recursive: true });
    const temporary = temporaryPath(this.root, ref.checksum);
    await writeBytesTemporary(temporary, bytes);
    try {
      await link(temporary, file);
      await fsyncDirectory(path.dirname(file));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await this.#validateExisting(ref);
    } finally {
      await rm(temporary, { force: true });
    }
    return ref;
  }

  async getBlock(ref) {
    const admitted = assertBlockRef(ref);
    const bytes = await readFile(this.blockPath(admitted)).catch((error) => {
      if (error?.code === 'ENOENT') fail('ERR_APPLICATION_V1_BLOCK_NOT_FOUND', admitted.checksum);
      throw error;
    });
    const actual = blockRef(bytes);
    if (actual.checksum !== admitted.checksum || actual.byteLength !== admitted.byteLength) {
      fail('ERR_APPLICATION_V1_BLOCK_CORRUPT', admitted.checksum);
    }
    return Buffer.from(bytes);
  }

  async hasBlock(ref) {
    try {
      await this.getBlock(ref);
      return true;
    } catch (error) {
      if (error?.code === 'ERR_APPLICATION_V1_BLOCK_NOT_FOUND') return false;
      throw error;
    }
  }

  blockPath(ref) {
    const admitted = assertBlockRef(ref);
    return path.join(this.root, 'blocks', 'sha256', admitted.checksum);
  }

  async #validateExisting(ref) {
    await this.getBlock(ref);
    return ref;
  }
}

export class DirectoryBranchHeadStore extends BranchHeadStore {
  constructor(root, { blockStore = null } = {}) {
    super();
    this.root = requiredRoot(root);
    this.blockStore = blockStore;
  }

  async readHead(runId, branchId) {
    const directory = headDirectory(this.root, runId, branchId);
    const entries = await readdir(directory).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const generations = entries
      .map(parseGenerationFile)
      .filter((generation) => generation !== null)
      .sort((left, right) => left - right);
    if (generations.length === 0) return null;
    let previous = null;
    for (let index = 0; index < generations.length; index += 1) {
      if (generations[index] !== index) fail('ERR_APPLICATION_V1_HEAD_HISTORY');
      const envelope = await readJson(path.join(directory, `${index}.json`));
      if (envelope.storeVersion !== STORE_VERSION || envelope.runId !== runId || envelope.branchId !== branchId) {
        fail('ERR_APPLICATION_V1_HEAD_SCOPE');
      }
      const head = makeHead(envelope.head);
      const declaredPrevious = envelope.previousHead === null ? null : makeHead(envelope.previousHead);
      if (head.generation !== index || !sameHead(previous, declaredPrevious)) {
        fail('ERR_APPLICATION_V1_HEAD_HISTORY');
      }
      previous = head;
    }
    return previous;
  }

  async advanceHeadIfCurrent(runId, branchId, expected, next) {
    requiredText(runId, 'runId');
    requiredText(branchId, 'branchId');
    const admittedExpected = expected === null ? null : makeHead(expected);
    const current = await this.readHead(runId, branchId);
    if (!sameHead(current, admittedExpected)) {
      return Object.freeze({ advanced: false, current });
    }
    const admittedNext = makeHead(next);
    const requiredGeneration = current === null ? 0 : current.generation + 1;
    if (admittedNext.generation !== requiredGeneration) fail('ERR_APPLICATION_V1_HEAD_GENERATION');
    if (current !== null && admittedNext.applicationId !== current.applicationId) {
      fail('ERR_APPLICATION_V1_HEAD_APPLICATION');
    }
    if (this.blockStore !== null && !await this.blockStore.hasBlock(admittedNext.frameRef)) {
      fail('ERR_APPLICATION_V1_HEAD_FRAME_BLOCK_MISSING');
    }

    const file = path.join(headDirectory(this.root, runId, branchId), `${admittedNext.generation}.json`);
    const created = await writeJsonNew(file, {
      storeVersion: STORE_VERSION,
      runId,
      branchId,
      previousHead: current,
      head: admittedNext,
    });
    if (!created) {
      return Object.freeze({ advanced: false, current: await this.readHead(runId, branchId) });
    }
    return Object.freeze({ advanced: true, current: admittedNext });
  }
}

export class DirectoryEffectJournalV1 extends EffectJournalV1 {
  constructor({ root, blockStore }) {
    super();
    this.root = requiredRoot(root);
    if (!blockStore) fail('ERR_APPLICATION_V1_EFFECT_JOURNAL_STORE');
    this.blockStore = blockStore;
  }

  async persistResult({
    runId,
    branchId,
    parentFrameId,
    request,
    result,
    limits,
    handlerId = 'operator-supplied',
    handlerConfigurationId = 'operator-supplied',
    recoveryClass = 'replayable',
    externalTransactionRef = null,
  }) {
    const admittedResult = admitEffectJournalResult(request, result, limits);
    const file = this.recordPath(runId, branchId, parentFrameId, request.requestId);
    const previous = await readJsonIfExists(file);
    if (previous !== null) {
      const retained = await readEffectJournalResult({ record: previous, blockStore: this.blockStore, request, limits });
      if (!sameBytes(retained.result.resultId, admittedResult.resultId)) fail('ERR_APPLICATION_V1_EFFECT_RESULT_CONFLICT');
      return cloneEffectJournalRecord(retained.record);
    }

    const resultRef = await this.blockStore.putBlock(admittedResult.encodedBytes);
    const record = createEffectJournalRecord({
      runId,
      branchId,
      parentFrameId,
      request,
      result: admittedResult,
      resultRef,
      handlerId,
      handlerConfigurationId,
      recoveryClass,
      externalTransactionRef,
    });
    if (!await writeJsonNew(file, record)) {
      const winner = await readEffectJournalResult({
        record: await readJson(file),
        blockStore: this.blockStore,
        request,
        limits,
      });
      if (!sameBytes(winner.result.resultId, admittedResult.resultId)) fail('ERR_APPLICATION_V1_EFFECT_RESULT_CONFLICT');
      return cloneEffectJournalRecord(winner.record);
    }
    return cloneEffectJournalRecord(record);
  }

  async readResult({ runId, branchId, parentFrameId, request, limits }) {
    const record = await readJsonIfExists(this.recordPath(runId, branchId, parentFrameId, request.requestId));
    if (record === null) return null;
    return await readEffectJournalResult({ record, blockStore: this.blockStore, request, limits });
  }

  recordPath(runId, branchId, parentFrameId, requestId) {
    const key = effectJournalKey(runId, branchId, parentFrameId, requestId);
    const checksum = sha256(Buffer.from(key, 'utf8'));
    return path.join(this.root, 'effects', checksum.slice(0, 2), `${checksum}.json`);
  }
}

export class DirectoryApplicationRegistryV1 {
  constructor(root) {
    this.root = requiredRoot(root);
  }

  async register({ name, applicationId, applicationVersion, wasmRef, manifestRef }) {
    const record = assertApplicationRecord({
      registryVersion: 'world-host.application-registry-v1',
      name,
      applicationId,
      applicationVersion,
      wasmRef,
      manifestRef,
    });
    const file = this.applicationPath(record.name);
    if (!await writeJsonNew(file, record)) {
      const existing = assertApplicationRecord(await readJson(file));
      if (JSON.stringify(existing) !== JSON.stringify(record)) fail('ERR_APPLICATION_V1_APPLICATION_EXISTS', record.name);
      return existing;
    }
    return record;
  }

  async get(identifier) {
    requiredText(identifier, 'application identifier');
    if (!/^[0-9a-f]{64}$/.test(identifier)) {
      const record = await readJsonIfExists(this.applicationPath(identifier));
      if (record === null) fail('ERR_APPLICATION_V1_APPLICATION_NOT_FOUND', identifier);
      const admitted = assertApplicationRecord(record);
      if (admitted.name !== identifier) fail('ERR_APPLICATION_V1_APPLICATION_REGISTRY');
      return admitted;
    }
    for (const record of await this.list()) {
      if (record.applicationId === identifier) return record;
    }
    fail('ERR_APPLICATION_V1_APPLICATION_NOT_FOUND', identifier);
  }

  async list() {
    const directory = path.join(this.root, 'applications');
    const entries = await readdir(directory).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const records = [];
    for (const entry of entries.sort()) {
      if (!/^[0-9a-f]{64}\.json$/.test(entry)) continue;
      records.push(assertApplicationRecord(await readJson(path.join(directory, entry))));
    }
    return records;
  }

  applicationPath(name) {
    return path.join(this.root, 'applications', `${sha256(Buffer.from(requiredText(name, 'application name'), 'utf8'))}.json`);
  }
}

export class DirectoryApplicationStoreV1 {
  constructor(storeRoot) {
    this.root = path.join(requiredRoot(storeRoot), 'application-v1');
    this.blockStore = new DirectoryBlockStore(this.root);
    this.headStore = new DirectoryBranchHeadStore(this.root, { blockStore: this.blockStore });
    this.effectJournal = new DirectoryEffectJournalV1({ root: this.root, blockStore: this.blockStore });
    this.applications = new DirectoryApplicationRegistryV1(this.root);
  }
}

function assertApplicationRecord(record) {
  if (!record || record.registryVersion !== 'world-host.application-registry-v1') {
    fail('ERR_APPLICATION_V1_APPLICATION_REGISTRY');
  }
  return Object.freeze({
    registryVersion: record.registryVersion,
    name: requiredText(record.name, 'application name'),
    applicationId: digestHex(record.applicationId, 'applicationId'),
    applicationVersion: requiredText(record.applicationVersion, 'applicationVersion'),
    wasmRef: assertBlockRef(record.wasmRef),
    manifestRef: assertBlockRef(record.manifestRef),
  });
}

function headDirectory(root, runId, branchId) {
  const scope = [requiredText(runId, 'runId'), requiredText(branchId, 'branchId')]
    .map((value) => `${Buffer.byteLength(value)}:${value}`)
    .join('');
  const checksum = sha256(Buffer.from(scope, 'utf8'));
  return path.join(root, 'heads', checksum.slice(0, 2), checksum);
}

function parseGenerationFile(name) {
  const match = /^(0|[1-9][0-9]*)\.json$/.exec(name);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function sameHead(left, right) {
  if (left === null || right === null) return left === right;
  return left.generation === right.generation &&
    left.applicationId === right.applicationId &&
    left.frameId === right.frameId &&
    left.frameRef.algorithm === right.frameRef.algorithm &&
    left.frameRef.checksum === right.frameRef.checksum &&
    left.frameRef.byteLength === right.frameRef.byteLength &&
    left.status === right.status;
}

async function writeBytesTemporary(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonNew(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeBytesTemporary(temporary, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
  try {
    await link(temporary, file);
    await fsyncDirectory(path.dirname(file));
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw error;
    fail('ERR_APPLICATION_V1_STORE_JSON', file);
  }
}

async function readJsonIfExists(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, 'r').catch(() => null);
  if (handle === null) return;
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function temporaryPath(root, label) {
  return path.join(root, 'tmp', `${label}.${randomUUID()}.tmp`);
}

function requiredRoot(value) {
  if (typeof value !== 'string' || value.length === 0) fail('ERR_APPLICATION_V1_STORE_ROOT');
  return path.resolve(value);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 4096) {
    fail('ERR_APPLICATION_V1_STORE_FIELD', label);
  }
  return value;
}

function digestHex(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('ERR_APPLICATION_V1_STORE_DIGEST', label);
  return value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameBytes(left, right) {
  return Buffer.from(left).equals(Buffer.from(right));
}
