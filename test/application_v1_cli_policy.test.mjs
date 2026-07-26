import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runApplicationV1Cli } from '../src/bun/application_v1_cli.mjs';

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
});
