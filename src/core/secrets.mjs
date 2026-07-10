import { assertBytes, fail, fromUtf8 } from './store.mjs';

const SECRET_PATTERN = /credential|authorization|bearer|token|secret|password|(?:api|access|private)[_-]?key|sk-[A-Za-z0-9_-]{8,}/i;

export class SecretDescriptor {
  constructor({ name, class: secretClass = 'opaque', provider = null, required = true } = {}) {
    if (typeof name !== 'string' || name.length === 0) fail('ERR_SECRET_DESCRIPTOR_INVALID', 'secret name is required');
    this.name = name;
    this.class = secretClass;
    this.provider = provider;
    this.required = required !== false;
    this.redacted = true;
    Object.freeze(this);
  }
}

export class SecretProvider {
  describe() { fail('ERR_SECRET_PROVIDER_METHOD_REQUIRED'); }
  get() { fail('ERR_SECRET_PROVIDER_METHOD_REQUIRED'); }
  has() { fail('ERR_SECRET_PROVIDER_METHOD_REQUIRED'); }
}

export class SecretAccessReport {
  constructor(fields = {}) {
    this.name = fields.name;
    this.purpose = fields.purpose ?? null;
    this.available = fields.available === true;
    this.valueRedacted = true;
    Object.freeze(this);
  }
}

export class EnvSecretProvider extends SecretProvider {
  #env;

  constructor(env = globalThis.process?.env ?? {}) {
    super();
    this.#env = env;
    Object.freeze(this);
  }

  describe(name) {
    return new SecretDescriptor({ name, provider: 'env', required: true });
  }

  has(name) {
    return typeof this.#env[name] === 'string' && this.#env[name].length > 0;
  }

  get(name, purpose = 'capability') {
    if (!this.has(name)) fail('ERR_SECRET_MISSING', `missing secret: ${name}`, { name, purpose });
    return this.#env[name];
  }

  accessReport(name, purpose = 'capability') {
    return new SecretAccessReport({ name, purpose, available: this.has(name) });
  }
}

export function scopeSecretProvider(secretProvider, descriptors) {
  const declaredNames = new Set(secretDescriptors(descriptors).map((descriptor) => descriptor.name));
  const assertDeclared = (name, purpose = null) => {
    if (!declaredNames.has(name)) fail('ERR_SECRET_UNDECLARED', `undeclared secret: ${name}`, { name, purpose });
  };
  return Object.freeze({
    describe(name) {
      assertDeclared(name);
      return secretProvider.describe(name);
    },
    get(name, purpose = 'capability') {
      assertDeclared(name, purpose);
      return secretProvider.get(name, purpose);
    },
    has(name) {
      assertDeclared(name);
      return secretProviderHas(secretProvider, name);
    },
    accessReport(name, purpose = 'capability') {
      assertDeclared(name, purpose);
      if (secretProvider?.accessReport == null) {
        return new SecretAccessReport({ name, purpose, available: secretProviderHas(secretProvider, name) });
      }
      if (typeof secretProvider.accessReport !== 'function') {
        fail('ERR_SECRET_PROVIDER_CONTRACT', 'secret provider accessReport must be a function', { method: 'accessReport' });
      }
      return secretProvider.accessReport(name, purpose);
    },
  });
}

export function assertRequiredSecretsAvailable(secretProvider, descriptors) {
  for (const descriptor of secretDescriptors(descriptors)) {
    if (descriptor.required && !secretProviderHas(secretProvider, descriptor.name)) fail('ERR_SECRET_MISSING', `missing secret: ${descriptor.name}`, { name: descriptor.name });
  }
  return true;
}

function secretDescriptors(descriptors) {
  if (!Array.isArray(descriptors)) fail('ERR_SECRET_DESCRIPTORS_INVALID', 'secret descriptors must be an array');
  return Array.from(descriptors, secretDescriptor);
}

function secretProviderHas(secretProvider, name) {
  if (typeof secretProvider?.has !== 'function') {
    fail('ERR_SECRET_PROVIDER_CONTRACT', 'secret provider has must be a function', { method: 'has', name });
  }
  const available = secretProvider.has(name);
  if (typeof available !== 'boolean') {
    fail('ERR_SECRET_PROVIDER_CONTRACT', 'secret provider has must return a synchronous boolean', { method: 'has', name });
  }
  return available;
}

function secretDescriptor(descriptorLike) {
  return descriptorLike instanceof SecretDescriptor
    ? descriptorLike
    : new SecretDescriptor(typeof descriptorLike === 'string' ? { name: descriptorLike } : descriptorLike);
}

export function secretBytes(value) {
  if (value instanceof Uint8Array) return assertBytes(value, 'secret');
  if (typeof value === 'string') return fromUtf8(value);
  fail('ERR_SECRET_VALUE_INVALID', 'secret must be bytes or string');
}

export function redactSecrets(value) {
  if (typeof value === 'string') return SECRET_PATTERN.test(value) ? '[redacted]' : value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SECRET_PATTERN.test(key) ? '[redacted]' : redactSecrets(child),
  ]));
}

export function assertNoSecretValuePersisted(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/sk-[A-Za-z0-9_-]{8,}/.test(text)) fail('ERR_SECRET_PERSISTED');
  return true;
}
