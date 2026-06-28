import { EffectRecoveryClass } from '../core/actuator.mjs';
import { fail, fromUtf8, stableJson } from '../core/store.mjs';
import { encodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';
import { encodeCanonicalValueImage } from '../protocol/world_loaded_value_codec.mjs';

const DEFAULT_ACTUATOR_REF = 'fixture:agent-model';
const DEFAULT_DESCRIPTOR = 'descriptor:fixture-agent-model';

export class FixtureAgentModelDriver {
  constructor({ scenario = 'skeleton', actuatorRef = DEFAULT_ACTUATOR_REF, descriptorFingerprint = DEFAULT_DESCRIPTOR } = {}) {
    this.scenario = scenario;
    this.actuatorRef = actuatorRef;
    this.descriptorFingerprint = descriptorFingerprint;
    this.responsesByKey = new Map();
    this.calls = 0;
  }

  manifest() {
    return {
      driverId: 'fixture-agent-model',
      supportedActuatorRefs: [this.actuatorRef],
      supportedDescriptorFingerprints: [this.descriptorFingerprint],
      supportedActuationClasses: ['model'],
      supportedResponseStatuses: ['ok', 'final'],
      maximumRequestBytes: 1024 * 1024,
      maximumResponseBytes: 1024 * 1024,
      recoveryClass: EffectRecoveryClass.pure,
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

  async resolve(context, hostRequest) {
    const key = responseKey(hostRequest);
    if (key && this.responsesByKey.has(key)) {
      return { resolutionInputBytes: resolutionInput(hostRequest, this.responsesByKey.get(key)) };
    }
    this.calls += 1;
    const prompt = parseDecisionPrompt(hostRequest.requestBytes);
    const response = actionForPrompt(this.scenario, prompt);
    const bytes = agentActionValueImage(response);
    if (key) this.responsesByKey.set(key, new Uint8Array(bytes));
    return { resolutionInputBytes: resolutionInput(hostRequest, bytes) };
  }

  async recover(context, effectRecord) {
    if (!effectRecord.resolutionInputRef) return await this.resolve(context, effectRecord);
    fail('ERR_FIXTURE_AGENT_MODEL_RECOVERY_SHOULD_REUSE_PERSISTED_OUTCOME');
  }
}

export function agentActionValueImage(action) {
  return encodeCanonicalValueImage({
    bytes: fromUtf8(stableJson({
      schema: 'boundary.Agent.Action.v0',
      action,
    })),
    dynamicSize: true,
  });
}

export function parseDecisionPrompt(bytes) {
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
  if (scenario === 'malformed') {
    return { variant: 'malformed', payload: 'not an Agent.Action variant' };
  }
  if (scenario === 'unknown-tool') {
    return { variant: 'tool', toolId: 'unknown_tool', payload: '' };
  }
  if (scenario === 'budget') {
    return { variant: 'tool', toolId: 'actuate', payload: '' };
  }
  if (observation === 'goal=invoke') {
    return { variant: 'tool', toolId: 'actuate', payload: '' };
  }
  if (observation === 'actuate') {
    return { variant: 'final', text: 'final=actuate skeleton complete' };
  }
  if (observation === 'goal=fixture') {
    return { variant: 'tool', toolId: 'read_file', payload: 'input.txt' };
  }
  if (observation === 'rewrite this file through the agent loop') {
    return { variant: 'tool', toolId: 'write_file', payload: 'output.txt\\nactuate updated the fixture' };
  }
  if (observation === 'write=ok') {
    return { variant: 'final', text: 'final=fixture updated' };
  }
  fail('ERR_FIXTURE_AGENT_MODEL_PROMPT_UNSUPPORTED', `unsupported fixture observation: ${observation}`);
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
