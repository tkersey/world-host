const packManifest = {
  driverId: "human-approval",
  packageName: "@tkersey/world-capabilities/human-approval",
  authorityLabels: ["human.approval"],
  supportedActuationClasses: ["approval"],
  supportedActuatorRefs: ["actuator.human-approval"],
  supportedDescriptorFingerprints: ["desc.human-approval.v0"],
  supportedResponseStatuses: ["ok", "rejected", "deferred", "failed"],
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
  const compatibleFallback = ["failed", "rejected"].find((item) => packManifest.supportedResponseStatuses.includes(item) && statuses.includes(item));
  if (compatibleFallback) return compatibleFallback;
  return "failed";
}

function dryRunFailureStatus(hostRequest) {
  const statuses = hostRequest?.responseSchema?.statuses ?? [];
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("rejected")) return "rejected";
  return "failed";
}

function reject(hostRequest, reason, responseStatus = status(hostRequest, "rejected")) {
  return { requestId: hostRequest?.requestId ?? "unknown", status: responseStatus, payload: { reason } };
}

function responseSchemaSupports(hostRequest, requiredStatuses) {
  const statuses = hostRequest.responseSchema?.statuses;
  return Array.isArray(statuses) && statuses.length > 0 && requiredStatuses.every((item) => statuses.includes(item));
}

function dryRunResponseSchemaSupports(hostRequest) {
  const statuses = hostRequest?.responseSchema?.statuses;
  return Array.isArray(statuses) && statuses.includes("deferred") && statuses.some((item) => item === "failed" || item === "rejected");
}

const STRUCTURAL_REQUEST_REASONS = new Set([
  "missing_request_id",
  "missing_descriptor_fingerprint",
  "missing_idempotency_key",
  "missing_actuator_ref",
  "missing_actuation_class",
  "unsupported_descriptor_fingerprint",
  "unsupported_actuator_ref",
  "unsupported_actuation_class"
]);

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

function reason(context, hostRequest, requiredStatuses = packManifest.supportedResponseStatuses) {
  if (!hostRequest?.requestId) return "missing_request_id";
  if (!hostRequest?.target?.descriptorFingerprint) return "missing_descriptor_fingerprint";
  if (!hostRequest?.idempotencyKey) return "missing_idempotency_key";
  if (!packManifest.supportedDescriptorFingerprints.includes(hostRequest.target.descriptorFingerprint)) return "unsupported_descriptor_fingerprint";
  if (!hostRequest.target.actuatorRef) return "missing_actuator_ref";
  if (!packManifest.supportedActuatorRefs.includes(hostRequest.target.actuatorRef)) return "unsupported_actuator_ref";
  if (!hostRequest.target.actuationClass) return "missing_actuation_class";
  if (!packManifest.supportedActuationClasses.includes(hostRequest.target.actuationClass)) return "unsupported_actuation_class";
  if (!responseSchemaSupports(hostRequest, requiredStatuses)) return "unsupported_response_schema";
  const policyReason = packagePolicyReason(context);
  if (policyReason) return policyReason;
  if (tooDeep(hostRequest.payload)) return "excessive_nesting";
  const hostile = hostilePayloadReason(hostRequest.payload);
  if (hostile) return hostile;
  if (!String(hostRequest.payload?.anchor ?? "").startsWith("world:host-request:")) return "missing_world_host_request_anchor";
  if (context?.policy?.auditOnly || context?.policy?.humanLive === false) return "policy_denied";
  return null;
}

export function manifest() {
  return structuredClone(packManifest);
}

export async function preflight(context, hostRequest) {
  const denied = reason(context, hostRequest, ["ok", "rejected"]);
  if (denied) return reject(hostRequest, denied);
  return { requestId: hostRequest.requestId, status: "ok", payload: { ready: true } };
}

export async function resolve(context, hostRequest) {
  const denied = reason(context, hostRequest, ["ok", "rejected"]);
  if (denied) return reject(hostRequest, denied);
  const mode = context?.approvalMode ?? "deny";
  if (mode === "allow") return { requestId: hostRequest.requestId, status: status(hostRequest, "ok"), payload: { approved: true } };
  return { requestId: hostRequest.requestId, status: status(hostRequest, "rejected"), payload: { approved: false } };
}

export async function dryRun(context, hostRequest) {
  const denied = reason({ ...context, policy: { ...(context?.policy ?? {}), humanLive: true, auditOnly: false } }, hostRequest, ["deferred"]);
  if (denied) {
    if (STRUCTURAL_REQUEST_REASONS.has(denied)) return reject(hostRequest, denied);
    if (!dryRunResponseSchemaSupports(hostRequest)) return reject(hostRequest, "unsupported_response_schema");
    return reject(hostRequest, denied, dryRunFailureStatus(hostRequest));
  }
  if (!dryRunResponseSchemaSupports(hostRequest)) return reject(hostRequest, "unsupported_response_schema");
  return { requestId: hostRequest.requestId, status: "deferred", payload: { promptWouldBeShown: false } };
}

export async function recover(context, effectRecord) {
  return { status: "failed", payload: { reason: "recover_unsupported_without_operator_event_id" } };
}

export async function shadow(context, hostRequest, recordedResolution) {
  return { status: "failed", payload: { reason: "shadow_unsupported" } };
}
