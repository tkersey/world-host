import { carrierVersionSummary } from '../protocol/world_manifest.mjs';
import { EffectRecoveryClass } from './actuator.mjs';
import { createBranchRecord, createRunRecord } from './run.mjs';
import { fail } from './store.mjs';

export async function forkRunBranch(store, { runId, sourceBranchId, sourceClosureFingerprint, newBranchId }) {
  const run = await store.getRun(runId);
  const sourceHead = await store.readHead(runId, sourceBranchId);
  if (sourceClosureFingerprint && sourceHead.turnClosureWorldFingerprint !== sourceClosureFingerprint) {
    fail('ERR_FORK_SOURCE_CLOSURE_NOT_CURRENT', 'v0 fork requires a stored source closure head');
  }
  const branch = createBranchRecord({
    branchId: newBranchId,
    parentBranchId: sourceBranchId,
    forkedFromTurnClosureFingerprint: sourceHead.turnClosureWorldFingerprint,
    currentHead: sourceHead,
    diagnostics: { sourceRunId: run.runId },
  });
  try {
    await store.readHead(runId, newBranchId);
    fail('ERR_BRANCH_EXISTS');
  } catch (error) {
    if (error?.code !== 'ERR_HEAD_NOT_FOUND') throw error;
  }
  await writeBranchHead(store, runId, newBranchId, sourceHead);
  await writeRunRecord(store, createRunRecord({
    ...run,
    branches: [...(run.branches ?? []).filter((existing) => existing.branchId !== newBranchId), branch],
  }));
  return branch;
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
    store.heads.set(`${runId}\0${branchId}`, JSON.parse(JSON.stringify(head)));
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
