import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DirectoryApplicationStoreV1,
  EffectStatus,
  FrameStatus,
  RunControllerV1,
  createEffectResult,
  decodeApplicationManifest,
  decodeFrame,
  encodeStepInput,
} from '../src/v1/index.mjs';

const options = parseArgs(process.argv.slice(2));
const wasmPath = path.resolve(options.wasm ?? path.join(options.worldRepo, 'zig-out/bin/one-effect.world.wasm'));
const wasmBytes = await readFile(wasmPath);
const root = await mkdtemp(path.join(tmpdir(), 'world-host-application-cli-v1-'));
const receiverRoot = await mkdtemp(path.join(tmpdir(), 'world-host-application-cli-v1-receiver-'));
const resultPath = path.join(root, 'alternate-result.bin');
const migrationPath = path.join(root, 'migration.json');

try {
  const installed = await cli([
    'app', 'install',
    '--store', root,
    '--name', 'one-effect',
    '--wasm', wasmPath,
  ]);
  assert.equal(installed.command, 'app install');
  assert.equal(installed.application.name, 'one-effect');

  const started = await cli([
    'app', 'run',
    '--store', root,
    '--app', 'one-effect',
    '--run', 'cli-run',
    '--fuel', '100',
  ]);
  assert.equal(started.frame.status, 'needsEffect');
  await cli([
    'app', 'fork',
    '--store', root,
    '--run', 'cli-run',
    '--source-branch', 'main',
    '--branch', 'alternate',
  ]);

  const store = new DirectoryApplicationStoreV1(root);
  const parentHead = await store.headStore.readHead('cli-run', 'main');
  const application = await store.applications.get(parentHead.applicationId);
  const manifest = decodeApplicationManifest(await store.blockStore.getBlock(application.manifestRef));
  const parentBytes = await store.blockStore.getBlock(parentHead.frameRef);
  const parent = decodeFrame(parentBytes, manifest.limits);
  assert.equal(parent.status, FrameStatus.needsEffect);
  const mainResult = integerResult(parent, manifest, 41n);

  let interrupted = true;
  const crashing = await RunControllerV1.create({
    wasmBytes,
    blockStore: store.blockStore,
    headStore: store.headStore,
    effectJournal: store.effectJournal,
    faultInjector: async (stage) => {
      if (stage === 'after-result-persistence' && interrupted) {
        interrupted = false;
        throw new Error('injected process loss after result persistence');
      }
    },
  });
  await assert.rejects(
    () => crashing.advance('cli-run', 'main', { effectResult: mainResult, fuel: 100n }),
    /injected process loss/,
  );
  assert.equal((await store.headStore.readHead('cli-run', 'main')).frameId, parentHead.frameId);

  const resumed = await cli([
    'app', 'resume',
    '--store', root,
    '--run', 'cli-run',
    '--fuel', '100',
  ]);
  assert.equal(resumed.frame.status, 'completed');
  const mainHead = await store.headStore.readHead('cli-run', 'main');
  const mainFrameBytes = await store.blockStore.getBlock(mainHead.frameRef);
  const mainFrame = decodeFrame(mainFrameBytes, manifest.limits);
  assert.equal(mainFrame.finalResultBytes.readBigInt64LE(), 41n);

  const expected = await freshStep(wasmBytes, encodeStepInput({
    applicationId: manifest.applicationId,
    expectedParentFrameId: parent.frameId,
    priorFrameBytes: parentBytes,
    effectResult: mainResult,
    fuel: 100n,
  }, manifest.limits));
  assert.deepEqual(mainFrameBytes, expected.frameBytes);

  const alternateResult = integerResult(parent, manifest, 42n);
  await writeFile(resultPath, alternateResult.encodedBytes);
  const alternate = await cli([
    'app', 'resume',
    '--store', root,
    '--run', 'cli-run',
    '--branch', 'alternate',
    '--effect-result', resultPath,
    '--fuel', '100',
  ]);
  assert.equal(alternate.frame.status, 'completed');
  const alternateHead = await store.headStore.readHead('cli-run', 'alternate');
  const alternateFrame = decodeFrame(await store.blockStore.getBlock(alternateHead.frameRef), manifest.limits);
  assert.equal(alternateFrame.finalResultBytes.readBigInt64LE(), 42n);
  assert.notEqual(mainHead.frameId, alternateHead.frameId);

  await cli([
    'app', 'export',
    '--store', root,
    '--run', 'cli-run',
    '--out', migrationPath,
  ]);
  const imported = await cli([
    'app', 'import',
    '--store', receiverRoot,
    '--in', migrationPath,
    '--run', 'cli-imported',
    '--name', 'one-effect',
  ]);
  assert.equal(imported.receiverPreflightApplied, true);
  const inspected = await cli([
    'app', 'inspect',
    '--store', receiverRoot,
    '--run', 'cli-imported',
  ]);
  assert.equal(inspected.frame.status, 'completed');
  assert.equal(inspected.head.frameId, mainHead.frameId);
  assert.equal(inspected.frame.finalResult.byteLength, 8);
  assert.equal(Object.prototype.hasOwnProperty.call(inspected.frame, 'stateBytes'), false);

  console.log('application_cli_v1=true');
  console.log('separate_process_install_run_resume=true');
  console.log('durable_result_reuse=true');
  console.log('byte_identical_restart=true');
  console.log('conditional_branch_children=2');
  console.log('migration_receiver_preflight=true');
  console.log('cli_exposes_semantic_bytes=false');
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(receiverRoot, { recursive: true, force: true });
}

async function cli(args) {
  const bin = fileURLToPath(new URL('../bin/world-host.mjs', import.meta.url));
  const child = Bun.spawn([process.execPath, bin, ...args], {
    cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, WORLD_HOST_CLI_ERROR_JSON: '1' },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout || `world-host exited ${exitCode}`);
  return JSON.parse(stdout);
}

function integerResult(parent, manifest, value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return createEffectResult({
    requestId: parent.pendingEffect.requestId,
    status: EffectStatus.ok,
    resultSchemaId: parent.pendingEffect.resultSchemaId,
    resultBytes: bytes,
  }, manifest.limits);
}

async function freshStep(bytes, input) {
  const { ApplicationWorker } = await import('../src/v1/index.mjs');
  const worker = new ApplicationWorker();
  try {
    await worker.instantiate(bytes);
    return worker.step(input);
  } finally {
    worker.dispose();
  }
}

function parseArgs(args) {
  const result = { worldRepo: path.resolve('../world'), wasm: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--world-repo') result.worldRepo = path.resolve(requireValue(args, ++index, '--world-repo'));
    else if (args[index] === '--wasm') result.wasm = requireValue(args, ++index, '--wasm');
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  return result;
}

function requireValue(args, index, flag) {
  if (index >= args.length) throw new Error(`${flag} requires a value`);
  return args[index];
}
