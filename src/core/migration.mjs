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
  const receiverRunId = options.runId ?? `${carrierExport.bundle.run.runId}:imported`;
  const bundle = rewriteRunBundle(carrierExport.bundle, receiverRunId);
  const importCandidate = {
    ...carrierExport,
    selectedRunId: receiverRunId,
    selectedBranchId: bundle.branchId,
    bundle,
  };
  if (typeof options.preflight === 'function') {
    const report = await options.preflight(importCandidate);
    if (report?.blockers?.length) fail('ERR_IMPORT_PREFLIGHT_BLOCKED', 'receiver capability preflight rejected import', { blockers: report.blockers });
  }
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
  const head = scrubReceiverPolicyRefs(bundle.head);
  const branch = createBranchRecord({
    ...(selectedBranch ?? { branchId: bundle.branchId }),
    currentHead: head,
  });
  const effects = (bundle.effects ?? [])
    .filter((effect) => effect.branchId === bundle.branchId)
    .map((effect) => scrubReceiverPolicyRefs({ ...effect, runId }));
  const application = scrubReceiverPolicyRefs(bundle.application);
  const run = scrubReceiverPolicyRefs({
    ...bundle.run,
    runId,
    branches: [branch],
    receiverPolicyRef: null,
  });
  const rewritten = {
    ...bundle,
    application,
    run,
    head,
    effects,
    branchId: bundle.branchId,
  };
  return {
    ...rewritten,
    blobs: filterReferencedBlobs(rewritten),
  };
}

function filterReferencedBlobs(bundle) {
  const required = new Set();
  collectBlobRefs(required, bundle.run, bundle.application, bundle.head, bundle.effects ?? []);
  return (bundle.blobs ?? []).filter((blob) => required.has(`${blob.checksum}:${blob.byteLength}`));
}

function scrubReceiverPolicyRefs(value) {
  if (Array.isArray(value)) return value.map((child) => scrubReceiverPolicyRefs(child));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'receiverPolicyRef' || key === 'receiverPolicyRefs') continue;
    out[key] = scrubReceiverPolicyRefs(child);
  }
  return out;
}

function collectBlobRefs(required, ...values) {
  for (const value of values) collectOwnedRefs(value);

  function add(ref) {
    if (!ref || typeof ref !== 'object') return;
    if (typeof ref.checksum === 'string' && Number.isSafeInteger(ref.byteLength)) {
      required.add(`${ref.checksum}:${ref.byteLength}`);
    }
  }

  function collectOwnedRefs(value) {
    if (Array.isArray(value)) {
      for (const child of value) collectOwnedRefs(child);
      return;
    }
    if (!value || typeof value !== 'object') return;
    add(value.executableImageRef);
    add(value.applianceManifestRef);
    add(value.turnClosureRef);
    add(value.requestBytesRef);
    add(value.effectIdentityBytesRef);
    add(value.resolutionInputRef);
    add(value.hostClaimRef);
    add(value.receiverPolicyRef);
    add(universalWasmRef(value));
    collectDiagnosticBlobRefs(value.diagnostics);
    collectDiagnosticBlobRefs(value.installationDiagnostics);
    collectDiagnosticBlobRefs(value.creationMetadata);
    collectDiagnosticBlobRefs(value.metadata);
    collectDiagnosticBlobRefs(value.updateDiagnostics);
    for (const branch of value.branches ?? []) {
      collectOwnedRefs(branch.currentHead);
      collectDiagnosticBlobRefs(branch.diagnostics);
      collectDiagnosticBlobRefs(branch.metadata);
    }
  }

  function collectDiagnosticBlobRefs(value, key = '') {
    if (Array.isArray(value)) {
      for (const child of value) collectDiagnosticBlobRefs(child, key.endsWith('Refs') ? 'Ref' : '');
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (key.endsWith('Ref')) add(value);
    for (const [childKey, child] of Object.entries(value)) {
      if ((childKey.endsWith('Ref') || key.endsWith('Ref')) && child && typeof child === 'object') {
        add(child);
      }
      collectDiagnosticBlobRefs(child, childKey);
    }
  }
}

function universalWasmRef(value) {
  if (typeof value.universalWasmChecksum === 'string' && value.universalWasmChecksum.startsWith('sha256:') && Number.isSafeInteger(value.universalWasmByteLength)) {
    return { algorithm: 'sha256', checksum: value.universalWasmChecksum.slice('sha256:'.length), byteLength: value.universalWasmByteLength };
  }
  return null;
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
