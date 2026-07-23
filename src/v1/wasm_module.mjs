import { assertBytes, fail } from './errors.mjs';

export const WASM_PAGE_BYTES = 65_536;

/// Inspect the declared linear-memory bounds without instantiating untrusted code.
export function inspectApplicationWasm(wasmBytes) {
  const bytes = Buffer.from(assertBytes(wasmBytes, 'wasmBytes'));
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])) ||
      !bytes.subarray(4, 8).equals(Buffer.from([0x01, 0x00, 0x00, 0x00]))) {
    fail('ERR_APPLICATION_V1_WASM_HEADER');
  }
  const cursor = { offset: 8 };
  let memory = null;
  while (cursor.offset < bytes.length) {
    const sectionId = readByte(bytes, cursor);
    const sectionLength = readVarUint32(bytes, cursor);
    const sectionEnd = checkedEnd(cursor.offset, sectionLength, bytes.length);
    if (sectionId === 5) {
      if (memory !== null) fail('ERR_APPLICATION_V1_WASM_MEMORY_SECTION_DUPLICATE');
      memory = readMemorySection(bytes.subarray(cursor.offset, sectionEnd));
    }
    cursor.offset = sectionEnd;
  }
  if (memory === null) fail('ERR_APPLICATION_V1_WASM_MEMORY_MISSING');
  return Object.freeze({
    byteLength: bytes.length,
    memory: Object.freeze(memory),
  });
}

function readMemorySection(section) {
  const cursor = { offset: 0 };
  const count = readVarUint32(section, cursor);
  if (count !== 1) fail('ERR_APPLICATION_V1_WASM_MEMORY_COUNT', `expected one memory, got ${count}`);
  const flags = readVarUint32(section, cursor);
  if (flags !== 1) {
    fail('ERR_APPLICATION_V1_WASM_MEMORY_LIMITS', 'application memory must be wasm32, unshared, and declare a maximum');
  }
  const minimumPages = readVarUint32(section, cursor);
  const maximumPages = readVarUint32(section, cursor);
  if (minimumPages === 0 || maximumPages < minimumPages) fail('ERR_APPLICATION_V1_WASM_MEMORY_LIMITS');
  if (cursor.offset !== section.length) fail('ERR_APPLICATION_V1_WASM_MEMORY_SECTION');
  return {
    minimumPages,
    maximumPages,
    minimumBytes: minimumPages * WASM_PAGE_BYTES,
    maximumBytes: maximumPages * WASM_PAGE_BYTES,
  };
}

function readByte(bytes, cursor) {
  if (cursor.offset >= bytes.length) fail('ERR_APPLICATION_V1_WASM_TRUNCATED');
  const result = bytes[cursor.offset];
  cursor.offset += 1;
  return result;
}

function readVarUint32(bytes, cursor) {
  let result = 0;
  let shift = 0;
  for (let index = 0; index < 5; index += 1) {
    const byte = readByte(bytes, cursor);
    if (index === 4 && (byte & 0xf0) !== 0) fail('ERR_APPLICATION_V1_WASM_LEB128');
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
  }
  fail('ERR_APPLICATION_V1_WASM_LEB128');
}

function checkedEnd(offset, length, maximum) {
  const end = offset + length;
  if (!Number.isSafeInteger(end) || end > maximum) fail('ERR_APPLICATION_V1_WASM_TRUNCATED');
  return end;
}
