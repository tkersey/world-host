import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { runCapabilityMode } from '../../src/core/capability_modes.mjs';
import { createCapabilityPolicy } from '../../src/core/capability_policy.mjs';
import { FixtureAgentModelCapabilityDriver } from '../../src/drivers/model_capability_driver.mjs';
import { GenericHttpJsonCapabilityDriver } from '../../src/drivers/generic_http_json_capability_driver.mjs';
import { HumanApprovalCapabilityDriver } from '../../src/drivers/human_approval_capability_driver.mjs';
import { SandboxFileDriver } from '../../src/drivers/sandbox_file_driver.mjs';
import { fromUtf8, stableJson } from '../../src/core/store.mjs';

export async function runExample() {
  const fixtureDriver = new FixtureAgentModelCapabilityDriver();
  const fixtureRequest = modelRequest('goal=invoke', 'fixture-model-key');
  const fixture = await fixtureDriver.resolve({}, fixtureRequest);
  const dryRun = await new GenericHttpJsonCapabilityDriver({
    endpointUrl: 'https://stub.local/decide',
    origins: ['https://stub.local'],
  }).dryRun({}, httpRequest());
  const shadow = await runCapabilityMode({
    mode: 'shadow',
    driver: fixtureDriver,
    hostRequest: fixtureRequest,
    recordedResolution: fixture.resolutionInputBytes,
  });
  const deniedLive = denied(() => runCapabilityMode({
    mode: 'live',
    driver: fixtureDriver,
    hostRequest: fixtureRequest,
    policy: createCapabilityPolicy(),
  }));
  const approvalResult = await approvalFileRewrite();
  return {
    fixtureBaseline: { resolutionBytes: fixture.resolutionInputBytes.byteLength },
    dryRunModel: { submittedToWorld: false, proposedAction: dryRun.proposedAction },
    approvalGatedFileRewrite: approvalResult,
    shadowModel: { submittedToWorld: shadow.submittedToWorld },
    deniedLiveRun: await deniedLive,
    sidecarCapability: { fixture: 'covered by proof:sidecars' },
    externalNetworkUsed: false,
  };
}

async function approvalFileRewrite() {
  const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-example-'));
  try {
    await writeFile(path.join(root, 'output.txt'), 'before');
    const approval = new HumanApprovalCapabilityDriver({ mode: 'noninteractive-allow' });
    const decision = await approval.approve({ proposed: { file: 'output.txt' } });
    if (!decision.approved) return { approved: false };
    const fileDriver = new SandboxFileDriver({ root });
    const result = await fileDriver.resolve({}, fileRequest('output.txt', 'after'));
    return {
      approved: true,
      written: await readFile(path.join(root, 'output.txt'), 'utf8'),
      resolutionBytes: result.resolutionInputBytes.byteLength,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function denied(fn) {
  try {
    await fn();
    return { denied: false };
  } catch (error) {
    return { denied: true, code: error.code ?? error.message };
  }
}

function modelRequest(observation, key) {
  return {
    hostRequestFingerprint: 'world:host-request:0000000000000d01',
    idempotencyKeyBytes: fromUtf8(key),
    idempotencyKeyWorldFingerprint: `world:key:${key}`,
    actuatorRef: 'fixture:agent-model',
    descriptorFingerprint: 'descriptor:fixture-agent-model',
    actuationClass: 'model',
    responseSchema: { status: 'ok' },
    requestBytes: fromUtf8(stableJson({ schema: 'boundary.Agent.DecisionPrompt.v0', observation })),
  };
}

function httpRequest() {
  return {
    hostRequestFingerprint: 'world:host-request:0000000000000d02',
    idempotencyKeyBytes: fromUtf8('dry-run-model-key'),
    idempotencyKeyWorldFingerprint: 'world:key:dry-run-model',
    actuatorRef: 'http:json',
    descriptorFingerprint: 'descriptor:http-json',
    actuationClass: 'http',
    responseSchema: { status: 'ok' },
    requestBytes: fromUtf8(stableJson({ body: { prompt: 'fixture' }, method: 'POST' })),
  };
}

function fileRequest(file, content) {
  return {
    hostRequestFingerprint: 'world:host-request:0000000000000d03',
    idempotencyKeyBytes: fromUtf8(`file-${file}`),
    idempotencyKeyWorldFingerprint: `world:key:file-${file}`,
    actuatorRef: 'sandbox:file',
    descriptorFingerprint: 'descriptor:sandbox-file',
    actuationClass: 'file',
    responseSchema: { status: 'ok' },
    requestBytes: fromUtf8(stableJson({ operation: 'write', path: file, content })),
  };
}
