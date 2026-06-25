import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { EffectRecoveryClass, assertDriverManifest } from '../src/core/actuator.mjs';
import { createRunPolicy, preflightCapabilities } from '../src/core/capabilities.mjs';
import { FixtureModelDriver } from '../src/drivers/fixture_model_driver.mjs';
import { SandboxFileDriver } from '../src/drivers/sandbox_file_driver.mjs';
import { HttpJsonDriver } from '../src/drivers/http_json_driver.mjs';
import { fromUtf8, stableJson } from '../src/core/store.mjs';
import { decodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';

describe('capability preflight and reference drivers', () => {
  it('accepts only exact driver manifest coverage under receiver-local policy', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [{ actuatorRef: 'fixture:model' }], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [new FixtureModelDriver({ responses: ['ok'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });
    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyPendingRequestCovered, true);
  });

  it('rejects sender-style uncovered authority and HTTP origins outside local policy', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://blocked.example/path')],
      drivers: [new HttpJsonDriver({ origins: ['https://allowed.example'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['network:http'], allowedHttpOrigins: ['https://allowed.example'] }),
    });
    assert.ok(report.blockers.includes('http-origin-denied:https://blocked.example'));
  });

  it('routes preflight through the first policy-allowed matching driver', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [policyDeniedFixtureDriver(), new FixtureModelDriver({ responses: ['ok'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });
    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture-model',
      driverId: 'fixture-model',
    }]);
  });

  it('applies receiver policy to required actuators and sandbox roots', async () => {
    const allowedRoot = await mkdtemp(path.join(tmpdir(), 'world-host-allowed-root-'));
    const blockedRoot = await mkdtemp(path.join(tmpdir(), 'world-host-blocked-root-'));
    try {
      const requiredReport = preflightCapabilities({
        application: { requiredActuators: [{ actuatorRef: 'fixture:model' }], requiredRuntimeLimits: {} },
        currentHead: { generation: 0 },
        drivers: [policyDeniedFixtureDriver()],
        policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
      });
      assert.ok(requiredReport.blockers.includes('required-actuator-policy-blocked:fixture:model'));
      assert.ok(requiredReport.blockers.includes('authority-denied:denied:fixture'));

      const fileReport = preflightCapabilities({
        application: { requiredActuators: [], requiredRuntimeLimits: {} },
        currentHead: { generation: 0 },
        pendingRequests: [fileRequest('out.txt', { operation: 'write', content: 'blocked' })],
        drivers: [new SandboxFileDriver({ root: blockedRoot })],
        policy: createRunPolicy({
          allowBestEffort: true,
          allowedAuthorityLabels: ['file:sandbox'],
          allowedFileRoots: [allowedRoot],
        }),
      });
      assert.ok(fileReport.blockers.includes(`file-root-denied:${path.resolve(blockedRoot)}`));
      assert.equal(fileReport.fileNetworkAuthoritiesAllowed, false);
    } finally {
      await rm(allowedRoot, { recursive: true, force: true });
      await rm(blockedRoot, { recursive: true, force: true });
    }
  });

  it('reports unsupported response statuses separately from uncovered requests', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path', 'GET', { status: 'streaming' })],
      drivers: [new HttpJsonDriver({ origins: ['https://allowed.example'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['network:http'], allowedHttpOrigins: ['https://allowed.example'] }),
    });
    assert.ok(report.blockers.includes('ERR_RESPONSE_STATUS_NOT_SUPPORTED'));
    assert.equal(report.everyPendingRequestCovered, true);
    assert.equal(report.responseStatusesSupported, false);
  });

  it('reports receiver byte-limit policy blockers for otherwise matching drivers', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [new FixtureModelDriver({ responses: ['ok'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'], maximumRequestBytes: 4096, maximumResponseBytes: 1 }),
    });
    assert.ok(report.blockers.includes('response-limit-exceeds-policy'));
    assert.equal(report.everyPendingRequestCovered, true);
  });

  it('rejects zero-concurrency driver manifests before preflight can cover requests', () => {
    assert.throws(
      () => assertDriverManifest({ ...policyDeniedFixtureDriver().manifest(), concurrencyLimit: 0 }),
      { code: 'ERR_INVALID_DRIVER_MANIFEST' },
    );
  });

  it('preserves HostRequest identity during fixture model recovery', async () => {
    const driver = new FixtureModelDriver({ responses: ['recovered'] });
    const recovered = await driver.recover({}, {
      hostRequestFingerprint: 'world:host-request:00000000000000a1',
    });
    const decoded = decodeResolutionInputBytes(recovered.resolutionInputBytes);
    assert.equal(decoded.targetHostRequestFingerprint, 0xa1n);
  });

  it('constrains sandbox file paths, symlinks, and atomic writes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-sandbox-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'world-host-outside-'));
    try {
      const driver = new SandboxFileDriver({ root });
      await assert.rejects(
        () => driver.resolve({}, fileRequest('../escape.txt')),
        { code: 'ERR_SANDBOX_PATH_ESCAPE' },
      );
      await symlink('/tmp', path.join(root, 'link'));
      await assert.rejects(
        () => driver.resolve({}, fileRequest('link')),
        { code: 'ERR_SANDBOX_SYMLINK_REJECTED' },
      );
      await writeFile(path.join(outside, 'secret.txt'), 'secret');
      await symlink(outside, path.join(root, 'linkdir'));
      await assert.rejects(
        () => driver.resolve({}, fileRequest('linkdir/secret.txt')),
        { code: 'ERR_SANDBOX_SYMLINK_REJECTED' },
      );
      await assert.rejects(
        () => driver.resolve({}, fileRequest('linkdir/new.txt', { operation: 'write', content: 'nope' })),
        { code: 'ERR_SANDBOX_SYMLINK_REJECTED' },
      );
      await driver.resolve({}, fileRequest('out.txt', { operation: 'write', content: 'world carrier updated the fixture' }));
      assert.equal(await readFile(path.join(root, 'out.txt'), 'utf8'), 'world carrier updated the fixture');
      await driver.resolve({}, fileRequest('nested/out.txt', { operation: 'write', content: 'nested write works' }));
      assert.equal(await readFile(path.join(root, 'nested', 'out.txt'), 'utf8'), 'nested write works');
      const symlinkKey = 'temp-symlink-key';
      await symlink(path.join(outside, 'outside.tmp'), path.join(root, `.blocked.txt.${sha256(symlinkKey)}.tmp`));
      await assert.rejects(
        () => driver.resolve({}, fileRequest('blocked.txt', { operation: 'write', content: 'blocked' }, symlinkKey)),
        { code: 'ERR_SANDBOX_SYMLINK_REJECTED' },
      );
      await assert.rejects(
        () => readFile(path.join(outside, 'outside.tmp')),
        { code: 'ENOENT' },
      );
      const staleKey = 'stale-temp-key';
      await writeFile(path.join(root, `.stale.txt.${sha256(staleKey)}.tmp`), 'stale');
      await driver.resolve({}, fileRequest('stale.txt', { operation: 'write', content: 'recovered from stale temp' }, staleKey));
      assert.equal(await readFile(path.join(root, 'stale.txt'), 'utf8'), 'recovered from stale temp');
      await assert.rejects(
        () => readFile(path.join(root, `.stale.txt.${sha256(staleKey)}.tmp`)),
        { code: 'ENOENT' },
      );
      await driver.resolve({}, fileRequest('safe.txt', { operation: 'write', content: 'safe' }, '../../../../outside'));
      assert.equal(await readFile(path.join(root, 'safe.txt'), 'utf8'), 'safe');
      await assert.rejects(
        () => readFile(path.join(outside, 'outside.tmp')),
        { code: 'ENOENT' },
      );
      const recovered = await driver.recover({}, {
        idempotencyKeyWorldFingerprint: 'key:out.txt',
        hostRequestFingerprint: 'sha256:00000000000000a1',
      });
      const decoded = decodeResolutionInputBytes(recovered.resolutionInputBytes);
      const payload = JSON.parse(new TextDecoder().decode(decoded.responseValueImageBytes));
      assert.equal(decoded.targetHostRequestFingerprint, 0xa1n);
      assert.deepEqual(payload, { byteLength: 33, path: 'out.txt', status: 'ok' });
      const restarted = new SandboxFileDriver({ root });
      await assert.rejects(() => restarted.recover({}, {
        actuatorRef: 'sandbox:file',
        descriptorFingerprint: 'descriptor:sandbox-file',
        idempotencyKeyWorldFingerprint: 'key:restart.txt',
        hostRequestFingerprint: 'sha256:00000000000000a2',
        requestBytes: fromUtf8(stableJson({ path: 'restart.txt', operation: 'write', content: 'recovered after restart' })),
      }), { code: 'ERR_SANDBOX_FILE_RECOVERY_UNAVAILABLE' });
      await assert.rejects(
        () => readFile(path.join(root, 'restart.txt')),
        { code: 'ENOENT' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects HTTP origins and methods outside allowlists without leaking credentials', async () => {
    const driver = new HttpJsonDriver({ origins: ['https://allowed.example'], methods: ['GET'], credentials: { headers: { Authorization: 'secret', 'X-Trace': 'ok', 'Idempotency-Key': 'credential-key' } } });
    assert.deepEqual(driver.manifest().diagnostics.origins, ['https://allowed.example']);
    await assert.rejects(
      () => driver.resolve({}, httpRequest('https://blocked.example/path')),
      { code: 'ERR_HTTP_ORIGIN_REJECTED' },
    );
    await assert.rejects(
      () => driver.resolve({}, httpRequest('https://allowed.example/path', 'POST')),
      { code: 'ERR_HTTP_METHOD_REJECTED' },
    );
    const originalFetch = globalThis.fetch;
    let requestHeaders = null;
    try {
      globalThis.fetch = async (url, options) => {
        requestHeaders = options.headers;
        return new Response('{"ok":true}', { status: 200, headers: { 'x-request-id': 'request-1' } });
      };
      const result = await driver.resolve({}, httpRequest('https://allowed.example/path'));
      assert.equal(requestHeaders.Authorization, 'secret');
      assert.equal(requestHeaders['X-Trace'], 'ok');
      assert.equal(requestHeaders['Idempotency-Key'], 'key:https://allowed.example/path');
      assert.equal(JSON.stringify(result.diagnostics).includes('secret'), false);
      globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://blocked.example/next' } });
      await assert.rejects(
        () => driver.resolve({}, httpRequest('https://allowed.example/redirect')),
        { code: 'ERR_HTTP_REDIRECT_REJECTED' },
      );
      const small = new HttpJsonDriver({ origins: ['https://allowed.example'], maximumResponseBytes: 4 });
      globalThis.fetch = async () => new Response('too-large');
      await assert.rejects(
        () => small.resolve({}, httpRequest('https://allowed.example/large')),
        { code: 'ERR_HTTP_RESPONSE_TOO_LARGE' },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function policyDeniedFixtureDriver() {
  return {
    manifest() {
      return {
        driverId: 'policy-denied-fixture',
        supportedActuatorRefs: ['fixture:model'],
        supportedDescriptorFingerprints: ['descriptor:fixture-model'],
        supportedActuationClasses: ['fixture'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024 * 1024,
        maximumResponseBytes: 1024 * 1024,
        recoveryClass: EffectRecoveryClass.pure,
        concurrencyLimit: 1,
        authorityLabels: ['denied:fixture'],
        diagnostics: {},
      };
    },
  };
}

function fixtureRequest() {
  return {
    actuatorRef: 'fixture:model',
    descriptorFingerprint: 'descriptor:fixture-model',
    actuationClass: 'fixture',
    responseSchema: { status: 'ok' },
    requestBytes: fromUtf8('prompt'),
  };
}

function fileRequest(filePath, request = { operation: 'read' }, idempotencyKeyWorldFingerprint = `key:${filePath}`) {
  return {
    actuatorRef: 'sandbox:file',
    descriptorFingerprint: 'descriptor:sandbox-file',
    actuationClass: 'file',
    responseSchema: { status: 'ok' },
    idempotencyKeyWorldFingerprint,
    requestBytes: fromUtf8(stableJson({ path: filePath, ...request })),
  };
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function httpRequest(url, method = 'GET', responseSchema = { status: 'ok' }) {
  return {
    actuatorRef: 'http:json',
    descriptorFingerprint: 'descriptor:http-json',
    actuationClass: 'http',
    responseSchema,
    idempotencyKeyWorldFingerprint: `key:${url}`,
    requestBytes: fromUtf8(stableJson({ url, method })),
  };
}
