import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { EnvSecretProvider, SecretAccessReport, SecretDescriptor, SecretProvider } from '../core/secrets.mjs';
import { fail } from '../core/store.mjs';

export { EnvSecretProvider };

export class FileSecretProvider extends SecretProvider {
  constructor({ root, mapping = {} } = {}) {
    super();
    if (!root) fail('ERR_SECRET_FILE_ROOT_REQUIRED');
    this.root = path.resolve(root);
    this.mapping = mapping;
  }

  describe(name) {
    return new SecretDescriptor({ name, provider: 'file', required: true });
  }

  has(name) {
    let handle;
    try {
      handle = this.#openSafeSync(name);
      return normalizeFileSecretValue(readFileSync(handle, 'utf8')).length > 0;
    } catch {
      return false;
    } finally {
      if (handle != null) closeSync(handle);
    }
  }

  async get(name, purpose = 'capability') {
    const handle = await this.#openSafe(name);
    let value;
    try {
      value = normalizeFileSecretValue(await handle.readFile('utf8'));
    } finally {
      await handle.close();
    }
    if (!value.length) fail('ERR_SECRET_MISSING', `empty secret: ${name}`, { name, purpose });
    return value;
  }

  async accessReport(name, purpose = 'capability') {
    return new SecretAccessReport({ name, purpose, available: await this.has(name) });
  }

  #path(name) {
    const relative = this.mapping[name] ?? name;
    if (typeof relative !== 'string' || relative.length === 0 || path.isAbsolute(relative) || relative.split(/[\\/]+/).includes('..')) {
      fail('ERR_SECRET_FILE_PATH_INVALID');
    }
    const file = path.resolve(this.root, relative);
    if (file !== this.root && !file.startsWith(`${this.root}${path.sep}`)) fail('ERR_SECRET_FILE_PATH_INVALID');
    return file;
  }

  async #openSafe(name) {
    const file = this.#path(name);
    const info = await lstat(file).catch(() => fail('ERR_SECRET_MISSING', `missing secret: ${name}`));
    if (info.isSymbolicLink() || !info.isFile()) fail('ERR_SECRET_FILE_PATH_INVALID');
    const root = await realpath(this.root).catch(() => fail('ERR_SECRET_FILE_ROOT_INVALID'));
    const actual = await realpath(file).catch(() => fail('ERR_SECRET_MISSING', `missing secret: ${name}`));
    if (!pathInside(root, actual)) fail('ERR_SECRET_FILE_PATH_INVALID');
    const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
      if (error?.code === 'ELOOP') fail('ERR_SECRET_FILE_PATH_INVALID');
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') fail('ERR_SECRET_MISSING', `missing secret: ${name}`);
      throw error;
    });
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) fail('ERR_SECRET_FILE_PATH_INVALID');
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  #openSafeSync(name) {
    const file = this.#path(name);
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) fail('ERR_SECRET_FILE_PATH_INVALID');
    const root = realpathSync(this.root);
    const actual = realpathSync(file);
    if (!pathInside(root, actual)) fail('ERR_SECRET_FILE_PATH_INVALID');
    const handle = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(handle);
      if (!opened.isFile()) fail('ERR_SECRET_FILE_PATH_INVALID');
      return handle;
    } catch (error) {
      closeSync(handle);
      throw error;
    }
  }
}

function normalizeFileSecretValue(value) {
  return value.replace(/\r?\n$/, '');
}

function pathInside(root, target) {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class PromptSecretProvider extends SecretProvider {
  constructor({ prompt } = {}) {
    super();
    if (typeof prompt !== 'function') fail('ERR_SECRET_PROMPT_REQUIRED');
    this.prompt = prompt;
    this.cache = new Map();
  }

  describe(name) {
    return new SecretDescriptor({ name, provider: 'prompt', required: true });
  }

  has(name) {
    return this.cache.has(name) || typeof this.prompt === 'function';
  }

  async get(name, purpose = 'capability') {
    if (!this.cache.has(name)) {
      const value = await this.prompt({ name, purpose });
      if (typeof value !== 'string' || value.length === 0) fail('ERR_SECRET_MISSING', `missing secret: ${name}`, { name, purpose });
      this.cache.set(name, value);
    }
    return this.cache.get(name);
  }

  accessReport(name, purpose = 'capability') {
    return new SecretAccessReport({ name, purpose, available: this.has(name) });
  }
}
