import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runApplicationV1Cli } from '../src/bun/application_v1_cli.mjs';
import {
  DirectoryApplicationStoreV1,
  EffectStatus,
  FrameStatus,
  RunControllerV1,
  createEffectResult,
  decodeApplicationManifest,
  decodeFrame,
} from '../src/v1/index.mjs';

describe('World application v1 CLI admission policy', () => {
  it('applies the same configured worker memory limit to inspection and installation', async () => {
    const store = await mkdtemp(path.join(tmpdir(), 'world-host-v1-cli-policy-'));
    const wasm = path.resolve(
      'agent-runtime-v1/applications/research-digest-agent.world.wasm',
    );
    const options = { workerOptions: { maximumMemoryBytes: 16 << 20 } };
    const io = { stdout: { write() {} } };
    try {
      await assert.rejects(
        () => runApplicationV1Cli(['inspect-app', wasm], io, options),
        { code: 'ERR_APPLICATION_V1_HOST_MEMORY_LIMIT' },
      );
      await assert.rejects(
        () => runApplicationV1Cli([
          'install',
          '--store', store,
          '--name', 'research-digest-agent',
          '--wasm', wasm,
        ], io, options),
        { code: 'ERR_APPLICATION_V1_HOST_MEMORY_LIMIT' },
      );
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it('requires a retained effect result before retry or replay', async () => {
    const store = await mkdtemp(path.join(tmpdir(), 'world-host-v1-cli-retained-'));
    const wasm = path.resolve(
      'agent-runtime-v1/applications/one-effect.world.wasm',
    );
    const io = { stdout: { write() {} } };
    try {
      await runApplicationV1Cli([
        'install',
        '--store', store,
        '--name', 'one-effect',
        '--wasm', wasm,
      ], io);
      await runApplicationV1Cli([
        'run',
        '--store', store,
        '--app', 'one-effect',
        '--run', 'fuel-yielded',
        '--fuel', '1',
      ], io);
      for (const command of ['retry', 'replay']) {
        await assert.rejects(
          () => runApplicationV1Cli([
            command,
            '--store', store,
            '--run', 'fuel-yielded',
            '--fuel', '100',
          ], io),
          { code: 'ERR_APPLICATION_V1_EFFECT_RESULT_REQUIRED' },
        );
      }
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it('reuses and validates the fuel retained with a lost result', async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), 'world-host-v1-cli-fuel-'));
    const wasmPath = path.resolve(
      'agent-runtime-v1/applications/one-effect.world.wasm',
    );
    const io = captureIo();
    try {
      await runApplicationV1Cli([
        'install',
        '--store', storeRoot,
        '--name', 'one-effect',
        '--wasm', wasmPath,
      ], io);
      await runApplicationV1Cli([
        'run',
        '--store', storeRoot,
        '--app', 'one-effect',
        '--run', 'lost-low-fuel',
        '--fuel', '100',
      ], io);

      const store = new DirectoryApplicationStoreV1(storeRoot);
      const head = await store.headStore.readHead('lost-low-fuel', 'main');
      const application = await store.applications.get(head.applicationId);
      const manifest = decodeApplicationManifest(
        await store.blockStore.getBlock(application.manifestRef),
      );
      const parent = decodeFrame(
        await store.blockStore.getBlock(head.frameRef),
        manifest.limits,
      );
      const resultBytes = Buffer.alloc(8);
      resultBytes.writeBigInt64LE(41n);
      const effectResult = createEffectResult({
        requestId: parent.pendingEffect.requestId,
        status: EffectStatus.ok,
        resultSchemaId: parent.pendingEffect.resultSchemaId,
        resultBytes,
      }, manifest.limits);
      const controller = await RunControllerV1.create({
        wasmBytes: await readFile(wasmPath),
        blockStore: store.blockStore,
        headStore: store.headStore,
        effectJournal: store.effectJournal,
        faultInjector: async (stage) => {
          if (stage === 'after-result-persistence') throw new Error('lost child');
        },
      });
      await assert.rejects(
        () => controller.advance('lost-low-fuel', 'main', {
          effectResult,
          fuel: 1n,
        }),
        /lost child/,
      );
      await assert.rejects(
        () => runApplicationV1Cli([
          'retry',
          '--store', storeRoot,
          '--run', 'lost-low-fuel',
          '--fuel', '2',
        ], io),
        { code: 'ERR_APPLICATION_V1_RETAINED_FUEL_MISMATCH' },
      );

      io.values.length = 0;
      await runApplicationV1Cli([
        'retry',
        '--store', storeRoot,
        '--run', 'lost-low-fuel',
      ], io);
      const retried = JSON.parse(io.values.join(''));
      assert.equal(retried.frame.status, 'yieldedFuel');
      assert.equal((await store.headStore.readHead('lost-low-fuel', 'main')).status,
        FrameStatus.yieldedFuel);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});

function captureIo() {
  const values = [];
  return {
    values,
    stdout: {
      write(value) {
        values.push(String(value));
      },
    },
  };
}
