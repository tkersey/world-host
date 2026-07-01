import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { EffectRecoveryClass } from '../src/core/actuator.mjs';
import {
  assertCapabilityManifest,
  assertCapabilityConformanceReceipt,
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
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['sidecar.mjs'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
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
      () => assertCapabilityManifest({ ...manifest, metadataBytes: ['sk', 'test-secret-value'].join('-') }),
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
      () => assertCapabilityPolicyAllows({ manifest, hostRequest: httpRequest(), policy: { allowLiveEffects: true }, mode: 'live' }),
      { code: 'ERR_CAPABILITY_NETWORK_DENIED' },
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
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'fixture',
        driver,
        hostRequest: { ...request, actuatorRef: 'http:json' },
      }),
      { code: 'ERR_CAPABILITY_PREFLIGHT_BLOCKED' },
    );
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

      let configuredEndpointFetchCalled = false;
      globalThis.fetch = async () => {
        configuredEndpointFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"configured"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-configured' },
        });
      };
      const configuredEndpointLive = await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
        hostRequest: { ...httpRequest(), requestBytes: fromUtf8(stableJson({ body: { prompt: 'hi' } })) },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'configured-endpoint-run',
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
      assert.equal(configuredEndpointFetchCalled, true);
      assert.equal(decodeResolutionInputBytes(configuredEndpointLive.resolutionInputBytes).status, 0);

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
        (error) => {
          assert.equal(error.code, 'ERR_CAPABILITY_PREFLIGHT_BLOCKED');
          assert.deepEqual(error.details.blockers, ['ERR_CAPABILITY_ORIGIN_DENIED']);
          return true;
        },
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
    assert.equal(approval.preflight({}, httpRequest()).accepted, false);
    const proposedApproval = approval.dryRun({}, {
      ...approvalRequest(),
      requestBytes: fromUtf8(stableJson({ action: 'approve-file-write', password: 'fixture-password', apiKey: 'fixture-key' })),
    });
    assert.equal(proposedApproval.proposedAction.approval.password, '[redacted]');
    assert.equal(proposedApproval.proposedAction.approval.apiKey, '[redacted]');
    const approved = await approval.resolve({}, approvalRequest());
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
      const deniedPreflight = driver.preflight(
        { policy: { allowLiveEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] } },
        modelRequest('goal=invoke', 'model-preflight-key'),
      );
      assert.equal(deniedPreflight.accepted, false);
      assert.equal(deniedPreflight.blockers.includes('ERR_CAPABILITY_NETWORK_DENIED'), true);
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

      globalThis.fetch = async () => new Response('{"action":{"variant":"final","text":"live ok"}}', {
        status: 200,
        headers: { 'x-request-id': 'request-live-model' },
      });
      const liveModel = await runCapabilityMode({
        mode: 'live',
        driver,
        hostRequest: {
          ...modelRequest('goal=invoke', 'model-live-key'),
          actuatorRef: 'model:decision',
          descriptorFingerprint: 'descriptor:agent-decision-prompt',
        },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'model-live-run',
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
      assert.deepEqual(
        decodeAgentActionFromResolutionInput(liveModel.resolutionInputBytes),
        { variant: 'final', text: 'live ok' },
      );

      globalThis.fetch = async () => new Response('{"action":{"variant":"tool","toolId":"unknown_tool","payload":""}}', { status: 200 });
      await assert.rejects(
        () => driver.resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, modelRequest('goal=invoke', 'model-http-key-unknown')),
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
        }, { ...modelRequest('goal=invoke', 'model-http-key-bad-prompt'), requestBytes: fromUtf8(stableJson({ schema: 'wrong', observation: 'goal=invoke' })) }),
        { code: 'ERR_AGENT_DECISION_PROMPT_SCHEMA' },
      );
      assert.equal(malformedPromptFetchCalled, false);

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
