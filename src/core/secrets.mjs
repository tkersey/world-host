import { assertBytes, fail, fromUtf8 } from './store.mjs';

const SECRET_PATTERN = /credential|authorization|bearer|token|secret|password|(?:api|access|private)[_-]?key/i;

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
  constructor(env = globalThis.process?.env ?? {}) {
    super();
    this.env = env;
  }

  describe(name) {
    return new SecretDescriptor({ name, provider: 'env', required: true });
  }

  has(name) {
    return typeof this.env[name] === 'string' && this.env[name].length > 0;
  }

  get(name, purpose = 'capability') {
    if (!this.has(name)) fail('ERR_SECRET_MISSING', `missing secret: ${name}`, { name, purpose });
    return this.env[name];
  }

  accessReport(name, purpose = 'capability') {
    return new SecretAccessReport({ name, purpose, available: this.has(name) });
  }
}

export function assertRequiredSecretsAvailable(secretProvider, descriptors) {
  for (const descriptorLike of descriptors ?? []) {
    const descriptor = descriptorLike instanceof SecretDescriptor
      ? descriptorLike
      : new SecretDescriptor(typeof descriptorLike === 'string' ? { name: descriptorLike } : descriptorLike);
    if (descriptor.required && !secretProvider.has(descriptor.name)) fail('ERR_SECRET_MISSING', `missing secret: ${descriptor.name}`, { name: descriptor.name });
  }
  return true;
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
