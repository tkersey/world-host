import * as genericHttpJson from "../../packages/generic-http-json/adapter.mjs";
import * as humanApproval from "../../packages/human-approval/adapter.mjs";
import * as localMemoryKv from "../../packages/local-memory-kv/adapter.mjs";
import { createAgentInvokeAdapter } from "./agent_invoke.mjs";
import { decodeJsonStringValue, encodeJsonStringValue } from "./json_string_codec.mjs";
import { effectInterfaceId, stringValueSchemaId } from "./protocol.mjs";

const STRING_SCHEMA = stringValueSchemaId();

export function genericHttpJsonBinding() {
  return jsonBinding({
    bindingId: "generic-http-json.v1",
    driverId: "generic-http-json",
    packageName: "@tkersey/world-capabilities/generic-http-json",
    interfaceLabel: "host.http.json.v1",
    authorityRequirements: 8n,
    adapter: genericHttpJson,
    target: {
      descriptorFingerprint: "desc.generic-http-json.v0",
      actuatorRef: "actuator.generic-http-json",
      actuationClass: "http"
    },
    recoveryClass: "best_effort"
  });
}

export function humanApprovalBinding() {
  return jsonBinding({
    bindingId: "human-approval.v1",
    driverId: "human-approval",
    packageName: "@tkersey/world-capabilities/human-approval",
    interfaceLabel: "host.human.approval.v1",
    authorityRequirements: 16n,
    adapter: humanApproval,
    target: {
      descriptorFingerprint: "desc.human-approval.v0",
      actuatorRef: "actuator.human-approval",
      actuationClass: "approval"
    },
    recoveryClass: "best_effort"
  });
}

export function localMemoryKvBinding() {
  return jsonBinding({
    bindingId: "local-memory-kv.v1",
    driverId: "local-memory-kv",
    packageName: "@tkersey/world-capabilities/local-memory-kv",
    interfaceLabel: "host.memory.kv.v1",
    authorityRequirements: 128n,
    adapter: localMemoryKv,
    target: {
      descriptorFingerprint: "desc.local-memory-kv.v0",
      actuatorRef: "actuator.local-memory-kv",
      actuationClass: "memory"
    },
    recoveryClass: "pure"
  });
}

export function agentInvokeBinding({ invokeChild }) {
  return jsonBinding({
    bindingId: "agent-invoke.v1",
    driverId: "agent-invoke",
    packageName: "@tkersey/world-capabilities/agent-invoke",
    interfaceLabel: "agent.invoke.v1",
    authorityRequirements: 256n,
    adapter: createAgentInvokeAdapter({ invokeChild }),
    target: {
      descriptorFingerprint: "desc.agent-invoke.v1",
      actuatorRef: "actuator.agent-invoke",
      actuationClass: "child-agent"
    },
    recoveryClass: "best_effort"
  });
}

function jsonBinding({
  bindingId,
  driverId,
  packageName,
  interfaceLabel,
  authorityRequirements,
  adapter,
  target,
  recoveryClass
}) {
  return {
    bindingId,
    driverId,
    packageName,
    interfaceId: effectInterfaceId(interfaceLabel),
    payloadSchemaId: STRING_SCHEMA,
    resultSchemaId: STRING_SCHEMA,
    authorityRequirements,
    adapter,
    target,
    decodePayload: decodeJsonStringValue,
    encodeOutcome: (outcome) => encodeJsonStringValue(outcome.payload ?? {}),
    recoveryClass
  };
}
