import { EffectRecoveryClass } from '../core/actuator.mjs';
import { CapabilityPreflightReport, DryRunReport, ShadowReport, capabilityHostClaimBytes, defaultCapabilityPreflight } from '../core/capability_driver.mjs';
import { createCapabilityPolicy } from '../core/capability_policy.mjs';
import { fail, fromUtf8, stableJson } from '../core/store.mjs';
import { decodeResolutionInputBytes, encodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';
import { decodeCanonicalValueImage } from '../protocol/world_loaded_value_codec.mjs';
import { FixtureAgentModelDriver, agentActionValueImage, parseDecisionPrompt } from './fixture_agent_model_driver.mjs';
import { GenericHttpJsonCapabilityDriver } from './generic_http_json_capability_driver.mjs';

const DEFAULT_ALLOWED_TOOL_IDS = Object.freeze(['actuate', 'read_file', 'write_file']);
const textDecoder = new TextDecoder();

export class FixtureAgentModelCapabilityDriver extends FixtureAgentModelDriver {
  preflight(context, hostRequest) {
    return defaultCapabilityPreflight(this.manifest(), hostRequest);
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
    return new ShadowReport({
      liveInvoked: false,
      schemaAccepted: Boolean(recordedResolution),
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
    return {
      ...this.http.manifest(),
      driverId: 'generic-http-json-model',
      supportedActuatorRefs: ['model:decision'],
      supportedDescriptorFingerprints: ['descriptor:agent-decision-prompt'],
      supportedActuationClasses: ['model'],
      supportedResponseStatuses: ['ok', 'failed', 'deferred'],
      recoveryClass: EffectRecoveryClass.idempotent,
      authorityLabels: ['model:http-json', 'network:http'],
      diagnostics: {
        ...this.http.manifest().diagnostics,
        vendorSpecific: false,
        outputSchema: 'boundary.Agent.Action.v0',
        allowedToolIds: [...this.allowedToolIds],
      },
    };
  }

  preflight(context, hostRequest) {
    const structural = defaultCapabilityPreflight(this.manifest(), hostRequest);
    const blockers = [...structural.blockers];
    try {
      parseDecisionPrompt(hostRequest.requestBytes);
      assertLiveModelBudgetAllows(context?.policy);
    } catch (error) {
      blockers.push(error.code ?? 'ERR_MODEL_PROMPT_INVALID');
    }
    if (blockers.length) return new CapabilityPreflightReport({ accepted: false, blockers });
    return this.http.preflight(context, {
      ...hostRequest,
      actuatorRef: 'http:json',
      descriptorFingerprint: 'descriptor:http-json',
      actuationClass: 'http',
    });
  }

  async resolve(context, hostRequest) {
    parseDecisionPrompt(hostRequest.requestBytes);
    assertLiveModelBudgetAllows(context?.policy);
    const result = await this.http.resolve(context, {
      ...hostRequest,
      actuatorRef: 'http:json',
      descriptorFingerprint: 'descriptor:http-json',
      actuationClass: 'http',
    });
    const resolution = decodeResolutionInputBytes(result.resolutionInputBytes);
    if (resolution.status !== 0) {
      return modelResolutionFromTransport(result, resolution, { status: resolution.status === 4 ? 'deferred' : 'failed' });
    }
    const action = decodeAgentActionFromValueImage(resolution.responseValueImageBytes, { allowedToolIds: this.allowedToolIds });
    return modelResolutionFromTransport(result, resolution, {
      status: 'ok',
      responseValueImageBytes: agentActionValueImage(action),
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
    const prompt = parseDecisionPrompt(hostRequest.requestBytes);
    return new DryRunReport({
      wouldInvoke: true,
      proposedAction: { endpoint: redactedEndpoint(this.http.endpointUrl), observationBytes: prompt.observation.length },
    });
  }

  shadow(context, hostRequest, recordedResolution) {
    return new ShadowReport({
      liveInvoked: false,
      schemaAccepted: Boolean(recordedResolution),
    });
  }
}

function assertLiveModelBudgetAllows(inputPolicy = {}) {
  const policy = createCapabilityPolicy(inputPolicy);
  if (policy.maximumLiveModelCalls < 1) fail('ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED');
}

function redactedEndpoint(endpointUrl) {
  const endpoint = new URL(endpointUrl);
  return `${endpoint.origin}${endpoint.pathname}`;
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

function modelResolutionFromTransport(result, resolution, { status, responseValueImageBytes = new Uint8Array(), action = null }) {
  const hostClaimBytes = capabilityHostClaimBytes({
    driver: 'generic-http-json-model',
    transportDriver: 'generic-http-json',
    status,
    transportStatus: result.diagnostics?.status ?? null,
    outputSchema: 'boundary.Agent.Action.v0',
    actionVariant: action?.variant ?? null,
  });
  return {
    ...result,
    hostClaimBytes,
    resolutionInputBytes: encodeResolutionInputBytes({
      ...resolution,
      status: status === 'ok' ? 0 : status === 'deferred' ? 4 : 2,
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
      })),
    }),
    diagnostics: {
      ...result.diagnostics,
      status,
      transportStatus: result.diagnostics?.status ?? null,
      outputSchema: 'boundary.Agent.Action.v0',
      actionVariant: action?.variant ?? null,
      toolId: action?.variant === 'tool' ? action.toolId : null,
    },
  };
}
