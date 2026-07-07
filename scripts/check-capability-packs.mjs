#!/usr/bin/env bun
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  assertCapabilityConformanceReceipt,
  assertCapabilityPackChecksums,
  validateCapabilityPackManifest,
} from '../src/core/capability_pack.mjs';
import { assertDriverManifest } from '../src/core/actuator.mjs';
import { assertCapabilityResolutionBoundary, defineCapabilityDriver } from '../src/core/capability_driver.mjs';
import { assertResolutionAccepted } from '../src/core/effect_journal.mjs';
import { fromUtf8, stableJson } from '../src/core/store.mjs';
import { CapabilitySidecar, CapabilitySidecarCommand } from '../src/sidecars/capability_sidecar.mjs';

const trustedExecuteAdapters = process.argv.includes('--trusted-execute-adapters');
const root = path.resolve('capability-packs');
const names = (await readdir(root).catch(() => [])).filter((name) => name.startsWith('capability-pack-v0.2-')).sort();
if (!names.length) {
  console.error('no capability packs found');
  process.exit(1);
}

const results = [];
for (const name of names) {
  const packRoot = path.join(root, name);
  const manifest = JSON.parse(await readPackFile(packRoot, 'manifest.json', 'utf8'));
  if (!Array.isArray(manifest.checksums) || manifest.checksums.length === 0) throw new Error(`ERR_CAPABILITY_PACK_CHECKSUMS_REQUIRED:${name}`);
  const checked = await validateCapabilityPackManifest(manifest, { requirePackFingerprint: true, verifyFingerprint: true });
  const artifacts = {};
  for (const item of checked.checksums) artifacts[item.path] = new Uint8Array(await readPackFile(packRoot, item.path));
  await assertCapabilityPackChecksums(checked, artifacts);
  if (trustedExecuteAdapters) await assertAdapterManifestMatchesPack(checked, artifacts, name, packRoot);
  if (checked.conformanceCorpusFingerprint != null) {
    const receipt = JSON.parse(await readPackFile(packRoot, 'conformance.json', 'utf8'));
    assertCapabilityConformanceReceipt(receipt);
    if (receipt.packFingerprint !== checked.packFingerprint) throw new Error(`ERR_CAPABILITY_CONFORMANCE_PACK_FINGERPRINT:${name}`);
    if (receipt.driverId !== checked.driverId) throw new Error(`ERR_CAPABILITY_CONFORMANCE_DRIVER:${name}`);
    if (receipt.corpusFingerprint !== checked.conformanceCorpusFingerprint) throw new Error(`ERR_CAPABILITY_CONFORMANCE_CORPUS:${name}`);
  }
  results.push({
    pack: name,
    driverId: checked.driverId,
    packFingerprint: checked.packFingerprint,
    artifactCount: checked.checksums.length,
    trustedAdapterExecution: trustedExecuteAdapters,
  });
}

console.log(JSON.stringify({ capabilityPacks: results, status: 'passed' }, null, 2));

async function readPackFile(packRoot, relativePath, encoding = null) {
  const rootPath = await safePackRoot(packRoot);
  const target = path.resolve(packRoot, relativePath);
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_UNSAFE:${relativePath}`);
  if (!info.isFile()) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_MISSING:${relativePath}`);
  const actual = await realpath(target);
  if (!pathInside(rootPath, actual)) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_UNSAFE:${relativePath}`);
  return encoding ? await readFile(actual, encoding) : await readFile(actual);
}

async function safePackRoot(packRoot) {
  const info = await lstat(packRoot);
  if (info.isSymbolicLink()) throw new Error(`ERR_CAPABILITY_PACK_ROOT_UNSAFE:${packRoot}`);
  if (!info.isDirectory()) throw new Error(`ERR_CAPABILITY_PACK_ROOT_INVALID:${packRoot}`);
  return await realpath(packRoot);
}

function pathInside(rootPath, target) {
  const relative = path.relative(rootPath, target);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function assertAdapterManifestMatchesPack(packManifest, artifacts, name, packRoot) {
  let driver;
  let sidecar = false;
  if (packManifest.adapter.kind === 'in_process') {
    const module = await import(await adapterImportUrl(packManifest, artifacts));
    const Driver = module[packManifest.adapter.exportName];
    if (typeof Driver !== 'function') throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_EXPORT:${name}`);
    driver = new Driver(adapterOptions(packManifest));
  } else if (packManifest.adapter.kind === 'sidecar') {
    driver = new CapabilitySidecar({ command: packManifest.adapter.command, cwd: packRoot });
    sidecar = true;
  } else {
    return;
  }
  const capabilityDriver = defineCapabilityDriver(driver);
  if (packManifest.canRecover === true && typeof driver.recover !== 'function') throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_RECOVER:${name}`);
  const driverManifest = sidecar
    ? await sidecarManifest(driver, packManifest)
    : capabilityDriver.manifest();
  if (driverManifest.packFingerprint !== packManifest.packFingerprint) throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_MANIFEST_MISMATCH:${name}:packFingerprint`);
  for (const field of [
    'driverId',
    'supportedActuatorRefs',
    'supportedDescriptorFingerprints',
    'supportedActuationClasses',
    'supportedResponseStatuses',
    'recoveryClass',
    'maximumRequestBytes',
    'maximumResponseBytes',
    'authorityLabels',
  ]) {
    assertSameManifestField(name, field, packManifest[field], driverManifest[field]);
  }
  if (sidecar) await assertSidecarCommands(packManifest, driver, capabilityDriver, driverManifest);
}

async function sidecarManifest(sidecarDriver, packManifest) {
  const raw = await sidecarDriver.requestPayload(CapabilitySidecarCommand.manifest, { packFingerprint: packManifest.packFingerprint });
  const manifest = assertDriverManifest(raw);
  if (raw.packFingerprint != null && typeof raw.packFingerprint !== 'string') throw new Error('ERR_INVALID_DRIVER_MANIFEST:packFingerprint');
  return raw.packFingerprint == null ? manifest : Object.freeze({ ...manifest, packFingerprint: raw.packFingerprint });
}

async function assertSidecarCommands(packManifest, sidecarDriver, capabilityDriver, driverManifest) {
  const hostRequest = sidecarProbeHostRequest(driverManifest);
  const policy = sidecarProbePolicy(driverManifest, hostRequest);
  const context = { worldHostCapabilityPackAbiProbe: true, policy };
  const preflight = await capabilityDriver.preflight(context, hostRequest);
  if (preflight.accepted !== true || preflight.blockers.length > 0) {
    throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_PREFLIGHT:${preflight.blockers.join(',')}`);
  }
  await capabilityDriver.dryRun(context, hostRequest);
  await capabilityDriver.shadow(context, hostRequest, { worldHostCapabilityPackAbiProbe: true });
  assertSidecarProbeResolution(
    (await sidecarDriver.request(CapabilitySidecarCommand.resolve, { context, hostRequest })).payload,
    hostRequest,
    driverManifest,
    policy,
  );
  if (packManifest.canRecover === true) {
    if (typeof capabilityDriver.recover !== 'function') throw new Error('ERR_CAPABILITY_PACK_ADAPTER_RECOVER');
    const recovery = await capabilityDriver.recover(context, sidecarProbeEffectRecord(driverManifest, hostRequest));
    if (recovery?.operatorInterventionRequired !== true) assertSidecarProbeResolution(recovery, hostRequest, driverManifest, policy);
  }
}

function assertSidecarProbeResolution(value, hostRequest, driverManifest, policy) {
  assertCapabilityResolutionBoundary(value);
  assertResolutionAccepted(value.resolutionInputBytes, hostRequest, driverManifest, policy);
}

function sidecarProbePolicy(driverManifest, hostRequest) {
  const actuationClasses = new Set(driverManifest.supportedActuationClasses ?? []);
  const diagnostics = driverManifest.diagnostics ?? {};
  const { origins, methods } = sidecarProbeHttpPolicy(diagnostics, hostRequest);
  return Object.freeze({
    allowLiveEffects: true,
    allowNetworkEffects: true,
    allowFileEffects: true,
    allowHumanEffects: true,
    allowBestEffort: true,
    requireApprovalForDestructiveEffects: false,
    requireApprovalForNetworkEffects: false,
    requireApprovalForBestEffort: false,
    maximumLiveModelCalls: actuationClasses.has('model') ? 1 : 0,
    allowedAuthorityLabels: [...(driverManifest.authorityLabels ?? [])],
    allowedCapabilityPacks: [driverManifest.packFingerprint, driverManifest.driverId].filter((item) => typeof item === 'string' && item.length > 0),
    allowedOrigins: origins,
    allowedMethods: methods,
    allowedHttpOrigins: origins,
    allowedHttpMethods: methods,
    allowedFileRoots: sidecarProbeFileRoots(driverManifest),
    maximumConcurrentEffects: Math.max(1, driverManifest.concurrencyLimit ?? 1),
    maximumRequestBytes: Math.max(1, driverManifest.maximumRequestBytes ?? 1, hostRequest.requestBytes?.byteLength ?? 0),
    maximumPromptBytes: Math.max(1, driverManifest.maximumRequestBytes ?? 1, hostRequest.requestBytes?.byteLength ?? 0),
    maximumResponseBytes: Math.max(1, driverManifest.maximumResponseBytes ?? 1),
  });
}

function sidecarProbeHttpPolicy(diagnostics, hostRequest) {
  const origins = new Set();
  for (const origin of diagnostics.origins ?? []) addHttpOrigin(origins, origin);
  addHttpOrigin(origins, diagnostics.configuredOrigin);
  addHttpOrigin(origins, diagnostics.configuredEndpointUrl);
  const request = parseProbeJson(hostRequest.requestBytes);
  addHttpOrigin(origins, request?.url);
  const methods = new Set((diagnostics.methods ?? []).map((item) => String(item).toUpperCase()));
  if (diagnostics.defaultMethod) methods.add(String(diagnostics.defaultMethod).toUpperCase());
  if (request?.method) methods.add(String(request.method).toUpperCase());
  return { origins: [...origins], methods: [...methods] };
}

function sidecarProbeFileRoots(driverManifest) {
  return [
    driverManifest.diagnostics?.root,
    ...(driverManifest.diagnostics?.allowedFileRoots ?? []),
  ].filter((item) => typeof item === 'string' && item.length > 0);
}

function addHttpOrigin(origins, value) {
  if (typeof value !== 'string' || value.length === 0) return;
  try {
    origins.add(new URL(value).origin);
  } catch {
    // Non-URL diagnostics are ignored; concrete probe bytes still provide a target when needed.
  }
}

function parseProbeJson(bytes) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function sidecarProbeHostRequest(driverManifest) {
  const actuationClass = driverManifest.supportedActuationClasses[0];
  const requestBytes = sidecarProbeRequestBytes(driverManifest, actuationClass);
  return Object.freeze({
    actuatorRef: driverManifest.supportedActuatorRefs[0],
    descriptorFingerprint: driverManifest.supportedDescriptorFingerprints[0],
    actuationClass,
    idempotencyKeyBytes: fromUtf8('world-host-capability-pack-sidecar-abi-probe-key'),
    idempotencyKeyWorldFingerprint: 'world:idempotency-key:world-host-capability-pack-sidecar-abi-probe',
    requestBytes,
    hostRequestFingerprint: 'world:host-request:0000000000000abc',
  });
}

function sidecarProbeRequestBytes(driverManifest, actuationClass) {
  const diagnostics = driverManifest.diagnostics ?? {};
  if (actuationClass === 'http') {
    return fromUtf8(stableJson({
      url: diagnostics.configuredEndpointUrl ??
        httpProbeUrlForOrigin(diagnostics.configuredOrigin) ??
        httpProbeUrlForOrigin(diagnostics.origins?.[0]) ??
        'https://example.invalid/world-host-abi-probe',
      method: diagnostics.defaultMethod ?? diagnostics.methods?.[0] ?? 'POST',
      body: { worldHostCapabilityPackAbiProbe: true },
    }));
  }
  if (actuationClass === 'model') {
    return fromUtf8(stableJson({
      schema: 'boundary.Agent.DecisionPrompt.v0',
      observation: 'world-host capability pack sidecar ABI probe',
    }));
  }
  if (actuationClass === 'human') {
    return fromUtf8(stableJson({ action: 'world-host capability pack sidecar ABI probe' }));
  }
  if (actuationClass === 'file') {
    return fromUtf8(stableJson({ operation: 'read', path: 'world-host-abi-probe.txt' }));
  }
  return fromUtf8(stableJson({ worldHostCapabilityPackAbiProbe: true }));
}

function httpProbeUrlForOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return null;
  try {
    return new URL('/world-host-abi-probe', origin).href;
  } catch {
    return null;
  }
}

function sidecarProbeEffectRecord(driverManifest, hostRequest) {
  const requestBytesChecksum = `sha256:${sha256BytesHex(hostRequest.requestBytes)}`;
  const requestBytesRef = sidecarProbeBlobRef(hostRequest.requestBytes);
  return Object.freeze({
    runId: 'world-host-capability-pack-sidecar-abi-probe-run',
    branchId: 'main',
    parentTurnClosureFingerprint: 'world:turn-closure:0000000000000abc',
    state: 'running',
    attemptCount: 1,
    driverId: driverManifest.driverId,
    driverRecoveryClass: driverManifest.recoveryClass,
    actuatorRef: hostRequest.actuatorRef,
    descriptorFingerprint: hostRequest.descriptorFingerprint,
    actuationClass: hostRequest.actuationClass,
    responseSchema: hostRequest.responseSchema,
    idempotencyKey: {
      format: 'world-idempotency-key-bytes.hex',
      bytesHex: bytesHex(hostRequest.idempotencyKeyBytes),
    },
    idempotencyKeyWorldFingerprint: hostRequest.idempotencyKeyWorldFingerprint,
    hostRequestFingerprint: hostRequest.hostRequestFingerprint,
    requestBytes: hostRequest.requestBytes,
    requestBytesRef,
    requestBytesChecksum,
    requestIdentityChecksum: requestBytesChecksum,
    effectIdentityBytesRef: requestBytesRef,
    effectIdentityBytes: hostRequest.requestBytes,
    diagnostics: { worldHostCapabilityPackAbiProbe: true },
  });
}

function sidecarProbeBlobRef(bytes) {
  return Object.freeze({
    algorithm: 'sha256',
    checksum: sha256BytesHex(bytes),
    byteLength: bytes.byteLength,
  });
}

function sha256BytesHex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function adapterImportUrl(packManifest, artifacts) {
  const checksum = packManifest.checksums.find((item) => item.path === packManifest.adapter.module)?.checksum;
  if (!checksum) throw new Error(`ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED:${packManifest.adapter.module}`);
  const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-adapter-imports-'));
  for (const item of packManifest.checksums) {
    const bytes = artifacts[item.path];
    if (!(bytes instanceof Uint8Array)) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_MISSING:${item.path}`);
    const target = path.resolve(root, item.path);
    if (!pathInside(root, target)) throw new Error(`ERR_CAPABILITY_HOST_PATH_FORBIDDEN:${item.path}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  return pathToFileURL(path.resolve(root, packManifest.adapter.module)).href;
}

function adapterOptions(packManifest) {
  const base = { packFingerprint: packManifest.packFingerprint };
  if (packManifest.driverId === 'generic-http-json') return { ...base, endpointUrl: 'https://example.invalid/decide' };
  return base;
}

function assertSameManifestField(name, field, packValue, driverValue) {
  if (JSON.stringify(packValue) !== JSON.stringify(driverValue)) {
    throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_MANIFEST_MISMATCH:${name}:${field}`);
  }
}
