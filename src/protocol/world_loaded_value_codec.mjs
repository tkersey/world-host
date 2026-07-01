import { carrierManifest } from './world_manifest.mjs';

export const loadedValueCodecBoundary = Object.freeze({
  artifact: 'world_loaded_value_codec.mjs',
  source: 'released World JavaScript loaded-value codec',
  supportedWorldRelease: carrierManifest.supportedWorldRelease,
  hostAuthority: 'decode/encode host-owned value images according to released codec only',
  worldEvidenceAuthority: false,
});

export function assertLoadedValueCodecBoundary(options = {}) {
  if (options.nativeWorldHelperProcess === true) {
    throw new Error('ERR_NATIVE_WORLD_HELPER_FORBIDDEN');
  }
  if (options.childProcessProtocolEncoding === true) {
    throw new Error('ERR_CHILD_PROCESS_PROTOCOL_ENCODING_FORBIDDEN');
  }
  if (options.constructsWorldEvidence === true) {
    throw new Error('ERR_WORLD_EVIDENCE_FORBIDDEN');
  }
  return loadedValueCodecBoundary;
}

export function requireReleasedLoadedValueCodec() {
  return releasedLoadedValueCodec;
}

export const releasedLoadedValueCodec = Object.freeze({
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
  u64WordBytes,
});

const textEncoder = new TextEncoder();
const MASK64 = (1n << 64n) - 1n;
const SECRET = [
  0xa0761d6478bd642fn,
  0xe7037ed1a0b428dbn,
  0x8ebc6af09c88c6e3n,
  0x589965cc75374cc3n,
];

export function encodeUnit() {
  return new Uint8Array();
}

export function encodeBool(value) {
  return u8(value ? 1 : 0);
}

export function encodeI32(value) {
  return i32(value);
}

export function encodeU64Word(value) {
  return u64(value);
}

export function encodeBytes(value) {
  const bytes = bytesOf(value);
  return concat([u32(bytes.length), bytes]);
}

export function encodeString(value) {
  return encodeBytes(textEncoder.encode(value));
}

export function encodeByteStringList(values) {
  return concat([u32(values.length), ...values.map((value) => encodeBytes(value))]);
}

export function encodeProduct(fields) {
  return concat([u32(fields.length), ...fields.map(bytesOf)]);
}

export function encodeSum(variantIndex, payload = null) {
  return payload == null
    ? concat([u32(variantIndex), u8(0)])
    : concat([u32(variantIndex), u8(1), bytesOf(payload)]);
}

export function encodeCanonicalValueImage({
  valueTableId = null,
  boundaryValueFingerprint = null,
  codecSchemaDescriptorFingerprint = null,
  bytes,
  dynamicSize = false,
  diagnosticTypeLabel = null,
}) {
  const payload = bytesOf(bytes);
  const label = diagnosticTypeLabel == null ? null : bytesOf(diagnosticTypeLabel);
  const fingerprint = fingerprintValueImage({
    valueTableId,
    boundaryValueFingerprint,
    codecSchemaDescriptorFingerprint,
    dynamicSize,
    diagnosticTypeLabel: label,
    bytes: payload,
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
    optionalPortableBytes(label),
  ]);
}

export function decodeCanonicalValueImage(bytes, request = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  let offset = 0;
  if (readCanonicalU32(data, offset) !== 1) throw codecError('ERR_WORLD_VALUE_IMAGE_UNSUPPORTED');
  offset += 4;
  if (readCanonicalU32(data, offset) !== 1) throw codecError('ERR_WORLD_VALUE_IMAGE_UNSUPPORTED');
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
  if (offset !== data.byteLength) throw codecError('ERR_WORLD_VALUE_IMAGE_TRAILING_BYTES');
  const actualFingerprint = fingerprintValueImage({
    valueTableId: valueTable.value,
    boundaryValueFingerprint: boundaryValue.value,
    codecSchemaDescriptorFingerprint: codecSchema.value,
    dynamicSize: dynamicSize.value,
    diagnosticTypeLabel: diagnosticTypeLabel.value,
    bytes: payload.value,
  });
  if (embeddedFingerprint !== actualFingerprint) throw codecError('ERR_WORLD_VALUE_IMAGE_FINGERPRINT');
  if (request.payloadValueRefFingerprint != null && boundaryValue.value !== BigInt(request.payloadValueRefFingerprint)) {
    throw codecError('ERR_WORLD_VALUE_IMAGE_PAYLOAD_REF');
  }
  if (request.payloadSchemaRefFingerprint != null && codecSchema.value !== BigInt(request.payloadSchemaRefFingerprint)) {
    throw codecError('ERR_WORLD_VALUE_IMAGE_PAYLOAD_SCHEMA_REF');
  }
  return {
    payload: payload.value,
    boundaryValueFingerprint: boundaryValue.value,
    codecSchemaDescriptorFingerprint: codecSchema.value,
    diagnosticTypeLabel: diagnosticTypeLabel.value,
    fingerprint: actualFingerprint,
  };
}

export function u64WordBytes(value) {
  return u64(value);
}

export function fingerprintValueImage({
  valueTableId,
  boundaryValueFingerprint,
  codecSchemaDescriptorFingerprint,
  dynamicSize,
  diagnosticTypeLabel,
  bytes,
}) {
  return wyhash64(concat([
    textEncoder.encode('world.frame.value_image.fingerprint'),
    u64(1),
    hashOptionalU32(valueTableId),
    hashOptionalU64(boundaryValueFingerprint),
    hashOptionalU64(codecSchemaDescriptorFingerprint),
    hashBool(dynamicSize),
    hashOptionalBytes(diagnosticTypeLabel),
    u64(bytes.length),
    bytes,
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
  if (tag === 0) return { value: null, offset: offset + 1 };
  return readCanonicalPortableBytes(data, offset + 1);
}

function readCanonicalOptional(data, offset, width, readValue) {
  const tag = readCanonicalOptionalTag(data, offset);
  if (tag === 0) return { value: null, offset: offset + 1 };
  const valueOffset = offset + 1;
  const next = valueOffset + width;
  if (next > data.byteLength) throw codecError('ERR_WORLD_VALUE_IMAGE_MALFORMED');
  return { value: readValue(data, valueOffset), offset: next };
}

function readCanonicalOptionalTag(data, offset) {
  if (offset >= data.byteLength) throw codecError('ERR_WORLD_VALUE_IMAGE_MALFORMED');
  const tag = data[offset];
  if (tag !== 0 && tag !== 1) throw codecError('ERR_WORLD_VALUE_IMAGE_MALFORMED');
  return tag;
}

function readCanonicalPortableBytes(data, offset) {
  const length = Number(canonicalView(data, offset, 8).getBigUint64(0, true));
  if (!Number.isSafeInteger(length)) throw codecError('ERR_WORLD_VALUE_IMAGE_MALFORMED');
  const start = offset + 8;
  const end = start + length;
  if (end > data.byteLength) throw codecError('ERR_WORLD_VALUE_IMAGE_MALFORMED');
  return { value: data.slice(start, end), offset: end };
}

function readCanonicalU32(data, offset) {
  return canonicalView(data, offset, 4).getUint32(0, true);
}

function readCanonicalU64(data, offset) {
  return canonicalView(data, offset, 8).getBigUint64(0, true);
}

function readCanonicalBool(data, offset) {
  if (offset >= data.byteLength) throw codecError('ERR_WORLD_VALUE_IMAGE_MALFORMED');
  const value = data[offset];
  if (value !== 0 && value !== 1) throw codecError('ERR_WORLD_VALUE_IMAGE_MALFORMED');
  return { value: value === 1, offset: offset + 1 };
}

function canonicalView(data, offset, length) {
  if (offset > data.byteLength || length > data.byteLength - offset) throw codecError('ERR_WORLD_VALUE_IMAGE_MALFORMED');
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
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return textEncoder.encode(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('expected byte-like value');
}

function u8(value) {
  return Uint8Array.of(Number(assertUnsignedInteger(value, 8, 'u8')));
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, Number(assertUnsignedInteger(value, 32, 'u32')), true);
  return out;
}

function i32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, Number(assertSignedInteger(value, 32, 'i32')), true);
  return out;
}

function u64(value) {
  const out = new Uint8Array(8);
  const actual = assertUnsignedInteger(value, 64, 'u64');
  const view = new DataView(out.buffer);
  view.setUint32(0, Number(actual & 0xffff_ffffn), true);
  view.setUint32(4, Number((actual >> 32n) & 0xffff_ffffn), true);
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
  if (actual < 0n || actual > maximum) throw new Error(`${label} out of range`);
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
  if (actual < minimum || actual > maximum) throw new Error(`${label} out of range`);
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

export function wyhash64(input, seed = 0n) {
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
        for (let lane = 0; lane < 3; lane += 1) {
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
    const quarter = (bytes.length >> 3) << 2;
    return [
      ((read(bytes, 0, 4) << 32n) | read(bytes, quarter, 4)) & MASK64,
      ((read(bytes, end, 4) << 32n) | read(bytes, end - quarter, 4)) & MASK64,
    ];
  }
  if (bytes.length > 0) {
    return [
      ((BigInt(bytes[0]) << 16n) | (BigInt(bytes[bytes.length >> 1]) << 8n) | BigInt(bytes[bytes.length - 1])) & MASK64,
      0n,
    ];
  }
  return [0n, 0n];
}

function read(bytes, offset, count) {
  let value = 0n;
  for (let i = 0; i < count; i += 1) value |= BigInt(bytes[offset + i]) << BigInt(8 * i);
  return value & MASK64;
}

function mum(a, b) {
  const product = (a & MASK64) * (b & MASK64);
  return [product & MASK64, (product >> 64n) & MASK64];
}

function mix(a, b) {
  const [lo, hi] = mum(a, b);
  return (lo ^ hi) & MASK64;
}
