import { BinaryReader, decodeHostRequest } from './world_appliance_wire_codec.mjs';

const textDecoder = new TextDecoder();

export function inspectTurnOutput(bytes) {
  const reader = new BinaryReader(bytes);
  const formatVersion = reader.u32();
  const fingerprintVersion = reader.u32();
  if (formatVersion !== 1) throw new Error(`unsupported TurnClosure format version: ${formatVersion}`);
  if (fingerprintVersion !== 1) throw new Error(`unsupported TurnClosure fingerprint version: ${fingerprintVersion}`);
  const closureFingerprint = reader.u64();
  reader.u64();
  const manifestFingerprint = reader.u64();
  reader.optionalU64();
  const turnSequenceNumber = reader.u64();
  reader.u64();
  const resultingStateFingerprint = reader.u64();
  reader.u64();
  const chronicleResultingCursorFingerprint = reader.u64();
  reader.optionalU64();
  reader.optionalU64();
  const archiveResultingMomentFingerprint = reader.optionalU64();
  const archiveResultingSealFingerprint = reader.optionalU64();
  reader.u64();
  reader.bytesLen();
  const capsuleFingerprint = reader.u64();
  reader.bytesLen();
  reader.u64();
  const turnReceiptBytes = reader.bytes();
  const turnReceipt = new BinaryReader(turnReceiptBytes).readTurnReceipt();
  reader.bytesLen();
  const archiveAppendFingerprint = reader.optionalU64();
  const archiveAppendBytesLen = reader.bytesLen();
  const pendingHostRequestBytes = reader.bytes();
  const hostRequests = decodeHostRequestsImage(pendingHostRequestBytes);
  const rootResultFingerprint = reader.optionalU64();
  const rootResultBytes = reader.bytes();
  const rootResultBytesLen = rootResultBytes.byteLength;
  reader.optionalU64();
  reader.optionalU64();
  reader.bytesLen();
  reader.skipU64Slice();
  reader.skipByteSlices();
  reader.skipU64Slice();
  reader.skipByteSlices();
  reader.skipU64Slice();
  reader.skipU64Slice();
  reader.skipU64Slice();
  reader.bytesLen();
  const status = reader.u8();
  assertReceiptMatchesClosure(turnReceipt, {
    manifestFingerprint,
    turnSequenceNumber,
    resultingStateFingerprint,
    capsuleFingerprint,
    chronicleResultingCursorFingerprint,
    archiveAppendFingerprint,
    archiveResultingMomentFingerprint,
    archiveResultingSealFingerprint,
    rootResultFingerprint,
    rootResultBytes,
    status,
    hostRequests,
  });
  if (reader.remaining() !== 0) throw new Error('trailing TurnClosure bytes');
  return {
    outputFingerprint: closureFingerprint,
    closureFingerprint,
    manifestFingerprint,
    turnSequenceNumber,
    resultingStateFingerprint,
    capsuleFingerprint,
    chronicleResultingCursorFingerprint,
    archiveResultingMomentFingerprint,
    archiveResultingSealFingerprint,
    status,
    hostRequestCount: hostRequests.length,
    hostRequests,
    rootResultFingerprint,
    rootResultBytesLen,
    archiveAppendFingerprint,
    archiveAppendBytesLen,
    turnReceipt,
  };
}

function assertReceiptMatchesClosure(receipt, closure) {
  if (receipt.manifestFingerprint !== closure.manifestFingerprint) throw new Error('TurnReceipt manifest does not match TurnClosure manifest');
  if (receipt.turnSequenceNumber !== closure.turnSequenceNumber) throw new Error('TurnReceipt sequence does not match TurnClosure sequence');
  if (receipt.resultingCapsuleFingerprint !== closure.capsuleFingerprint) throw new Error('TurnReceipt resulting capsule does not match TurnClosure capsule');
  if (receipt.resultingChronicleCursorFingerprint != null && receipt.resultingChronicleCursorFingerprint !== closure.chronicleResultingCursorFingerprint) throw new Error('TurnReceipt chronicle cursor does not match TurnClosure chronicle cursor');
  assertOptionalFingerprintMatches(receipt.archiveAppendBatchFingerprint, closure.archiveAppendFingerprint, 'TurnReceipt archive append does not match TurnClosure archive append');
  assertOptionalFingerprintMatches(receipt.resultingArchiveMomentFingerprint, closure.archiveResultingMomentFingerprint, 'TurnReceipt archive moment does not match TurnClosure archive moment');
  assertOptionalFingerprintMatches(receipt.resultingArchiveSealFingerprint, closure.archiveResultingSealFingerprint, 'TurnReceipt archive seal does not match TurnClosure archive seal');
  assertRootResultMatchesClosure(receipt.rootResultFingerprint, closure.rootResultFingerprint, closure.rootResultBytes);
  if (closureStatusForReceiptStatus(receipt.status) !== closure.status) throw new Error('TurnReceipt status does not map to TurnClosure status');
  assertEmittedHostRequestsMatch(receipt.emittedHostRequestFingerprints, closure.hostRequests);
}

function assertOptionalFingerprintMatches(receiptValue, closureValue, message) {
  if (receiptValue == null && closureValue == null) return;
  if (receiptValue === closureValue) return;
  throw new Error(message);
}

function assertEmittedHostRequestsMatch(emittedFingerprints, hostRequests) {
  if (emittedFingerprints.length !== hostRequests.length) throw new Error('TurnReceipt emitted HostRequest count does not match TurnClosure pending request count');
  const emitted = new Set(emittedFingerprints.map((value) => value.toString()));
  for (const request of hostRequests) {
    if (!emitted.has(request.requestFingerprint.toString())) throw new Error('TurnReceipt emitted HostRequests do not match TurnClosure pending requests');
  }
}

function assertRootResultMatchesClosure(receiptValue, closureValue, rootResultBytes) {
  if (receiptValue == null) {
    if (closureValue == null && rootResultBytes.byteLength === 0) return;
    throw new Error('TurnReceipt root result does not match TurnClosure root result');
  }
  if (closureValue == null || rootResultBytes.byteLength === 0) throw new Error('TurnReceipt root result does not match TurnClosure root result');
  const reader = new BinaryReader(rootResultBytes);
  const labelLength = reader.u32();
  reader.require(labelLength);
  const label = textDecoder.decode(rootResultBytes.slice(reader.offset, reader.offset + labelLength));
  reader.offset += labelLength;
  const value = reader.u64();
  if (reader.remaining() !== 0 || label !== 'world.appliance.root_result.value_image' || value !== receiptValue) {
    throw new Error('TurnReceipt root result does not match TurnClosure root result');
  }
}

function closureStatusForReceiptStatus(status) {
  if (status === 0) return 0;
  if (status === 1) return 2;
  if (status === 2) return 3;
  if (status === 3) return 1;
  if (status === 4) return 4;
  if (status === 5) return 5;
  return null;
}

export function summarizeTurnClosureForRunHead(bytes) {
  const summary = inspectTurnOutput(bytes);
  const receipt = summary.turnReceipt;
  return Object.freeze({
    turnClosureWorldFingerprint: worldFingerprint('turn-closure', summary.closureFingerprint),
    resultingStateFingerprint: worldFingerprint('state', summary.resultingStateFingerprint),
    chronicleCursor: worldFingerprint('chronicle-cursor', summary.chronicleResultingCursorFingerprint),
    archiveMomentFingerprint: optionalWorldFingerprint('archive-moment', summary.archiveResultingMomentFingerprint ?? receipt.resultingArchiveMomentFingerprint),
    archiveSealFingerprint: optionalWorldFingerprint('archive-seal', summary.archiveResultingSealFingerprint ?? receipt.resultingArchiveSealFingerprint),
    status: closureStatusLabel(summary.status),
    inspectionDiagnostics: Object.freeze({
      manifestFingerprint: worldFingerprint('manifest', summary.manifestFingerprint),
      turnSequenceNumber: Number(summary.turnSequenceNumber),
      turnReceiptFingerprint: worldFingerprint('turn-receipt', receipt.receiptFingerprint),
      archiveAppendBatchFingerprint: receipt.archiveAppendBatchFingerprint == null ? null : worldFingerprint('archive-append-batch', receipt.archiveAppendBatchFingerprint),
      rootResultFingerprint: summary.rootResultFingerprint == null ? null : worldFingerprint('root-result', summary.rootResultFingerprint),
      appliedHostReplyFingerprints: receipt.appliedHostReplyFingerprints.map(fingerprintString),
      hostRequestCount: summary.hostRequestCount,
      outputFingerprint: worldFingerprint('turn-output', summary.outputFingerprint),
    }),
  });
}

function decodeHostRequestsImage(bytes) {
  if (bytes.length === 0) return [];
  const reader = new BinaryReader(bytes);
  const count = Number(reader.u64());
  const requests = [];
  for (let i = 0; i < count; i += 1) requests.push(decodeHostRequest(reader));
  if (reader.remaining() !== 0) throw new Error('trailing HostRequest bytes');
  return requests;
}

export function decodeUtf8(bytes) {
  return textDecoder.decode(bytes);
}

function closureStatusLabel(status) {
  if (status === 0) return 'needs_host';
  if (status === 1) return 'yielded_budget';
  if (status === 2) return 'completed';
  if (status === 3) return 'failed';
  if (status === 4) return 'cancelled';
  if (status === 5) return 'inspected';
  return `world-status:${status}`;
}

function worldFingerprint(kind, value) {
  if (value == null) throw new Error(`missing ${kind} fingerprint`);
  return `world:${kind}:${value.toString(16).padStart(16, '0')}`;
}

function fingerprintString(value) {
  return value.toString(16).padStart(16, '0');
}

function optionalWorldFingerprint(kind, value) {
  return value == null ? null : worldFingerprint(kind, value);
}
