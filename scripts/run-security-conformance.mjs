#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { createRunPolicy, preflightCapabilities } from '../src/core/capabilities.mjs';
import { SandboxFileDriver } from '../src/drivers/sandbox_file_driver.mjs';
import { HttpJsonDriver } from '../src/drivers/http_json_driver.mjs';
import { fromUtf8, stableJson } from '../src/core/store.mjs';

await pathTraversalRejected();
await symlinkEscapeRejected();
await httpOriginRejected();
await preflightRejectsMissingDriver();

console.log('security_conformance=passed');

async function pathTraversalRejected() {
  const root = await mkdtemp(path.join(tmpdir(), 'world-host-security-'));
  try {
    const driver = new SandboxFileDriver({ root });
    await assert.rejects(() => driver.resolve({}, fileRequest('../escape')), { code: 'ERR_SANDBOX_PATH_ESCAPE' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function symlinkEscapeRejected() {
  const root = await mkdtemp(path.join(tmpdir(), 'world-host-security-'));
  try {
    await symlink('/tmp', path.join(root, 'link'));
    const driver = new SandboxFileDriver({ root });
    await assert.rejects(() => driver.resolve({}, fileRequest('link')), { code: 'ERR_SANDBOX_SYMLINK_REJECTED' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function httpOriginRejected() {
  const driver = new HttpJsonDriver({ origins: ['https://allowed.example'] });
  await assert.rejects(() => driver.resolve({}, httpRequest('https://blocked.example/path')), { code: 'ERR_HTTP_ORIGIN_REJECTED' });
}

async function preflightRejectsMissingDriver() {
  const report = preflightCapabilities({
    application: { requiredActuators: [{ actuatorRef: 'sandbox:file' }], requiredRuntimeLimits: {} },
    currentHead: { generation: 0 },
    pendingRequests: [fileRequest('input.txt')],
    drivers: [],
    policy: createRunPolicy({ allowedAuthorityLabels: ['file:sandbox'] }),
  });
  assert.ok(report.blockers.some((item) => item.includes('uncovered')));
}

function fileRequest(filePath) {
  return {
    actuatorRef: 'sandbox:file',
    descriptorFingerprint: 'descriptor:sandbox-file',
    actuationClass: 'file',
    responseSchema: { status: 'ok' },
    idempotencyKeyWorldFingerprint: `key:${filePath}`,
    requestBytes: fromUtf8(stableJson({ operation: 'read', path: filePath })),
  };
}

function httpRequest(url) {
  return {
    actuatorRef: 'http:json',
    descriptorFingerprint: 'descriptor:http-json',
    actuationClass: 'http',
    responseSchema: { status: 'ok' },
    idempotencyKeyWorldFingerprint: `key:${url}`,
    requestBytes: fromUtf8(stableJson({ url })),
  };
}
