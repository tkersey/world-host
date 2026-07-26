import { createHash } from 'node:crypto';

import { assertBytes, fail } from './errors.mjs';

export class BlockStore {
  async putBlock() { fail('ERR_APPLICATION_V1_ABSTRACT_STORE'); }
  async getBlock() { fail('ERR_APPLICATION_V1_ABSTRACT_STORE'); }
  async hasBlock() { fail('ERR_APPLICATION_V1_ABSTRACT_STORE'); }
}

export class BranchHeadStore {
  async readHead() { fail('ERR_APPLICATION_V1_ABSTRACT_HEAD_STORE'); }
  async advanceHeadIfCurrent() { fail('ERR_APPLICATION_V1_ABSTRACT_HEAD_STORE'); }
}

export class MemoryBlockStore extends BlockStore {
  constructor() {
    super();
    this.blocks = new Map();
  }

  async putBlock(blockBytes) {
    const bytes = Buffer.from(assertBytes(blockBytes, 'blockBytes'));
    const ref = blockRef(bytes);
    const previous = this.blocks.get(ref.checksum);
    if (previous !== undefined && !previous.equals(bytes)) fail('ERR_APPLICATION_V1_BLOCK_COLLISION');
    if (previous === undefined) this.blocks.set(ref.checksum, bytes);
    return ref;
  }

  async getBlock(ref) {
    const admitted = assertBlockRef(ref);
    const bytes = this.blocks.get(admitted.checksum);
    if (bytes === undefined) fail('ERR_APPLICATION_V1_BLOCK_NOT_FOUND', admitted.checksum);
    if (bytes.length !== admitted.byteLength || blockRef(bytes).checksum !== admitted.checksum) {
      fail('ERR_APPLICATION_V1_BLOCK_CORRUPT');
    }
    return Buffer.from(bytes);
  }

  async hasBlock(ref) {
    const admitted = assertBlockRef(ref);
    const bytes = this.blocks.get(admitted.checksum);
    return bytes !== undefined && bytes.length === admitted.byteLength;
  }
}

export class MemoryBranchHeadStore extends BranchHeadStore {
  constructor() {
    super();
    this.heads = new Map();
  }

  async readHead(runId, branchId) {
    const current = this.heads.get(headKey(runId, branchId));
    return current === undefined ? null : cloneHead(current);
  }

  async advanceHeadIfCurrent(runId, branchId, expected, next) {
    const key = headKey(runId, branchId);
    const current = this.heads.get(key) ?? null;
    if (!sameHead(current, expected)) {
      return Object.freeze({ advanced: false, current: current === null ? null : cloneHead(current) });
    }
    const admittedNext = assertHead(next);
    const requiredGeneration = current === null ? 0 : current.generation + 1;
    if (admittedNext.generation !== requiredGeneration) fail('ERR_APPLICATION_V1_HEAD_GENERATION');
    if (current !== null && admittedNext.applicationId !== current.applicationId) fail('ERR_APPLICATION_V1_HEAD_APPLICATION');
    this.heads.set(key, admittedNext);
    return Object.freeze({ advanced: true, current: cloneHead(admittedNext) });
  }
}

export function blockRef(blockBytes) {
  const bytes = Buffer.from(assertBytes(blockBytes, 'blockBytes'));
  return Object.freeze({
    algorithm: 'sha256',
    checksum: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
  });
}

export function assertBlockRef(ref) {
  if (!ref || ref.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/.test(ref.checksum) ||
      !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
    fail('ERR_APPLICATION_V1_BLOCK_REF');
  }
  return Object.freeze({ algorithm: 'sha256', checksum: ref.checksum, byteLength: ref.byteLength });
}

export function makeHead({
  generation,
  applicationId,
  frameId,
  frameRef,
  status,
  journalBindingId = null,
}) {
  return assertHead({ generation, applicationId, frameId, frameRef, status, journalBindingId });
}

function assertHead(head) {
  if (!head || !Number.isSafeInteger(head.generation) || head.generation < 0 ||
      !/^[0-9a-f]{64}$/.test(head.applicationId) || !/^[0-9a-f]{64}$/.test(head.frameId) ||
      !Number.isInteger(head.status) || head.status < 0 || head.status > 4) {
    fail('ERR_APPLICATION_V1_HEAD');
  }
  return Object.freeze({
    generation: head.generation,
    applicationId: head.applicationId,
    frameId: head.frameId,
    frameRef: assertBlockRef(head.frameRef),
    status: head.status,
    journalBindingId: optionalDigest(head.journalBindingId, 'journalBindingId'),
  });
}

function cloneHead(head) {
  return assertHead(head);
}

function sameHead(left, right) {
  if (left === null || right === null) return left === right;
  const admittedRight = assertHead(right);
  return left.generation === admittedRight.generation &&
    left.applicationId === admittedRight.applicationId &&
    left.frameId === admittedRight.frameId &&
    left.frameRef.checksum === admittedRight.frameRef.checksum &&
    left.frameRef.byteLength === admittedRight.frameRef.byteLength &&
    left.status === admittedRight.status &&
    left.journalBindingId === admittedRight.journalBindingId;
}

function optionalDigest(value, label) {
  if (value === null || value === undefined) return null;
  if (!/^[0-9a-f]{64}$/.test(value)) fail('ERR_APPLICATION_V1_HEAD', label);
  return value;
}

function headKey(runId, branchId) {
  if (typeof runId !== 'string' || runId.length === 0 || typeof branchId !== 'string' || branchId.length === 0) {
    fail('ERR_APPLICATION_V1_HEAD_KEY');
  }
  return `${runId.length}:${runId}${branchId.length}:${branchId}`;
}
