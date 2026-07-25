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
});
