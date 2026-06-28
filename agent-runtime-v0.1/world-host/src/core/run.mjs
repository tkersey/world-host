import { assertBlobRef, assertWorldFingerprint } from './store.mjs';
import { fail } from './store.mjs';

export function createRunRecord(input) {
  return Object.freeze({
    runId: requiredString(input.runId, 'runId'),
    applicationId: requiredString(input.applicationId, 'applicationId'),
    branches: Array.isArray(input.branches) ? input.branches.map((branch) => createBranchRecord(branch)) : [],
    effectJournalNamespace: requiredString(input.effectJournalNamespace, 'effectJournalNamespace'),
    creationMetadata: input.creationMetadata ?? {},
    receiverPolicyRef: optionalBlobRef(input.receiverPolicyRef, 'receiverPolicyRef'),
    diagnostics: input.diagnostics ?? {},
  });
}

export function createBranchRecord(input) {
  return Object.freeze({
    branchId: requiredString(input.branchId, 'branchId'),
    parentBranchId: input.parentBranchId ?? null,
    forkedFromTurnClosureFingerprint: input.forkedFromTurnClosureFingerprint ?? null,
    currentHead: createRunHead(input.currentHead),
    diagnostics: input.diagnostics ?? {},
  });
}

export function createRunHead(input) {
  if (!input || typeof input !== 'object') fail('ERR_INVALID_RUN_HEAD');
  const archiveMomentFingerprint = optionalWorldFingerprint(input.archiveMomentFingerprint, 'archiveMomentFingerprint');
  const archiveSealFingerprint = optionalWorldFingerprint(input.archiveSealFingerprint, 'archiveSealFingerprint');
  if ((archiveMomentFingerprint == null) !== (archiveSealFingerprint == null)) {
    fail('ERR_ARCHIVE_ANCHOR_PAIR_REQUIRED', 'archive moment and seal must both be present or both be absent');
  }
  return Object.freeze({
    generation: integer(input.generation, 'generation'),
    turnClosureRef: assertBlobRef(input.turnClosureRef),
    turnClosureWorldFingerprint: assertWorldFingerprint(input.turnClosureWorldFingerprint, 'turnClosureWorldFingerprint'),
    resultingStateFingerprint: assertWorldFingerprint(input.resultingStateFingerprint, 'resultingStateFingerprint'),
    chronicleCursor: requiredString(input.chronicleCursor, 'chronicleCursor'),
    archiveMomentFingerprint,
    archiveSealFingerprint,
    status: requiredString(input.status, 'status'),
    updateDiagnostics: input.updateDiagnostics ?? {},
  });
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail('ERR_REQUIRED_FIELD', `${label} is required`);
  return value;
}

function optionalWorldFingerprint(value, label) {
  return value == null ? null : assertWorldFingerprint(value, label);
}

function optionalBlobRef(value, label) {
  try {
    return value == null ? null : assertBlobRef(value);
  } catch (error) {
    if (error?.code === 'ERR_INVALID_BLOB_REF') {
      fail('ERR_INVALID_BLOB_REF', `${label} must be a BlobRef`);
    }
    throw error;
  }
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('ERR_REQUIRED_INTEGER', `${label} must be nonnegative integer`);
  return value;
}
