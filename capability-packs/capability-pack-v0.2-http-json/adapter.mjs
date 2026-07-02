// @bun
// src/core/store.mjs
class CarrierError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "CarrierError";
    this.code = code;
    this.details = details;
  }
}
function fail(code, message = code, details = {}) {
  throw new CarrierError(code, message, details);
}
function assertBytes(bytes, label = "bytes") {
  if (bytes instanceof Uint8Array)
    return bytes;
  fail("ERR_EXPECTED_BYTES", `${label} must be Uint8Array`);
}
function fromUtf8(value) {
  return new TextEncoder().encode(value);
}
function stableJson(value) {
  return JSON.stringify(sortJson(value));
}
function sortJson(value) {
  if (Array.isArray(value))
    return value.map(sortJson);
  if (!value || typeof value !== "object")
    return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]));
}

// src/core/actuator.mjs
var EffectRecoveryClass = Object.freeze({
  pure: "pure",
  idempotent: "idempotent",
  externallyRecoverable: "externally_recoverable",
  transactional: "transactional",
  bestEffort: "best_effort"
});
var ActuationClass = Object.freeze({
  model: "model",
  file: "file",
  http: "http",
  fixture: "fixture",
  host: "host"
});
var RECOVERY_CLASSES = new Set(Object.values(EffectRecoveryClass));
var ResponseStatusCode = Object.freeze({
  responded: 0,
  ok: 0,
  final: 0,
  rejected: 1,
  not_found: 1,
  http_error: 1,
  failed: 2,
  pending: 3,
  deferred: 4,
  cancelled: 5
});
var RESPONSE_STATUSES = new Set(Object.keys(ResponseStatusCode));
function assertRecoveryClass(value) {
  if (!RECOVERY_CLASSES.has(value))
    fail("ERR_INVALID_EFFECT_RECOVERY_CLASS", `invalid recovery class: ${value}`);
  return value;
}
function assertDriverManifest(manifest) {
  if (!manifest || typeof manifest !== "object")
    fail("ERR_INVALID_DRIVER_MANIFEST");
  requiredString(manifest.driverId, "driverId");
  requiredList(manifest.supportedActuatorRefs, "supportedActuatorRefs");
  requiredList(manifest.supportedDescriptorFingerprints, "supportedDescriptorFingerprints");
  requiredList(manifest.supportedActuationClasses, "supportedActuationClasses");
  requiredKnownResponseStatusList(manifest.supportedResponseStatuses, "supportedResponseStatuses");
  requiredSafeInteger(manifest.maximumRequestBytes, "maximumRequestBytes");
  requiredSafeInteger(manifest.maximumResponseBytes, "maximumResponseBytes");
  assertRecoveryClass(manifest.recoveryClass);
  requiredPositiveSafeInteger(manifest.concurrencyLimit, "concurrencyLimit");
  requiredList(manifest.authorityLabels, "authorityLabels");
  return Object.freeze({
    driverId: manifest.driverId,
    supportedActuatorRefs: [...manifest.supportedActuatorRefs],
    supportedDescriptorFingerprints: [...manifest.supportedDescriptorFingerprints],
    supportedActuationClasses: [...manifest.supportedActuationClasses],
    supportedResponseStatuses: [...manifest.supportedResponseStatuses],
    maximumRequestBytes: manifest.maximumRequestBytes,
    maximumResponseBytes: manifest.maximumResponseBytes,
    recoveryClass: manifest.recoveryClass,
    concurrencyLimit: manifest.concurrencyLimit,
    authorityLabels: [...manifest.authorityLabels],
    diagnostics: manifest.diagnostics ?? {}
  });
}
function assertDriverCanResolve(manifest, hostRequest) {
  assertDriverManifest(manifest);
  if (!manifest.supportedActuatorRefs.includes(hostRequest.actuatorRef))
    fail("ERR_ACTUATOR_REF_NOT_SUPPORTED");
  if (!manifest.supportedDescriptorFingerprints.includes(hostRequest.descriptorFingerprint))
    fail("ERR_DESCRIPTOR_NOT_SUPPORTED");
  if (!manifest.supportedActuationClasses.includes(hostRequest.actuationClass))
    fail("ERR_ACTUATION_CLASS_NOT_SUPPORTED");
  if (hostRequest.responseSchema?.status !== undefined && !RESPONSE_STATUSES.has(hostRequest.responseSchema.status)) {
    fail("ERR_RESPONSE_STATUS_NOT_SUPPORTED");
  }
  if (hostRequest.responseSchema && !manifest.supportedResponseStatuses.includes(hostRequest.responseSchema.status)) {
    fail("ERR_RESPONSE_STATUS_NOT_SUPPORTED");
  }
  if (hostRequest.requestBytes?.byteLength > manifest.maximumRequestBytes)
    fail("ERR_HOST_REQUEST_TOO_LARGE");
  return true;
}
function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0)
    fail("ERR_INVALID_DRIVER_MANIFEST", `${field} is required`);
}
function requiredList(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail("ERR_INVALID_DRIVER_MANIFEST", `${field} must be a string list`);
  }
}
function requiredKnownResponseStatusList(value, field) {
  requiredList(value, field);
  if (value.some((item) => !RESPONSE_STATUSES.has(item))) {
    fail("ERR_INVALID_DRIVER_MANIFEST", `${field} must contain known response statuses`);
  }
}
function requiredSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail("ERR_INVALID_DRIVER_MANIFEST", `${field} must be a non-negative safe integer`);
}
function requiredPositiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1)
    fail("ERR_INVALID_DRIVER_MANIFEST", `${field} must be a positive safe integer`);
}

// src/protocol/world_manifest.mjs
var carrierManifest = Object.freeze({
  carrierVersion: "0.0.0-carrier-v0",
  supportedWorldRelease: "v0.1.0",
  supportedBoundaryRelease: "v0.6.2",
  applianceAbiVersion: "v4",
  turnClosureFormatVersion: "v1",
  universalWasm: Object.freeze({
    fileName: "world_universal_appliance.wasm",
    sha256: "a79ae458d3cc5145660dadfc678736e75822c8c70558f8139861dc1103e84add",
    checksumSource: "local World universal Appliance cache artifact selected by real Carrier conformance",
    releaseVerificationRequired: true
  }),
  runtime: Object.freeze({
    moduleFormat: "esm",
    runtimeDependencies: 0,
    allowsNativeWorldHelperProcess: false,
    allowsChildProcessProtocolEncoding: false
  })
});

// src/protocol/world_loaded_value_codec.mjs
var loadedValueCodecBoundary = Object.freeze({
  artifact: "world_loaded_value_codec.mjs",
  source: "released World JavaScript loaded-value codec",
  supportedWorldRelease: carrierManifest.supportedWorldRelease,
  hostAuthority: "decode/encode host-owned value images according to released codec only",
  worldEvidenceAuthority: false
});
var releasedLoadedValueCodec = Object.freeze({
  boundary: loadedValueCodecBoundary,
  encodeUnit,
  encodeBool,
  encodeI32,
  encodeU64Word,
  encodeBytes,
  encodeString,
  encodeByteStringList,
  encodeProduct,
  encodeSum,
  encodeCanonicalValueImage,
  decodeCanonicalValueImage,
  fingerprintValueImage,
  u64WordBytes
});
var textEncoder = new TextEncoder;
var MASK64 = (1n << 64n) - 1n;
var SECRET = [
  0xa0761d6478bd642fn,
  0xe7037ed1a0b428dbn,
  0x8ebc6af09c88c6e3n,
  0x589965cc75374cc3n
];
function encodeUnit() {
  return new Uint8Array;
}
function encodeBool(value) {
  return u8(value ? 1 : 0);
}
function encodeI32(value) {
  return i32(value);
}
function encodeU64Word(value) {
  return u64(value);
}
function encodeBytes(value) {
  const bytes = bytesOf(value);
  return concat([u32(bytes.length), bytes]);
}
function encodeString(value) {
  return encodeBytes(textEncoder.encode(value));
}
function encodeByteStringList(values) {
  return concat([u32(values.length), ...values.map((value) => encodeBytes(value))]);
}
function encodeProduct(fields) {
  return concat([u32(fields.length), ...fields.map(bytesOf)]);
}
function encodeSum(variantIndex, payload = null) {
  return payload == null ? concat([u32(variantIndex), u8(0)]) : concat([u32(variantIndex), u8(1), bytesOf(payload)]);
}
function encodeCanonicalValueImage({
  valueTableId = null,
  boundaryValueFingerprint = null,
  codecSchemaDescriptorFingerprint = null,
  bytes,
  dynamicSize = false,
  diagnosticTypeLabel = null
}) {
  const payload = bytesOf(bytes);
  const label = diagnosticTypeLabel == null ? null : bytesOf(diagnosticTypeLabel);
  const fingerprint = fingerprintValueImage({
    valueTableId,
    boundaryValueFingerprint,
    codecSchemaDescriptorFingerprint,
    dynamicSize,
    diagnosticTypeLabel: label,
    bytes: payload
  });
  return concat([
    u32(1),
    u32(1),
    u64(fingerprint),
    optionalU32(valueTableId),
    optionalU64(boundaryValueFingerprint),
    optionalU64(codecSchemaDescriptorFingerprint),
    u8(dynamicSize ? 1 : 0),
    portableBytes(payload),
    optionalPortableBytes(label)
  ]);
}
function decodeCanonicalValueImage(bytes, request = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  let offset = 0;
  if (readCanonicalU32(data, offset) !== 1)
    throw codecError("ERR_WORLD_VALUE_IMAGE_UNSUPPORTED");
  offset += 4;
  if (readCanonicalU32(data, offset) !== 1)
    throw codecError("ERR_WORLD_VALUE_IMAGE_UNSUPPORTED");
  offset += 4;
  const embeddedFingerprint = readCanonicalU64(data, offset);
  offset += 8;
  const valueTable = readCanonicalOptional(data, offset, 4, readCanonicalU32);
  offset = valueTable.offset;
  const boundaryValue = readCanonicalOptional(data, offset, 8, readCanonicalU64);
  offset = boundaryValue.offset;
  const codecSchema = readCanonicalOptional(data, offset, 8, readCanonicalU64);
  offset = codecSchema.offset;
  const dynamicSize = readCanonicalBool(data, offset);
  offset = dynamicSize.offset;
  const payload = readCanonicalPortableBytes(data, offset);
  offset = payload.offset;
  const diagnosticTypeLabel = readCanonicalOptionalPortableBytes(data, offset);
  offset = diagnosticTypeLabel.offset;
  if (offset !== data.byteLength)
    throw codecError("ERR_WORLD_VALUE_IMAGE_TRAILING_BYTES");
  const actualFingerprint = fingerprintValueImage({
    valueTableId: valueTable.value,
    boundaryValueFingerprint: boundaryValue.value,
    codecSchemaDescriptorFingerprint: codecSchema.value,
    dynamicSize: dynamicSize.value,
    diagnosticTypeLabel: diagnosticTypeLabel.value,
    bytes: payload.value
  });
  if (embeddedFingerprint !== actualFingerprint)
    throw codecError("ERR_WORLD_VALUE_IMAGE_FINGERPRINT");
  if (request.payloadValueRefFingerprint != null && boundaryValue.value !== BigInt(request.payloadValueRefFingerprint)) {
    throw codecError("ERR_WORLD_VALUE_IMAGE_PAYLOAD_REF");
  }
  if (request.payloadSchemaRefFingerprint != null && codecSchema.value !== BigInt(request.payloadSchemaRefFingerprint)) {
    throw codecError("ERR_WORLD_VALUE_IMAGE_PAYLOAD_SCHEMA_REF");
  }
  return {
    payload: payload.value,
    boundaryValueFingerprint: boundaryValue.value,
    codecSchemaDescriptorFingerprint: codecSchema.value,
    diagnosticTypeLabel: diagnosticTypeLabel.value,
    fingerprint: actualFingerprint
  };
}
function u64WordBytes(value) {
  return u64(value);
}
function fingerprintValueImage({
  valueTableId,
  boundaryValueFingerprint,
  codecSchemaDescriptorFingerprint,
  dynamicSize,
  diagnosticTypeLabel,
  bytes
}) {
  return wyhash64(concat([
    textEncoder.encode("world.frame.value_image.fingerprint"),
    u64(1),
    hashOptionalU32(valueTableId),
    hashOptionalU64(boundaryValueFingerprint),
    hashOptionalU64(codecSchemaDescriptorFingerprint),
    hashBool(dynamicSize),
    hashOptionalBytes(diagnosticTypeLabel),
    u64(bytes.length),
    bytes
  ]));
}
function hashBool(value) {
  return u64(value ? 1 : 0);
}
function hashOptionalU32(value) {
  return value == null ? hashBool(false) : concat([hashBool(true), u64(value)]);
}
function hashOptionalU64(value) {
  return value == null ? hashBool(false) : concat([hashBool(true), u64(value)]);
}
function hashOptionalBytes(value) {
  return value == null ? hashBool(false) : concat([hashBool(true), u64(value.length), value]);
}
function optionalU32(value) {
  return value == null ? u8(0) : concat([u8(1), u32(value)]);
}
function optionalU64(value) {
  return value == null ? u8(0) : concat([u8(1), u64(value)]);
}
function optionalPortableBytes(value) {
  return value == null ? u8(0) : concat([u8(1), portableBytes(value)]);
}
function readCanonicalOptionalPortableBytes(data, offset) {
  const tag = readCanonicalOptionalTag(data, offset);
  if (tag === 0)
    return { value: null, offset: offset + 1 };
  return readCanonicalPortableBytes(data, offset + 1);
}
function readCanonicalOptional(data, offset, width, readValue) {
  const tag = readCanonicalOptionalTag(data, offset);
  if (tag === 0)
    return { value: null, offset: offset + 1 };
  const valueOffset = offset + 1;
  const next = valueOffset + width;
  if (next > data.byteLength)
    throw codecError("ERR_WORLD_VALUE_IMAGE_MALFORMED");
  return { value: readValue(data, valueOffset), offset: next };
}
function readCanonicalOptionalTag(data, offset) {
  if (offset >= data.byteLength)
    throw codecError("ERR_WORLD_VALUE_IMAGE_MALFORMED");
  const tag = data[offset];
  if (tag !== 0 && tag !== 1)
    throw codecError("ERR_WORLD_VALUE_IMAGE_MALFORMED");
  return tag;
}
function readCanonicalPortableBytes(data, offset) {
  const length = Number(canonicalView(data, offset, 8).getBigUint64(0, true));
  if (!Number.isSafeInteger(length))
    throw codecError("ERR_WORLD_VALUE_IMAGE_MALFORMED");
  const start = offset + 8;
  const end = start + length;
  if (end > data.byteLength)
    throw codecError("ERR_WORLD_VALUE_IMAGE_MALFORMED");
  return { value: data.slice(start, end), offset: end };
}
function readCanonicalU32(data, offset) {
  return canonicalView(data, offset, 4).getUint32(0, true);
}
function readCanonicalU64(data, offset) {
  return canonicalView(data, offset, 8).getBigUint64(0, true);
}
function readCanonicalBool(data, offset) {
  if (offset >= data.byteLength)
    throw codecError("ERR_WORLD_VALUE_IMAGE_MALFORMED");
  const value = data[offset];
  if (value !== 0 && value !== 1)
    throw codecError("ERR_WORLD_VALUE_IMAGE_MALFORMED");
  return { value: value === 1, offset: offset + 1 };
}
function canonicalView(data, offset, length) {
  if (offset > data.byteLength || length > data.byteLength - offset)
    throw codecError("ERR_WORLD_VALUE_IMAGE_MALFORMED");
  return new DataView(data.buffer, data.byteOffset + offset, length);
}
function codecError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function portableBytes(value) {
  const bytes = bytesOf(value);
  return concat([u64(bytes.length), bytes]);
}
function bytesOf(value) {
  if (value instanceof Uint8Array)
    return value;
  if (typeof value === "string")
    return textEncoder.encode(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer)
    return new Uint8Array(value);
  if (Array.isArray(value))
    return Uint8Array.from(value);
  throw new Error("expected byte-like value");
}
function u8(value) {
  return Uint8Array.of(Number(assertUnsignedInteger(value, 8, "u8")));
}
function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, Number(assertUnsignedInteger(value, 32, "u32")), true);
  return out;
}
function i32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, Number(assertSignedInteger(value, 32, "i32")), true);
  return out;
}
function u64(value) {
  const out = new Uint8Array(8);
  const actual = assertUnsignedInteger(value, 64, "u64");
  const view = new DataView(out.buffer);
  view.setUint32(0, Number(actual & 0xffff_ffffn), true);
  view.setUint32(4, Number(actual >> 32n & 0xffff_ffffn), true);
  return out;
}
function assertUnsignedInteger(value, bits, label) {
  let actual;
  try {
    actual = BigInt(value);
  } catch {
    throw new Error(`${label} out of range`);
  }
  const maximum = (1n << BigInt(bits)) - 1n;
  if (actual < 0n || actual > maximum)
    throw new Error(`${label} out of range`);
  return actual;
}
function assertSignedInteger(value, bits, label) {
  let actual;
  try {
    actual = BigInt(value);
  } catch {
    throw new Error(`${label} out of range`);
  }
  const minimum = -(1n << BigInt(bits - 1));
  const maximum = (1n << BigInt(bits - 1)) - 1n;
  if (actual < minimum || actual > maximum)
    throw new Error(`${label} out of range`);
  return actual;
}
function concat(chunks) {
  const normalized = chunks.map(bytesOf);
  const total = normalized.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of normalized) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function wyhash64(input, seed = 0n) {
  const bytes = bytesOf(input);
  const state0 = (seed ^ mix(seed ^ SECRET[0], SECRET[1])) & MASK64;
  const state = [state0, state0, state0];
  let a = 0n;
  let b = 0n;
  if (bytes.length <= 16) {
    [a, b] = smallKey(bytes);
  } else {
    let i = 0;
    if (bytes.length >= 48) {
      while (i + 48 < bytes.length) {
        for (let lane = 0;lane < 3; lane += 1) {
          const left = read(bytes, i + 8 * (2 * lane), 8);
          const right = read(bytes, i + 8 * (2 * lane + 1), 8);
          state[lane] = mix(left ^ SECRET[lane + 1], right ^ state[lane]);
        }
        i += 48;
      }
      state[0] = (state[0] ^ state[1] ^ state[2]) & MASK64;
    }
    let j = i;
    while (j + 16 < bytes.length) {
      state[0] = mix(read(bytes, j, 8) ^ SECRET[1], read(bytes, j + 8, 8) ^ state[0]);
      j += 16;
    }
    a = read(bytes, bytes.length - 16, 8);
    b = read(bytes, bytes.length - 8, 8);
  }
  a = (a ^ SECRET[1]) & MASK64;
  b = (b ^ state[0]) & MASK64;
  [a, b] = mum(a, b);
  return mix(a ^ SECRET[0] ^ BigInt(bytes.length), b ^ SECRET[1]);
}
function smallKey(bytes) {
  if (bytes.length >= 4) {
    const end = bytes.length - 4;
    const quarter = bytes.length >> 3 << 2;
    return [
      (read(bytes, 0, 4) << 32n | read(bytes, quarter, 4)) & MASK64,
      (read(bytes, end, 4) << 32n | read(bytes, end - quarter, 4)) & MASK64
    ];
  }
  if (bytes.length > 0) {
    return [
      (BigInt(bytes[0]) << 16n | BigInt(bytes[bytes.length >> 1]) << 8n | BigInt(bytes[bytes.length - 1])) & MASK64,
      0n
    ];
  }
  return [0n, 0n];
}
function read(bytes, offset, count) {
  let value = 0n;
  for (let i = 0;i < count; i += 1)
    value |= BigInt(bytes[offset + i]) << BigInt(8 * i);
  return value & MASK64;
}
function mum(a, b) {
  const product = (a & MASK64) * (b & MASK64);
  return [product & MASK64, product >> 64n & MASK64];
}
function mix(a, b) {
  const [lo, hi] = mum(a, b);
  return (lo ^ hi) & MASK64;
}

// src/protocol/world_appliance_wire_codec.mjs
var wireCodecBoundary = Object.freeze({
  artifact: "world_appliance_wire_codec.mjs",
  source: "released World JavaScript wire codec",
  supportedWorldRelease: carrierManifest.supportedWorldRelease,
  hostAuthority: "host-authored TurnInput and ResolutionInput only",
  worldEvidenceAuthority: false
});
var releasedWireCodec = Object.freeze({
  boundary: wireCodecBoundary,
  encodeBootTurnInput,
  encodeRestoreTurnInput,
  encodeContinueTurnInput,
  encodeResolutionInput,
  encodeResolutionInputBytes,
  decodeResolutionInputBytes,
  encodeTurnInput,
  decodeRuntimeManifest,
  decodeApplianceManifest,
  decodeHostRequest
});
var operationBoot = 0;
var operationRestore = 1;
var operationContinue = 2;
var resolutionResponded = 0;
var applianceManifestFormatVersion = 3;
var applianceManifestFingerprintVersion = 3;
function encodeBootTurnInput({ manifestFingerprint, metadata = "" }) {
  return encodeTurnInput({
    operation: operationBoot,
    manifestFingerprint,
    turnSequenceNumber: 0n,
    hostMetadata: metadata
  });
}
function encodeContinueTurnInput({ manifestFingerprint, previousTurnReceiptFingerprint, turnSequenceNumber, resolutions, metadata = "" }) {
  return encodeTurnInput({
    operation: operationContinue,
    manifestFingerprint,
    previousTurnReceiptFingerprint,
    turnSequenceNumber,
    resolutions,
    hostMetadata: metadata
  });
}
function encodeRestoreTurnInput({
  manifestFingerprint,
  parentTurnClosureBytes,
  expectedParentClosureFingerprint,
  expectedParentStateFingerprint,
  previousTurnReceiptFingerprint,
  turnSequenceNumber,
  resolutions = [],
  retention = null,
  metadata = ""
}) {
  return encodeTurnInput({
    operation: operationRestore,
    manifestFingerprint,
    expectedParentClosureFingerprint,
    expectedParentStateFingerprint,
    previousTurnReceiptFingerprint,
    turnSequenceNumber,
    parentTurnClosureBytes,
    resolutions,
    retention,
    hostMetadata: metadata
  });
}
function encodeResolutionInput({ request, responseFingerprint = 0x600d0001n, status = resolutionResponded, metadata = "fixture-response" }) {
  const responseValueImageBytes = status === resolutionResponded ? encodeCanonicalValueImage({
    boundaryValueFingerprint: request.expectedResponseValueRefFingerprint,
    codecSchemaDescriptorFingerprint: request.expectedResponseSchemaRefFingerprint,
    bytes: u64WordBytes(responseFingerprint),
    dynamicSize: false
  }) : new Uint8Array;
  return {
    targetHostRequestFingerprint: request.requestFingerprint,
    status,
    responseValueImageBytes,
    hostClaimBytes: utf8("host-claim:fixture"),
    attemptNumber: 1,
    metadata: utf8(metadata)
  };
}
function encodeResolutionInputBytes(value) {
  return resolutionInput(value);
}
function decodeResolutionInputBytes(bytes) {
  const reader = new BinaryReader(bytes);
  const value = decodeResolutionInput(reader);
  if (value.formatVersion !== 1)
    throw new Error(`unsupported ResolutionInput format version: ${value.formatVersion}`);
  if (reader.remaining() !== 0)
    throw new Error("trailing ResolutionInput bytes");
  return value;
}
function encodeTurnInput({
  operation,
  manifestFingerprint,
  expectedParentClosureFingerprint = null,
  expectedParentStateFingerprint = null,
  previousTurnReceiptFingerprint = null,
  turnSequenceNumber,
  rootArgumentImages = [],
  parentTurnClosureBytes = new Uint8Array,
  resolutions = [],
  receiverEvidenceFingerprints = [],
  retention = null,
  deterministicTurnBudget = 0n,
  requestedEvidenceProfile = 1,
  hostMetadata = ""
}) {
  const sortedResolutions = [...resolutions].sort((left, right) => compareU64(left.targetHostRequestFingerprint, right.targetHostRequestFingerprint));
  for (let i = 1;i < sortedResolutions.length; i += 1) {
    if (toU64(sortedResolutions[i - 1].targetHostRequestFingerprint) === toU64(sortedResolutions[i].targetHostRequestFingerprint)) {
      throw new Error("duplicate resolution target");
    }
  }
  return concat2([
    u322(2),
    u82(operation),
    u642(manifestFingerprint),
    optionalU642(expectedParentClosureFingerprint),
    optionalU642(expectedParentStateFingerprint),
    optionalU642(previousTurnReceiptFingerprint),
    u642(turnSequenceNumber),
    byteSlices(rootArgumentImages),
    bytes(parentTurnClosureBytes),
    resolutionInputs(sortedResolutions),
    u64Slice(receiverEvidenceFingerprints),
    optionalRetentionInput(retention),
    u642(deterministicTurnBudget),
    u82(requestedEvidenceProfile),
    bytes(hostMetadata)
  ]);
}
function decodeRuntimeManifest(text) {
  return parseManifestText(text);
}
function decodeApplianceManifest(bytes) {
  const reader = new BinaryReader(bytes);
  const manifest = {
    formatVersion: reader.u32(),
    fingerprintVersion: reader.u32(),
    manifestFingerprint: reader.u64(),
    abiVersion: reader.u32(),
    rootTargetRefFingerprint: reader.u64(),
    rootWorldSurfaceFingerprint: reader.u64(),
    rootTargetCertificateFingerprint: reader.u64(),
    linkPlanFingerprint: reader.u64(),
    linkCertificateFingerprint: reader.u64(),
    assemblyFingerprint: reader.u64(),
    providerTargetRefFingerprints: reader.u64Slice(),
    fabricPlanFingerprints: reader.u64Slice(),
    residualImportSetFingerprint: reader.u64(),
    actuationDescriptorFingerprints: reader.u64Slice(),
    actuationBindingFingerprints: reader.u64Slice(),
    actuationActuatorRefFingerprints: reader.u64Slice(),
    actuationWorldPortIds: reader.u64Slice(),
    actuationPayloadValueRefFingerprints: reader.u64Slice(),
    actuationResponseValueRefFingerprints: reader.u64Slice(),
    actuationClasses: reader.u8Slice(),
    actuationAllowedResponseStatuses: reader.u8Slice(),
    supervisionPolicyFingerprint: reader.u64(),
    defaultPermitRequirementFingerprints: reader.u64Slice(),
    capsuleProfileFingerprint: reader.u64(),
    archiveProfileFingerprint: reader.u64(),
    supportedExecutionModes: reader.u8(),
    enabledFeatures: reader.u16(),
    capacityFingerprint: reader.u64(),
    memoryPlanFingerprint: reader.u64(),
    requiredHostCapabilities: reader.u8(),
    metadata: reader.bytes()
  };
  const trailingBytes = reader.remaining();
  if (manifest.formatVersion !== applianceManifestFormatVersion)
    throw new Error(`unsupported ApplianceManifest format version: ${manifest.formatVersion}`);
  if (manifest.fingerprintVersion !== applianceManifestFingerprintVersion)
    throw new Error(`unsupported ApplianceManifest fingerprint version: ${manifest.fingerprintVersion}`);
  if (`v${manifest.abiVersion}` !== carrierManifest.applianceAbiVersion)
    throw new Error(`unsupported Appliance ABI version: v${manifest.abiVersion}`);
  if (trailingBytes !== 0)
    throw new Error("trailing ApplianceManifest bytes");
  return { ...manifest, trailingBytes };
}
function decodeHostRequest(reader) {
  const start = reader.offset;
  const request = {
    requestFormatVersion: reader.u32(),
    requestFingerprintVersion: reader.u32(),
    requestFingerprint: reader.u64(),
    turnSequenceNumber: reader.u64(),
    requestOrdinal: reader.u32(),
    runHandleFingerprint: reader.u64(),
    pendingPortFingerprint: reader.u64(),
    worldPortId: reader.u32(),
    targetRefFingerprint: reader.u64(),
    worldSurfaceFingerprint: reader.u64(),
    actuatorRefFingerprint: reader.u64(),
    actuationClass: reader.u8(),
    allowedResponseStatuses: reader.u8(),
    intentFingerprint: reader.u64(),
    envelopeFingerprint: reader.u64(),
    decisionFingerprint: reader.u64(),
    expectedResponseDescriptorFingerprint: reader.u64(),
    idempotencyKeyFingerprint: reader.u64(),
    supervisionRefFingerprint: reader.optionalU64(),
    metadata: reader.bytes(),
    frameRequestBytes: reader.bytes(),
    payloadValueImageBytes: reader.bytes(),
    payloadValueRefFingerprint: reader.optionalU64(),
    payloadSchemaRefFingerprint: reader.optionalU64(),
    expectedResponseValueRefFingerprint: reader.optionalU64(),
    expectedResponseSchemaRefFingerprint: reader.optionalU64(),
    preparedActuationEvidenceBytes: reader.bytes(),
    idempotencyKeyBytes: reader.bytes()
  };
  if (request.requestFormatVersion !== 4)
    throw new Error(`unsupported HostRequest format version: ${request.requestFormatVersion}`);
  if (request.requestFingerprintVersion !== 4)
    throw new Error(`unsupported HostRequest fingerprint version: ${request.requestFingerprintVersion}`);
  request.hostRequestBytes = reader.bytesValue.slice(start, reader.offset);
  return request;
}

class BinaryReader {
  constructor(bytes) {
    this.bytesValue = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.offset = 0;
    this.view = new DataView(this.bytesValue.buffer, this.bytesValue.byteOffset, this.bytesValue.byteLength);
  }
  u8() {
    this.require(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }
  u16() {
    this.require(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }
  u32() {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }
  u64() {
    this.require(8);
    const lo = BigInt(this.view.getUint32(this.offset, true));
    const hi = BigInt(this.view.getUint32(this.offset + 4, true));
    this.offset += 8;
    return hi << 32n | lo;
  }
  optionalU64() {
    const tag = this.u8();
    if (tag === 0)
      return null;
    if (tag !== 1)
      throw new Error("invalid optional u64 tag");
    return this.u64();
  }
  bytes() {
    const len = this.u32();
    this.require(len);
    const out = this.bytesValue.slice(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }
  bytesLen() {
    return this.bytes().length;
  }
  u64Slice() {
    const count = Number(this.u64());
    const values = [];
    for (let i = 0;i < count; i += 1)
      values.push(this.u64());
    return values;
  }
  u8Slice() {
    const count = Number(this.u64());
    const values = [];
    for (let i = 0;i < count; i += 1)
      values.push(this.u8());
    return values;
  }
  skipU64Slice() {
    this.u64Slice();
  }
  skipByteSlices() {
    const count = Number(this.u64());
    for (let i = 0;i < count; i += 1)
      this.bytesLen();
  }
  skipQuiescence() {
    this.u64();
    this.u8();
    for (let i = 0;i < 9; i += 1)
      this.u64();
  }
  skipCheckpoint() {
    this.u32();
    this.u32();
    this.u64();
    this.u64();
    this.u64();
    this.u64();
    this.optionalU64();
    this.bytesLen();
    this.optionalU64();
    this.optionalU64();
    this.optionalU64();
    this.optionalU64();
    this.skipOptionalCursor();
    this.skipOptionalCursor();
    this.u8();
    this.optionalU64();
    const outstanding = Number(this.u64());
    for (let i = 0;i < outstanding; i += 1)
      decodeHostRequest(this);
    this.u8();
    this.bytesLen();
  }
  skipOptionalCursor() {
    const tag = this.u8();
    if (tag === 0)
      return;
    if (tag !== 1)
      throw new Error("invalid optional cursor tag");
    this.u32();
    this.u64();
    this.u64();
    this.optionalU64();
    this.u64();
    this.u64();
    this.u64();
    this.bytesLen();
  }
  readTurnReceipt() {
    const receipt = {
      formatVersion: this.u32(),
      fingerprintVersion: this.u32(),
      receiptFingerprint: this.u64(),
      manifestFingerprint: this.u64(),
      turnSequenceNumber: this.u64(),
      commandFingerprint: this.u64(),
      priorCheckpointFingerprint: this.optionalU64(),
      appliedHostReplyFingerprints: this.u64Slice(),
      emittedHostRequestFingerprints: this.u64Slice(),
      sourceCapsuleFingerprint: this.optionalU64(),
      resultingCapsuleFingerprint: this.u64(),
      archiveAppendBatchFingerprint: this.optionalU64(),
      resultingArchiveMomentFingerprint: this.optionalU64(),
      resultingArchiveSealFingerprint: this.optionalU64(),
      resultingChronicleCursorFingerprint: this.optionalU64(),
      rootResultFingerprint: this.optionalU64(),
      status: this.u8(),
      runReceiptFingerprint: this.optionalU64(),
      blockerCount: this.u64(),
      warningCount: this.u64()
    };
    if (receipt.formatVersion !== 1)
      throw new Error(`unsupported TurnReceipt format version: ${receipt.formatVersion}`);
    if (receipt.fingerprintVersion !== 1)
      throw new Error(`unsupported TurnReceipt fingerprint version: ${receipt.fingerprintVersion}`);
    if (this.remaining() !== 0)
      throw new Error("trailing TurnReceipt bytes");
    return receipt;
  }
  remaining() {
    return this.bytesValue.length - this.offset;
  }
  require(len) {
    if (len < 0 || this.offset + len > this.bytesValue.length)
      throw new Error("truncated wire bytes");
  }
}
function resolutionInputs(values) {
  return concat2([u642(values.length), ...values.map(resolutionInput)]);
}
function resolutionInput(value) {
  return concat2([
    u322(1),
    u642(value.targetHostRequestFingerprint),
    u82(value.status),
    bytes(value.responseValueImageBytes ?? new Uint8Array),
    bytes(value.hostClaimBytes ?? new Uint8Array),
    u322(value.attemptNumber ?? 0),
    bytes(value.metadata ?? new Uint8Array)
  ]);
}
function decodeResolutionInput(reader) {
  return {
    formatVersion: reader.u32(),
    targetHostRequestFingerprint: reader.u64(),
    status: reader.u8(),
    responseValueImageBytes: reader.bytes(),
    hostClaimBytes: reader.bytes(),
    attemptNumber: reader.u32(),
    metadata: reader.bytes()
  };
}
function optionalRetentionInput(value) {
  if (value == null)
    return u82(0);
  return concat2([
    u82(1),
    u322(1),
    u642(value.priorArchiveAppendBatchFingerprint),
    u642(value.resultingMomentFingerprint),
    u642(value.resultingSealFingerprint),
    u642(value.resultingChronicleCursorFingerprint),
    u82(value.hostRetentionStatus),
    bytes(value.metadata ?? new Uint8Array)
  ]);
}
function byteSlices(values) {
  return concat2([u642(values.length), ...values.map(bytes)]);
}
function u64Slice(values) {
  return concat2([u642(values.length), ...values.map(u642)]);
}
function optionalU642(value) {
  return value == null ? u82(0) : concat2([u82(1), u642(value)]);
}
function bytes(value) {
  const actual = bytesOf2(value);
  return concat2([u322(actual.length), actual]);
}
function u82(value) {
  return Uint8Array.of(Number(toUnsignedInteger(value, 8, "u8")));
}
function u322(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, Number(toUnsignedInteger(value, 32, "u32")), true);
  return out;
}
function u642(value) {
  const out = new Uint8Array(8);
  const actual = toU64(value);
  const view = new DataView(out.buffer);
  view.setUint32(0, Number(actual & 0xffff_ffffn), true);
  view.setUint32(4, Number(actual >> 32n & 0xffff_ffffn), true);
  return out;
}
function utf8(value) {
  return new TextEncoder().encode(value);
}
function bytesOf2(value) {
  if (value instanceof Uint8Array)
    return value;
  if (typeof value === "string")
    return utf8(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer)
    return new Uint8Array(value);
  if (Array.isArray(value))
    return Uint8Array.from(value);
  throw new Error("expected byte-like value");
}
function concat2(chunks) {
  const normalized = chunks.map(bytesOf2);
  const total = normalized.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of normalized) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
function compareU64(left, right) {
  const a = toU64(left);
  const b = toU64(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
function toU64(value) {
  return toUnsignedInteger(value, 64, "u64");
}
function toUnsignedInteger(value, bits, label) {
  let actual;
  try {
    actual = BigInt(value);
  } catch {
    throw new Error(`${label} out of range`);
  }
  const maximum = (1n << BigInt(bits)) - 1n;
  if (actual < 0n || actual > maximum)
    throw new Error(`${label} out of range`);
  return actual;
}
function parseManifestText(text) {
  const values = new Map;
  let lineNumber = 0;
  for (const line of text.split(`
`)) {
    lineNumber += 1;
    if (line.length === 0)
      continue;
    const index = line.indexOf("=");
    if (index <= 0) {
      if (lineNumber === 1) {
        values.set("format", line);
        continue;
      }
      throw new Error(`malformed manifest line: ${line}`);
    }
    values.set(line.slice(0, index), line.slice(index + 1));
  }
  return values;
}

// src/core/capability_driver.mjs
var FORBIDDEN_WORLD_EVIDENCE_KEYS = new Set([
  "boundaryModuleBytes",
  "worldReceiptBytes",
  "turnReceiptBytes",
  "turnClosureBytes",
  "capsuleBytes",
  "chronicleEventBytes",
  "archiveAppendBatchBytes",
  "actuationReceiptBytes",
  "executableImageBytes",
  "runHead"
]);

class CapabilityPreflightReport {
  constructor(fields = {}) {
    this.accepted = fields.accepted === true;
    this.blockers = Object.freeze([...fields.blockers ?? []]);
    this.warnings = Object.freeze([...fields.warnings ?? []]);
    this.diagnostics = Object.freeze(fields.diagnostics ?? {});
    Object.freeze(this);
  }
}

class DryRunReport {
  constructor(fields = {}) {
    this.wouldInvoke = fields.wouldInvoke === true;
    this.proposedAction = fields.proposedAction ?? null;
    this.resolutionPolicy = fields.resolutionPolicy ?? "not-submitted";
    this.diagnostics = Object.freeze(fields.diagnostics ?? {});
    Object.freeze(this);
  }
}

class ShadowReport {
  constructor(fields = {}) {
    this.liveInvoked = fields.liveInvoked === true;
    this.submittedToWorld = false;
    this.schemaAccepted = fields.schemaAccepted === true;
    this.diagnostics = Object.freeze(fields.diagnostics ?? {});
    Object.freeze(this);
  }
}
function defaultCapabilityPreflight(manifestLike, hostRequest) {
  const manifest = assertDriverManifest(manifestLike);
  try {
    assertDriverCanResolve(manifest, hostRequest);
    return new CapabilityPreflightReport({ accepted: true });
  } catch (error) {
    return new CapabilityPreflightReport({
      accepted: false,
      blockers: [error.code ?? "ERR_CAPABILITY_PREFLIGHT_REJECTED"],
      diagnostics: { message: error.message }
    });
  }
}
function capabilityHostClaimBytes(value) {
  return fromUtf8(stableJson({
    kind: "world-host.capability.host-claim.v0",
    value,
    worldAuthoredEvidence: false
  }));
}

// src/core/capability_policy.mjs
function createCapabilityPolicy(input = {}) {
  return new CapabilityPolicy(input);
}

class CapabilityPolicy {
  constructor(input = {}) {
    this.allowLiveEffects = input.allowLiveEffects === true;
    this.allowNetworkEffects = input.allowNetworkEffects === true;
    this.allowFileEffects = input.allowFileEffects === true;
    this.allowHumanEffects = input.allowHumanEffects === true;
    this.allowBestEffort = input.allowBestEffort === true;
    this.requireApprovalForDestructiveEffects = input.requireApprovalForDestructiveEffects !== false;
    this.requireApprovalForNetworkEffects = input.requireApprovalForNetworkEffects === true;
    this.requireApprovalForBestEffort = input.requireApprovalForBestEffort !== false;
    this.maximumLiveModelCalls = nonNegativeSafeInteger(input.maximumLiveModelCalls ?? 0, "maximumLiveModelCalls");
    this.maximumRequestBytes = positiveSafeInteger(input.maximumRequestBytes ?? input.maximumPromptBytes ?? 1024 * 1024, "maximumRequestBytes");
    this.maximumPromptBytes = positiveSafeInteger(input.maximumPromptBytes ?? this.maximumRequestBytes, "maximumPromptBytes");
    this.maximumResponseBytes = positiveSafeInteger(input.maximumResponseBytes ?? 1024 * 1024, "maximumResponseBytes");
    this.allowedOrigins = new Set(iterable(input.allowedOrigins));
    this.allowedMethods = new Set(iterable(input.allowedMethods).map((item) => String(item).toUpperCase()));
    this.allowedFileRoots = new Set(iterable(input.allowedFileRoots));
    this.allowedAuthorityLabels = new Set(iterable(input.allowedAuthorityLabels));
    this.allowedCapabilityPacks = new Set(iterable(input.allowedCapabilityPacks));
    this.deniedCapabilityPacks = new Set(iterable(input.deniedCapabilityPacks));
    this.redactionPolicy = input.redactionPolicy ?? "secret-shaped";
    this.dryRun = input.dryRun === true;
    this.shadowMode = input.shadowMode === true;
    this.auditOnly = input.auditOnly === true;
    Object.freeze(this.allowedOrigins);
    Object.freeze(this.allowedMethods);
    Object.freeze(this.allowedFileRoots);
    Object.freeze(this.allowedAuthorityLabels);
    Object.freeze(this.allowedCapabilityPacks);
    Object.freeze(this.deniedCapabilityPacks);
    Object.freeze(this);
  }
}
function assertCapabilityPolicyAllows({ manifest, hostRequest = null, policy: inputPolicy = {}, mode = "live", action = null, enforceNetworkTarget = true }) {
  const policy = createCapabilityPolicy(inputPolicy);
  if (mode === "live" && policy.auditOnly === true)
    fail("ERR_CAPABILITY_AUDIT_ONLY_DENIED");
  if (mode === "live" && policy.allowLiveEffects !== true)
    fail("ERR_CAPABILITY_LIVE_DENIED");
  if (policy.deniedCapabilityPacks.has(manifest?.packFingerprint) || policy.deniedCapabilityPacks.has(manifest?.driverId)) {
    fail("ERR_CAPABILITY_PACK_DENIED");
  }
  if (policy.allowedCapabilityPacks.size && !policy.allowedCapabilityPacks.has(manifest?.packFingerprint) && !policy.allowedCapabilityPacks.has(manifest?.driverId)) {
    fail("ERR_CAPABILITY_PACK_NOT_ALLOWED");
  }
  const authorityLabels = manifest?.authorityLabels ?? [];
  const deniedAuthorityLabels = authorityLabels.filter((label) => policy.allowedAuthorityLabels.size && !policy.allowedAuthorityLabels.has(label));
  if (deniedAuthorityLabels.length)
    fail("ERR_CAPABILITY_AUTHORITY_DENIED", "authority label denied", { labels: deniedAuthorityLabels });
  if (isNetwork(manifest, hostRequest) && policy.allowNetworkEffects !== true)
    fail("ERR_CAPABILITY_NETWORK_DENIED");
  if (isFile(manifest, hostRequest) && policy.allowFileEffects !== true)
    fail("ERR_CAPABILITY_FILE_DENIED");
  if (isHuman(manifest, hostRequest) && policy.allowHumanEffects !== true)
    fail("ERR_CAPABILITY_HUMAN_DENIED");
  if (mode === "live" && isLiveModelCall(manifest, hostRequest) && policy.maximumLiveModelCalls < 1)
    fail("ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED");
  if (manifest?.recoveryClass === EffectRecoveryClass.bestEffort && policy.allowBestEffort !== true)
    fail("ERR_BEST_EFFORT_REQUIRES_OPERATOR_OPT_IN");
  const policyRequestBytes = hostRequest?.policyRequestBytes ?? hostRequest?.requestBytes;
  if (policyRequestBytes?.byteLength > policy.maximumRequestBytes)
    fail("ERR_CAPABILITY_PROMPT_TOO_LARGE");
  if (manifest?.maximumResponseBytes > policy.maximumResponseBytes)
    fail("ERR_CAPABILITY_RESPONSE_LIMIT_EXCEEDS_POLICY");
  if (isNetwork(manifest, hostRequest)) {
    if (enforceNetworkTarget) {
      assertOriginAndMethodAllowed(hostRequest, policy);
    } else {
      assertNetworkAllowlistsPresent(policy);
    }
  }
  assertFileRootAllowed(manifest, policy);
  const approved = action?.approved === true;
  if (action?.destructive === true && policy.requireApprovalForDestructiveEffects && !approved)
    fail("ERR_CAPABILITY_APPROVAL_REQUIRED");
  if (isNetwork(manifest, hostRequest) && policy.requireApprovalForNetworkEffects && !approved)
    fail("ERR_CAPABILITY_APPROVAL_REQUIRED");
  if (manifest?.recoveryClass === EffectRecoveryClass.bestEffort && policy.requireApprovalForBestEffort && !approved)
    fail("ERR_CAPABILITY_APPROVAL_REQUIRED");
  return true;
}
function isNetwork(manifest, hostRequest) {
  return hostRequest?.actuationClass === "http" || (manifest?.authorityLabels ?? []).some((label) => label.startsWith("network:"));
}
function isFile(manifest, hostRequest) {
  return hostRequest?.actuationClass === "file" || (manifest?.authorityLabels ?? []).some((label) => label.startsWith("file:"));
}
function isHuman(manifest, hostRequest) {
  return hostRequest?.actuationClass === "human" || (manifest?.authorityLabels ?? []).some((label) => label.startsWith("human:"));
}
function isLiveModelCall(manifest, hostRequest) {
  if (hostRequest?.actuationClass !== "model")
    return false;
  if (manifest?.driverId === "fixture-agent-model" || manifest?.diagnostics?.deterministic === true)
    return false;
  const labels = manifest?.authorityLabels ?? [];
  if (labels.some((label) => label.startsWith("model:fixture")))
    return false;
  return labels.some((label) => label.startsWith("model:"));
}
function assertOriginAndMethodAllowed(hostRequest, policy) {
  if (!hostRequest?.requestBytes)
    fail("ERR_CAPABILITY_NETWORK_TARGET_REQUIRED");
  const parsed = parseJsonRequest(hostRequest);
  if (!parsed?.url)
    fail("ERR_CAPABILITY_NETWORK_TARGET_REQUIRED");
  let url;
  try {
    url = new URL(parsed.url);
  } catch {
    fail("ERR_CAPABILITY_NETWORK_TARGET_REQUIRED");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    fail("ERR_CAPABILITY_NETWORK_TARGET_REQUIRED", "network target must be http(s)");
  if (url.username || url.password)
    fail("ERR_CAPABILITY_NETWORK_TARGET_REQUIRED", "network target must not include credentials");
  const origin = url.origin;
  if (!policy.allowedOrigins.size)
    fail("ERR_CAPABILITY_ORIGIN_ALLOWLIST_REQUIRED");
  if (!policy.allowedOrigins.has(origin))
    fail("ERR_CAPABILITY_ORIGIN_DENIED", `origin denied: ${origin}`);
  if (!policy.allowedMethods.size)
    fail("ERR_CAPABILITY_METHOD_ALLOWLIST_REQUIRED");
  const method = parsed.method === undefined ? null : String(parsed.method).toUpperCase();
  if (method === null)
    fail("ERR_CAPABILITY_METHOD_REQUIRED");
  if (!policy.allowedMethods.has(method))
    fail("ERR_CAPABILITY_METHOD_DENIED", `method denied: ${method}`);
}
function assertNetworkAllowlistsPresent(policy) {
  if (!policy.allowedOrigins.size)
    fail("ERR_CAPABILITY_ORIGIN_ALLOWLIST_REQUIRED");
  if (!policy.allowedMethods.size)
    fail("ERR_CAPABILITY_METHOD_ALLOWLIST_REQUIRED");
}
function assertFileRootAllowed(manifest, policy) {
  if (!policy.allowedFileRoots.size)
    return;
  const root = manifest?.diagnostics?.root ?? manifest?.policyRequirements?.root;
  if ((manifest?.authorityLabels ?? []).some((label) => label.startsWith("file:")) && (!root || !policy.allowedFileRoots.has(root))) {
    fail("ERR_CAPABILITY_FILE_ROOT_DENIED", `file root denied: ${root ?? "unknown"}`);
  }
}
function parseJsonRequest(hostRequest) {
  try {
    return JSON.parse(new TextDecoder().decode(hostRequest.requestBytes));
  } catch {
    return null;
  }
}
function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1)
    fail("ERR_CAPABILITY_POLICY_LIMIT_INVALID", `${field} must be positive`);
  return value;
}
function nonNegativeSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail("ERR_CAPABILITY_POLICY_LIMIT_INVALID", `${field} must be non-negative`);
  return value;
}
function iterable(value) {
  if (value == null)
    return [];
  if (value instanceof Set)
    return [...value];
  if (Array.isArray(value))
    return value;
  return [value];
}

// src/core/secrets.mjs
class SecretDescriptor {
  constructor({ name, class: secretClass = "opaque", provider = null, required = true } = {}) {
    if (typeof name !== "string" || name.length === 0)
      fail("ERR_SECRET_DESCRIPTOR_INVALID", "secret name is required");
    this.name = name;
    this.class = secretClass;
    this.provider = provider;
    this.required = required !== false;
    this.redacted = true;
    Object.freeze(this);
  }
}
function assertRequiredSecretsAvailable(secretProvider, descriptors) {
  for (const descriptorLike of descriptors ?? []) {
    const descriptor = descriptorLike instanceof SecretDescriptor ? descriptorLike : new SecretDescriptor(typeof descriptorLike === "string" ? { name: descriptorLike } : descriptorLike);
    if (descriptor.required && !secretProvider.has(descriptor.name))
      fail("ERR_SECRET_MISSING", `missing secret: ${descriptor.name}`, { name: descriptor.name });
  }
  return true;
}

// src/drivers/generic_http_json_capability_driver.mjs
var DEFAULT_MAXIMUM_RESPONSE_ENVELOPE_BYTES = 1024 * 1024;
var REQUEST_ENVELOPE_OVERHEAD_BYTES = 4096;
var RESPONSE_ENVELOPE_OVERHEAD_BYTES = 8192;
var DEFAULT_MAXIMUM_RESPONSE_BODY_BYTES = Math.floor((DEFAULT_MAXIMUM_RESPONSE_ENVELOPE_BYTES - RESPONSE_ENVELOPE_OVERHEAD_BYTES) / 6);

class GenericHttpJsonCapabilityDriver {
  constructor({
    endpointUrl,
    methods = ["POST"],
    origins = [],
    secretHeaders = {},
    secretProvider = null,
    requestTemplate = null,
    responseExtractionPath = null,
    timeoutMs = 5000,
    retryPolicy = { attempts: 1 },
    maximumRequestBytes = 64 * 1024,
    maximumResponseBytes = DEFAULT_MAXIMUM_RESPONSE_BODY_BYTES,
    idempotencyHeaderName = "Idempotency-Key",
    allowEndpointFromRequest = false,
    redactionRules = []
  } = {}) {
    if (!endpointUrl)
      fail("ERR_HTTP_CAPABILITY_ENDPOINT_REQUIRED");
    assertNoReservedSecretHeaders(secretHeaders, idempotencyHeaderName);
    const parsedEndpointUrl = parseHttpUrl(endpointUrl);
    this.endpointUrl = endpointUrl;
    this.endpointOrigin = parsedEndpointUrl.origin;
    this.methods = new Set(methods.map((method) => String(method).toUpperCase()));
    this.origins = new Set(origins.length ? origins : [parsedEndpointUrl.origin]);
    this.secretHeaders = secretHeaders;
    this.secretProvider = secretProvider;
    this.requestTemplate = requestTemplate;
    this.responseExtractionPath = responseExtractionPath;
    this.timeoutMs = timeoutMs;
    this.retryPolicy = normalizeRetryPolicy(retryPolicy);
    this.maximumRequestBytes = maximumRequestBytes;
    this.maximumResponseBytes = maximumResponseBytes;
    this.idempotencyHeaderName = idempotencyHeaderName;
    this.allowEndpointFromRequest = allowEndpointFromRequest;
    this.redactionRules = redactionRules;
  }
  manifest() {
    return {
      driverId: "generic-http-json",
      supportedActuatorRefs: ["http:json"],
      supportedDescriptorFingerprints: ["descriptor:http-json"],
      supportedActuationClasses: ["http"],
      supportedResponseStatuses: ["ok", "http_error", "deferred", "failed"],
      maximumRequestBytes: encodedJsonStringEnvelopeLimit(this.maximumRequestBytes, REQUEST_ENVELOPE_OVERHEAD_BYTES),
      maximumResponseBytes: encodedJsonStringEnvelopeLimit(this.maximumResponseBytes, RESPONSE_ENVELOPE_OVERHEAD_BYTES),
      recoveryClass: EffectRecoveryClass.idempotent,
      concurrencyLimit: 4,
      authorityLabels: ["network:http"],
      diagnostics: {
        origins: [...this.origins],
        methods: [...this.methods],
        endpointSource: this.allowEndpointFromRequest ? "request-or-config" : "config",
        configuredOrigin: this.endpointOrigin,
        defaultMethod: [...this.methods][0] ?? "POST",
        secretHeaders: Object.keys(this.secretHeaders)
      }
    };
  }
  preflight(context, hostRequest) {
    const structural = defaultCapabilityPreflight(this.manifest(), hostRequest);
    const blockers = [...structural.blockers];
    if (!blockers.length) {
      try {
        this.#assertPolicyAllows(context, hostRequest);
        this.#assertSecrets();
      } catch (error) {
        blockers.push(error.code ?? "ERR_HTTP_CAPABILITY_PREFLIGHT_REJECTED");
      }
    }
    return new CapabilityPreflightReport({ accepted: blockers.length === 0, blockers });
  }
  dryRun(context, hostRequest) {
    const request = this.#request(hostRequest);
    return new DryRunReport({
      wouldInvoke: true,
      proposedAction: {
        method: request.method,
        url: `${new URL(request.url).origin}${new URL(request.url).pathname}`,
        bodyBytes: request.bodyBytes
      },
      diagnostics: { driverId: "generic-http-json" }
    });
  }
  shadow(context, hostRequest, recordedResolution) {
    const dryRun = this.dryRun(context, hostRequest);
    return new ShadowReport({
      liveInvoked: false,
      schemaAccepted: Boolean(recordedResolution),
      diagnostics: { proposedAction: dryRun.proposedAction }
    });
  }
  async resolve(context, hostRequest) {
    this.#assertPolicyAllows(context, hostRequest);
    this.#assertSecrets();
    const secretValues = await this.#secretValues();
    const request = this.#request(hostRequest);
    try {
      return await this.#fetchWithRetry(request, hostRequest, secretValues, async (response) => {
        if (response.status >= 300 && response.status < 400) {
          await discardResponseBody(response, this.maximumResponseBytes);
          fail("ERR_HTTP_REDIRECT_REJECTED");
        }
        if (!response.ok) {
          await discardResponseBody(response, this.maximumResponseBytes);
          return this.#resolution(hostRequest, { status: "http_error", statusCode: response.status }, 1, response.headers.get("x-request-id"));
        }
        const bytes2 = await readResponseBytes(response, this.maximumResponseBytes);
        const json = bytes2.byteLength ? JSON.parse(new TextDecoder().decode(bytes2)) : null;
        const body = extractPath(json, this.responseExtractionPath);
        const payload = { status: "ok", statusCode: response.status, body };
        assertNoKnownSecretEcho(payload, secretValues);
        return this.#resolution(hostRequest, payload, 0, response.headers.get("x-request-id"));
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        return this.#resolution(hostRequest, { status: "deferred", reason: "timeout" }, 4, null);
      }
      throw error;
    }
  }
  async recover(context, effectRecord) {
    if (!effectRecord.requestBytes)
      fail("ERR_HTTP_RECOVERY_REQUEST_BYTES_REQUIRED");
    return await this.resolve(context, {
      actuatorRef: effectRecord.actuatorRef,
      descriptorFingerprint: effectRecord.descriptorFingerprint,
      actuationClass: effectRecord.actuationClass,
      requestBytes: effectRecord.requestBytes,
      responseSchema: effectRecord.responseSchema,
      idempotencyKeyWorldFingerprint: effectRecord.idempotencyKeyWorldFingerprint,
      hostRequestFingerprint: effectRecord.hostRequestFingerprint
    });
  }
  #request(hostRequest) {
    const payload = parseJsonBytes(hostRequest.requestBytes);
    const url = this.allowEndpointFromRequest && payload.url ? payload.url : this.endpointUrl;
    const parsedUrl = parseHttpUrl(url);
    if (!this.origins.has(parsedUrl.origin))
      fail("ERR_HTTP_ORIGIN_REJECTED");
    const method = String(payload.method ?? [...this.methods][0] ?? "POST").toUpperCase();
    if (!this.methods.has(method))
      fail("ERR_HTTP_METHOD_REJECTED");
    const bodyValue = this.requestTemplate ?? (Object.prototype.hasOwnProperty.call(payload, "body") ? payload.body : payload);
    const body = method === "GET" ? undefined : stableJson(bodyValue);
    const bodyBytes = body ? fromUtf8(body).byteLength : 0;
    if (bodyBytes > this.maximumRequestBytes)
      fail("ERR_HTTP_REQUEST_TOO_LARGE");
    return { url, method, body, bodyBytes };
  }
  #policyHostRequest(hostRequest, request = this.#request(hostRequest)) {
    return { ...hostRequest, requestBytes: fromUtf8(stableJson({ url: request.url, method: request.method })) };
  }
  #assertPolicyAllows(context, hostRequest) {
    const manifest = this.manifest();
    const policy = context?.policy ?? {};
    const action = context?.action ?? null;
    assertCapabilityPolicyAllows({
      manifest,
      hostRequest,
      policy,
      mode: "live",
      action,
      enforceNetworkTarget: false
    });
    const request = this.#request(hostRequest);
    assertRenderedRequestWithinPolicy(request, policy);
    assertCapabilityPolicyAllows({
      manifest,
      hostRequest: this.#policyHostRequest(hostRequest, request),
      policy,
      mode: "live",
      action
    });
  }
  async#headers(hostRequest, secretValues = null) {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      [this.idempotencyHeaderName]: hostRequest.idempotencyKeyWorldFingerprint
    };
    assertNoReservedSecretHeaders(this.secretHeaders, this.idempotencyHeaderName);
    const values = secretValues ?? await this.#secretValues();
    for (const [header, secretName] of Object.entries(this.secretHeaders)) {
      headers[header] = values.get(secretName);
    }
    return headers;
  }
  async#fetchWithRetry(request, hostRequest, secretValues, handleResponse) {
    let lastError = null;
    for (let attempt = 1;attempt <= this.retryPolicy.attempts; attempt += 1) {
      const controller = new AbortController;
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: await this.#headers(hostRequest, secretValues),
          body: request.body,
          signal: controller.signal,
          redirect: "manual"
        });
        return await handleResponse(response);
      } catch (error) {
        if (error?.name === "AbortError")
          throw error;
        lastError = error;
        if (attempt >= this.retryPolicy.attempts)
          throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }
  async#secret(name) {
    if (!this.secretProvider)
      fail("ERR_SECRET_PROVIDER_REQUIRED");
    const value = await this.secretProvider.get(name, `http-header:${name}`);
    if (typeof value !== "string" || value.length === 0)
      fail("ERR_SECRET_MISSING");
    return value;
  }
  async#secretValues() {
    const values = new Map;
    for (const secretName of new Set(Object.values(this.secretHeaders))) {
      values.set(secretName, await this.#secret(secretName));
    }
    return values;
  }
  #assertSecrets() {
    if (!Object.keys(this.secretHeaders).length)
      return;
    if (!this.secretProvider)
      fail("ERR_SECRET_PROVIDER_REQUIRED");
    assertRequiredSecretsAvailable(this.secretProvider, Object.values(this.secretHeaders));
  }
  #resolution(hostRequest, payload, status, transactionRef) {
    const responseValueImageBytes = status === 0 ? encodeCanonicalValueImage({ bytes: fromUtf8(stableJson(payload)), dynamicSize: true }) : new Uint8Array;
    return {
      resolutionInputBytes: encodeResolutionInputBytes({
        targetHostRequestFingerprint: resolutionTarget(hostRequest),
        status,
        responseValueImageBytes,
        hostClaimBytes: capabilityHostClaimBytes({ driver: "generic-http-json", status: payload.status }),
        attemptNumber: 1,
        metadata: fromUtf8(stableJson({ driver: "generic-http-json", status: payload.status, statusCode: payload.statusCode ?? null }))
      }),
      driverTransactionRef: transactionRef,
      diagnostics: { status: payload.status, statusCode: payload.statusCode ?? null }
    };
  }
}
function parseJsonBytes(bytes2) {
  assertBytes(bytes2, "requestBytes");
  return JSON.parse(new TextDecoder().decode(bytes2));
}
function parseHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("ERR_HTTP_URL_INVALID");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    fail("ERR_HTTP_URL_SCHEME_REJECTED");
  if (parsed.username || parsed.password)
    fail("ERR_HTTP_URL_CREDENTIALS_FORBIDDEN");
  return parsed;
}
function normalizeRetryPolicy(value = {}) {
  const attempts = value?.attempts ?? 1;
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    fail("ERR_HTTP_RETRY_POLICY_INVALID");
  return Object.freeze({ attempts });
}
function assertNoReservedSecretHeaders(secretHeaders, idempotencyHeaderName) {
  const reserved = normalizedHeaderName(idempotencyHeaderName);
  for (const header of Object.keys(secretHeaders ?? {})) {
    if (normalizedHeaderName(header) === reserved)
      fail("ERR_HTTP_SECRET_HEADER_RESERVED", `${idempotencyHeaderName} is reserved for World idempotency`);
  }
}
function normalizedHeaderName(value) {
  return String(value).trim().toLowerCase();
}
function assertNoKnownSecretEcho(value, secretValues) {
  const candidates = secretEchoCandidates(secretValues);
  if (!candidates.length)
    return;
  visitPayloadStrings(value, (text) => {
    for (const candidate of candidates) {
      if (text.includes(candidate))
        fail("ERR_SECRET_PERSISTED", "HTTP response echoed a local secret");
    }
  });
}
function secretEchoCandidates(secretValues) {
  const candidates = new Set;
  for (const value of secretValues.values()) {
    if (typeof value !== "string")
      continue;
    const trimmed = value.trim();
    if (!trimmed)
      continue;
    candidates.add(trimmed);
    const scheme = trimmed.match(/^(?:Bearer|Basic)\s+(.+)$/i);
    if (scheme?.[1]?.trim())
      candidates.add(scheme[1].trim());
  }
  return [...candidates];
}
function visitPayloadStrings(value, visit) {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value)
      visitPayloadStrings(item, visit);
    return;
  }
  if (!value || typeof value !== "object")
    return;
  for (const [key, child] of Object.entries(value)) {
    visit(key);
    visitPayloadStrings(child, visit);
  }
}
function assertRenderedRequestWithinPolicy(request, inputPolicy) {
  const policy = createCapabilityPolicy(inputPolicy);
  if (request.bodyBytes > policy.maximumRequestBytes)
    fail("ERR_CAPABILITY_PROMPT_TOO_LARGE");
}
function extractPath(value, path) {
  if (!path)
    return value;
  let current = value;
  for (const part of path.split("."))
    current = current?.[part];
  if (current === undefined)
    fail("ERR_HTTP_RESPONSE_SCHEMA_INVALID");
  return current;
}
function resolutionTarget(hostRequest = {}) {
  const value = hostRequest.hostRequestFingerprint;
  if (typeof value === "bigint" || typeof value === "number")
    return BigInt(value);
  const match = String(value ?? "").match(/(?:0x|world:host-request:)?([0-9a-f]+)$/i);
  if (!match)
    fail("ERR_HOST_REQUEST_FINGERPRINT_REQUIRED");
  return BigInt(`0x${match[1]}`);
}
async function readResponseBytes(response, maximumResponseBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximumResponseBytes)
    fail("ERR_HTTP_RESPONSE_TOO_LARGE");
  if (!response.body)
    return new Uint8Array;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maximumResponseBytes)
        fail("ERR_HTTP_RESPONSE_TOO_LARGE");
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return concatChunks(chunks, total);
}
async function discardResponseBody(response, maximumResponseBytes) {
  if (!response.body)
    return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maximumResponseBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    await reader.cancel().catch(() => {});
  }
}
function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
function encodedJsonStringEnvelopeLimit(logicalBytes, overheadBytes) {
  if (logicalBytes > Math.floor((Number.MAX_SAFE_INTEGER - overheadBytes) / 6))
    return Number.MAX_SAFE_INTEGER;
  return logicalBytes * 6 + overheadBytes;
}
export {
  GenericHttpJsonCapabilityDriver as CapabilityDriver
};
