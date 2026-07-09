const DEFAULT_ACTUATOR_REF = 'fixture:agent-model';
const DEFAULT_DESCRIPTOR = 'descriptor:fixture-agent-model';
const ResponseStatusCode = Object.freeze({
  ok: 0,
  final: 0,
});
const FORBIDDEN_WORLD_EVIDENCE_KEYS = new Set([
  'boundaryModuleBytes',
  'worldReceiptBytes',
  'turnReceiptBytes',
  'turnClosureBytes',
  'capsuleBytes',
  'chronicleEventBytes',
  'archiveAppendBatchBytes',
  'actuationReceiptBytes',
  'executableImageBytes',
  'runHead',
]);

class CarrierError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'CarrierError';
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new CarrierError(code, message);
}

function fromUtf8(value) {
  return new TextEncoder().encode(value);
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]));
}

function parseDecisionPrompt(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('ERR_AGENT_DECISION_PROMPT_BYTES_REQUIRED');
  try {
    const prompt = JSON.parse(new TextDecoder().decode(bytes));
    if (prompt?.schema !== 'boundary.Agent.DecisionPrompt.v0') fail('ERR_AGENT_DECISION_PROMPT_SCHEMA');
    if (typeof prompt.observation !== 'string') fail('ERR_AGENT_DECISION_OBSERVATION_REQUIRED');
    return prompt;
  } catch (error) {
    if (error?.code) throw error;
    fail('ERR_AGENT_DECISION_PROMPT_MALFORMED');
  }
}

function actionForPrompt(scenario, prompt) {
  const observation = prompt.observation;
  if (scenario === 'branch-final' && observation === 'goal=invoke') {
    return { variant: 'final', text: 'final=alternate branch complete' };
  }
  if (scenario === 'malformed') return { variant: 'malformed', payload: 'not an Agent.Action variant' };
  if (scenario === 'unknown-tool') return { variant: 'tool', toolId: 'unknown_tool', payload: '' };
  if (scenario === 'budget') return { variant: 'tool', toolId: 'actuate', payload: '' };
  if (observation === 'goal=invoke') return { variant: 'tool', toolId: 'actuate', payload: '' };
  if (observation === 'actuate') return { variant: 'final', text: 'final=actuate skeleton complete' };
  if (observation === 'goal=fixture') return { variant: 'tool', toolId: 'read_file', payload: 'input.txt' };
  if (observation === 'rewrite this file through the agent loop') {
    return { variant: 'tool', toolId: 'write_file', payload: 'output.txt\nactuate updated the fixture' };
  }
  if (observation === 'write=ok') return { variant: 'final', text: 'final=fixture updated' };
  fail('ERR_FIXTURE_AGENT_MODEL_PROMPT_UNSUPPORTED', `unsupported fixture observation: ${observation}`);
}

function preflightAccepted() {
  return Object.freeze({ accepted: true, blockers: [] });
}

function preflightRejected(blockers) {
  return Object.freeze({ accepted: false, blockers });
}

function agentActionValueImage(action) {
  return encodeCanonicalValueImage({
    bytes: fromUtf8(stableJson({
      schema: 'boundary.Agent.Action.v0',
      action,
    })),
    dynamicSize: true,
  });
}

function resolutionInput(hostRequest, responseValueImageBytes, status = 0) {
  return encodeResolutionInputBytes({
    targetHostRequestFingerprint: resolutionTarget(hostRequest),
    status,
    responseValueImageBytes,
    hostClaimBytes: new Uint8Array(),
    attemptNumber: 1,
    metadata: fromUtf8('fixture-agent-model'),
  });
}

function responseKey(hostRequest = {}) {
  return hostRequest.idempotencyKeyWorldFingerprint ?? hostRequest.hostRequestFingerprint ?? null;
}

function resolutionTarget(hostRequest = {}) {
  const value = hostRequest.hostRequestFingerprint;
  if (value === undefined) return 0n;
  if (typeof value === 'bigint' || typeof value === 'number') return BigInt(value);
  const match = String(value).match(/(?:0x)?([0-9a-f]+)$/i);
  if (!match) fail('ERR_HOST_REQUEST_FINGERPRINT_REQUIRED');
  return BigInt(`0x${match[1]}`);
}

function recordedResolutionAccepted(recordedResolution, hostRequest, manifest, policy = {}) {
  const resolutionInputBytes = recordedResolutionInputBytes(recordedResolution);
  if (!resolutionInputBytes) return false;
  try {
    assertCapabilityResolutionBoundary({ resolutionInputBytes });
    assertResolutionAccepted(resolutionInputBytes, hostRequest, manifest, policy);
    return true;
  } catch {
    return false;
  }
}

function recordedResolutionInputBytes(recordedResolution) {
  if (recordedResolution instanceof Uint8Array) return recordedResolution;
  if (recordedResolution?.resolutionInputBytes instanceof Uint8Array) return recordedResolution.resolutionInputBytes;
  return null;
}

function assertResolutionAccepted(resolutionInputBytes, hostRequest, manifest, policy = {}) {
  const resolution = decodeResolutionInputBytes(resolutionInputBytes);
  if (resolution.targetHostRequestFingerprint !== resolutionTarget(hostRequest)) {
    fail('ERR_EFFECT_RESOLUTION_TARGET_MISMATCH');
  }
  assertResolutionStatusAccepted(resolution.status, hostRequest, manifest);
  if (resolution.status === 0 && resolution.responseValueImageBytes.byteLength === 0) fail('ERR_EFFECT_RESPONSE_REQUIRED');
  if (resolution.status !== 0 && resolution.responseValueImageBytes.byteLength !== 0) fail('ERR_EFFECT_RESPONSE_FORBIDDEN');
  const maximumResponseBytes = policy.maximumResponseBytes === undefined ? manifest.maximumResponseBytes : Math.min(manifest.maximumResponseBytes, policy.maximumResponseBytes);
  if (maximumResponseBytes !== Number.MAX_SAFE_INTEGER && (
    resolutionInputBytes.byteLength > maximumResponseBytes ||
    resolution.responseValueImageBytes.byteLength > maximumResponseBytes ||
    resolution.hostClaimBytes.byteLength > maximumResponseBytes ||
    resolution.metadata.byteLength > maximumResponseBytes
  )) {
    fail('ERR_EFFECT_RESPONSE_TOO_LARGE');
  }
}

function assertCapabilityResolutionBoundary(value) {
  if (!value || typeof value !== 'object') fail('ERR_CAPABILITY_RESOLUTION_INVALID');
  assertNoWorldEvidenceKeys(value);
  for (const field of ['hostClaimBytes', 'metadata', 'responseValueImageBytes']) {
    assertNoWorldEvidenceByteField(value[field]);
  }
  const resolutionInputBytes = value.resolutionInputBytes;
  if (!(resolutionInputBytes instanceof Uint8Array)) fail('ERR_CAPABILITY_RESOLUTION_INVALID');
  const decoded = decodeResolutionInputBytes(resolutionInputBytes);
  for (const field of ['hostClaimBytes', 'metadata', 'responseValueImageBytes']) {
    assertNoWorldEvidenceByteField(decoded[field]);
  }
  return true;
}

function assertNoWorldEvidenceByteField(value) {
  const payload = parseJsonBytes(value);
  if (payload !== null) assertNoWorldEvidenceKeys(payload);
  const valueImage = parseCanonicalValueImage(value);
  if (valueImage !== null) {
    const decodedPayload = parseJsonBytes(valueImage.payload);
    if (decodedPayload !== null) assertNoWorldEvidenceKeys(decodedPayload);
    const decodedLabel = parseJsonBytes(valueImage.diagnosticTypeLabel);
    if (decodedLabel !== null) assertNoWorldEvidenceKeys(decodedLabel, ['diagnosticTypeLabel']);
  }
}

function parseJsonBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(value).trim();
  } catch {
    return null;
  }
  if (!text || !/^[\[{]/.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseCanonicalValueImage(value) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) return null;
  try {
    return decodeCanonicalValueImage(value);
  } catch {
    return null;
  }
}

function assertNoWorldEvidenceKeys(value, path = [], seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return true;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (value instanceof Map) {
    let index = 0;
    for (const [key, child] of value.entries()) {
      const entryPath = [...path, `map:${index}`];
      if (typeof key === 'string' && FORBIDDEN_WORLD_EVIDENCE_KEYS.has(key)) {
        fail('ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN', `capability driver must not author ${key}`);
      }
      assertNoWorldEvidenceKeys(key, [...entryPath, 'key'], seen);
      assertNoWorldEvidenceKeys(child, typeof key === 'string' ? [...path, key] : [...entryPath, 'value'], seen);
      index += 1;
    }
  } else if (value instanceof Set) {
    let index = 0;
    for (const child of value.values()) {
      assertNoWorldEvidenceKeys(child, [...path, `set:${index}`], seen);
      index += 1;
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_WORLD_EVIDENCE_KEYS.has(key)) {
      fail('ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN', `capability driver must not author ${key}`);
    }
    assertNoWorldEvidenceKeys(child, [...path, key], seen);
  }
  return true;
}

function assertResolutionStatusAccepted(status, hostRequest, manifest) {
  const expectedStatus = hostRequest.responseSchema?.status;
  if (expectedStatus === undefined) {
    const manifestStatuses = new Set((manifest.supportedResponseStatuses ?? []).map((item) => ResponseStatusCode[item]));
    if (!manifestStatuses.has(status)) fail('ERR_RESPONSE_STATUS_NOT_SUPPORTED');
    return;
  }
  const expectedWireStatus = ResponseStatusCode[expectedStatus];
  if (expectedWireStatus === undefined || status !== expectedWireStatus) fail('ERR_RESPONSE_STATUS_NOT_SUPPORTED');
}

function decodeResolutionInputBytes(value) {
  const reader = new ResolutionInputReader(value);
  const version = reader.u32();
  if (version !== 1) fail('ERR_RESOLUTION_INPUT_VERSION');
  const out = {
    targetHostRequestFingerprint: reader.u64(),
    status: reader.u8(),
    responseValueImageBytes: reader.bytes(),
    hostClaimBytes: reader.bytes(),
    attemptNumber: reader.u32(),
    metadata: reader.bytes(),
  };
  reader.done();
  return out;
}

function decodeCanonicalValueImage(value) {
  const reader = new ResolutionInputReader(value);
  if (reader.u32() !== 1) fail('ERR_WORLD_VALUE_IMAGE_UNSUPPORTED');
  if (reader.u32() !== 1) fail('ERR_WORLD_VALUE_IMAGE_UNSUPPORTED');
  reader.u64();
  reader.optionalU32();
  reader.optionalU64();
  reader.optionalU64();
  reader.u8();
  const payload = reader.portableBytes();
  const diagnosticTypeLabel = reader.optionalPortableBytes();
  reader.done();
  return { payload, diagnosticTypeLabel };
}

class ResolutionInputReader {
  constructor(value) {
    this.bytesValue = bytesOf(value);
    this.offset = 0;
  }

  u8() {
    if (this.offset + 1 > this.bytesValue.byteLength) fail('ERR_RESOLUTION_INPUT_TRUNCATED');
    const value = this.bytesValue[this.offset];
    this.offset += 1;
    return value;
  }

  u32() {
    if (this.offset + 4 > this.bytesValue.byteLength) fail('ERR_RESOLUTION_INPUT_TRUNCATED');
    const value = new DataView(this.bytesValue.buffer, this.bytesValue.byteOffset + this.offset, 4).getUint32(0, true);
    this.offset += 4;
    return value;
  }

  u64() {
    if (this.offset + 8 > this.bytesValue.byteLength) fail('ERR_RESOLUTION_INPUT_TRUNCATED');
    const view = new DataView(this.bytesValue.buffer, this.bytesValue.byteOffset + this.offset, 8);
    const value = BigInt(view.getUint32(0, true)) | (BigInt(view.getUint32(4, true)) << 32n);
    this.offset += 8;
    return value;
  }

  bytes() {
    const length = this.u32();
    if (this.offset + length > this.bytesValue.byteLength) fail('ERR_RESOLUTION_INPUT_TRUNCATED');
    const out = this.bytesValue.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  optionalU32() {
    return this.optional(() => this.u32());
  }

  optionalU64() {
    return this.optional(() => this.u64());
  }

  optionalPortableBytes() {
    return this.optional(() => this.portableBytes());
  }

  optional(readValue) {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag !== 1) fail('ERR_WORLD_VALUE_IMAGE_TRUNCATED');
    return readValue();
  }

  portableBytes() {
    const length = this.u64();
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) fail('ERR_WORLD_VALUE_IMAGE_TRUNCATED');
    const size = Number(length);
    if (this.offset + size > this.bytesValue.byteLength) fail('ERR_WORLD_VALUE_IMAGE_TRUNCATED');
    const out = this.bytesValue.slice(this.offset, this.offset + size);
    this.offset += size;
    return out;
  }

  done() {
    if (this.offset !== this.bytesValue.byteLength) fail('ERR_RESOLUTION_INPUT_TRAILING_BYTES');
  }
}

function encodeResolutionInputBytes(value) {
  return concat([
    u32(1),
    u64(value.targetHostRequestFingerprint),
    u8(value.status),
    bytes(value.responseValueImageBytes ?? new Uint8Array()),
    bytes(value.hostClaimBytes ?? new Uint8Array()),
    u32(value.attemptNumber ?? 0),
    bytes(value.metadata ?? new Uint8Array()),
  ]);
}

function encodeCanonicalValueImage({
  valueTableId = null,
  boundaryValueFingerprint = null,
  codecSchemaDescriptorFingerprint = null,
  bytes: payloadBytes,
  dynamicSize = false,
  diagnosticTypeLabel = null,
}) {
  const payload = bytesOf(payloadBytes);
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

function fingerprintValueImage({
  valueTableId,
  boundaryValueFingerprint,
  codecSchemaDescriptorFingerprint,
  dynamicSize,
  diagnosticTypeLabel,
  bytes: payload,
}) {
  return wyhash64(concat([
    fromUtf8('world.frame.value_image.fingerprint'),
    u64(1),
    hashOptionalU32(valueTableId),
    hashOptionalU64(boundaryValueFingerprint),
    hashOptionalU64(codecSchemaDescriptorFingerprint),
    hashBool(dynamicSize),
    hashOptionalBytes(diagnosticTypeLabel),
    u64(payload.length),
    payload,
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

function portableBytes(value) {
  const payload = bytesOf(value);
  return concat([u64(payload.length), payload]);
}

function bytes(value) {
  const payload = bytesOf(value);
  return concat([u32(payload.length), payload]);
}

function u8(value) {
  return Uint8Array.of(Number(assertUnsignedInteger(value, 8, 'u8')));
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, Number(assertUnsignedInteger(value, 32, 'u32')), true);
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

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return fromUtf8(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('expected byte-like value');
}

const MASK64 = (1n << 64n) - 1n;
const SECRET = [
  0xa0761d6478bd642fn,
  0xe7037ed1a0b428dbn,
  0x8ebc6af09c88c6e3n,
  0x589965cc75374cc3n,
];

function wyhash64(input, seed = 0n) {
  const payload = bytesOf(input);
  const state0 = (seed ^ mix(seed ^ SECRET[0], SECRET[1])) & MASK64;
  const state = [state0, state0, state0];
  let a = 0n;
  let b = 0n;

  if (payload.length <= 16) {
    [a, b] = smallKey(payload);
  } else {
    let i = 0;
    if (payload.length >= 48) {
      while (i + 48 < payload.length) {
        for (let lane = 0; lane < 3; lane += 1) {
          const left = read(payload, i + 8 * (2 * lane), 8);
          const right = read(payload, i + 8 * (2 * lane + 1), 8);
          state[lane] = mix(left ^ SECRET[lane + 1], right ^ state[lane]);
        }
        i += 48;
      }
      state[0] = (state[0] ^ state[1] ^ state[2]) & MASK64;
    }
    let j = i;
    while (j + 16 < payload.length) {
      state[0] = mix(read(payload, j, 8) ^ SECRET[1], read(payload, j + 8, 8) ^ state[0]);
      j += 16;
    }
    a = read(payload, payload.length - 16, 8);
    b = read(payload, payload.length - 8, 8);
  }

  a = (a ^ SECRET[1]) & MASK64;
  b = (b ^ state[0]) & MASK64;
  [a, b] = mum(a, b);
  return mix(a ^ SECRET[0] ^ BigInt(payload.length), b ^ SECRET[1]);
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

export class CapabilityDriver {
  constructor({
    scenario = 'skeleton',
    actuatorRef = DEFAULT_ACTUATOR_REF,
    descriptorFingerprint = DEFAULT_DESCRIPTOR,
    packFingerprint = null,
  } = {}) {
    this.scenario = scenario;
    this.actuatorRef = actuatorRef;
    this.descriptorFingerprint = descriptorFingerprint;
    this.packFingerprint = packFingerprint;
    this.responsesByKey = new Map();
    this.calls = 0;
  }

  manifest() {
    return {
      driverId: 'fixture-agent-model',
      ...(this.packFingerprint ? { packFingerprint: this.packFingerprint } : {}),
      supportedActuatorRefs: [this.actuatorRef],
      supportedDescriptorFingerprints: [this.descriptorFingerprint],
      supportedActuationClasses: ['model'],
      supportedResponseStatuses: ['ok', 'final'],
      maximumRequestBytes: 1024 * 1024,
      maximumResponseBytes: 1024 * 1024,
      recoveryClass: 'pure',
      concurrencyLimit: 1,
      authorityLabels: ['model:fixture-agent'],
      diagnostics: {
        deterministic: true,
        network: false,
        credentials: false,
        semanticAuthority: 'Boundary Agent.Action schema',
      },
    };
  }

  preflight(context, hostRequest) {
    const manifest = this.manifest();
    const blockers = [];
    if (!manifest.supportedActuatorRefs.includes(hostRequest?.actuatorRef)) blockers.push('actuator-ref-uncovered');
    if (!manifest.supportedDescriptorFingerprints.includes(hostRequest?.descriptorFingerprint)) blockers.push('descriptor-uncovered');
    if (!manifest.supportedActuationClasses.includes(hostRequest?.actuationClass)) blockers.push('actuation-class-uncovered');
    if (hostRequest?.requestBytes?.byteLength > manifest.maximumRequestBytes) blockers.push('request-limit-exceeded');
    if (hostRequest?.responseSchema && !manifest.supportedResponseStatuses.includes(hostRequest.responseSchema.status)) {
      blockers.push('response-status-uncovered');
    }
    if (!blockers.length) {
      try {
        parseDecisionPrompt(hostRequest.requestBytes);
      } catch (error) {
        blockers.push(error.code ?? 'ERR_AGENT_DECISION_PROMPT_INVALID');
      }
    }
    return blockers.length ? preflightRejected(blockers) : preflightAccepted();
  }

  dryRun(context, hostRequest) {
    const prompt = parseDecisionPrompt(hostRequest.requestBytes);
    return {
      wouldInvoke: false,
      proposedAction: { driver: 'fixture-agent-model', observation: prompt.observation },
      diagnostics: { deterministic: true },
    };
  }

  shadow(context, hostRequest, recordedResolution) {
    try {
      parseDecisionPrompt(hostRequest.requestBytes);
    } catch (error) {
      return {
        liveInvoked: false,
        schemaAccepted: false,
        diagnostics: { driver: 'fixture-agent-model', blocker: error.code ?? 'ERR_AGENT_DECISION_PROMPT_INVALID' },
      };
    }
    return {
      liveInvoked: false,
      schemaAccepted: recordedResolutionAccepted(recordedResolution, hostRequest, this.manifest(), context?.policy ?? {}),
      diagnostics: { driver: 'fixture-agent-model' },
    };
  }

  async resolve(context, hostRequest) {
    const key = responseKey(hostRequest);
    if (key && this.responsesByKey.has(key)) {
      return { resolutionInputBytes: resolutionInput(hostRequest, this.responsesByKey.get(key)) };
    }
    this.calls += 1;
    const prompt = parseDecisionPrompt(hostRequest.requestBytes);
    const response = agentActionValueImage(actionForPrompt(this.scenario, prompt));
    if (key) this.responsesByKey.set(key, new Uint8Array(response));
    return { resolutionInputBytes: resolutionInput(hostRequest, response) };
  }

  async recover(context, effectRecord) {
    if (!effectRecord?.resolutionInputRef) return await this.resolve(context, effectRecord);
    return { operatorInterventionRequired: true };
  }
}
