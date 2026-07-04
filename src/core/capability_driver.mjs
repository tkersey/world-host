import { assertDriverCanResolve, assertDriverManifest, defineActuatorDriver } from './actuator.mjs';
import { assertBytes, fail, fromUtf8, stableJson } from './store.mjs';
import { decodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';

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
    this.diagnostics = Object.freeze(fields.diagnostics ?? {});
    Object.freeze(this);
  }
}

export class DryRunReport {
  constructor(fields = {}) {
    this.wouldInvoke = fields.wouldInvoke === true;
    this.proposedAction = fields.proposedAction ?? null;
    this.resolutionPolicy = fields.resolutionPolicy ?? 'not-submitted';
    this.diagnostics = Object.freeze(fields.diagnostics ?? {});
    Object.freeze(this);
  }
}

export class ShadowReport {
  constructor(fields = {}) {
    this.liveInvoked = fields.liveInvoked === true;
    this.submittedToWorld = false;
    this.schemaAccepted = fields.schemaAccepted === true;
    this.diagnostics = Object.freeze(fields.diagnostics ?? {});
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
      return assertCapabilityPreflightReport(await driver.preflight(context, hostRequest));
    },
    async resolve(context, hostRequest) {
      const result = await actuator.resolve(context, hostRequest);
      assertCapabilityResolutionBoundary(result);
      return result;
    },
    recover: typeof actuator.recover === 'function'
      ? async (context, effectRecord) => {
          const result = await actuator.recover(context, effectRecord);
          if (result?.operatorInterventionRequired === true) {
            assertNoWorldEvidenceKeys(result);
            return result;
          }
          assertCapabilityResolutionBoundary(result);
          return result;
        }
      : undefined,
    async dryRun(context, hostRequest) {
      return assertDryRunReport(await driver.dryRun(context, hostRequest));
    },
    async shadow(context, hostRequest, recordedResolution) {
      return assertShadowReport(await driver.shadow(context, hostRequest, recordedResolution));
    },
    cancel: typeof actuator.cancel === 'function' ? actuator.cancel : undefined,
    query: typeof actuator.query === 'function' ? actuator.query : undefined,
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
  assertNoWorldEvidenceKeys(value);
  if (value instanceof CapabilityPreflightReport) return value;
  if (!value || typeof value !== 'object') fail('ERR_CAPABILITY_PREFLIGHT_REPORT_INVALID');
  return new CapabilityPreflightReport(value);
}

export function assertDryRunReport(value) {
  assertNoWorldEvidenceKeys(value);
  if (value instanceof DryRunReport) return value;
  if (!value || typeof value !== 'object') fail('ERR_CAPABILITY_DRY_RUN_REPORT_INVALID');
  return new DryRunReport(value);
}

export function assertShadowReport(value) {
  assertNoWorldEvidenceKeys(value);
  if (value instanceof ShadowReport) return value;
  if (!value || typeof value !== 'object') fail('ERR_CAPABILITY_SHADOW_REPORT_INVALID');
  return new ShadowReport(value);
}

export function assertCapabilityResolutionBoundary(value) {
  if (!value || typeof value !== 'object') fail('ERR_CAPABILITY_RESOLUTION_INVALID');
  assertNoWorldEvidenceKeys(value);
  decodeResolutionInputBytes(assertBytes(value.resolutionInputBytes, 'resolutionInputBytes'));
  return true;
}

export function assertNoWorldEvidenceKeys(value, path = [], seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return true;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
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
  return fromUtf8(stableJson({
    kind: 'world-host.capability.host-claim.v0',
    value,
    worldAuthoredEvidence: false,
  }));
}
