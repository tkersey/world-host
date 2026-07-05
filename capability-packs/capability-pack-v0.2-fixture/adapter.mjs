const DEFAULT_ACTUATOR_REF = 'fixture:agent-model';
const DEFAULT_DESCRIPTOR = 'descriptor:fixture-agent-model';

class CarrierError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'CarrierError';
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new CarrierError(code, message);
}

function fromUtf8(value) {
  return new TextEncoder().encode(value);
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]));
}

function parseDecisionPrompt(bytes) {
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
  if (scenario === 'malformed') return { variant: 'malformed', payload: 'not an Agent.Action variant' };
  if (scenario === 'unknown-tool') return { variant: 'tool', toolId: 'unknown_tool', payload: '' };
  if (scenario === 'budget') return { variant: 'tool', toolId: 'actuate', payload: '' };
  if (observation === 'goal=invoke') return { variant: 'tool', toolId: 'actuate', payload: '' };
  if (observation === 'actuate') return { variant: 'final', text: 'final=actuate skeleton complete' };
  if (observation === 'goal=fixture') return { variant: 'tool', toolId: 'read_file', payload: 'input.txt' };
  if (observation === 'rewrite this file through the agent loop') {
    return { variant: 'tool', toolId: 'write_file', payload: 'output.txt\nactuate updated the fixture' };
  }
  if (observation === 'write=ok') return { variant: 'final', text: 'final=fixture updated' };
  fail('ERR_FIXTURE_AGENT_MODEL_PROMPT_UNSUPPORTED', `unsupported fixture observation: ${observation}`);
}

function preflightAccepted() {
  return Object.freeze({ accepted: true, blockers: [] });
}

function preflightRejected(blockers) {
  return Object.freeze({ accepted: false, blockers });
}

function agentActionValueImage(action) {
  return fromUtf8(stableJson({
    schema: 'boundary.Agent.Action.v0',
    action,
  }));
}

function resolutionInput(hostRequest, responseValueImageBytes) {
  return fromUtf8(stableJson({
    targetHostRequestFingerprint: hostRequest?.hostRequestFingerprint ?? null,
    status: 'ok',
    responseValueImageBytes: [...responseValueImageBytes],
    metadata: 'fixture-agent-model',
  }));
}

function responseKey(hostRequest = {}) {
  return hostRequest.idempotencyKeyWorldFingerprint ?? hostRequest.hostRequestFingerprint ?? null;
}

export class CapabilityDriver {
  constructor({
    scenario = 'skeleton',
    actuatorRef = DEFAULT_ACTUATOR_REF,
    descriptorFingerprint = DEFAULT_DESCRIPTOR,
    packFingerprint = null,
  } = {}) {
    this.scenario = scenario;
    this.actuatorRef = actuatorRef;
    this.descriptorFingerprint = descriptorFingerprint;
    this.packFingerprint = packFingerprint;
    this.responsesByKey = new Map();
    this.calls = 0;
  }

  manifest() {
    return {
      driverId: 'fixture-agent-model',
      ...(this.packFingerprint ? { packFingerprint: this.packFingerprint } : {}),
      supportedActuatorRefs: [this.actuatorRef],
      supportedDescriptorFingerprints: [this.descriptorFingerprint],
      supportedActuationClasses: ['model'],
      supportedResponseStatuses: ['ok', 'final'],
      maximumRequestBytes: 1024 * 1024,
      maximumResponseBytes: 1024 * 1024,
      recoveryClass: 'pure',
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

  preflight(context, hostRequest) {
    const manifest = this.manifest();
    const blockers = [];
    if (!manifest.supportedActuatorRefs.includes(hostRequest?.actuatorRef)) blockers.push('actuator-ref-uncovered');
    if (!manifest.supportedDescriptorFingerprints.includes(hostRequest?.descriptorFingerprint)) blockers.push('descriptor-uncovered');
    if (!manifest.supportedActuationClasses.includes(hostRequest?.actuationClass)) blockers.push('actuation-class-uncovered');
    if (hostRequest?.responseSchema && !manifest.supportedResponseStatuses.includes(hostRequest.responseSchema.status)) {
      blockers.push('response-status-uncovered');
    }
    if (!blockers.length) {
      try {
        parseDecisionPrompt(hostRequest.requestBytes);
      } catch (error) {
        blockers.push(error.code ?? 'ERR_AGENT_DECISION_PROMPT_INVALID');
      }
    }
    return blockers.length ? preflightRejected(blockers) : preflightAccepted();
  }

  dryRun(context, hostRequest) {
    const prompt = parseDecisionPrompt(hostRequest.requestBytes);
    return {
      wouldInvoke: false,
      proposedAction: { driver: 'fixture-agent-model', observation: prompt.observation },
      diagnostics: { deterministic: true },
    };
  }

  shadow(context, hostRequest, recordedResolution) {
    return {
      liveInvoked: false,
      schemaAccepted: Boolean(recordedResolution),
      diagnostics: { driver: 'fixture-agent-model' },
    };
  }

  async resolve(context, hostRequest) {
    const key = responseKey(hostRequest);
    if (key && this.responsesByKey.has(key)) {
      return { resolutionInputBytes: resolutionInput(hostRequest, this.responsesByKey.get(key)) };
    }
    this.calls += 1;
    const prompt = parseDecisionPrompt(hostRequest.requestBytes);
    const response = agentActionValueImage(actionForPrompt(this.scenario, prompt));
    if (key) this.responsesByKey.set(key, new Uint8Array(response));
    return { resolutionInputBytes: resolutionInput(hostRequest, response) };
  }

  async recover(context, effectRecord) {
    if (!effectRecord?.resolutionInputRef) return await this.resolve(context, effectRecord);
    return { operatorInterventionRequired: true };
  }
}
