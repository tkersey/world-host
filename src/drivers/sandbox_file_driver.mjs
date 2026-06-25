import { mkdir, open, readFile, rename, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { EffectRecoveryClass } from '../core/actuator.mjs';
import { assertBytes, fail, fromUtf8, stableJson } from '../core/store.mjs';
import { encodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';

export class SandboxFileDriver {
  constructor({ root, allowAbsolute = false, symlinkPolicy = 'reject', maximumReadBytes = 1024 * 1024, maximumWriteBytes = 1024 * 1024 } = {}) {
    if (!root) fail('ERR_SANDBOX_ROOT_REQUIRED');
    this.root = path.resolve(root);
    this.allowAbsolute = allowAbsolute;
    this.symlinkPolicy = symlinkPolicy;
    this.maximumReadBytes = maximumReadBytes;
    this.maximumWriteBytes = maximumWriteBytes;
    this.writeOutcomes = new Map();
  }

  manifest() {
    return {
      driverId: 'sandbox-file',
      supportedActuatorRefs: ['sandbox:file'],
      supportedDescriptorFingerprints: ['descriptor:sandbox-file'],
      supportedActuationClasses: ['file'],
      supportedResponseStatuses: ['ok', 'not_found'],
      maximumRequestBytes: this.maximumWriteBytes,
      maximumResponseBytes: this.maximumReadBytes,
      recoveryClass: EffectRecoveryClass.idempotent,
      concurrencyLimit: 2,
      authorityLabels: ['file:sandbox'],
      diagnostics: { root: this.root, symlinkPolicy: this.symlinkPolicy },
    };
  }

  async resolve(context, hostRequest) {
    const request = parseJsonBytes(hostRequest.requestBytes);
    if (request.operation === 'read') return await this.#read(request.path, hostRequest);
    if (request.operation === 'write') return await this.#write(request.path, request.content ?? '', hostRequest.idempotencyKeyWorldFingerprint, hostRequest);
    fail('ERR_SANDBOX_FILE_OPERATION_UNSUPPORTED');
  }

  async recover(context, effectRecord) {
    const outcome = this.writeOutcomes.get(effectRecord.idempotencyKeyWorldFingerprint);
    if (!outcome && effectRecord.requestBytes) {
      return await this.resolve(context, {
        actuatorRef: effectRecord.actuatorRef,
        descriptorFingerprint: effectRecord.descriptorFingerprint,
        actuationClass: 'file',
        requestBytes: effectRecord.requestBytes,
        idempotencyKeyWorldFingerprint: effectRecord.idempotencyKeyWorldFingerprint,
        hostRequestFingerprint: effectRecord.hostRequestFingerprint,
      });
    }
    if (!outcome) fail('ERR_SANDBOX_FILE_RECOVERY_UNAVAILABLE');
    return { resolutionInputBytes: resolutionInput({ hostRequestFingerprint: effectRecord.hostRequestFingerprint }, outcome), diagnostics: { recovered: true } };
  }

  async #read(filePath, hostRequest) {
    const resolved = await this.#resolvePath(filePath);
    const bytes = await readFile(resolved).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (bytes === null) return { resolutionInputBytes: resolutionInput(hostRequest, { status: 'not_found' }, undefined, 1) };
    if (bytes.byteLength > this.maximumReadBytes) fail('ERR_SANDBOX_FILE_READ_TOO_LARGE');
    return { resolutionInputBytes: resolutionInput(hostRequest, { status: 'ok' }, bytes) };
  }

  async #write(filePath, content, key, hostRequest) {
    const bytes = content instanceof Uint8Array ? content : fromUtf8(String(content));
    if (bytes.byteLength > this.maximumWriteBytes) fail('ERR_SANDBOX_FILE_WRITE_TOO_LARGE');
    const resolved = await this.#resolvePath(filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    if (this.symlinkPolicy === 'reject') await this.#rejectSymlinkComponents(path.dirname(resolved));
    const tmp = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${tempKey(key)}.tmp`);
    const handle = await this.#openTempForWrite(tmp);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await rename(tmp, resolved);
    const outcome = { status: 'ok', path: path.relative(this.root, resolved), byteLength: bytes.byteLength };
    this.writeOutcomes.set(key, outcome);
    return { resolutionInputBytes: resolutionInput(hostRequest, outcome), driverTransactionRef: key };
  }

  async #openTempForWrite(tmp) {
    try {
      return await open(tmp, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(tmp).catch((statError) => {
        if (statError.code === 'ENOENT') return null;
        throw statError;
      });
      if (!info) return await open(tmp, 'wx');
      if (info.isSymbolicLink()) fail('ERR_SANDBOX_SYMLINK_REJECTED');
      if (!info.isFile()) fail('ERR_SANDBOX_TEMP_EXISTS');
      await rm(tmp, { force: true });
      return await open(tmp, 'wx');
    }
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

function tempKey(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
