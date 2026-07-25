import { createHash } from "node:crypto";

import { fail } from "./errors.mjs";
import {
  DEFAULT_LIMITS,
  EffectStatus,
  createEffectResult,
  decodeEffectRequest,
  statusCode,
  statusNames,
  validateEffectResultForRequest
} from "./protocol.mjs";

const FORBIDDEN_OUTPUT_KEYS = new Set([
  "frame",
  "frameBytes",
  "worldState",
  "worldImage",
  "applicationManifest",
  "transitionBlock",
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
]);
const FORBIDDEN_OUTPUT_KEY_NORMAL_FORMS = new Set([...FORBIDDEN_OUTPUT_KEYS]
  .map((key) => key.replace(/[^a-z0-9]/gi, "").toLowerCase()));

export class CapabilityRouterV1 {
  constructor({ bindings, limits = DEFAULT_LIMITS }) {
    if (!Array.isArray(bindings) || bindings.length === 0) fail("ERR_CAPABILITY_V1_BINDINGS");
    this.limits = Object.freeze({ ...limits });
    this.bindings = new Map();
    for (const binding of bindings) {
      const admitted = assertBinding(binding);
      const key = Buffer.from(admitted.interfaceId).toString("hex");
      if (this.bindings.has(key)) fail("ERR_CAPABILITY_V1_BINDING_AMBIGUOUS", key);
      this.bindings.set(key, admitted);
    }
  }

  inspect(requestBytes) {
    const request = decodeEffectRequest(requestBytes, this.limits);
    const binding = this.#bindingFor(request);
    return Object.freeze({
      request,
      bindingId: binding.bindingId,
      driverId: binding.driverId,
      packageName: binding.packageName,
      effectAttempted: false
    });
  }

  async resolve(context, requestBytes) {
    const request = decodeEffectRequest(requestBytes, this.limits);
    const binding = this.#bindingFor(request);
    const projected = projectRequest(binding, request);
    const preflight = await binding.adapter.preflight(context, projected);
    assertOutcome(preflight, projected);
    const outcome = preflight.status === "ok"
      ? await binding.adapter.resolve(context, projected)
      : preflight;
    assertOutcome(outcome, projected);
    assertNoForbiddenOutput(outcome);
    const status = statusCode(outcome.status);
    if ((request.allowedStatuses & (1 << status)) === 0) fail("ERR_CAPABILITY_V1_OUTCOME_STATUS");
    const resultBytes = status === EffectStatus.ok
      ? binding.encodeOutcome(outcome, projected, request)
      : null;
    if (status === EffectStatus.ok && !(resultBytes instanceof Uint8Array)) fail("ERR_CAPABILITY_V1_OUTCOME_BYTES");
    const result = createEffectResult({
      requestId: request.requestId,
      status,
      resultSchemaId: request.resultSchemaId,
      resultBytes,
      hostClaims: binding.hostClaims(outcome, projected),
      attempt: context?.attempt ?? 1
    }, {
      ...this.limits,
      maximumResultBytes: Math.min(
        this.limits.maximumResultBytes,
        request.limits.maximumResultBytes
      )
    });
    validateEffectResultForRequest(request, result, this.limits);
    const handlerConfigurationIdentity = binding.configurationIdentity(context, projected, request);
    if (typeof handlerConfigurationIdentity !== "string" || handlerConfigurationIdentity.length === 0) {
      fail("ERR_CAPABILITY_V1_HANDLER_CONFIGURATION_IDENTITY");
    }
    return Object.freeze({
      request,
      result,
      bindingId: binding.bindingId,
      handlerIdentity: binding.handlerIdentity,
      handlerConfigurationIdentity,
      recoveryClass: binding.recoveryClass
    });
  }

  #bindingFor(request) {
    const binding = this.bindings.get(Buffer.from(request.interfaceId).toString("hex"));
    if (!binding) fail("ERR_CAPABILITY_V1_INTERFACE_UNCOVERED");
    if (!sameBytes(request.payloadSchemaId, binding.payloadSchemaId) ||
        !sameBytes(request.resultSchemaId, binding.resultSchemaId)) {
      fail("ERR_CAPABILITY_V1_SCHEMA_MISMATCH");
    }
    if (request.authorityRequirements !== binding.authorityRequirements) fail("ERR_CAPABILITY_V1_AUTHORITY_MISMATCH");
    if (binding.applicationIds !== null &&
        !binding.applicationIds.some((applicationId) => sameBytes(request.applicationId, applicationId))) {
      fail("ERR_CAPABILITY_V1_APPLICATION_MISMATCH");
    }
    return binding;
  }
}

function assertBinding(binding) {
  if (!binding || typeof binding !== "object" || typeof binding.bindingId !== "string" || binding.bindingId.length === 0 ||
      typeof binding.driverId !== "string" || binding.driverId.length === 0 ||
      typeof binding.packageName !== "string" || binding.packageName.length === 0 ||
      !(binding.interfaceId instanceof Uint8Array) || binding.interfaceId.length !== 32 ||
      !(binding.payloadSchemaId instanceof Uint8Array) || binding.payloadSchemaId.length !== 32 ||
      !(binding.resultSchemaId instanceof Uint8Array) || binding.resultSchemaId.length !== 32 ||
      typeof binding.decodePayload !== "function" || typeof binding.encodeOutcome !== "function" ||
      !binding.adapter || typeof binding.adapter.preflight !== "function" || typeof binding.adapter.resolve !== "function") {
    fail("ERR_CAPABILITY_V1_BINDING");
  }
  const applicationIds = normalizeApplicationIds(binding.applicationIds);
  const target = Object.freeze({ ...(binding.target ?? {}) });
  return Object.freeze({
    ...binding,
    adapter: Object.freeze({
      preflight: binding.adapter.preflight,
      resolve: binding.adapter.resolve
    }),
    interfaceId: Buffer.from(binding.interfaceId),
    payloadSchemaId: Buffer.from(binding.payloadSchemaId),
    resultSchemaId: Buffer.from(binding.resultSchemaId),
    applicationIds,
    authorityRequirements: asU64(binding.authorityRequirements ?? 0n, "authorityRequirements"),
    target,
    handlerIdentity: binding.handlerIdentity ?? binding.driverId,
    configurationIdentity: binding.configurationIdentity ?? (() => semanticConfigurationIdentity({
      ...binding,
      applicationIds,
      target
    })),
    recoveryClass: binding.recoveryClass ?? "pure",
    hostClaims: binding.hostClaims ?? (() => new Uint8Array(0))
  });
}

function projectRequest(binding, request) {
  const payload = binding.decodePayload(request.payloadBytes, request);
  return Object.freeze({
    protocolVersion: "world-effect-v1",
    requestId: Buffer.from(request.requestId).toString("hex"),
    idempotencyKey: Buffer.from(request.idempotencyKey).toString("hex"),
    interfaceId: Buffer.from(request.interfaceId).toString("hex"),
    siteId: request.siteId.toString(),
    sequence: request.sequence.toString(),
    target: binding.target,
    responseSchema: Object.freeze({ statuses: statusNames(request.allowedStatuses) }),
    limits: Object.freeze({
      maximumResultBytes: request.limits.maximumResultBytes,
      maximumAttempts: request.limits.maximumAttempts
    }),
    payload
  });
}

function assertOutcome(value, request) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("ERR_CAPABILITY_V1_OUTCOME");
  if (value.requestId !== request.requestId) fail("ERR_CAPABILITY_V1_OUTCOME_TARGET");
  statusCode(value.status);
}

function assertNoForbiddenOutput(value, path = "$", depth = 0) {
  if (depth > 16) fail("ERR_CAPABILITY_V1_OUTCOME_DEPTH", path);
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normal = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (FORBIDDEN_OUTPUT_KEYS.has(key) || FORBIDDEN_OUTPUT_KEY_NORMAL_FORMS.has(normal)) {
      fail("ERR_CAPABILITY_V1_WORLD_EVIDENCE", `${path}.${key}`);
    }
    assertNoForbiddenOutput(child, `${path}.${key}`, depth + 1);
  }
}

function semanticConfigurationIdentity(binding) {
  const hasher = createHash("sha256");
  hasher.update("world.capability-binding.v1");
  hasher.update(Buffer.from([0]));
  hasher.update(binding.bindingId);
  hasher.update(Buffer.from(binding.interfaceId));
  hasher.update(JSON.stringify(binding.target ?? {}));
  for (const applicationId of binding.applicationIds ?? []) {
    hasher.update(Buffer.from([0]));
    hasher.update(applicationId);
  }
  return hasher.digest("hex");
}

function normalizeApplicationIds(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) fail("ERR_CAPABILITY_V1_APPLICATION_IDS");
  const ids = value.map((applicationId) => {
    if (!(applicationId instanceof Uint8Array) || applicationId.length !== 32) {
      fail("ERR_CAPABILITY_V1_APPLICATION_IDS");
    }
    return Buffer.from(applicationId);
  });
  ids.sort(Buffer.compare);
  for (let index = 1; index < ids.length; index += 1) {
    if (sameBytes(ids[index - 1], ids[index])) fail("ERR_CAPABILITY_V1_APPLICATION_IDS");
  }
  return Object.freeze(ids);
}

function sameBytes(left, right) {
  return Buffer.from(left).equals(Buffer.from(right));
}

function asU64(value, label) {
  const admitted = typeof value === "bigint" ? value : Number.isSafeInteger(value) ? BigInt(value) : null;
  if (admitted === null || admitted < 0n || admitted > 0xffffffffffffffffn) fail("ERR_CAPABILITY_V1_U64", label);
  return admitted;
}
