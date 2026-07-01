import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { EffectRecoveryClass } from '../src/core/actuator.mjs';
import {
  assertCapabilityManifest,
  assertCapabilityPackChecksums,
  capabilityPackFingerprint,
  validateCapabilityPackManifest,
  world_host_capability_driver_abi_version,
  world_host_capability_pack_format_version,
} from '../src/core/capability_pack.mjs';
import { assertCapabilityResolutionBoundary } from '../src/core/capability_driver.mjs';
import { assertCapabilityPolicyAllows, createCapabilityPolicy, redactCapabilityDiagnostics } from '../src/core/capability_policy.mjs';
import { runCapabilityMode } from '../src/core/capability_modes.mjs';
import { EnvSecretProvider, assertNoSecretValuePersisted, assertRequiredSecretsAvailable, redactSecrets } from '../src/core/secrets.mjs';
import { FileSecretProvider } from '../src/bun/secret_providers.mjs';
import { HostEventStream, HostEventType } from '../src/core/observability.mjs';
import {
  FixtureAgentModelCapabilityDriver,
  GenericHttpJsonModelDriver,
  decodeAgentActionFromResolutionInput,
  validateAgentAction,
} from '../src/drivers/model_capability_driver.mjs';
import { GenericHttpJsonCapabilityDriver } from '../src/drivers/generic_http_json_capability_driver.mjs';
import { HumanApprovalCapabilityDriver } from '../src/drivers/human_approval_capability_driver.mjs';
import { fromUtf8, stableJson, toHex } from '../src/core/store.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';
import { decodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';

describe('Capability Plane v0.2 core contracts', () => {
  it('validates CapabilityPack semantic identity, checksums, and authority boundaries', async () => {
    const manifest = fixtureCapabilityManifest();
    const packFingerprint = await capabilityPackFingerprint(manifest);
    assert.match(packFingerprint, /^sha256:[0-9a-f]{64}$/);
    const artifact = fromUtf8('adapter bytes');
    const readme = fromUtf8('readme bytes');
    const withFingerprint = {
      ...manifest,
      packFingerprint,
      checksums: [
        { path: 'adapter.mjs', checksum: `sha256:${await sha256Hex(artifact)}` },
        { path: 'README.md', checksum: `sha256:${await sha256Hex(readme)}` },
      ],
    };
    assert.equal((await validateCapabilityPackManifest(withFingerprint, { verifyFingerprint: true })).packFingerprint, packFingerprint);
    assert.equal(await assertCapabilityPackChecksums(withFingerprint, { 'adapter.mjs': artifact, 'README.md': readme }), true);
    await assert.rejects(
      () => assertCapabilityPackChecksums({ ...withFingerprint, checksums: withFingerprint.checksums.slice(0, 1) }, { 'adapter.mjs': artifact }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
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
      () => assertCapabilityManifest({ ...manifest, metadataBytes: ['sk', 'test-secret-value'].join('-') }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
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
      () => assertCapabilityPolicyAllows({ manifest, hostRequest: httpRequest(), policy: { allowLiveEffects: true }, mode: 'live' }),
      { code: 'ERR_CAPABILITY_NETWORK_DENIED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest,
        hostRequest: httpRequest(),
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowBestEffort: true },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_APPROVAL_REQUIRED' },
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
  });

  it('keeps secrets receiver-local and redacted', async () => {
    const env = new EnvSecretProvider({ API_TOKEN: 'fixture-token-value' });
    assert.equal(env.has('API_TOKEN'), true);
    assert.equal(env.describe('API_TOKEN').redacted, true);
    assert.equal(env.accessReport('API_TOKEN').valueRedacted, true);
    assert.equal(redactSecrets({ apiKey: 'fixture-token-value' }).apiKey, '[redacted]');
    assert.equal(redactCapabilityDiagnostics({ diagnostics: { Authorization: 'Bearer fixture-token-value' } }).diagnostics.Authorization, '[redacted]');
    assert.throws(() => assertNoSecretValuePersisted({ value: ['sk', 'local-secret'].join('-') }), { code: 'ERR_SECRET_PERSISTED' });

    const root = await mkdtemp(path.join(tmpdir(), 'world-host-secret-'));
    try {
      await writeFile(path.join(root, 'api-token'), 'fixture-file-value\n');
      const fileProvider = new FileSecretProvider({ root, mapping: { API_TOKEN: 'api-token' } });
      assert.equal(fileProvider.has('API_TOKEN'), true);
      assert.equal(fileProvider.has('MISSING'), false);
      assert.equal(await fileProvider.get('API_TOKEN'), 'fixture-file-value');
      assert.equal((await fileProvider.accessReport('API_TOKEN')).valueRedacted, true);
      assert.throws(() => assertRequiredSecretsAvailable(fileProvider, ['MISSING']), { code: 'ERR_SECRET_MISSING' });
      await assert.rejects(() => new FileSecretProvider({ root, mapping: { BAD: '../secret' } }).get('BAD'), { code: 'ERR_SECRET_FILE_PATH_INVALID' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs fixture, dry-run, shadow, approval, and live modes without host-authored World evidence', async () => {
    const driver = new FixtureAgentModelCapabilityDriver();
    const request = modelRequest('goal=invoke', 'model-key');
    const fixture = await runCapabilityMode({ mode: 'fixture', driver, hostRequest: request });
    assert.equal(decodeResolutionInputBytes(fixture.resolutionInputBytes).status, 0);
    const dry = await runCapabilityMode({ mode: 'dry-run', driver, hostRequest: request });
    assert.equal(dry.submittedToWorld, false);
    const shadow = await runCapabilityMode({ mode: 'shadow', driver, hostRequest: request, recordedResolution: fromUtf8('recorded') });
    assert.equal(shadow.submittedToWorld, false);

    const approved = await runCapabilityMode({
      mode: 'approval',
      driver,
      hostRequest: request,
      approval: () => ({ approved: true }),
    });
    assert.equal(approved.approved, true);
    assert.equal(approved.proposed.wouldInvoke, false);
    assertCapabilityResolutionBoundary(approved);

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
    assert.equal(decodeResolutionInputBytes(live.resolutionInputBytes).status, 0);
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
      const result = await driver.resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, httpRequest());
      assert.equal(observedHeaders.Authorization, 'Bearer fixture-token-value');
      assert.equal(JSON.stringify(result.diagnostics).includes('secret'), false);
      assert.equal(decodeResolutionInputBytes(result.resolutionInputBytes).status, 0);

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
    } finally {
      globalThis.fetch = originalFetch;
    }

    const approval = new HumanApprovalCapabilityDriver({ mode: 'noninteractive-allow' });
    const approved = await approval.resolve({}, approvalRequest());
    assert.equal(decodeResolutionInputBytes(approved.resolutionInputBytes).status, 0);
    assert.equal(approved.diagnostics.decision, 'approved');
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
      const result = await driver.resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, modelRequest('goal=invoke', 'model-http-key'));
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

      globalThis.fetch = async () => new Response('{"action":{"variant":"tool","toolId":"unknown_tool","payload":""}}', { status: 200 });
      await assert.rejects(
        () => driver.resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, modelRequest('goal=invoke', 'model-http-key-unknown')),
        { code: 'ERR_AGENT_ACTION_TOOL_UNKNOWN' },
      );

      globalThis.fetch = async () => new Response('transport failed', { status: 500 });
      const failed = await driver.resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, modelRequest('goal=invoke', 'model-http-key-failed'));
      const failedResolution = decodeResolutionInputBytes(failed.resolutionInputBytes);
      const failedMetadata = JSON.parse(new TextDecoder().decode(failedResolution.metadata));
      assert.equal(failedResolution.status, 2);
      assert.equal(failedResolution.responseValueImageBytes.byteLength, 0);
      assert.equal(failedMetadata.driver, 'generic-http-json-model');
      assert.equal(failedMetadata.status, 'failed');
      assert.equal(failedMetadata.transportStatus, 'http_error');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits operational-only observability JSONL without secrets', () => {
    const stream = new HostEventStream();
    stream.emit(HostEventType.capabilityPackLoaded, { driverId: 'fixture', apiKey: 'secret' });
    stream.emit(HostEventType.runCompleted, { worldFingerprint: 'world:turn-closure:1' });
    const jsonl = stream.toJsonl();
    assert.equal(jsonl.includes('secret'), false);
    assert.equal(stream.summary().worldAuthoredEvidence, false);
    assert.equal(stream.summary().counts.capability_pack_loaded, 1);
  });
});

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
