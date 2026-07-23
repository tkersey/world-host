import { createHash } from 'node:crypto';

import { fail } from './errors.mjs';
import {
  createEffectResult,
  decodeEffectResult,
  validateEffectResultForRequest,
} from './protocol.mjs';

export class EffectJournalV1 {
  async persistResult() { fail('ERR_APPLICATION_V1_ABSTRACT_EFFECT_JOURNAL'); }
  async readResult() { fail('ERR_APPLICATION_V1_ABSTRACT_EFFECT_JOURNAL'); }
}

export class MemoryEffectJournalV1 extends EffectJournalV1 {
  constructor({ blockStore }) {
    super();
    if (!blockStore) fail('ERR_APPLICATION_V1_EFFECT_JOURNAL_STORE');
    this.blockStore = blockStore;
    this.records = new Map();
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
    const key = effectJournalKey(runId, branchId, parentFrameId, request.requestId);
    const previous = this.records.get(key);
    if (previous !== undefined) {
      if (previous.resultId !== hex(admittedResult.resultId)) fail('ERR_APPLICATION_V1_EFFECT_RESULT_CONFLICT');
      return cloneRecord(previous);
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
    this.records.set(key, record);
    return cloneRecord(record);
  }

  async readResult({ runId, branchId, parentFrameId, request, limits }) {
    const record = this.records.get(effectJournalKey(runId, branchId, parentFrameId, request.requestId));
    if (record === undefined) return null;
    return await readEffectJournalResult({ record, blockStore: this.blockStore, request, limits });
  }
}

export function admitEffectJournalResult(request, result, limits) {
  const admitted = result?.encodedBytes instanceof Uint8Array
    ? decodeEffectResult(result.encodedBytes, limits)
    : result instanceof Uint8Array
      ? decodeEffectResult(result, limits)
      : createEffectResult(result, limits);
  validateEffectResultForRequest(request, admitted, limits);
  return admitted;
}

export function createEffectJournalRecord({
  runId,
  branchId,
  parentFrameId,
  request,
  result,
  resultRef,
  handlerId,
  handlerConfigurationId,
  recoveryClass,
  externalTransactionRef,
}) {
  return assertEffectJournalRecord({
    journalVersion: 'world-host.effect-journal-v1',
    runId,
    branchId,
    parentFrameId: digestHex(parentFrameId, 'parentFrameId'),
    requestId: hex(request.requestId),
    requestArtifactChecksum: requestArtifactChecksum(request),
    idempotencyKey: hex(request.idempotencyKey),
    interfaceId: hex(request.interfaceId),
    handlerId,
    handlerConfigurationId,
    recoveryClass,
    state: 'resolved',
    resultId: hex(result.resultId),
    resultRef,
    externalTransactionRef,
  });
}

export function assertEffectJournalRecord(record) {
  if (!record || record.journalVersion !== 'world-host.effect-journal-v1' || record.state !== 'resolved') {
    fail('ERR_APPLICATION_V1_EFFECT_JOURNAL_RECORD');
  }
  return Object.freeze({
    journalVersion: record.journalVersion,
    runId: requiredText(record.runId, 'runId'),
    branchId: requiredText(record.branchId, 'branchId'),
    parentFrameId: digestHex(record.parentFrameId, 'parentFrameId'),
    requestId: digestHex(record.requestId, 'requestId'),
    requestArtifactChecksum: digestHex(record.requestArtifactChecksum, 'requestArtifactChecksum'),
    idempotencyKey: digestHex(record.idempotencyKey, 'idempotencyKey'),
    interfaceId: digestHex(record.interfaceId, 'interfaceId'),
    handlerId: requiredText(record.handlerId, 'handlerId'),
    handlerConfigurationId: requiredText(record.handlerConfigurationId, 'handlerConfigurationId'),
    recoveryClass: requiredText(record.recoveryClass, 'recoveryClass'),
    state: record.state,
    resultId: digestHex(record.resultId, 'resultId'),
    resultRef: assertResultRef(record.resultRef),
    externalTransactionRef: optionalText(record.externalTransactionRef, 'externalTransactionRef'),
  });
}

export async function readEffectJournalResult({ record, blockStore, request, limits }) {
  const admitted = assertEffectJournalRecord(record);
  if (admitted.requestId !== hex(request.requestId) || admitted.idempotencyKey !== hex(request.idempotencyKey) ||
      admitted.requestArtifactChecksum !== requestArtifactChecksum(request)) {
    fail('ERR_APPLICATION_V1_EFFECT_JOURNAL_MISMATCH');
  }
  const bytes = await blockStore.getBlock(admitted.resultRef);
  const result = decodeEffectResult(bytes, limits);
  validateEffectResultForRequest(request, result, limits);
  if (hex(result.resultId) !== admitted.resultId) fail('ERR_APPLICATION_V1_EFFECT_JOURNAL_MISMATCH');
  return Object.freeze({ record: cloneRecord(admitted), result });
}

export function effectJournalKey(runId, branchId, parentFrameId, requestId) {
  return [
    requiredText(runId, 'runId'),
    requiredText(branchId, 'branchId'),
    digestHex(parentFrameId, 'parentFrameId'),
    digestHex(requestId, 'requestId'),
  ].map((part) => `${part.length}:${part}`).join('');
}

function requestArtifactChecksum(request) {
  if (!(request?.encodedBytes instanceof Uint8Array)) fail('ERR_APPLICATION_V1_EFFECT_REQUEST_BYTES');
  return createHash('sha256').update(request.encodedBytes).digest('hex');
}

export function cloneEffectJournalRecord(record) {
  return cloneRecord(assertEffectJournalRecord(record));
}

function cloneRecord(record) {
  return Object.freeze({ ...record, resultRef: Object.freeze({ ...record.resultRef }) });
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail('ERR_APPLICATION_V1_EFFECT_JOURNAL_FIELD', label);
  return value;
}

function optionalText(value, label) {
  if (value === null || value === undefined) return null;
  return requiredText(value, label);
}

function assertResultRef(ref) {
  if (!ref || ref.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/.test(ref.checksum) ||
      !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
    fail('ERR_APPLICATION_V1_EFFECT_JOURNAL_RESULT_REF');
  }
  return Object.freeze({ algorithm: 'sha256', checksum: ref.checksum, byteLength: ref.byteLength });
}

function digestHex(value, label) {
  if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) return value;
  if (value instanceof Uint8Array && value.length === 32) return hex(value);
  fail('ERR_APPLICATION_V1_EFFECT_JOURNAL_DIGEST', label);
}

function hex(value) {
  return Buffer.from(value).toString('hex');
}
