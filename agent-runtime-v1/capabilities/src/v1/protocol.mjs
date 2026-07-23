import { createHash } from "node:crypto";

import { assertBytes, fail } from "./errors.mjs";

export const FORMAT_VERSION = 1;
export const DIGEST_LENGTH = 32;
export const ZERO_DIGEST = Buffer.alloc(DIGEST_LENGTH);

export const EffectStatus = Object.freeze({
  ok: 0,
  rejected: 1,
  failed: 2,
  deferred: 3,
  cancelled: 4
});

export const DEFAULT_LIMITS = Object.freeze({
  maximumPayloadBytes: 1 << 20,
  maximumResultBytes: 1 << 20,
  maximumHostClaimBytes: 64 << 10
});

export function effectInterfaceId(label) {
  if (typeof label !== "string" || label.length === 0) fail("ERR_CAPABILITY_V1_INTERFACE_LABEL");
  return domainDigest("world.effect-interface.v1", Buffer.from(label, "utf8"));
}

export function stringValueSchemaId() {
  return domainDigest("world.value-schema.v1", Buffer.from("string", "ascii"));
}

export function encodeStringValue(value) {
  if (typeof value !== "string") fail("ERR_CAPABILITY_V1_STRING_VALUE");
  const bytes = Buffer.from(value, "utf8");
  const writer = new Writer();
  writer.lenBytes(bytes);
  return writer.finish();
}

export function decodeStringValue(encoded, maximum = DEFAULT_LIMITS.maximumPayloadBytes) {
  const reader = new Reader(boundedBytes(encoded, maximum + 4, "string value"));
  const bytes = reader.lenBytes(maximum, "string value");
  reader.finish();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("ERR_CAPABILITY_V1_STRING_UTF8");
  }
}

export function decodeEffectRequest(encoded, limits = DEFAULT_LIMITS) {
  const admitted = normalizeLimits(limits);
  const bytes = boundedBytes(encoded, admitted.maximumPayloadBytes + 512, "EffectRequest");
  const reader = new Reader(bytes);
  reader.magic("WRLDERQ1");
  reader.version();
  const request = {
    requestId: reader.digest(),
    applicationId: reader.digest(),
    parentFrameId: reader.digest(),
    sequence: reader.u64(),
    ordinal: reader.u32(),
    siteId: reader.u64(),
    interfaceId: reader.digest(),
    payloadSchemaId: reader.digest(),
    resultSchemaId: reader.digest(),
    allowedStatuses: reader.u8(),
    payloadBytes: reader.lenBytes(admitted.maximumPayloadBytes, "effect payload"),
    idempotencyKey: reader.digest(),
    authorityRequirements: reader.u64(),
    limits: {
      maximumResultBytes: reader.u32(),
      maximumAttempts: reader.u32()
    }
  };
  reader.finish();
  validateRequest(request, admitted);
  return Object.freeze({ ...request, encodedBytes: Buffer.from(bytes) });
}

export function createEffectResult({
  requestId,
  status,
  resultSchemaId,
  resultBytes = null,
  hostClaims = new Uint8Array(0),
  attempt = 1
}, limits = DEFAULT_LIMITS) {
  const admitted = normalizeLimits(limits);
  const result = {
    resultId: Buffer.from(ZERO_DIGEST),
    requestId: digest(requestId, "requestId"),
    status: statusValue(status),
    resultSchemaId: digest(resultSchemaId, "resultSchemaId"),
    resultBytes: resultBytes === null ? null : ownedBytes(resultBytes, "resultBytes"),
    hostClaims: ownedBytes(hostClaims, "hostClaims"),
    attempt: u32(attempt, "attempt")
  };
  validateResult(result, admitted, false);
  result.resultId = domainDigest("world.effect-result.v1", encodeResultCanonical(result, false));
  const encodedBytes = encodeResultCanonical(result, true);
  return Object.freeze({ ...result, encodedBytes });
}

export function decodeEffectResult(encoded, limits = DEFAULT_LIMITS) {
  const admitted = normalizeLimits(limits);
  const bytes = boundedBytes(encoded, admitted.maximumResultBytes + admitted.maximumHostClaimBytes + 256, "EffectResult");
  const reader = new Reader(bytes);
  reader.magic("WRLDERS1");
  reader.version();
  const result = {
    resultId: reader.digest(),
    requestId: reader.digest(),
    status: reader.effectStatus(),
    resultSchemaId: reader.digest(),
    resultBytes: reader.optionalBytes(admitted.maximumResultBytes, "effect result"),
    hostClaims: reader.lenBytes(admitted.maximumHostClaimBytes, "host claims"),
    attempt: reader.u32()
  };
  reader.finish();
  validateResult(result, admitted, true);
  return Object.freeze({ ...result, encodedBytes: Buffer.from(bytes) });
}

export function validateEffectResultForRequest(request, result, limits = DEFAULT_LIMITS) {
  const admitted = normalizeLimits(limits);
  validateRequest(request, admitted);
  validateResult(result, admitted, true);
  if (!sameBytes(request.requestId, result.requestId)) fail("ERR_CAPABILITY_V1_RESULT_TARGET");
  if ((request.allowedStatuses & (1 << result.status)) === 0) fail("ERR_CAPABILITY_V1_RESULT_STATUS");
  if (!sameBytes(request.resultSchemaId, result.resultSchemaId)) fail("ERR_CAPABILITY_V1_RESULT_SCHEMA");
  if (result.attempt > request.limits.maximumAttempts) fail("ERR_CAPABILITY_V1_RESULT_ATTEMPT");
  if (result.resultBytes !== null && result.resultBytes.length > request.limits.maximumResultBytes) {
    fail("ERR_CAPABILITY_V1_RESULT_LIMIT");
  }
}

export function statusNames(mask) {
  validateAllowedStatuses(mask);
  return Object.freeze(Object.entries(EffectStatus)
    .filter(([, value]) => (mask & (1 << value)) !== 0)
    .map(([name]) => name));
}

export function statusCode(name) {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(EffectStatus, name)) {
    fail("ERR_CAPABILITY_V1_STATUS", String(name));
  }
  return EffectStatus[name];
}

function validateRequest(request, limits) {
  validateAllowedStatuses(request.allowedStatuses);
  if (isZeroDigest(request.applicationId) || isZeroDigest(request.interfaceId) ||
      isZeroDigest(request.payloadSchemaId) || isZeroDigest(request.resultSchemaId) ||
      (request.sequence === 0n) !== isZeroDigest(request.parentFrameId) ||
      request.ordinal !== 0 || request.payloadBytes.length > limits.maximumPayloadBytes) {
    fail("ERR_CAPABILITY_V1_REQUEST");
  }
  if (request.limits.maximumResultBytes === 0 || request.limits.maximumResultBytes > limits.maximumResultBytes ||
      request.limits.maximumAttempts === 0) fail("ERR_CAPABILITY_V1_REQUEST_LIMITS");
  const expectedId = domainDigest("world.effect-request.v1", encodeRequestCanonical(request, false));
  if (!sameBytes(expectedId, request.requestId)) fail("ERR_CAPABILITY_V1_REQUEST_IDENTITY");
  const expectedKey = domainDigestParts("world.idempotency-key.v1", [
    request.requestId,
    request.interfaceId,
    request.applicationId
  ]);
  if (!sameBytes(expectedKey, request.idempotencyKey)) fail("ERR_CAPABILITY_V1_IDEMPOTENCY_IDENTITY");
}

function validateResult(result, limits, checkIdentity) {
  statusValue(result.status);
  if (isZeroDigest(result.requestId) || isZeroDigest(result.resultSchemaId) ||
      result.attempt === 0 || result.hostClaims.length > limits.maximumHostClaimBytes ||
      (result.resultBytes !== null && result.resultBytes.length > limits.maximumResultBytes) ||
      (result.status === EffectStatus.ok && result.resultBytes === null) ||
      (result.status === EffectStatus.deferred && result.resultBytes !== null)) {
    fail("ERR_CAPABILITY_V1_RESULT");
  }
  if (checkIdentity) {
    const expected = domainDigest("world.effect-result.v1", encodeResultCanonical(result, false));
    if (!sameBytes(expected, result.resultId)) fail("ERR_CAPABILITY_V1_RESULT_IDENTITY");
  }
}

function encodeRequestCanonical(request, includeIdentity) {
  const writer = new Writer();
  writer.magic("WRLDERQ1");
  writer.u32(FORMAT_VERSION);
  writer.digest(includeIdentity ? request.requestId : ZERO_DIGEST);
  writer.digest(request.applicationId);
  writer.digest(request.parentFrameId);
  writer.u64(request.sequence);
  writer.u32(request.ordinal);
  writer.u64(request.siteId);
  writer.digest(request.interfaceId);
  writer.digest(request.payloadSchemaId);
  writer.digest(request.resultSchemaId);
  writer.u8(request.allowedStatuses);
  writer.lenBytes(request.payloadBytes);
  writer.digest(includeIdentity ? request.idempotencyKey : ZERO_DIGEST);
  writer.u64(request.authorityRequirements);
  writer.u32(request.limits.maximumResultBytes);
  writer.u32(request.limits.maximumAttempts);
  return writer.finish();
}

function encodeResultCanonical(result, includeIdentity) {
  const writer = new Writer();
  writer.magic("WRLDERS1");
  writer.u32(FORMAT_VERSION);
  writer.digest(includeIdentity ? result.resultId : ZERO_DIGEST);
  writer.digest(result.requestId);
  writer.u8(result.status);
  writer.digest(result.resultSchemaId);
  writer.optionalBytes(result.resultBytes);
  writer.lenBytes(result.hostClaims);
  writer.u32(result.attempt);
  return writer.finish();
}

function normalizeLimits(value) {
  if (!value || typeof value !== "object") fail("ERR_CAPABILITY_V1_LIMITS");
  return {
    maximumPayloadBytes: positiveU32(value.maximumPayloadBytes, "maximumPayloadBytes"),
    maximumResultBytes: positiveU32(value.maximumResultBytes, "maximumResultBytes"),
    maximumHostClaimBytes: u32(value.maximumHostClaimBytes, "maximumHostClaimBytes")
  };
}

function validateAllowedStatuses(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 0x1f) fail("ERR_CAPABILITY_V1_ALLOWED_STATUSES");
}

function statusValue(value) {
  if (!Number.isInteger(value) || value < EffectStatus.ok || value > EffectStatus.cancelled) fail("ERR_CAPABILITY_V1_STATUS");
  return value;
}

function domainDigest(domain, bytes) {
  return domainDigestParts(domain, [bytes]);
}

function domainDigestParts(domain, parts) {
  const hasher = createHash("sha256");
  hasher.update(domain);
  hasher.update(Buffer.from([0]));
  for (const part of parts) hasher.update(part);
  return hasher.digest();
}

function sameBytes(left, right) {
  return Buffer.from(left).equals(Buffer.from(right));
}

function isZeroDigest(value) {
  return sameBytes(value, ZERO_DIGEST);
}

function ownedBytes(value, label) {
  return Buffer.from(assertBytes(value, label));
}

function boundedBytes(value, maximum, label) {
  const bytes = ownedBytes(value, label);
  if (bytes.length > maximum) fail("ERR_CAPABILITY_V1_LIMIT", `${label} exceeds ${maximum} bytes`);
  return bytes;
}

function digest(value, label) {
  const bytes = ownedBytes(value, label);
  if (bytes.length !== DIGEST_LENGTH) fail("ERR_CAPABILITY_V1_DIGEST", label);
  return bytes;
}

function u32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) fail("ERR_CAPABILITY_V1_U32", label);
  return value;
}

function positiveU32(value, label) {
  const admitted = u32(value, label);
  if (admitted === 0) fail("ERR_CAPABILITY_V1_U32", label);
  return admitted;
}

function u64(value, label) {
  const admitted = typeof value === "bigint" ? value : Number.isSafeInteger(value) ? BigInt(value) : null;
  if (admitted === null || admitted < 0n || admitted > 0xffffffffffffffffn) fail("ERR_CAPABILITY_V1_U64", label);
  return admitted;
}

class Writer {
  constructor() { this.chunks = []; }
  magic(value) { this.chunks.push(Buffer.from(value, "ascii")); }
  bytes(value) { this.chunks.push(Buffer.from(value)); }
  bool(value) { this.u8(value ? 1 : 0); }
  u8(value) {
    const admitted = u32(value, "u8");
    if (admitted > 0xff) fail("ERR_CAPABILITY_V1_U8");
    this.chunks.push(Buffer.from([admitted]));
  }
  u32(value) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(u32(value, "u32"));
    this.chunks.push(bytes);
  }
  u64(value) {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(u64(value, "u64"));
    this.chunks.push(bytes);
  }
  digest(value) { this.chunks.push(digest(value, "digest")); }
  lenBytes(value) { this.u32(value.length); this.bytes(value); }
  optionalBytes(value) { this.bool(value !== null); if (value !== null) this.lenBytes(value); }
  finish() { return Buffer.concat(this.chunks); }
}

class Reader {
  constructor(value) { this.value = Buffer.from(value); this.offset = 0; }
  bytes(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.value.length) fail("ERR_CAPABILITY_V1_TRUNCATED");
    const result = this.value.subarray(this.offset, this.offset + length);
    this.offset += length;
    return Buffer.from(result);
  }
  magic(expected) { if (this.bytes(expected.length).toString("ascii") !== expected) fail("ERR_CAPABILITY_V1_MAGIC"); }
  version() { if (this.u32() !== FORMAT_VERSION) fail("ERR_CAPABILITY_V1_VERSION"); }
  bool() { const value = this.u8(); if (value > 1) fail("ERR_CAPABILITY_V1_BOOLEAN"); return value === 1; }
  u8() { return this.bytes(1)[0]; }
  u32() { return this.bytes(4).readUInt32LE(); }
  u64() { return this.bytes(8).readBigUInt64LE(); }
  digest() { return this.bytes(DIGEST_LENGTH); }
  lenBytes(maximum, label) { const length = this.u32(); if (length > maximum) fail("ERR_CAPABILITY_V1_LIMIT", label); return this.bytes(length); }
  optionalBytes(maximum, label) { return this.bool() ? this.lenBytes(maximum, label) : null; }
  effectStatus() { return statusValue(this.u8()); }
  finish() { if (this.offset !== this.value.length) fail("ERR_CAPABILITY_V1_TRAILING_BYTES"); }
}
