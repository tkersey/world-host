export class WorldApplicationHostError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'WorldApplicationHostError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message = code, details = {}) {
  throw new WorldApplicationHostError(code, message, details);
}

export function assertBytes(value, label = 'bytes') {
  if (!(value instanceof Uint8Array)) {
    fail('ERR_APPLICATION_V1_EXPECTED_BYTES', `${label} must be Uint8Array`);
  }
  return value;
}
