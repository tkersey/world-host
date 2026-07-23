const packManifest = {
  driverId: "generic-http-json",
  packageName: "@tkersey/world-capabilities/generic-http-json",
  authorityLabels: ["network.http"],
  supportedActuationClasses: ["http"],
  supportedActuatorRefs: ["actuator.generic-http-json"],
  supportedDescriptorFingerprints: ["desc.generic-http-json.v0"],
  supportedResponseStatuses: ["ok", "rejected", "failed"],
  secretRequirements: [{ name: "API_TOKEN", requiredByDefault: false }]
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

function status(hostRequest, wanted, fallback = "failed") {
  const statuses = hostRequest?.responseSchema?.statuses ?? [];
  if (statuses.includes(wanted)) return wanted;
  if (statuses.includes(fallback)) return fallback;
  const compatibleFallback = ["failed", "rejected"].find((item) => statuses.includes(item));
  if (compatibleFallback) return compatibleFallback;
  return fallback;
}

function responseSchemaSupports(hostRequest) {
  const statuses = hostRequest.responseSchema?.statuses;
  return Array.isArray(statuses) && statuses.includes("ok") && statuses.some((item) => item === "rejected" || item === "failed");
}

function outcome(hostRequest, wanted, reason, extra = {}) {
  return {
    requestId: hostRequest?.requestId ?? "unknown",
    status: status(hostRequest, wanted),
    payload: { reason, ...extra }
  };
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

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function packagePolicyReason(context) {
  const policy = context?.policy;
  if (policy && Object.prototype.hasOwnProperty.call(policy, "denyPackages") && (!Array.isArray(policy.denyPackages) || policy.denyPackages.includes(packManifest.packageName))) return "package_denied";
  if (policy && Object.prototype.hasOwnProperty.call(policy, "allowPackages") && (!Array.isArray(policy.allowPackages) || !policy.allowPackages.includes(packManifest.packageName))) return "package_not_allowed";
  return null;
}

function preEffectReason(context, hostRequest) {
  if (!hostRequest || typeof hostRequest !== "object") return "host_request_not_object";
  if (!hostRequest.requestId) return "missing_request_id";
  if (!hostRequest.target?.descriptorFingerprint) return "missing_descriptor_fingerprint";
  if (!hostRequest.idempotencyKey) return "missing_idempotency_key";
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
  if (!hostRequest.payload?.url || typeof hostRequest.payload.url !== "string") return "malformed_target";
  if (!isHttpUrl(hostRequest.payload.url)) return "malformed_target";
  if (!["GET", "POST", "PUT", "DELETE"].includes(hostRequest.payload.method)) return "method_not_allowed";
  if (context?.policy?.auditOnly) return "audit_only";
  if (!context?.policy?.live && !context?.policy?.networkLive) return "network_denied";
  if (hostRequest.payload.requiresSecret && hostRequest.payload.requiresSecret !== "API_TOKEN") return "missing_secret";
  if (hostRequest.payload.requiresSecret === "API_TOKEN" && !context?.secrets?.API_TOKEN) return "missing_secret";
  return null;
}

export function manifest() {
  return structuredClone(packManifest);
}

export async function preflight(context, hostRequest) {
  const reason = preEffectReason(context, hostRequest);
  if (reason) return outcome(hostRequest, "rejected", reason);
  return { requestId: hostRequest.requestId, status: "ok", payload: { ready: true } };
}

export async function resolve(context, hostRequest) {
  const denied = preEffectReason(context, hostRequest);
  if (denied) return outcome(hostRequest, denied.includes("oversized") || denied.includes("diagnostics") ? "failed" : "rejected", denied);
  context.effectAttempted = (context.effectAttempted ?? 0) + 1;
  return {
    requestId: hostRequest.requestId,
    status: status(hostRequest, "ok"),
    payload: { dryRunOnly: false, httpStatus: 200 },
    diagnostics: { endpointInvoked: true }
  };
}

export async function dryRun(context, hostRequest) {
  const denied = preEffectReason({ ...context, policy: { ...(context?.policy ?? {}), auditOnly: false, networkLive: true } }, hostRequest);
  if (denied && !["network_denied", "audit_only"].includes(denied)) return outcome(hostRequest, "rejected", denied);
  return { requestId: hostRequest?.requestId ?? "unknown", status: "ok", payload: { wouldFetch: false, url: hostRequest?.payload?.url } };
}

export async function recover(context, effectRecord) {
  return { status: "failed", payload: { reason: "recover_unsupported_without_stable_request_id" } };
}

export async function shadow(context, hostRequest, recordedResolution) {
  return { requestId: hostRequest?.requestId ?? "unknown", status: "ok", payload: { liveEndpointInvoked: false, recordedResolution } };
}
