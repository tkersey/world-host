import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';

import { EffectRecoveryClass } from '../src/core/actuator.mjs';
import {
  CapabilityManifest,
  assertCapabilityManifest,
  capabilityPackFingerprint,
  validateCapabilityPackManifest,
  world_host_capability_driver_abi_version,
  world_host_capability_pack_format_version,
} from '../src/core/capability_pack.mjs';

describe('Capability pack manifest semantic immutability', () => {
  it('keeps a verified sidecar command immutable and fingerprint-stable', async () => {
    const checked = await verifiedManifest({
      adapter: { kind: 'sidecar', command: ['node', 'sidecar.mjs'] },
    });

    assert.equal(Object.isFrozen(checked.adapter.command), true);
    assert.throws(() => {
      checked.adapter.command[1] = 'changed.mjs';
    }, TypeError);
    assert.deepEqual(checked.adapter.command, ['node', 'sidecar.mjs']);
    assert.equal(await capabilityPackFingerprint(checked), checked.packFingerprint);
  });

  it('keeps verified policy requirement lists immutable and fingerprint-stable', async () => {
    const checked = await verifiedManifest({
      policyRequirements: {
        allowLiveEffects: true,
        allowNetworkEffects: true,
        allowFileEffects: true,
        allowedOrigins: ['https://allowed.example'],
        allowedMethods: ['post'],
        allowedFileRoots: ['sandbox'],
      },
    });

    for (const [field, replacement] of [
      ['allowedOrigins', 'https://changed.example'],
      ['allowedMethods', 'DELETE'],
      ['allowedFileRoots', 'changed-root'],
    ]) {
      const expected = [...checked.policyRequirements[field]];
      assert.equal(Object.isFrozen(checked.policyRequirements[field]), true, field);
      assert.throws(() => {
        checked.policyRequirements[field][0] = replacement;
      }, TypeError);
      assert.deepEqual(checked.policyRequirements[field], expected);
      assert.equal(await capabilityPackFingerprint(checked), checked.packFingerprint);
    }
  });

  it('defensively copies and deep-freezes verified structured metadata', async () => {
    const metadataBytes = {
      format: 'json',
      payload: {
        labels: ['stable'],
        details: { version: 1 },
      },
    };
    const checked = await verifiedManifest({ metadataBytes });

    assert.notEqual(checked.metadataBytes, metadataBytes);
    assert.notEqual(checked.metadataBytes.payload, metadataBytes.payload);
    assert.notEqual(checked.metadataBytes.payload.labels, metadataBytes.payload.labels);
    assert.equal(Object.isFrozen(checked.metadataBytes), true);
    assert.equal(Object.isFrozen(checked.metadataBytes.payload), true);
    assert.equal(Object.isFrozen(checked.metadataBytes.payload.labels), true);
    assert.equal(Object.isFrozen(checked.metadataBytes.payload.details), true);
    assert.throws(() => {
      checked.metadataBytes.payload.labels.push('changed');
    }, TypeError);
    assert.throws(() => {
      checked.metadataBytes.payload.details.version = 2;
    }, TypeError);

    metadataBytes.payload.labels[0] = 'source-mutated';
    metadataBytes.payload.details.version = 3;
    assert.deepEqual(checked.metadataBytes.payload, {
      labels: ['stable'],
      details: { version: 1 },
    });
    assert.equal(await capabilityPackFingerprint(checked), checked.packFingerprint);
  });

  it('defensively copies direct-constructor semantic structures', async () => {
    const fields = {
      ...fixtureCapabilityManifest(),
      adapter: { kind: 'sidecar', command: ['node', 'sidecar.mjs'] },
      policyRequirements: {
        allowLiveEffects: true,
        allowedOrigins: ['https://allowed.example'],
        allowedMethods: ['POST'],
        allowedFileRoots: ['sandbox'],
      },
      requiredSecrets: [{ name: 'FIXTURE_SECRET', class: 'opaque', required: true }],
      checksums: [{ path: 'sidecar.mjs', checksum: `sha256:${'1'.repeat(64)}` }],
      metadataBytes: { payload: { labels: ['stable'] } },
    };
    const constructed = new CapabilityManifest(fields);
    const fingerprint = await capabilityPackFingerprint(constructed);

    fields.supportedActuatorRefs[0] = 'fixture:changed';
    fields.requiredSecrets[0].name = 'CHANGED_SECRET';
    fields.checksums[0].path = 'changed.mjs';
    fields.adapter.command[1] = 'changed.mjs';
    fields.policyRequirements.allowedOrigins[0] = 'https://changed.example';
    fields.policyRequirements.allowedMethods[0] = 'DELETE';
    fields.policyRequirements.allowedFileRoots[0] = 'changed-root';
    fields.metadataBytes.payload.labels[0] = 'changed';

    assert.deepEqual(constructed.supportedActuatorRefs, ['fixture:immutable']);
    assert.equal(constructed.requiredSecrets[0].name, 'FIXTURE_SECRET');
    assert.equal(constructed.checksums[0].path, 'sidecar.mjs');
    assert.deepEqual(constructed.adapter.command, ['node', 'sidecar.mjs']);
    assert.deepEqual(constructed.policyRequirements.allowedOrigins, ['https://allowed.example']);
    assert.deepEqual(constructed.policyRequirements.allowedMethods, ['POST']);
    assert.deepEqual(constructed.policyRequirements.allowedFileRoots, ['sandbox']);
    assert.deepEqual(constructed.metadataBytes, { payload: { labels: ['stable'] } });
    for (const value of [
      constructed.supportedActuatorRefs,
      constructed.requiredSecrets,
      constructed.requiredSecrets[0],
      constructed.checksums,
      constructed.checksums[0],
      constructed.adapter,
      constructed.adapter.command,
      constructed.policyRequirements,
      constructed.policyRequirements.allowedOrigins,
      constructed.policyRequirements.allowedMethods,
      constructed.policyRequirements.allowedFileRoots,
      constructed.metadataBytes,
      constructed.metadataBytes.payload,
      constructed.metadataBytes.payload.labels,
    ]) {
      assert.equal(Object.isFrozen(value), true);
    }
    assert.equal(await capabilityPackFingerprint(constructed), fingerprint);
  });

  it('preserves every supported field emitted by manifest normalization', async () => {
    const normalized = assertCapabilityManifest(fixtureCapabilityManifest());

    assert.deepEqual(Reflect.ownKeys(normalized), [
      'formatVersion',
      'packFingerprint',
      'packageName',
      'packageVersion',
      'driverId',
      'driverAbiVersion',
      'supportedWorldProtocolVersion',
      'supportedApplianceAbiVersion',
      'supportedTurnClosureVersion',
      'supportedActuatorRefs',
      'supportedDescriptorFingerprints',
      'supportedActuationClasses',
      'supportedResponseStatuses',
      'recoveryClass',
      'canDryRun',
      'canShadow',
      'canReplay',
      'canRecover',
      'propagatesWorldIdempotencyKey',
      'requiresApproval',
      'requiredSecrets',
      'authorityLabels',
      'policyRequirements',
      'maximumRequestBytes',
      'maximumResponseBytes',
      'conformanceCorpusFingerprint',
      'conformanceReceiptFingerprint',
      'metadataBytes',
      'adapter',
      'checksums',
      'docs',
    ]);
    assert.equal(
      await capabilityPackFingerprint(JSON.parse(JSON.stringify(normalized))),
      await capabilityPackFingerprint(normalized),
    );
  });

  it('rejects serializer hooks, unknown fields, and symbol fields before they can escape fingerprint semantics', async () => {
    const fixture = fixtureCapabilityManifest();
    const expectedFingerprint = await capabilityPackFingerprint(fixture);
    const serializerHook = {
      ...fixture,
      toJSON() {
        return { ...fixture, driverId: 'serialization-only-driver' };
      },
    };
    const unknownField = { ...fixture, serializationOnlyDriver: 'serialization-only-driver' };
    const symbolField = { ...fixture };
    symbolField[Symbol('serialization-only-driver')] = true;

    assert.equal(await capabilityPackFingerprint(serializerHook), expectedFingerprint);
    assert.equal(await capabilityPackFingerprint(unknownField), expectedFingerprint);
    for (const [label, fields] of [
      ['toJSON serializer hook', serializerHook],
      ['unknown field', unknownField],
      ['symbol field', symbolField],
    ]) {
      assert.throws(
        () => new CapabilityManifest(fields),
        { code: 'ERR_CAPABILITY_MANIFEST_INVALID' },
        label,
      );
    }
  });

  it('rejects top-level accessors without invoking them', () => {
    let accessorReads = 0;
    const fields = { ...fixtureCapabilityManifest() };
    Object.defineProperty(fields, 'packageName', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'serialization-only-package';
      },
    });

    assert.throws(
      () => new CapabilityManifest(fields),
      { code: 'ERR_CAPABILITY_MANIFEST_INVALID' },
    );
    assert.equal(accessorReads, 0);
  });

  it('rejects non-JSON structured metadata through validation and direct construction', () => {
    const callableProxy = new Proxy(() => {}, {});
    const symbolKeyed = { value: 'visible' };
    symbolKeyed[Symbol('hidden')] = 'hidden';
    const cyclic = {};
    cyclic.self = cyclic;
    const cases = [
      ['function', { value: () => {} }],
      ['callable proxy', { value: callableProxy }],
      ['symbol', { value: Symbol('value') }],
      ['symbol key', symbolKeyed],
      ['top-level undefined', undefined],
      ['undefined', { value: undefined }],
      ['bigint', { value: 1n }],
      ['non-finite number', { value: Number.NaN }],
      ['non-plain object', { value: new Date(0) }],
      ['accessor', Object.defineProperty({}, 'value', { enumerable: true, get: () => 'unstable' })],
      ['sparse array', { value: Array(1) }],
      ['cycle', cyclic],
    ];

    for (const [label, metadataBytes] of cases) {
      assert.throws(
        () => new CapabilityManifest({ ...fixtureCapabilityManifest(), metadataBytes }),
        { code: 'ERR_CAPABILITY_METADATA_INVALID' },
        `constructor: ${label}`,
      );
      assert.throws(
        () => assertCapabilityManifest({ ...fixtureCapabilityManifest(), metadataBytes }),
        { code: 'ERR_CAPABILITY_METADATA_INVALID' },
        `validator: ${label}`,
      );
    }
  });

  it('normalizes metadata proxy failures and severs accepted proxy aliases', () => {
    const throwingProxy = new Proxy({}, {
      ownKeys() {
        throw new Error('proxy trap failure');
      },
    });
    for (const operation of [
      () => new CapabilityManifest({ ...fixtureCapabilityManifest(), metadataBytes: throwingProxy }),
      () => assertCapabilityManifest({ ...fixtureCapabilityManifest(), metadataBytes: throwingProxy }),
    ]) {
      assert.throws(operation, { code: 'ERR_CAPABILITY_METADATA_INVALID' });
    }

    const proxyTarget = { payload: { labels: ['stable'] } };
    const constructed = new CapabilityManifest({
      ...fixtureCapabilityManifest(),
      metadataBytes: new Proxy(proxyTarget, {}),
    });
    proxyTarget.payload.labels[0] = 'changed';
    assert.deepEqual(constructed.metadataBytes, { payload: { labels: ['stable'] } });
    assert.equal(Object.isFrozen(constructed.metadataBytes.payload.labels), true);
  });
});

async function verifiedManifest(overrides = {}) {
  const manifest = {
    ...fixtureCapabilityManifest(),
    ...overrides,
  };
  manifest.packFingerprint = await capabilityPackFingerprint(manifest);
  return await validateCapabilityPackManifest(manifest, {
    requirePackFingerprint: true,
    verifyFingerprint: true,
  });
}

function fixtureCapabilityManifest() {
  return {
    formatVersion: world_host_capability_pack_format_version,
    packageName: 'world-capability-immutability-fixture',
    packageVersion: '0.2.0',
    driverId: 'immutability-fixture',
    driverAbiVersion: world_host_capability_driver_abi_version,
    supportedWorldProtocolVersion: 'v0.1.0',
    supportedApplianceAbiVersion: 'v4',
    supportedTurnClosureVersion: 'v1',
    supportedActuatorRefs: ['fixture:immutable'],
    supportedDescriptorFingerprints: ['descriptor:fixture-immutable'],
    supportedActuationClasses: ['model'],
    supportedResponseStatuses: ['ok', 'final'],
    recoveryClass: EffectRecoveryClass.pure,
    canDryRun: true,
    canShadow: true,
    canReplay: true,
    canRecover: true,
    propagatesWorldIdempotencyKey: true,
    requiresApproval: false,
    requiredSecrets: [],
    authorityLabels: ['model:fixture-immutable'],
    policyRequirements: {},
    maximumRequestBytes: 1024,
    maximumResponseBytes: 1024,
    conformanceCorpusFingerprint: null,
    conformanceReceiptFingerprint: null,
    metadataBytes: '',
    adapter: { kind: 'in_process', module: 'adapter.mjs', exportName: 'CapabilityDriver' },
    checksums: [],
    docs: [],
  };
}
