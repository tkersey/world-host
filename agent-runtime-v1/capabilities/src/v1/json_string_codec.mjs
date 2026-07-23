import { fail } from "./errors.mjs";
import { decodeStringValue, encodeStringValue } from "./protocol.mjs";

export function decodeJsonStringValue(bytes, maximumBytes = 1 << 20) {
  const text = decodeStringValue(bytes, maximumBytes);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("ERR_CAPABILITY_V1_JSON");
  }
  assertJsonValue(value, "$", 0);
  return value;
}

export function encodeJsonStringValue(value) {
  assertJsonValue(value, "$", 0);
  return encodeStringValue(JSON.stringify(value));
}

function assertJsonValue(value, path, depth) {
  if (depth > 16) fail("ERR_CAPABILITY_V1_JSON_DEPTH", path);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("ERR_CAPABILITY_V1_JSON_NUMBER", path);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1024) fail("ERR_CAPABILITY_V1_JSON_COUNT", path);
    for (let index = 0; index < value.length; index += 1) assertJsonValue(value[index], `${path}[${index}]`, depth + 1);
    return;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) fail("ERR_CAPABILITY_V1_JSON_VALUE", path);
  const entries = Object.entries(value);
  if (entries.length > 1024) fail("ERR_CAPABILITY_V1_JSON_COUNT", path);
  for (const [key, child] of entries) assertJsonValue(child, `${path}.${key}`, depth + 1);
}
