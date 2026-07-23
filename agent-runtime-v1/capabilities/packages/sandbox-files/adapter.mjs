import { readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { join, resolve as pathResolve, relative, isAbsolute } from "node:path";

const packManifest = {
  driverId: "sandbox-files",
  packageName: "@tkersey/world-capabilities/sandbox-files",
  authorityLabels: ["file.fixture"],
  supportedActuationClasses: ["file"],
  supportedActuatorRefs: ["actuator.sandbox-files"],
  supportedDescriptorFingerprints: ["desc.sandbox-files.v0"],
  supportedResponseStatuses: ["ok", "rejected", "failed"],
  secretRequirements: []
};

const FORBIDDEN_EVIDENCE_KEYS = [
  "turnReceiptBytes",
  "archiveAppendBatchBytes",
  "capsuleBytes",
  "chronicleEventBytes",
  "chronicleCommitBytes",
  "actuationReceiptBytes",
  "boundaryModuleBytes",
  "executableImageBytes",
  "turnClosureBytes",
  "worldAuthoredEvidence",
  "boundaryAuthoredEvidence",
  "archiveMomentBytes",
  "archiveSealBytes"
];

function tooDeep(value, depth = 0) {
  if (depth > 8) return true;
  if (!value || typeof value !== "object") return false;
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.some((item) => tooDeep(item, depth + 1));
}

function status(hostRequest, wanted, fallback = "rejected") {
  const statuses = hostRequest?.responseSchema?.statuses ?? [];
  if (statuses.includes(wanted)) return wanted;
  if (statuses.includes(fallback)) return fallback;
  const compatibleFallback = ["failed", "rejected"].find((item) => statuses.includes(item));
  return compatibleFallback ?? "failed";
}

function responseSchemaSupports(hostRequest) {
  const statuses = hostRequest.responseSchema?.statuses;
  return Array.isArray(statuses) && statuses.includes("ok") && statuses.some((item) => item === "rejected" || item === "failed");
}

function out(hostRequest, wanted, reason, extra = {}) {
  return { requestId: hostRequest?.requestId ?? "unknown", status: status(hostRequest, wanted), payload: { reason, ...extra } };
}

function packagePolicyReason(context) {
  const policy = context?.policy;
  if (policy && Object.prototype.hasOwnProperty.call(policy, "denyPackages") && (!Array.isArray(policy.denyPackages) || policy.denyPackages.includes(packManifest.packageName))) return "package_denied";
  if (policy && Object.prototype.hasOwnProperty.call(policy, "allowPackages") && (!Array.isArray(policy.allowPackages) || !policy.allowPackages.includes(packManifest.packageName))) return "package_not_allowed";
  return null;
}

function hostilePayloadReason(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of FORBIDDEN_EVIDENCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return key === "worldAuthoredEvidence" ? "forbidden_world_evidence" : "forbidden_evidence";
  }
  if (value.duplicateResolution || value.staleResolution) return "invalid_resolution_state";
  if (value.variant?.kind === "unknown") return "malformed_sum_variant";
  if (value.simulateOversizedResponse) return "oversized_response";
  if (value.diagnostic) return "secret_shaped_diagnostics";
  for (const item of Object.values(value)) {
    const reason = hostilePayloadReason(item);
    if (reason) return reason;
  }
  return null;
}

function pathInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!!rel && rel.split(/[\\/]/, 1).join("") !== ".." && !isAbsolute(rel));
}

async function safePath(context, requested, options = {}) {
  if (!context?.fixtureRoot) return { ok: false, reason: "missing_allowed_root" };
  if (!requested || typeof requested !== "string") return { ok: false, reason: "missing_path" };
  if (isAbsolute(requested)) return { ok: false, reason: "absolute_path_rejected" };
  if (requested.split(/[\\/]/).includes("..")) return { ok: false, reason: "path_traversal_rejected" };
  const root = pathResolve(context.fixtureRoot);
  const full = pathResolve(join(root, requested));
  if (!pathInside(root, full)) return { ok: false, reason: "path_escape_rejected" };
  let rootReal;
  try {
    rootReal = await realpath(root);
  } catch {
    return { ok: false, reason: "missing_allowed_root" };
  }
  try {
    const parentReal = await realpath(pathResolve(full, ".."));
    if (!pathInside(rootReal, parentReal)) return { ok: false, reason: "symlink_ancestor_rejected" };
  } catch {
    return { ok: false, reason: "missing_parent_directory" };
  }
  try {
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) return { ok: false, reason: "final_symlink_rejected" };
    if (options.requireFile && !stat.isFile()) return { ok: false, reason: "file_read_target_not_file" };
  } catch {
    if (options.requireFile) return { ok: false, reason: "file_read_target_missing" };
  }
  return { ok: true, full, display: relative(root, full) };
}

async function preEffectReason(context, hostRequest, options = {}) {
  const enforceWriteAuthority = options.enforceWriteAuthority ?? true;
  if (!hostRequest?.requestId) return "missing_request_id";
  if (!hostRequest?.target?.descriptorFingerprint) return "missing_descriptor_fingerprint";
  if (!hostRequest?.idempotencyKey) return "missing_idempotency_key";
  if (!packManifest.supportedDescriptorFingerprints.includes(hostRequest.target.descriptorFingerprint)) return "unsupported_descriptor_fingerprint";
  if (!hostRequest.target.actuatorRef) return "missing_actuator_ref";
  if (!packManifest.supportedActuatorRefs.includes(hostRequest.target.actuatorRef)) return "unsupported_actuator_ref";
  if (!hostRequest.target.actuationClass) return "missing_actuation_class";
  if (!packManifest.supportedActuationClasses.includes(hostRequest.target.actuationClass)) return "unsupported_actuation_class";
  if (!responseSchemaSupports(hostRequest)) return "unsupported_response_schema";
  const policyReason = packagePolicyReason(context);
  if (policyReason) return policyReason;
  if (tooDeep(hostRequest.payload)) return "excessive_nesting";
  const hostile = hostilePayloadReason(hostRequest.payload);
  if (hostile) return hostile;
  if (!["read", "write"].includes(hostRequest.payload?.operation)) return "unsupported_file_operation";
  if (enforceWriteAuthority && hostRequest.payload?.operation === "write" && !context?.policy?.fileWrite) return "write_policy_required";
  if (enforceWriteAuthority && hostRequest.payload?.operation === "write" && context?.policy?.approvalRequired && !context?.approval?.approved) return "approval_required";
  const path = await safePath(context, hostRequest.payload?.path, { requireFile: hostRequest.payload?.operation === "read" });
  if (!path.ok) return path.reason;
  return null;
}

export function manifest() {
  return structuredClone(packManifest);
}

export async function preflight(context, hostRequest) {
  const reason = await preEffectReason(context, hostRequest);
  if (reason) return out(hostRequest, "rejected", reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { ready: true } };
}

export async function resolve(context, hostRequest) {
  const reason = await preEffectReason(context, hostRequest);
  if (reason) return out(hostRequest, "rejected", reason);
  const path = await safePath(context, hostRequest.payload.path, { requireFile: hostRequest.payload.operation === "read" });
  if (hostRequest.payload.operation === "read") {
    context.effectAttempted = (context.effectAttempted ?? 0) + 1;
    const bytes = await readFile(path.full, "utf8");
    return { requestId: hostRequest.requestId, status: status(hostRequest, "ok"), payload: { bytes } };
  }
  if (hostRequest.payload.operation === "write") {
    context.effectAttempted = (context.effectAttempted ?? 0) + 1;
    await writeFile(path.full, String(hostRequest.payload.bytes ?? ""));
    return { requestId: hostRequest.requestId, status: status(hostRequest, "ok"), payload: { path: path.display, idempotencyKey: hostRequest.idempotencyKey } };
  }
  return out(hostRequest, "rejected", "unsupported_file_operation");
}

export async function dryRun(context, hostRequest) {
  const reason = await preEffectReason(context, hostRequest, { enforceWriteAuthority: false });
  if (reason) return out(hostRequest, "rejected", reason);
  const path = await safePath(context, hostRequest.payload.path);
  return { requestId: hostRequest.requestId, status: "ok", payload: { wouldTouch: path.display, effect: false } };
}

export async function recover(context, effectRecord) {
  return { status: "failed", payload: { reason: "recover_unsupported" } };
}

export async function shadow(context, hostRequest, recordedResolution) {
  return { status: "failed", payload: { reason: "shadow_unsupported" } };
}
