import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { CapabilitySidecar, CapabilitySidecarCommand, decodeSidecarFrame, encodeSidecarFrame } from '../src/sidecars/capability_sidecar.mjs';
import { fromUtf8 } from '../src/core/store.mjs';

describe('Capability sidecar transport', () => {
  it('roundtrips bounded deterministic frames', () => {
    const frame = encodeSidecarFrame({
      command: CapabilitySidecarCommand.resolve,
      payload: { bytes: fromUtf8('hello') },
    });
    const decoded = decodeSidecarFrame(frame);
    assert.equal(decoded.command, 'resolve');
    assert.deepEqual([...decoded.payload.bytes], [...fromUtf8('hello')]);
    assert.throws(
      () => decodeSidecarFrame(fromUtf8('x'.repeat(32)), 8),
      { code: 'ERR_CAPABILITY_SIDECAR_FRAME_TOO_LARGE' },
    );
  });

  it('runs sidecars without shell interpolation and rejects bad outcomes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-sidecar-'));
    try {
      const sidecarPath = path.join(root, 'sidecar.mjs');
      await writeFile(sidecarPath, `
        const input = await new Response(Bun.stdin.stream()).text();
        const frame = JSON.parse(input);
        if (frame.command === 'manifest') {
          process.stdout.write(JSON.stringify({ command: 'manifest', payload: { driverId: 'fixture-sidecar' } }) + '\\n');
        } else if (frame.command === 'resolve') {
          process.stdout.write(JSON.stringify({ command: 'resolve', payload: { ok: true } }) + '\\n');
        } else {
          process.exit(2);
        }
      `);
      const sidecar = new CapabilitySidecar({ command: [process.execPath, sidecarPath], timeoutMs: 1000 });
      assert.equal((await sidecar.manifest()).payload.driverId, 'fixture-sidecar');
      assert.equal((await sidecar.resolve({ request: 'ok' })).payload.ok, true);
      await assert.rejects(() => sidecar.dryRun({}), { code: 'ERR_CAPABILITY_SIDECAR_EXIT' });

      const stderrPath = path.join(root, 'stderr.mjs');
      await writeFile(stderrPath, `
        process.stderr.write('x'.repeat(2048));
        await new Promise(() => {});
      `);
      await assert.rejects(
        () => new CapabilitySidecar({ command: [process.execPath, stderrPath], timeoutMs: 1000, maximumFrameBytes: 1024 }).manifest(),
        { code: 'ERR_CAPABILITY_SIDECAR_STDERR_TOO_LARGE' },
      );

      const sleepPath = path.join(root, 'sleep.mjs');
      await writeFile(sleepPath, `
        process.on('SIGTERM', () => {});
        await new Promise(() => {});
      `);
      await assert.rejects(
        () => new CapabilitySidecar({ command: [process.execPath, sleepPath], timeoutMs: 10 }).manifest(),
        { code: 'ERR_CAPABILITY_SIDECAR_TIMEOUT' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
