import { mkdir, readFile, rename, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { EffectRecoveryClass } from '../core/actuator.mjs';
import { assertBytes, fail, fromUtf8, stableJson } from '../core/store.mjs';

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
    if (request.operation === 'read') return await this.#read(request.path);
    if (request.operation === 'write') return await this.#write(request.path, request.content ?? '', hostRequest.idempotencyKeyWorldFingerprint);
    fail('ERR_SANDBOX_FILE_OPERATION_UNSUPPORTED');
  }

  async recover(context, effectRecord) {
    const outcome = this.writeOutcomes.get(effectRecord.idempotencyKeyWorldFingerprint);
    if (!outcome) fail('ERR_SANDBOX_FILE_RECOVERY_UNAVAILABLE');
    return { resolutionInputBytes: fromUtf8(stableJson(outcome)), diagnostics: { recovered: true } };
  }

  async #read(filePath) {
    const resolved = await this.#resolvePath(filePath);
    const bytes = await readFile(resolved).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (bytes === null) return { resolutionInputBytes: fromUtf8(stableJson({ status: 'not_found' })) };
    if (bytes.byteLength > this.maximumReadBytes) fail('ERR_SANDBOX_FILE_READ_TOO_LARGE');
    return { resolutionInputBytes: new Uint8Array(bytes) };
  }

  async #write(filePath, content, key) {
    const bytes = content instanceof Uint8Array ? content : fromUtf8(String(content));
    if (bytes.byteLength > this.maximumWriteBytes) fail('ERR_SANDBOX_FILE_WRITE_TOO_LARGE');
    const resolved = await this.#resolvePath(filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    if (this.symlinkPolicy === 'reject') await this.#rejectSymlinkComponents(path.dirname(resolved));
    const tmp = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${key}.tmp`);
    await writeFile(tmp, bytes);
    await rename(tmp, resolved);
    const outcome = { status: 'ok', path: path.relative(this.root, resolved), byteLength: bytes.byteLength };
    this.writeOutcomes.set(key, outcome);
    return { resolutionInputBytes: fromUtf8(stableJson(outcome)), driverTransactionRef: key };
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

function parseJsonBytes(bytes) {
  assertBytes(bytes, 'requestBytes');
  return JSON.parse(new TextDecoder().decode(bytes));
}
