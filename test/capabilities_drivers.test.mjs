import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createRunPolicy, preflightCapabilities } from '../src/core/capabilities.mjs';
import { FixtureModelDriver } from '../src/drivers/fixture_model_driver.mjs';
import { SandboxFileDriver } from '../src/drivers/sandbox_file_driver.mjs';
import { HttpJsonDriver } from '../src/drivers/http_json_driver.mjs';
import { fromUtf8, stableJson } from '../src/core/store.mjs';

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
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects HTTP origins and methods outside allowlists without leaking credentials', async () => {
    const driver = new HttpJsonDriver({ origins: ['https://allowed.example'], methods: ['GET'], credentials: { headers: { Authorization: 'secret', 'X-Trace': 'ok' } } });
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
      assert.equal(JSON.stringify(result.diagnostics).includes('secret'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function fixtureRequest() {
  return {
    actuatorRef: 'fixture:model',
    descriptorFingerprint: 'descriptor:fixture-model',
    actuationClass: 'fixture',
    responseSchema: { status: 'ok' },
    requestBytes: fromUtf8('prompt'),
  };
}

function fileRequest(filePath, request = { operation: 'read' }) {
  return {
    actuatorRef: 'sandbox:file',
    descriptorFingerprint: 'descriptor:sandbox-file',
    actuationClass: 'file',
    responseSchema: { status: 'ok' },
    idempotencyKeyWorldFingerprint: `key:${filePath}`,
    requestBytes: fromUtf8(stableJson({ path: filePath, ...request })),
  };
}

function httpRequest(url, method = 'GET') {
  return {
    actuatorRef: 'http:json',
    descriptorFingerprint: 'descriptor:http-json',
    actuationClass: 'http',
    responseSchema: { status: 'ok' },
    idempotencyKeyWorldFingerprint: `key:${url}`,
    requestBytes: fromUtf8(stableJson({ url, method })),
  };
}
