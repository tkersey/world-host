#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { GenericHttpJsonCapabilityDriver } from '../src/drivers/generic_http_json_capability_driver.mjs';
import { EnvSecretProvider } from '../src/core/secrets.mjs';
import { redactCapabilityDiagnostics } from '../src/core/capability_policy.mjs';
import { fromUtf8, stableJson } from '../src/core/store.mjs';
import { decodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';

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

const idempotencyKeyBytes = fromUtf8(config.idempotencyKey ?? 'live-smoke-key');
const requestMethod = config.method ?? config.methods?.[0] ?? 'POST';
const hostRequest = {
  hostRequestFingerprint: 'world:host-request:0000000000000c02',
  idempotencyKeyBytes,
  idempotencyKeyWorldFingerprint: `world:key:live-smoke:${createHash('sha256').update(idempotencyKeyBytes).digest('hex')}`,
  actuatorRef: 'http:json',
  descriptorFingerprint: 'descriptor:http-json',
  actuationClass: 'http',
  requestBytes: fromUtf8(stableJson({ body: config.body ?? {}, method: requestMethod })),
};

const diagnostics = live
  ? summarizeLiveResult(await driver.resolve({
      mode: 'live',
      policy: {
        allowLiveEffects: true,
        allowNetworkEffects: true,
        allowedOrigins: [allowOrigin],
        allowedMethods: config.methods ?? ['POST'],
      },
    }, hostRequest))
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

function summarizeLiveResult(result) {
  const resolution = decodeResolutionInputBytes(result.resolutionInputBytes);
  if (resolution.status !== 0) throw new Error('ERR_LIVE_SMOKE_HTTP_ERROR_RESOLUTION');
  return {
    diagnostics: result.diagnostics ?? {},
    driverTransactionRef: result.driverTransactionRef ?? null,
    resolutionInputBytes: byteCount(result.resolutionInputBytes),
    hostClaimBytes: byteCount(result.hostClaimBytes),
  };
}

function byteCount(value) {
  return value instanceof Uint8Array ? { byteLength: value.byteLength } : null;
}
