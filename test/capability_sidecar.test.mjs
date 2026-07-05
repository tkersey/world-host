import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { CapabilitySidecar, CapabilitySidecarCommand, decodeSidecarFrame, encodeSidecarFrame } from '../src/sidecars/capability_sidecar.mjs';
import { defineCapabilityDriver } from '../src/core/capability_driver.mjs';
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
          process.stdout.write(JSON.stringify({
            command: 'manifest',
            payload: {
              driverId: 'fixture-sidecar',
              supportedActuatorRefs: ['http:json'],
              supportedDescriptorFingerprints: ['descriptor:http-json'],
              supportedActuationClasses: ['http'],
              supportedResponseStatuses: ['ok'],
              maximumRequestBytes: 1024,
              maximumResponseBytes: 1024,
              recoveryClass: 'idempotent',
              concurrencyLimit: 1,
              authorityLabels: ['network:http']
            }
          }) + '\\n');
        } else if (frame.command === 'resolve') {
          process.stdout.write(JSON.stringify({
            command: 'resolve',
            payload: {
              ok: true,
              actuatorRef: frame.payload.hostRequest?.actuatorRef ?? null,
              legacyRequest: frame.payload.request ?? null
            }
          }) + '\\n');
        } else {
          process.exit(2);
        }
      `);
      assert.throws(
        () => new CapabilitySidecar({ command: ['sidecar.mjs'] }),
        { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
      );
      assert.throws(
        () => new CapabilitySidecar({ command: [sidecarPath] }),
        { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
      );
      const sidecar = new CapabilitySidecar({ command: [process.execPath, sidecarPath], timeoutMs: 1000 });
      assert.equal((await sidecar.request(CapabilitySidecarCommand.manifest)).payload.driverId, 'fixture-sidecar');
      assert.equal((await sidecar.manifest()).driverId, 'fixture-sidecar');
      assert.equal(defineCapabilityDriver(sidecar).manifest().driverId, 'fixture-sidecar');
      const resolved = await sidecar.resolve({ trace: true }, { actuatorRef: 'http:json' });
      assert.equal(resolved.ok, true);
      assert.equal(resolved.actuatorRef, 'http:json');
      assert.equal((await sidecar.resolve({ request: 'ok' })).legacyRequest, 'ok');
      assert.equal((await new CapabilitySidecar({ command: ['bun', sidecarPath], timeoutMs: 1000 }).manifest()).driverId, 'fixture-sidecar');
      assert.equal((await new CapabilitySidecar({ command: ['bun', 'sidecar.mjs'], cwd: root, timeoutMs: 1000 }).manifest()).driverId, 'fixture-sidecar');
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
        assert.equal(isolated.ambientSecret, null);
        assert.equal(isolated.declaredSecret, null);
        const declared = await new CapabilitySidecar({
          command: [process.execPath, envPath],
          timeoutMs: 1000,
          env: { DECLARED_SECRET: 'mapped-secret' },
        }).manifest();
        assert.equal(declared.ambientSecret, null);
        assert.equal(declared.declaredSecret, 'mapped-secret');
      } finally {
        if (originalAmbient === undefined) {
          delete process.env.WORLD_HOST_SIDECAR_AMBIENT_SECRET;
        } else {
          process.env.WORLD_HOST_SIDECAR_AMBIENT_SECRET = originalAmbient;
        }
      }

      const dotenvPath = path.join(root, 'dotenv.mjs');
      await writeFile(path.join(root, '.env'), 'WORLD_HOST_SIDECAR_DOTENV_SECRET=dotenv-secret\n');
      await writeFile(dotenvPath, `
        await new Response(Bun.stdin.stream()).text();
        process.stdout.write(JSON.stringify({
          command: 'manifest',
          payload: {
            dotenvSecret: process.env.WORLD_HOST_SIDECAR_DOTENV_SECRET ?? null,
            bunfigPreload: globalThis.__worldHostAmbientBunfigPreload === true
          }
        }) + '\\n');
      `);
      const originalCwd = process.cwd();
      process.chdir(root);
      try {
        await writeFile(path.join(root, 'preload.mjs'), 'globalThis.__worldHostAmbientBunfigPreload = true;\n');
        await writeFile(path.join(root, 'bunfig.toml'), 'preload = ["./preload.mjs"]\n');
        await writeFile(path.join(root, 'run'), '');
        const dotenvIsolated = await new CapabilitySidecar({ command: [process.execPath, dotenvPath], timeoutMs: 1000 }).manifest();
        assert.equal(dotenvIsolated.dotenvSecret, null);
        assert.equal(dotenvIsolated.bunfigPreload, false);
        assert.throws(
          () => new CapabilitySidecar({
            command: ['env', 'bun', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: ['/usr/bin/env', 'bun', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        const explicitDotenv = await new CapabilitySidecar({
          command: [process.execPath, '--env-file', path.join(root, '.env'), dotenvPath],
          timeoutMs: 1000,
        }).manifest();
        assert.equal(explicitDotenv.dotenvSecret, 'dotenv-secret');
        assert.equal(explicitDotenv.bunfigPreload, false);
        const runtimeOptionDotenv = await new CapabilitySidecar({
          command: [process.execPath, '--smol', dotenvPath, '--env-file', path.join(root, '.env')],
          timeoutMs: 1000,
        }).manifest();
        assert.equal(runtimeOptionDotenv.dotenvSecret, null);
        assert.equal(runtimeOptionDotenv.bunfigPreload, false);
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '--env-file-if-exists=missing.env', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '--import', './preload.mjs', '--env-file-if-exists=missing.env', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '-c', './bunfig.toml', '--env-file-if-exists=missing.env', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, 'run', '--env-file-if-exists=missing.env', 'show'],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, 'run', 'show'],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '--config', 'run', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '--config-file=./bunfig.toml', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '-c=./bunfig.toml', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '--cwd', 'run', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '--conditions', 'prod', '--cwd', 'run', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '--no-config', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        const shebangPath = path.join(root, 'dotenv-sidecar');
        await writeFile(shebangPath, `#!/usr/bin/env bun
          await new Response(Bun.stdin.stream()).text();
          process.stdout.write(JSON.stringify({
            command: 'manifest',
            payload: { dotenvSecret: process.env.WORLD_HOST_SIDECAR_DOTENV_SECRET ?? null }
          }) + '\\n');
        `);
        await chmod(shebangPath, 0o755);
        const shebangDotenvIsolated = await new CapabilitySidecar({
          command: [shebangPath],
          timeoutMs: 1000,
        }).manifest();
        assert.equal(shebangDotenvIsolated.dotenvSecret, null);
        await writeFile(path.join(root, 'shebang-preload.mjs'), 'globalThis.__worldHostShebangPreload = true;\n');
        const shebangWithArgsPath = path.join(root, 'preloaded-sidecar');
        await writeFile(shebangWithArgsPath, `#!/usr/bin/env -S bun --preload ./shebang-preload.mjs
          await new Response(Bun.stdin.stream()).text();
          process.stdout.write(JSON.stringify({
            command: 'manifest',
            payload: {
              preloaded: globalThis.__worldHostShebangPreload === true,
              dotenvSecret: process.env.WORLD_HOST_SIDECAR_DOTENV_SECRET ?? null
            }
          }) + '\\n');
        `);
        await chmod(shebangWithArgsPath, 0o755);
        const shebangArgsPreserved = await new CapabilitySidecar({
          command: [shebangWithArgsPath],
          timeoutMs: 1000,
        }).manifest();
        assert.equal(shebangArgsPreserved.preloaded, true);
        assert.equal(shebangArgsPreserved.dotenvSecret, null);
        const quotedShebangWithArgsPath = path.join(root, 'quoted-preloaded-sidecar');
        await writeFile(quotedShebangWithArgsPath, `#!/usr/bin/env -S bun --preload "./shebang-preload.mjs"
          await new Response(Bun.stdin.stream()).text();
          process.stdout.write(JSON.stringify({ command: 'manifest', payload: {} }) + '\\n');
        `);
        await chmod(quotedShebangWithArgsPath, 0o755);
        assert.throws(
          () => new CapabilitySidecar({
            command: [quotedShebangWithArgsPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: ['dotenv-sidecar'],
            env: { PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}` },
            timeoutMs: 1000,
          }),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '-r', './preload.mjs', '--env-file-if-exists=missing.env', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '--require', './preload.mjs', '--env-file-if-exists=missing.env', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        const scriptArgEnvFile = await new CapabilitySidecar({
          command: [process.execPath, dotenvPath, '--env-file', path.join(root, '.env')],
          timeoutMs: 1000,
        }).manifest();
        assert.equal(scriptArgEnvFile.dotenvSecret, null);
        const scriptArgEnvFileIfExists = await new CapabilitySidecar({
          command: [process.execPath, dotenvPath, '--env-file-if-exists=.env'],
          timeoutMs: 1000,
        }).manifest();
        assert.equal(scriptArgEnvFileIfExists.dotenvSecret, null);
      } finally {
        process.chdir(originalCwd);
      }

      const cwdShebangPath = path.join(root, 'cwd-sidecar');
      await writeFile(cwdShebangPath, `#!/usr/bin/env bun
        await new Response(Bun.stdin.stream()).text();
        process.stdout.write(JSON.stringify({
          command: 'manifest',
          payload: {
            dotenvSecret: process.env.WORLD_HOST_SIDECAR_DOTENV_SECRET ?? null,
            bunfigPreload: globalThis.__worldHostAmbientBunfigPreload === true
          }
        }) + '\\n');
      `);
      await chmod(cwdShebangPath, 0o755);
      const cwdShebangIsolated = await new CapabilitySidecar({
        command: ['./cwd-sidecar'],
        cwd: root,
        timeoutMs: 1000,
      }).manifest();
      assert.equal(cwdShebangIsolated.dotenvSecret, null);
      assert.equal(cwdShebangIsolated.bunfigPreload, false);

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
      assert.throws(
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
      assert.throws(
        () => new CapabilitySidecar({ command: [process.execPath, stderrPath], timeoutMs: 1000, maximumFrameBytes: 1024 }).manifest(),
        { code: 'ERR_CAPABILITY_SIDECAR_STDERR_TOO_LARGE' },
      );

      const sleepPath = path.join(root, 'sleep.mjs');
      await writeFile(sleepPath, `
        process.on('SIGTERM', () => {});
        await new Promise(() => {});
      `);
      assert.throws(
        () => new CapabilitySidecar({ command: [process.execPath, sleepPath], timeoutMs: 10 }).manifest(),
        { code: 'ERR_CAPABILITY_SIDECAR_TIMEOUT' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
