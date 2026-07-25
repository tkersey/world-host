import { assertBytes, fail } from './errors.mjs';
import { DEFAULT_ADMISSION_LIMITS, decodeApplicationManifestPrefix } from './protocol.mjs';

export const WASM_PAGE_BYTES = 65_536;
export const REQUIRED_APPLICATION_EXPORTS = Object.freeze([
  Object.freeze({ name: 'memory', kind: 'memory' }),
  ...[
    'world_abi_version',
    'world_manifest_ptr',
    'world_manifest_len',
    'world_input_ptr',
    'world_input_capacity',
    'world_step',
    'world_output_ptr',
    'world_output_len',
    'world_error_ptr',
    'world_error_len',
    'world_reset',
  ].map((name) => Object.freeze({ name, kind: 'function' })),
]);

/// Inspect the declared ABI surface, memory bounds, and embedded manifest
/// without compiling or instantiating untrusted guest code.
export function inspectApplicationWasm(wasmBytes, {
  admissionLimits = DEFAULT_ADMISSION_LIMITS,
} = {}) {
  const bytes = Buffer.from(assertBytes(wasmBytes, 'wasmBytes'));
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])) ||
      !bytes.subarray(4, 8).equals(Buffer.from([0x01, 0x00, 0x00, 0x00]))) {
    fail('ERR_APPLICATION_V1_WASM_HEADER');
  }
  const cursor = { offset: 8 };
  const standardSections = new Set();
  let importCount = 0;
  let exports = [];
  let memory = null;
  while (cursor.offset < bytes.length) {
    const sectionId = readByte(bytes, cursor);
    const sectionLength = readVarUint32(bytes, cursor);
    const sectionEnd = checkedEnd(cursor.offset, sectionLength, bytes.length);
    if (sectionId !== 0) {
      if (standardSections.has(sectionId)) fail('ERR_APPLICATION_V1_WASM_SECTION_DUPLICATE');
      standardSections.add(sectionId);
    }
    const section = bytes.subarray(cursor.offset, sectionEnd);
    if (sectionId === 2) importCount = readVectorCount(section);
    if (sectionId === 5) {
      if (memory !== null) fail('ERR_APPLICATION_V1_WASM_MEMORY_SECTION_DUPLICATE');
      memory = readMemorySection(section);
    }
    if (sectionId === 7) exports = readExportSection(section);
    cursor.offset = sectionEnd;
  }
  if (memory === null) fail('ERR_APPLICATION_V1_WASM_MEMORY_MISSING');
  const manifest = findEmbeddedApplicationManifest(bytes, admissionLimits);
  return Object.freeze({
    byteLength: bytes.length,
    importCount,
    exports: Object.freeze(exports),
    memory: Object.freeze(memory),
    manifest,
  });
}

export function assertApplicationWasmSurface(inspection) {
  const declared = new Map(inspection.exports.map((entry) => [entry.name, entry.kind]));
  for (const required of REQUIRED_APPLICATION_EXPORTS) {
    if (declared.get(required.name) !== required.kind) {
      fail('ERR_APPLICATION_V1_WASM_EXPORT_MISSING', required.name);
    }
  }
  if (inspection.importCount !== 0) fail('ERR_APPLICATION_V1_WASM_IMPORTS_FORBIDDEN');
  if (inspection.manifest === null) fail('ERR_APPLICATION_V1_WASM_MANIFEST_MISSING');
  return inspection;
}

function findEmbeddedApplicationManifest(bytes, admissionLimits) {
  const magic = Buffer.from('WRLDMNF1', 'ascii');
  const found = [];
  for (let offset = bytes.indexOf(magic); offset !== -1; offset = bytes.indexOf(magic, offset + 1)) {
    try {
      const manifest = decodeApplicationManifestPrefix(bytes.subarray(offset), admissionLimits);
      found.push(manifest);
    } catch {
      // A matching byte sequence is not an embedded manifest unless the full
      // canonical record, limits, and semantic identity validate.
    }
  }
  if (found.length === 0) return null;
  if (found.length !== 1) fail('ERR_APPLICATION_V1_WASM_MANIFEST_AMBIGUOUS');
  return found[0];
}

function readVectorCount(section) {
  return readVarUint32(section, { offset: 0 });
}

function readExportSection(section) {
  const cursor = { offset: 0 };
  const count = readVarUint32(section, cursor);
  const result = [];
  const names = new Set();
  for (let index = 0; index < count; index += 1) {
    const nameLength = readVarUint32(section, cursor);
    const nameEnd = checkedEnd(cursor.offset, nameLength, section.length);
    const nameBytes = section.subarray(cursor.offset, nameEnd);
    cursor.offset = nameEnd;
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    if (names.has(name)) fail('ERR_APPLICATION_V1_WASM_EXPORT_DUPLICATE', name);
    names.add(name);
    const kindValue = readByte(section, cursor);
    const kind = ['function', 'table', 'memory', 'global', 'tag'][kindValue];
    if (kind === undefined) fail('ERR_APPLICATION_V1_WASM_EXPORT_KIND');
    readVarUint32(section, cursor);
    result.push(Object.freeze({ name, kind }));
  }
  if (cursor.offset !== section.length) fail('ERR_APPLICATION_V1_WASM_EXPORT_SECTION');
  return result;
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
