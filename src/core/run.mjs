import { assertBlobRef, assertWorldFingerprint } from './store.mjs';
import { fail } from './store.mjs';

export function createRunRecord(input) {
  return Object.freeze({
    runId: requiredString(input.runId, 'runId'),
    applicationId: requiredString(input.applicationId, 'applicationId'),
    branches: Array.isArray(input.branches) ? input.branches : [],
    effectJournalNamespace: requiredString(input.effectJournalNamespace, 'effectJournalNamespace'),
    creationMetadata: input.creationMetadata ?? {},
    receiverPolicyRef: input.receiverPolicyRef ?? null,
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
  return Object.freeze({
    generation: integer(input.generation, 'generation'),
    turnClosureRef: assertBlobRef(input.turnClosureRef),
    turnClosureWorldFingerprint: assertWorldFingerprint(input.turnClosureWorldFingerprint, 'turnClosureWorldFingerprint'),
    resultingStateFingerprint: assertWorldFingerprint(input.resultingStateFingerprint, 'resultingStateFingerprint'),
    chronicleCursor: requiredString(input.chronicleCursor, 'chronicleCursor'),
    archiveMomentFingerprint: assertWorldFingerprint(input.archiveMomentFingerprint, 'archiveMomentFingerprint'),
    archiveSealFingerprint: assertWorldFingerprint(input.archiveSealFingerprint, 'archiveSealFingerprint'),
    status: requiredString(input.status, 'status'),
    updateDiagnostics: input.updateDiagnostics ?? {},
  });
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail('ERR_REQUIRED_FIELD', `${label} is required`);
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('ERR_REQUIRED_INTEGER', `${label} must be nonnegative integer`);
  return value;
}
