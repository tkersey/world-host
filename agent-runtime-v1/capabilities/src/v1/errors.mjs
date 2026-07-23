export class CapabilityProtocolV1Error extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "CapabilityProtocolV1Error";
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message = code, details = {}) {
  throw new CapabilityProtocolV1Error(code, message, details);
}

export function assertBytes(value, label = "bytes") {
  if (!(value instanceof Uint8Array)) fail("ERR_CAPABILITY_V1_EXPECTED_BYTES", `${label} must be Uint8Array`);
  return value;
}
