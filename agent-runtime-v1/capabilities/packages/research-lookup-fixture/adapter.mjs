const packManifest = {
  driverId: "research-lookup-fixture",
  packageName: "@tkersey/world-capabilities/research-lookup-fixture",
  authorityLabels: ["research.fixture"],
  supportedActuationClasses: ["research"],
  supportedActuatorRefs: ["actuator.research-lookup-fixture.v1"],
  supportedDescriptorFingerprints: ["desc.research-lookup-fixture.v1"],
  supportedResponseStatuses: ["ok", "rejected", "failed"],
  secretRequirements: []
};

const QUERY = "portable algebraic effects";
const MAXIMUM_QUERY_BYTES = 4096;
const MAXIMUM_ITEMS = 2n;
const FORBIDDEN_EVIDENCE_NORMAL_FORMS = new Set([
  "turnreceiptbytes",
  "archiveappendbatchbytes",
  "capsulebytes",
  "chronicleeventbytes",
  "chroniclecommitbytes",
  "actuationreceiptbytes",
  "boundarymodulebytes",
  "executableimagebytes",
  "turnclosurebytes",
  "worldauthoredevidence",
  "boundaryauthoredevidence",
  "archivemomentbytes",
  "archivesealbytes",
  "frame",
  "framebytes",
  "worldstate",
  "applicationmanifest"
]);
const RESPONSE = Object.freeze({
  first: Object.freeze({
    title: "Effect rows as application boundaries",
    summary: "Static closure leaves authority outside the guest."
  }),
  second: Object.freeze({
    title: "Portable continuations",
    summary: "Canonical Frames resume in fresh WASM instances."
  }),
  digestResult: Object.freeze({
    digest: "Static closure keeps authority external; canonical Frames keep continuation portable.",
    itemCount: 2n
  })
});

function status(hostRequest, wanted, fallback = "rejected") {
  const statuses = hostRequest?.responseSchema?.statuses ?? [];
  if (statuses.includes(wanted)) return wanted;
  if (statuses.includes(fallback)) return fallback;
  return statuses.find((candidate) => candidate === "failed" || candidate === "rejected") ?? "failed";
}

function rejection(hostRequest, reason) {
  return {
    requestId: hostRequest?.requestId ?? "unknown",
    status: status(hostRequest, "rejected"),
    payload: { reason }
  };
}

function packagePolicyReason(context) {
  const policy = context?.policy;
  if (!policy || typeof policy !== "object") return "research_lookup_policy_required";
  if (Object.prototype.hasOwnProperty.call(policy, "denyPackages") &&
      (!Array.isArray(policy.denyPackages) ||
       policy.denyPackages.includes(packManifest.packageName))) {
    return "package_denied";
  }
  if (Object.prototype.hasOwnProperty.call(policy, "allowPackages") &&
      (!Array.isArray(policy.allowPackages) ||
       !policy.allowPackages.includes(packManifest.packageName))) {
    return "package_not_allowed";
  }
  if (policy.researchLookup !== true) return "research_lookup_policy_required";
  return null;
}

function hostilePayloadReason(value, depth = 0) {
  if (depth > 8) return "excessive_nesting";
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (FORBIDDEN_EVIDENCE_NORMAL_FORMS.has(normalized)) {
      return normalized === "worldauthoredevidence"
        ? "forbidden_world_evidence"
        : "forbidden_evidence";
    }
    if (normalized === "duplicateresolution" || normalized === "staleresolution") return "invalid_resolution_state";
    if (normalized === "simulateoversizedresponse") return "oversized_response";
    if (normalized === "diagnostic") return "secret_shaped_diagnostics";
    if (normalized === "variant" && child?.kind === "unknown") return "malformed_sum_variant";
    const nested = hostilePayloadReason(child, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function requestReason(context, hostRequest) {
  if (!hostRequest || typeof hostRequest !== "object") return "host_request_not_object";
  if (typeof hostRequest.requestId !== "string" || hostRequest.requestId.length === 0) {
    return "missing_request_id";
  }
  if (typeof hostRequest.idempotencyKey !== "string" || hostRequest.idempotencyKey.length === 0) {
    return "missing_idempotency_key";
  }
  if (!hostRequest.target || typeof hostRequest.target !== "object") return "malformed_target";
  if (!packManifest.supportedDescriptorFingerprints.includes(hostRequest.target.descriptorFingerprint)) {
    return "unsupported_descriptor_fingerprint";
  }
  if (!packManifest.supportedActuatorRefs.includes(hostRequest.target.actuatorRef)) {
    return "unsupported_actuator_ref";
  }
  if (!packManifest.supportedActuationClasses.includes(hostRequest.target.actuationClass)) {
    return "unsupported_actuation_class";
  }
  const statuses = hostRequest.responseSchema?.statuses;
  if (!Array.isArray(statuses) ||
      !statuses.includes("ok") ||
      !statuses.some((candidate) => candidate === "rejected" || candidate === "failed")) {
    return "unsupported_response_schema";
  }
  const policyReason = packagePolicyReason(context);
  if (policyReason) return policyReason;
  const hostile = hostilePayloadReason(hostRequest.payload);
  if (hostile) return hostile;
  const query = hostRequest.payload?.query;
  if (typeof query !== "string" ||
      new TextEncoder().encode(query).length === 0 ||
      new TextEncoder().encode(query).length > MAXIMUM_QUERY_BYTES) {
    return "malformed_research_query";
  }
  if (typeof hostRequest.payload?.maximumItems !== "bigint" ||
      hostRequest.payload.maximumItems !== MAXIMUM_ITEMS) {
    return "invalid_maximum_items";
  }
  if (query !== QUERY) return "unsupported_fixture_query";
  return null;
}

export function manifest() {
  return structuredClone(packManifest);
}

export async function preflight(context, hostRequest) {
  const reason = requestReason(context, hostRequest);
  if (reason) return rejection(hostRequest, reason);
  return {
    requestId: hostRequest.requestId,
    status: "ok",
    payload: { admitted: true }
  };
}

export async function resolve(context, hostRequest) {
  const admitted = await preflight(context, hostRequest);
  if (admitted.status !== "ok") return admitted;
  context.effectAttempted = (context.effectAttempted ?? 0) + 1;
  return {
    requestId: hostRequest.requestId,
    status: status(hostRequest, "ok"),
    payload: structuredClone(RESPONSE)
  };
}

export async function dryRun(context, hostRequest) {
  const admitted = await preflight(context, hostRequest);
  if (admitted.status !== "ok") return admitted;
  return {
    requestId: hostRequest.requestId,
    status: "ok",
    payload: { wouldResolve: true, effect: false }
  };
}

export async function recover(_context, effectRecord) {
  if (effectRecord?.recordedResolution) return structuredClone(effectRecord.recordedResolution);
  return { status: "failed", payload: { reason: "recorded_resolution_required" } };
}

export async function shadow(_context, hostRequest, recordedResolution) {
  return {
    requestId: hostRequest?.requestId ?? "unknown",
    status: "ok",
    payload: { matched: true, recordedResolution }
  };
}
