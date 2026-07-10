import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';

import { EnvSecretProvider, SecretAccessReport, assertRequiredSecretsAvailable, scopeSecretProvider } from '../src/core/secrets.mjs';

describe('secret provider ownership', () => {
  it('keeps EnvSecretProvider backing environment private without changing direct lookup behavior', () => {
    const env = { DECLARED_SECRET: 'first-value', UNRELATED_SECRET: 'unrelated-value' };
    const provider = new EnvSecretProvider(env);

    assert.equal(Object.isFrozen(provider), true);
    assert.equal('env' in provider, false);
    assert.equal(provider.env, undefined);
    assert.equal(provider.get('UNRELATED_SECRET'), 'unrelated-value');
    assert.throws(() => {
      provider.env = { UNRELATED_SECRET: 'shadow-value' };
    }, TypeError);

    env.UNRELATED_SECRET = 'updated-value';
    assert.equal(provider.get('UNRELATED_SECRET'), 'updated-value');
    assert.equal(provider.env, undefined);
  });

  it('exposes a frozen facade for declared secrets', () => {
    const provider = new EnvSecretProvider({
      DECLARED_SECRET: 'declared-value',
      UNRELATED_SECRET: 'unrelated-value',
    });
    const scoped = scopeSecretProvider(provider, [{ name: 'DECLARED_SECRET', required: true }]);

    assert.equal(Object.isFrozen(scoped), true);
    assert.equal(Object.hasOwn(scoped, 'secretProvider'), false);
    assert.equal(scoped.has('DECLARED_SECRET'), true);
    assert.equal(scoped.get('DECLARED_SECRET', 'test-purpose'), 'declared-value');
    assert.equal(scoped.describe('DECLARED_SECRET').name, 'DECLARED_SECRET');
    const report = scoped.accessReport('DECLARED_SECRET', 'test-purpose');
    assert.equal(report.name, 'DECLARED_SECRET');
    assert.equal(report.purpose, 'test-purpose');
    assert.equal(report.available, true);
    assert.equal(report.valueRedacted, true);
    assert.throws(() => {
      scoped.get = () => 'replacement';
    }, TypeError);
  });

  it('rejects every undeclared operation before delegating', () => {
    const calls = [];
    const provider = {
      describe(name) {
        calls.push(['describe', name]);
        return { name };
      },
      get(name, purpose) {
        calls.push(['get', name, purpose]);
        return 'unrelated-value';
      },
      has(name) {
        calls.push(['has', name]);
        return true;
      },
      accessReport(name, purpose) {
        calls.push(['accessReport', name, purpose]);
        return { name, purpose, available: true, valueRedacted: true };
      },
    };
    const scoped = scopeSecretProvider(provider, ['DECLARED_SECRET']);

    for (const operation of [
      () => scoped.describe('UNRELATED_SECRET'),
      () => scoped.get('UNRELATED_SECRET', 'test-purpose'),
      () => scoped.has('UNRELATED_SECRET'),
      () => scoped.accessReport('UNRELATED_SECRET', 'test-purpose'),
    ]) {
      assert.throws(operation, { code: 'ERR_SECRET_UNDECLARED' });
    }
    assert.deepEqual(calls, []);
  });

  it('requires an array of descriptors', () => {
    const provider = new EnvSecretProvider({ S: 'single-character-value' });

    assert.throws(() => scopeSecretProvider(provider, 'SECRET'), { code: 'ERR_SECRET_DESCRIPTORS_INVALID' });
    assert.throws(() => assertRequiredSecretsAvailable(provider, 'SECRET'), { code: 'ERR_SECRET_DESCRIPTORS_INVALID' });
    assert.throws(() => scopeSecretProvider(provider, new Array(1)), { code: 'ERR_SECRET_DESCRIPTOR_INVALID' });
  });

  it('requires has to return a synchronous boolean', () => {
    for (const has of [async () => true, () => 1]) {
      const provider = {
        describe(name) {
          return { name };
        },
        get() {
          return 'declared-value';
        },
        has,
      };
      const scoped = scopeSecretProvider(provider, ['DECLARED_SECRET']);

      assert.throws(() => scoped.has('DECLARED_SECRET'), { code: 'ERR_SECRET_PROVIDER_CONTRACT' });
      assert.throws(
        () => assertRequiredSecretsAvailable(provider, ['DECLARED_SECRET']),
        { code: 'ERR_SECRET_PROVIDER_CONTRACT' },
      );
      assert.throws(() => scoped.accessReport('DECLARED_SECRET'), { code: 'ERR_SECRET_PROVIDER_CONTRACT' });
    }
  });

  it('synthesizes redacted access reports for minimal providers', () => {
    const provider = {
      describe(name) {
        return { name };
      },
      get() {
        return 'declared-value';
      },
      has(name) {
        return name === 'DECLARED_SECRET';
      },
    };
    const scoped = scopeSecretProvider(provider, ['DECLARED_SECRET']);

    const report = scoped.accessReport('DECLARED_SECRET', 'minimal-provider');
    assert.equal(report instanceof SecretAccessReport, true);
    assert.deepEqual(report, new SecretAccessReport({
      name: 'DECLARED_SECRET',
      purpose: 'minimal-provider',
      available: true,
    }));
  });

  it('preserves asynchronous get, describe, and access-report results with synchronous availability', async () => {
    const provider = {
      async describe(name) {
        return { name, provider: 'async' };
      },
      async get(name, purpose) {
        return `${name}:${purpose}`;
      },
      has(name) {
        return name === 'DECLARED_SECRET';
      },
      async accessReport(name, purpose) {
        return { name, purpose, available: true, valueRedacted: true };
      },
    };
    const scoped = scopeSecretProvider(provider, ['DECLARED_SECRET']);

    assert.deepEqual(await scoped.describe('DECLARED_SECRET'), { name: 'DECLARED_SECRET', provider: 'async' });
    assert.equal(await scoped.get('DECLARED_SECRET', 'async-purpose'), 'DECLARED_SECRET:async-purpose');
    assert.equal(scoped.has('DECLARED_SECRET'), true);
    assert.deepEqual(await scoped.accessReport('DECLARED_SECRET', 'async-purpose'), {
      name: 'DECLARED_SECRET',
      purpose: 'async-purpose',
      available: true,
      valueRedacted: true,
    });
  });
});
