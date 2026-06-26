import { carrierVersionSummary } from '../protocol/world_manifest.mjs';
import { summarizeTurnClosureForRunHead } from '../protocol/world_universal_appliance_codec.mjs';
import { EffectRecoveryClass } from './actuator.mjs';
import { createBranchRecord, createRunHead, createRunRecord } from './run.mjs';
import { fail, stableJson } from './store.mjs';

export async function forkRunBranch(store, { runId, sourceBranchId, sourceClosureFingerprint, newBranchId }) {
  const run = await store.getRun(runId);
  const sourceHead = await store.readHead(runId, sourceBranchId);
  let existingHead = null;
  try {
    existingHead = await store.readHead(runId, newBranchId);
  } catch (error) {
    if (error?.code !== 'ERR_HEAD_NOT_FOUND') throw error;
  }
  const branchAlreadyPublished = (run.branches ?? []).some((existing) => existing.branchId === newBranchId);
  let forkHead = sourceHead;
  if (sourceClosureFingerprint && sourceHead.turnClosureWorldFingerprint !== sourceClosureFingerprint) {
    if (existingHead && !branchAlreadyPublished && existingHead.turnClosureWorldFingerprint === sourceClosureFingerprint) {
      forkHead = existingHead;
    } else {
      forkHead = await storedTurnClosureHead(store, run, sourceBranchId, sourceClosureFingerprint);
      if (!forkHead) fail('ERR_FORK_SOURCE_CLOSURE_NOT_STORED', 'fork requires a stored source closure');
    }
  }
  const branch = createBranchRecord({
    branchId: newBranchId,
    parentBranchId: sourceBranchId,
    forkedFromTurnClosureFingerprint: forkHead.turnClosureWorldFingerprint,
    currentHead: forkHead,
    diagnostics: { sourceRunId: run.runId },
  });
  if (existingHead) {
    if (branchAlreadyPublished || stableJson(existingHead) !== stableJson(forkHead)) fail('ERR_BRANCH_EXISTS');
  } else {
    await writeBranchHead(store, runId, newBranchId, forkHead);
  }
  await writeRunRecord(store, createRunRecord({
    ...run,
    branches: [...(run.branches ?? []).filter((existing) => existing.branchId !== newBranchId), branch],
  }));
  return branch;
}

async function storedTurnClosureHead(store, run, sourceBranchId, sourceClosureFingerprint) {
  if (!selectedBranchClosureFingerprints(run, sourceBranchId).has(sourceClosureFingerprint)) return null;
  for (const head of selectedBranchHistoricalHeads(run, sourceBranchId)) {
    if (head.turnClosureWorldFingerprint !== sourceClosureFingerprint) continue;
    let summary;
    try {
      summary = summarizeTurnClosureForRunHead(await store.getBlob(head.turnClosureRef));
    } catch {
      continue;
    }
    if (summary.turnClosureWorldFingerprint !== sourceClosureFingerprint) continue;
    return createRunHead({
      ...head,
      updateDiagnostics: { ...head.updateDiagnostics, selectedStoredClosure: true, inspectedTurnClosure: summary.inspectionDiagnostics },
    });
  }
  const refs = selectedBranchClosureRefs(run, sourceBranchId);
  for (const ref of refs) {
    let summary;
    try {
      summary = summarizeTurnClosureForRunHead(await store.getBlob(ref));
    } catch {
      continue;
    }
    if (summary.turnClosureWorldFingerprint !== sourceClosureFingerprint) continue;
    const closureGeneration = summary.inspectionDiagnostics.turnSequenceNumber;
    if (!Number.isSafeInteger(closureGeneration) || closureGeneration < 0) fail('ERR_FORK_SOURCE_CLOSURE_NOT_STORED', 'stored source closure has an invalid turn sequence');
    return createRunHead({
      generation: closureGeneration + 1,
      turnClosureRef: ref,
      turnClosureWorldFingerprint: summary.turnClosureWorldFingerprint,
      resultingStateFingerprint: summary.resultingStateFingerprint,
      chronicleCursor: summary.chronicleCursor,
      archiveMomentFingerprint: summary.archiveMomentFingerprint,
      archiveSealFingerprint: summary.archiveSealFingerprint,
      status: summary.status,
      updateDiagnostics: { selectedStoredClosure: true, inspectedTurnClosure: summary.inspectionDiagnostics },
    });
  }
  return null;
}

function selectedBranchClosureRefs(run, sourceBranchId) {
  const refs = [];
  for (const branch of run.branches ?? []) {
    if (branch.branchId !== sourceBranchId) continue;
    addRef(refs, branch.currentHead?.turnClosureRef);
    for (const ref of branch.diagnostics?.historicalTurnClosureRefs ?? []) addRef(refs, ref);
    for (const head of branch.diagnostics?.historicalRunHeads ?? []) addRef(refs, head?.turnClosureRef);
  }
  return refs;
}

function selectedBranchClosureFingerprints(run, sourceBranchId) {
  const fingerprints = new Set();
  for (const branch of run.branches ?? []) {
    if (branch.branchId !== sourceBranchId) continue;
    addFingerprint(fingerprints, branch.currentHead?.turnClosureWorldFingerprint);
    addFingerprint(fingerprints, branch.forkedFromTurnClosureFingerprint);
    for (const fingerprint of branch.diagnostics?.historicalTurnClosureFingerprints ?? []) addFingerprint(fingerprints, fingerprint);
    for (const head of branch.diagnostics?.historicalRunHeads ?? []) addFingerprint(fingerprints, head?.turnClosureWorldFingerprint);
  }
  return fingerprints;
}

function selectedBranchHistoricalHeads(run, sourceBranchId) {
  const heads = [];
  for (const branch of run.branches ?? []) {
    if (branch.branchId !== sourceBranchId) continue;
    for (const head of branch.diagnostics?.historicalRunHeads ?? []) {
      if (head && typeof head === 'object' && typeof head.turnClosureWorldFingerprint === 'string' && !heads.some((item) => item.turnClosureWorldFingerprint === head.turnClosureWorldFingerprint)) {
        heads.push(createRunHead(head));
      }
    }
  }
  return heads;
}

function addFingerprint(fingerprints, value) {
  if (typeof value === 'string' && value.length > 0) fingerprints.add(value);
}

function addRef(refs, value) {
  if (!value || typeof value !== 'object') return;
  if (!refs.some((item) => item.checksum === value.checksum && item.byteLength === value.byteLength)) refs.push(value);
}

export async function exportCarrierRun(store, runId, branchId, options = {}) {
  const bundle = await store.exportRun(runId, branchId);
  return Object.freeze({
    carrierExportVersion: 'CarrierExport-v0',
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    release: carrierVersionSummary(),
    authorityCarried: false,
    selectedRunId: runId,
    selectedBranchId: branchId,
    bundle,
    diagnostics: { exportPolicy: options.exportPolicy ?? 'selected-branch' },
  });
}

export async function importCarrierRun(store, carrierExport, options = {}) {
  if (carrierExport?.carrierExportVersion !== 'CarrierExport-v0') fail('ERR_INVALID_CARRIER_EXPORT');
  if (stableJson(carrierExport.release) !== stableJson(carrierVersionSummary())) fail('ERR_IMPORT_RELEASE_MISMATCH');
  rejectUnrecoverableEffects(carrierExport.bundle.effects ?? []);
  if (typeof options.preflight === 'function') {
    const report = await options.preflight(carrierExport);
    if (report?.blockers?.length) fail('ERR_IMPORT_PREFLIGHT_BLOCKED', 'receiver capability preflight rejected import', { blockers: report.blockers });
  }
  const receiverRunId = options.runId ?? `${carrierExport.bundle.run.runId}:imported`;
  const bundle = rewriteRunBundle(carrierExport.bundle, receiverRunId);
  await store.importRun(bundle);
  return {
    run: await store.getRun(receiverRunId),
    branchId: bundle.branchId,
    authorityImported: false,
    receiverPolicyApplied: typeof options.preflight === 'function',
  };
}

export function createCarrierProofBundle({ runId, branchId, head, effects = [], recoveryActions = [], conformance = [] }) {
  return Object.freeze({
    proofBundleVersion: 'CarrierProofBundle-v0',
    runId,
    branchId,
    headGeneration: head?.generation,
    turnClosureRef: head?.turnClosureRef,
    turnClosureWorldFingerprint: head?.turnClosureWorldFingerprint,
    effectIds: effects.map((effect) => effect.idempotencyKeyWorldFingerprint ?? effect.idempotencyKey?.bytesHex),
    recoveryActions,
    conformance,
    changesWorldFingerprints: false,
  });
}

function rejectUnrecoverableEffects(effects) {
  for (const effect of effects) {
    if (effect.state === 'running' && effect.driverRecoveryClass === EffectRecoveryClass.bestEffort) {
      fail('ERR_IMPORT_UNRECOVERABLE_EFFECT_RUNNING');
    }
  }
}

function rewriteRunBundle(bundle, runId) {
  const selectedBranch = (bundle.run.branches ?? []).find((branch) => branch.branchId === bundle.branchId);
  const branch = createBranchRecord({
    ...(selectedBranch ?? { branchId: bundle.branchId }),
    currentHead: bundle.head,
  });
  return {
    ...bundle,
    run: { ...bundle.run, runId, branches: [branch] },
    head: bundle.head,
    effects: (bundle.effects ?? [])
      .filter((effect) => effect.branchId === bundle.branchId)
      .map((effect) => ({ ...effect, runId })),
    branchId: bundle.branchId,
  };
}

async function writeBranchHead(store, runId, branchId, head) {
  if (typeof store.writeHead === 'function') return await store.writeHead(runId, branchId, head);
  if (store.heads instanceof Map) {
    store.heads.set(stableJson([runId, branchId]), JSON.parse(JSON.stringify(head)));
    return head;
  }
  fail('ERR_STORE_BRANCH_CREATE_UNSUPPORTED');
}

async function writeRunRecord(store, run) {
  if (typeof store.writeRun === 'function') return await store.writeRun(run);
  if (store.runs instanceof Map) {
    store.runs.set(run.runId, JSON.parse(JSON.stringify(run)));
    return run;
  }
  fail('ERR_STORE_RUN_UPDATE_UNSUPPORTED');
}
