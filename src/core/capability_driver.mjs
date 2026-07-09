import { assertDriverCanResolve, assertDriverManifest, defineActuatorDriver } from './actuator.mjs';
import { receiverLocalEffectContext } from './effect_context.mjs';
import { assertBytes, fail, fromUtf8, stableJson } from './store.mjs';
import { decodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';
import { decodeCanonicalValueImage } from '../protocol/world_loaded_value_codec.mjs';

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

export class CapabilityPreflightReport {
  constructor(fields = {}) {
    this.accepted = fields.accepted === true;
    this.blockers = Object.freeze([...(fields.blockers ?? [])]);
    this.warnings = Object.freeze([...(fields.warnings ?? [])]);
    this.diagnostics = cloneReportPayload(fields.diagnostics ?? {});
    Object.freeze(this);
  }
}

export class DryRunReport {
  constructor(fields = {}) {
    this.wouldInvoke = fields.wouldInvoke === true;
    this.proposedAction = cloneReportPayload(fields.proposedAction ?? null);
    this.resolutionPolicy = fields.resolutionPolicy ?? 'not-submitted';
    this.diagnostics = cloneReportPayload(fields.diagnostics ?? {});
    Object.freeze(this);
  }
}

export class ShadowReport {
  constructor(fields = {}) {
    this.liveInvoked = fields.liveInvoked === true;
    this.submittedToWorld = false;
    this.schemaAccepted = fields.schemaAccepted === true;
    this.diagnostics = cloneReportPayload(fields.diagnostics ?? {});
    Object.freeze(this);
  }
}

export function defineCapabilityDriver(driver) {
  const actuator = defineActuatorDriver(driver);
  for (const method of ['preflight', 'dryRun', 'shadow']) {
    if (typeof driver?.[method] !== 'function') fail('ERR_CAPABILITY_DRIVER_ABI_INCOMPLETE', `${method} is required`);
  }
  return Object.freeze({
    manifest() {
      const raw = driver.manifest();
      const manifest = assertDriverManifest(raw);
      if (raw.packFingerprint != null && typeof raw.packFingerprint !== 'string') fail('ERR_INVALID_DRIVER_MANIFEST', 'packFingerprint must be a string');
      return raw.packFingerprint == null ? manifest : Object.freeze({ ...manifest, packFingerprint: raw.packFingerprint });
    },
    async preflight(context, hostRequest) {
      return assertCapabilityPreflightReport(await driver.preflight(receiverLocalEffectContext(context), hostRequest));
    },
    async resolve(context, hostRequest) {
      const result = await actuator.resolve(receiverLocalEffectContext(context), hostRequest);
      assertCapabilityResolutionBoundary(result);
      return result;
    },
    recover: typeof actuator.recover === 'function'
      ? async (context, effectRecord) => {
          const result = await actuator.recover(receiverLocalEffectContext(context), effectRecord);
          if (result?.operatorInterventionRequired === true) {
            assertNoWorldEvidenceKeys(result);
            return result;
          }
          assertCapabilityResolutionBoundary(result);
          return result;
        }
      : undefined,
    async dryRun(context, hostRequest) {
      return assertDryRunReport(await driver.dryRun(receiverLocalEffectContext(context), hostRequest));
    },
    async shadow(context, hostRequest, recordedResolution) {
      return assertShadowReport(await driver.shadow(receiverLocalEffectContext(context), hostRequest, recordedResolution));
    },
    cancel: typeof actuator.cancel === 'function'
      ? (context, effectRecord) => actuator.cancel(receiverLocalEffectContext(context), effectRecord)
      : undefined,
    query: typeof actuator.query === 'function'
      ? (context, externalTransactionRef) => actuator.query(receiverLocalEffectContext(context), externalTransactionRef)
      : undefined,
  });
}

export function defaultCapabilityPreflight(manifestLike, hostRequest) {
  const manifest = assertDriverManifest(manifestLike);
  try {
    assertDriverCanResolve(manifest, hostRequest);
    return new CapabilityPreflightReport({ accepted: true });
  } catch (error) {
    return new CapabilityPreflightReport({
      accepted: false,
      blockers: [error.code ?? 'ERR_CAPABILITY_PREFLIGHT_REJECTED'],
      diagnostics: { message: error.message },
    });
  }
}

export function assertCapabilityPreflightReport(value) {
  if (!value || typeof value !== 'object') fail('ERR_CAPABILITY_PREFLIGHT_REPORT_INVALID');
  assertNoWorldEvidenceKeys(value);
  const report = new CapabilityPreflightReport(value);
  assertNoWorldEvidenceKeys(report);
  return report;
}

export function assertDryRunReport(value) {
  if (!value || typeof value !== 'object') fail('ERR_CAPABILITY_DRY_RUN_REPORT_INVALID');
  assertNoWorldEvidenceKeys(value);
  const report = new DryRunReport(value);
  assertNoWorldEvidenceKeys(report);
  return report;
}

export function assertShadowReport(value) {
  if (!value || typeof value !== 'object') fail('ERR_CAPABILITY_SHADOW_REPORT_INVALID');
  assertNoWorldEvidenceKeys(value);
  const report = new ShadowReport(value);
  assertNoWorldEvidenceKeys(report);
  return report;
}

export function assertCapabilityResolutionBoundary(value) {
  if (!value || typeof value !== 'object') fail('ERR_CAPABILITY_RESOLUTION_INVALID');
  assertNoWorldEvidenceKeys(value);
  assertNoCarriedResolutionWorldEvidence(value);
  const decoded = decodeResolutionInputBytes(assertBytes(value.resolutionInputBytes, 'resolutionInputBytes'));
  assertNoDecodedResolutionWorldEvidence(decoded);
  return true;
}

function assertNoCarriedResolutionWorldEvidence(value) {
  for (const field of ['hostClaimBytes', 'metadata', 'responseValueImageBytes']) assertNoWorldEvidenceByteField(value[field]);
}

function assertNoDecodedResolutionWorldEvidence(decoded) {
  for (const field of ['hostClaimBytes', 'metadata', 'responseValueImageBytes']) assertNoWorldEvidenceByteField(decoded[field]);
}

function assertNoWorldEvidenceByteField(value, path = []) {
  const payload = parseJsonBytes(value);
  if (payload !== null) assertNoWorldEvidenceKeys(payload, path);
  const valueImage = parseCanonicalValueImage(value);
  if (valueImage !== null) {
    const decodedPayload = parseJsonBytes(valueImage.payload);
    if (decodedPayload !== null) assertNoWorldEvidenceKeys(decodedPayload, path);
    const decodedLabel = parseJsonBytes(valueImage.diagnosticTypeLabel);
    if (decodedLabel !== null) assertNoWorldEvidenceKeys(decodedLabel, [...path, 'diagnosticTypeLabel']);
  }
}

function parseJsonBytes(value) {
  const bytes = byteView(value);
  if (bytes === null || bytes.byteLength === 0) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
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
  const bytes = byteView(value);
  if (bytes === null || bytes.byteLength === 0) return null;
  try {
    return decodeCanonicalValueImage(bytes);
  } catch {
    return null;
  }
}

function byteView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function cloneReportPayload(value, seen = new WeakMap()) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return cloneArrayBufferView(value);
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const clone = [];
    seen.set(value, clone);
    for (const item of value) clone.push(cloneReportPayload(item, seen));
    return Object.freeze(clone);
  }
  if (value instanceof Map) {
    const clone = {};
    seen.set(value, clone);
    let index = 0;
    for (const [key, child] of value.entries()) {
      const property = typeof key === 'string' ? key : `map:${index}`;
      Object.defineProperty(clone, property, {
        value: cloneReportPayload(child, seen),
        enumerable: true,
        configurable: false,
        writable: false,
      });
      index += 1;
    }
    return Object.freeze(clone);
  }
  if (value instanceof Set) {
    const clone = [];
    seen.set(value, clone);
    for (const item of value.values()) clone.push(cloneReportPayload(item, seen));
    return Object.freeze(clone);
  }
  const clone = {};
  seen.set(value, clone);
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(clone, key, {
      value: cloneReportPayload(child, seen),
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(clone);
}

function cloneArrayBufferView(value) {
  if (value instanceof DataView) {
    return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return new value.constructor(value);
}

export function assertNoWorldEvidenceKeys(value, path = [], seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return true;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    assertNoWorldEvidenceByteField(value, path);
    return true;
  }
  if (seen.has(value)) return true;
  seen.add(value);
  if (value instanceof Map) {
    let index = 0;
    for (const [key, child] of value.entries()) {
      const entryPath = [...path, `map:${index}`];
      if (typeof key === 'string' && FORBIDDEN_WORLD_EVIDENCE_KEYS.has(key)) {
        fail('ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN', `capability driver must not author ${key}`, { path: [...path, key].join('.') });
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
      fail('ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN', `capability driver must not author ${key}`, { path: [...path, key].join('.') });
    }
    assertNoWorldEvidenceKeys(child, [...path, key], seen);
  }
  return true;
}

export function capabilityHostClaimBytes(value) {
  assertNoWorldEvidenceKeys(value);
  return fromUtf8(stableJson({
    kind: 'world-host.capability.host-claim.v0',
    value,
    worldAuthoredEvidence: false,
  }));
}
