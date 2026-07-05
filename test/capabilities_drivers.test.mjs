import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, symlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { EffectRecoveryClass, assertDriverManifest, defineActuatorDriver } from '../src/core/actuator.mjs';
import { createRunPolicy, preflightCapabilities } from '../src/core/capabilities.mjs';
import { EffectJournal, EffectState, journaledHostRequest } from '../src/core/effect_journal.mjs';
import { FixtureModelDriver } from '../src/drivers/fixture_model_driver.mjs';
import { SandboxFileDriver } from '../src/drivers/sandbox_file_driver.mjs';
import { HttpJsonDriver } from '../src/drivers/http_json_driver.mjs';
import { GenericHttpJsonCapabilityDriver } from '../src/drivers/generic_http_json_capability_driver.mjs';
import { GenericHttpJsonModelDriver } from '../src/drivers/model_capability_driver.mjs';
import { agentActionValueImage } from '../src/drivers/fixture_agent_model_driver.mjs';
import { HumanApprovalCapabilityDriver } from '../src/drivers/human_approval_capability_driver.mjs';
import { fromUtf8, makeBlobRef, stableJson } from '../src/core/store.mjs';
import { decodeResolutionInputBytes, encodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';

const FIXTURE_FILE_ROOT = path.resolve('/tmp/world-host-fixture-file-root');

describe('capability preflight and reference drivers', () => {
  it('accepts only exact driver manifest coverage under receiver-local policy', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [{ actuatorRef: 'fixture:model' }], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [new FixtureModelDriver({ responses: ['ok'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });
    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyPendingRequestCovered, true);
  });

  it('checks decoded appliance supervision fingerprints against receiver policy', () => {
    const deniedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      applianceManifest: { supervisionPolicyFingerprint: 0x123n },
      currentHead: { generation: 0 },
      policy: createRunPolicy({ acceptedSupervisionPolicies: [0x456n] }),
    });

    assert.ok(deniedReport.blockers.includes('supervision-policy-rejected'));
    assert.equal(deniedReport.runtimeCompatible, false);
    assert.equal(deniedReport.supervisionPolicyAccepted, false);

    const allowedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      applianceManifest: { supervisionPolicyFingerprint: 0x123n },
      currentHead: { generation: 0 },
      policy: createRunPolicy({ acceptedSupervisionPolicies: 0x123n }),
    });

    assert.deepEqual(allowedReport.blockers, []);
    assert.equal(allowedReport.supervisionPolicyAccepted, true);
  });

  it('rejects sender-style uncovered authority and HTTP origins outside local policy', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://blocked.example/path')],
      drivers: [new HttpJsonDriver({ origins: ['https://allowed.example'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['network:http'], allowedHttpOrigins: ['https://allowed.example'], allowedHttpMethods: ['GET'] }),
    });
    assert.ok(report.blockers.includes('http-origin-denied:https://blocked.example'));
    assert.ok(report.blockers.includes('http-origin-driver-denied:https://blocked.example'));
    assert.equal(report.fileNetworkAuthoritiesAllowed, false);
  });

  it('applies HTTP policy to network-prefixed authority labels during route selection', () => {
    const request = {
      ...fixtureRequest(),
      requestBytes: fromUtf8(stableJson({ prompt: 'hi' })),
    };
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [request],
      drivers: [
        fixtureDriverWithAuthority(['network:openai'], {
          driverId: 'blocked-openai',
          diagnostics: {
            endpointSource: 'config',
            configuredOrigin: 'https://blocked.example',
            origins: ['https://blocked.example'],
            defaultMethod: 'POST',
            methods: ['POST'],
          },
        }),
        fixtureDriverWithAuthority(['network:openai'], {
          driverId: 'allowed-openai',
          diagnostics: {
            endpointSource: 'config',
            configuredOrigin: 'https://allowed.example',
            origins: ['https://allowed.example'],
            defaultMethod: 'POST',
            methods: ['POST'],
          },
        }),
      ],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:openai'],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['POST'],
      }),
    });

    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.selectedPendingRequestRoutes, [{
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture-model',
      driverId: 'allowed-openai',
      driverIndex: 1,
    }]);
  });

  it('uses configured HTTP driver default methods when request URLs omit methods during preflight', () => {
    const request = {
      ...httpRequest('https://allowed.example/path'),
      requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/path', body: { prompt: 'hi' } })),
    };
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [request],
      drivers: [new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://fallback.example/decide',
        allowEndpointFromRequest: true,
        origins: ['https://allowed.example', 'https://fallback.example'],
        methods: ['POST'],
      })],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:http'],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['POST'],
      }),
    });

    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyPendingRequestCovered, true);
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'http:json',
      descriptorFingerprint: 'descriptor:http-json',
      driverId: 'generic-http-json',
    }]);
  });

  it('uses raw HTTP driver configured default methods when request URLs omit methods during preflight', () => {
    const request = {
      ...httpRequest('https://allowed.example/path'),
      requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/path', body: { prompt: 'hi' } })),
    };
    const driver = new HttpJsonDriver({
      origins: ['https://allowed.example'],
      methods: ['POST'],
    });
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [request],
      drivers: [driver],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:http'],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['POST'],
      }),
    });

    assert.equal(driver.manifest().diagnostics.defaultMethod, 'POST');
    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyPendingRequestCovered, true);
  });

  it('checks request-routed HTTP required actuators against declared request origins', () => {
    const request = {
      ...httpRequest('https://allowed.example/path', 'POST'),
      requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/path', body: { prompt: 'hi' } })),
    };
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{ actuatorRef: 'http:json', descriptorFingerprint: 'descriptor:http-json' }],
        requiredHostAuthorityLabels: ['network:http'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [request],
      drivers: [new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://fallback.example/decide',
        allowEndpointFromRequest: true,
        origins: ['https://allowed.example'],
        methods: ['POST'],
      })],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:http'],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['POST'],
      }),
    });

    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyRequiredActuatorCovered, true);
    assert.equal(report.everyPendingRequestCovered, true);
  });

  it('checks configured HTTP required actuators against any receiver-allowed method', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{ actuatorRef: 'http:json', descriptorFingerprint: 'descriptor:http-json' }],
        requiredHostAuthorityLabels: ['network:http'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      drivers: [new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        methods: ['GET', 'POST'],
      })],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:http'],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['POST'],
      }),
    });

    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyRequiredActuatorCovered, true);
  });

  it('uses default HTTP methods for multi-method request URLs during preflight', () => {
    const request = {
      ...httpRequest('https://allowed.example/path'),
      requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/path', body: { prompt: 'hi' } })),
    };
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [request],
      drivers: [new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://fallback.example/decide',
        allowEndpointFromRequest: true,
        origins: ['https://allowed.example', 'https://fallback.example'],
        methods: ['POST', 'PUT'],
      })],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:http'],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['POST'],
      }),
    });

    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyPendingRequestCovered, true);
  });

  it('rejects explicit fallback HTTP methods during preflight', () => {
    const request = {
      ...httpRequest('https://allowed.example/path'),
      requestBytes: fromUtf8(stableJson({ method: 'DELETE', body: { prompt: 'hi' } })),
    };
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [request],
      drivers: [new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/path',
        allowEndpointFromRequest: true,
        origins: ['https://allowed.example'],
        methods: ['POST'],
      })],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:http'],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['POST'],
      }),
    });

    assert.ok(report.blockers.includes('http-method-driver-denied:DELETE'));
    assert.equal(report.coveredRequests.length, 1);
  });

  it('preflights fixed configured HTTP endpoints independently of payload url fields', () => {
    const request = {
      ...httpRequest('https://payload.example/not-target'),
      requestBytes: fromUtf8(stableJson({ url: 'https://payload.example/not-target', body: { prompt: 'hi' } })),
    };
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [request],
      drivers: [new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' })],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:http'],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['POST'],
      }),
    });

    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyPendingRequestCovered, true);
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'http:json',
      descriptorFingerprint: 'descriptor:http-json',
      driverId: 'generic-http-json',
    }]);
  });

  it('derives configured HTTP endpoint origins and singleton methods during preflight', () => {
    const request = {
      ...httpRequest('https://payload.example/not-target'),
      requestBytes: fromUtf8(stableJson({ body: { prompt: 'hi' } })),
    };
    const driver = {
      manifest() {
        return {
          driverId: 'configured-url-only-put',
          supportedActuatorRefs: ['http:json'],
          supportedDescriptorFingerprints: ['descriptor:http-json'],
          supportedActuationClasses: ['http'],
          supportedResponseStatuses: ['ok'],
          maximumRequestBytes: 4096,
          maximumResponseBytes: 4096,
          recoveryClass: EffectRecoveryClass.idempotent,
          concurrencyLimit: 1,
          authorityLabels: ['network:http'],
          diagnostics: {
            endpointSource: 'config',
            configuredEndpointUrl: 'https://allowed.example/put',
            methods: ['PUT'],
          },
        };
      },
    };

    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [request],
      drivers: [driver],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:http'],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['PUT'],
      }),
    });

    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'http:json',
      descriptorFingerprint: 'descriptor:http-json',
      driverId: 'configured-url-only-put',
    }]);
  });

  it('checks configured HTTP endpoint method coverage against explicit payload methods', () => {
    const request = {
      ...httpRequest('https://payload.example/not-target'),
      requestBytes: fromUtf8(stableJson({ method: 'DELETE', body: { prompt: 'hi' } })),
    };
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [request],
      drivers: [new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' })],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:http'],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['POST'],
      }),
    });

    assert.ok(report.blockers.includes('http-method-driver-denied:DELETE'));
    assert.equal(report.fileNetworkAuthoritiesAllowed, false);
  });

  it('requires receiver HTTP origin allowlists for pending HTTP requests', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path')],
      drivers: [new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['network:http'] }),
    });

    assert.ok(report.blockers.includes('http-origin-allowlist-required'));
    assert.equal(report.fileNetworkAuthoritiesAllowed, false);
  });

  it('requires receiver HTTP method allowlists for pending HTTP requests', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path', 'GET')],
      drivers: [new HttpJsonDriver({ origins: ['https://allowed.example'], methods: ['GET'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['network:http'], allowedHttpOrigins: ['https://allowed.example'] }),
    });

    assert.ok(report.blockers.includes('http-method-allowlist-required'));
    assert.equal(report.fileNetworkAuthoritiesAllowed, false);
  });

  it('summarizes receiver HTTP method denials as authority failures', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path', 'DELETE')],
      drivers: [new HttpJsonDriver({ origins: ['https://allowed.example'], methods: ['DELETE'] })],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:http'],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['POST'],
      }),
    });

    assert.ok(report.blockers.includes('http-method-denied:DELETE'));
    assert.equal(report.blockers.includes('http-method-driver-denied:DELETE'), false);
    assert.equal(report.fileNetworkAuthoritiesAllowed, false);
  });

  it('routes preflight through the first policy-allowed matching driver', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [{ actuatorRef: 'fixture:model' }], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [policyDeniedFixtureDriver(), new FixtureModelDriver({ responses: ['ok'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });
    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyRequiredActuatorCovered, true);
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture-model',
      driverId: 'fixture-model',
    }]);
  });

  it('preserves capability pack fingerprints during preflight policy checks', () => {
    const packFingerprint = 'sha256:'.concat('f'.repeat(64));
    const driver = new GenericHttpJsonCapabilityDriver({
      endpointUrl: 'https://allowed.example/path',
      packFingerprint,
    });
    const allowedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path', 'POST')],
      drivers: [driver],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:http'],
        allowedCapabilityPacks: [packFingerprint],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['POST'],
      }),
    });

    assert.deepEqual(allowedReport.blockers, []);
    assert.equal(allowedReport.everyPendingRequestCovered, true);

    const stringAllowedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path', 'POST')],
      drivers: [driver],
      policy: createRunPolicy({
        allowedAuthorityLabels: 'network:http',
        allowedCapabilityPacks: packFingerprint,
        allowedHttpOrigins: 'https://allowed.example',
        allowedHttpMethods: 'POST',
      }),
    });

    assert.deepEqual(stringAllowedReport.blockers, []);
    assert.equal(stringAllowedReport.everyPendingRequestCovered, true);

    const deniedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path', 'POST')],
      drivers: [driver],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:http'],
        deniedCapabilityPacks: [packFingerprint],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['POST'],
      }),
    });

    assert.ok(deniedReport.blockers.includes('ERR_CAPABILITY_PACK_DENIED'));

    const stringDeniedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path', 'POST')],
      drivers: [driver],
      policy: createRunPolicy({
        allowedAuthorityLabels: 'network:http',
        deniedCapabilityPacks: packFingerprint,
        allowedHttpOrigins: 'https://allowed.example',
        allowedHttpMethods: 'POST',
      }),
    });

    assert.ok(stringDeniedReport.blockers.includes('ERR_CAPABILITY_PACK_DENIED'));

    const wrappedDeniedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path', 'POST')],
      drivers: [defineActuatorDriver(driver)],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['network:http'],
        deniedCapabilityPacks: [packFingerprint],
        allowedHttpOrigins: ['https://allowed.example'],
        allowedHttpMethods: ['POST'],
      }),
    });

    assert.ok(wrappedDeniedReport.blockers.includes('ERR_CAPABILITY_PACK_DENIED'));
  });

  it('reports live model budget blockers during receiver preflight', () => {
    const modelRequest = (key) => ({
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      actuationClass: 'model',
      responseSchema: { status: 'ok' },
      idempotencyKeyWorldFingerprint: `key:model-budget:${key}`,
      requestBytes: fromUtf8(stableJson({ schema: 'boundary.Agent.DecisionPrompt.v0', observation: `goal=budget:${key}` })),
    });
    const driver = fixtureDriverWithAuthority(['model:live'], {
      driverId: 'live-model',
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      actuationClasses: ['model'],
      recoveryClass: EffectRecoveryClass.idempotent,
    });
    const rerunnableDriver = fixtureDriverWithAuthority(['model:live'], {
      driverId: 'live-model-rerunnable',
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      actuationClasses: ['model'],
    });
    const zeroBudgetReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [modelRequest('zero')],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 0 }),
    });
    const overBudgetReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [modelRequest('first'), modelRequest('second')],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 1 }),
    });
    const wrappedModelRequest = (key) => ({
      ...modelRequest(key),
      actuatorRef: 'world:model-bridge',
      descriptorFingerprint: 'descriptor:world-model-bridge',
      actuationClass: 'world:actuation-class:1',
    });
    const wrappedDriver = fixtureDriverWithAuthority(['model:http-json'], {
      driverId: 'wrapped-live-model',
      actuatorRef: 'world:model-bridge',
      descriptorFingerprint: 'descriptor:world-model-bridge',
      actuationClasses: ['world:actuation-class:1'],
    });
    const wrappedOverBudgetReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [wrappedModelRequest('first'), wrappedModelRequest('second')],
      drivers: [wrappedDriver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:http-json'], maximumLiveModelCalls: 1 }),
    });
    const cachedModelRequest = {
      ...modelRequest('cached'),
      idempotencyKeyBytes: fromUtf8('model-budget-cached-key'),
      hostRequestFingerprint: 'world:host-request:0000000000000c01',
    };
    const freshModelRequest = {
      ...modelRequest('fresh'),
      idempotencyKeyBytes: fromUtf8('model-budget-fresh-key'),
      hostRequestFingerprint: 'world:host-request:0000000000000c02',
    };
    const cachedModelRequestChecksum = `sha256:${createHash('sha256').update(cachedModelRequest.requestBytes).digest('hex')}`;
    const cachedModelResolutionInputBytes = encodeResolutionInputBytes({
      targetHostRequestFingerprint: 0xc01n,
      status: 0,
      responseValueImageBytes: fromUtf8('cached model response'),
      hostClaimBytes: fromUtf8('host-claim:cached-model-response'),
      attemptNumber: 1,
      metadata: fromUtf8('cached-model-resolution'),
    });
    const cachedModelResolutionInputRef = blobRefForBytes(cachedModelResolutionInputBytes);
    const cachedModelResolutionInputs = new Map([[blobRefKey(cachedModelResolutionInputRef), cachedModelResolutionInputBytes]]);
    const cachedModelEffect = {
      branchId: 'main',
      idempotencyKeyWorldFingerprint: cachedModelRequest.idempotencyKeyWorldFingerprint,
      hostRequestFingerprint: cachedModelRequest.hostRequestFingerprint,
      idempotencyKey: {
        format: 'world-idempotency-key-bytes.hex',
        bytesHex: Buffer.from('model-budget-cached-key').toString('hex'),
      },
      requestBytesRef: blobRefForBytes(cachedModelRequest.requestBytes),
      requestBytesChecksum: cachedModelRequestChecksum,
      state: EffectState.resolved,
      driverRecoveryClass: EffectRecoveryClass.idempotent,
      resolutionInputRef: cachedModelResolutionInputRef,
    };
    const { requestBytesRef: _requestBytesRef, ...cachedModelEffectWithoutRequestBytes } = cachedModelEffect;
    const mismatchedResolutionInputBytes = encodeResolutionInputBytes({
      targetHostRequestFingerprint: 0xbadn,
      status: 0,
      responseValueImageBytes: fromUtf8('cached model response'),
      hostClaimBytes: fromUtf8('host-claim:cached-model-response'),
      attemptNumber: 1,
      metadata: fromUtf8('mismatched-resolution-target'),
    });
    const mismatchedResolutionInputRef = blobRefForBytes(mismatchedResolutionInputBytes);
    const oversizedResolutionInputBytes = encodeResolutionInputBytes({
      targetHostRequestFingerprint: 0xc01n,
      status: 0,
      responseValueImageBytes: fromUtf8('oversized'),
      hostClaimBytes: fromUtf8('host-claim:oversized'),
      attemptNumber: 1,
      metadata: new Uint8Array(),
    });
    const oversizedResolutionInputRef = blobRefForBytes(oversizedResolutionInputBytes);
    const unsupportedStatusResolutionInputBytes = encodeResolutionInputBytes({
      targetHostRequestFingerprint: 0xc01n,
      status: 2,
      responseValueImageBytes: new Uint8Array(),
      hostClaimBytes: fromUtf8('host-claim:unsupported-status'),
      attemptNumber: 1,
      metadata: fromUtf8('unsupported-status-resolution'),
    });
    const unsupportedStatusResolutionInputRef = blobRefForBytes(unsupportedStatusResolutionInputBytes);
    const smallResponseDriver = fixtureDriverWithAuthority(['model:live'], {
      driverId: 'live-model-small-response',
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      actuationClasses: ['model'],
      maximumResponseBytes: 8,
      recoveryClass: EffectRecoveryClass.idempotent,
    });
    const mismatchedResolutionReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 0 }),
      effectRecords: [{ ...cachedModelEffect, resolutionInputRef: mismatchedResolutionInputRef }],
      effectResolutionInputs: new Map([[blobRefKey(mismatchedResolutionInputRef), mismatchedResolutionInputBytes]]),
    });
    const mismatchedResolutionRerunReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [rerunnableDriver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 1 }),
      effectRecords: [{ ...cachedModelEffect, driverRecoveryClass: EffectRecoveryClass.pure, resolutionInputRef: mismatchedResolutionInputRef }],
      effectResolutionInputs: new Map([[blobRefKey(mismatchedResolutionInputRef), mismatchedResolutionInputBytes]]),
    });
    const mismatchedRecoveryClassReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 0 }),
      effectRecords: [{ ...cachedModelEffect, driverRecoveryClass: EffectRecoveryClass.pure }],
      effectResolutionInputs: cachedModelResolutionInputs,
    });
    const mismatchedResolutionWithoutRequestBytesReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 1 }),
      effectRecords: [{ ...cachedModelEffectWithoutRequestBytes, resolutionInputRef: mismatchedResolutionInputRef }],
      effectResolutionInputs: new Map([[blobRefKey(mismatchedResolutionInputRef), mismatchedResolutionInputBytes]]),
    });
    const mismatchedSubmittedResolutionReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 1 }),
      effectRecords: [{ ...cachedModelEffect, state: EffectState.submitted, resolutionInputRef: mismatchedResolutionInputRef }],
      effectResolutionInputs: new Map([[blobRefKey(mismatchedResolutionInputRef), mismatchedResolutionInputBytes]]),
    });
    const mismatchedSameBranchOldParentSubmittedResolutionReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 1, turnClosureWorldFingerprint: 'turn:1' },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [rerunnableDriver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 1 }),
      effectRecords: [{
        ...cachedModelEffect,
        parentTurnClosureFingerprint: 'turn:0',
        state: EffectState.submitted,
        driverRecoveryClass: EffectRecoveryClass.pure,
        resolutionInputRef: mismatchedResolutionInputRef,
      }],
      effectResolutionInputs: new Map([[blobRefKey(mismatchedResolutionInputRef), mismatchedResolutionInputBytes]]),
    });
    const mismatchedSameBranchOldParentCommittedResolutionReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 1, turnClosureWorldFingerprint: 'turn:1' },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [rerunnableDriver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 1 }),
      effectRecords: [{
        ...cachedModelEffect,
        parentTurnClosureFingerprint: 'turn:0',
        state: EffectState.closureCommitted,
        driverRecoveryClass: EffectRecoveryClass.pure,
        resolutionInputRef: mismatchedResolutionInputRef,
      }],
      effectResolutionInputs: new Map([[blobRefKey(mismatchedResolutionInputRef), mismatchedResolutionInputBytes]]),
    });
    const oversizedSubmittedResolutionReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [smallResponseDriver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 1 }),
      effectRecords: [{ ...cachedModelEffect, state: EffectState.submitted, resolutionInputRef: oversizedResolutionInputRef }],
      effectResolutionInputs: new Map([[blobRefKey(oversizedResolutionInputRef), oversizedResolutionInputBytes]]),
    });
    const unsupportedStatusSubmittedResolutionReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 1 }),
      effectRecords: [{ ...cachedModelEffect, state: EffectState.submitted, resolutionInputRef: unsupportedStatusResolutionInputRef }],
      effectResolutionInputs: new Map([[blobRefKey(unsupportedStatusResolutionInputRef), unsupportedStatusResolutionInputBytes]]),
    });
    const mismatchedCrossBranchSubmittedResolutionReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [rerunnableDriver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 1 }),
      effectRecords: [{ ...cachedModelEffect, branchId: 'cached-branch', state: EffectState.submitted, driverRecoveryClass: EffectRecoveryClass.pure, resolutionInputRef: mismatchedResolutionInputRef }],
      effectResolutionInputs: new Map([[blobRefKey(mismatchedResolutionInputRef), mismatchedResolutionInputBytes]]),
    });
    const shadowedCachedEffects = [
      { ...cachedModelEffect, branchId: 'cached-branch' },
      { ...cachedModelEffect, state: EffectState.observed, resolutionInputRef: undefined },
    ];
    const replayOnlyReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 0 }),
      effectRecords: [cachedModelEffect],
      effectResolutionInputs: cachedModelResolutionInputs,
    });
    const divergentFingerprintReplayReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 0 }),
      effectRecords: [{
        ...cachedModelEffect,
        idempotencyKeyWorldFingerprint: `sha256:${createHash('sha256').update(cachedModelRequest.idempotencyKeyBytes).digest('hex')}`,
      }],
      effectResolutionInputs: cachedModelResolutionInputs,
    });
    const auditOnlyPendingReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], auditOnly: true, maximumLiveModelCalls: 1 }),
    });
    const oneNewWithCachedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest, freshModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 1 }),
      effectRecords: [cachedModelEffect],
      effectResolutionInputs: cachedModelResolutionInputs,
    });
    const shadowedReplayReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 0 }),
      effectRecords: shadowedCachedEffects,
    });
    const shadowedReplayWithResolutionReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 0 }),
      effectRecords: shadowedCachedEffects,
      effectResolutionInputs: cachedModelResolutionInputs,
    });
    const shadowedInvalidCurrentBranchSubmittedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 0 }),
      effectRecords: [
        { ...cachedModelEffect, branchId: 'cached-branch' },
        { ...cachedModelEffect, state: EffectState.submitted, resolutionInputRef: mismatchedResolutionInputRef },
      ],
      effectResolutionInputs: new Map([
        [blobRefKey(cachedModelResolutionInputRef), cachedModelResolutionInputBytes],
        [blobRefKey(mismatchedResolutionInputRef), mismatchedResolutionInputBytes],
      ]),
    });
    const shadowedMixedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest, freshModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 1 }),
      effectRecords: shadowedCachedEffects,
    });
    const mismatchedCachedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [cachedModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 0 }),
      effectRecords: [{ ...cachedModelEffect, hostRequestFingerprint: 'world:host-request:0000000000000bad' }],
    });
    const wrongFullKeyReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [cachedModelRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:live'], maximumLiveModelCalls: 0 }),
      effectRecords: [{
        ...cachedModelEffect,
        idempotencyKey: {
          format: 'world-idempotency-key-bytes.hex',
          bytesHex: Buffer.from('different-model-budget-key').toString('hex'),
        },
      }],
    });
    const nonLiveDriver = fixtureDriverWithAuthority(['model:fixture'], {
      driverId: 'fixture-model-budget',
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      actuationClasses: ['model'],
      recoveryClass: EffectRecoveryClass.idempotent,
      diagnostics: { deterministic: true },
    });
    const liveOnlyRequest = {
      ...modelRequest('live-only'),
      descriptorFingerprint: 'descriptor:agent-live-only',
    };
    const liveOnlyDriver = fixtureDriverWithAuthority(['model:live'], {
      driverId: 'live-model-only',
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-live-only',
      actuationClasses: ['model'],
    });
    const spoofedFixtureIdLiveDriver = fixtureDriverWithAuthority(['model:live'], {
      driverId: 'fixture-agent-model',
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-live-only',
      actuationClasses: ['model'],
      diagnostics: { deterministic: true },
    });
    const fallbackWithInvalidReusableReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [driver, nonLiveDriver],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['model:live', 'model:fixture'],
        maximumLiveModelCalls: 0,
      }),
      effectRecords: [{ ...cachedModelEffect, resolutionInputRef: mismatchedResolutionInputRef }],
      effectResolutionInputs: new Map([[blobRefKey(mismatchedResolutionInputRef), mismatchedResolutionInputBytes]]),
    });
    const fallbackWithSubmittedInvalidReusableReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [driver, nonLiveDriver],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['model:live', 'model:fixture'],
        maximumLiveModelCalls: 0,
      }),
      effectRecords: [{ ...cachedModelEffect, state: EffectState.submitted, resolutionInputRef: mismatchedResolutionInputRef }],
      effectResolutionInputs: new Map([[blobRefKey(mismatchedResolutionInputRef), mismatchedResolutionInputBytes]]),
    });
    const routeSpecificLiveDriver = fixtureDriverWithAuthority(['model:live'], {
      driverId: 'route-specific-live-model',
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      actuationClasses: ['model'],
      recoveryClass: EffectRecoveryClass.idempotent,
      diagnostics: {
        endpointSource: 'request-or-config',
        modelOutputValidation: { schema: 'strict-agent-action' },
      },
    });
    const routeSpecificLiveIdentityBytes = journaledHostRequest(cachedModelRequest, routeSpecificLiveDriver.manifest()).effectIdentityBytes;
    const fallbackWithRouteSpecificConflictReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      currentBranchId: 'main',
      pendingRequests: [cachedModelRequest],
      drivers: [routeSpecificLiveDriver, nonLiveDriver],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['model:live', 'model:fixture'],
        maximumLiveModelCalls: 0,
      }),
      effectRecords: [{
        ...cachedModelEffect,
        state: EffectState.submitted,
        resolutionInputRef: mismatchedResolutionInputRef,
        requestIdentityChecksum: `sha256:${createHash('sha256').update(routeSpecificLiveIdentityBytes).digest('hex')}`,
      }],
      effectResolutionInputs: new Map([[blobRefKey(mismatchedResolutionInputRef), mismatchedResolutionInputBytes]]),
    });
    const liveFirstWithFixtureFallbackReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [modelRequest('fixture-fallback')],
      drivers: [driver, nonLiveDriver],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['model:live', 'model:fixture'],
        maximumLiveModelCalls: 0,
      }),
    });
    const mixedBudgetWithFixtureFallbackReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [modelRequest('fixture-fallback'), liveOnlyRequest],
      drivers: [driver, nonLiveDriver, liveOnlyDriver],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['model:live', 'model:fixture'],
        maximumLiveModelCalls: 1,
      }),
    });
    const spoofedFixtureIdLiveReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [liveOnlyRequest],
      drivers: [spoofedFixtureIdLiveDriver],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['model:live'],
        maximumLiveModelCalls: 0,
      }),
    });

    assert.ok(zeroBudgetReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'));
    assert.ok(overBudgetReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'));
    assert.ok(wrappedOverBudgetReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'));
    assert.equal(replayOnlyReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'), false);
    assert.deepEqual(divergentFingerprintReplayReport.blockers, []);
    assert.deepEqual(auditOnlyPendingReport.blockers, ['ERR_CAPABILITY_AUDIT_ONLY_DENIED']);
    assert.equal(oneNewWithCachedReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'), false);
    assert.ok(shadowedReplayReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'));
    assert.deepEqual(shadowedReplayWithResolutionReport.blockers, []);
    assert.deepEqual(shadowedInvalidCurrentBranchSubmittedReport.blockers, [
      'ERR_CAPABILITY_REUSABLE_EFFECT_TARGET_MISMATCH',
      'ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED',
    ]);
    assert.ok(shadowedMixedReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'));
    assert.ok(mismatchedCachedReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'));
    assert.ok(wrongFullKeyReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'));
    assert.ok(mismatchedResolutionReport.blockers.includes('ERR_CAPABILITY_REUSABLE_EFFECT_TARGET_MISMATCH'));
    assert.ok(mismatchedResolutionReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'));
    assert.deepEqual(mismatchedResolutionRerunReport.blockers, []);
    assert.ok(mismatchedRecoveryClassReport.blockers.includes('ERR_EFFECT_RECOVERY_CLASS_MISMATCH'));
    assert.ok(mismatchedRecoveryClassReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'));
    assert.deepEqual(mismatchedResolutionWithoutRequestBytesReport.blockers, ['ERR_CAPABILITY_REUSABLE_EFFECT_TARGET_MISMATCH']);
    assert.deepEqual(mismatchedSubmittedResolutionReport.blockers, ['ERR_CAPABILITY_REUSABLE_EFFECT_TARGET_MISMATCH']);
    assert.deepEqual(mismatchedSameBranchOldParentSubmittedResolutionReport.blockers, []);
    assert.deepEqual(mismatchedSameBranchOldParentCommittedResolutionReport.blockers, []);
    assert.deepEqual(oversizedSubmittedResolutionReport.blockers, ['ERR_CAPABILITY_REUSABLE_EFFECT_RESPONSE_TOO_LARGE']);
    assert.equal(oversizedSubmittedResolutionReport.valueSizeLimitsSupported, false);
    assert.deepEqual(unsupportedStatusSubmittedResolutionReport.blockers, ['ERR_CAPABILITY_REUSABLE_EFFECT_STATUS_MISMATCH']);
    assert.equal(unsupportedStatusSubmittedResolutionReport.responseStatusesSupported, false);
    assert.deepEqual(mismatchedCrossBranchSubmittedResolutionReport.blockers, []);
    assert.deepEqual(fallbackWithInvalidReusableReport.blockers, []);
    assert.deepEqual(fallbackWithInvalidReusableReport.coveredRequests, [{
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      driverId: 'fixture-model-budget',
    }]);
    assert.deepEqual(fallbackWithSubmittedInvalidReusableReport.blockers, ['ERR_CAPABILITY_REUSABLE_EFFECT_TARGET_MISMATCH']);
    assert.deepEqual(fallbackWithSubmittedInvalidReusableReport.coveredRequests, [{
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      driverId: 'fixture-model-budget',
    }]);
    assert.deepEqual(fallbackWithRouteSpecificConflictReport.blockers, ['ERR_EFFECT_IDEMPOTENCY_CONFLICT']);
    assert.deepEqual(fallbackWithRouteSpecificConflictReport.coveredRequests, [{
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      driverId: 'fixture-model-budget',
    }]);
    assert.deepEqual(liveFirstWithFixtureFallbackReport.blockers, []);
    assert.deepEqual(liveFirstWithFixtureFallbackReport.coveredRequests, [{
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      driverId: 'fixture-model-budget',
    }]);
    assert.deepEqual(mixedBudgetWithFixtureFallbackReport.blockers, []);
    assert.deepEqual(mixedBudgetWithFixtureFallbackReport.coveredRequests.map(({ driverId }) => driverId), [
      'fixture-model-budget',
      'live-model-only',
    ]);
    assert.ok(spoofedFixtureIdLiveReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'));
  });

  it('requires human-effect opt-in during receiver preflight', () => {
    const humanRequest = {
      actuatorRef: 'human:approval',
      descriptorFingerprint: 'descriptor:human-approval',
      actuationClass: 'human',
      responseSchema: { status: 'ok' },
      idempotencyKeyWorldFingerprint: 'world:key:human-preflight',
      requestBytes: fromUtf8(stableJson({ action: 'approve' })),
    };
    const driver = new HumanApprovalCapabilityDriver({ mode: 'noninteractive-allow' });
    const deniedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [humanRequest],
      drivers: [driver],
      policy: createRunPolicy({ allowedAuthorityLabels: ['human:approval'] }),
    });
    const allowedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [humanRequest],
      drivers: [driver],
      policy: createRunPolicy({
        allowHumanEffects: true,
        allowedAuthorityLabels: ['human:approval'],
      }),
    });

    assert.ok(deniedReport.blockers.includes('ERR_CAPABILITY_HUMAN_DENIED'));
    assert.deepEqual(allowedReport.blockers, []);

    const denyDriverForOkRequest = new HumanApprovalCapabilityDriver({ mode: 'noninteractive-deny' });
    const denyDriverOkReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [humanRequest],
      drivers: [denyDriverForOkRequest],
      policy: createRunPolicy({
        allowHumanEffects: true,
        allowedAuthorityLabels: ['human:approval'],
      }),
    });
    const allowDriverRejectedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [{ ...humanRequest, responseSchema: { status: 'rejected' } }],
      drivers: [driver],
      policy: createRunPolicy({
        allowHumanEffects: true,
        allowedAuthorityLabels: ['human:approval'],
      }),
    });
    assert.ok(denyDriverOkReport.blockers.includes('ERR_RESPONSE_STATUS_NOT_SUPPORTED'));
    assert.ok(allowDriverRejectedReport.blockers.includes('ERR_RESPONSE_STATUS_NOT_SUPPORTED'));
  });

  it('applies prompt byte limits to human approval prompts', async () => {
    const humanRequest = {
      actuatorRef: 'human:approval',
      descriptorFingerprint: 'descriptor:human-approval',
      actuationClass: 'human',
      responseSchema: { status: 'ok' },
      idempotencyKeyWorldFingerprint: 'world:key:human-prompt-limit',
      requestBytes: fromUtf8(stableJson({ prompt: 'approve this larger request' })),
      hostRequestFingerprint: 'world:host-request:0000000000000a01',
    };
    const policy = {
      allowLiveEffects: true,
      allowHumanEffects: true,
      allowedAuthorityLabels: ['human:approval'],
      maximumRequestBytes: 4096,
      maximumPromptBytes: 4,
    };
    const context = { policy };
    const driver = new HumanApprovalCapabilityDriver({ mode: 'noninteractive-allow' });
    const report = driver.preflight(context, humanRequest);

    assert.equal(report.accepted, false);
    assert.ok(report.blockers.includes('ERR_CAPABILITY_PROMPT_TOO_LARGE'));
    await assert.rejects(
      () => driver.resolve(context, humanRequest),
      { code: 'ERR_CAPABILITY_PROMPT_TOO_LARGE' },
    );

    const preflightReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [humanRequest],
      drivers: [driver],
      policy,
    });
    assert.ok(preflightReport.blockers.includes('prompt-limit-exceeds-policy'));
  });

  it('enforces prompt byte limits during live model receiver preflight', () => {
    const modelRequest = {
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      actuationClass: 'model',
      responseSchema: { status: 'ok' },
      idempotencyKeyWorldFingerprint: 'world:key:model-prompt-limit',
      requestBytes: fromUtf8(stableJson({ schema: 'boundary.Agent.DecisionPrompt.v0', observation: 'goal=too-large' })),
      hostRequestFingerprint: 'world:host-request:0000000000000b01',
    };
    const driver = fixtureDriverWithAuthority(['model:live'], {
      driverId: 'live-model-prompt-limit',
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      actuationClasses: ['model'],
      recoveryClass: EffectRecoveryClass.idempotent,
    });
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [modelRequest],
      drivers: [driver],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['model:live'],
        maximumLiveModelCalls: 1,
        maximumRequestBytes: 4096,
        maximumPromptBytes: 4,
      }),
    });

    assert.ok(report.blockers.includes('prompt-limit-exceeds-policy'));
  });

  it('rejects invalid human approval modes during driver preflight', async () => {
    const humanRequest = {
      actuatorRef: 'human:approval',
      descriptorFingerprint: 'descriptor:human-approval',
      actuationClass: 'human',
      responseSchema: { status: 'ok' },
      idempotencyKeyWorldFingerprint: 'world:key:human-preflight',
      requestBytes: fromUtf8(stableJson({ action: 'approve' })),
    };
    const policy = createRunPolicy({
      allowHumanEffects: true,
      allowedAuthorityLabels: ['human:approval'],
    });
    const context = { policy };
    const missingPromptDriver = new HumanApprovalCapabilityDriver({ mode: 'interactive-terminal' });
    const unsupportedModeDriver = new HumanApprovalCapabilityDriver({ mode: 'browser-popup', prompt: async () => true });
    const missingPromptReport = missingPromptDriver.preflight(context, humanRequest);
    const unsupportedModeReport = unsupportedModeDriver.preflight(context, humanRequest);

    assert.equal(missingPromptReport.accepted, false);
    assert.ok(missingPromptReport.blockers.includes('ERR_HUMAN_APPROVAL_PROMPT_REQUIRED'));
    assert.equal(unsupportedModeReport.accepted, false);
    assert.ok(unsupportedModeReport.blockers.includes('ERR_HUMAN_APPROVAL_MODE_UNSUPPORTED'));
    await assert.rejects(
      () => missingPromptDriver.resolve(context, humanRequest),
      { code: 'ERR_HUMAN_APPROVAL_PROMPT_REQUIRED' },
    );
  });

  it('binds cached model replay budget exemptions to output validation policy', () => {
    const modelRequest = {
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      actuationClass: 'model',
      responseSchema: { status: 'ok' },
      idempotencyKeyBytes: fromUtf8('model-output-policy-key'),
      idempotencyKeyWorldFingerprint: 'world:key:model-output-policy',
      requestBytes: fromUtf8(stableJson({ schema: 'boundary.Agent.DecisionPrompt.v0', observation: 'goal=policy-cache' })),
      hostRequestFingerprint: 'world:host-request:0000000000000c03',
    };
    const permissiveDriver = new GenericHttpJsonModelDriver({
      endpointUrl: 'https://allowed.example/decide',
      allowedToolIds: ['actuate', 'write_file'],
    });
    const strictDriver = new GenericHttpJsonModelDriver({
      endpointUrl: 'https://allowed.example/decide',
      allowedToolIds: ['actuate'],
    });
    const cachedIdentityBytes = journaledHostRequest(modelRequest, permissiveDriver.manifest()).effectIdentityBytes;
    const cachedResolutionInputBytes = encodeResolutionInputBytes({
      targetHostRequestFingerprint: 0xc03n,
      status: 0,
      responseValueImageBytes: agentActionValueImage({ variant: 'tool', toolId: 'write_file', payload: 'cached policy response' }),
      hostClaimBytes: fromUtf8('host-claim:cached-policy-response'),
      attemptNumber: 1,
      metadata: fromUtf8('cached-model-output-policy-resolution'),
    });
    const forgedResolutionInputBytes = encodeResolutionInputBytes({
      targetHostRequestFingerprint: 0xc03n,
      status: 0,
      responseValueImageBytes: fromUtf8('forged model response'),
      hostClaimBytes: fromUtf8('host-claim:forged-model-response'),
      attemptNumber: 1,
      metadata: fromUtf8('forged-model-output-policy-resolution'),
    });
    const cachedResolutionInputRef = blobRefForBytes(cachedResolutionInputBytes);
    const forgedResolutionInputRef = blobRefForBytes(forgedResolutionInputBytes);
    const cachedResolutionInputs = new Map([
      [blobRefKey(cachedResolutionInputRef), cachedResolutionInputBytes],
      [blobRefKey(forgedResolutionInputRef), forgedResolutionInputBytes],
    ]);
    const cachedEffect = {
      idempotencyKeyWorldFingerprint: modelRequest.idempotencyKeyWorldFingerprint,
      hostRequestFingerprint: modelRequest.hostRequestFingerprint,
      idempotencyKey: {
        format: 'world-idempotency-key-bytes.hex',
        bytesHex: Buffer.from('model-output-policy-key').toString('hex'),
      },
      requestBytesChecksum: `sha256:${createHash('sha256').update(modelRequest.requestBytes).digest('hex')}`,
      requestIdentityChecksum: `sha256:${createHash('sha256').update(cachedIdentityBytes).digest('hex')}`,
      state: EffectState.resolved,
      resolutionInputRef: cachedResolutionInputRef,
    };
    const policy = createRunPolicy({
      allowedAuthorityLabels: ['model:http-json', 'network:http'],
      allowedHttpOrigins: ['https://allowed.example'],
      allowedHttpMethods: ['POST'],
      maximumLiveModelCalls: 0,
    });

    const permissiveReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [modelRequest],
      drivers: [permissiveDriver],
      policy,
      effectRecords: [cachedEffect],
      effectResolutionInputs: cachedResolutionInputs,
    });
    const strictReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [modelRequest],
      drivers: [strictDriver],
      policy,
      effectRecords: [cachedEffect],
      effectResolutionInputs: cachedResolutionInputs,
    });
    const forgedReport = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [modelRequest],
      drivers: [permissiveDriver],
      policy,
      effectRecords: [{ ...cachedEffect, resolutionInputRef: forgedResolutionInputRef }],
      effectResolutionInputs: cachedResolutionInputs,
    });

    assert.equal(permissiveReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'), false);
    assert.ok(strictReport.blockers.includes('ERR_EFFECT_IDEMPOTENCY_CONFLICT'));
    assert.ok(forgedReport.blockers.includes('ERR_CAPABILITY_REUSABLE_EFFECT_OUTPUT_INVALID'));
    assert.ok(forgedReport.blockers.includes('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED'));
  });

  it('invalidates cached model outputs that fail journal output validation before reuse', async () => {
    const modelRequest = {
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      actuationClass: 'model',
      responseSchema: { status: 'ok' },
      idempotencyKeyBytes: fromUtf8('model-output-journal-cache-key'),
      idempotencyKeyWorldFingerprint: 'world:key:model-output-journal-cache',
      requestBytes: fromUtf8(stableJson({ schema: 'boundary.Agent.DecisionPrompt.v0', observation: 'goal=journal-cache' })),
      hostRequestFingerprint: 'world:host-request:0000000000000d04',
    };
    let liveInvocations = 0;
    const strictDriver = {
      manifest() {
        return {
          driverId: 'strict-model-output-cache',
          supportedActuatorRefs: ['model:decision'],
          supportedDescriptorFingerprints: ['descriptor:agent-decision-prompt'],
          supportedActuationClasses: ['model'],
          supportedResponseStatuses: ['ok'],
          maximumRequestBytes: 4096,
          maximumResponseBytes: 4096,
          recoveryClass: EffectRecoveryClass.idempotent,
          concurrencyLimit: 1,
          authorityLabels: ['model:http-json'],
          diagnostics: {
            endpointSource: 'config',
            configuredEndpointUrl: 'https://allowed.example/decide',
            defaultMethod: 'POST',
            modelOutputValidation: {
              outputSchema: 'boundary.Agent.Action.v0',
              allowedToolIds: ['actuate'],
            },
          },
        };
      },
      async resolve() {
        liveInvocations += 1;
        return {
          resolutionInputBytes: encodeResolutionInputBytes({
            targetHostRequestFingerprint: 0xd04n,
            status: 0,
            responseValueImageBytes: agentActionValueImage({ variant: 'final', text: 'fresh model output' }),
            hostClaimBytes: fromUtf8('host-claim:fresh-model-output'),
            attemptNumber: liveInvocations,
            metadata: fromUtf8('fresh-model-output-resolution'),
          }),
        };
      },
    };
    const manifest = strictDriver.manifest();
    const store = new MemoryStore();
    const cachedResolutionInputBytes = encodeResolutionInputBytes({
      targetHostRequestFingerprint: 0xd04n,
      status: 0,
      responseValueImageBytes: agentActionValueImage({ variant: 'tool', toolId: 'write_file', payload: 'cached invalid tool' }),
      hostClaimBytes: fromUtf8('host-claim:cached-invalid-model-output'),
      attemptNumber: 1,
      metadata: fromUtf8('cached-invalid-model-output-resolution'),
    });
    const requestBytesRef = await store.putBlob(modelRequest.requestBytes);
    const cachedResolutionInputRef = await store.putBlob(cachedResolutionInputBytes);
    const journaledRequest = journaledHostRequest(modelRequest, manifest);
    const cachedEffect = {
      runId: 'run:model-output-journal-cache',
      branchId: 'branch:model-output-journal-cache',
      parentTurnClosureFingerprint: 'world:closure:model-output-journal-cache-parent',
      hostRequestFingerprint: modelRequest.hostRequestFingerprint,
      idempotencyKey: {
        format: 'world-idempotency-key-bytes.hex',
        bytesHex: Buffer.from('model-output-journal-cache-key').toString('hex'),
      },
      idempotencyKeyWorldFingerprint: modelRequest.idempotencyKeyWorldFingerprint,
      actuatorRef: modelRequest.actuatorRef,
      descriptorFingerprint: modelRequest.descriptorFingerprint,
      actuationClass: modelRequest.actuationClass,
      responseSchema: modelRequest.responseSchema,
      requestBytesRef,
      requestBytesChecksum: `sha256:${createHash('sha256').update(modelRequest.requestBytes).digest('hex')}`,
      requestIdentityChecksum: `sha256:${createHash('sha256').update(journaledRequest.effectIdentityBytes).digest('hex')}`,
      state: EffectState.resolved,
      attemptCount: 1,
      driverRecoveryClass: EffectRecoveryClass.idempotent,
      resolutionInputRef: cachedResolutionInputRef,
      diagnostics: {},
    };
    await store.putEffectRecord(cachedEffect);
    const journal = new EffectJournal({
      store,
      runId: cachedEffect.runId,
      branchId: cachedEffect.branchId,
      parentTurnClosureFingerprint: cachedEffect.parentTurnClosureFingerprint,
      policy: {
        allowedAuthorityLabels: ['model:http-json'],
        maximumLiveModelCalls: 1,
      },
    });

    const result = await journal.resolve({}, modelRequest, strictDriver);
    const current = await store.getEffectRecord(cachedEffect.runId, cachedEffect.idempotencyKey, cachedEffect.branchId);

    assert.equal(liveInvocations, 1);
    assert.equal(result.reused, false);
    assert.equal(decodeResolutionInputBytes(result.resolutionInputBytes).status, 0);
    assert.notDeepEqual(current.resolutionInputRef, cachedResolutionInputRef);
    assert.equal(current.diagnostics.invalidReusableResolution, 'ERR_EFFECT_MODEL_OUTPUT_INVALID');
  });

  it('requires descriptor coverage for application-level actuator requirements', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{
          actuatorRef: 'fixture:model',
          descriptorFingerprint: 'descriptor:other-model',
        }],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      drivers: [new FixtureModelDriver({ responses: ['ok'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.ok(report.blockers.includes('required-actuator-descriptor-uncovered:fixture:model:descriptor:other-model'));
    assert.equal(report.everyRequiredActuatorCovered, false);
    assert.equal(report.executableCompatible, false);
  });

  it('requires declared host authority labels during application preflight', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{
          actuatorRef: 'fixture:model',
          descriptorFingerprint: 'descriptor:fixture-model',
        }],
        requiredHostAuthorityLabels: ['model:fixture-agent'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      drivers: [new FixtureModelDriver({ responses: ['ok'] })],
      policy: createRunPolicy(),
    });

    assert.ok(report.blockers.includes('required-authority-uncovered:model:fixture-agent'));
    assert.equal(report.everyRequiredActuatorCovered, false);
    assert.equal(report.executableCompatible, false);
  });

  it('preserves detailed policy blockers for required host authority labels', async () => {
    const allowedRoot = await mkdtemp(path.join(tmpdir(), 'world-host-authority-allowed-'));
    const blockedRoot = await mkdtemp(path.join(tmpdir(), 'world-host-authority-blocked-'));
    try {
      const report = preflightCapabilities({
        application: {
          requiredActuators: [],
          requiredHostAuthorityLabels: ['file:sandbox'],
          requiredRuntimeLimits: {},
        },
        currentHead: { generation: 0 },
        drivers: [new SandboxFileDriver({ root: blockedRoot })],
        policy: createRunPolicy({
          allowBestEffort: true,
          allowedAuthorityLabels: ['file:sandbox'],
          allowedFileRoots: [allowedRoot],
        }),
      });

      assert.ok(report.blockers.includes('required-authority-policy-blocked:file:sandbox'));
      assert.ok(report.blockers.includes(`file-root-denied:${path.resolve(blockedRoot)}`));
      assert.equal(report.fileNetworkAuthoritiesAllowed, false);
    } finally {
      await rm(allowedRoot, { recursive: true, force: true });
      await rm(blockedRoot, { recursive: true, force: true });
    }
  });

  it('requires receiver file root allowlists for file authority routes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-authority-file-root-'));
    try {
      const report = preflightCapabilities({
        application: {
          requiredActuators: [],
          requiredRuntimeLimits: {},
        },
        currentHead: { generation: 0 },
        pendingRequests: [fileRequest('out.txt')],
        drivers: [new SandboxFileDriver({ root })],
        policy: createRunPolicy({
          allowBestEffort: true,
          allowedAuthorityLabels: ['file:sandbox'],
        }),
      });

      assert.ok(report.blockers.includes('file-root-allowlist-required'));
      assert.equal(report.fileNetworkAuthoritiesAllowed, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires receiver file root allowlists for required file actuators', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-required-file-root-'));
    try {
      const report = preflightCapabilities({
        application: {
          requiredActuators: [{
            actuatorRef: 'sandbox:file',
            descriptorFingerprint: 'descriptor:sandbox-file',
          }],
          requiredRuntimeLimits: {},
        },
        currentHead: { generation: 0 },
        drivers: [new SandboxFileDriver({ root })],
        policy: createRunPolicy({
          allowBestEffort: true,
          allowedAuthorityLabels: ['file:sandbox'],
        }),
      });

      assert.ok(report.blockers.includes('required-actuator-policy-blocked:sandbox:file'));
      assert.ok(report.blockers.includes('file-root-allowlist-required'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires authority labels on selected actuator and request drivers', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{
          actuatorRef: 'fixture:model',
          descriptorFingerprint: 'descriptor:fixture-model',
        }],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [
        fixtureDriverWithAuthority([]),
        fixtureDriverWithAuthority(['model:fixture'], {
          driverId: 'dummy-authority',
          actuatorRef: 'fixture:other',
        }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.ok(report.blockers.includes('required-authority-unbound:model:fixture'));
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture-model',
      driverId: 'fixture-model-custom',
    }]);
    assert.equal(report.everyRequiredActuatorCovered, false);
  });

  it('prefers authority-bound routes over earlier unlabeled matches', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{
          actuatorRef: 'fixture:model',
          descriptorFingerprint: 'descriptor:fixture-model',
        }],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [
        fixtureDriverWithAuthority([], { driverId: 'unlabeled-model' }),
        fixtureDriverWithAuthority(['model:fixture'], { driverId: 'labeled-model' }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture-model',
      driverId: 'labeled-model',
    }]);
    assert.equal(report.everyRequiredActuatorCovered, true);
  });

  it('does not prefer unrelated required authority labels for pending routes', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [
          {
            actuatorRef: 'fixture:model',
            descriptorFingerprint: 'descriptor:fixture-model',
          },
          {
            actuatorRef: 'sandbox:file',
            descriptorFingerprint: 'descriptor:sandbox-file',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture', 'file:sandbox'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [
        fixtureDriverWithAuthority(['file:sandbox'], { driverId: 'wrong-label-model' }),
        fixtureDriverWithAuthority(['model:fixture'], { driverId: 'labeled-model' }),
        fixtureDriverWithAuthority(['file:sandbox'], {
          driverId: 'file-required',
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClasses: ['file'],
          diagnostics: { root: FIXTURE_FILE_ROOT },
        }),
      ],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['model:fixture', 'file:sandbox'],
        allowedFileRoots: [FIXTURE_FILE_ROOT],
      }),
    });

    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture-model',
      driverId: 'labeled-model',
    }]);
    assert.equal(report.everyRequiredActuatorCovered, true);
  });

  it('does not let inactive actuator routes satisfy active request authority labels', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [
          {
            actuatorRef: 'fixture:model',
            descriptorFingerprint: 'descriptor:fixture-model',
          },
          {
            actuatorRef: 'sandbox:file',
            descriptorFingerprint: 'descriptor:sandbox-file',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture', 'file:sandbox'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fileRequest('out.txt')],
      drivers: [
        fixtureDriverWithAuthority(['model:fixture', 'file:sandbox'], {
          driverId: 'cross-labeled-model',
          diagnostics: { root: FIXTURE_FILE_ROOT },
        }),
        fixtureDriverWithAuthority([], {
          driverId: 'unlabeled-file',
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClasses: ['file'],
          diagnostics: { root: FIXTURE_FILE_ROOT },
        }),
      ],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['model:fixture', 'file:sandbox'],
        allowedFileRoots: [FIXTURE_FILE_ROOT],
      }),
    });

    assert.ok(report.blockers.includes('required-authority-unbound:file:sandbox'));
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'sandbox:file',
      descriptorFingerprint: 'descriptor:sandbox-file',
      driverId: 'unlabeled-file',
    }]);
    assert.equal(report.everyRequiredActuatorCovered, false);
  });

  it('binds distinct required authority labels to simultaneous pending routes', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [
          {
            actuatorRef: 'fixture:model',
            descriptorFingerprint: 'descriptor:fixture-model',
          },
          {
            actuatorRef: 'sandbox:file',
            descriptorFingerprint: 'descriptor:sandbox-file',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture', 'file:sandbox'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [
        fixtureRequest(),
        fileRequest('out.txt'),
      ],
      drivers: [
        fixtureDriverWithAuthority(['model:fixture']),
        fixtureDriverWithAuthority(['file:sandbox'], {
          driverId: 'file-required',
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClasses: ['file'],
          diagnostics: { root: FIXTURE_FILE_ROOT },
        }),
      ],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['model:fixture', 'file:sandbox'],
        allowedFileRoots: [FIXTURE_FILE_ROOT],
      }),
    });

    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.coveredRequests, [
      {
        actuatorRef: 'fixture:model',
        descriptorFingerprint: 'descriptor:fixture-model',
        driverId: 'fixture-model-custom',
      },
      {
        actuatorRef: 'sandbox:file',
        descriptorFingerprint: 'descriptor:sandbox-file',
        driverId: 'file-required',
      },
    ]);
    assert.equal(report.everyRequiredActuatorCovered, true);
  });

  it('does not bind pending request authority to an unused required actuator route', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{
          actuatorRef: 'fixture:model',
          descriptorFingerprint: 'descriptor:fixture-model',
        }],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [
        fixtureDriverWithAuthority(['model:fixture'], {
          driverId: 'labeled-required-only',
          actuationClasses: ['fixture:unused'],
        }),
        fixtureDriverWithAuthority([], { driverId: 'selected-unlabeled-request' }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.ok(report.blockers.includes('required-authority-unbound:model:fixture'));
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture-model',
      driverId: 'selected-unlabeled-request',
    }]);
    assert.equal(report.everyRequiredActuatorCovered, false);
  });

  it('does not require inactive actuator authorities on unrelated pending request routes', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [
          {
            actuatorRef: 'fixture:model',
            descriptorFingerprint: 'descriptor:fixture-model',
          },
          {
            actuatorRef: 'sandbox:file',
            descriptorFingerprint: 'descriptor:sandbox-file',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture', 'file:sandbox'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [
        fixtureDriverWithAuthority(['model:fixture']),
        fixtureDriverWithAuthority(['file:sandbox'], {
          driverId: 'file-required',
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClasses: ['file'],
          diagnostics: { root: FIXTURE_FILE_ROOT },
        }),
      ],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['model:fixture', 'file:sandbox'],
        allowedFileRoots: [FIXTURE_FILE_ROOT],
      }),
    });

    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyRequiredActuatorCovered, true);
  });

  it('does not require an inactive single authority label on unrelated pending request routes', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [
          {
            actuatorRef: 'fixture:model',
            descriptorFingerprint: 'descriptor:fixture-model',
          },
          {
            actuatorRef: 'sandbox:file',
            descriptorFingerprint: 'descriptor:sandbox-file',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fileRequest('out.txt')],
      drivers: [
        fixtureDriverWithAuthority(['model:fixture']),
        fixtureDriverWithAuthority([], {
          driverId: 'unlabeled-file',
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClasses: ['file'],
          diagnostics: { root: FIXTURE_FILE_ROOT },
        }),
      ],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['model:fixture'],
        allowedFileRoots: [FIXTURE_FILE_ROOT],
      }),
    });

    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'sandbox:file',
      descriptorFingerprint: 'descriptor:sandbox-file',
      driverId: 'unlabeled-file',
    }]);
    assert.equal(report.everyRequiredActuatorCovered, true);
  });

  it('does not bind one pending request authority to another pending request route', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [
          {
            actuatorRef: 'fixture:model',
            descriptorFingerprint: 'descriptor:fixture-model',
          },
          {
            actuatorRef: 'sandbox:file',
            descriptorFingerprint: 'descriptor:sandbox-file',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [
        fixtureRequest(),
        fileRequest('out.txt'),
      ],
      drivers: [
        fixtureDriverWithAuthority([], { driverId: 'selected-unlabeled-model' }),
        fixtureDriverWithAuthority(['model:fixture'], {
          driverId: 'unrelated-labeled-file',
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClasses: ['file'],
          diagnostics: { root: FIXTURE_FILE_ROOT },
        }),
      ],
      policy: createRunPolicy({
        allowedAuthorityLabels: ['model:fixture'],
        allowedFileRoots: [FIXTURE_FILE_ROOT],
      }),
    });

    assert.ok(report.blockers.includes('required-authority-unbound:model:fixture'));
    assert.deepEqual(report.coveredRequests, [
      {
        actuatorRef: 'fixture:model',
        descriptorFingerprint: 'descriptor:fixture-model',
        driverId: 'selected-unlabeled-model',
      },
      {
        actuatorRef: 'sandbox:file',
        descriptorFingerprint: 'descriptor:sandbox-file',
        driverId: 'unrelated-labeled-file',
      },
    ]);
    assert.equal(report.everyRequiredActuatorCovered, false);
  });

  it('requires authority labels on selected actuator drivers before requests are inspected', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{
          actuatorRef: 'fixture:model',
          descriptorFingerprint: 'descriptor:fixture-model',
        }],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      drivers: [
        fixtureDriverWithAuthority([]),
        fixtureDriverWithAuthority(['model:fixture'], {
          driverId: 'dummy-authority',
          actuatorRef: 'fixture:other',
        }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.ok(report.blockers.includes('required-authority-unbound:model:fixture'));
    assert.equal(report.everyRequiredActuatorCovered, false);
    assert.equal(report.executableCompatible, false);
  });

  it('defers authority binding when pending requests are not available yet', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      drivers: [fixtureDriverWithAuthority(['model:fixture'])],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyRequiredActuatorCovered, true);
  });

  it('applies receiver policy to required actuators and sandbox roots', async () => {
    const allowedRoot = await mkdtemp(path.join(tmpdir(), 'world-host-allowed-root-'));
    const blockedRoot = await mkdtemp(path.join(tmpdir(), 'world-host-blocked-root-'));
    try {
      const requiredReport = preflightCapabilities({
        application: { requiredActuators: [{ actuatorRef: 'fixture:model' }], requiredRuntimeLimits: {} },
        currentHead: { generation: 0 },
        drivers: [policyDeniedFixtureDriver()],
        policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
      });
      assert.ok(requiredReport.blockers.includes('required-actuator-policy-blocked:fixture:model'));
      assert.ok(requiredReport.blockers.includes('authority-denied:denied:fixture'));

      const fileReport = preflightCapabilities({
        application: { requiredActuators: [], requiredRuntimeLimits: {} },
        currentHead: { generation: 0 },
        pendingRequests: [fileRequest('out.txt', { operation: 'write', content: 'blocked' })],
        drivers: [new SandboxFileDriver({ root: blockedRoot })],
        policy: createRunPolicy({
          allowBestEffort: true,
          allowedAuthorityLabels: ['file:sandbox'],
          allowedFileRoots: [allowedRoot],
        }),
      });
      assert.ok(fileReport.blockers.includes(`file-root-denied:${path.resolve(blockedRoot)}`));
      assert.equal(fileReport.fileNetworkAuthoritiesAllowed, false);

      const mislabelledFileReport = preflightCapabilities({
        application: { requiredActuators: [], requiredRuntimeLimits: {} },
        currentHead: { generation: 0 },
        pendingRequests: [fileRequest('out.txt', { operation: 'write', content: 'blocked' })],
        drivers: [fixtureDriverWithAuthority([], {
          driverId: 'mislabelled-file',
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClasses: ['file'],
          diagnostics: { root: path.resolve(blockedRoot) },
        })],
        policy: createRunPolicy({
          allowBestEffort: true,
          allowedFileRoots: [allowedRoot],
        }),
      });
      assert.ok(mislabelledFileReport.blockers.includes(`file-root-denied:${path.resolve(blockedRoot)}`));
      assert.equal(mislabelledFileReport.fileNetworkAuthoritiesAllowed, false);
    } finally {
      await rm(allowedRoot, { recursive: true, force: true });
      await rm(blockedRoot, { recursive: true, force: true });
    }
  });

  it('reports unsupported response statuses separately from uncovered requests', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path', 'GET', { status: 'streaming' })],
      drivers: [new HttpJsonDriver({ origins: ['https://allowed.example'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['network:http'], allowedHttpOrigins: ['https://allowed.example'], allowedHttpMethods: ['GET'] }),
    });
    assert.ok(report.blockers.includes('ERR_RESPONSE_STATUS_NOT_SUPPORTED'));
    assert.equal(report.everyPendingRequestCovered, true);
    assert.equal(report.responseStatusesSupported, false);
  });

  it('reports receiver byte-limit policy blockers for otherwise matching drivers', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [new FixtureModelDriver({ responses: ['ok'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'], maximumRequestBytes: 4096, maximumResponseBytes: 1 }),
    });
    assert.ok(report.blockers.includes('response-limit-exceeds-policy'));
    assert.equal(report.everyPendingRequestCovered, true);
    assert.equal(report.valueSizeLimitsSupported, false);
  });

  it('normalizes partial preflight policies before evaluating blockers', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [new FixtureModelDriver({ responses: ['ok'] })],
      policy: { maximumRequestBytes: 4096 },
    });

    assert.equal(report.everyPendingRequestCovered, true);
    assert.deepEqual(report.blockers, []);
  });

  it('rejects non-numeric receiver byte limits before preflight comparisons', () => {
    assert.throws(
      () => createRunPolicy({ maximumResponseBytes: '1048576' }),
      { code: 'ERR_RUN_POLICY_LIMIT_INVALID' },
    );
    assert.throws(
      () => createRunPolicy({ maximumRequestBytes: Number.NaN }),
      { code: 'ERR_RUN_POLICY_LIMIT_INVALID' },
    );
    assert.throws(
      () => createRunPolicy({ maximumPromptBytes: Number.NaN }),
      { code: 'ERR_RUN_POLICY_LIMIT_INVALID' },
    );
    const promptLimited = createRunPolicy({ maximumRequestBytes: 4096, maximumPromptBytes: 8 });
    assert.equal(promptLimited.maximumRequestBytes, 4096);
    assert.equal(promptLimited.maximumPromptBytes, 8);
  });

  it('keeps default HTTP driver response limits within the default policy', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path')],
      drivers: [new HttpJsonDriver({ origins: ['https://allowed.example'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['network:http'], allowedHttpOrigins: ['https://allowed.example'], allowedHttpMethods: ['GET'] }),
    });

    assert.equal(report.valueSizeLimitsSupported, true);
    assert.equal(report.blockers.includes('response-limit-exceeds-policy'), false);
  });

  it('advertises HTTP request envelope limits separately from body limits', () => {
    const request = httpRequest('https://allowed.example/path', 'POST');
    const driver = new HttpJsonDriver({ origins: ['https://allowed.example'], maximumRequestBytes: 4 });

    assert.equal(request.requestBytes.byteLength > 4, true);
    assert.equal(request.requestBytes.byteLength <= driver.manifest().maximumRequestBytes, true);
  });

  it('blocks HTTP method mismatches during preflight', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path', 'POST')],
      drivers: [new HttpJsonDriver({ origins: ['https://allowed.example'], methods: ['GET'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['network:http'], allowedHttpOrigins: ['https://allowed.example'], allowedHttpMethods: ['POST'] }),
    });

    assert.ok(report.blockers.includes('http-method-driver-denied:POST'));
    assert.equal(report.fileNetworkAuthoritiesAllowed, false);
  });

  it('rejects zero-concurrency driver manifests before preflight can cover requests', () => {
    assert.throws(
      () => assertDriverManifest({ ...policyDeniedFixtureDriver().manifest(), concurrencyLimit: 0 }),
      { code: 'ERR_INVALID_DRIVER_MANIFEST' },
    );
  });

  it('preserves HostRequest identity during fixture model recovery', async () => {
    const driver = new FixtureModelDriver({ responses: ['recovered'] });
    const recovered = await driver.recover({}, {
      hostRequestFingerprint: 'world:host-request:00000000000000a1',
    });
    const decoded = decodeResolutionInputBytes(recovered.resolutionInputBytes);
    assert.equal(decoded.targetHostRequestFingerprint, 0xa1n);
  });

  it('recovers the same fixture model response for the same effect key', async () => {
    const driver = new FixtureModelDriver({ responses: ['first', 'second'] });
    const request = {
      hostRequestFingerprint: 'world:host-request:00000000000000a1',
      idempotencyKeyWorldFingerprint: 'world:key:first',
    };

    const resolved = await driver.resolve({}, request);
    const recovered = await driver.recover({}, request);
    const next = await driver.resolve({}, {
      hostRequestFingerprint: 'world:host-request:00000000000000a2',
      idempotencyKeyWorldFingerprint: 'world:key:second',
    });

    assert.deepEqual([...recovered.resolutionInputBytes], [...resolved.resolutionInputBytes]);
    assert.notDeepEqual([...next.resolutionInputBytes], [...resolved.resolutionInputBytes]);
  });

  it('constrains sandbox file paths, symlinks, and writes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-sandbox-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'world-host-outside-'));
    try {
      const driver = new SandboxFileDriver({ root });
      await assert.rejects(
        () => driver.resolve({}, fileRequest('../escape.txt')),
        { code: 'ERR_SANDBOX_PATH_ESCAPE' },
      );
      await symlink('/tmp', path.join(root, 'link'));
      await assert.rejects(
        () => driver.resolve({}, fileRequest('link')),
        { code: 'ERR_SANDBOX_SYMLINK_REJECTED' },
      );
      await writeFile(path.join(outside, 'secret.txt'), 'secret');
      await symlink(outside, path.join(root, 'linkdir'));
      await assert.rejects(
        () => driver.resolve({}, fileRequest('linkdir/secret.txt')),
        { code: 'ERR_SANDBOX_SYMLINK_REJECTED' },
      );
      await assert.rejects(
        () => new SandboxFileDriver({ root, symlinkPolicy: 'allow' }).resolve({}, fileRequest('linkdir/secret.txt')),
        { code: 'ERR_SANDBOX_PATH_ESCAPE' },
      );
      await assert.rejects(
        () => new SandboxFileDriver({ root, symlinkPolicy: 'allow' }).resolve({}, fileRequest('linkdir/new.txt', { operation: 'write', content: 'nope' })),
        { code: 'ERR_SANDBOX_PATH_ESCAPE' },
      );
      await assert.rejects(
        () => readFile(path.join(outside, 'new.txt')),
        { code: 'ENOENT' },
      );
      await symlink(path.join(outside, 'final-new.txt'), path.join(root, 'final-link'));
      await assert.rejects(
        () => new SandboxFileDriver({ root, symlinkPolicy: 'allow' }).resolve({}, fileRequest('final-link', { operation: 'write', content: 'nope' })),
        { code: 'ERR_SANDBOX_SYMLINK_CREATE_REJECTED' },
      );
      await assert.rejects(
        () => readFile(path.join(outside, 'final-new.txt')),
        { code: 'ENOENT' },
      );
      await assert.rejects(
        () => driver.resolve({}, fileRequest('linkdir/new.txt', { operation: 'write', content: 'nope' })),
        { code: 'ERR_SANDBOX_SYMLINK_REJECTED' },
      );
      await writeFile(path.join(outside, 'hardlink-target.txt'), 'outside hardlink content');
      await link(path.join(outside, 'hardlink-target.txt'), path.join(root, 'hardlink-read.txt'));
      await link(path.join(outside, 'hardlink-target.txt'), path.join(root, 'hardlink-write.txt'));
      await assert.rejects(
        () => driver.resolve({}, fileRequest('hardlink-read.txt')),
        { code: 'ERR_SANDBOX_HARDLINK_REJECTED' },
      );
      await assert.rejects(
        () => driver.resolve({}, fileRequest('hardlink-write.txt', { operation: 'write', content: 'pwned' })),
        { code: 'ERR_SANDBOX_HARDLINK_REJECTED' },
      );
      assert.equal(await readFile(path.join(outside, 'hardlink-target.txt'), 'utf8'), 'outside hardlink content');
      await writeFile(path.join(root, 'out.txt'), '');
      const write = await driver.resolve({}, fileRequest('out.txt', { operation: 'write', content: 'world carrier updated the fixture' }));
      const writeImage = decodeResolutionInputBytes(write.resolutionInputBytes).responseValueImageBytes;
      const writeImageView = new DataView(writeImage.buffer, writeImage.byteOffset, writeImage.byteLength);
      assert.equal(writeImageView.getUint32(0, true), 1);
      assert.equal(writeImageView.getUint32(4, true), 1);
      assert.equal(await readFile(path.join(root, 'out.txt'), 'utf8'), 'world carrier updated the fixture');
      await mkdir(path.join(root, 'nested'));
      await writeFile(path.join(root, 'nested', 'out.txt'), '');
      await driver.resolve({}, fileRequest('nested/out.txt', { operation: 'write', content: 'nested write works' }));
      assert.equal(await readFile(path.join(root, 'nested', 'out.txt'), 'utf8'), 'nested write works');
      const edgeWrite = fileRequest('edge.txt', { operation: 'write', content: '1234' }, 'key:edge');
      const edgeDriver = new SandboxFileDriver({ root, maximumWriteBytes: 4 });
      assert.equal(edgeWrite.requestBytes.byteLength > 4, true);
      assert.equal(edgeWrite.requestBytes.byteLength <= edgeDriver.manifest().maximumRequestBytes, true);
      await writeFile(path.join(root, 'edge.txt'), '');
      await edgeDriver.resolve({}, edgeWrite);
      assert.equal(await readFile(path.join(root, 'edge.txt'), 'utf8'), '1234');
      await writeFile(path.join(root, 'safe.txt'), '');
      await driver.resolve({}, fileRequest('safe.txt', { operation: 'write', content: 'safe' }, '../../../../outside'));
      assert.equal(await readFile(path.join(root, 'safe.txt'), 'utf8'), 'safe');
      await assert.rejects(
        () => readFile(path.join(outside, 'outside.tmp')),
        { code: 'ENOENT' },
      );
      const policyJournal = new EffectJournal({
        store: new MemoryStore(),
        runId: 'run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'turn:0',
        policy: { allowBestEffort: true, maximumResponseBytes: 1 },
      });
      await assert.rejects(
        () => policyJournal.resolve({}, {
          ...fileRequest('policy-blocked.txt', { operation: 'write', content: 'blocked-before-rename' }),
          idempotencyKeyBytes: fromUtf8('policy-blocked-key'),
        }, new SandboxFileDriver({ root })),
        { code: 'ERR_EFFECT_RESPONSE_LIMIT_EXCEEDS_POLICY' },
      );
      await assert.rejects(
        () => readFile(path.join(root, 'policy-blocked.txt')),
        { code: 'ENOENT' },
      );
      const recovered = await driver.recover({}, {
        idempotencyKeyWorldFingerprint: 'key:out.txt',
        hostRequestFingerprint: 'sha256:00000000000000a1',
      });
      const decoded = decodeResolutionInputBytes(recovered.resolutionInputBytes);
      assert.equal(decoded.targetHostRequestFingerprint, 0xa1n);
      assert.deepEqual([...decoded.responseValueImageBytes], [...writeImage]);
      const missing = await driver.resolve({}, fileRequest('missing.txt'));
      const missingDecoded = decodeResolutionInputBytes(missing.resolutionInputBytes);
      assert.equal(missingDecoded.status, 1);
      assert.equal(missingDecoded.responseValueImageBytes.byteLength, 0);
      await writeFile(path.join(root, 'empty.txt'), '');
      const emptyReadJournal = new EffectJournal({
        store: new MemoryStore(),
        runId: 'empty-read-run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'turn:0',
        policy: { allowBestEffort: true },
      });
      const emptyRead = await emptyReadJournal.resolve({}, {
        ...fileRequest('empty.txt', { operation: 'read' }, 'key:empty-read'),
        idempotencyKeyBytes: fromUtf8('empty-read-key'),
      }, driver);
      const emptyReadImage = decodeResolutionInputBytes(emptyRead.resolutionInputBytes).responseValueImageBytes;
      const emptyReadView = new DataView(emptyReadImage.buffer, emptyReadImage.byteOffset, emptyReadImage.byteLength);
      assert.equal(emptyRead.record.state, 'resolved');
      assert.equal(emptyReadView.getUint32(0, true), 1);
      assert.equal(emptyReadView.getUint32(4, true), 1);
      await writeFile(path.join(root, 'large.txt'), 'too-large');
      await assert.rejects(
        () => new SandboxFileDriver({ root, maximumReadBytes: 1 }).resolve({}, fileRequest('large.txt')),
        { code: 'ERR_SANDBOX_FILE_READ_TOO_LARGE' },
      );
      if (process.platform !== 'win32') {
        const fifoPath = path.join(root, 'pipe');
        const fifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
        assert.equal(fifo.status, 0, fifo.stderr);
        await assert.rejects(
          () => driver.resolve({}, fileRequest('pipe')),
          { code: 'ERR_SANDBOX_FILE_NOT_REGULAR' },
        );
        await assert.rejects(
          () => driver.resolve({}, fileRequest('pipe', { operation: 'write', content: 'blocked' })),
          { code: 'ERR_SANDBOX_FILE_NOT_REGULAR' },
        );
      }
      const restarted = new SandboxFileDriver({ root });
      await assert.rejects(() => restarted.recover({}, {
        actuatorRef: 'sandbox:file',
        descriptorFingerprint: 'descriptor:sandbox-file',
        idempotencyKeyWorldFingerprint: 'key:restart.txt',
        hostRequestFingerprint: 'sha256:00000000000000a2',
        requestBytes: fromUtf8(stableJson({ path: 'restart.txt', operation: 'write', content: 'recovered after restart' })),
      }), { code: 'ERR_SANDBOX_FILE_RECOVERY_UNAVAILABLE' });
      await assert.rejects(
        () => readFile(path.join(root, 'restart.txt')),
        { code: 'ENOENT' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects HTTP origins and methods outside allowlists without leaking credentials', async () => {
    const driver = new HttpJsonDriver({ origins: ['https://allowed.example'], methods: ['GET'], credentials: { headers: { Authorization: 'secret', 'X-Trace': 'ok', 'Idempotency-Key': 'credential-key' } } });
    assert.deepEqual(driver.manifest().diagnostics.origins, ['https://allowed.example']);
    await assert.rejects(
      () => driver.resolve({}, httpRequest('https://blocked.example/path')),
      { code: 'ERR_HTTP_ORIGIN_REJECTED' },
    );
    await assert.rejects(
      () => driver.resolve({}, httpRequest('https://allowed.example/path', 'POST')),
      { code: 'ERR_HTTP_METHOD_REJECTED' },
    );
    const originalFetch = globalThis.fetch;
    let requestHeaders = null;
    try {
      globalThis.fetch = async (url, options) => {
        requestHeaders = options.headers;
        return new Response('{"ok":true}', { status: 200, headers: { 'x-request-id': 'request-1' } });
      };
      const result = await driver.resolve({}, httpRequest('https://allowed.example/path'));
      assert.equal(requestHeaders.Authorization, 'secret');
      assert.equal(requestHeaders['X-Trace'], 'ok');
      assert.equal(requestHeaders['Idempotency-Key'], 'key:https://allowed.example/path');
      assert.equal(JSON.stringify(result.diagnostics).includes('secret'), false);
      globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://blocked.example/next' } });
      await assert.rejects(
        () => driver.resolve({}, httpRequest('https://allowed.example/redirect')),
        { code: 'ERR_HTTP_REDIRECT_REJECTED' },
      );
      const edge = new HttpJsonDriver({ origins: ['https://allowed.example'], maximumResponseBytes: 4 });
      globalThis.fetch = async () => new Response('1234');
      const edgeResult = await edge.resolve({}, httpRequest('https://allowed.example/edge'));
      const edgePayload = decodeResolutionInputBytes(edgeResult.resolutionInputBytes).responseValueImageBytes;
      const edgePayloadView = new DataView(edgePayload.buffer, edgePayload.byteOffset, edgePayload.byteLength);
      assert.equal(edgePayloadView.getUint32(0, true), 1);
      assert.equal(edgePayloadView.getUint32(4, true), 1);
      assert.equal(edgePayload.byteLength > 4, true);
      assert.equal(edgePayload.byteLength <= edge.manifest().maximumResponseBytes, true);
      globalThis.fetch = async () => new Response('server failed', { status: 500 });
      const failed = await driver.resolve({}, httpRequest('https://allowed.example/fail', 'GET', { status: 'http_error' }));
      const failedDecoded = decodeResolutionInputBytes(failed.resolutionInputBytes);
      assert.equal(failedDecoded.status, 1);
      assert.equal(failedDecoded.responseValueImageBytes.byteLength, 0);
      const failedSmall = new HttpJsonDriver({ origins: ['https://allowed.example'], maximumResponseBytes: 4 });
      globalThis.fetch = async () => new Response('too-large-error-body', { status: 500 });
      const failedSmallResult = await failedSmall.resolve({}, httpRequest('https://allowed.example/fail-small', 'GET', { status: 'http_error' }));
      assert.equal(decodeResolutionInputBytes(failedSmallResult.resolutionInputBytes).status, 1);
      const small = new HttpJsonDriver({ origins: ['https://allowed.example'], maximumResponseBytes: 4 });
      globalThis.fetch = async () => new Response('too-large');
      await assert.rejects(
        () => small.resolve({}, httpRequest('https://allowed.example/large')),
        { code: 'ERR_HTTP_RESPONSE_TOO_LARGE' },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses raw HTTP driver configured default methods when request URLs omit methods during resolve', async () => {
    const driver = new HttpJsonDriver({ origins: ['https://allowed.example'], methods: ['POST'] });
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    try {
      globalThis.fetch = async (url, options) => {
        fetchCount += 1;
        assert.equal(url.href, 'https://allowed.example/path');
        assert.equal(options.method, 'POST');
        return new Response('{"ok":true}', { status: 200 });
      };

      await driver.resolve({}, {
        ...httpRequest('https://allowed.example/path'),
        requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/path', body: { prompt: 'hi' } })),
      });

      assert.equal(fetchCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function policyDeniedFixtureDriver() {
  return {
    manifest() {
      return {
        driverId: 'policy-denied-fixture',
        supportedActuatorRefs: ['fixture:model'],
        supportedDescriptorFingerprints: ['descriptor:fixture-model'],
        supportedActuationClasses: ['fixture'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024 * 1024,
        maximumResponseBytes: 1024 * 1024,
        recoveryClass: EffectRecoveryClass.pure,
        concurrencyLimit: 1,
        authorityLabels: ['denied:fixture'],
        diagnostics: {},
      };
    },
  };
}

function fixtureDriverWithAuthority(authorityLabels, options = {}) {
  return {
    manifest() {
      return {
        driverId: options.driverId ?? 'fixture-model-custom',
        supportedActuatorRefs: [options.actuatorRef ?? 'fixture:model'],
        supportedDescriptorFingerprints: [options.descriptorFingerprint ?? 'descriptor:fixture-model'],
        supportedActuationClasses: options.actuationClasses ?? ['fixture'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024 * 1024,
        maximumResponseBytes: options.maximumResponseBytes ?? 1024 * 1024,
        recoveryClass: options.recoveryClass ?? EffectRecoveryClass.pure,
        concurrencyLimit: 1,
        authorityLabels,
        diagnostics: options.diagnostics ?? {},
      };
    },
  };
}

function blobRefForBytes(bytes) {
  return makeBlobRef(createHash('sha256').update(bytes).digest('hex'), bytes.byteLength);
}

function blobRefKey(ref) {
  return `${ref.algorithm}:${ref.checksum}:${ref.byteLength}`;
}

function fixtureRequest() {
  return {
    actuatorRef: 'fixture:model',
    descriptorFingerprint: 'descriptor:fixture-model',
    actuationClass: 'fixture',
    responseSchema: { status: 'ok' },
    requestBytes: fromUtf8('prompt'),
  };
}

function fileRequest(filePath, request = { operation: 'read' }, idempotencyKeyWorldFingerprint = `key:${filePath}`) {
  return {
    actuatorRef: 'sandbox:file',
    descriptorFingerprint: 'descriptor:sandbox-file',
    actuationClass: 'file',
    responseSchema: { status: 'ok' },
    idempotencyKeyWorldFingerprint,
    requestBytes: fromUtf8(stableJson({ path: filePath, ...request })),
  };
}

function httpRequest(url, method = 'GET', responseSchema = { status: 'ok' }) {
  return {
    actuatorRef: 'http:json',
    descriptorFingerprint: 'descriptor:http-json',
    actuationClass: 'http',
    responseSchema,
    idempotencyKeyWorldFingerprint: `key:${url}`,
    requestBytes: fromUtf8(stableJson({ url, method })),
  };
}
