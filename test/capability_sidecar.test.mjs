import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { CapabilitySidecar, CapabilitySidecarCommand, CapabilitySidecarConformance, decodeSidecarFrame, encodeSidecarFrame } from '../src/sidecars/capability_sidecar.mjs';
import { MAXIMUM_SIDECAR_SHEBANG_LINE_BYTES } from '../src/core/capability_pack.mjs';
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
          { LD_PRELOAD: './preload.so' },
          { DYLD_INSERT_LIBRARIES: './preload.dylib' },
          { RUBYOPT: '-r./preload.rb' },
          { RUBYLIB: './ruby-lib' },
          { RUBYGEMS_GEMDEPS: './Gemfile' },
          { PERL5OPT: '-MPreload' },
          { PERL5LIB: './perl-lib' },
          { PERLLIB: './legacy-perl-lib' },
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
        for (const command of [
          ['env', `PATH=${root}`, 'python3', './adapter.py'],
          ['env', '-P', root, 'python3', './adapter.py'],
          ['env', `-P${root}`, 'python3', './adapter.py'],
          ['env', '-u', 'PATH', 'python3', './adapter.py'],
          ['env', '-uPATH', 'python3', './adapter.py'],
          ['env', '--unset', 'PATH', 'python3', './adapter.py'],
          ['env', '--unset=PATH', 'python3', './adapter.py'],
          ['env', '-', 'python3', './adapter.py'],
          ['env', '-i', 'python3', './adapter.py'],
          ['env', '--ignore-environment', 'python3', './adapter.py'],
          ['env', 'LD_PRELOAD=./preload.so', 'python3', './adapter.py'],
          ['env', 'DYLD_INSERT_LIBRARIES=./preload.dylib', 'python3', './adapter.py'],
          ['env', 'RUBYLIB=./ruby-lib', 'ruby', './adapter.rb'],
          ['env', '-S', 'RUBYLIB=./ruby-lib ruby ./adapter.rb'],
          ['env', 'RUBYGEMS_GEMDEPS=./Gemfile', 'ruby', './adapter.rb'],
          ['env', 'PERL5LIB=./perl-lib', 'perl', './adapter.pl'],
          ['env', 'PERLLIB=./legacy-perl-lib', 'perl', './adapter.pl'],
        ]) {
          assert.throws(
            () => new CapabilitySidecar({ command, timeoutMs: 1000 }),
            { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
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
          ['python3', '--help-all', './adapter.py'],
          ['python3', '--help-env', './adapter.py'],
          ['python3', '--help-xoptions', './adapter.py'],
          ['python3', '-?', './adapter.py'],
          ['python3', '-hfoo', './adapter.py'],
          ['python3', '-help', './adapter.py'],
          ['python3', '-V', './adapter.py'],
          ['python3', '-VV', './adapter.py'],
          ['python3', '-h', './adapter.py'],
          ['python3', '-', './adapter.py'],
          ['pypy3', '-VV', './adapter.py'],
          ['pypy3', '--help-all', './adapter.py'],
          ['pypy3', '--help-env', './adapter.py'],
          ['pypy3', '--help-xoptions', './adapter.py'],
          ['pypy3', '-?', './adapter.py'],
          ['pypy3', '-hfoo', './adapter.py'],
          ['pypy3', '-help', './adapter.py'],
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
          ['perl', '-Ivendor', './adapter.pl'],
          ['perl', '-c', './adapter.pl'],
          ['perl', '-d:Some::Mod', './adapter.pl'],
          ['perl', '-n', './adapter.pl'],
          ['perl', '-an', './adapter.pl'],
          ['perl', '-ap', './adapter.pl'],
          ['perl', '-lan', './adapter.pl'],
          ['perl', '-lap', './adapter.pl'],
          ['perl', '-np', './adapter.pl'],
          ['perl', '-p', './adapter.pl'],
          ['perl', '-pn', './adapter.pl'],
          ['perl', '-v', './adapter.pl'],
          ['perl', '-V', './adapter.pl'],
          ['perl', '-h', './adapter.pl'],
          ['perl', '-', './adapter.pl'],
          ['perl5.36', '-e', 'print 1'],
          ['perl5.36', '-v', './adapter.pl'],
          ['ruby', '-e', 'puts 1'],
          ['ruby', '-r./preload.rb', './adapter.rb'],
          ['ruby', '-Ivendor', './adapter.rb'],
          ['ruby', '-c', './adapter.rb'],
          ['ruby', '-n', './adapter.rb'],
          ['ruby', '-an', './adapter.rb'],
          ['ruby', '-ap', './adapter.rb'],
          ['ruby', '-ln', './adapter.rb'],
          ['ruby', '-lp', './adapter.rb'],
          ['ruby', '-np', './adapter.rb'],
          ['ruby', '-p', './adapter.rb'],
          ['ruby', '-pn', './adapter.rb'],
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

  it('rejects Ruby and Perl pre-entry execution through direct, wrapped, and shebang argv', async () => {
    const rejected = [
      ['ruby', '-Wn', './adapter.rb'],
      ['ruby', '-0n', './adapter.rb'],
      ['ruby', '-0777p', './adapter.rb'],
      ['ruby', '-W0p', './adapter.rb'],
      ['ruby', '-Knp', './adapter.rb'],
      ['ruby', '-T0p', './adapter.rb'],
      ['ruby', '-weCODE', './adapter.rb'],
      ['ruby', '-wrLIB', './adapter.rb'],
      ['ruby', '-wc', './adapter.rb'],
      ['ruby', '-wS', './adapter.rb'],
      ['ruby', '-y', './adapter.rb'],
      ['ruby', '-S', './adapter.rb'],
      ['ruby', '-Cdir', './adapter.rb'],
      ['ruby', '-I/tmp/hooks', './adapter.rb'],
      ['ruby', '-I', '/tmp/hooks', './adapter.rb'],
      ['ruby', '-I', './lib', '-p', './adapter.rb'],
      ['ruby3.2', '-Wn', './adapter.rb'],
      ['ruby3.2', '-y', './adapter.rb'],
      ['ruby3.2', '-I/tmp/hooks', './adapter.rb'],
      ['perl', '-Un', './adapter.pl'],
      ['perl', '-Fn', './adapter.pl'],
      ['perl', '-0p', './adapter.pl'],
      ['perl', '-0777p', './adapter.pl'],
      ['perl', '-0x41p', './adapter.pl'],
      ['perl', '-l0p', './adapter.pl'],
      ['perl', '-a', './adapter.pl'],
      ['perl', '-Ffields', './adapter.pl'],
      ['perl', '-E', 'say 1'],
      ['perl', '-we', 'print 1'],
      ['perl', '-wMstrict', './adapter.pl'],
      ['perl', '-wc', './adapter.pl'],
      ['perl', '-wS', './adapter.pl'],
      ['perl', '-u', './adapter.pl'],
      ['perl', '-q', './adapter.pl'],
      ['perl', '-I/tmp/hooks', './adapter.pl'],
      ['perl', '-I', '/tmp/hooks', './adapter.pl'],
      ['perl', '-I', './lib', '-p', './adapter.pl'],
      ['perl5.36', '-Un', './adapter.pl'],
      ['perl5.36', '-u', './adapter.pl'],
      ['perl5.36', '-q', './adapter.pl'],
      ['perl5.36', '-0x41p', './adapter.pl'],
      ['perl5.36', '-I', '/tmp/hooks', './adapter.pl'],
      ['env', 'ruby', '-Wn', './adapter.rb'],
      ['env', 'ruby', '-y', './adapter.rb'],
      ['env', 'ruby', '-I/tmp/hooks', './adapter.rb'],
      ['timeout', '1', 'perl', '-Un', './adapter.pl'],
      ['timeout', '1', 'perl', '-u', './adapter.pl'],
      ['timeout', '1', 'perl', '-I', '/tmp/hooks', './adapter.pl'],
      ['env', 'perl', '-q', './adapter.pl'],
      ['env', 'perl', '-0x41p', './adapter.pl'],
      ['env', 'timeout', '1', 'ruby', '-0n', './adapter.rb'],
      ['ruby', '-I'],
      ['perl', '-I'],
      ['ruby', 'adapter.rb'],
      ['perl', '--', 'adapter.pl'],
    ];
    for (const command of rejected) {
      assert.throws(
        () => new CapabilitySidecar({ command, timeoutMs: 1000 }),
        { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        JSON.stringify(command),
      );
    }

    const admitted = [
      ['ruby', '-Fnp', './adapter.rb'],
      ['ruby', '-Kp', './adapter.rb'],
      ['ruby', '-W:performance', './adapter.rb'],
      ['ruby', './adapter.rb', '-p'],
      ['ruby', './adapter.rb', '-I/tmp/hooks'],
      ['ruby', './adapter.rb', '-I', '/tmp/hooks'],
      ['perl', '-ip', './adapter.pl'],
      ['perl', '-0x41', './adapter.pl'],
      ['perl', '-0x41f', './adapter.pl'],
      ['perl', './adapter.pl', '-p'],
      ['perl', './adapter.pl', '-I/tmp/hooks'],
      ['perl', './adapter.pl', '-I', '/tmp/hooks'],
      ['env', 'ruby', './adapter.rb', '-I/tmp/hooks'],
      ['timeout', '1', 'perl', './adapter.pl', '-I/tmp/hooks'],
    ];
    for (const command of admitted) {
      assert.doesNotThrow(
        () => new CapabilitySidecar({ command, timeoutMs: 1000 }),
        JSON.stringify(command),
      );
    }

    const root = await mkdtemp(path.join(tmpdir(), 'world-host-runtime-admission-'));
    try {
      const unsafeRuby = path.join(root, 'unsafe-ruby');
      const unsafePerl = path.join(root, 'unsafe-perl');
      const unsafeRubyEnv = path.join(root, 'unsafe-ruby-env');
      const unsafePerlEnv = path.join(root, 'unsafe-perl-env');
      const unsafeRubyTrace = path.join(root, 'unsafe-ruby-trace');
      const unsafePerlCore = path.join(root, 'unsafe-perl-core');
      const unsafeRubyLoadPath = path.join(root, 'unsafe-ruby-load-path');
      const unsafePerlLoadPath = path.join(root, 'unsafe-perl-load-path');
      const unsafePerlHexFallback = path.join(root, 'unsafe-perl-hex-fallback');
      const unsafeRubyAlias = path.join(root, 'unsafe-ruby-alias');
      const unsafePerlAlias = path.join(root, 'unsafe-perl-alias');
      const unsafeUpperRubyMarker = path.join(root, 'unsafe-upper-ruby-marker');
      const unsafeUpperPerlMarker = path.join(root, 'unsafe-upper-perl-marker');
      const unsafeRubyLoneCarriageReturn = path.join(root, 'unsafe-ruby-lone-carriage-return');
      const foreignPerlShebang = path.join(root, 'foreign-perl-shebang');
      const unsafePerlUnknownOption = path.join(root, 'unsafe-perl-unknown-option');
      const longUnsafeRuby = path.join(root, 'long-unsafe-ruby');
      const longUnsafePerl = path.join(root, 'long-unsafe-perl');
      const overlongRuby = path.join(root, 'overlong-ruby');
      const longSafeRuby = path.join(root, 'long-safe-ruby');
      const safeRuby = path.join(root, 'safe-ruby');
      const safeRubyCrlf = path.join(root, 'safe-ruby-crlf');
      const maximumRubyCrlf = path.join(root, 'maximum-ruby-crlf');
      await writeFile(unsafeRuby, '#!/usr/bin/env -S ruby -Wn\nputs "sidecar"\n');
      await writeFile(unsafePerl, '#!/usr/bin/env -S perl -Un\nprint "sidecar";\n');
      await writeFile(unsafeRubyEnv, '#!/usr/bin/env -S RUBYOPT=-r./preload.rb ruby\nputs "sidecar"\n');
      await writeFile(unsafePerlEnv, '#!/usr/bin/env -S PERL5OPT=-MPreload perl\nprint "sidecar";\n');
      await writeFile(unsafeRubyTrace, '#!/usr/bin/env -S ruby -y\nputs "sidecar"\n');
      await writeFile(unsafePerlCore, '#!/usr/bin/env -S perl -u\nprint "sidecar";\n');
      await writeFile(unsafeRubyLoadPath, '#!/usr/bin/env -S ruby -I/tmp/hooks\nputs "sidecar"\n');
      await writeFile(unsafePerlLoadPath, '#!/usr/bin/env -S perl -I /tmp/hooks\nprint "sidecar";\n');
      await writeFile(unsafePerlHexFallback, '#!/usr/bin/env -S perl -0x41p\nprint "sidecar";\n');
      await writeFile(unsafeRubyAlias, '#!/usr/bin/env -S notruby -n\nputs "sidecar"\n');
      await writeFile(unsafePerlAlias, '#!/usr/bin/env -S notperl -n\nprint "sidecar";\n');
      await writeFile(unsafeUpperRubyMarker, `#!${path.join(root, 'NOTRUBY')} -w\nputs "sidecar"\n`);
      await writeFile(unsafeUpperPerlMarker, `#!${path.join(root, 'NOTPERL')} -w\nprint "sidecar";\n`);
      await writeFile(unsafeRubyLoneCarriageReturn, '#!/usr/bin/ruby\r -I/tmp/hooks\nputs "sidecar"\n');
      await writeFile(foreignPerlShebang, '#!/bin/echo -n\nprint "sidecar";\n');
      await writeFile(unsafePerlUnknownOption, '#!/usr/bin/env -S perl -q\nprint "sidecar";\n');
      await writeFile(longUnsafeRuby, `#!/usr/bin/env -S ruby ${'-w '.repeat(100)}-y\nputs "sidecar"\n`);
      await writeFile(longUnsafePerl, `#!/usr/bin/perl${' '.repeat(300)}-u\nprint "sidecar";\n`);
      await writeFile(overlongRuby, `#!/usr/bin/env -S ruby ${'-w '.repeat(MAXIMUM_SIDECAR_SHEBANG_LINE_BYTES)}-y\nputs "sidecar"\n`);
      await writeFile(longSafeRuby, `#!/usr/bin/env -S ruby ${'-w '.repeat(100)}-W:performance\nputs "sidecar"\n`);
      await writeFile(safeRuby, '#!/usr/bin/env -S ruby -W:performance\nputs "sidecar"\n');
      await writeFile(safeRubyCrlf, '#!/usr/bin/env -S ruby -W:performance\r\nputs "sidecar"\n');
      const maximumRubyPrefix = '#!/usr/bin/env ruby';
      await writeFile(
        maximumRubyCrlf,
        `${maximumRubyPrefix}${' '.repeat(MAXIMUM_SIDECAR_SHEBANG_LINE_BYTES - maximumRubyPrefix.length)}\r\nputs "sidecar"\n`,
      );
      for (const command of [
        [unsafeRuby],
        ['ruby', unsafeRuby],
        ['env', unsafeRuby],
        [unsafePerl],
        ['perl', unsafePerl],
        ['timeout', '1', unsafePerl],
        [unsafeRubyEnv],
        ['ruby', unsafeRubyEnv],
        [unsafePerlEnv],
        ['perl', unsafePerlEnv],
        [unsafeRubyTrace],
        ['ruby', unsafeRubyTrace],
        [unsafePerlCore],
        ['perl', unsafePerlCore],
        [unsafeRubyLoadPath],
        ['ruby', unsafeRubyLoadPath],
        ['ruby3.2', unsafeRubyLoadPath],
        ['env', unsafeRubyLoadPath],
        [unsafePerlLoadPath],
        ['perl', unsafePerlLoadPath],
        ['perl5.36', unsafePerlLoadPath],
        ['timeout', '1', unsafePerlLoadPath],
        [unsafePerlHexFallback],
        ['perl', unsafePerlHexFallback],
        ['ruby', unsafeRubyAlias],
        ['ruby3.2', unsafeRubyAlias],
        ['env', 'ruby', unsafeRubyAlias],
        ['perl', unsafePerlAlias],
        ['perl5.36', unsafePerlAlias],
        ['env', 'perl', unsafePerlAlias],
        ['ruby', unsafeUpperRubyMarker],
        ['ruby3.2', unsafeUpperRubyMarker],
        ['perl', unsafeUpperPerlMarker],
        ['perl5.36', unsafeUpperPerlMarker],
        [unsafeRubyLoneCarriageReturn],
        ['ruby', unsafeRubyLoneCarriageReturn],
        ['perl', foreignPerlShebang],
        ['timeout', '1', 'perl', foreignPerlShebang],
        [unsafePerlUnknownOption],
        ['perl', unsafePerlUnknownOption],
        ['perl5.36', unsafePerlUnknownOption],
        ['env', unsafePerlUnknownOption],
        [longUnsafeRuby],
        ['ruby', longUnsafeRuby],
        ['ruby3.2', longUnsafeRuby],
        ['env', longUnsafeRuby],
        [longUnsafePerl],
        ['perl', longUnsafePerl],
        ['perl5.36', longUnsafePerl],
        ['timeout', '1', 'perl', longUnsafePerl],
        [overlongRuby],
        ['ruby', overlongRuby],
      ]) {
        assert.throws(
          () => new CapabilitySidecar({ command, timeoutMs: 1000 }),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
          JSON.stringify(command),
        );
      }
      const originalPath = process.env.PATH;
      try {
        await chmod(longUnsafeRuby, 0o755);
        process.env.PATH = `${root}${path.delimiter}${originalPath ?? ''}`;
        assert.throws(
          () => new CapabilitySidecar({ command: [path.basename(longUnsafeRuby)], timeoutMs: 1000 }),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
      assert.doesNotThrow(() => new CapabilitySidecar({ command: [longSafeRuby], timeoutMs: 1000 }));
      assert.doesNotThrow(() => new CapabilitySidecar({ command: ['ruby', longSafeRuby], timeoutMs: 1000 }));
      assert.doesNotThrow(() => new CapabilitySidecar({ command: [safeRuby], timeoutMs: 1000 }));
      assert.doesNotThrow(() => new CapabilitySidecar({ command: ['ruby', safeRuby], timeoutMs: 1000 }));
      assert.doesNotThrow(() => new CapabilitySidecar({ command: [safeRubyCrlf], timeoutMs: 1000 }));
      assert.doesNotThrow(() => new CapabilitySidecar({ command: ['ruby', maximumRubyCrlf], timeoutMs: 1000 }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs non-executable Ruby and Perl shebang artifacts through their validated runtimes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-direct-shebang-runtime-'));
    try {
      const runtimeSource = (source) => `#!/usr/bin/env bun
        await new Response(Bun.stdin.stream()).text();
        process.stdout.write(JSON.stringify({
          command: 'manifest',
          payload: { source: ${JSON.stringify(source)}, runtimePath: process.argv[1], argv: process.argv.slice(2) }
        }) + '\\n');
      `;
      const embeddedRuntimeRoot = path.join(root, 'embedded');
      await mkdir(embeddedRuntimeRoot);
      const originalPath = process.env.PATH;
      try {
        process.env.PATH = `${root}${path.delimiter}${originalPath ?? ''}`;
        for (const { runtimeName, adapterName, tail } of [
          { runtimeName: 'ruby3.2', adapterName: 'adapter.rb', tail: 'ruby-tail' },
          { runtimeName: 'perl5.36', adapterName: 'adapter.pl', tail: 'perl-tail' },
          { runtimeName: 'Rscript', adapterName: 'adapter.R', tail: 'r-tail' },
        ]) {
          const receiverRuntimePath = path.join(root, runtimeName);
          const embeddedRuntimePath = path.join(embeddedRuntimeRoot, runtimeName);
          const adapterPath = path.join(root, adapterName);
          await writeFile(receiverRuntimePath, runtimeSource('receiver-path'));
          await chmod(receiverRuntimePath, 0o755);
          await writeFile(embeddedRuntimePath, runtimeSource('embedded-shebang-path'));
          await chmod(embeddedRuntimePath, 0o755);
          await writeFile(adapterPath, `#!${embeddedRuntimePath} -w\nignored by the fake runtime\n`);
          await chmod(adapterPath, 0o600);

          const result = await new CapabilitySidecar({
            command: [adapterPath, tail],
            timeoutMs: 1000,
          }).manifest();
          assert.equal(result.source, 'receiver-path');
          assert.equal(path.basename(result.runtimePath), runtimeName);
          assert.deepEqual(result.argv, ['-w', adapterPath, tail]);
        }
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the admitted adapter as the sole program in lowered non-JavaScript shebang argv', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-shebang-program-ownership-'));
    const originalPath = process.env.PATH;
    try {
      const pythonRuntimePath = path.join(root, 'python3');
      const phpRuntimePath = path.join(root, 'php');
      const secondaryProgramPath = path.join(root, 'secondary-program.py');
      const terminalDelimiterPath = path.join(root, 'terminal-delimiter.py');
      const runtimeSource = `#!/usr/bin/env bun
        await new Response(Bun.stdin.stream()).text();
        process.stdout.write(JSON.stringify({
          command: 'manifest',
          payload: { runtimePath: process.argv[1], argv: process.argv.slice(2) }
        }) + '\\n');
      `;
      await writeFile(pythonRuntimePath, runtimeSource);
      await writeFile(phpRuntimePath, runtimeSource);
      await writeFile(secondaryProgramPath, '#!/usr/bin/env -S python3 -- /tmp/unchecked.py\n');
      await writeFile(terminalDelimiterPath, '#!/usr/bin/env -S python3 --\n');
      await chmod(pythonRuntimePath, 0o755);
      await chmod(phpRuntimePath, 0o755);
      await chmod(secondaryProgramPath, 0o600);
      await chmod(terminalDelimiterPath, 0o600);
      process.env.PATH = `${root}${path.delimiter}${originalPath ?? ''}`;

      assert.throws(
        () => new CapabilitySidecar({ command: [secondaryProgramPath], timeoutMs: 1000 }),
        { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
      );
      const result = await new CapabilitySidecar({
        command: [terminalDelimiterPath],
        timeoutMs: 1000,
      }).manifest();
      assert.equal(path.basename(result.runtimePath), 'python3');
      assert.deepEqual(result.argv, [terminalDelimiterPath]);

      for (const [index, selector] of [
        ['-f', '/tmp/unchecked.php'],
        ['-f/tmp/unchecked.php'],
        ['--file', '/tmp/unchecked.php'],
        ['--file=/tmp/unchecked.php'],
        ['-F', '/tmp/unchecked.php'],
        ['-F/tmp/unchecked.php'],
        ['--process-file', '/tmp/unchecked.php'],
        ['--process-file=/tmp/unchecked.php'],
        ['--'],
      ].entries()) {
        const adapterPath = path.join(root, `php-program-selector-${index}.php`);
        await writeFile(adapterPath, `#!/usr/bin/env -S php ${selector.join(' ')}\n`);
        await chmod(adapterPath, 0o600);
        assert.throws(
          () => new CapabilitySidecar({ command: [adapterPath], timeoutMs: 1000 }),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
        );
      }

      const safePhpPath = path.join(root, 'safe-php.php');
      await writeFile(safePhpPath, '#!/usr/bin/env -S php -n\n');
      await chmod(safePhpPath, 0o600);
      const safePhp = await new CapabilitySidecar({
        command: [safePhpPath],
        timeoutMs: 1000,
      }).manifest();
      assert.equal(path.basename(safePhp.runtimePath), 'php');
      assert.deepEqual(safePhp.argv, ['-n', safePhpPath]);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects PATH-resolved and wrapper-selected implicit shebangs before spawn', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-path-spawn-identity-'));
    const originalPath = process.env.PATH;
    try {
      const inspectedBin = path.join(root, 'inspected-bin');
      const executableBin = path.join(root, 'executable-bin');
      const embeddedRuntimeRoot = path.join(root, 'embedded');
      const markerPath = path.join(root, 'embedded-runtime-invoked');
      await mkdir(inspectedBin);
      await mkdir(executableBin);
      await mkdir(embeddedRuntimeRoot);

      const embeddedRuntimePath = path.join(embeddedRuntimeRoot, 'ruby3.2');
      await writeFile(embeddedRuntimePath, `#!/usr/bin/env bun
        await Bun.write(${JSON.stringify(markerPath)}, 'invoked');
        await new Response(Bun.stdin.stream()).text();
        process.stdout.write(JSON.stringify({
          command: 'manifest',
          payload: { source: 'embedded-shebang-path' }
        }) + '\\n');
      `);
      await chmod(embeddedRuntimePath, 0o755);

      const inspectedEntrypoint = path.join(inspectedBin, 'adapter');
      const executableEntrypoint = path.join(executableBin, 'adapter');
      await writeFile(inspectedEntrypoint, 'harmless non-executable PATH shadow\n');
      await writeFile(executableEntrypoint, `#!${embeddedRuntimePath}\nignored by the embedded runtime\n`);
      await chmod(executableEntrypoint, 0o755);

      process.env.PATH = `${inspectedBin}${path.delimiter}${executableBin}${path.delimiter}${originalPath ?? ''}`;
      for (const command of [
        ['adapter'],
        ['env', 'adapter'],
        ['env', executableEntrypoint],
      ]) {
        await assert.rejects(
          async () => new CapabilitySidecar({ command, timeoutMs: 1000 }).manifest(),
          { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
          JSON.stringify(command),
        );
      }

      const cwdEntrypointRoot = path.join(root, 'cwd-entrypoint');
      await mkdir(cwdEntrypointRoot);
      const cwdEntrypoint = path.join(cwdEntrypointRoot, 'cwd-adapter');
      const selectedCwdEntrypoint = path.join(executableBin, 'cwd-adapter');
      await writeFile(cwdEntrypoint, '#!/bin/sh\nexit 1\n');
      await chmod(cwdEntrypoint, 0o755);
      await writeFile(selectedCwdEntrypoint, `#!${embeddedRuntimePath}\nignored by the embedded runtime\n`);
      await chmod(selectedCwdEntrypoint, 0o755);
      process.env.PATH = `${path.delimiter}${executableBin}`;
      await assert.rejects(
        async () => new CapabilitySidecar({
          command: ['cwd-adapter'],
          cwd: cwdEntrypointRoot,
          timeoutMs: 1000,
        }).manifest(),
        { code: 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID' },
      );

      if (process.platform !== 'win32') {
        const fifoEntrypoint = path.join(root, 'fifo-adapter.rb');
        const fifo = spawnSync('mkfifo', [fifoEntrypoint], { encoding: 'utf8' });
        assert.equal(fifo.status, 0, fifo.stderr);
        const moduleUrl = new URL('../src/sidecars/capability_sidecar.mjs', import.meta.url).href;
        const probe = spawnSync(process.execPath, ['-e', `
          import { CapabilitySidecar } from ${JSON.stringify(moduleUrl)};
          try {
            new CapabilitySidecar({ command: ['ruby', ${JSON.stringify(fifoEntrypoint)}] });
            process.stdout.write('admitted');
          } catch (error) {
            process.stdout.write(error?.code ?? 'unknown');
          }
        `], { encoding: 'utf8', timeout: 1000 });
        assert.equal(probe.status, 0, probe.error?.message ?? probe.stderr);
        assert.equal(probe.stdout, 'ERR_CAPABILITY_SIDECAR_COMMAND_INVALID');
      }
      await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
