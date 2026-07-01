import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, symlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { EffectRecoveryClass, assertDriverManifest } from '../src/core/actuator.mjs';
import { createRunPolicy, preflightCapabilities } from '../src/core/capabilities.mjs';
import { EffectJournal } from '../src/core/effect_journal.mjs';
import { FixtureModelDriver } from '../src/drivers/fixture_model_driver.mjs';
import { SandboxFileDriver } from '../src/drivers/sandbox_file_driver.mjs';
import { HttpJsonDriver } from '../src/drivers/http_json_driver.mjs';
import { fromUtf8, stableJson } from '../src/core/store.mjs';
import { decodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';

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
    assert.ok(report.blockers.includes('http-origin-driver-denied:https://blocked.example'));
    assert.equal(report.fileNetworkAuthoritiesAllowed, false);
  });

  it('routes preflight through the first policy-allowed matching driver', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [{ actuatorRef: 'fixture:model' }], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [policyDeniedFixtureDriver(), new FixtureModelDriver({ responses: ['ok'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });
    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyRequiredActuatorCovered, true);
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture-model',
      driverId: 'fixture-model',
    }]);
  });

  it('requires descriptor coverage for application-level actuator requirements', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{
          actuatorRef: 'fixture:model',
          descriptorFingerprint: 'descriptor:other-model',
        }],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      drivers: [new FixtureModelDriver({ responses: ['ok'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.ok(report.blockers.includes('required-actuator-descriptor-uncovered:fixture:model:descriptor:other-model'));
    assert.equal(report.everyRequiredActuatorCovered, false);
    assert.equal(report.executableCompatible, false);
  });

  it('requires declared host authority labels during application preflight', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{
          actuatorRef: 'fixture:model',
          descriptorFingerprint: 'descriptor:fixture-model',
        }],
        requiredHostAuthorityLabels: ['model:fixture-agent'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      drivers: [new FixtureModelDriver({ responses: ['ok'] })],
      policy: createRunPolicy(),
    });

    assert.ok(report.blockers.includes('required-authority-uncovered:model:fixture-agent'));
    assert.equal(report.everyRequiredActuatorCovered, false);
    assert.equal(report.executableCompatible, false);
  });

  it('preserves detailed policy blockers for required host authority labels', async () => {
    const allowedRoot = await mkdtemp(path.join(tmpdir(), 'world-host-authority-allowed-'));
    const blockedRoot = await mkdtemp(path.join(tmpdir(), 'world-host-authority-blocked-'));
    try {
      const report = preflightCapabilities({
        application: {
          requiredActuators: [],
          requiredHostAuthorityLabels: ['file:sandbox'],
          requiredRuntimeLimits: {},
        },
        currentHead: { generation: 0 },
        drivers: [new SandboxFileDriver({ root: blockedRoot })],
        policy: createRunPolicy({
          allowBestEffort: true,
          allowedAuthorityLabels: ['file:sandbox'],
          allowedFileRoots: [allowedRoot],
        }),
      });

      assert.ok(report.blockers.includes('required-authority-policy-blocked:file:sandbox'));
      assert.ok(report.blockers.includes(`file-root-denied:${path.resolve(blockedRoot)}`));
      assert.equal(report.fileNetworkAuthoritiesAllowed, false);
    } finally {
      await rm(allowedRoot, { recursive: true, force: true });
      await rm(blockedRoot, { recursive: true, force: true });
    }
  });

  it('requires authority labels on selected actuator and request drivers', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{
          actuatorRef: 'fixture:model',
          descriptorFingerprint: 'descriptor:fixture-model',
        }],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [
        fixtureDriverWithAuthority([]),
        fixtureDriverWithAuthority(['model:fixture'], {
          driverId: 'dummy-authority',
          actuatorRef: 'fixture:other',
        }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.ok(report.blockers.includes('required-authority-unbound:model:fixture'));
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture-model',
      driverId: 'fixture-model-custom',
    }]);
    assert.equal(report.everyRequiredActuatorCovered, false);
  });

  it('prefers authority-bound routes over earlier unlabeled matches', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{
          actuatorRef: 'fixture:model',
          descriptorFingerprint: 'descriptor:fixture-model',
        }],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [
        fixtureDriverWithAuthority([], { driverId: 'unlabeled-model' }),
        fixtureDriverWithAuthority(['model:fixture'], { driverId: 'labeled-model' }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture-model',
      driverId: 'labeled-model',
    }]);
    assert.equal(report.everyRequiredActuatorCovered, true);
  });

  it('does not prefer unrelated required authority labels for pending routes', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [
          {
            actuatorRef: 'fixture:model',
            descriptorFingerprint: 'descriptor:fixture-model',
          },
          {
            actuatorRef: 'sandbox:file',
            descriptorFingerprint: 'descriptor:sandbox-file',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture', 'file:sandbox'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [
        fixtureDriverWithAuthority(['file:sandbox'], { driverId: 'wrong-label-model' }),
        fixtureDriverWithAuthority(['model:fixture'], { driverId: 'labeled-model' }),
        fixtureDriverWithAuthority(['file:sandbox'], {
          driverId: 'file-required',
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClasses: ['file'],
        }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture', 'file:sandbox'] }),
    });

    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture-model',
      driverId: 'labeled-model',
    }]);
    assert.equal(report.everyRequiredActuatorCovered, true);
  });

  it('does not let inactive actuator routes satisfy active request authority labels', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [
          {
            actuatorRef: 'fixture:model',
            descriptorFingerprint: 'descriptor:fixture-model',
          },
          {
            actuatorRef: 'sandbox:file',
            descriptorFingerprint: 'descriptor:sandbox-file',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture', 'file:sandbox'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fileRequest('out.txt')],
      drivers: [
        fixtureDriverWithAuthority(['model:fixture', 'file:sandbox'], { driverId: 'cross-labeled-model' }),
        fixtureDriverWithAuthority([], {
          driverId: 'unlabeled-file',
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClasses: ['file'],
        }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture', 'file:sandbox'] }),
    });

    assert.ok(report.blockers.includes('required-authority-unbound:file:sandbox'));
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'sandbox:file',
      descriptorFingerprint: 'descriptor:sandbox-file',
      driverId: 'unlabeled-file',
    }]);
    assert.equal(report.everyRequiredActuatorCovered, false);
  });

  it('binds distinct required authority labels to simultaneous pending routes', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [
          {
            actuatorRef: 'fixture:model',
            descriptorFingerprint: 'descriptor:fixture-model',
          },
          {
            actuatorRef: 'sandbox:file',
            descriptorFingerprint: 'descriptor:sandbox-file',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture', 'file:sandbox'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [
        fixtureRequest(),
        fileRequest('out.txt'),
      ],
      drivers: [
        fixtureDriverWithAuthority(['model:fixture']),
        fixtureDriverWithAuthority(['file:sandbox'], {
          driverId: 'file-required',
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClasses: ['file'],
        }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture', 'file:sandbox'] }),
    });

    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.coveredRequests, [
      {
        actuatorRef: 'fixture:model',
        descriptorFingerprint: 'descriptor:fixture-model',
        driverId: 'fixture-model-custom',
      },
      {
        actuatorRef: 'sandbox:file',
        descriptorFingerprint: 'descriptor:sandbox-file',
        driverId: 'file-required',
      },
    ]);
    assert.equal(report.everyRequiredActuatorCovered, true);
  });

  it('does not bind pending request authority to an unused required actuator route', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{
          actuatorRef: 'fixture:model',
          descriptorFingerprint: 'descriptor:fixture-model',
        }],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [
        fixtureDriverWithAuthority(['model:fixture'], {
          driverId: 'labeled-required-only',
          actuationClasses: ['fixture:unused'],
        }),
        fixtureDriverWithAuthority([], { driverId: 'selected-unlabeled-request' }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.ok(report.blockers.includes('required-authority-unbound:model:fixture'));
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'fixture:model',
      descriptorFingerprint: 'descriptor:fixture-model',
      driverId: 'selected-unlabeled-request',
    }]);
    assert.equal(report.everyRequiredActuatorCovered, false);
  });

  it('does not require inactive actuator authorities on unrelated pending request routes', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [
          {
            actuatorRef: 'fixture:model',
            descriptorFingerprint: 'descriptor:fixture-model',
          },
          {
            actuatorRef: 'sandbox:file',
            descriptorFingerprint: 'descriptor:sandbox-file',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture', 'file:sandbox'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [
        fixtureDriverWithAuthority(['model:fixture']),
        fixtureDriverWithAuthority(['file:sandbox'], {
          driverId: 'file-required',
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClasses: ['file'],
        }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture', 'file:sandbox'] }),
    });

    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyRequiredActuatorCovered, true);
  });

  it('does not require an inactive single authority label on unrelated pending request routes', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [
          {
            actuatorRef: 'fixture:model',
            descriptorFingerprint: 'descriptor:fixture-model',
          },
          {
            actuatorRef: 'sandbox:file',
            descriptorFingerprint: 'descriptor:sandbox-file',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [fileRequest('out.txt')],
      drivers: [
        fixtureDriverWithAuthority(['model:fixture']),
        fixtureDriverWithAuthority([], {
          driverId: 'unlabeled-file',
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClasses: ['file'],
        }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.coveredRequests, [{
      actuatorRef: 'sandbox:file',
      descriptorFingerprint: 'descriptor:sandbox-file',
      driverId: 'unlabeled-file',
    }]);
    assert.equal(report.everyRequiredActuatorCovered, true);
  });

  it('does not bind one pending request authority to another pending request route', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [
          {
            actuatorRef: 'fixture:model',
            descriptorFingerprint: 'descriptor:fixture-model',
          },
          {
            actuatorRef: 'sandbox:file',
            descriptorFingerprint: 'descriptor:sandbox-file',
          },
        ],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      pendingRequests: [
        fixtureRequest(),
        fileRequest('out.txt'),
      ],
      drivers: [
        fixtureDriverWithAuthority([], { driverId: 'selected-unlabeled-model' }),
        fixtureDriverWithAuthority(['model:fixture'], {
          driverId: 'unrelated-labeled-file',
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClasses: ['file'],
        }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.ok(report.blockers.includes('required-authority-unbound:model:fixture'));
    assert.deepEqual(report.coveredRequests, [
      {
        actuatorRef: 'fixture:model',
        descriptorFingerprint: 'descriptor:fixture-model',
        driverId: 'selected-unlabeled-model',
      },
      {
        actuatorRef: 'sandbox:file',
        descriptorFingerprint: 'descriptor:sandbox-file',
        driverId: 'unrelated-labeled-file',
      },
    ]);
    assert.equal(report.everyRequiredActuatorCovered, false);
  });

  it('requires authority labels on selected actuator drivers before requests are inspected', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [{
          actuatorRef: 'fixture:model',
          descriptorFingerprint: 'descriptor:fixture-model',
        }],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      drivers: [
        fixtureDriverWithAuthority([]),
        fixtureDriverWithAuthority(['model:fixture'], {
          driverId: 'dummy-authority',
          actuatorRef: 'fixture:other',
        }),
      ],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.ok(report.blockers.includes('required-authority-unbound:model:fixture'));
    assert.equal(report.everyRequiredActuatorCovered, false);
    assert.equal(report.executableCompatible, false);
  });

  it('defers authority binding when pending requests are not available yet', () => {
    const report = preflightCapabilities({
      application: {
        requiredActuators: [],
        requiredHostAuthorityLabels: ['model:fixture'],
        requiredRuntimeLimits: {},
      },
      currentHead: { generation: 0 },
      drivers: [fixtureDriverWithAuthority(['model:fixture'])],
      policy: createRunPolicy({ allowedAuthorityLabels: ['model:fixture'] }),
    });

    assert.deepEqual(report.blockers, []);
    assert.equal(report.everyRequiredActuatorCovered, true);
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
    assert.equal(report.valueSizeLimitsSupported, false);
  });

  it('normalizes partial preflight policies before evaluating blockers', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [fixtureRequest()],
      drivers: [new FixtureModelDriver({ responses: ['ok'] })],
      policy: { maximumRequestBytes: 4096 },
    });

    assert.equal(report.everyPendingRequestCovered, true);
    assert.deepEqual(report.blockers, []);
  });

  it('rejects non-numeric receiver byte limits before preflight comparisons', () => {
    assert.throws(
      () => createRunPolicy({ maximumResponseBytes: '1048576' }),
      { code: 'ERR_RUN_POLICY_LIMIT_INVALID' },
    );
    assert.throws(
      () => createRunPolicy({ maximumRequestBytes: Number.NaN }),
      { code: 'ERR_RUN_POLICY_LIMIT_INVALID' },
    );
  });

  it('keeps default HTTP driver response limits within the default policy', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path')],
      drivers: [new HttpJsonDriver({ origins: ['https://allowed.example'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['network:http'], allowedHttpOrigins: ['https://allowed.example'] }),
    });

    assert.equal(report.valueSizeLimitsSupported, true);
    assert.equal(report.blockers.includes('response-limit-exceeds-policy'), false);
  });

  it('advertises HTTP request envelope limits separately from body limits', () => {
    const request = httpRequest('https://allowed.example/path', 'POST');
    const driver = new HttpJsonDriver({ origins: ['https://allowed.example'], maximumRequestBytes: 4 });

    assert.equal(request.requestBytes.byteLength > 4, true);
    assert.equal(request.requestBytes.byteLength <= driver.manifest().maximumRequestBytes, true);
  });

  it('blocks HTTP method mismatches during preflight', () => {
    const report = preflightCapabilities({
      application: { requiredActuators: [], requiredRuntimeLimits: {} },
      currentHead: { generation: 0 },
      pendingRequests: [httpRequest('https://allowed.example/path', 'POST')],
      drivers: [new HttpJsonDriver({ origins: ['https://allowed.example'], methods: ['GET'] })],
      policy: createRunPolicy({ allowedAuthorityLabels: ['network:http'], allowedHttpOrigins: ['https://allowed.example'] }),
    });

    assert.ok(report.blockers.includes('http-method-driver-denied:POST'));
    assert.equal(report.fileNetworkAuthoritiesAllowed, false);
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

  it('recovers the same fixture model response for the same effect key', async () => {
    const driver = new FixtureModelDriver({ responses: ['first', 'second'] });
    const request = {
      hostRequestFingerprint: 'world:host-request:00000000000000a1',
      idempotencyKeyWorldFingerprint: 'world:key:first',
    };

    const resolved = await driver.resolve({}, request);
    const recovered = await driver.recover({}, request);
    const next = await driver.resolve({}, {
      hostRequestFingerprint: 'world:host-request:00000000000000a2',
      idempotencyKeyWorldFingerprint: 'world:key:second',
    });

    assert.deepEqual([...recovered.resolutionInputBytes], [...resolved.resolutionInputBytes]);
    assert.notDeepEqual([...next.resolutionInputBytes], [...resolved.resolutionInputBytes]);
  });

  it('constrains sandbox file paths, symlinks, and writes', async () => {
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
        () => new SandboxFileDriver({ root, symlinkPolicy: 'allow' }).resolve({}, fileRequest('linkdir/secret.txt')),
        { code: 'ERR_SANDBOX_PATH_ESCAPE' },
      );
      await assert.rejects(
        () => new SandboxFileDriver({ root, symlinkPolicy: 'allow' }).resolve({}, fileRequest('linkdir/new.txt', { operation: 'write', content: 'nope' })),
        { code: 'ERR_SANDBOX_PATH_ESCAPE' },
      );
      await assert.rejects(
        () => readFile(path.join(outside, 'new.txt')),
        { code: 'ENOENT' },
      );
      await symlink(path.join(outside, 'final-new.txt'), path.join(root, 'final-link'));
      await assert.rejects(
        () => new SandboxFileDriver({ root, symlinkPolicy: 'allow' }).resolve({}, fileRequest('final-link', { operation: 'write', content: 'nope' })),
        { code: 'ERR_SANDBOX_SYMLINK_CREATE_REJECTED' },
      );
      await assert.rejects(
        () => readFile(path.join(outside, 'final-new.txt')),
        { code: 'ENOENT' },
      );
      await assert.rejects(
        () => driver.resolve({}, fileRequest('linkdir/new.txt', { operation: 'write', content: 'nope' })),
        { code: 'ERR_SANDBOX_SYMLINK_REJECTED' },
      );
      await writeFile(path.join(outside, 'hardlink-target.txt'), 'outside hardlink content');
      await link(path.join(outside, 'hardlink-target.txt'), path.join(root, 'hardlink-read.txt'));
      await link(path.join(outside, 'hardlink-target.txt'), path.join(root, 'hardlink-write.txt'));
      await assert.rejects(
        () => driver.resolve({}, fileRequest('hardlink-read.txt')),
        { code: 'ERR_SANDBOX_HARDLINK_REJECTED' },
      );
      await assert.rejects(
        () => driver.resolve({}, fileRequest('hardlink-write.txt', { operation: 'write', content: 'pwned' })),
        { code: 'ERR_SANDBOX_HARDLINK_REJECTED' },
      );
      assert.equal(await readFile(path.join(outside, 'hardlink-target.txt'), 'utf8'), 'outside hardlink content');
      await writeFile(path.join(root, 'out.txt'), '');
      const write = await driver.resolve({}, fileRequest('out.txt', { operation: 'write', content: 'world carrier updated the fixture' }));
      const writeImage = decodeResolutionInputBytes(write.resolutionInputBytes).responseValueImageBytes;
      const writeImageView = new DataView(writeImage.buffer, writeImage.byteOffset, writeImage.byteLength);
      assert.equal(writeImageView.getUint32(0, true), 1);
      assert.equal(writeImageView.getUint32(4, true), 1);
      assert.equal(await readFile(path.join(root, 'out.txt'), 'utf8'), 'world carrier updated the fixture');
      await mkdir(path.join(root, 'nested'));
      await writeFile(path.join(root, 'nested', 'out.txt'), '');
      await driver.resolve({}, fileRequest('nested/out.txt', { operation: 'write', content: 'nested write works' }));
      assert.equal(await readFile(path.join(root, 'nested', 'out.txt'), 'utf8'), 'nested write works');
      const edgeWrite = fileRequest('edge.txt', { operation: 'write', content: '1234' }, 'key:edge');
      const edgeDriver = new SandboxFileDriver({ root, maximumWriteBytes: 4 });
      assert.equal(edgeWrite.requestBytes.byteLength > 4, true);
      assert.equal(edgeWrite.requestBytes.byteLength <= edgeDriver.manifest().maximumRequestBytes, true);
      await writeFile(path.join(root, 'edge.txt'), '');
      await edgeDriver.resolve({}, edgeWrite);
      assert.equal(await readFile(path.join(root, 'edge.txt'), 'utf8'), '1234');
      await writeFile(path.join(root, 'safe.txt'), '');
      await driver.resolve({}, fileRequest('safe.txt', { operation: 'write', content: 'safe' }, '../../../../outside'));
      assert.equal(await readFile(path.join(root, 'safe.txt'), 'utf8'), 'safe');
      await assert.rejects(
        () => readFile(path.join(outside, 'outside.tmp')),
        { code: 'ENOENT' },
      );
      const policyJournal = new EffectJournal({
        store: new MemoryStore(),
        runId: 'run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'turn:0',
        policy: { allowBestEffort: true, maximumResponseBytes: 1 },
      });
      await assert.rejects(
        () => policyJournal.resolve({}, {
          ...fileRequest('policy-blocked.txt', { operation: 'write', content: 'blocked-before-rename' }),
          idempotencyKeyBytes: fromUtf8('policy-blocked-key'),
        }, new SandboxFileDriver({ root })),
        { code: 'ERR_EFFECT_RESPONSE_LIMIT_EXCEEDS_POLICY' },
      );
      await assert.rejects(
        () => readFile(path.join(root, 'policy-blocked.txt')),
        { code: 'ENOENT' },
      );
      const recovered = await driver.recover({}, {
        idempotencyKeyWorldFingerprint: 'key:out.txt',
        hostRequestFingerprint: 'sha256:00000000000000a1',
      });
      const decoded = decodeResolutionInputBytes(recovered.resolutionInputBytes);
      assert.equal(decoded.targetHostRequestFingerprint, 0xa1n);
      assert.deepEqual([...decoded.responseValueImageBytes], [...writeImage]);
      const missing = await driver.resolve({}, fileRequest('missing.txt'));
      const missingDecoded = decodeResolutionInputBytes(missing.resolutionInputBytes);
      assert.equal(missingDecoded.status, 1);
      assert.equal(missingDecoded.responseValueImageBytes.byteLength, 0);
      await writeFile(path.join(root, 'empty.txt'), '');
      const emptyReadJournal = new EffectJournal({
        store: new MemoryStore(),
        runId: 'empty-read-run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'turn:0',
        policy: { allowBestEffort: true },
      });
      const emptyRead = await emptyReadJournal.resolve({}, {
        ...fileRequest('empty.txt', { operation: 'read' }, 'key:empty-read'),
        idempotencyKeyBytes: fromUtf8('empty-read-key'),
      }, driver);
      const emptyReadImage = decodeResolutionInputBytes(emptyRead.resolutionInputBytes).responseValueImageBytes;
      const emptyReadView = new DataView(emptyReadImage.buffer, emptyReadImage.byteOffset, emptyReadImage.byteLength);
      assert.equal(emptyRead.record.state, 'resolved');
      assert.equal(emptyReadView.getUint32(0, true), 1);
      assert.equal(emptyReadView.getUint32(4, true), 1);
      await writeFile(path.join(root, 'large.txt'), 'too-large');
      await assert.rejects(
        () => new SandboxFileDriver({ root, maximumReadBytes: 1 }).resolve({}, fileRequest('large.txt')),
        { code: 'ERR_SANDBOX_FILE_READ_TOO_LARGE' },
      );
      if (process.platform !== 'win32') {
        const fifoPath = path.join(root, 'pipe');
        const fifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
        assert.equal(fifo.status, 0, fifo.stderr);
        await assert.rejects(
          () => driver.resolve({}, fileRequest('pipe')),
          { code: 'ERR_SANDBOX_FILE_NOT_REGULAR' },
        );
        await assert.rejects(
          () => driver.resolve({}, fileRequest('pipe', { operation: 'write', content: 'blocked' })),
          { code: 'ERR_SANDBOX_FILE_NOT_REGULAR' },
        );
      }
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
      const edge = new HttpJsonDriver({ origins: ['https://allowed.example'], maximumResponseBytes: 4 });
      globalThis.fetch = async () => new Response('1234');
      const edgeResult = await edge.resolve({}, httpRequest('https://allowed.example/edge'));
      const edgePayload = decodeResolutionInputBytes(edgeResult.resolutionInputBytes).responseValueImageBytes;
      const edgePayloadView = new DataView(edgePayload.buffer, edgePayload.byteOffset, edgePayload.byteLength);
      assert.equal(edgePayloadView.getUint32(0, true), 1);
      assert.equal(edgePayloadView.getUint32(4, true), 1);
      assert.equal(edgePayload.byteLength > 4, true);
      assert.equal(edgePayload.byteLength <= edge.manifest().maximumResponseBytes, true);
      globalThis.fetch = async () => new Response('server failed', { status: 500 });
      const failed = await driver.resolve({}, httpRequest('https://allowed.example/fail', 'GET', { status: 'http_error' }));
      const failedDecoded = decodeResolutionInputBytes(failed.resolutionInputBytes);
      assert.equal(failedDecoded.status, 1);
      assert.equal(failedDecoded.responseValueImageBytes.byteLength, 0);
      const failedSmall = new HttpJsonDriver({ origins: ['https://allowed.example'], maximumResponseBytes: 4 });
      globalThis.fetch = async () => new Response('too-large-error-body', { status: 500 });
      const failedSmallResult = await failedSmall.resolve({}, httpRequest('https://allowed.example/fail-small', 'GET', { status: 'http_error' }));
      assert.equal(decodeResolutionInputBytes(failedSmallResult.resolutionInputBytes).status, 1);
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

function fixtureDriverWithAuthority(authorityLabels, options = {}) {
  return {
    manifest() {
      return {
        driverId: options.driverId ?? 'fixture-model-custom',
        supportedActuatorRefs: [options.actuatorRef ?? 'fixture:model'],
        supportedDescriptorFingerprints: [options.descriptorFingerprint ?? 'descriptor:fixture-model'],
        supportedActuationClasses: options.actuationClasses ?? ['fixture'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024 * 1024,
        maximumResponseBytes: 1024 * 1024,
        recoveryClass: EffectRecoveryClass.pure,
        concurrencyLimit: 1,
        authorityLabels,
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
