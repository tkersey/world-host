#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';

import { GenericHttpJsonCapabilityDriver } from '../src/drivers/generic_http_json_capability_driver.mjs';
import { EnvSecretProvider } from '../src/core/secrets.mjs';
import { redactCapabilityDiagnostics } from '../src/core/capability_policy.mjs';
import { fromUtf8, stableJson } from '../src/core/store.mjs';

if (process.env.WORLD_HOST_LIVE_SMOKE !== '1') {
  console.log(JSON.stringify({ skipped: true, reason: 'WORLD_HOST_LIVE_SMOKE not set to 1' }, null, 2));
  process.exit(0);
}

const configPath = valueAfter('--config');
const secretProviderName = valueAfter('--secret-provider');
const allowOrigin = valueAfter('--allow-origin');
const live = process.argv.includes('--live');
const allowDestructive = process.argv.includes('--allow-destructive');

if (!configPath) throw new Error('ERR_LIVE_SMOKE_CONFIG_REQUIRED');
if (!secretProviderName) throw new Error('ERR_LIVE_SMOKE_SECRET_PROVIDER_REQUIRED');
if (!allowOrigin) throw new Error('ERR_LIVE_SMOKE_ALLOWLIST_REQUIRED');

const config = JSON.parse(await readFile(configPath, 'utf8'));
if (config.destructive === true && !allowDestructive) throw new Error('ERR_LIVE_SMOKE_DESTRUCTIVE_REQUIRES_OPT_IN');
if (secretProviderName !== 'env') throw new Error('ERR_LIVE_SMOKE_SECRET_PROVIDER_UNSUPPORTED');

const driver = new GenericHttpJsonCapabilityDriver({
  endpointUrl: config.endpointUrl,
  origins: [allowOrigin],
  methods: config.methods ?? ['POST'],
  secretHeaders: config.secretHeaders ?? {},
  secretProvider: new EnvSecretProvider(),
  responseExtractionPath: config.responseExtractionPath ?? null,
});

const hostRequest = {
  hostRequestFingerprint: 'world:host-request:0000000000000c02',
  idempotencyKeyBytes: fromUtf8(config.idempotencyKey ?? 'live-smoke-key'),
  idempotencyKeyWorldFingerprint: 'world:key:live-smoke',
  actuatorRef: 'http:json',
  descriptorFingerprint: 'descriptor:http-json',
  actuationClass: 'http',
  responseSchema: { status: 'ok' },
  requestBytes: fromUtf8(stableJson({ body: config.body ?? {}, method: config.method ?? 'POST' })),
};

const diagnostics = live
  ? await driver.resolve({
      mode: 'live',
      policy: {
        allowLiveEffects: true,
        allowNetworkEffects: true,
        allowedOrigins: [allowOrigin],
        allowedMethods: config.methods ?? ['POST'],
      },
    }, hostRequest)
  : await driver.dryRun({}, hostRequest);

console.log(JSON.stringify(redactCapabilityDiagnostics({
  kind: 'CapabilitySmokeReceipt',
  mode: live ? 'live' : 'dry-run',
  destructiveAllowed: allowDestructive,
  diagnostics,
}), null, 2));

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}
