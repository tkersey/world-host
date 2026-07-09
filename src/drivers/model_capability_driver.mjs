import { EffectRecoveryClass } from '../core/actuator.mjs';
import { CapabilityPreflightReport, DryRunReport, ShadowReport, assertCapabilityResolutionBoundary, capabilityHostClaimBytes, defaultCapabilityPreflight } from '../core/capability_driver.mjs';
import { assertResolutionAccepted } from '../core/effect_journal.mjs';
import { assertCapabilityPolicyAllows, createCapabilityPolicy } from '../core/capability_policy.mjs';
import { fail, fromUtf8, stableJson } from '../core/store.mjs';
import { decodeResolutionInputBytes, encodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';
import { decodeCanonicalValueImage } from '../protocol/world_loaded_value_codec.mjs';
import { FixtureAgentModelDriver, agentActionValueImage, parseDecisionPrompt } from './fixture_agent_model_driver.mjs';
import { GenericHttpJsonCapabilityDriver } from './generic_http_json_capability_driver.mjs';

const DEFAULT_ALLOWED_TOOL_IDS = Object.freeze(['actuate', 'read_file', 'write_file']);
const textDecoder = new TextDecoder();

export class FixtureAgentModelCapabilityDriver extends FixtureAgentModelDriver {
  preflight(context, hostRequest) {
    const structural = defaultCapabilityPreflight(this.manifest(), hostRequest);
    const blockers = [...structural.blockers];
    if (!blockers.length) {
      try {
        parseDecisionPrompt(hostRequest.requestBytes);
      } catch (error) {
        blockers.push(error.code ?? 'ERR_AGENT_DECISION_PROMPT_INVALID');
      }
    }
    if (blockers.length) return new CapabilityPreflightReport({ accepted: false, blockers });
    return structural;
  }

  dryRun(context, hostRequest) {
    const prompt = parseDecisionPrompt(hostRequest.requestBytes);
    return new DryRunReport({
      wouldInvoke: false,
      proposedAction: { driver: 'fixture-agent-model', observation: prompt.observation },
      diagnostics: { deterministic: true },
    });
  }

  shadow(context, hostRequest, recordedResolution) {
    try {
      parseDecisionPrompt(hostRequest.requestBytes);
    } catch (error) {
      return new ShadowReport({
        liveInvoked: false,
        schemaAccepted: false,
        diagnostics: { driver: 'fixture-agent-model', blocker: error.code ?? 'ERR_AGENT_DECISION_PROMPT_INVALID' },
      });
    }
    return new ShadowReport({
      liveInvoked: false,
      schemaAccepted: recordedResolutionAccepted(recordedResolution, hostRequest, this.manifest(), context?.policy ?? {}),
      diagnostics: { driver: 'fixture-agent-model' },
    });
  }
}

export class GenericHttpJsonModelDriver {
  constructor(options = {}) {
    this.allowedToolIds = new Set(options.allowedToolIds ?? DEFAULT_ALLOWED_TOOL_IDS);
    this.http = new GenericHttpJsonCapabilityDriver({
      ...options,
      endpointUrl: options.endpointUrl,
      methods: options.methods ?? ['POST'],
      origins: options.origins,
      responseExtractionPath: options.responseExtractionPath ?? 'action',
    });
  }

  manifest() {
    const httpManifest = this.http.manifest();
    const outputValidation = modelOutputValidationDiagnostics(this.allowedToolIds);
    return {
      ...httpManifest,
      driverId: 'generic-http-json-model',
      supportedActuatorRefs: ['model:decision'],
      supportedDescriptorFingerprints: ['descriptor:agent-decision-prompt'],
      supportedActuationClasses: ['model'],
      supportedResponseStatuses: ['ok', 'http_error', 'failed', 'deferred'],
      maximumRequestBytes: this.http.maximumRequestBytes,
      recoveryClass: EffectRecoveryClass.idempotent,
      authorityLabels: ['model:http-json', 'network:http'],
      diagnostics: {
        ...httpManifest.diagnostics,
        vendorSpecific: false,
        outputSchema: 'boundary.Agent.Action.v0',
        allowedToolIds: [...outputValidation.allowedToolIds],
        modelOutputValidation: outputValidation,
      },
    };
  }

  preflight(context, hostRequest) {
    const structural = defaultCapabilityPreflight(this.manifest(), hostRequest);
    const blockers = [...structural.blockers];
    if (!blockers.length) {
      try {
        parseDecisionPrompt(hostRequest.requestBytes);
        this.#assertPolicyAllows(context, hostRequest);
      } catch (error) {
        blockers.push(error.code ?? 'ERR_MODEL_PROMPT_INVALID');
      }
    }
    if (blockers.length) return new CapabilityPreflightReport({ accepted: false, blockers });
    return this.http.preflight(transportContext(context), transportHostRequest(hostRequest));
  }

  async resolve(context, hostRequest) {
    parseDecisionPrompt(hostRequest.requestBytes);
    this.#assertPolicyAllows(context, hostRequest);
    const result = await this.http.resolve(transportContext(context), transportHostRequest(hostRequest));
    const resolution = decodeResolutionInputBytes(result.resolutionInputBytes);
    if (resolution.status !== 0) {
      return modelResolutionFromTransport(result, resolution, { status: modelStatusForTransportStatus(resolution.status, hostRequest.responseSchema) });
    }
    let action;
    try {
      action = decodeAgentActionFromValueImage(resolution.responseValueImageBytes, { allowedToolIds: this.allowedToolIds });
    } catch (error) {
      const status = modelResponseStatus(hostRequest, 'failed', 'ERR_MODEL_FAILED_STATUS_UNSUPPORTED', 'failed model output cannot satisfy fixed response schema');
      return modelResolutionFromTransport(result, resolution, {
        status,
        failureCode: error.code ?? 'ERR_AGENT_ACTION_MALFORMED',
      });
    }
    if (hostRequest.responseSchema?.status === 'failed') {
      return modelResolutionFromTransport(result, resolution, {
        status: 'failed',
        failureCode: 'ERR_MODEL_OK_STATUS_UNSUPPORTED',
      });
    }
    modelResponseStatus(hostRequest, 'ok', 'ERR_MODEL_OK_STATUS_UNSUPPORTED', 'successful model output cannot satisfy fixed response schema');
    return modelResolutionFromTransport(result, resolution, {
      status: 'ok',
      responseValueImageBytes: agentActionValueImage(action),
      action,
    });
  }

  #assertPolicyAllows(context, hostRequest) {
    const manifest = this.manifest();
    const policy = context?.policy ?? {};
    const action = context?.action ?? null;
    assertCapabilityPolicyAllows({
      manifest,
      hostRequest,
      policy,
      mode: 'live',
      action,
      enforceNetworkTarget: false,
    });
    assertCapabilityPolicyAllows({
      manifest,
      hostRequest: modelPolicyHostRequest(hostRequest, manifest),
      policy,
      mode: 'live',
      action,
    });
  }

  async recover(context, effectRecord) {
    return await this.resolve(context, {
      actuatorRef: 'model:decision',
      descriptorFingerprint: 'descriptor:agent-decision-prompt',
      actuationClass: 'model',
      requestBytes: effectRecord.requestBytes,
      responseSchema: effectRecord.responseSchema,
      idempotencyKeyWorldFingerprint: effectRecord.idempotencyKeyWorldFingerprint,
      hostRequestFingerprint: effectRecord.hostRequestFingerprint,
    });
  }

  decide(context, decisionPrompt) {
    if (!decisionPrompt || typeof decisionPrompt !== 'object') fail('ERR_AGENT_DECISION_PROMPT_MALFORMED');
    return { variant: 'defer', reason: 'generic-http-json-model-decision-requires-resolve' };
  }

  dryRun(context, hostRequest) {
    const manifest = this.manifest();
    assertModelDryRunPolicyAllows(context, manifest, hostRequest);
    const prompt = parseDecisionPrompt(hostRequest.requestBytes);
    this.http.dryRun(transportContext(context), transportHostRequest(hostRequest));
    const target = modelPolicyTarget(hostRequest, manifest);
    return new DryRunReport({
      wouldInvoke: true,
      proposedAction: { endpoint: redactedEndpoint(target.url), observationBytes: fromUtf8(prompt.observation).byteLength },
    });
  }

  shadow(context, hostRequest, recordedResolution) {
    const manifest = this.manifest();
    assertModelDryRunPolicyAllows(context, manifest, hostRequest);
    parseDecisionPrompt(hostRequest.requestBytes);
    this.http.dryRun(transportContext(context), transportHostRequest(hostRequest));
    return new ShadowReport({
      liveInvoked: false,
      schemaAccepted: recordedResolutionAccepted(recordedResolution, hostRequest, manifest, context?.policy ?? {}),
    });
  }
}

function modelOutputValidationDiagnostics(allowedToolIds) {
  return {
    outputSchema: 'boundary.Agent.Action.v0',
    allowedToolIds: [...allowedToolIds].sort(),
  };
}

function redactedEndpoint(endpointUrl) {
  const endpoint = new URL(endpointUrl);
  return `${endpoint.origin}${endpoint.pathname}`;
}

function assertModelDryRunPolicyAllows(context, manifest, hostRequest) {
  const policy = createCapabilityPolicy(context?.policy ?? {});
  assertCapabilityPolicyAllows({
    manifest,
    hostRequest,
    policy,
    mode: 'dry-run',
    requireEffectOptIn: false,
    enforceNetworkTarget: false,
    checkNetworkTarget: false,
    checkFileRoot: false,
    checkRecoveryClass: false,
    enforceApprovalRequirements: false,
  });
  assertCapabilityPolicyAllows({
    manifest,
    hostRequest: modelPolicyHostRequest(hostRequest, manifest),
    policy,
    mode: 'dry-run',
    requireEffectOptIn: false,
    enforceNetworkTarget: true,
    checkNetworkTarget: policy.allowedOrigins.size > 0 || policy.allowedMethods.size > 0,
    checkFileRoot: false,
    checkRecoveryClass: false,
    enforceApprovalRequirements: false,
  });
}

function modelPolicyHostRequest(hostRequest, manifest) {
  return {
    ...hostRequest,
    policyRequestBytes: hostRequest.requestBytes,
    requestBytes: fromUtf8(stableJson(modelPolicyTarget(hostRequest, manifest))),
  };
}

function modelPolicyTarget(hostRequest, manifest) {
  const diagnostics = manifest?.diagnostics ?? {};
  const configured = {
    url: diagnostics.configuredEndpointUrl ?? diagnostics.configuredOrigin,
    method: diagnostics.defaultMethod ?? 'POST',
  };
  if (diagnostics.endpointSource !== 'request-or-config') return configured;
  try {
    const payload = JSON.parse(new TextDecoder().decode(hostRequest.requestBytes));
    return {
      url: Object.prototype.hasOwnProperty.call(payload, 'url') ? payload.url : configured.url,
      method: Object.prototype.hasOwnProperty.call(payload, 'method') ? payload.method : configured.method,
    };
  } catch {
    return configured;
  }
}

function transportHostRequest(hostRequest) {
  return {
    ...hostRequest,
    actuatorRef: 'http:json',
    descriptorFingerprint: 'descriptor:http-json',
    actuationClass: 'http',
    responseSchema: transportResponseSchema(hostRequest.responseSchema),
  };
}

function transportContext(context = {}) {
  const policy = context?.policy ?? {};
  return {
    ...context,
    policy: {
      ...policy,
      allowedCapabilityPacks: [],
      deniedCapabilityPacks: [],
    },
  };
}

function recordedResolutionAccepted(recordedResolution, hostRequest, manifest, policy) {
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

function transportResponseSchema(responseSchema) {
  if (!responseSchema || responseSchema.status !== 'failed') return responseSchema;
  return null;
}

export function decodeAgentActionFromResolutionInput(resolutionInputBytes, options = {}) {
  const resolution = decodeResolutionInputBytes(resolutionInputBytes);
  if (resolution.status !== 0) fail('ERR_AGENT_ACTION_RESOLUTION_NOT_RESPONDED');
  return decodeAgentActionFromValueImage(resolution.responseValueImageBytes, options);
}

export function decodeAgentActionFromValueImage(responseValueImageBytes, options = {}) {
  const payloadBytes = decodeCanonicalValueImage(responseValueImageBytes).payload;
  let payload;
  try {
    payload = JSON.parse(textDecoder.decode(payloadBytes));
  } catch {
    fail('ERR_AGENT_ACTION_MALFORMED');
  }
  const action = payload?.schema === 'boundary.Agent.Action.v0' ? payload.action : payload?.body;
  return validateAgentAction(action, options);
}

export function validateAgentAction(action, { allowedToolIds = DEFAULT_ALLOWED_TOOL_IDS } = {}) {
  const allowed = allowedToolIds instanceof Set ? allowedToolIds : new Set(allowedToolIds);
  if (!action || typeof action !== 'object' || typeof action.variant !== 'string') {
    fail('ERR_AGENT_ACTION_MALFORMED');
  }
  if (action.variant === 'final') {
    if (typeof action.text !== 'string') fail('ERR_AGENT_ACTION_MALFORMED');
    return { variant: 'final', text: action.text };
  }
  if (action.variant === 'tool') {
    if (typeof action.toolId !== 'string' || typeof action.payload !== 'string') fail('ERR_AGENT_ACTION_MALFORMED');
    if (!allowed.has(action.toolId)) fail('ERR_AGENT_ACTION_TOOL_UNKNOWN');
    return { variant: 'tool', toolId: action.toolId, payload: action.payload };
  }
  if (action.variant === 'defer') {
    if (typeof action.reason !== 'string') fail('ERR_AGENT_ACTION_MALFORMED');
    return { variant: 'defer', reason: action.reason };
  }
  fail('ERR_AGENT_ACTION_MALFORMED');
}

function modelResolutionFromTransport(result, resolution, { status, responseValueImageBytes = new Uint8Array(), action = null, failureCode = null }) {
  const hostClaimBytes = capabilityHostClaimBytes({
    driver: 'generic-http-json-model',
    transportDriver: 'generic-http-json',
    status,
    transportStatus: result.diagnostics?.status ?? null,
    outputSchema: 'boundary.Agent.Action.v0',
    actionVariant: action?.variant ?? null,
    failureCode,
  });
  return {
    ...result,
    hostClaimBytes,
    resolutionInputBytes: encodeResolutionInputBytes({
      ...resolution,
      status: modelWireStatus(status),
      responseValueImageBytes,
      hostClaimBytes,
      metadata: fromUtf8(stableJson({
        driver: 'generic-http-json-model',
        transportDriver: 'generic-http-json',
        status,
        transportStatus: result.diagnostics?.status ?? null,
        outputSchema: 'boundary.Agent.Action.v0',
        actionVariant: action?.variant ?? null,
        toolId: action?.variant === 'tool' ? action.toolId : null,
        failureCode,
      })),
    }),
    diagnostics: {
      ...result.diagnostics,
      status,
      transportStatus: result.diagnostics?.status ?? null,
      outputSchema: 'boundary.Agent.Action.v0',
      actionVariant: action?.variant ?? null,
      toolId: action?.variant === 'tool' ? action.toolId : null,
      failureCode,
    },
  };
}

function modelStatusForTransportStatus(status, responseSchema = null) {
  if ((status === 1 || status === 2 || status === 4) && responseSchema?.status === 'failed') return 'failed';
  if (status === 1) return 'http_error';
  if (status === 4) return 'deferred';
  return 'failed';
}

function modelResponseStatus(hostRequest, status, code, message) {
  const expected = hostRequest?.responseSchema?.status;
  if (expected == null || expected === status) return status;
  fail(code, message);
}

function modelWireStatus(status) {
  if (status === 'ok') return 0;
  if (status === 'http_error') return 1;
  if (status === 'deferred') return 4;
  return 2;
}
