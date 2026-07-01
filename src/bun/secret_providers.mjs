import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
    try {
      return existsSync(this.#path(name));
    } catch {
      return false;
    }
  }

  async get(name, purpose = 'capability') {
    const file = this.#path(name);
    const value = await readFile(file, 'utf8');
    if (!value.length) fail('ERR_SECRET_MISSING', `empty secret: ${name}`, { name, purpose });
    return value.replace(/\n$/, '');
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
    return this.cache.has(name);
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
