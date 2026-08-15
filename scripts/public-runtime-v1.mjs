import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PUBLIC_RUNTIME_VERSION = '1.0.1';
export const PUBLIC_RUNTIME_ROOT = `world-host-v${PUBLIC_RUNTIME_VERSION}-runtime`;
export const PUBLIC_RUNTIME_ARCHIVE = `${PUBLIC_RUNTIME_ROOT}.tar.gz`;
export const MAXIMUM_ARCHIVE_BYTES = 16 << 20;
export const MAXIMUM_EXPANDED_BYTES = 64 << 20;
export const MAXIMUM_ENTRY_COUNT = 512;
export const MAXIMUM_CHECKSUM_SIDECAR_BYTES = 256;

export const RUNTIME_SOURCE_PATHS = Object.freeze([
  'LICENSE',
  'bin/world-host-v1.mjs',
  'src/bun/application_v1_cli.mjs',
  'src/bun/application_v1_inspection_worker.mjs',
]);

const EXPECTED_RUNTIME_FILES = Object.freeze([
  'LICENSE',
  'README.md',
  'bin/world-host-v1.mjs',
  'checksums.sha256',
  'conformance/check-runtime.mjs',
  'conformance/public-runtime-v1.mjs',
  'manifest.json',
  'package.json',
  'src/bun/application_v1_cli.mjs',
  'src/bun/application_v1_inspection_worker.mjs',
  'src/v1/application_worker.mjs',
  'src/v1/directory_storage.mjs',
  'src/v1/effect_journal.mjs',
  'src/v1/errors.mjs',
  'src/v1/index.mjs',
  'src/v1/protocol.mjs',
  'src/v1/run_controller.mjs',
  'src/v1/storage.mjs',
  'src/v1/wasm_module.mjs',
]);

export async function runtimeSourcePaths(repository) {
  const paths = [...RUNTIME_SOURCE_PATHS];
  await walk(repository, 'src/v1', paths);
  return paths.sort();
}

export async function buildRuntimeTree(repository, outputRoot) {
  const files = await runtimeSourcePaths(repository);
  for (const relative of files) {
    const bytes = await readFile(path.join(repository, relative));
    await writeTreeFile(outputRoot, relative, bytes, executable(relative));
  }
  await writeTreeFile(outputRoot, 'package.json', Buffer.from(`${JSON.stringify({
    name: '@tkersey/world-host-v1-runtime',
    version: PUBLIC_RUNTIME_VERSION,
    private: true,
    license: 'MIT',
    type: 'module',
    bin: { 'world-host': './bin/world-host-v1.mjs', 'world-host-v1': './bin/world-host-v1.mjs' },
    engines: { bun: '>=1.3.2' },
    dependencies: {},
  }, null, 2)}\n`));
  await writeTreeFile(outputRoot, 'README.md', Buffer.from(`# world-host v${PUBLIC_RUNTIME_VERSION} runtime\n\nThis source-independent distribution runs Application ABI v1 World WASM with Bun 1.3.2 or newer. It contains no application, capability, receiver secret, or runtime store.\n\nVerify it with:\n\n\`\`\`sh\nbun conformance/check-runtime.mjs --root .\n\`\`\`\n`));
  for (const script of ['public-runtime-v1.mjs', 'check-public-runtime-v1.mjs']) {
    const target = script === 'check-public-runtime-v1.mjs' ? 'check-runtime.mjs' : script;
    await writeTreeFile(outputRoot, `conformance/${target}`, await readFile(path.join(repository, 'scripts', script)), true);
  }
  const beforeChecksums = await treeFiles(outputRoot);
  const checksums = [];
  for (const relative of beforeChecksums) {
    checksums.push(`${sha256(await readFile(path.join(outputRoot, relative)))}  ${relative}`);
  }
  await writeTreeFile(outputRoot, 'checksums.sha256', Buffer.from(`${checksums.join('\n')}\n`));
  const manifest = {
    format: 'world-host-public-runtime/v1',
    version: PUBLIC_RUNTIME_VERSION,
    archiveRoot: PUBLIC_RUNTIME_ROOT,
    applicationAbiVersion: 1,
    frameVersion: 1,
    entrypoint: 'bin/world-host-v1.mjs',
    verifier: 'conformance/check-runtime.mjs',
    runtimeDependencies: 0,
    sourceCheckoutRequired: false,
  };
  await writeTreeFile(outputRoot, 'manifest.json', Buffer.from(`${stableJson(manifest)}\n`));
  // Manifest is intentionally outside the internal checksum list so the list
  // cannot be self-referential. The archive SHA-256 covers every byte.
  return manifest;
}

export async function writeDeterministicArchive(treeRoot, outputPath) {
  const entries = await treeFiles(treeRoot);
  assert(entries.length <= MAXIMUM_ENTRY_COUNT, 'runtime archive has too many entries');
  const opened = [];
  try {
    let projectedBytes = 1024;
    for (const relative of entries) {
      const handle = await open(path.join(treeRoot, relative), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        assert(info.isFile(), `runtime archive entry must be a regular file: ${relative}`);
        projectedBytes += 512 + info.size + ((512 - (info.size % 512)) % 512);
        assert(projectedBytes <= MAXIMUM_EXPANDED_BYTES, 'runtime archive expansion exceeds maximum');
        assert(canonicalGzipSize(projectedBytes) <= MAXIMUM_ARCHIVE_BYTES, 'runtime archive exceeds maximum size');
        opened.push({ handle, info, relative });
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
    const chunks = [];
    for (const entry of opened) {
      const current = await entry.handle.stat();
      assert.equal(current.size, entry.info.size, `runtime archive entry changed during admission: ${entry.relative}`);
      const bytes = await entry.handle.readFile();
      assert.equal(bytes.length, entry.info.size, `runtime archive entry changed during admission: ${entry.relative}`);
      chunks.push(tarHeader(`${PUBLIC_RUNTIME_ROOT}/${entry.relative}`, bytes.length, executable(entry.relative) ? 0o755 : 0o644));
      chunks.push(bytes);
      const padding = (512 - (bytes.length % 512)) % 512;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
    chunks.push(Buffer.alloc(1024));
    const archive = canonicalGzip(Buffer.concat(chunks, projectedBytes));
    assert(archive.length <= MAXIMUM_ARCHIVE_BYTES, 'runtime archive exceeds maximum size');
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, archive);
    return { sha256: sha256(archive), bytes: archive.length, entries: entries.length };
  } finally {
    await Promise.all(opened.map(({ handle }) => handle.close()));
  }
}

export async function extractRuntimeArchive(archivePath, destination, admittedArchive = null) {
  const archive = admittedArchive ?? await readRuntimeArchive(archivePath);
  assert(Buffer.isBuffer(archive), 'runtime archive must be admitted as bytes');
  assert(archive.length <= MAXIMUM_ARCHIVE_BYTES, 'runtime archive exceeds maximum size');
  assert.deepEqual(archive.subarray(0, 10), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]),
    'runtime archive has non-canonical gzip metadata');
  const inflated = inflateRawSync(archive.subarray(10), { info: true, maxOutputLength: MAXIMUM_EXPANDED_BYTES });
  assert.equal(10 + inflated.engine.bytesWritten + 8, archive.length, 'runtime archive must contain exactly one gzip member');
  const tar = gunzipSync(archive, { maxOutputLength: MAXIMUM_EXPANDED_BYTES });
  assert(archive.equals(canonicalGzip(tar)), 'runtime archive gzip encoding is not canonical');
  assert.equal(tar.length % 512, 0, 'tar payload is not block aligned');
  let offset = 0;
  let expanded = 0;
  let count = 0;
  let terminated = false;
  const seen = new Set();
  const portableSeen = new Set();
  const entries = [];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      assert(offset + 512 <= tar.length, 'tar terminator is incomplete');
      assert(tar.subarray(offset, offset + 512).every((byte) => byte === 0), 'tar terminator is incomplete');
      offset += 512;
      assert(tar.subarray(offset).every((byte) => byte === 0), 'non-zero data follows tar terminator');
      terminated = true;
      break;
    }
    count += 1;
    assert(count <= MAXIMUM_ENTRY_COUNT, 'runtime archive has too many entries');
    const storedChecksum = octal(header.subarray(148, 156));
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    assert.equal(sum(checksumHeader), storedChecksum, 'invalid tar header checksum');
    const name = textField(header.subarray(0, 100));
    const prefix = textField(header.subarray(345, 500));
    const relative = prefix ? `${prefix}/${name}` : name;
    assert(relative.startsWith(`${PUBLIC_RUNTIME_ROOT}/`), 'unexpected archive root');
    const inside = relative.slice(PUBLIC_RUNTIME_ROOT.length + 1);
    assert(safeRelative(inside), `unsafe archive path: ${relative}`);
    assert(!seen.has(inside), `duplicate archive path: ${inside}`);
    seen.add(inside);
    const portable = inside.normalize('NFC').toLowerCase();
    assert(!portableSeen.has(portable), `non-portable archive path collision: ${inside}`);
    portableSeen.add(portable);
    const type = header[156];
    assert(type === 0 || type === 0x30, `links and non-files are forbidden: ${inside}`);
    const size = octal(header.subarray(124, 136));
    assert(header.equals(tarHeader(relative, size, executable(inside) ? 0o755 : 0o644)),
      `non-canonical tar header: ${inside}`);
    expanded += size;
    assert(expanded <= MAXIMUM_EXPANDED_BYTES, 'runtime archive expansion exceeds maximum');
    const padding = (512 - (size % 512)) % 512;
    assert(offset + size + padding <= tar.length, 'truncated tar entry');
    entries.push({ inside, bytes: tar.subarray(offset, offset + size), isExecutable: executable(inside) });
    offset += size;
    assert(tar.subarray(offset, offset + padding).every((byte) => byte === 0), `non-zero tar padding: ${inside}`);
    offset += padding;
  }
  assert(count > 0, 'runtime archive is empty');
  assert(terminated, 'runtime archive has no complete terminator');
  for (const entry of entries) {
    await writeTreeFile(destination, entry.inside, entry.bytes, entry.isExecutable);
  }
  return { sha256: sha256(archive), bytes: archive.length, entries: count, expandedBytes: expanded };
}

export async function readRuntimeArchive(archivePath) {
  const handle = await open(archivePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    assert(info.isFile(), 'runtime archive must be a regular file');
    assert(info.size <= MAXIMUM_ARCHIVE_BYTES, 'runtime archive exceeds maximum size');
    const archive = await handle.readFile();
    assert(archive.length <= MAXIMUM_ARCHIVE_BYTES, 'runtime archive exceeds maximum size');
    return archive;
  } finally {
    await handle.close();
  }
}

export function canonicalGzip(bytes) {
  const blocks = [];
  for (let offset = 0; offset < bytes.length || blocks.length === 0;) {
    const length = Math.min(0xffff, bytes.length - offset);
    const final = offset + length === bytes.length;
    const header = Buffer.alloc(5);
    header[0] = final ? 1 : 0;
    header.writeUInt16LE(length, 1);
    header.writeUInt16LE(length ^ 0xffff, 3);
    blocks.push(header, bytes.subarray(offset, offset + length));
    offset += length;
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  return Buffer.concat([
    Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff]),
    ...blocks,
    trailer,
  ]);
}

function canonicalGzipSize(bytes) {
  return 10 + bytes + (5 * Math.max(1, Math.ceil(bytes / 0xffff))) + 8;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function verifyRuntimeTree(root) {
  const files = await treeFiles(root);
  assert.deepEqual(files, [...EXPECTED_RUNTIME_FILES], 'runtime file inventory mismatch');
  for (const forbidden of files) {
    assert(!/(^|\/)(applications?|capabilities?|fixtures?|stores?|runs?|logs?|transcripts?|evidence|secrets?|\.git)(\/|$)/i.test(forbidden), `forbidden runtime path: ${forbidden}`);
  }
  const snapshot = await snapshotRuntimeFiles(root, files);
  const manifest = JSON.parse(snapshot.get('manifest.json').toString('utf8'));
  assert.deepEqual(manifest, {
    applicationAbiVersion: 1,
    archiveRoot: PUBLIC_RUNTIME_ROOT,
    entrypoint: 'bin/world-host-v1.mjs',
    format: 'world-host-public-runtime/v1',
    frameVersion: 1,
    runtimeDependencies: 0,
    sourceCheckoutRequired: false,
    verifier: 'conformance/check-runtime.mjs',
    version: PUBLIC_RUNTIME_VERSION,
  });
  const checksums = parseChecksums(snapshot.get('checksums.sha256').toString('utf8'));
  const covered = files.filter((file) => !['checksums.sha256', 'manifest.json'].includes(file));
  assert.deepEqual([...checksums.keys()].sort(), covered, 'runtime checksum coverage mismatch');
  for (const relative of covered) {
    assert.equal(sha256(snapshot.get(relative)), checksums.get(relative), `runtime checksum mismatch: ${relative}`);
  }
  return { format: manifest.format, version: manifest.version, fileCount: files.length, checksumCount: checksums.size, sourceCheckoutRequired: false };
}

async function snapshotRuntimeFiles(root, files) {
  const snapshot = new Map();
  let totalBytes = 0;
  for (const relative of files) {
    const handle = await open(path.join(root, relative), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      assert(before.isFile(), `runtime entry must be a regular file: ${relative}`);
      assert(before.size <= MAXIMUM_EXPANDED_BYTES - totalBytes, 'runtime tree exceeds maximum size');
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        assert(read.bytesRead > 0, `runtime file changed while reading: ${relative}`);
        offset += read.bytesRead;
      }
      const extra = Buffer.alloc(1);
      assert.equal((await handle.read(extra, 0, 1, bytes.length)).bytesRead, 0,
        `runtime file changed while reading: ${relative}`);
      const after = await handle.stat();
      assert.equal(after.size, before.size, `runtime file changed while reading: ${relative}`);
      totalBytes += bytes.length;
      snapshot.set(relative, bytes);
    } finally {
      await handle.close();
    }
  }
  return snapshot;
}

export function parseChecksumSidecar(text, expectedName = PUBLIC_RUNTIME_ARCHIVE) {
  const match = /^([0-9a-f]{64})  ([^\n]+)\n?$/.exec(text);
  assert(match, 'invalid checksum sidecar');
  assert.equal(match[2], expectedName, 'checksum sidecar asset mismatch');
  return match[1];
}

export async function readChecksumSidecar(checksumPath) {
  const handle = await open(checksumPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    assert(info.isFile(), 'checksum sidecar must be a regular file');
    assert(info.size <= MAXIMUM_CHECKSUM_SIDECAR_BYTES, 'checksum sidecar exceeds maximum size');
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

async function walk(root, relative, output) {
  const { readdir, lstat } = await import('node:fs/promises');
  const entries = await readdir(path.join(root, relative));
  for (const name of entries.sort()) {
    const child = path.posix.join(relative, name);
    const info = await lstat(path.join(root, child));
    assert(!info.isSymbolicLink(), `runtime source symlink forbidden: ${child}`);
    if (info.isDirectory()) await walk(root, child, output);
    else if (info.isFile()) output.push(child);
    else assert.fail(`unsupported runtime entry: ${child}`);
  }
}

async function treeFiles(root) {
  const output = [];
  await walk(root, '.', output);
  return output.map((value) => value.startsWith('./') ? value.slice(2) : value).sort();
}

async function writeTreeFile(root, relative, bytes, isExecutable = false) {
  assert(safeRelative(relative), `unsafe output path: ${relative}`);
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { mode: isExecutable ? 0o755 : 0o644 });
}

function tarHeader(name, size, mode) {
  const header = Buffer.alloc(512);
  const encoded = Buffer.from(name);
  assert(encoded.length <= 100, `tar path is too long: ${name}`);
  encoded.copy(header, 0);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  Buffer.from('ustar\0').copy(header, 257);
  Buffer.from('00').copy(header, 263);
  writeOctal(header, 148, 8, sum(header));
  return header;
}

function writeOctal(buffer, offset, width, value) {
  const encoded = value.toString(8).padStart(width - 2, '0');
  assert(encoded.length <= width - 2, 'tar numeric field overflow');
  buffer.write(encoded, offset, 'ascii');
  buffer[offset + width - 2] = 0;
  buffer[offset + width - 1] = 0x20;
}

function octal(bytes) {
  const value = textField(bytes).trim();
  assert(/^[0-7]*$/.test(value), 'invalid tar octal field');
  return value === '' ? 0 : Number.parseInt(value, 8);
}

function textField(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString('utf8');
}

function sum(bytes) { let result = 0; for (const byte of bytes) result += byte; return result; }
function executable(relative) { return relative.startsWith('bin/') || relative.startsWith('conformance/'); }
function safeRelative(value) { return value.length > 0 && !value.includes('\\') && !path.posix.isAbsolute(value) && !value.split('/').some((part) => part === '' || part === '.' || part === '..'); }
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function stableJson(value) { return JSON.stringify(value, Object.keys(value).sort(), 2); }
function parseChecksums(text) {
  const result = new Map();
  for (const line of text.trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})  ([^\n]+)$/.exec(line);
    assert(match, 'invalid runtime checksum line');
    assert(safeRelative(match[2]) && !result.has(match[2]), 'invalid or duplicate runtime checksum path');
    result.set(match[2], match[1]);
  }
  return result;
}
