export class CarrierError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'CarrierError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message = code, details = {}) {
  throw new CarrierError(code, message, details);
}

export function assertBytes(bytes, label = 'bytes') {
  if (bytes instanceof Uint8Array) return bytes;
  fail('ERR_EXPECTED_BYTES', `${label} must be Uint8Array`);
}

export function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromUtf8(value) {
  return new TextEncoder().encode(value);
}

export function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

export function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]));
}

export function assertBlobRef(ref) {
  if (!ref || ref.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/.test(ref.checksum) || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
    fail('ERR_INVALID_BLOB_REF');
  }
  return ref;
}

export function makeBlobRef(checksum, byteLength) {
  return assertBlobRef({ algorithm: 'sha256', checksum, byteLength });
}

export function sameBlobRef(left, right) {
  return left?.algorithm === right?.algorithm &&
    left?.checksum === right?.checksum &&
    left?.byteLength === right?.byteLength;
}

export function assertWorldFingerprint(value, label = 'worldFingerprint') {
  if (typeof value !== 'string' || value.length === 0) {
    fail('ERR_INVALID_WORLD_FINGERPRINT', `${label} is required`);
  }
  return value;
}

export class ClosureStore {
  async putBlob() { fail('ERR_ABSTRACT_STORE_METHOD'); }
  async getBlob() { fail('ERR_ABSTRACT_STORE_METHOD'); }
  async hasBlob() { fail('ERR_ABSTRACT_STORE_METHOD'); }
  async createApplication() { fail('ERR_ABSTRACT_STORE_METHOD'); }
  async getApplication() { fail('ERR_ABSTRACT_STORE_METHOD'); }
  async createRun() { fail('ERR_ABSTRACT_STORE_METHOD'); }
  async getRun() { fail('ERR_ABSTRACT_STORE_METHOD'); }
  async readHead() { fail('ERR_ABSTRACT_STORE_METHOD'); }
  async compareAndSwapHead() { fail('ERR_ABSTRACT_STORE_METHOD'); }
  async putEffectRecord() { fail('ERR_ABSTRACT_STORE_METHOD'); }
  async getEffectRecord() { fail('ERR_ABSTRACT_STORE_METHOD'); }
  async listEffectRecords() { fail('ERR_ABSTRACT_STORE_METHOD'); }
  async exportRun() { fail('ERR_ABSTRACT_STORE_METHOD'); }
  async importRun() { fail('ERR_ABSTRACT_STORE_METHOD'); }
}
