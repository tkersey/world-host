import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";

import * as fixtureModel from "../../packages/fixture-model/adapter.mjs";
import * as sandboxFiles from "../../packages/sandbox-files/adapter.mjs";
import { fail } from "./errors.mjs";
import {
  decodeStringValue,
  effectInterfaceId,
  encodeStringValue,
  stringValueSchemaId
} from "./protocol.mjs";

const STRING_SCHEMA = stringValueSchemaId();

export function fixtureAgentBindings() {
  return [
    modelBinding(),
    fileReadBinding(),
    fileWriteBinding()
  ];
}

function modelBinding() {
  return {
    bindingId: "fixture-agent.model.v1",
    driverId: "fixture-model",
    packageName: "@tkersey/world-capabilities/fixture-model",
    interfaceId: effectInterfaceId("agent.model.decide.v1"),
    payloadSchemaId: STRING_SCHEMA,
    resultSchemaId: STRING_SCHEMA,
    authorityRequirements: 1n,
    target: {
      descriptorFingerprint: "desc.fixture-model.v0",
      actuatorRef: "actuator.fixture-model",
      actuationClass: "model"
    },
    adapter: fixtureModel,
    decodePayload: (bytes) => ({ prompt: decodeStringValue(bytes) }),
    encodeOutcome: (_outcome, projected) => encodeStringValue(fixtureModelDecision(projected.payload.prompt)),
    recoveryClass: "pure"
  };
}

function fileReadBinding() {
  return {
    bindingId: "fixture-agent.file-read.v1",
    driverId: "sandbox-files",
    packageName: "@tkersey/world-capabilities/sandbox-files",
    interfaceId: effectInterfaceId("host.file.read.v1"),
    payloadSchemaId: STRING_SCHEMA,
    resultSchemaId: STRING_SCHEMA,
    authorityRequirements: 2n,
    target: {
      descriptorFingerprint: "desc.sandbox-files.v0",
      actuatorRef: "actuator.sandbox-files",
      actuationClass: "file"
    },
    adapter: sandboxFiles,
    decodePayload: (bytes) => ({ operation: "read", path: decodeStringValue(bytes) }),
    encodeOutcome: (outcome) => encodeStringValue(String(outcome.payload?.bytes ?? "")),
    configurationIdentity: fileConfigurationIdentity,
    recoveryClass: "idempotent"
  };
}

function fileWriteBinding() {
  return {
    bindingId: "fixture-agent.file-write.v1",
    driverId: "sandbox-files",
    packageName: "@tkersey/world-capabilities/sandbox-files",
    interfaceId: effectInterfaceId("host.file.write.v1"),
    payloadSchemaId: STRING_SCHEMA,
    resultSchemaId: STRING_SCHEMA,
    authorityRequirements: 4n,
    target: {
      descriptorFingerprint: "desc.sandbox-files.v0",
      actuatorRef: "actuator.sandbox-files",
      actuationClass: "file"
    },
    adapter: sandboxFiles,
    decodePayload: (bytes) => {
      const value = decodeStringValue(bytes);
      const separator = value.indexOf("\n");
      if (separator <= 0) fail("ERR_CAPABILITY_V1_FIXTURE_WRITE_PAYLOAD");
      return { operation: "write", path: value.slice(0, separator), bytes: value.slice(separator + 1) };
    },
    encodeOutcome: () => encodeStringValue("write=ok"),
    configurationIdentity: fileConfigurationIdentity,
    recoveryClass: "idempotent"
  };
}

function fixtureModelDecision(prompt) {
  switch (prompt) {
    case "goal=invoke":
      return "actuate";
    case "actuate":
      return "final=actuate skeleton complete";
    case "goal=fixture":
      return "fixture-input.txt";
    case "rewrite this file through the agent loop\n":
      return "fixture-output.txt\nactuate updated the fixture";
    case "write=ok":
      return "final=fixture updated";
    default:
      fail("ERR_CAPABILITY_V1_FIXTURE_MODEL_PROMPT", prompt);
  }
}

function fileConfigurationIdentity(context, projected) {
  if (typeof context?.fixtureRoot !== "string" || context.fixtureRoot.length === 0) {
    fail("ERR_CAPABILITY_V1_FIXTURE_ROOT");
  }
  const hasher = createHash("sha256");
  hasher.update("world.capability-configuration.v1");
  hasher.update(Buffer.from([0]));
  hasher.update("sandbox-files");
  hasher.update(Buffer.from([0]));
  hasher.update(resolvePath(context.fixtureRoot));
  hasher.update(Buffer.from([0]));
  hasher.update(projected.payload.operation);
  return hasher.digest("hex");
}
