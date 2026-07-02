import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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
    const reservedObjectFrame = encodeSidecarFrame({
      command: CapabilitySidecarCommand.resolve,
      payload: {
        tagged: { __bytes: 'abc', other: 1 },
        exactLegacyShape: { __bytes: 'plain-user-object' },
        namespaced: { __world_host_sidecar_type: 'bytes', base64: 'plain-user-object' },
      },
    });
    const reservedObjectDecoded = decodeSidecarFrame(reservedObjectFrame);
    assert.deepEqual(reservedObjectDecoded.payload.tagged, { __bytes: 'abc', other: 1 });
    assert.deepEqual(reservedObjectDecoded.payload.exactLegacyShape, { __bytes: 'plain-user-object' });
    assert.deepEqual(reservedObjectDecoded.payload.namespaced, { __world_host_sidecar_type: 'bytes', base64: 'plain-user-object' });
    const legacyBytes = decodeSidecarFrame(fromUtf8(`${JSON.stringify({
      command: CapabilitySidecarCommand.resolve,
      payload: { bytes: { __bytes: Buffer.from('legacy').toString('base64') } },
    })}\n`));
    assert.deepEqual([...legacyBytes.payload.bytes], [...fromUtf8('legacy')]);
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
      assert.equal((await new CapabilitySidecar({ command: ['bun', sidecarPath], timeoutMs: 1000 }).manifest()).payload.driverId, 'fixture-sidecar');
      await assert.rejects(() => sidecar.dryRun({}), { code: 'ERR_CAPABILITY_SIDECAR_EXIT' });

      const envPath = path.join(root, 'env.mjs');
      await writeFile(envPath, `
        await new Response(Bun.stdin.stream()).text();
        process.stdout.write(JSON.stringify({
          command: 'manifest',
          payload: {
            ambientSecret: process.env.WORLD_HOST_SIDECAR_AMBIENT_SECRET ?? null,
            declaredSecret: process.env.DECLARED_SECRET ?? null
          }
        }) + '\\n');
      `);
      const originalAmbient = process.env.WORLD_HOST_SIDECAR_AMBIENT_SECRET;
      process.env.WORLD_HOST_SIDECAR_AMBIENT_SECRET = 'ambient-secret';
      try {
        const isolated = await new CapabilitySidecar({ command: [process.execPath, envPath], timeoutMs: 1000 }).manifest();
        assert.equal(isolated.payload.ambientSecret, null);
        assert.equal(isolated.payload.declaredSecret, null);
        const declared = await new CapabilitySidecar({
          command: [process.execPath, envPath],
          timeoutMs: 1000,
          env: { DECLARED_SECRET: 'mapped-secret' },
        }).manifest();
        assert.equal(declared.payload.ambientSecret, null);
        assert.equal(declared.payload.declaredSecret, 'mapped-secret');
      } finally {
        if (originalAmbient === undefined) {
          delete process.env.WORLD_HOST_SIDECAR_AMBIENT_SECRET;
        } else {
          process.env.WORLD_HOST_SIDECAR_AMBIENT_SECRET = originalAmbient;
        }
      }

      const mismatchPath = path.join(root, 'mismatch.mjs');
      await writeFile(mismatchPath, `
        await new Response(Bun.stdin.stream()).text();
        process.stdout.write(JSON.stringify({ command: 'manifest', payload: { ok: true } }) + '\\n');
      `);
      await assert.rejects(
        () => new CapabilitySidecar({ command: [process.execPath, mismatchPath], timeoutMs: 1000 }).resolve({}),
        { code: 'ERR_CAPABILITY_SIDECAR_RESPONSE_COMMAND' },
      );

      const exitSecretPath = path.join(root, 'exit-secret.mjs');
      await writeFile(exitSecretPath, `
        process.stderr.write('DECLARED_SECRET=' + process.env.DECLARED_SECRET);
        process.exit(2);
      `);
      await assert.rejects(
        () => new CapabilitySidecar({
          command: [process.execPath, exitSecretPath],
          timeoutMs: 1000,
          env: { DECLARED_SECRET: 'mapped-secret' },
        }).manifest(),
        (error) => {
          assert.equal(error.code, 'ERR_CAPABILITY_SIDECAR_EXIT');
          assert.equal(error.message.includes('mapped-secret'), false);
          assert.equal(error.message.includes('DECLARED_SECRET'), false);
          return true;
        },
      );

      const exitFastPath = path.join(root, 'exit-fast.mjs');
      await writeFile(exitFastPath, `
        process.exit(2);
      `);
      await assert.rejects(
        () => new CapabilitySidecar({
          command: [process.execPath, exitFastPath],
          timeoutMs: 1000,
          maximumFrameBytes: 2 * 1024 * 1024,
        }).resolve({ body: 'x'.repeat(1024 * 1024) }),
        { code: 'ERR_CAPABILITY_SIDECAR_EXIT' },
      );

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
