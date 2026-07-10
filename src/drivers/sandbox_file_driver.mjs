import { constants } from 'node:fs';
import { open, realpath, lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';

import { EffectRecoveryClass } from '../core/actuator.mjs';
import { assertBytes, fail, fromUtf8, stableJson } from '../core/store.mjs';
import { encodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';
import { encodeCanonicalValueImage } from '../protocol/world_loaded_value_codec.mjs';

export class SandboxFileDriver {
  constructor({ root, allowAbsolute = false, symlinkPolicy = 'reject', maximumReadBytes = DEFAULT_MAXIMUM_READ_BYTES, maximumWriteBytes = 1024 * 1024, actuatorRef = 'sandbox:file', descriptorFingerprint = 'descriptor:sandbox-file' } = {}) {
    if (!root) fail('ERR_SANDBOX_ROOT_REQUIRED');
    this.root = path.resolve(root);
    this.allowAbsolute = allowAbsolute;
    this.symlinkPolicy = symlinkPolicy;
    this.maximumReadBytes = maximumReadBytes;
    this.maximumWriteBytes = maximumWriteBytes;
    this.actuatorRef = actuatorRef;
    this.descriptorFingerprint = descriptorFingerprint;
    this.writeOutcomes = new Map();
    this.canonicalRoot = null;
  }

  manifest() {
    return {
      driverId: 'sandbox-file',
      supportedActuatorRefs: [this.actuatorRef],
      supportedDescriptorFingerprints: [this.descriptorFingerprint],
      supportedActuationClasses: ['file'],
      supportedResponseStatuses: ['ok', 'not_found'],
      maximumRequestBytes: encodedJsonStringEnvelopeLimit(this.maximumWriteBytes, 4096),
      maximumResponseBytes: Math.max(encodedJsonStringEnvelopeLimit(this.maximumReadBytes, 256), encodedJsonStringEnvelopeLimit(MAXIMUM_WRITE_ACK_BYTES, 256)),
      recoveryClass: EffectRecoveryClass.bestEffort,
      concurrencyLimit: 2,
      authorityLabels: ['file:sandbox'],
      diagnostics: { root: this.root, symlinkPolicy: this.symlinkPolicy },
    };
  }

  assertRequestSupported(hostRequest) {
    assertSandboxFileRequestSupported(parseJsonBytes(hostRequest.requestBytes), hostRequest, 'ERR_RESPONSE_STATUS_NOT_SUPPORTED');
    return true;
  }

  async resolve(context, hostRequest) {
    const request = parseJsonBytes(hostRequest.requestBytes);
    assertSandboxFileRequestSupported(request, hostRequest, 'ERR_SANDBOX_FILE_RESPONSE_SCHEMA_UNSUPPORTED');
    if (request.operation === 'read') return await this.#read(request.path, hostRequest);
    if (request.operation === 'write') {
      return await this.#write(request.path, request.content ?? '', hostRequest.idempotencyKeyWorldFingerprint, hostRequest);
    }
  }

  async recover(context, effectRecord) {
    const outcome = this.writeOutcomes.get(effectRecord.idempotencyKeyWorldFingerprint);
    if (!outcome) fail('ERR_SANDBOX_FILE_RECOVERY_UNAVAILABLE');
    return {
      resolutionInputBytes: resolutionInput(
        { hostRequestFingerprint: effectRecord.hostRequestFingerprint },
        outcome,
        writeValueImage(outcome),
      ),
      diagnostics: { recovered: true },
    };
  }

  async #read(filePath, hostRequest) {
    const resolved = await this.#resolvePath(filePath);
    if (!await this.#assertRegularPathBeforeOpen(resolved, { allowMissing: true })) {
      return { resolutionInputBytes: resolutionInput(hostRequest, { status: 'not_found' }, new Uint8Array(), 1) };
    }
    const handle = await this.#openForRead(resolved).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (handle === null) return { resolutionInputBytes: resolutionInput(hostRequest, { status: 'not_found' }, new Uint8Array(), 1) };
    let bytes;
    try {
      await this.#assertOpenHandleWithinRoot(handle, resolved);
      const info = await handle.stat();
      if (!info.isFile()) fail('ERR_SANDBOX_FILE_NOT_REGULAR');
      if (info.size > this.maximumReadBytes) fail('ERR_SANDBOX_FILE_READ_TOO_LARGE');
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (bytes === null) return { resolutionInputBytes: resolutionInput(hostRequest, { status: 'not_found' }, new Uint8Array(), 1) };
    if (bytes.byteLength > this.maximumReadBytes) fail('ERR_SANDBOX_FILE_READ_TOO_LARGE');
    return { resolutionInputBytes: resolutionInput(hostRequest, { status: 'ok' }, readValueImage(bytes)) };
  }

  async #write(filePath, content, key, hostRequest) {
    const bytes = content instanceof Uint8Array ? content : fromUtf8(String(content));
    if (bytes.byteLength > this.maximumWriteBytes) fail('ERR_SANDBOX_FILE_WRITE_TOO_LARGE');
    const resolved = await this.#resolvePath(filePath);
    const outcome = { status: 'ok', path: path.relative(this.root, resolved), byteLength: bytes.byteLength };
    const responseBytes = fromUtf8(stableJson(outcome));
    if (responseBytes.byteLength > MAXIMUM_WRITE_ACK_BYTES) fail('ERR_SANDBOX_FILE_ACK_TOO_LARGE');
    await this.#assertExistingParentWithinRoot(path.dirname(resolved));
    await this.#rejectCreateThroughFinalSymlink(resolved);
    if (!await this.#assertRegularPathBeforeOpen(resolved, { allowMissing: true })) {
      fail('ERR_SANDBOX_FILE_NOT_FOUND', 'sandbox writes require an existing regular file');
    }
    const handle = await this.#openForWrite(resolved);
    try {
      await this.#assertOpenHandleWithinRoot(handle, resolved);
      await handle.truncate(0);
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    if (this.symlinkPolicy === 'reject') await this.#assertResolvedPathWithinRoot(resolved);
    this.writeOutcomes.set(key, outcome);
    return { resolutionInputBytes: resolutionInput(hostRequest, outcome, writeValueImage(outcome)), driverTransactionRef: key };
  }

  async #openForRead(filePath) {
    const flags = constants.O_RDONLY | this.#noFollowFlag() | nonBlockFlag();
    return await open(filePath, flags);
  }

  async #openForWrite(filePath) {
    return await open(filePath, constants.O_WRONLY | this.#noFollowFlag() | nonBlockFlag());
  }

  #noFollowFlag() {
    return this.symlinkPolicy === 'allow' ? 0 : noFollowFlag();
  }

  async #resolvePath(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) fail('ERR_SANDBOX_FILE_PATH_REQUIRED');
    if (path.isAbsolute(filePath) && !this.allowAbsolute) fail('ERR_SANDBOX_ABSOLUTE_PATH_REJECTED');
    const resolved = path.resolve(this.root, filePath);
    if (resolved !== this.root && !resolved.startsWith(`${this.root}${path.sep}`)) fail('ERR_SANDBOX_PATH_ESCAPE');
    if (this.symlinkPolicy === 'reject') await this.#rejectSymlinkComponents(resolved);
    return resolved;
  }

  async #rejectSymlinkComponents(resolved) {
    const rootInfo = await lstat(this.root);
    if (rootInfo.isSymbolicLink()) fail('ERR_SANDBOX_SYMLINK_REJECTED');
    const relative = path.relative(this.root, resolved);
    if (relative === '') return;
    let current = this.root;
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      const info = await lstat(current).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info) return;
      if (info.isSymbolicLink()) fail('ERR_SANDBOX_SYMLINK_REJECTED');
    }
  }

  async #assertResolvedPathWithinRoot(value) {
    const actual = await realpath(value);
    const root = await this.#canonicalRoot();
    if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) fail('ERR_SANDBOX_PATH_ESCAPE');
  }

  async #assertExistingParentWithinRoot(parentPath) {
    await this.#assertResolvedPathWithinRoot(parentPath).catch((error) => {
      if (error.code === 'ENOENT') fail('ERR_SANDBOX_FILE_NOT_FOUND', 'sandbox writes require an existing parent directory');
      throw error;
    });
  }

  async #assertOpenHandleWithinRoot(handle, expectedPath) {
    const fdInfo = await handle.stat();
    if (fdInfo.isFile() && fdInfo.nlink > 1) fail('ERR_SANDBOX_HARDLINK_REJECTED');
    const fdPath = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : `/dev/fd/${handle.fd}`;
    const actual = await realpath(fdPath).catch(() => null);
    const root = await this.#canonicalRoot();
    if (actual && actual !== fdPath && !actual.startsWith('/dev/fd/')) {
      if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) fail('ERR_SANDBOX_PATH_ESCAPE');
      return;
    }
    const expectedActual = await realpath(expectedPath);
    if (expectedActual !== root && !expectedActual.startsWith(`${root}${path.sep}`)) fail('ERR_SANDBOX_PATH_ESCAPE');
    const pathInfo = await stat(expectedActual);
    if (fdInfo.dev !== pathInfo.dev || fdInfo.ino !== pathInfo.ino) fail('ERR_SANDBOX_PATH_ESCAPE');
  }

  async #assertRegularPathBeforeOpen(resolved, { allowMissing = false } = {}) {
    const info = await stat(resolved).catch((error) => {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return false;
    if (!info.isFile()) fail('ERR_SANDBOX_FILE_NOT_REGULAR');
    return true;
  }

  async #rejectCreateThroughFinalSymlink(resolved) {
    const info = await lstat(resolved).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) {
      await this.#assertResolvedPathWithinRoot(resolved).catch(() => {});
      fail('ERR_SANDBOX_SYMLINK_CREATE_REJECTED');
    }
  }

  async #canonicalRoot() {
    this.canonicalRoot ??= await realpath(this.root);
    return this.canonicalRoot;
  }
}

function assertSandboxFileRequestSupported(request, hostRequest, responseStatusError) {
  if (request?.operation === 'read') return true;
  if (request?.operation === 'write') {
    if (hostRequest.responseSchema?.status && hostRequest.responseSchema.status !== 'ok') fail(responseStatusError);
    return true;
  }
  fail('ERR_SANDBOX_FILE_OPERATION_UNSUPPORTED');
}

function noFollowFlag() {
  return constants.O_NOFOLLOW ?? 0;
}

function nonBlockFlag() {
  return constants.O_NONBLOCK ?? 0;
}

const MAXIMUM_WRITE_ACK_BYTES = 4096;
const DEFAULT_MAXIMUM_RESPONSE_ENVELOPE_BYTES = 1024 * 1024;
const DEFAULT_MAXIMUM_READ_BYTES = Math.floor((DEFAULT_MAXIMUM_RESPONSE_ENVELOPE_BYTES - 256) / 6);

function writeValueImage(outcome) {
  return encodeCanonicalValueImage({
    bytes: fromUtf8(stableJson(outcome)),
    dynamicSize: true,
  });
}

function readValueImage(contentBytes) {
  return encodeCanonicalValueImage({
    bytes: fromUtf8(stableJson({
      contentBase64: Buffer.from(contentBytes).toString('base64'),
      encoding: 'base64',
      status: 'ok',
    })),
    dynamicSize: true,
  });
}

function resolutionInput(hostRequest, payload, responseBytes = fromUtf8(stableJson(payload)), status = 0) {
  return encodeResolutionInputBytes({
    targetHostRequestFingerprint: resolutionTarget(hostRequest),
    status,
    responseValueImageBytes: responseBytes,
    hostClaimBytes: new Uint8Array(),
    attemptNumber: 1,
    metadata: fromUtf8('sandbox-file'),
  });
}

function encodedJsonStringEnvelopeLimit(logicalBytes, overheadBytes) {
  if (logicalBytes > Math.floor((Number.MAX_SAFE_INTEGER - overheadBytes) / 6)) return Number.MAX_SAFE_INTEGER;
  return logicalBytes * 6 + overheadBytes;
}

function resolutionTarget(hostRequest = {}) {
  const value = hostRequest.hostRequestFingerprint;
  if (value === undefined) return 0n;
  if (typeof value === 'bigint' || typeof value === 'number') return BigInt(value);
  const match = String(value).match(/(?:0x)?([0-9a-f]+)$/i);
  if (!match) fail('ERR_HOST_REQUEST_FINGERPRINT_REQUIRED');
  return BigInt(`0x${match[1]}`);
}

function parseJsonBytes(bytes) {
  assertBytes(bytes, 'requestBytes');
  return JSON.parse(new TextDecoder().decode(bytes));
}
