import { redactCapabilityDiagnostics } from './capability_policy.mjs';
import { stableJson } from './store.mjs';

export const HostEventType = Object.freeze({
  runtimePackLoaded: 'runtime_pack_loaded',
  capabilityPackLoaded: 'capability_pack_loaded',
  policyLoaded: 'policy_loaded',
  secretRequested: 'secret_requested',
  secretMissing: 'secret_missing',
  hostRequestReceived: 'host_request_received',
  capabilitySelected: 'capability_selected',
  preflightPassed: 'preflight_passed',
  preflightRejected: 'preflight_rejected',
  effectClaimed: 'effect_claimed',
  dryRunCompleted: 'dry_run_completed',
  shadowCompleted: 'shadow_completed',
  approvalRequested: 'approval_requested',
  approvalRecorded: 'approval_recorded',
  resolutionPersisted: 'resolution_persisted',
  turnSubmitted: 'turn_submitted',
  turnClosureReceived: 'turn_closure_received',
  branchHeadAdvanced: 'branch_head_advanced',
  replayUsed: 'replay_used',
  retryReusedOutcome: 'retry_reused_outcome',
  migrationImported: 'migration_imported',
  runCompleted: 'run_completed',
  runFailed: 'run_failed',
});

const EVENT_TYPES = new Set(Object.values(HostEventType));

export class HostEventStream {
  constructor({ redact = redactCapabilityDiagnostics } = {}) {
    this.events = [];
    this.redact = redact;
  }

  emit(type, fields = {}) {
    const event = createHostEvent(type, fields, this.redact);
    this.events.push(event);
    return event;
  }

  toJsonl() {
    return `${this.events.map((event) => stableJson(event)).join('\n')}${this.events.length ? '\n' : ''}`;
  }

  summary() {
    const counts = {};
    for (const event of this.events) counts[event.type] = (counts[event.type] ?? 0) + 1;
    return {
      eventCount: this.events.length,
      counts,
      firstEventType: this.events[0]?.type ?? null,
      lastEventType: this.events.at(-1)?.type ?? null,
      worldAuthoredEvidence: false,
    };
  }
}

export function createHostEvent(type, fields = {}, redact = redactCapabilityDiagnostics) {
  if (!EVENT_TYPES.has(type)) throw new Error(`ERR_HOST_EVENT_TYPE_UNSUPPORTED:${type}`);
  return Object.freeze({
    ...redact(fields),
    type,
    at: new Date().toISOString(),
    wallClockDiagnosticOnly: true,
    worldAuthoredEvidence: false,
  });
}
