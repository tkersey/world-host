import { BinaryReader, decodeHostRequest } from './world_appliance_wire_codec.mjs';

const textDecoder = new TextDecoder();

export function inspectTurnOutput(bytes) {
  const reader = new BinaryReader(bytes);
  reader.u32();
  reader.u32();
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
  reader.u64();
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
  const rootResultBytesLen = reader.bytesLen();
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
  if (reader.remaining() !== 0) throw new Error('trailing TurnClosure bytes');
  return {
    outputFingerprint: closureFingerprint,
    closureFingerprint,
    manifestFingerprint,
    turnSequenceNumber,
    resultingStateFingerprint,
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
  if (status === 2) return 'completed';
  if (status === 3) return 'failed';
  if (status === 4) return 'blocked';
  if (status === 5) return 'cancelled';
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
