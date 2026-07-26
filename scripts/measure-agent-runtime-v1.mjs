#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const options = parseArgs(process.argv.slice(2));
const host = await import(pathToFileURL(path.join(options.pack, 'host/src/v1/index.mjs')).href);
const capabilities = await import(pathToFileURL(path.join(options.pack, 'capabilities/src/v1/index.mjs')).href);
const packManifest = JSON.parse(await readFile(path.join(options.pack, 'manifest.json'), 'utf8'));

const compileMilliseconds = options.worldRepo === null
  ? null
  : await measureWorldBuild(options.worldRepo);
const applications = [];
for (const application of packManifest.applications) {
  applications.push(await measureApplication(application));
}

process.stdout.write(`${JSON.stringify({
  measurementVersion: 'agent-runtime-v1-performance/v1',
  releaseStatus: packManifest.releaseStatus,
  environment: {
    bunVersion: Bun.version,
    platform: process.platform,
    architecture: process.arch,
    cpu: os.cpus()[0]?.model ?? 'unknown',
  },
  samples: {
    cold: options.coldSamples,
    warm: options.warmSamples,
  },
  compileMilliseconds,
  applications,
  acceptanceThresholds: null,
}, null, 2)}\n`);

async function measureApplication(application) {
  const wasmBytes = await readFile(path.join(options.pack, application.wasmPath));
  const coldInstantiate = [];
  const manifestRead = [];
  const firstStep = [];
  let frameBytes = 0;
  let stateBytes = 0;
  let initialMemoryBytes = 0;
  let maximumMemoryBytes = 0;

  for (let sample = 0; sample < options.coldSamples; sample += 1) {
    const worker = new host.ApplicationWorker();
    const instantiateStart = performance.now();
    const runtime = await worker.instantiate(wasmBytes);
    coldInstantiate.push(performance.now() - instantiateStart);

    const manifestStart = performance.now();
    const manifest = worker.readManifest();
    manifestRead.push(performance.now() - manifestStart);
    const input = host.encodeStepInput({
      applicationId: manifest.applicationId,
      initialArgsBytes: initialArgs(application.name),
      fuel: 100n,
    }, manifest.limits);

    const stepStart = performance.now();
    const output = worker.step(input);
    firstStep.push(performance.now() - stepStart);
    assert.equal(output.frame.status, host.FrameStatus.needsEffect);
    frameBytes = output.frameBytes.length;
    stateBytes = output.frame.stateBytes.length;
    initialMemoryBytes = runtime.initialMemoryBytes;
    maximumMemoryBytes = runtime.maximumMemoryBytes;
    worker.dispose();
  }

  const warmWorker = new host.ApplicationWorker();
  await warmWorker.instantiate(wasmBytes);
  const manifest = warmWorker.readManifest();
  const warmInput = host.encodeStepInput({
    applicationId: manifest.applicationId,
    initialArgsBytes: initialArgs(application.name),
    fuel: 100n,
  }, manifest.limits);
  const warmStep = [];
  for (let sample = 0; sample < options.warmSamples; sample += 1) {
    const stepStart = performance.now();
    const output = warmWorker.step(warmInput);
    warmStep.push(performance.now() - stepStart);
    assert.equal(output.frame.status, host.FrameStatus.needsEffect);
  }
  warmWorker.dispose();

  return {
    name: application.name,
    wasmBytes: wasmBytes.length,
    initialMemoryBytes,
    maximumMemoryBytes,
    firstFrameBytes: frameBytes,
    firstStateBytes: stateBytes,
    coldInstantiateMedianMilliseconds: median(coldInstantiate),
    manifestReadMedianMilliseconds: median(manifestRead),
    firstStepMedianMilliseconds: median(firstStep),
    warmStepMedianMilliseconds: median(warmStep),
  };
}

function initialArgs(applicationName) {
  if (applicationName === 'one-effect') return Buffer.alloc(0);
  if (applicationName === 'skeleton-agent') return capabilities.encodeStringValue('goal=invoke');
  if (applicationName === 'fixture-agent') return capabilities.encodeStringValue('goal=fixture');
  if (applicationName === 'research-digest-agent') {
    return encodeResearchRequest({
      query: 'portable algebraic effects',
      maximumItems: 2n,
    });
  }
  assert.fail(`unknown application: ${applicationName}`);
}

function encodeResearchRequest(value) {
  const query = Buffer.from(value.query, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(query.length);
  const maximumItems = Buffer.alloc(8);
  maximumItems.writeBigUInt64LE(value.maximumItems);
  return Buffer.concat([length, query, maximumItems]);
}

async function measureWorldBuild(worldRepo) {
  const started = performance.now();
  const process = Bun.spawn([
    'zig',
    'build',
    'world-one-effect-application-wasm',
    'world-skeleton-agent-wasm',
    'world-fixture-agent-wasm',
  ], {
    cwd: worldRepo,
    stdout: 'ignore',
    stderr: 'inherit',
  });
  assert.equal(await process.exited, 0, 'World application build failed');
  return performance.now() - started;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return Number(value.toFixed(3));
}

function parseArgs(args) {
  const result = {
    pack: path.resolve('agent-runtime-v1'),
    worldRepo: null,
    coldSamples: 10,
    warmSamples: 25,
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--pack') result.pack = path.resolve(requireValue(args, ++index, '--pack'));
    else if (args[index] === '--world-repo') result.worldRepo = path.resolve(requireValue(args, ++index, '--world-repo'));
    else if (args[index] === '--cold-samples') result.coldSamples = positiveInteger(requireValue(args, ++index, '--cold-samples'));
    else if (args[index] === '--warm-samples') result.warmSamples = positiveInteger(requireValue(args, ++index, '--warm-samples'));
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  return result;
}

function positiveInteger(value) {
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed) && parsed > 0, `invalid positive integer: ${value}`);
  return parsed;
}

function requireValue(args, index, flag) {
  if (index >= args.length) throw new Error(`${flag} requires a value`);
  return args[index];
}
