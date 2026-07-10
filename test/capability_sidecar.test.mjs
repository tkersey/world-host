import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { CapabilitySidecar, CapabilitySidecarCommand, CapabilitySidecarConformance, decodeSidecarFrame, encodeSidecarFrame } from '../src/sidecars/capability_sidecar.mjs';
import { defineCapabilityDriver } from '../src/core/capability_driver.mjs';
import { markDefaultEffectContext } from '../src/core/effect_context.mjs';
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
    const policyFrame = encodeSidecarFrame({
      command: CapabilitySidecarCommand.preflight,
      payload: { context: { policy: { allowedOrigins: new Set(['https://api.example']) } } },
    });
    const policyDecoded = decodeSidecarFrame(policyFrame);
    assert.deepEqual(policyDecoded.payload.context.policy.allowedOrigins, ['https://api.example']);
    const sentinelMapFrame = encodeSidecarFrame({
      command: CapabilitySidecarCommand.preflight,
      payload: {
        value: new Map([
          ['__world_host_sidecar_type', 'bytes'],
          ['base64', 'not-really-bytes'],
        ]),
      },
    });
    assert.deepEqual(decodeSidecarFrame(sentinelMapFrame).payload.value, {
      __world_host_sidecar_type: 'bytes',
      base64: 'not-really-bytes',
    });
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

  it('validates frame and timeout limits at public boundaries', () => {
    const frame = encodeSidecarFrame({
      command: CapabilitySidecarCommand.resolve,
      payload: { ok: true },
    });
    const frameLimitError = {
      code: 'ERR_CAPABILITY_SIDECAR_FRAME_LIMIT_INVALID',
      message: 'maximumFrameBytes must be a positive safe integer',
    };
    const timeoutError = {
      code: 'ERR_CAPABILITY_SIDECAR_TIMEOUT_INVALID',
      message: 'timeoutMs must be an integer in 1..2147483647',
    };
    const assertValidationError = (operation, expected, label) => {
      assert.throws(operation, (error) => {
        assert.equal(error.code, expected.code, `${label}: code`);
        assert.equal(error.message, expected.message, `${label}: message`);
        return true;
      });
    };

    for (const { label, value } of [
      { label: 'zero', value: 0 },
      { label: 'negative', value: -1 },
      { label: 'fractional', value: 1.5 },
      { label: 'NaN', value: Number.NaN },
      { label: 'infinite', value: Number.POSITIVE_INFINITY },
      { label: 'unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
      { label: 'string', value: '1024' },
      { label: 'null', value: null },
    ]) {
      assertValidationError(
        () => new CapabilitySidecar({ command: ['true'], maximumFrameBytes: value }),
        frameLimitError,
        `constructor maximumFrameBytes ${label}`,
      );
      assertValidationError(
        () => decodeSidecarFrame(frame, value),
        frameLimitError,
        `decode maximumFrameBytes ${label}`,
      );
    }

    for (const { label, value } of [
      { label: 'zero', value: 0 },
      { label: 'negative', value: -1 },
      { label: 'fractional', value: 1.5 },
      { label: 'NaN', value: Number.NaN },
      { label: 'infinite', value: Number.POSITIVE_INFINITY },
      { label: 'above timer maximum', value: 2_147_483_648 },
      { label: 'string', value: '1000' },
      { label: 'null', value: null },
    ]) {
      assertValidationError(
        () => new CapabilitySidecar({ command: ['true'], timeoutMs: value }),
        timeoutError,
        `constructor timeoutMs ${label}`,
      );
    }

    const defaults = new CapabilitySidecar({ command: ['true'] });
    assert.equal(defaults.maximumFrameBytes, 1024 * 1024);
    assert.equal(defaults.timeoutMs, 5000);
    for (const maximumFrameBytes of [1, Number.MAX_SAFE_INTEGER]) {
      assert.equal(
        new CapabilitySidecar({ command: ['true'], maximumFrameBytes }).maximumFrameBytes,
        maximumFrameBytes,
      );
    }
    for (const timeoutMs of [1, 2_147_483_647]) {
      assert.equal(new CapabilitySidecar({ command: ['true'], timeoutMs }).timeoutMs, timeoutMs);
    }
    assert.throws(
      () => decodeSidecarFrame(frame, 1),
      { code: 'ERR_CAPABILITY_SIDECAR_FRAME_TOO_LARGE' },
    );
    assert.deepEqual(decodeSidecarFrame(frame, Number.MAX_SAFE_INTEGER), {
      command: CapabilitySidecarCommand.resolve,
      payload: { ok: true },
    });
  });

  it('keeps marked default contexts receiver-local in sidecar frames', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-sidecar-context-'));
    try {
      const sidecarPath = path.join(root, 'sidecar.mjs');
      await writeFile(sidecarPath, `
        const input = await new Response(Bun.stdin.stream()).text();
        const frame = JSON.parse(input);
        const context = frame.payload.context ?? frame.payload;
        process.stdout.write(JSON.stringify({
          command: frame.command,
          payload: {
            context,
            contextKeys: Object.keys(context).sort(),
            hasHostRequest: frame.payload.hostRequest != null
          }
        }) + '\\n');
      `);

      const sidecar = new CapabilitySidecar({ command: [process.execPath, sidecarPath], timeoutMs: 1000 });
      const defaultContext = markDefaultEffectContext({
        policy: { allowedOrigins: ['https://api.example'] },
        action: { approved: true },
        run: { id: 'receiver-run' },
        parentClosureBytes: { redacted: false },
        hostRequest: { hostRequestFingerprint: 'world:host-request:0000000000000a01' },
        worldHostRequest: { requestFingerprint: '0xa01' },
      });

      const resolved = await sidecar.resolve(defaultContext, { actuatorRef: 'http:json' });
      assert.deepEqual(resolved.contextKeys, ['action', 'policy']);
      assert.deepEqual(resolved.context.action, { approved: true });
      assert.deepEqual(resolved.context.policy, { allowedOrigins: ['https://api.example'] });
      assert.equal(resolved.hasHostRequest, true);

      const custom = await sidecar.resolve({
        policy: { allowedOrigins: ['https://custom.example'] },
        trace: true,
        parentClosureBytes: { redacted: false },
        worldHostRequest: { requestFingerprint: '0xc01' },
      }, { actuatorRef: 'http:json' });
      assert.deepEqual(custom.contextKeys, ['policy', 'trace']);
      assert.deepEqual(custom.context.policy, { allowedOrigins: ['https://custom.example'] });
      assert.equal(custom.context.trace, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('pins bare Bun commands to the current runtime instead of ambient PATH', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-sidecar-bun-runtime-'));
    const originalPath = process.env.PATH;
    try {
      const fakeBin = path.join(root, 'bin');
      const fakeBunPath = path.join(fakeBin, 'bun');
      const fakeMarkerPath = path.join(root, 'fake-bun-invoked');
      const sidecarPath = path.join(root, 'sidecar.mjs');
      await mkdir(fakeBin);
      await writeFile(fakeBunPath, `#!/bin/sh
printf '%s\\n' invoked > ${JSON.stringify(fakeMarkerPath)}
cat >/dev/null
printf '%s\\n' '{"command":"manifest","payload":{"driverId":"fake-bun"}}'
`);
      await chmod(fakeBunPath, 0o755);
      await writeFile(sidecarPath, `
        await new Response(Bun.stdin.stream()).text();
        process.stdout.write(JSON.stringify({
          command: 'manifest',
          payload: { driverId: 'pinned-bun-runtime' }
        }) + '\\n');
      `);
      process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`;

      const manifest = await new CapabilitySidecar({
        command: ['bun', sidecarPath],
        timeoutMs: 1000,
      }).manifest();

      assert.equal(manifest.driverId, 'pinned-bun-runtime');
      await assert.rejects(readFile(fakeMarkerPath), { code: 'ENOENT' });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the captured Bun runtime after process.execPath mutation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-sidecar-bun-identity-'));
    try {
      const fakeBunPath = path.join(root, 'fake-bun');
      const fakeMarkerPath = path.join(root, 'fake-bun-invoked');
      const directSidecarPath = path.join(root, 'direct-sidecar.mjs');
      const shebangSidecarPath = path.join(root, 'shebang-sidecar');
      const probePath = path.join(root, 'probe.mjs');
      const sidecarSource = `
        const input = await new Response(Bun.stdin.stream()).text();
        const frame = JSON.parse(input);
        process.stdout.write(JSON.stringify({
          command: frame.command,
          payload: {
            driverId: 'captured-bun-runtime',
            runtimeExecutable: process.execPath
          }
        }) + '\\n');
      `;
      await writeFile(fakeBunPath, `#!/bin/sh
printf '%s\\n' invoked > ${JSON.stringify(fakeMarkerPath)}
exit 97
`);
      await chmod(fakeBunPath, 0o755);
      await writeFile(directSidecarPath, sidecarSource);
      await writeFile(shebangSidecarPath, `#!/usr/bin/env bun\n${sidecarSource}`);
      await chmod(shebangSidecarPath, 0o755);
      await writeFile(probePath, `
        import assert from 'node:assert/strict';
        import { CapabilitySidecar } from ${JSON.stringify(new URL('../src/sidecars/capability_sidecar.mjs', import.meta.url).href)};

        const originalExecutable = process.execPath;
        const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
        const directSidecar = new CapabilitySidecar({
          command: ['bun', ${JSON.stringify(directSidecarPath)}],
          timeoutMs: 1000
        });
        const shebangSidecar = new CapabilitySidecar({
          command: [${JSON.stringify(shebangSidecarPath)}],
          timeoutMs: 1000
        });
        Object.defineProperty(process, 'execPath', {
          ...originalDescriptor,
          value: ${JSON.stringify(fakeBunPath)}
        });
        try {
          const syncManifest = directSidecar.manifest();
          const directFrame = await directSidecar.request('manifest');
          const shebangFrame = await shebangSidecar.request('manifest');
          assert.equal(syncManifest.runtimeExecutable, originalExecutable);
          assert.equal(directFrame.payload.runtimeExecutable, originalExecutable);
          assert.equal(shebangFrame.payload.runtimeExecutable, originalExecutable);
        } finally {
          Object.defineProperty(process, 'execPath', originalDescriptor);
        }
      `);

      const result = spawnSync(process.execPath, [probePath], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });

      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      await assert.rejects(readFile(fakeMarkerPath), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
              legacyRequest: frame.payload.request ?? null,
              contextRequestFingerprint: frame.payload.context?.requestFingerprint ?? null
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
      for (const command of [
        ['php', '-a', './adapter.php'],
        ['php', '-d', 'memory_limit=128M', './adapter.php'],
        ['php', '-i', './adapter.php'],
        ['php', '-m', './adapter.php'],
        ['php', '-s', './adapter.php'],
        ['php', '-w', './adapter.php'],
        ['php', '--ini', './adapter.php'],
      ]) {
        assert.throws(
          () => new CapabilitySidecar({ command }),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
      }
      const sidecar = new CapabilitySidecar({ command: [process.execPath, sidecarPath], timeoutMs: 1000 });
      assert.equal((await sidecar.request(CapabilitySidecarCommand.manifest)).payload.driverId, 'fixture-sidecar');
      assert.equal((await sidecar.manifest()).driverId, 'fixture-sidecar');
      assert.equal(defineCapabilityDriver(sidecar).manifest().driverId, 'fixture-sidecar');
      const cappedSidecar = new CapabilitySidecar({ command: [process.execPath, sidecarPath], timeoutMs: 1000, maximumFrameBytes: 8192 });
      assert.equal((await cappedSidecar.manifest()).maximumRequestBytes, Math.floor((8192 - 4096) / 6));
      assert.equal((await cappedSidecar.manifest()).maximumResponseBytes, Math.floor((8192 - 4096) / 6));
      const mutableCommand = [process.execPath, sidecarPath];
      const copiedCommandSidecar = new CapabilitySidecar({ command: mutableCommand, timeoutMs: 1000 });
      mutableCommand[0] = '/tmp/world-host-untrusted-runtime';
      mutableCommand[1] = '/tmp/world-host-untrusted-sidecar.mjs';
      assert.equal((await copiedCommandSidecar.manifest()).driverId, 'fixture-sidecar');
      const resolved = await sidecar.resolve({ trace: true }, { actuatorRef: 'http:json' });
      assert.equal(resolved.ok, true);
      assert.equal(resolved.actuatorRef, 'http:json');
      const conformance = await new CapabilitySidecarConformance({
        command: [process.execPath, sidecarPath],
        vectors: [
          {
            command: CapabilitySidecarCommand.resolve,
            payload: { hostRequest: { actuatorRef: 'http:json' } },
            expectedPayload: {
              ok: true,
              actuatorRef: 'http:json',
              legacyRequest: null,
              contextRequestFingerprint: null,
            },
          },
        ],
      }).run();
      assert.equal(conformance.vectorCount, 1);
      assert.deepEqual(conformance.vectors, [{ command: CapabilitySidecarCommand.resolve, accepted: true }]);
      await assert.rejects(
        () => new CapabilitySidecarConformance({
          command: [process.execPath, sidecarPath],
          vectors: [
            {
              command: CapabilitySidecarCommand.resolve,
              payload: { hostRequest: { actuatorRef: 'http:json' } },
              expectedPayload: { ok: false },
            },
          ],
        }).run(),
        { code: 'ERR_CAPABILITY_SIDECAR_CONFORMANCE_VECTOR_FAILED' },
      );
      const resolvedWithBigIntContext = await sidecar.resolve(
        { requestFingerprint: 0x12n },
        { actuatorRef: 'http:json' },
      );
      assert.equal(resolvedWithBigIntContext.contextRequestFingerprint, '0x12');
      assert.equal((await sidecar.resolve({ request: 'ok' })).legacyRequest, 'ok');
      assert.equal((await new CapabilitySidecar({ command: ['bun', sidecarPath], timeoutMs: 1000 }).manifest()).driverId, 'fixture-sidecar');
      assert.equal((await new CapabilitySidecar({ command: ['bun', 'sidecar.mjs'], cwd: root, timeoutMs: 1000 }).manifest()).driverId, 'fixture-sidecar');
      await assert.rejects(() => sidecar.dryRun({}), { code: 'ERR_CAPABILITY_SIDECAR_EXIT' });

      const largeManifestPath = path.join(root, 'large-manifest.mjs');
      await writeFile(largeManifestPath, `
        await new Response(Bun.stdin.stream()).text();
        process.stdout.write(JSON.stringify({
          command: 'manifest',
          payload: {
            driverId: 'large-sidecar',
            supportedActuatorRefs: ['http:json'],
            supportedDescriptorFingerprints: ['descriptor:http-json'],
            supportedActuationClasses: ['http'],
            supportedResponseStatuses: ['ok'],
            maximumRequestBytes: 1048576,
            maximumResponseBytes: 1048576,
            recoveryClass: 'idempotent',
            concurrencyLimit: 1,
            authorityLabels: ['network:http']
          }
        }) + '\\n');
      `);
      const largeSidecar = new CapabilitySidecar({ command: [process.execPath, largeManifestPath], timeoutMs: 1000, maximumFrameBytes: 8192 });
      const rawLargeManifest = await largeSidecar.requestPayload(CapabilitySidecarCommand.manifest);
      const cappedLargeManifest = await largeSidecar.manifest();
      assert.equal(rawLargeManifest.maximumRequestBytes, 1048576);
      assert.equal(cappedLargeManifest.maximumRequestBytes, Math.floor((8192 - 4096) / 6));
      assert.equal(cappedLargeManifest.maximumResponseBytes, Math.floor((8192 - 4096) / 6));

      const packFingerprintPath = path.join(root, 'pack-fingerprint.mjs');
      await writeFile(packFingerprintPath, `
        const input = await new Response(Bun.stdin.stream()).text();
        const frame = JSON.parse(input);
        if (frame.command === 'manifest') {
          process.stdout.write(JSON.stringify({
            command: 'manifest',
            payload: {
              driverId: 'pack-fingerprint-sidecar',
              supportedActuatorRefs: ['http:json'],
              supportedDescriptorFingerprints: ['descriptor:http-json'],
              supportedActuationClasses: ['http'],
              supportedResponseStatuses: ['ok'],
              maximumRequestBytes: 1024,
              maximumResponseBytes: 1024,
              recoveryClass: 'idempotent',
              concurrencyLimit: 1,
              authorityLabels: ['network:http'],
              packFingerprint: frame.payload?.packFingerprint
            }
          }) + '\\n');
        } else {
          process.stdout.write(JSON.stringify({ command: frame.command, payload: { packFingerprint: frame.payload?.packFingerprint } }) + '\\n');
        }
      `);
      const packSidecar = new CapabilitySidecar({
        command: [process.execPath, packFingerprintPath],
        timeoutMs: 1000,
        packFingerprint: 'sha256:'.concat('7'.repeat(64)),
      });
      assert.equal((await packSidecar.manifest()).packFingerprint, 'sha256:'.concat('7'.repeat(64)));
      assert.equal((await packSidecar.resolve({}, { actuatorRef: 'http:json' })).packFingerprint, 'sha256:'.concat('7'.repeat(64)));

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
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, envPath],
            timeoutMs: 1000,
            env: { NODE_OPTIONS: '--require=./preload.cjs' },
          }),
          { code: 'ERR_CAPABILITY_SIDECAR_ENV_INVALID' },
        );
        for (const env of [
          { PATH: root },
          { RUBYOPT: '-r./preload.rb' },
          { PERL5OPT: '-MPreload' },
          { PYTHONPATH: './preload-dir' },
          { PYTHONHOME: './python-home' },
          { PYTHONUSERBASE: './python-user-base' },
          { LUA_INIT: '@./preload.lua' },
          { LUA_INIT_5_4: '@./preload.lua' },
          { PHPRC: './php-ini-dir' },
          { PHP_INI_SCAN_DIR: './php-ini-scan-dir' },
          { R_PROFILE: './preload.R' },
          { R_PROFILE_USER: './preload.R' },
          { R_ENVIRON: './Renviron' },
          { R_ENVIRON_USER: './Renviron' },
        ]) {
          assert.throws(
            () => new CapabilitySidecar({
              command: [process.execPath, envPath],
              timeoutMs: 1000,
              env,
            }),
            { code: 'ERR_CAPABILITY_SIDECAR_ENV_INVALID' },
          );
        }
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
            bunfigPreload: globalThis.__worldHostAmbientBunfigPreload === true,
            execArgv: process.execArgv
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
        assert.ok(dotenvIsolated.execArgv.includes('--no-install'));
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
        for (const command of [
          ['gtimeout', '1', 'bun', dotenvPath],
          ['gtimeout', '--', '1', 'bun', dotenvPath],
          ['ionice', 'bun', dotenvPath],
          ['nice', 'bun', dotenvPath],
          ['nohup', 'bun', dotenvPath],
          ['setsid', 'bun', dotenvPath],
          ['stdbuf', '-oL', 'bun', dotenvPath],
          ['time', 'bun', dotenvPath],
          ['command', 'bun', dotenvPath],
          ['timeout', '1', 'bun', dotenvPath],
          ['timeout', '--', '1', 'bun', dotenvPath],
          ['ksh', '-c', `bun ${dotenvPath}`],
          ['pwsh', '-Command', `bun ${dotenvPath}`],
          ['sh', '-c', `bun ${dotenvPath}`],
          ['env', 'sh', '-c', `bun ${dotenvPath}`],
        ]) {
          assert.throws(
            () => new CapabilitySidecar({ command, timeoutMs: 1000 }).manifest(),
            { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
          );
        }
        const nodeShebangPath = path.join(root, 'node-sidecar');
        await writeFile(nodeShebangPath, '#!/usr/bin/env -S node --env-file=.env\nprocess.exit(0);\n');
        await chmod(nodeShebangPath, 0o755);
        const nodeConcatSplitShebangPath = path.join(root, 'node-concat-split-sidecar');
        await writeFile(nodeConcatSplitShebangPath, '#!/usr/bin/env -Snode --env-file=.env\nprocess.exit(0);\n');
        await chmod(nodeConcatSplitShebangPath, 0o755);
        const denoShebangPath = path.join(root, 'deno-sidecar');
        await writeFile(denoShebangPath, '#!/usr/bin/env -S deno run --allow-read=.\nDeno.exit(0);\n');
        await chmod(denoShebangPath, 0o755);
        const bunShebangPath = path.join(root, 'bun-sidecar');
        await writeFile(bunShebangPath, '#!/usr/bin/env bun\nprocess.exit(0);\n');
        await chmod(bunShebangPath, 0o755);
        const chdirRoot = path.join(root, 'evil');
        await mkdir(chdirRoot);
        await writeFile(path.join(chdirRoot, 'node-sidecar'), '#!/usr/bin/env node\nprocess.exit(0);\n');
        await chmod(path.join(chdirRoot, 'node-sidecar'), 0o755);
        for (const command of [
          [nodeShebangPath],
          [nodeConcatSplitShebangPath],
          [denoShebangPath],
        ]) {
          assert.throws(
            () => new CapabilitySidecar({ command, timeoutMs: 1000 }),
            { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
          );
        }
        for (const command of [
          ['env', nodeShebangPath],
          ['nice', denoShebangPath],
          ['env', '-Snode --env-file=.env', dotenvPath],
        ]) {
          assert.throws(
            () => new CapabilitySidecar({ command, timeoutMs: 1000 }).manifest(),
            { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
          );
        }
        for (const command of [
          ['env', 'node-sidecar'],
          ['nice', 'deno-sidecar'],
          ['env', 'bun-sidecar'],
        ]) {
          assert.throws(
            () => new CapabilitySidecar({
              command,
              env: { PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}` },
              timeoutMs: 1000,
            }).manifest(),
            { code: 'ERR_CAPABILITY_SIDECAR_ENV_INVALID' },
          );
        }
        for (const command of [
          ['env', `PATH=${root}${path.delimiter}${process.env.PATH ?? ''}`, 'node-sidecar'],
          ['env', '-S', `PATH=${root}${path.delimiter}${process.env.PATH ?? ''}`, 'node-sidecar'],
          ['env', '-P', root, 'bun-sidecar'],
        ]) {
          assert.throws(
            () => new CapabilitySidecar({
              command,
              timeoutMs: 1000,
            }).manifest(),
            { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
          );
        }
        assert.throws(
          () => new CapabilitySidecar({
            command: ['env', 'node-sidecar'],
            cwd: root,
            env: { PATH: `.${path.delimiter}${process.env.PATH ?? ''}` },
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_ENV_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: ['env', 'PATH=.', 'node-sidecar'],
            cwd: root,
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: ['env', '-C', 'evil', './node-sidecar'],
            cwd: root,
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        const shellSidecarPath = path.join(root, 'shell-sidecar.sh');
        await writeFile(shellSidecarPath, `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"command":"manifest","payload":{"driverId":"shell-sidecar"}}'
`);
        await chmod(shellSidecarPath, 0o755);
        assert.equal(new CapabilitySidecar({
          command: ['env', './shell-sidecar.sh'],
          cwd: root,
          timeoutMs: 1000,
        }).manifest().driverId, 'shell-sidecar');
        assert.equal(new CapabilitySidecar({
          command: ['env', './shell-sidecar.sh', '--mode=node'],
          cwd: root,
          timeoutMs: 1000,
        }).manifest().driverId, 'shell-sidecar');
        assert.equal(new CapabilitySidecar({
          command: ['env', '-S', './shell-sidecar.sh --mode=node'],
          cwd: root,
          timeoutMs: 1000,
        }).manifest().driverId, 'shell-sidecar');
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '--env-file', path.join(root, '.env'), dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '--env-file=.env', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        const runtimeOptionDotenv = await new CapabilitySidecar({
          command: [process.execPath, '--smol', dotenvPath, '--env-file', path.join(root, '.env')],
          timeoutMs: 1000,
        }).manifest();
        assert.equal(runtimeOptionDotenv.dotenvSecret, null);
        assert.equal(runtimeOptionDotenv.bunfigPreload, false);
        const runtimeOptionValueHelp = await new CapabilitySidecar({
          command: [process.execPath, '--title', '--help', dotenvPath],
          timeoutMs: 1000,
        }).manifest();
        assert.equal(runtimeOptionValueHelp.dotenvSecret, null);
        assert.equal(runtimeOptionValueHelp.bunfigPreload, false);
        assert.throws(
          () => new CapabilitySidecar({
            command: ['deno', 'run', '--no-config', dotenvPath],
            env: { PATH: root },
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_ENV_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: ['deno', 'run', '--no-config', '--unsafely-ignore-certificate-errors', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: ['deno', 'run', '--config=deno.json', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
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
            command: [process.execPath, '--config=./bunfig.toml', dotenvPath],
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
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '--preload=./preload.mjs', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '--import', './preload.mjs', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '-r', './preload.mjs', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '--require=./preload.mjs', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        assert.throws(
          () => new CapabilitySidecar({
            command: [process.execPath, '-e', 'console.log(1)', dotenvPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        for (const command of [
          ['node'],
          ['node', '--conditions', 'dev'],
          ['node', '--env-file=.env', dotenvPath],
          ['node', '--env-file', '.env', dotenvPath],
          ['node', '--env-file-if-exists=.env', dotenvPath],
          ['node', '--enable-source-maps', '--env-file=.env', dotenvPath],
          ['node', '--conditions', 'dev', '--require=./preload.mjs', dotenvPath],
          ['node', '--foo=bar', dotenvPath],
          ['node', '--foo', 'bar', dotenvPath],
          ['node', '-e', 'console.log(1)'],
          ['node', '--eval=console.log(1)'],
          ['node', '--inspect=0', dotenvPath],
          ['node', '--inspect-brk=0', dotenvPath],
          ['node', '--import', './preload.mjs', dotenvPath],
          ['node', '--loader=./loader.mjs', dotenvPath],
          ['node', '--require=./preload.mjs', dotenvPath],
          ['node', '--run', 'start'],
          ['node', '--run=start'],
          ['time', 'node', '--env-file=.env', dotenvPath],
          ['command', 'node', '--env-file=.env', dotenvPath],
          ['env', 'node', '--env-file=.env', dotenvPath],
          ['env', 'NODE_OPTIONS=--require=./preload.cjs', 'node', dotenvPath],
          ['ksh', '-c', `node --env-file=.env ${dotenvPath}`],
          ['pwsh', '-Command', `node --env-file=.env ${dotenvPath}`],
          ['nice', 'deno', 'eval', 'console.log(1)'],
          ['time', 'deno', 'eval', 'console.log(1)'],
          ['deno', 'eval', 'console.log(1)'],
          ['deno', 'run', dotenvPath],
          ['deno', 'run', '--inspect=0', dotenvPath],
          ['deno', 'run', '--import', './preload.mjs', dotenvPath],
          ['deno', 'run', '--import-map', 'import_map.json', dotenvPath],
          ['deno', 'run', '--import-map=import_map.json', dotenvPath],
          ['deno', 'run', '--no-config', '--unsafely-ignore-certificate-errors', dotenvPath],
          ['deno', 'run', '--no-config', '--unsafely-ignore-certificate-errors=example.invalid', dotenvPath],
          ['deno', 'run', '--no-config', '--unsafely-ignore-certificate-errors', 'https://example.invalid/sidecar.ts', dotenvPath],
          ['deno', 'run', 'https://example.invalid/sidecar.ts'],
          ['deno', 'run', 'jsr:@example/sidecar'],
          ['deno', 'run', '--config=deno.json', dotenvPath],
          ['deno', 'run', '-cdeno.json', dotenvPath],
          ['deno', 'task', 'sidecar'],
          ['deno', '--no-config', 'task', 'start', './sidecar.ts'],
          ['deno', 'run', '--allow-read=.', dotenvPath],
          ['deno', 'run', '-A', dotenvPath],
          ['bun'],
          ['bun', '--'],
          ['python3'],
          ['python3', '--'],
          ['python3', '-c', 'print(1)'],
          ['python3', '-m', 'http.server'],
          ['python3', '--version', './adapter.py'],
          ['python3', '--help', './adapter.py'],
          ['python3', '-V', './adapter.py'],
          ['python3', '-h', './adapter.py'],
          ['python3', '-', './adapter.py'],
          ['pypy3', '-', './adapter.py'],
          ['python3', '-W', 'ignore', '-c', 'print(1)'],
          ['env', 'python3', '-c', 'print(1)'],
          ['env', 'python3', '-', './adapter.py'],
          ['env', 'PYTHONPATH=./preload-dir', 'python3', './adapter.py'],
          ['env', 'PYTHONUSERBASE=./python-user-base', 'python3', './adapter.py'],
          ['timeout', '1', 'python3', '-c', 'print(1)'],
          ['timeout', '1', 'python3', '-', './adapter.py'],
          ['perl', '-e', 'print 1'],
          ['perl', '-MPreload', './adapter.pl'],
          ['perl', '-c', './adapter.pl'],
          ['perl', '-d:Some::Mod', './adapter.pl'],
          ['perl', '-v', './adapter.pl'],
          ['perl', '-V', './adapter.pl'],
          ['perl', '-h', './adapter.pl'],
          ['perl', '-', './adapter.pl'],
          ['perl5.36', '-e', 'print 1'],
          ['perl5.36', '-v', './adapter.pl'],
          ['ruby', '-e', 'puts 1'],
          ['ruby', '-r./preload.rb', './adapter.rb'],
          ['ruby', '-c', './adapter.rb'],
          ['ruby', '--version', './adapter.rb'],
          ['ruby', '--help', './adapter.rb'],
          ['ruby', '-', './adapter.rb'],
          ['ruby3.2', '-e', 'puts 1'],
          ['ruby3.2', '-c', './adapter.rb'],
          ['env', 'RUBYOPT=-r./preload.rb', 'ruby', './adapter.rb'],
          ['Rscript', '-e', 'cat("preload")', './adapter.R'],
          ['Rscript', '--version', './adapter.R'],
          ['Rscript', '--help', './adapter.R'],
          ['Rscript', '-', './adapter.R'],
          ['php', '-r', 'echo 1;'],
          ['php', '-B', 'echo 1;', './adapter.php'],
          ['php', '-d', 'auto_prepend_file=./preload.php', './adapter.php'],
          ['php', '-c', './php.ini', './adapter.php'],
          ['php', '-l', './adapter.php'],
          ['php', '-v', './adapter.php'],
          ['php', '-S', '127.0.0.1:0', './adapter.php'],
          ['php8.2', '-r', 'echo 1;'],
          ['php8.2', '-v', './adapter.php'],
          ['env', 'PHPRC=./php-ini-dir', 'php', './adapter.php'],
          ['env', 'PHP_INI_SCAN_DIR=./php-ini-scan-dir', 'php', './adapter.php'],
          ['lua', '-e', 'print(1)'],
          ['lua', '-l', 'preload', './adapter.lua'],
          ['lua', '-v', './adapter.lua'],
          ['lua', '-', './adapter.lua'],
          ['lua5.4', '-e', 'print(1)'],
          ['lua5.4', '-v', './adapter.lua'],
          ['env', 'LUA_INIT=@./preload.lua', 'lua', './adapter.lua'],
          ['npx', 'unchecked-package'],
          ['npm', 'exec', 'unchecked-package'],
          ['corepack', 'pnpm', 'dlx', 'unchecked-package'],
          ['env', 'npx', 'unchecked-package'],
          ['timeout', '1', 'npx', 'unchecked-package'],
        ]) {
          assert.throws(
            () => new CapabilitySidecar({ command, timeoutMs: 1000 }).manifest(),
            { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
          );
        }
        assert.throws(
          () => new CapabilitySidecar({ command: ['/tmp/bun', dotenvPath], timeoutMs: 1000 }),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
        for (const command of [
          [process.execPath, '--install=force', dotenvPath],
          [process.execPath, '--install', 'force', dotenvPath],
          [process.execPath, '-i', dotenvPath],
          [process.execPath, 'i'],
          [process.execPath, 'bun', dotenvPath],
          [process.execPath, 'ci'],
          [process.execPath, 'completions', dotenvPath],
          [process.execPath, 'dev', dotenvPath],
          [process.execPath, 'dlx', 'unchecked-package'],
          [process.execPath, 'discord', dotenvPath],
          [process.execPath, 'getcompletes', dotenvPath],
          [process.execPath, 'remove', 'left-pad', dotenvPath],
          [process.execPath, 'audit', dotenvPath],
          [process.execPath, 'outdated', dotenvPath],
          [process.execPath, 'unlink', dotenvPath],
          [process.execPath, 'publish', dotenvPath],
          [process.execPath, 'patch-commit', dotenvPath],
          [process.execPath, 'why', 'left-pad', dotenvPath],
          [process.execPath, 'build', dotenvPath],
          [process.execPath, 'rm', 'left-pad', dotenvPath],
          [process.execPath, 'a', 'left-pad', dotenvPath],
          [process.execPath, 'c', 'fixture-template', dotenvPath],
          [process.execPath, 'x', 'some-cli'],
          [process.execPath, 'exec', 'some-cli'],
          [process.execPath, 'test', dotenvPath],
          [process.execPath, '--print', 'JSON.stringify({})', dotenvPath],
          [process.execPath, '--print=JSON.stringify({})', dotenvPath],
          [process.execPath, '-p', 'JSON.stringify({})', dotenvPath],
          [process.execPath, '-pJSON.stringify({})', dotenvPath],
          [process.execPath, '--inspect=0', dotenvPath],
          [process.execPath, '--inspect-brk=0', dotenvPath],
          [process.execPath, '--inspect-wait=0', dotenvPath],
          [process.execPath, '--fetch-preconnect=https://denied.example', dotenvPath],
          [process.execPath, '--fetch-preconnect', 'https://denied.example', dotenvPath],
          [process.execPath, '--redis-preconnect', dotenvPath],
          [process.execPath, '--prefer-latest', dotenvPath],
          [process.execPath, '--version', dotenvPath],
          [process.execPath, '-v', dotenvPath],
          [process.execPath, '-vh', dotenvPath],
          [process.execPath, '-hv', dotenvPath],
          [process.execPath, '-vv', dotenvPath],
          [process.execPath, '--help', dotenvPath],
          [process.execPath, '--revision', dotenvPath],
          [process.execPath, '--watch', dotenvPath],
          [process.execPath, '--hot', dotenvPath],
          [process.execPath, '--unsafely-ignore-certificate-errors', dotenvPath],
          [process.execPath, '--unsafely-ignore-certificate-errors=example.invalid', dotenvPath],
        ]) {
          assert.throws(
            () => new CapabilitySidecar({ command, timeoutMs: 1000 }).manifest(),
            { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
          );
        }
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
        assert.throws(
          () => new CapabilitySidecar({
            command: [shebangWithArgsPath],
            timeoutMs: 1000,
          }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
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
        const pythonInlineShebangPath = path.join(root, 'python-inline-sidecar');
        await writeFile(pythonInlineShebangPath, `#!/usr/bin/env -S python3 -c pass
          print("adapter body")
        `);
        await chmod(pythonInlineShebangPath, 0o755);
        assert.throws(
          () => new CapabilitySidecar({
            command: [pythonInlineShebangPath],
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
          { code: 'ERR_CAPABILITY_SIDECAR_ENV_INVALID' },
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
      assert.throws(
        () => new CapabilitySidecar({
          command: ['timeout', '5', './cwd-sidecar'],
          cwd: root,
          timeoutMs: 1000,
        }).manifest(),
        { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
      );

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
        process.on('SIGTERM', () => {});
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
  }, 15000);
});
