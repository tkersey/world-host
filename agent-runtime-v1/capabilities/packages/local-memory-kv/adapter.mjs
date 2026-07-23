const packManifest = {
  driverId: "local-memory-kv",
  packageName: "@tkersey/world-capabilities/local-memory-kv",
  authorityLabels: ["memory.fixture"],
  supportedActuationClasses: ["memory"],
  supportedActuatorRefs: ["actuator.local-memory-kv"],
  supportedDescriptorFingerprints: ["desc.local-memory-kv.v0"],
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

function reject(hostRequest, reason) {
  return { requestId: hostRequest?.requestId ?? "unknown", status: status(hostRequest, "rejected"), payload: { reason } };
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

function packagePolicyReason(context) {
  const policy = context?.policy;
  if (policy && Object.prototype.hasOwnProperty.call(policy, "denyPackages") && (!Array.isArray(policy.denyPackages) || policy.denyPackages.includes(packManifest.packageName))) return "package_denied";
  if (policy && Object.prototype.hasOwnProperty.call(policy, "allowPackages") && (!Array.isArray(policy.allowPackages) || !policy.allowPackages.includes(packManifest.packageName))) return "package_not_allowed";
  return null;
}

function check(context, hostRequest) {
  if (!hostRequest?.requestId) return "missing_request_id";
  if (!hostRequest?.idempotencyKey) return "missing_idempotency_key";
  if (!hostRequest?.target?.descriptorFingerprint) return "missing_descriptor_fingerprint";
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
  if (!["get", "put"].includes(hostRequest.payload?.operation)) return "unsupported_memory_operation";
  if (String(hostRequest.payload?.key ?? "").length > 128) return "key_too_large";
  if (String(hostRequest.payload?.value ?? "").length > 1024) return "value_too_large";
  return null;
}

export function manifest() {
  return structuredClone(packManifest);
}

export async function preflight(context, hostRequest) {
  const reason = check(context, hostRequest);
  if (reason) return reject(hostRequest, reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { ready: true } };
}

export async function resolve(context, hostRequest) {
  const reason = check(context, hostRequest);
  if (reason) return reject(hostRequest, reason);
  const store = context.kv ?? new Map();
  context.kv = store;
  if (hostRequest.payload.operation === "put") {
    store.set(hostRequest.payload.key, hostRequest.payload.value);
    return { requestId: hostRequest.requestId, status: status(hostRequest, "ok"), payload: { stored: true, durability: "none" } };
  }
  if (hostRequest.payload.operation === "get") {
    if (!store.has(hostRequest.payload.key)) return reject(hostRequest, "missing_key");
    return { requestId: hostRequest.requestId, status: status(hostRequest, "ok"), payload: { value: store.get(hostRequest.payload.key), durability: "none" } };
  }
  return reject(hostRequest, "unsupported_memory_operation");
}

export async function dryRun(context, hostRequest) {
  const reason = check(context, hostRequest);
  if (reason) return reject(hostRequest, reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { wouldMutateProcessMemory: hostRequest.payload.operation === "put" } };
}

export async function recover(context, effectRecord) {
  return { status: "failed", payload: { reason: "recover_unsupported_no_durability_claim" } };
}

export async function shadow(context, hostRequest, recordedResolution) {
  return { status: "failed", payload: { reason: "shadow_unsupported" } };
}
