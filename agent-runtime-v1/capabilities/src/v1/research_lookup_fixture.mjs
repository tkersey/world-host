import * as researchLookupFixture from "../../packages/research-lookup-fixture/adapter.mjs";
import { fail } from "./errors.mjs";
import { effectInterfaceId } from "./protocol.mjs";

export const RESEARCH_LOOKUP_INTERFACE_LABEL = "research.lookup.v1";
export const RESEARCH_DIGEST_APPLICATION_ID =
  "88e5a053c2a16fe9093abe4aa9f0c34d3e56abc9d1080aff5eb346687e72be85";
export const RESEARCH_REQUEST_SCHEMA_ID =
  "24eb8230d48242130660a1229ad28857eaad2d85315dfcee6d41f21badf3a03a";
export const RESEARCH_RESPONSE_SCHEMA_ID =
  "79828538ca9f2e3899120ce1ce96314bce094ab585c92b127d63f94ac8eb2172";

const MAXIMUM_QUERY_BYTES = 4096;
const MAXIMUM_TEXT_BYTES = 64 * 1024;

export function researchLookupFixtureBinding(options = {}) {
  const adapter = options.adapter ?? researchLookupFixture;
  return {
    bindingId: "research-lookup-fixture.v1",
    driverId: "research-lookup-fixture",
    packageName: "@tkersey/world-capabilities/research-lookup-fixture",
    interfaceId: effectInterfaceId(RESEARCH_LOOKUP_INTERFACE_LABEL),
    payloadSchemaId: digest(RESEARCH_REQUEST_SCHEMA_ID),
    resultSchemaId: digest(RESEARCH_RESPONSE_SCHEMA_ID),
    applicationIds: [digest(RESEARCH_DIGEST_APPLICATION_ID)],
    authorityRequirements: 128n,
    target: {
      descriptorFingerprint: "desc.research-lookup-fixture.v1",
      actuatorRef: "actuator.research-lookup-fixture.v1",
      actuationClass: "research"
    },
    adapter,
    decodePayload: decodeResearchRequest,
    encodeOutcome: (outcome) => encodeResearchResponse(outcome.payload),
    recoveryClass: "pure"
  };
}

export function decodeResearchRequest(encoded) {
  const reader = new Reader(encoded);
  const query = reader.string(MAXIMUM_QUERY_BYTES, "query");
  const maximumItems = reader.u64();
  reader.finish();
  return Object.freeze({ query, maximumItems });
}

export function encodeResearchResponse(value) {
  if (!value || typeof value !== "object") fail("ERR_CAPABILITY_V1_RESEARCH_RESPONSE");
  return Buffer.concat([
    encodeResearchItem(value.first, "first"),
    encodeResearchItem(value.second, "second"),
    encodeString(value.digestResult?.digest, "digest"),
    encodeU64(value.digestResult?.itemCount, "itemCount")
  ]);
}

export function decodeResearchResponse(encoded) {
  const reader = new Reader(encoded);
  const response = {
    first: decodeResearchItem(reader, "first"),
    second: decodeResearchItem(reader, "second"),
    digestResult: {
      digest: reader.string(MAXIMUM_TEXT_BYTES, "digest"),
      itemCount: reader.u64()
    }
  };
  reader.finish();
  return response;
}

function encodeResearchItem(value, label) {
  if (!value || typeof value !== "object") fail("ERR_CAPABILITY_V1_RESEARCH_RESPONSE", label);
  return Buffer.concat([
    encodeString(value.title, `${label}.title`),
    encodeString(value.summary, `${label}.summary`)
  ]);
}

function decodeResearchItem(reader, label) {
  return {
    title: reader.string(MAXIMUM_TEXT_BYTES, `${label}.title`),
    summary: reader.string(MAXIMUM_TEXT_BYTES, `${label}.summary`)
  };
}

function encodeString(value, label) {
  if (typeof value !== "string") fail("ERR_CAPABILITY_V1_RESEARCH_RESPONSE", label);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > MAXIMUM_TEXT_BYTES) fail("ERR_CAPABILITY_V1_RESEARCH_RESPONSE", label);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function encodeU64(value, label) {
  if (typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn) {
    fail("ERR_CAPABILITY_V1_RESEARCH_RESPONSE", label);
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function digest(value) {
  return Buffer.from(value, "hex");
}

class Reader {
  constructor(value) {
    if (!(value instanceof Uint8Array)) fail("ERR_CAPABILITY_V1_RESEARCH_REQUEST");
    this.value = Buffer.from(value);
    this.offset = 0;
  }

  bytes(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.value.length) {
      fail("ERR_CAPABILITY_V1_RESEARCH_REQUEST");
    }
    const result = this.value.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  u32() {
    return this.bytes(4).readUInt32LE();
  }

  u64() {
    return this.bytes(8).readBigUInt64LE();
  }

  string(maximum, label) {
    const bytes = this.bytes(this.u32());
    if (bytes.length > maximum) fail("ERR_CAPABILITY_V1_RESEARCH_REQUEST", label);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("ERR_CAPABILITY_V1_RESEARCH_REQUEST", label);
    }
  }

  finish() {
    if (this.offset !== this.value.length) fail("ERR_CAPABILITY_V1_RESEARCH_REQUEST");
  }
}
