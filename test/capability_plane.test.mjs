import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { EffectRecoveryClass } from '../src/core/actuator.mjs';
import { EffectJournal, EffectState } from '../src/core/effect_journal.mjs';
import {
  assertCapabilityManifest,
  assertCapabilityConformanceReceipt,
  assertCapabilityPackChecksums,
  capabilityPackFingerprint,
  validateCapabilityPackManifest,
  world_host_capability_driver_abi_version,
  world_host_capability_pack_format_version,
} from '../src/core/capability_pack.mjs';
import { assertCapabilityResolutionBoundary, defineCapabilityDriver } from '../src/core/capability_driver.mjs';
import { assertCapabilityPolicyAllows, createCapabilityPolicy, redactCapabilityDiagnostics } from '../src/core/capability_policy.mjs';
import { runCapabilityMode } from '../src/core/capability_modes.mjs';
import { EnvSecretProvider, assertNoSecretValuePersisted, assertRequiredSecretsAvailable, redactSecrets } from '../src/core/secrets.mjs';
import { FileSecretProvider, PromptSecretProvider } from '../src/bun/secret_providers.mjs';
import { HostEventStream, HostEventType } from '../src/core/observability.mjs';
import {
  FixtureAgentModelCapabilityDriver,
  GenericHttpJsonModelDriver,
  decodeAgentActionFromResolutionInput,
  validateAgentAction,
} from '../src/drivers/model_capability_driver.mjs';
import { GenericHttpJsonCapabilityDriver } from '../src/drivers/generic_http_json_capability_driver.mjs';
import { HumanApprovalCapabilityDriver } from '../src/drivers/human_approval_capability_driver.mjs';
import { CapabilityDriver as HttpJsonPackCapabilityDriver } from '../capability-packs/capability-pack-v0.2-http-json/adapter.mjs';
import { CapabilityDriver as HumanApprovalPackCapabilityDriver } from '../capability-packs/capability-pack-v0.2-human-approval/adapter.mjs';
import { fromUtf8, stableJson, toHex } from '../src/core/store.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';
import { decodeResolutionInputBytes, encodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';

describe('Capability Plane v0.2 core contracts', () => {
  it('validates CapabilityPack semantic identity, checksums, and authority boundaries', async () => {
    const manifest = fixtureCapabilityManifest();
    const artifact = fromUtf8('adapter bytes');
    const readme = fromUtf8('readme bytes');
    const withChecksums = {
      ...manifest,
      checksums: [
        { path: 'adapter.mjs', checksum: `sha256:${await sha256Hex(artifact)}` },
        { path: 'README.md', checksum: `sha256:${await sha256Hex(readme)}` },
      ],
    };
    const packFingerprint = await capabilityPackFingerprint(withChecksums);
    assert.match(packFingerprint, /^sha256:[0-9a-f]{64}$/);
    const withFingerprint = { ...withChecksums, packFingerprint };
    assert.equal((await validateCapabilityPackManifest(withFingerprint, { verifyFingerprint: true })).packFingerprint, packFingerprint);
    assert.equal(await assertCapabilityPackChecksums(withFingerprint, { 'adapter.mjs': artifact, 'README.md': readme }), true);
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, supportedWorldProtocolVersion: 'v999.0.0' }),
      { code: 'ERR_CAPABILITY_VERSION_UNSUPPORTED' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, supportedApplianceAbiVersion: 'v999' }),
      { code: 'ERR_CAPABILITY_VERSION_UNSUPPORTED' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, supportedTurnClosureVersion: 'v999' }),
      { code: 'ERR_CAPABILITY_VERSION_UNSUPPORTED' },
    );
    const changedArtifact = fromUtf8('changed adapter bytes');
    const changedArtifactChecksum = `sha256:${await sha256Hex(changedArtifact)}`;
    const changedChecksumManifest = {
      ...withFingerprint,
      checksums: withFingerprint.checksums.map((item) => item.path === 'adapter.mjs'
        ? { ...item, checksum: changedArtifactChecksum }
        : item),
    };
    assert.notEqual(await capabilityPackFingerprint(changedChecksumManifest), packFingerprint);
    await assert.rejects(
      () => validateCapabilityPackManifest(changedChecksumManifest, { verifyFingerprint: true }),
      { code: 'ERR_CAPABILITY_PACK_FINGERPRINT_MISMATCH' },
    );
    const externalAdapter = fromUtf8("export { CapabilityDriver } from '../../src/drivers/model_capability_driver.mjs';");
    const externalAdapterChecksum = `sha256:${await sha256Hex(externalAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: externalAdapterChecksum }],
      }, { 'adapter.mjs': externalAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const localImportAdapter = fromUtf8("import helper from './helper.mjs'; export const CapabilityDriver = helper;");
    const localImportAdapterChecksum = `sha256:${await sha256Hex(localImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: localImportAdapterChecksum }],
      }, { 'adapter.mjs': localImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const bareImportAdapter = fromUtf8("const helper = await import('helper-package'); export const CapabilityDriver = helper.Driver;");
    const bareImportAdapterChecksum = `sha256:${await sha256Hex(bareImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: bareImportAdapterChecksum }],
      }, { 'adapter.mjs': bareImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const computedImportAdapter = fromUtf8("const specifier = './helper.mjs'; const helper = await import(specifier); export const CapabilityDriver = helper.Driver;");
    const computedImportAdapterChecksum = `sha256:${await sha256Hex(computedImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: computedImportAdapterChecksum }],
      }, { 'adapter.mjs': computedImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const prefixedStaticImportAdapter = fromUtf8(";import fs from 'node:fs'; export const CapabilityDriver = fs;");
    const prefixedStaticImportAdapterChecksum = `sha256:${await sha256Hex(prefixedStaticImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: prefixedStaticImportAdapterChecksum }],
      }, { 'adapter.mjs': prefixedStaticImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const compactStaticImportAdapter = fromUtf8("import{readFile}from 'node:fs/promises'; export const CapabilityDriver = readFile;");
    const compactStaticImportAdapterChecksum = `sha256:${await sha256Hex(compactStaticImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: compactStaticImportAdapterChecksum }],
      }, { 'adapter.mjs': compactStaticImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const requireAdapter = fromUtf8("const fs = require('node:fs'); export const CapabilityDriver = fs;");
    const requireAdapterChecksum = `sha256:${await sha256Hex(requireAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: requireAdapterChecksum }],
      }, { 'adapter.mjs': requireAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const aliasedRequireAdapter = fromUtf8("const r = require; const fs = r('node:fs'); export const CapabilityDriver = fs;");
    const aliasedRequireAdapterChecksum = `sha256:${await sha256Hex(aliasedRequireAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: aliasedRequireAdapterChecksum }],
      }, { 'adapter.mjs': aliasedRequireAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const commentedImportAdapter = fromUtf8("const fs = await import/* adapter bypass */('node:fs'); export const CapabilityDriver = fs;");
    const commentedImportAdapterChecksum = `sha256:${await sha256Hex(commentedImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: commentedImportAdapterChecksum }],
      }, { 'adapter.mjs': commentedImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const functionImportAdapter = fromUtf8('const fs = Function("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const functionImportAdapterChecksum = `sha256:${await sha256Hex(functionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: functionImportAdapterChecksum }],
      }, { 'adapter.mjs': functionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const evalImportAdapter = fromUtf8('const fs = eval("import(\\\"node:fs\\\")"); export const CapabilityDriver = fs;');
    const evalImportAdapterChecksum = `sha256:${await sha256Hex(evalImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: evalImportAdapterChecksum }],
      }, { 'adapter.mjs': evalImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const secretReadme = fromUtf8('Authorization: Bearer sk-artifact-secret-value');
    const secretReadmeChecksum = `sha256:${await sha256Hex(secretReadme)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: ['README.md'],
        checksums: [
          { path: 'adapter.mjs', checksum: withChecksums.checksums[0].checksum },
          { path: 'README.md', checksum: secretReadmeChecksum },
        ],
      }, { 'adapter.mjs': artifact, 'README.md': secretReadme }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    const sidecar = fromUtf8('sidecar bytes');
    const launcherChecksum = `sha256:${await sha256Hex(artifact)}`;
    const sidecarChecksum = `sha256:${await sha256Hex(sidecar)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({ ...withFingerprint, checksums: withFingerprint.checksums.slice(0, 1) }, { 'adapter.mjs': artifact }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['sidecar.mjs'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'bun', checksum: launcherChecksum }],
      }, { bun: artifact }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bun', 'sidecar.mjs'] },
      docs: [],
      checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
    }, { 'sidecar.mjs': sidecar }), true);
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bun', '--endpoint=https://api.example/v1', 'sidecar.mjs', '--model=gpt-4.1'] },
      docs: [],
      checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
    }, { 'sidecar.mjs': sidecar }), true);
    const sidecarImport = fromUtf8("import './helper.mjs';\nconsole.log('ready');\n");
    const sidecarImportChecksum = `sha256:${await sha256Hex(sidecarImport)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarImportChecksum }],
      }, { 'sidecar.mjs': sidecarImport }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const secretSidecar = fromUtf8('API_KEY=supersecret123\n');
    const secretSidecarChecksum = `sha256:${await sha256Hex(secretSidecar)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['sidecar.sh'] },
        docs: [],
        checksums: [{ path: 'sidecar.sh', checksum: secretSidecarChecksum }],
      }, { 'sidecar.sh': secretSidecar }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, extra: 'sk-raw-manifest-secret' }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.equal(assertCapabilityManifest({ ...manifest, requiredSecrets: ['API_TOKEN'] }).requiredSecrets[0].name, 'API_TOKEN');
    assert.throws(
      () => assertCapabilityManifest({
        ...manifest,
        requiredSecrets: [{ name: 'API_TOKEN', class: 'opaque', required: true, default: 'sk-secret-default' }],
      }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    const passedReceipt = {
      driverId: 'fixture-agent-model',
      packFingerprint: 'sha256:'.concat('1'.repeat(64)),
      corpusFingerprint: 'sha256:'.concat('2'.repeat(64)),
      vectors: [{ name: 'passed-vector', status: 'passed' }],
    };
    assert.throws(
      () => assertCapabilityConformanceReceipt({
        ...passedReceipt,
        vectors: [{ name: 'passed-vector', status: 'passed', apiKey: 'sk-vector-secret' }],
      }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityConformanceReceipt({
        ...passedReceipt,
        nonClaims: ['token=secret-value'],
      }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityConformanceReceipt({
        driverId: 'fixture-agent-model',
        packFingerprint: 'sha256:'.concat('1'.repeat(64)),
        corpusFingerprint: 'sha256:'.concat('2'.repeat(64)),
        vectors: [{ name: 'failed-vector', status: 'failed' }],
      }),
      { code: 'ERR_CAPABILITY_CONFORMANCE_RECEIPT_INVALID' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, driverAbiVersion: 99 }),
      { code: 'ERR_CAPABILITY_VERSION_UNSUPPORTED' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, authorityLabels: ['operation:delete'] }),
      { code: 'ERR_CAPABILITY_OPERATION_LABEL_AUTHORITY_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, adapter: { kind: 'in_process', module: '/tmp/driver.mjs' } }),
      { code: 'ERR_CAPABILITY_HOST_PATH_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, adapter: { kind: 'sidecar', command: ['/tmp/provider'] } }),
      { code: 'ERR_CAPABILITY_HOST_PATH_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, policyRequirements: { allowedFileRoots: ['/etc'] } }),
      { code: 'ERR_CAPABILITY_HOST_PATH_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, metadataBytes: ['sk', 'test-secret-value'].join('-') }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, metadataBytes: fromUtf8(['sk', 'metadata-secret-value'].join('-')) }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    const encodedMetadataSecret = btoa(String.fromCharCode(...fromUtf8(['sk', 'base64-secret-value'].join('-'))));
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, metadataBytes: { format: 'base64', bytes: encodedMetadataSecret } }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, metadataBytes: 'Bearer persisted-token-value' }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.doesNotThrow(
      () => assertCapabilityManifest({
        ...manifest,
        requiredSecrets: [{ name: 'HTTP_AUTHORIZATION', class: 'header', purpose: 'optional authorization header' }],
      }),
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, requiredSecrets: [{ name: 'Bearer persisted-token-value' }] }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, requiredSecrets: [{ name: 'API_TOKEN', class: 'password=persisted-token-value' }] }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, requiredSecrets: [{ name: 'API_TOKEN', purpose: 'token=persisted-token-value' }] }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, requiredSecrets: [{ name: 'sk-abcdefghijklmnop' }] }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityResolutionBoundary({}),
      { code: 'ERR_EXPECTED_BYTES' },
    );
  });

  it('denies live, network, file, and best-effort capabilities by default', () => {
    const manifest = {
      driverId: 'network',
      packFingerprint: 'sha256:'.concat('1'.repeat(64)),
      authorityLabels: ['network:http'],
      recoveryClass: EffectRecoveryClass.bestEffort,
      maximumResponseBytes: 1024,
    };
    assert.throws(
      () => assertCapabilityPolicyAllows({ manifest, hostRequest: httpRequest(), policy: createCapabilityPolicy(), mode: 'live' }),
      { code: 'ERR_CAPABILITY_LIVE_DENIED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest,
        hostRequest: httpRequest(),
        policy: {
          auditOnly: true,
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_AUDIT_ONLY_DENIED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({ manifest, hostRequest: httpRequest(), policy: { allowLiveEffects: true }, mode: 'live' }),
      { code: 'ERR_CAPABILITY_NETWORK_DENIED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest: {
          driverId: 'mislabelled-file',
          supportedActuationClasses: ['file'],
          authorityLabels: [],
          recoveryClass: EffectRecoveryClass.bestEffort,
          maximumResponseBytes: 1024,
          diagnostics: { root: '/blocked' },
        },
        hostRequest: {
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClass: 'file',
          responseSchema: { status: 'ok' },
          requestBytes: fromUtf8(stableJson({ path: 'out.txt', operation: 'write', content: 'blocked' })),
        },
        policy: {
          allowLiveEffects: true,
          allowFileEffects: true,
          allowBestEffort: true,
        },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_FILE_ROOT_ALLOWLIST_REQUIRED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest: {
          driverId: 'mislabelled-file',
          supportedActuationClasses: ['file'],
          authorityLabels: [],
          recoveryClass: EffectRecoveryClass.bestEffort,
          maximumResponseBytes: 1024,
          diagnostics: { root: '/blocked' },
        },
        hostRequest: {
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClass: 'file',
          responseSchema: { status: 'ok' },
          requestBytes: fromUtf8(stableJson({ path: 'out.txt', operation: 'write', content: 'blocked' })),
        },
        policy: {
          allowLiveEffects: true,
          allowFileEffects: true,
          allowBestEffort: true,
          allowedFileRoots: ['/allowed'],
        },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_FILE_ROOT_DENIED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest,
        hostRequest: httpRequest(),
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowBestEffort: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_APPROVAL_REQUIRED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest: { ...manifest, recoveryClass: EffectRecoveryClass.idempotent },
        hostRequest: httpRequest(),
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedMethods: ['POST'] },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_ORIGIN_ALLOWLIST_REQUIRED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest: { ...manifest, recoveryClass: EffectRecoveryClass.idempotent },
        hostRequest: httpRequest(),
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'] },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_METHOD_ALLOWLIST_REQUIRED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest: { ...manifest, recoveryClass: EffectRecoveryClass.idempotent },
        hostRequest: { ...httpRequest(), requestBytes: fromUtf8('{') },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_NETWORK_TARGET_REQUIRED' },
    );
    assert.equal(assertCapabilityPolicyAllows({
      manifest: { ...manifest, recoveryClass: EffectRecoveryClass.idempotent },
      hostRequest: httpRequest(),
      policy: {
        allowLiveEffects: true,
        allowNetworkEffects: true,
        allowedOrigins: ['https://allowed.example'],
        allowedMethods: ['POST'],
      },
      mode: 'live',
    }), true);
    assert.equal(assertCapabilityPolicyAllows({
      manifest: {
        driverId: 'model',
        authorityLabels: ['model:fixture'],
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1024,
      },
      hostRequest: { ...httpRequest(), actuationClass: 'model' },
      policy: { allowLiveEffects: true, allowedOrigins: ['https://other.example'], allowedMethods: ['POST'] },
      mode: 'live',
    }), true);
    assert.throws(() => assertCapabilityPolicyAllows({
      manifest: {
        driverId: 'deterministic-model-http',
        authorityLabels: ['model:http-json'],
        diagnostics: { deterministic: true },
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1024,
      },
      hostRequest: { ...genericHttpModelRequest('goal=policy', 'model-policy-key') },
      policy: { allowLiveEffects: true },
      mode: 'live',
    }), { code: 'ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED' });
    assert.throws(() => assertCapabilityPolicyAllows({
      manifest: {
        driverId: 'http',
        authorityLabels: ['network:http'],
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1024,
      },
      hostRequest: { ...httpRequest(), requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/decide' })) },
      policy: {
        allowLiveEffects: true,
        allowNetworkEffects: true,
        allowedOrigins: ['https://allowed.example'],
        allowedMethods: ['POST'],
      },
      mode: 'live',
    }), { code: 'ERR_CAPABILITY_METHOD_REQUIRED' });
    assert.throws(() => assertCapabilityPolicyAllows({
      manifest: { ...manifest, recoveryClass: EffectRecoveryClass.idempotent },
      hostRequest: {
        ...httpRequest(),
        requestBytes: fromUtf8(stableJson({ url: 'https://user:pass@allowed.example/decide', method: 'POST' })),
      },
      policy: {
        allowLiveEffects: true,
        allowNetworkEffects: true,
        allowedOrigins: ['https://allowed.example'],
        allowedMethods: ['POST'],
      },
      mode: 'live',
    }), { code: 'ERR_CAPABILITY_NETWORK_TARGET_REQUIRED' });
    assert.throws(() => assertCapabilityPolicyAllows({
      manifest: { ...manifest, recoveryClass: EffectRecoveryClass.idempotent },
      hostRequest: {
        ...httpRequest(),
        requestBytes: fromUtf8(stableJson({ url: 'file:///tmp/world-host-capability.json', method: 'POST' })),
      },
      policy: {
        allowLiveEffects: true,
        allowNetworkEffects: true,
        allowedOrigins: ['null'],
        allowedMethods: ['POST'],
      },
      mode: 'live',
    }), { code: 'ERR_CAPABILITY_NETWORK_TARGET_REQUIRED' });
  });

  it('awaits asynchronous capability driver reports', async () => {
    const driver = defineCapabilityDriver({
      manifest: () => new FixtureAgentModelCapabilityDriver().manifest(),
      async preflight() {
        return { accepted: true, blockers: ['should-not-survive'] };
      },
      async dryRun() {
        return { wouldInvoke: true, proposedAction: { async: true } };
      },
      async shadow() {
        return { liveInvoked: true, schemaAccepted: true };
      },
      async resolve() {
        throw new Error('not used');
      },
    });

    assert.equal((await driver.preflight({}, modelRequest('goal=async'))).accepted, true);
    assert.equal((await driver.dryRun({}, modelRequest('goal=async'))).wouldInvoke, true);
    assert.equal((await driver.shadow({}, modelRequest('goal=async'), null)).schemaAccepted, true);
  });

  it('keeps secrets receiver-local and redacted', async () => {
    const env = new EnvSecretProvider({ API_TOKEN: 'fixture-token-value' });
    assert.equal(env.has('API_TOKEN'), true);
    assert.equal(env.describe('API_TOKEN').redacted, true);
    assert.equal(env.accessReport('API_TOKEN').valueRedacted, true);
    assert.equal(redactSecrets({ apiKey: 'fixture-token-value' }).apiKey, '[redacted]');
    assert.equal(redactSecrets({ message: 'sk-abcdefghijklmnop' }).message, '[redacted]');
    assert.equal(redactCapabilityDiagnostics({ diagnostics: { Authorization: 'Bearer fixture-token-value' } }).diagnostics.Authorization, '[redacted]');
    assert.equal(redactCapabilityDiagnostics({ message: 'sk-abcdefghijklmnop' }).message, '[redacted]');
    assert.throws(() => assertNoSecretValuePersisted({ value: ['sk', 'local-secret'].join('-') }), { code: 'ERR_SECRET_PERSISTED' });

    const secretBase = await mkdtemp(path.join(tmpdir(), 'world-host-secret-'));
    const root = path.join(secretBase, 'root');
    try {
      await mkdir(root);
      await writeFile(path.join(root, 'api-token'), 'fixture-file-value\n');
      const fileProvider = new FileSecretProvider({ root, mapping: { API_TOKEN: 'api-token' } });
      assert.equal(fileProvider.has('API_TOKEN'), true);
      assert.equal(fileProvider.has('MISSING'), false);
      assert.equal(await fileProvider.get('API_TOKEN'), 'fixture-file-value');
      assert.equal((await fileProvider.accessReport('API_TOKEN')).valueRedacted, true);
      assert.throws(() => assertRequiredSecretsAvailable(fileProvider, ['MISSING']), { code: 'ERR_SECRET_MISSING' });
      await assert.rejects(() => new FileSecretProvider({ root, mapping: { BAD: '../secret' } }).get('BAD'), { code: 'ERR_SECRET_FILE_PATH_INVALID' });
      const outsideSecret = path.join(secretBase, 'outside-secret');
      await writeFile(outsideSecret, 'outside-secret-value');
      await symlink(outsideSecret, path.join(root, 'linked-secret'));
      const linkedProvider = new FileSecretProvider({ root, mapping: { LINKED: 'linked-secret' } });
      assert.equal(linkedProvider.has('LINKED'), false);
      await assert.rejects(() => linkedProvider.get('LINKED'), { code: 'ERR_SECRET_FILE_PATH_INVALID' });
      await writeFile(path.join(root, 'empty-token'), '\n');
      const emptyProvider = new FileSecretProvider({ root, mapping: { EMPTY: 'empty-token' } });
      assert.equal(emptyProvider.has('EMPTY'), false);
      assert.equal((await emptyProvider.accessReport('EMPTY')).available, false);
      await assert.rejects(() => emptyProvider.get('EMPTY'), { code: 'ERR_SECRET_MISSING' });
      const emptySecretPreflight = new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        secretHeaders: { Authorization: 'EMPTY' },
        secretProvider: emptyProvider,
      }).preflight({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }, httpRequest());
      assert.equal(emptySecretPreflight.accepted, false);
      assert.equal(emptySecretPreflight.blockers.includes('ERR_SECRET_MISSING'), true);
    } finally {
      await rm(secretBase, { recursive: true, force: true });
    }
  });

  it('derives live smoke idempotency headers from the configured key', async () => {
    let idempotencyHeader = null;
    let smokeStatus = 200;
    const server = createServer((request, response) => {
      idempotencyHeader = request.headers['idempotency-key'];
      request.resume();
      response.writeHead(smokeStatus, { 'content-type': 'application/json' });
      response.end(smokeStatus === 200 ? '{}' : 'failed');
    });
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-live-smoke-'));
    try {
      await listen(server);
      const { port } = server.address();
      const endpointUrl = `http://127.0.0.1:${port}/decide`;
      const idempotencyKey = 'operator-selected-live-smoke-key';
      const config = path.join(root, 'config.json');
      await writeFile(config, JSON.stringify({ endpointUrl, idempotencyKey, body: { ok: true } }));
      const result = await runBunProcess([
        process.execPath,
        'scripts/run-live-capability-smoke.mjs',
        '--config',
        config,
        '--secret-provider',
        'env',
        '--allow-origin',
        `http://127.0.0.1:${port}`,
        '--live',
      ], { env: { ...process.env, WORLD_HOST_LIVE_SMOKE: '1' } });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.equal(
        idempotencyHeader,
        `world:key:live-smoke:${createHash('sha256').update(fromUtf8(idempotencyKey)).digest('hex')}`,
      );
      smokeStatus = 500;
      const failingResult = await runBunProcess([
        process.execPath,
        'scripts/run-live-capability-smoke.mjs',
        '--config',
        config,
        '--secret-provider',
        'env',
        '--allow-origin',
        `http://127.0.0.1:${port}`,
        '--live',
      ], { env: { ...process.env, WORLD_HOST_LIVE_SMOKE: '1' } });
      assert.notEqual(failingResult.code, 0);
      assert.match(failingResult.stderr, /ERR_LIVE_SMOKE_HTTP_ERROR_RESOLUTION/);
    } finally {
      server.closeAllConnections?.();
      await close(server);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs fixture, dry-run, shadow, approval, and live modes without host-authored World evidence', async () => {
    const driver = new FixtureAgentModelCapabilityDriver();
    const request = modelRequest('goal=invoke', 'model-key');
    const fixture = await runCapabilityMode({ mode: 'fixture', driver, hostRequest: request });
    assert.equal(decodeResolutionInputBytes(fixture.resolutionInputBytes).status, 0);
    const fixtureWithDriverOverrides = await runCapabilityMode({ mode: 'fixture', driver: hostFieldOverrideFixtureDriver(), hostRequest: request });
    assert.equal(fixtureWithDriverOverrides.mode, 'fixture');
    assert.equal(fixtureWithDriverOverrides.submittedToWorld, true);
    assert.throws(
      () => assertCapabilityResolutionBoundary({ ...fixture, turnReceiptBytes: fromUtf8('receipt') }),
      { code: 'ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN' },
    );
    await assert.rejects(
      () => runCapabilityMode({ mode: 'fixture', driver: wrongTargetFixtureDriver(), hostRequest: request }),
      { code: 'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH' },
    );
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'fixture',
        driver,
        hostRequest: { ...request, actuatorRef: 'http:json' },
      }),
      { code: 'ERR_ACTUATOR_REF_NOT_SUPPORTED' },
    );
    const uncoveredRequest = { ...request, actuatorRef: 'model:other' };
    await assert.rejects(
      () => runCapabilityMode({ mode: 'fixture', driver: hostFieldOverrideFixtureDriver(), hostRequest: uncoveredRequest }),
      { code: 'ERR_ACTUATOR_REF_NOT_SUPPORTED' },
    );
    await assert.rejects(
      () => runCapabilityMode({ mode: 'dry-run', driver: hostFieldOverrideFixtureDriver(), hostRequest: uncoveredRequest }),
      { code: 'ERR_ACTUATOR_REF_NOT_SUPPORTED' },
    );
    await assert.rejects(
      () => runCapabilityMode({ mode: 'shadow', driver: hostFieldOverrideFixtureDriver(), hostRequest: uncoveredRequest, recordedResolution: fromUtf8('recorded') }),
      { code: 'ERR_ACTUATOR_REF_NOT_SUPPORTED' },
    );
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'approval',
        driver: hostFieldOverrideFixtureDriver(),
        hostRequest: uncoveredRequest,
        approval: () => ({ approved: true }),
      }),
      { code: 'ERR_ACTUATOR_REF_NOT_SUPPORTED' },
    );
    const dry = await runCapabilityMode({ mode: 'dry-run', driver, hostRequest: request });
    assert.equal(dry.submittedToWorld, false);
    const shadow = await runCapabilityMode({ mode: 'shadow', driver, hostRequest: request, recordedResolution: fromUtf8('recorded') });
    assert.equal(shadow.submittedToWorld, false);
    let fixtureLiveEffectResolveCalled = false;
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'fixture',
        driver: deterministicLiveEffectDriver(() => {
          fixtureLiveEffectResolveCalled = true;
        }),
        hostRequest: httpRequest(),
      }),
      { code: 'ERR_CAPABILITY_FIXTURE_LIVE_EFFECT_DENIED' },
    );
    assert.equal(fixtureLiveEffectResolveCalled, false);
    let fixtureUnlabeledLiveEffectResolveCalled = false;
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'fixture',
        driver: deterministicLiveEffectDriver(() => {
          fixtureUnlabeledLiveEffectResolveCalled = true;
        }, { authorityLabels: [] }),
        hostRequest: httpRequest(),
      }),
      { code: 'ERR_CAPABILITY_FIXTURE_LIVE_EFFECT_DENIED' },
    );
    assert.equal(fixtureUnlabeledLiveEffectResolveCalled, false);
    let fixtureModelLiveEffectResolveCalled = false;
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'fixture',
        driver: deterministicModelLiveEffectDriver(() => {
          fixtureModelLiveEffectResolveCalled = true;
        }),
        hostRequest: genericHttpModelRequest('goal=fixture-model-live', 'model-fixture-live-key'),
      }),
      { code: 'ERR_CAPABILITY_FIXTURE_LIVE_EFFECT_DENIED' },
    );
    assert.equal(fixtureModelLiveEffectResolveCalled, false);

    const approved = await runCapabilityMode({
      mode: 'approval',
      driver,
      hostRequest: request,
      approval: () => ({ approved: true }),
    });
    assert.equal(approved.approved, true);
    assert.equal(approved.proposed.wouldInvoke, false);
    assertCapabilityResolutionBoundary(approved);
    const approvedWithDriverOverrides = await runCapabilityMode({
      mode: 'approval',
      driver: hostFieldOverrideFixtureDriver(),
      hostRequest: request,
      approval: () => ({ approved: true }),
    });
    assert.equal(approvedWithDriverOverrides.mode, 'approval');
    assert.equal(approvedWithDriverOverrides.submittedToWorld, true);
    assert.equal(approvedWithDriverOverrides.approved, true);
    assert.equal(approvedWithDriverOverrides.proposed.wouldInvoke, false);
    let approvalShortcutLiveEffectResolveCalled = false;
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'approval',
        driver: deterministicLiveEffectDriver(() => {
          approvalShortcutLiveEffectResolveCalled = true;
        }, { authorityLabels: [], driverId: 'fixture-agent-model' }),
        hostRequest: httpRequest(),
        approval: () => ({ approved: true }),
      }),
      { code: 'ERR_CAPABILITY_FIXTURE_LIVE_EFFECT_DENIED' },
    );
    assert.equal(approvalShortcutLiveEffectResolveCalled, false);
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'approval',
        driver: wrongTargetFixtureDriver(),
        hostRequest: request,
        approval: () => ({ approved: true }),
      }),
      { code: 'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH' },
    );

    const store = new MemoryStore();
    const live = await runCapabilityMode({
      mode: 'live',
      driver,
      hostRequest: request,
      journalOptions: {
        store,
        runId: 'run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'world:turn-closure:parent',
      },
      policy: { allowLiveEffects: true },
    });
    assert.equal(live.record.state, 'resolved');
    assert.equal(live.submittedToWorld, false);
    assert.equal(decodeResolutionInputBytes(live.resolutionInputBytes).status, 0);

    const parkedStore = new MemoryStore();
    const parkedJournal = new EffectJournal({
      store: parkedStore,
      runId: 'parked-run',
      branchId: 'main',
      parentTurnClosureFingerprint: 'world:turn-closure:parent',
      policy: { allowBestEffort: true },
    });
    const parkedRequest = {
      ...modelRequest('goal=parked', 'model-parked-key'),
      hostRequestFingerprint: 'world:host-request:00000000000000a8',
    };
    const observed = await parkedJournal.observe(parkedRequest, { recoveryClass: EffectRecoveryClass.bestEffort });
    await parkedStore.putEffectRecord({ ...observed, state: EffectState.running, attemptCount: 1 });
    const parkedDriver = bestEffortModelDriver();
    const parked = await runCapabilityMode({
      mode: 'live',
      driver: parkedDriver,
      hostRequest: parkedRequest,
      journalOptions: parkedJournal,
      policy: { allowLiveEffects: true, allowBestEffort: true, requireApprovalForBestEffort: false },
    });
    assert.equal(parked.operatorInterventionRequired, true);
    assert.equal(parked.submittedToWorld, false);
    assert.equal(parked.resolutionInputBytes, null);
    assert.equal(parkedDriver.resolveCalled, false);
  });

  it('supports generic HTTP JSON and human approval reference capabilities', async () => {
    const originalFetch = globalThis.fetch;
    let observedHeaders = null;
    try {
      globalThis.fetch = async (url, options) => {
        observedHeaders = options.headers;
        return new Response('{"action":{"variant":"final","text":"ok"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-1' },
        });
      };
      const driver = new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        secretHeaders: { Authorization: 'API_TOKEN' },
        secretProvider: new EnvSecretProvider({ API_TOKEN: 'Bearer fixture-token-value' }),
      });
      assert.deepEqual(driver.manifest().supportedResponseStatuses, ['ok', 'http_error', 'deferred']);
      const packDriver = new HttpJsonPackCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' });
      assert.deepEqual(packDriver.manifest().supportedResponseStatuses, ['ok', 'http_error', 'deferred']);
      const runtimePackFingerprint = 'sha256:'.concat('4'.repeat(64));
      const pinnedPackDriver = defineCapabilityDriver(new HttpJsonPackCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        packFingerprint: runtimePackFingerprint,
      }));
      assert.equal(pinnedPackDriver.manifest().packFingerprint, runtimePackFingerprint);
      assert.throws(
        () => assertCapabilityPolicyAllows({
          manifest: pinnedPackDriver.manifest(),
          hostRequest: httpRequest(),
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            deniedCapabilityPacks: [runtimePackFingerprint],
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
          mode: 'live',
        }),
        { code: 'ERR_CAPABILITY_PACK_DENIED' },
      );
      assert.equal(assertCapabilityPolicyAllows({
        manifest: pinnedPackDriver.manifest(),
        hostRequest: httpRequest(),
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedCapabilityPacks: [runtimePackFingerprint],
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
        mode: 'live',
      }), true);
      assert.throws(
        () => new HttpJsonPackCapabilityDriver({ endpointUrl: 'https://allowed.example/decide?api_key=secret' }),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      const credentialQueryRequest = {
        ...httpRequest(),
        requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/decide?token=Bearer%20fixture-token-value', method: 'POST', body: { prompt: 'hi' } })),
      };
      assert.throws(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example'],
        }).dryRun({}, credentialQueryRequest),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      assert.throws(
        () => new HttpJsonPackCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example'],
        }).dryRun({}, credentialQueryRequest),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      const result = await driver.resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, httpRequest());
      assert.equal(observedHeaders.Authorization, 'Bearer fixture-token-value');
      assert.equal(JSON.stringify(result.diagnostics).includes('secret'), false);
      assert.equal(decodeResolutionInputBytes(result.resolutionInputBytes).status, 0);
      assert.equal(driver.dryRun({}, httpRequest()).wouldInvoke, true);

      globalThis.fetch = async () => new Response('{"action":{"variant":"final","text":"Bearer fixture-token-value"}}', {
        status: 200,
        headers: { 'x-request-id': 'request-secret-echo' },
      });
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          secretHeaders: { Authorization: 'API_TOKEN' },
          secretProvider: new EnvSecretProvider({ API_TOKEN: 'Bearer fixture-token-value' }),
        }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, {
          ...httpRequest(),
          hostRequestFingerprint: 'world:host-request:00000000000000ab',
          idempotencyKeyBytes: fromUtf8('http-key-secret-echo'),
          idempotencyKeyWorldFingerprint: 'world:key:http-secret-echo',
        }),
        { code: 'ERR_SECRET_PERSISTED' },
      );
      globalThis.fetch = async () => new Response('{"action":{"variant":"final","text":"ok"}}', {
        status: 200,
        headers: { 'x-request-id': 'Bearer fixture-token-value' },
      });
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          secretHeaders: { Authorization: 'API_TOKEN' },
          secretProvider: new EnvSecretProvider({ API_TOKEN: 'Bearer fixture-token-value' }),
        }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, {
          ...httpRequest(),
          hostRequestFingerprint: 'world:host-request:00000000000000ac',
          idempotencyKeyBytes: fromUtf8('http-key-secret-transaction-ref'),
          idempotencyKeyWorldFingerprint: 'world:key:http-secret-transaction-ref',
        }),
        { code: 'ERR_SECRET_PERSISTED' },
      );

      let secretHasCalls = 0;
      let secretGetCalls = 0;
      const untouchedSecretProvider = {
        has() {
          secretHasCalls += 1;
          return true;
        },
        async get() {
          secretGetCalls += 1;
          return 'Bearer should-not-read';
        },
      };
      const blockedSecretDriver = new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        secretHeaders: { Authorization: 'API_TOKEN' },
        secretProvider: untouchedSecretProvider,
      });
      const deniedSecretPreflight = blockedSecretDriver.preflight({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://other.example'],
          allowedMethods: ['POST'],
        },
      }, httpRequest());
      assert.equal(deniedSecretPreflight.accepted, false);
      assert.equal(deniedSecretPreflight.blockers.includes('ERR_CAPABILITY_ORIGIN_DENIED'), true);
      assert.equal(secretHasCalls, 0);
      await assert.rejects(
        () => blockedSecretDriver.resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://other.example'],
            allowedMethods: ['POST'],
          },
        }, httpRequest()),
        { code: 'ERR_CAPABILITY_ORIGIN_DENIED' },
      );
      assert.equal(secretGetCalls, 0);

      let observedBody = undefined;
      globalThis.fetch = async (url, options) => {
        observedBody = options.body;
        return new Response('{"status":"ok"}', {
          status: 200,
          headers: { 'x-request-id': 'request-null-body' },
        });
      };
      await new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, {
        ...httpRequest(),
        hostRequestFingerprint: 'world:host-request:00000000000000a6',
        idempotencyKeyBytes: fromUtf8('http-key-null-body'),
        idempotencyKeyWorldFingerprint: 'world:key:http-null-body',
        requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/decide', method: 'POST', body: null })),
      });
      assert.equal(observedBody, 'null');

      let errorBodyPulled = false;
      globalThis.fetch = async () => new Response(new ReadableStream({
        pull(controller) {
          errorBodyPulled = true;
          controller.enqueue(fromUtf8('http-error-body'));
          controller.close();
        },
      }), {
        status: 500,
        headers: { 'x-request-id': 'request-http-error' },
      });
      const httpError = await new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, {
        ...httpRequest(),
        hostRequestFingerprint: 'world:host-request:00000000000000a7',
        idempotencyKeyBytes: fromUtf8('http-key-error-body'),
        idempotencyKeyWorldFingerprint: 'world:key:http-error-body',
      });
      assert.equal(decodeResolutionInputBytes(httpError.resolutionInputBytes).status, 1);
      assert.equal(errorBodyPulled, true);

      let retryFetchCount = 0;
      globalThis.fetch = async () => {
        retryFetchCount += 1;
        if (retryFetchCount === 1) throw new TypeError('transient network failure');
        return new Response('{"status":"ok"}', {
          status: 200,
          headers: { 'x-request-id': 'request-retry' },
        });
      };
      const retried = await new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        retryPolicy: { attempts: 2 },
      }).resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, {
        ...httpRequest(),
        hostRequestFingerprint: 'world:host-request:00000000000000a9',
        idempotencyKeyBytes: fromUtf8('http-key-retry'),
        idempotencyKeyWorldFingerprint: 'world:key:http-retry',
      });
      assert.equal(retryFetchCount, 2);
      assert.equal(decodeResolutionInputBytes(retried.resolutionInputBytes).status, 0);

      let postResponseFailureFetchCount = 0;
      globalThis.fetch = async () => {
        postResponseFailureFetchCount += 1;
        return new Response('{not-json', {
          status: 200,
          headers: { 'x-request-id': 'request-post-response-failure' },
        });
      };
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          retryPolicy: { attempts: 2 },
        }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, {
          ...httpRequest(),
          hostRequestFingerprint: 'world:host-request:00000000000000ad',
          idempotencyKeyBytes: fromUtf8('http-key-post-response-failure'),
          idempotencyKeyWorldFingerprint: 'world:key:http-post-response-failure',
        }),
        SyntaxError,
      );
      assert.equal(postResponseFailureFetchCount, 1);

      let stalledBodyAborted = false;
      globalThis.fetch = async (url, options) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(fromUtf8('{"status":'));
          options.signal.addEventListener('abort', () => {
            stalledBodyAborted = true;
            controller.error(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        },
      }), {
        status: 200,
        headers: { 'x-request-id': 'request-body-timeout' },
      });
      const stalledBodyTimeout = await new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        timeoutMs: 5,
      }).resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, {
        ...httpRequest(),
        hostRequestFingerprint: 'world:host-request:00000000000000aa',
        idempotencyKeyBytes: fromUtf8('http-key-body-timeout'),
        idempotencyKeyWorldFingerprint: 'world:key:http-body-timeout',
      });
      assert.equal(decodeResolutionInputBytes(stalledBodyTimeout.resolutionInputBytes).status, 4);
      assert.equal(stalledBodyAborted, true);

      let reuseFetchCount = 0;
      globalThis.fetch = async () => {
        reuseFetchCount += 1;
        return new Response('{"action":{"variant":"final","text":"reused"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-reused' },
        });
      };
      const reuseStore = new MemoryStore();
      const reuseJournalOptions = {
        store: reuseStore,
        runId: 'secret-reuse-run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'world:turn-closure:parent',
      };
      const firstSecretRun = await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          secretHeaders: { Authorization: 'API_TOKEN' },
          secretProvider: new EnvSecretProvider({ API_TOKEN: 'Bearer reusable-token' }),
        }),
        hostRequest: httpRequest(),
        journalOptions: reuseJournalOptions,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(firstSecretRun.reused, false);
      globalThis.fetch = async () => {
        reuseFetchCount += 1;
        throw new Error('reused effect should not fetch');
      };
      const secondSecretRun = await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          secretHeaders: { Authorization: 'API_TOKEN' },
        }),
        hostRequest: httpRequest(),
        journalOptions: reuseJournalOptions,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(secondSecretRun.reused, true);
      assert.equal(reuseFetchCount, 1);

      let directLimitedRequestFetchCalled = false;
      globalThis.fetch = async () => {
        directLimitedRequestFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            maximumRequestBytes: 1,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }, httpRequest()),
        { code: 'ERR_CAPABILITY_PROMPT_TOO_LARGE' },
      );
      assert.equal(directLimitedRequestFetchCalled, false);

      assert.throws(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'file:///tmp/world-host-capability.json' }),
        { code: 'ERR_HTTP_URL_SCHEME_REJECTED' },
      );
      assert.throws(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://user:pass@allowed.example/decide' }),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      assert.throws(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          secretHeaders: { 'idempotency-key': 'API_TOKEN' },
        }),
        { code: 'ERR_HTTP_SECRET_HEADER_RESERVED' },
      );
      let credentialUrlFetchCalled = false;
      globalThis.fetch = async () => {
        credentialUrlFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example'],
        }).resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }, {
          ...httpRequest(),
          requestBytes: fromUtf8(stableJson({ url: 'https://user:pass@allowed.example/decide', method: 'POST', body: { prompt: 'hi' } })),
        }),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      assert.equal(credentialUrlFetchCalled, false);

      let nonHttpFetchCalled = false;
      globalThis.fetch = async () => {
        nonHttpFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          allowEndpointFromRequest: true,
          origins: ['null', 'https://allowed.example'],
        }).resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['null'],
            allowedMethods: ['POST'],
          },
        }, {
          ...httpRequest(),
          requestBytes: fromUtf8(stableJson({ url: 'file:///tmp/world-host-capability.json', method: 'POST', body: { prompt: 'hi' } })),
        }),
        { code: 'ERR_HTTP_URL_SCHEME_REJECTED' },
      );
      assert.equal(nonHttpFetchCalled, false);

      let limitedRequestFetchCalled = false;
      globalThis.fetch = async () => {
        limitedRequestFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
          hostRequest: httpRequest(),
          journalOptions: {
            store: new MemoryStore(),
            runId: 'request-limit-run',
            branchId: 'main',
            parentTurnClosureFingerprint: 'world:turn-closure:parent',
          },
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            maximumRequestBytes: 1,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }),
        { code: 'ERR_CAPABILITY_PROMPT_TOO_LARGE' },
      );
      assert.equal(limitedRequestFetchCalled, false);

      const renderedTemplate = { prompt: 'x'.repeat(128) };
      const renderedLimitedHostRequest = { ...httpRequest(), requestBytes: fromUtf8(stableJson({ body: 'x' })) };
      let renderedLimitedFetchCalled = false;
      globalThis.fetch = async () => {
        renderedLimitedFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({
            endpointUrl: 'https://allowed.example/decide',
            requestTemplate: renderedTemplate,
          }),
          hostRequest: renderedLimitedHostRequest,
          journalOptions: {
            store: new MemoryStore(),
            runId: 'rendered-request-limit-run',
            branchId: 'main',
            parentTurnClosureFingerprint: 'world:turn-closure:parent',
          },
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            maximumRequestBytes: renderedLimitedHostRequest.requestBytes.byteLength + 8,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }),
        (error) => {
          assert.equal(error.code, 'ERR_CAPABILITY_PREFLIGHT_BLOCKED');
          assert.deepEqual(error.details.blockers, ['ERR_CAPABILITY_PROMPT_TOO_LARGE']);
          return true;
        },
      );
      assert.equal(renderedLimitedFetchCalled, false);

      let missingAllowlistFetchCalled = false;
      globalThis.fetch = async () => {
        missingAllowlistFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
          hostRequest: { ...httpRequest(), requestBytes: fromUtf8(stableJson({ body: { prompt: 'hi' } })) },
          journalOptions: {
            store: new MemoryStore(),
            runId: 'missing-allowlist-run',
            branchId: 'main',
            parentTurnClosureFingerprint: 'world:turn-closure:parent',
          },
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
          },
        }),
        { code: 'ERR_CAPABILITY_ORIGIN_ALLOWLIST_REQUIRED' },
      );
      assert.equal(missingAllowlistFetchCalled, false);

      let configuredEndpointFetchCalled = false;
      globalThis.fetch = async () => {
        configuredEndpointFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"configured"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-configured' },
        });
      };
      const configuredEndpointRequest = { ...httpRequest(), requestBytes: fromUtf8(stableJson({ body: { prompt: 'hi' } })) };
      const configuredEndpointJournalOptions = {
        store: new MemoryStore(),
        runId: 'configured-endpoint-run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'world:turn-closure:parent',
      };
      const configuredEndpointLive = await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
        hostRequest: configuredEndpointRequest,
        journalOptions: configuredEndpointJournalOptions,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(configuredEndpointFetchCalled, true);
      assert.equal(decodeResolutionInputBytes(configuredEndpointLive.resolutionInputBytes).status, 0);
      globalThis.fetch = async () => {
        throw new Error('configured endpoint reuse should be blocked by current policy');
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
          hostRequest: configuredEndpointRequest,
          journalOptions: configuredEndpointJournalOptions,
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://other.example'],
            allowedMethods: ['POST'],
          },
        }),
        { code: 'ERR_CAPABILITY_ORIGIN_DENIED' },
      );
      let configuredEndpointReuseFetchCalled = false;
      globalThis.fetch = async () => {
        configuredEndpointReuseFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"other"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-configured-other' },
        });
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://other.example/decide' }),
          hostRequest: configuredEndpointRequest,
          journalOptions: configuredEndpointJournalOptions,
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://other.example'],
            allowedMethods: ['POST'],
          },
        }),
        { code: 'ERR_EFFECT_IDEMPOTENCY_CONFLICT' },
      );
      assert.equal(configuredEndpointReuseFetchCalled, false);

      let configuredPayloadUrlFetchUrl = null;
      globalThis.fetch = async (url) => {
        configuredPayloadUrlFetchUrl = url;
        return new Response('{"action":{"variant":"final","text":"configured-payload-url"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-configured-payload-url' },
        });
      };
      await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
        hostRequest: {
          ...httpRequest(),
          hostRequestFingerprint: 'world:host-request:00000000000000a4',
          idempotencyKeyBytes: fromUtf8('http-key-configured-payload-url'),
          idempotencyKeyWorldFingerprint: 'world:key:http-configured-payload-url',
          requestBytes: fromUtf8(stableJson({ url: 'https://denied.example/data', prompt: 'payload data only' })),
        },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'configured-payload-url-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(configuredPayloadUrlFetchUrl, 'https://allowed.example/decide');

      let tinyBodyFetchCalled = false;
      globalThis.fetch = async () => {
        tinyBodyFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"tiny-body"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-tiny-body' },
        });
      };
      const tinyBodyDriver = new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        maximumRequestBytes: 2,
      });
      await runCapabilityMode({
        mode: 'live',
        driver: tinyBodyDriver,
        hostRequest: {
          ...httpRequest(),
          hostRequestFingerprint: 'world:host-request:00000000000000a5',
          idempotencyKeyBytes: fromUtf8('http-key-tiny-body'),
          idempotencyKeyWorldFingerprint: 'world:key:http-tiny-body',
          requestBytes: fromUtf8(stableJson({ body: {} })),
        },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'tiny-body-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(tinyBodyFetchCalled, true);

      let defaultMethod = null;
      globalThis.fetch = async (url, options) => {
        defaultMethod = options.method;
        return new Response('{"action":{"variant":"final","text":"default-method"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-default-method' },
        });
      };
      await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://fallback.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example', 'https://fallback.example'],
        }),
        hostRequest: {
          ...httpRequest(),
          hostRequestFingerprint: 'world:host-request:00000000000000a3',
          idempotencyKeyBytes: fromUtf8('http-key-default-method'),
          idempotencyKeyWorldFingerprint: 'world:key:http-default-method',
          requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/decide', body: { prompt: 'hi' } })),
        },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'default-method-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(defaultMethod, 'POST');

      let shadowFetchCalled = false;
      globalThis.fetch = async () => {
        shadowFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      const httpShadow = await runCapabilityMode({
        mode: 'shadow',
        driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
        hostRequest: httpRequest(),
        context: { allowShadowNetwork: true },
        recordedResolution: null,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(httpShadow.shadow.liveInvoked, false);
      assert.equal(shadowFetchCalled, false);

      const envelopeDriver = new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        maximumResponseBytes: 4,
      });
      assert.equal(envelopeDriver.manifest().maximumResponseBytes > 4, true);
      globalThis.fetch = async () => new Response('1234', { status: 200 });
      const envelopeResult = await envelopeDriver.resolve({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
          maximumResponseBytes: envelopeDriver.manifest().maximumResponseBytes,
        },
      }, httpRequest());
      assert.equal(envelopeResult.resolutionInputBytes.byteLength <= envelopeDriver.manifest().maximumResponseBytes, true);

      globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      }), { status: 200 });
      const limitedDriver = new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        maximumResponseBytes: 10,
      });
      await assert.rejects(
        () => limitedDriver.resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, httpRequest()),
        { code: 'ERR_HTTP_RESPONSE_TOO_LARGE' },
      );

      let directFetchCalled = false;
      globalThis.fetch = async () => {
        directFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"ok"}}', { status: 200 });
      };
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, { ...httpRequest(), hostRequestFingerprint: undefined }),
        { code: 'ERR_HOST_REQUEST_FINGERPRINT_REQUIRED' },
      );
      assert.equal(directFetchCalled, false);
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, { ...httpRequest(), idempotencyKeyWorldFingerprint: undefined }),
        { code: 'ERR_HTTP_IDEMPOTENCY_KEY_REQUIRED' },
      );
      assert.equal(directFetchCalled, false);
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({}, httpRequest()),
        { code: 'ERR_CAPABILITY_LIVE_DENIED' },
      );
      assert.equal(directFetchCalled, false);
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true },
        }, httpRequest()),
        { code: 'ERR_CAPABILITY_ORIGIN_ALLOWLIST_REQUIRED' },
      );
      assert.equal(directFetchCalled, false);

      let blockedFetchCalled = false;
      globalThis.fetch = async () => {
        blockedFetchCalled = true;
        return new Response('{}', { status: 200 });
      };
      const blockedDriver = new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://blocked.example/decide' });
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: blockedDriver,
          hostRequest: httpRequest(),
          journalOptions: {
            store: new MemoryStore(),
            runId: 'policy-run',
            branchId: 'main',
            parentTurnClosureFingerprint: 'world:turn-closure:parent',
          },
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }),
        { code: 'ERR_CAPABILITY_ORIGIN_DENIED' },
      );
      assert.equal(blockedFetchCalled, false);

      let approvalFetchCalled = false;
      globalThis.fetch = async () => {
        approvalFetchCalled = true;
        return new Response('{}', { status: 200 });
      };
      const denied = await runCapabilityMode({
        mode: 'approval',
        driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
        hostRequest: httpRequest(),
        approval: () => ({ approved: false }),
      });
      assert.equal(denied.approved, false);
      assert.equal(approvalFetchCalled, false);
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'approval',
          driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
          hostRequest: httpRequest(),
          approval: () => ({ approved: true }),
        }),
        { code: 'ERR_CAPABILITY_LIVE_DENIED' },
      );
      assert.equal(approvalFetchCalled, false);

      globalThis.fetch = async () => new Response('{"status":"ok"}', {
        status: 200,
        headers: { 'x-request-id': 'request-approved' },
      });
      const approvedNetwork = await runCapabilityMode({
        mode: 'approval',
        driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
        hostRequest: httpRequest(),
        journalOptions: {
          store: new MemoryStore(),
          runId: 'approval-network-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          requireApprovalForNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
        approval: () => ({ approved: true }),
      });
      assert.equal(decodeResolutionInputBytes(approvedNetwork.resolutionInputBytes).status, 0);
      assert.equal(approvedNetwork.submittedToWorld, false);

      let promptedHeader = null;
      const promptProvider = new PromptSecretProvider({
        prompt: async () => 'Bearer prompted-token',
      });
      assert.equal(promptProvider.has('API_TOKEN'), true);
      globalThis.fetch = async (url, options) => {
        promptedHeader = options.headers.Authorization;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        secretHeaders: { Authorization: 'API_TOKEN' },
        secretProvider: promptProvider,
      }).resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, httpRequest());
      assert.equal(promptedHeader, 'Bearer prompted-token');
    } finally {
      globalThis.fetch = originalFetch;
    }

    const approval = new HumanApprovalCapabilityDriver({ mode: 'noninteractive-allow' });
    assert.deepEqual(approval.manifest().supportedResponseStatuses, ['ok', 'rejected']);
    assert.deepEqual(new HumanApprovalPackCapabilityDriver({ mode: 'noninteractive-allow' }).manifest().supportedResponseStatuses, ['ok', 'rejected']);
    assert.equal(approval.preflight({}, httpRequest()).accepted, false);
    const proposedApproval = approval.dryRun({}, {
      ...approvalRequest(),
      requestBytes: fromUtf8(stableJson({ action: 'approve-file-write', password: 'fixture-password', apiKey: 'fixture-key' })),
    });
    assert.equal(proposedApproval.proposedAction.approval.password, '[redacted]');
    assert.equal(proposedApproval.proposedAction.approval.apiKey, '[redacted]');
    let promptedProposal = null;
    const interactiveApproval = new HumanApprovalCapabilityDriver({
      mode: 'interactive-terminal',
      prompt: async ({ proposed }) => {
        promptedProposal = proposed;
        return true;
      },
    });
    let directPromptCalled = false;
    const directDeniedApproval = new HumanApprovalCapabilityDriver({
      mode: 'interactive-terminal',
      prompt: async () => {
        directPromptCalled = true;
        return true;
      },
    });
    await assert.rejects(
      () => directDeniedApproval.resolve({}, approvalRequest()),
      { code: 'ERR_CAPABILITY_LIVE_DENIED' },
    );
    assert.equal(directPromptCalled, false);
    await interactiveApproval.resolve({
      policy: { allowLiveEffects: true, allowHumanEffects: true },
    }, {
      ...approvalRequest(),
      requestBytes: fromUtf8(stableJson({ action: 'approve-file-write', password: 'fixture-password', apiKey: 'fixture-key' })),
    });
    assert.equal(promptedProposal.password, '[redacted]');
    assert.equal(promptedProposal.apiKey, '[redacted]');
    assert.equal(JSON.stringify(promptedProposal).includes('fixture-password'), false);
    const operatorRecovery = await defineCapabilityDriver(approval).recover({}, {});
    assert.equal(operatorRecovery.operatorInterventionRequired, true);
    const approved = await approval.resolve({
      policy: { allowLiveEffects: true, allowHumanEffects: true },
    }, approvalRequest());
    assert.equal(decodeResolutionInputBytes(approved.resolutionInputBytes).status, 0);
    assert.equal(approved.diagnostics.decision, 'approved');
  });

  it('honors driver preflight before live and approved live resolution', async () => {
    const liveDriver = preflightBlockedDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'live',
        driver: liveDriver,
        hostRequest: httpRequest(),
        journalOptions: {
          store: new MemoryStore(),
          runId: 'preflight-live-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_PREFLIGHT_BLOCKED' },
    );
    assert.equal(liveDriver.resolveCalled, false);

    const approvalDriver = preflightBlockedDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'approval',
        driver: approvalDriver,
        hostRequest: httpRequest(),
        approval: () => ({ approved: true }),
        journalOptions: {
          store: new MemoryStore(),
          runId: 'preflight-approval-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_PREFLIGHT_BLOCKED' },
    );
    assert.equal(approvalDriver.resolveCalled, false);
  });

  it('enforces live mode pack and raw network policy before resolve', async () => {
    const packFingerprint = 'sha256:'.concat('2'.repeat(64));
    const deniedPackDriver = policyProbeDriver({ packFingerprint });
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'live',
        driver: deniedPackDriver,
        hostRequest: httpRequest(),
        journalOptions: {
          store: new MemoryStore(),
          runId: 'denied-pack-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          deniedCapabilityPacks: [packFingerprint],
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_PACK_DENIED' },
    );
    assert.equal(deniedPackDriver.resolveCalled, false);

    const deniedOriginDriver = policyProbeDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'live',
        driver: deniedOriginDriver,
        hostRequest: httpRequest(),
        journalOptions: {
          store: new MemoryStore(),
          runId: 'denied-origin-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://denied.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_ORIGIN_DENIED' },
    );
    assert.equal(deniedOriginDriver.resolveCalled, false);

    const unknownNetworkTargetDriver = policyProbeDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'live',
        driver: unknownNetworkTargetDriver,
        hostRequest: { ...httpRequest(), requestBytes: fromUtf8(stableJson({ body: { prompt: 'hi' } })) },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'unknown-network-target-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_NETWORK_TARGET_REQUIRED' },
    );
    assert.equal(unknownNetworkTargetDriver.resolveCalled, false);

    const defaultDeniedShadowDriver = policyProbeDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'shadow',
        driver: defaultDeniedShadowDriver,
        hostRequest: httpRequest(),
        recordedResolution: null,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_SHADOW_LIVE_EFFECT_DENIED' },
    );
    assert.equal(defaultDeniedShadowDriver.shadowCalled, false);

    const deniedShadowDriver = policyProbeDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'shadow',
        driver: deniedShadowDriver,
        hostRequest: httpRequest(),
        context: { allowShadowNetwork: true },
        recordedResolution: null,
      }),
      { code: 'ERR_CAPABILITY_LIVE_DENIED' },
    );
    assert.equal(deniedShadowDriver.shadowCalled, false);

    const allowedShadowDriver = policyProbeDriver();
    const shadow = await runCapabilityMode({
      mode: 'shadow',
      driver: allowedShadowDriver,
      hostRequest: httpRequest(),
      context: { allowShadowNetwork: true },
      recordedResolution: null,
      policy: {
        allowLiveEffects: true,
        allowNetworkEffects: true,
        allowedOrigins: ['https://allowed.example'],
        allowedMethods: ['POST'],
      },
    });
    assert.equal(allowedShadowDriver.shadowCalled, true);
    assert.equal(shadow.shadow.liveInvoked, true);

    const defaultDeniedModelShadowDriver = modelShadowProbeDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'shadow',
        driver: defaultDeniedModelShadowDriver,
        hostRequest: genericHttpModelRequest('goal=shadow-model', 'model-shadow-default-key'),
        recordedResolution: null,
        policy: { allowLiveEffects: true, maximumLiveModelCalls: 1 },
      }),
      { code: 'ERR_CAPABILITY_SHADOW_LIVE_EFFECT_DENIED' },
    );
    assert.equal(defaultDeniedModelShadowDriver.shadowCalled, false);

    const budgetDeniedModelShadowDriver = modelShadowProbeDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'shadow',
        driver: budgetDeniedModelShadowDriver,
        hostRequest: genericHttpModelRequest('goal=shadow-model', 'model-shadow-budget-key'),
        context: { allowShadowLiveEffects: true },
        recordedResolution: null,
        policy: { allowLiveEffects: true },
      }),
      { code: 'ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED' },
    );
    assert.equal(budgetDeniedModelShadowDriver.shadowCalled, false);

    const allowedModelShadowDriver = modelShadowProbeDriver();
    const modelShadow = await runCapabilityMode({
      mode: 'shadow',
      driver: allowedModelShadowDriver,
      hostRequest: genericHttpModelRequest('goal=shadow-model', 'model-shadow-allowed-key'),
      context: { allowShadowLiveEffects: true },
      recordedResolution: null,
      policy: { allowLiveEffects: true, maximumLiveModelCalls: 1 },
    });
    assert.equal(allowedModelShadowDriver.shadowCalled, true);
    assert.equal(modelShadow.shadow.liveInvoked, true);
  });

  it('validates model capability output as Boundary Agent.Action', async () => {
    assert.deepEqual(validateAgentAction({ variant: 'final', text: 'ok' }), { variant: 'final', text: 'ok' });
    assert.throws(
      () => validateAgentAction({ variant: 'tool', toolId: 'unknown_tool', payload: '' }),
      { code: 'ERR_AGENT_ACTION_TOOL_UNKNOWN' },
    );
    assert.throws(
      () => validateAgentAction({ variant: 'malformed', payload: 'not an action' }),
      { code: 'ERR_AGENT_ACTION_MALFORMED' },
    );

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response('{"action":{"variant":"tool","toolId":"actuate","payload":""}}', {
        status: 200,
        headers: { 'x-request-id': 'request-2' },
      });
      const driver = new GenericHttpJsonModelDriver({ endpointUrl: 'https://allowed.example/decide' });
      assert.equal(driver.dryRun({}, genericHttpModelRequest('goal=invoke', 'model-dry-key')).wouldInvoke, true);
      assert.throws(() => new GenericHttpJsonModelDriver({
        endpointUrl: 'https://allowed.example/decide?api_key=secret',
      }), { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' });
      const wrongModelRequestPreflight = driver.preflight(
        {
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            maximumLiveModelCalls: 1,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        },
        {
          ...genericHttpModelRequest('goal=invoke', 'model-wrong-actuator-key'),
          actuatorRef: 'model:other',
        },
      );
      assert.equal(wrongModelRequestPreflight.accepted, false);
      assert.equal(wrongModelRequestPreflight.blockers.includes('ERR_ACTUATOR_REF_NOT_SUPPORTED'), true);
      const deniedPreflight = driver.preflight(
        {
          policy: {
            allowLiveEffects: true,
            maximumLiveModelCalls: 1,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        },
        genericHttpModelRequest('goal=invoke', 'model-preflight-key'),
      );
      assert.equal(deniedPreflight.accepted, false);
      assert.equal(deniedPreflight.blockers.includes('ERR_CAPABILITY_NETWORK_DENIED'), true);
      let budgetFetchCalled = false;
      globalThis.fetch = async () => {
        budgetFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"budget bypassed"}}', { status: 200 });
      };
      await assert.rejects(
        () => driver.resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }, genericHttpModelRequest('goal=invoke', 'model-budget-key')),
        { code: 'ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED' },
      );
      assert.equal(budgetFetchCalled, false);
      globalThis.fetch = async () => new Response('{"action":{"variant":"tool","toolId":"actuate","payload":""}}', {
        status: 200,
        headers: { 'x-request-id': 'request-2' },
      });
      const result = await driver.resolve({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }, genericHttpModelRequest('goal=invoke', 'model-http-key'));
      const semanticResolution = decodeResolutionInputBytes(result.resolutionInputBytes);
      const semanticHostClaim = JSON.parse(new TextDecoder().decode(semanticResolution.hostClaimBytes));
      const semanticMetadata = JSON.parse(new TextDecoder().decode(semanticResolution.metadata));
      assert.deepEqual(
        decodeAgentActionFromResolutionInput(result.resolutionInputBytes),
        { variant: 'tool', toolId: 'actuate', payload: '' },
      );
      assert.deepEqual(result.hostClaimBytes, semanticResolution.hostClaimBytes);
      assert.equal(semanticHostClaim.worldAuthoredEvidence, false);
      assert.equal(semanticHostClaim.value.driver, 'generic-http-json-model');
      assert.equal(semanticHostClaim.value.transportDriver, 'generic-http-json');
      assert.equal(semanticMetadata.driver, 'generic-http-json-model');
      assert.equal(semanticMetadata.transportDriver, 'generic-http-json');
      assert.equal(semanticMetadata.outputSchema, 'boundary.Agent.Action.v0');

      globalThis.fetch = async () => new Response('{"action":{"variant":"final","text":"live ok"}}', {
        status: 200,
        headers: { 'x-request-id': 'request-live-model' },
      });
      const liveModel = await runCapabilityMode({
        mode: 'live',
        driver,
        hostRequest: genericHttpModelRequest('goal=invoke', 'model-live-key'),
        journalOptions: {
          store: new MemoryStore(),
          runId: 'model-live-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.deepEqual(
        decodeAgentActionFromResolutionInput(liveModel.resolutionInputBytes),
        { variant: 'final', text: 'live ok' },
      );

      globalThis.fetch = async () => new Response('{"action":{"variant":"tool","toolId":"unknown_tool","payload":""}}', { status: 200 });
      await assert.rejects(
        () => driver.resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            maximumLiveModelCalls: 1,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }, genericHttpModelRequest('goal=invoke', 'model-http-key-unknown')),
        { code: 'ERR_AGENT_ACTION_TOOL_UNKNOWN' },
      );

      let malformedPromptFetchCalled = false;
      globalThis.fetch = async () => {
        malformedPromptFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"ok"}}', { status: 200 });
      };
      await assert.rejects(
        () => driver.resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, { ...genericHttpModelRequest('goal=invoke', 'model-http-key-bad-prompt'), requestBytes: fromUtf8(stableJson({ schema: 'wrong', observation: 'goal=invoke' })) }),
        { code: 'ERR_AGENT_DECISION_PROMPT_SCHEMA' },
      );
      assert.equal(malformedPromptFetchCalled, false);

      globalThis.fetch = async () => new Response('transport failed', { status: 500 });
      const failed = await driver.resolve({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }, genericHttpModelRequest('goal=invoke', 'model-http-key-failed'));
      const failedResolution = decodeResolutionInputBytes(failed.resolutionInputBytes);
      const failedMetadata = JSON.parse(new TextDecoder().decode(failedResolution.metadata));
      assert.equal(failedResolution.status, 2);
      assert.equal(failedResolution.responseValueImageBytes.byteLength, 0);
      assert.equal(failedMetadata.driver, 'generic-http-json-model');
      assert.equal(failedMetadata.status, 'failed');
      assert.equal(failedMetadata.transportStatus, 'http_error');

      let failedLiveFetchCount = 0;
      globalThis.fetch = async () => {
        failedLiveFetchCount += 1;
        return new Response('transport failed', { status: 500 });
      };
      const failedLive = await runCapabilityMode({
        mode: 'live',
        driver,
        hostRequest: { ...genericHttpModelRequest('goal=invoke', 'model-live-failed-key'), responseSchema: { status: 'failed' } },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'model-live-failed-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(decodeResolutionInputBytes(failedLive.resolutionInputBytes).status, 2);
      assert.equal(failedLiveFetchCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits operational-only observability JSONL without secrets', () => {
    const stream = new HostEventStream();
    const event = stream.emit(HostEventType.capabilityPackLoaded, {
      driverId: 'fixture',
      apiKey: 'secret',
      type: HostEventType.runFailed,
      at: 'caller-clock',
      worldAuthoredEvidence: true,
    });
    assert.equal(event.type, HostEventType.capabilityPackLoaded);
    assert.equal(event.at === 'caller-clock', false);
    assert.equal(event.worldAuthoredEvidence, false);
    stream.emit(HostEventType.runCompleted, { worldFingerprint: 'world:turn-closure:1' });
    const jsonl = stream.toJsonl();
    assert.equal(jsonl.includes('secret'), false);
    assert.equal(stream.summary().worldAuthoredEvidence, false);
    assert.equal(stream.summary().counts.capability_pack_loaded, 1);
  });
});

function preflightBlockedDriver() {
  let resolveCalled = false;
  return {
    get resolveCalled() {
      return resolveCalled;
    },
    manifest() {
      return {
        driverId: 'preflight-blocked-http',
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024,
        maximumResponseBytes: 1024,
        recoveryClass: EffectRecoveryClass.idempotent,
        concurrencyLimit: 1,
        authorityLabels: ['network:http'],
      };
    },
    preflight() {
      return { accepted: false, blockers: ['driver-specific-blocker'] };
    },
    dryRun() {
      return { wouldInvoke: true, proposedAction: { driver: 'preflight-blocked-http' } };
    },
    shadow() {
      return { liveInvoked: false, schemaAccepted: false };
    },
    async resolve() {
      resolveCalled = true;
      const error = new Error('preflight bypassed');
      error.code = 'ERR_PREFLIGHT_BYPASS_EFFECT';
      throw error;
    },
  };
}

function deterministicLiveEffectDriver(onResolve, { authorityLabels = ['network:http'], driverId = 'deterministic-live-effect' } = {}) {
  return {
    manifest() {
      return {
        driverId,
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024,
        maximumResponseBytes: 1024,
        recoveryClass: EffectRecoveryClass.idempotent,
        concurrencyLimit: 1,
        authorityLabels,
        diagnostics: { deterministic: true },
      };
    },
    preflight() {
      return { accepted: true };
    },
    dryRun() {
      return { wouldInvoke: true, proposedAction: { driver: 'deterministic-live-effect' } };
    },
    shadow() {
      return { liveInvoked: false, schemaAccepted: false };
    },
    async resolve() {
      onResolve();
      const error = new Error('fixture live effect should not resolve');
      error.code = 'ERR_FIXTURE_LIVE_EFFECT_RESOLVED';
      throw error;
    },
  };
}

function deterministicModelLiveEffectDriver(onResolve) {
  return {
    manifest() {
      return {
        driverId: 'fixture-agent-model',
        supportedActuatorRefs: ['model:decision'],
        supportedDescriptorFingerprints: ['descriptor:agent-decision-prompt'],
        supportedActuationClasses: ['model'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024 * 1024,
        maximumResponseBytes: 1024 * 1024,
        recoveryClass: EffectRecoveryClass.idempotent,
        concurrencyLimit: 1,
        authorityLabels: ['model:http-json'],
        diagnostics: { deterministic: true },
      };
    },
    preflight() {
      return { accepted: true };
    },
    dryRun() {
      return { wouldInvoke: true, proposedAction: { driver: 'deterministic-model-live-effect' } };
    },
    shadow() {
      return { liveInvoked: true, schemaAccepted: false };
    },
    async resolve() {
      onResolve();
      const error = new Error('fixture live model effect should not resolve');
      error.code = 'ERR_FIXTURE_MODEL_LIVE_EFFECT_RESOLVED';
      throw error;
    },
  };
}

function wrongTargetFixtureDriver() {
  const delegate = new FixtureAgentModelCapabilityDriver();
  return {
    manifest: () => delegate.manifest(),
    preflight: () => ({ accepted: true }),
    dryRun: delegate.dryRun.bind(delegate),
    shadow: delegate.shadow.bind(delegate),
    async resolve() {
      return {
        resolutionInputBytes: encodeResolutionInputBytes({
          targetHostRequestFingerprint: 0x9999n,
          status: 0,
          responseValueImageBytes: fromUtf8('wrong-target'),
          hostClaimBytes: fromUtf8('{}'),
          attemptNumber: 1,
        }),
      };
    },
  };
}

function hostFieldOverrideFixtureDriver() {
  const delegate = new FixtureAgentModelCapabilityDriver();
  return {
    manifest: () => delegate.manifest(),
    preflight: () => ({ accepted: true }),
    dryRun: delegate.dryRun.bind(delegate),
    shadow: delegate.shadow.bind(delegate),
    async resolve(context, hostRequest) {
      return {
        ...await delegate.resolve(context, hostRequest),
        mode: 'driver-mode',
        submittedToWorld: false,
        approved: false,
        proposed: { wouldInvoke: true },
      };
    },
  };
}

function bestEffortModelDriver() {
  let resolveCalled = false;
  return {
    get resolveCalled() {
      return resolveCalled;
    },
    manifest() {
      return {
        driverId: 'best-effort-model',
        supportedActuatorRefs: ['fixture:agent-model'],
        supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
        supportedActuationClasses: ['model'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024,
        maximumResponseBytes: 1024,
        recoveryClass: EffectRecoveryClass.bestEffort,
        concurrencyLimit: 1,
        authorityLabels: ['model:fixture-agent'],
      };
    },
    preflight() {
      return { accepted: true };
    },
    dryRun() {
      return { wouldInvoke: false, proposedAction: { driver: 'best-effort-model' } };
    },
    shadow() {
      return { liveInvoked: false, schemaAccepted: false };
    },
    async resolve() {
      resolveCalled = true;
      const error = new Error('parked best-effort effect should not resolve');
      error.code = 'ERR_PARKED_BEST_EFFORT_RESOLVED';
      throw error;
    },
  };
}

function policyProbeDriver({ packFingerprint } = {}) {
  let resolveCalled = false;
  let shadowCalled = false;
  return {
    get resolveCalled() {
      return resolveCalled;
    },
    get shadowCalled() {
      return shadowCalled;
    },
    manifest() {
      return {
        driverId: 'policy-probe-http',
        packFingerprint,
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024,
        maximumResponseBytes: 1024,
        recoveryClass: EffectRecoveryClass.idempotent,
        concurrencyLimit: 1,
        authorityLabels: ['network:http'],
      };
    },
    preflight() {
      return { accepted: true };
    },
    dryRun() {
      return { wouldInvoke: true, proposedAction: { driver: 'policy-probe-http' } };
    },
    shadow() {
      shadowCalled = true;
      return { liveInvoked: true, schemaAccepted: false };
    },
    async resolve() {
      resolveCalled = true;
      const error = new Error('policy bypassed');
      error.code = 'ERR_POLICY_BYPASS_EFFECT';
      throw error;
    },
  };
}

async function runBunProcess(command, options = {}) {
  const subprocess = Bun.spawn(command, { ...options, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function modelShadowProbeDriver() {
  let shadowCalled = false;
  return {
    get shadowCalled() {
      return shadowCalled;
    },
    manifest() {
      return {
        driverId: 'policy-probe-model',
        supportedActuatorRefs: ['model:decision'],
        supportedDescriptorFingerprints: ['descriptor:agent-decision-prompt'],
        supportedActuationClasses: ['model'],
        supportedResponseStatuses: ['ok', 'failed', 'deferred'],
        maximumRequestBytes: 1024 * 1024,
        maximumResponseBytes: 1024 * 1024,
        recoveryClass: EffectRecoveryClass.idempotent,
        concurrencyLimit: 1,
        authorityLabels: ['model:openai'],
      };
    },
    preflight() {
      return { accepted: true };
    },
    dryRun() {
      return { wouldInvoke: true, proposedAction: { driver: 'policy-probe-model' } };
    },
    shadow() {
      shadowCalled = true;
      return { liveInvoked: true, schemaAccepted: false };
    },
    async resolve() {
      const error = new Error('model probe should not resolve');
      error.code = 'ERR_MODEL_PROBE_RESOLVED';
      throw error;
    },
  };
}

function fixtureCapabilityManifest() {
  return {
    formatVersion: world_host_capability_pack_format_version,
    packageName: 'world-capability-fixture',
    packageVersion: '0.2.0',
    driverId: 'fixture-agent-model',
    driverAbiVersion: world_host_capability_driver_abi_version,
    supportedWorldProtocolVersion: 'v0.1.0',
    supportedApplianceAbiVersion: 'v4',
    supportedTurnClosureVersion: 'v1',
    supportedActuatorRefs: ['fixture:agent-model'],
    supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
    supportedActuationClasses: ['model'],
    supportedResponseStatuses: ['ok', 'final'],
    recoveryClass: EffectRecoveryClass.pure,
    canDryRun: true,
    canShadow: true,
    canReplay: true,
    canRecover: true,
    propagatesWorldIdempotencyKey: true,
    requiresApproval: false,
    requiredSecrets: [],
    authorityLabels: ['model:fixture-agent'],
    policyRequirements: {},
    maximumRequestBytes: 1024,
    maximumResponseBytes: 1024,
    conformanceCorpusFingerprint: null,
    metadataBytes: '',
    adapter: { kind: 'in_process', module: 'adapter.mjs', exportName: 'driver' },
    checksums: [],
    docs: ['README.md'],
  };
}

function modelRequest(observation, key) {
  return {
    hostRequestFingerprint: 'world:host-request:00000000000000a1',
    idempotencyKeyBytes: fromUtf8(key),
    idempotencyKeyWorldFingerprint: `world:key:${key}`,
    actuatorRef: 'fixture:agent-model',
    descriptorFingerprint: 'descriptor:fixture-agent-model',
    actuationClass: 'model',
    responseSchema: { status: 'ok' },
    requestBytes: fromUtf8(stableJson({ schema: 'boundary.Agent.DecisionPrompt.v0', observation })),
  };
}

function genericHttpModelRequest(observation, key) {
  return {
    ...modelRequest(observation, key),
    actuatorRef: 'model:decision',
    descriptorFingerprint: 'descriptor:agent-decision-prompt',
  };
}

function httpRequest() {
  return {
    hostRequestFingerprint: 'world:host-request:00000000000000a2',
    idempotencyKeyBytes: fromUtf8('http-key'),
    idempotencyKeyWorldFingerprint: 'world:key:http',
    actuatorRef: 'http:json',
    descriptorFingerprint: 'descriptor:http-json',
    actuationClass: 'http',
    responseSchema: { status: 'ok' },
    requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/decide', method: 'POST', body: { prompt: 'hi' } })),
  };
}

function approvalRequest() {
  return {
    hostRequestFingerprint: 'world:host-request:00000000000000a3',
    idempotencyKeyBytes: fromUtf8('approval-key'),
    idempotencyKeyWorldFingerprint: 'world:key:approval',
    actuatorRef: 'human:approval',
    descriptorFingerprint: 'descriptor:human-approval',
    actuationClass: 'human',
    responseSchema: { status: 'ok' },
    requestBytes: fromUtf8(stableJson({ action: 'approve-file-write', secret: '[redacted]' })),
  };
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}
