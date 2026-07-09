import { spawn, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { receiverLocalEffectContext } from '../core/effect_context.mjs';
import { assertBytes, fail, fromUtf8, stableJson } from '../core/store.mjs';

export const CapabilitySidecarCommand = Object.freeze({
  manifest: 'manifest',
  preflight: 'preflight',
  resolve: 'resolve',
  recover: 'recover',
  dryRun: 'dry-run',
  shadow: 'shadow',
});

const COMMANDS = new Set(Object.values(CapabilitySidecarCommand));
const DEFAULT_SIDECAR_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const BYTES_SENTINEL_KEY = '__world_host_sidecar_type';
const BYTES_SENTINEL_VALUE = 'bytes';
const OBJECT_SENTINEL_VALUE = 'object';
const BYTES_SENTINEL_PAYLOAD = 'base64';
const OBJECT_SENTINEL_PAYLOAD = 'value';
const LEGACY_BYTES_KEY = '__bytes';
const EMPTY_BUN_ENV_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const EMPTY_BUN_CONFIG_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const SIDECAR_FRAME_PAYLOAD_OVERHEAD_BYTES = 4096;
const SIDECAR_FRAME_PAYLOAD_EXPANSION = 6;
const SIDECAR_SYNC_HELPER_ARG = '--world-host-sidecar-sync-helper';
const BUN_RUNTIME_VALUE_OPTIONS = new Set([
  '--conditions',
  '--config',
  '--config-file',
  '--console-depth',
  '--cpu-prof-dir',
  '--cpu-prof-name',
  '--dns-result-order',
  '--elide-lines',
  '--env-file',
  '--fetch-preconnect',
  '--filter',
  '--import',
  '--install',
  '--max-http-header-size',
  '--port',
  '--preload',
  '--require',
  '--shell',
  '--title',
  '--unhandled-rejections',
  '--user-agent',
  '-c',
  '-F',
  '-r',
]);
const BUN_ARGV_WRAPPER_COMMANDS = new Set(['command', 'env', 'gtimeout', 'ionice', 'nice', 'nohup', 'setsid', 'stdbuf', 'time', 'timeout']);
const BUN_SHELL_WRAPPER_COMMANDS = new Set(['bash', 'cmd', 'cmd.exe', 'csh', 'dash', 'fish', 'ksh', 'powershell', 'powershell.exe', 'pwsh', 'sh', 'tcsh', 'zsh']);
const PACKAGE_MANAGER_COMMANDS = new Set(['bunx', 'corepack', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn']);
const BUN_UNSUPPORTED_SUBCOMMANDS = new Set([
  'a',
  'add',
  'audit',
  'build',
  'bun',
  'c',
  'ci',
  'completions',
  'create',
  'dev',
  'dlx',
  'discord',
  'exec',
  'feedback',
  'getcompletes',
  'help',
  'i',
  'info',
  'init',
  'install',
  'link',
  'outdated',
  'patch',
  'patch-commit',
  'pm',
  'publish',
  'rebuild',
  'remove',
  'repl',
  'restart',
  'rm',
  'run',
  'run-script',
  'start',
  'stop',
  'test',
  'unlink',
  'update',
  'upgrade',
  'why',
  'x',
]);
const JS_RUNTIMES = new Set(['bun', 'node', 'deno']);
const NODE_UNSUPPORTED_VALUE_OPTIONS = new Set([
  '--env-file',
  '--env-file-if-exists',
  '--experimental-config-file',
  '--experimental-policy',
  '--experimental-loader',
  '--import',
  '--input-type',
  '--loader',
  '--openssl-config',
  '--require',
  '--run',
  '-r',
]);
const NODE_UNSUPPORTED_FLAG_PREFIXES = [
  '--env-file=',
  '--env-file-if-exists=',
  '--experimental-config-file=',
  '--experimental-policy=',
  '--experimental-loader=',
  '--import=',
  '--loader=',
  '--openssl-config=',
  '--require=',
  '--run=',
];
const NODE_UNSUPPORTED_EVAL_PREFIXES = ['-e', '-p', '--eval=', '--print='];
const NODE_ALLOWED_VALUE_OPTIONS = new Set(['--conditions']);
const NODE_ALLOWED_VALUE_PREFIXES = ['--conditions='];
const NODE_ALLOWED_FLAG_ONLY_OPTIONS = new Set([
  '--enable-source-maps',
  '--experimental-strip-types',
  '--no-warnings',
  '--trace-warnings',
]);
const DENO_OPTION_VALUE_OPTIONS = new Set(['--cert', '--config', '--config-file', '--location', '-c']);
const DENO_OPTION_INLINE_VALUE_OPTIONS = new Set(DENO_OPTION_VALUE_OPTIONS);
const DENO_ALLOWED_FLAG_ONLY_OPTIONS = new Set(['--no-config']);
const NON_JS_INLINE_EVAL_RUNTIMES = new Set(['perl', 'php', 'ruby', 'rscript', 'lua', 'luajit']);

export class CapabilitySidecar {
  constructor({ command, cwd = null, timeoutMs = 5000, maximumFrameBytes = 1024 * 1024, env = {}, packFingerprint = null } = {}) {
    if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== 'string' || item.length === 0)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar command must be an argv array');
    }
    if (cwd != null && (typeof cwd !== 'string' || cwd.length === 0)) {
      fail('ERR_CAPABILITY_SIDECAR_CWD_INVALID', 'sidecar cwd must be a path string');
    }
    if (packFingerprint != null && (typeof packFingerprint !== 'string' || packFingerprint.length === 0)) {
      fail('ERR_CAPABILITY_SIDECAR_PACK_FINGERPRINT_INVALID', 'sidecar pack fingerprint must be a string');
    }
    const childEnv = sidecarUserEnv(env);
    if (bareScriptEntrypoint(command[0])) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar script entrypoints must be path-qualified');
    }
    if (pathQualifiedJavaScriptEntrypoint(command[0])) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar JavaScript entrypoints must use an explicit runtime command');
    }
    const resolvedShebangRuntime = pathResolvedJavaScriptRuntimeShebang(command[0], sidecarPath(), cwd ?? undefined);
    if (resolvedShebangRuntime === 'bun') {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar Bun shebang entrypoints must be path-qualified');
    }
    if (resolvedShebangRuntime === 'node' || resolvedShebangRuntime === 'deno') {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar Node and Deno shebang entrypoints must use explicit runtime commands');
    }
    const directShebangRuntime = javascriptRuntimeShebangRuntime(commandInspectionPath(command[0], cwd ?? undefined));
    if (directShebangRuntime === 'node' || directShebangRuntime === 'deno') {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar Node and Deno shebang entrypoints must use explicit runtime commands');
    }
    if (pathQualifiedSidecarRuntime(command[0])) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar runtime commands must not be path-qualified');
    }
    assertSupportedNonJavaScriptRuntimeCommand(command);
    sidecarSpawnArgv(command, cwd ?? undefined, childEnv);
    this.command = Object.freeze([...command]);
    this.cwd = cwd == null ? undefined : path.resolve(cwd);
    this.timeoutMs = timeoutMs;
    this.maximumFrameBytes = maximumFrameBytes;
    this.env = sidecarEnv({ PATH: sidecarPath(), ...childEnv });
    this.packFingerprint = packFingerprint;
  }

  async request(command, payload = {}) {
    if (!COMMANDS.has(command)) fail('ERR_CAPABILITY_SIDECAR_COMMAND_UNSUPPORTED');
    const frame = encodeSidecarFrame({ command, payload });
    if (frame.byteLength > this.maximumFrameBytes) fail('ERR_CAPABILITY_SIDECAR_FRAME_TOO_LARGE');
    const response = await runSidecarCommand({
      argv: this.command,
      input: frame,
      timeoutMs: this.timeoutMs,
      maximumFrameBytes: this.maximumFrameBytes,
      env: this.env,
      cwd: this.cwd,
    });
    if (!response || response.command !== command) fail('ERR_CAPABILITY_SIDECAR_RESPONSE_COMMAND');
    return response;
  }

  requestSync(command, payload = {}) {
    if (!COMMANDS.has(command)) fail('ERR_CAPABILITY_SIDECAR_COMMAND_UNSUPPORTED');
    const frame = encodeSidecarFrame({ command, payload });
    if (frame.byteLength > this.maximumFrameBytes) fail('ERR_CAPABILITY_SIDECAR_FRAME_TOO_LARGE');
    const response = runSidecarCommandSync({
      argv: this.command,
      input: frame,
      timeoutMs: this.timeoutMs,
      maximumFrameBytes: this.maximumFrameBytes,
      env: this.env,
      cwd: this.cwd,
    });
    if (!response || response.command !== command) fail('ERR_CAPABILITY_SIDECAR_RESPONSE_COMMAND');
    return response;
  }

  manifest() {
    return sidecarManifestTransportLimits(
      this.requestPayloadSync(CapabilitySidecarCommand.manifest, sidecarPackPayload(this.packFingerprint)),
      this.maximumFrameBytes,
    );
  }

  async preflight(context, hostRequest) {
    return await this.requestPayload(CapabilitySidecarCommand.preflight, sidecarPackPayload(
      this.packFingerprint,
      driverHostRequestPayload(context, hostRequest, arguments.length),
    ));
  }

  async resolve(context, hostRequest) {
    return await this.requestPayload(CapabilitySidecarCommand.resolve, sidecarPackPayload(
      this.packFingerprint,
      driverHostRequestPayload(context, hostRequest, arguments.length),
    ));
  }

  async recover(context, effectRecord) {
    const sidecarContext = receiverLocalEffectContext(context);
    return await this.requestPayload(CapabilitySidecarCommand.recover, sidecarPackPayload(
      this.packFingerprint,
      arguments.length === 1 ? sidecarContext : { context: sidecarContext, effectRecord },
    ));
  }

  async dryRun(context, hostRequest) {
    return await this.requestPayload(CapabilitySidecarCommand.dryRun, sidecarPackPayload(
      this.packFingerprint,
      driverHostRequestPayload(context, hostRequest, arguments.length),
    ));
  }

  async shadow(context, hostRequest, recordedResolution) {
    const sidecarContext = receiverLocalEffectContext(context);
    return await this.requestPayload(
      CapabilitySidecarCommand.shadow,
      sidecarPackPayload(
        this.packFingerprint,
        arguments.length === 1 ? sidecarContext : { context: sidecarContext, hostRequest, recordedResolution },
      ),
    );
  }

  async requestPayload(command, payload = {}) {
    return (await this.request(command, payload)).payload;
  }

  requestPayloadSync(command, payload = {}) {
    return this.requestSync(command, payload).payload;
  }
}

function driverHostRequestPayload(context, hostRequest, arity) {
  const sidecarContext = receiverLocalEffectContext(context);
  return arity === 1 ? sidecarContext : { context: sidecarContext, hostRequest };
}

function sidecarPackPayload(packFingerprint, payload = {}) {
  return packFingerprint == null ? payload : { ...payload, packFingerprint };
}

function sidecarManifestTransportLimits(raw, maximumFrameBytes) {
  if (!raw || typeof raw !== 'object') return raw;
  const transportableBytes = sidecarTransportablePayloadBytes(maximumFrameBytes);
  let manifest = raw;
  for (const field of ['maximumRequestBytes', 'maximumResponseBytes']) {
    if (Number.isSafeInteger(raw[field]) && raw[field] > transportableBytes) {
      if (manifest === raw) manifest = { ...raw };
      manifest[field] = transportableBytes;
    }
  }
  return manifest;
}

function sidecarTransportablePayloadBytes(maximumFrameBytes) {
  return Math.max(1, Math.floor((maximumFrameBytes - SIDECAR_FRAME_PAYLOAD_OVERHEAD_BYTES) / SIDECAR_FRAME_PAYLOAD_EXPANSION));
}

export class CapabilitySidecarConformance {
  constructor({ command, cwd = null, vectors = [] } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.vectors = Object.freeze([...vectors]);
    Object.freeze(this);
  }

  async run() {
    const sidecar = new CapabilitySidecar({ command: this.command, cwd: this.cwd });
    const manifest = await sidecar.manifest();
    const results = [];
    for (const vector of this.vectors) {
      const command = vector?.command;
      if (!COMMANDS.has(command)) fail('ERR_CAPABILITY_SIDECAR_CONFORMANCE_VECTOR_INVALID');
      const response = await sidecar.request(command, vector.payload ?? {});
      if (response.command !== command) fail('ERR_CAPABILITY_SIDECAR_CONFORMANCE_VECTOR_FAILED');
      if (vector.expectedPayload != null && stableJson(response.payload) !== stableJson(vector.expectedPayload)) {
        fail('ERR_CAPABILITY_SIDECAR_CONFORMANCE_VECTOR_FAILED');
      }
      results.push(Object.freeze({ command, accepted: true }));
    }
    return Object.freeze({
      manifest,
      vectorCount: this.vectors.length,
      vectors: Object.freeze(results),
      sidecarOutputTrusted: false,
      worldAuthoredEvidence: false,
    });
  }
}

export function encodeSidecarFrame(frame) {
  if (!frame || typeof frame !== 'object' || !COMMANDS.has(frame.command)) fail('ERR_CAPABILITY_SIDECAR_FRAME_INVALID');
  return fromUtf8(`${JSON.stringify(encodeBytes(frame))}\n`);
}

export function decodeSidecarFrame(bytes, maximumFrameBytes = 1024 * 1024) {
  const input = assertBytes(bytes, 'frame');
  if (input.byteLength > maximumFrameBytes) fail('ERR_CAPABILITY_SIDECAR_FRAME_TOO_LARGE');
  const text = new TextDecoder().decode(input).trim();
  const parsed = JSON.parse(text);
  return decodeBytes(parsed);
}

async function runSidecarCommand({ argv, input, timeoutMs, maximumFrameBytes, env, cwd }) {
  return await new Promise((resolve, reject) => {
      const spawnArgv = sidecarSpawnArgv(argv, cwd, env);
    const child = spawn(spawnArgv[0], spawnArgv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env,
      cwd,
    });
    let stdout = new Uint8Array();
    let stderr = '';
    let settled = false;
    let terminalError = null;
    let stdinError = null;
    let killTimer = null;
    const timer = setTimeout(() => {
      terminateWith(Object.assign(new Error('sidecar timeout'), { code: 'ERR_CAPABILITY_SIDECAR_TIMEOUT' }));
    }, timeoutMs);
    function terminateWith(error) {
      if (settled || terminalError) return;
      terminalError = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, 100);
    }
    child.stdout.on('data', (chunk) => {
      if (terminalError) return;
      stdout = concat(stdout, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      if (stdout.byteLength > maximumFrameBytes) {
        terminateWith(Object.assign(new Error('sidecar output too large'), { code: 'ERR_CAPABILITY_SIDECAR_FRAME_TOO_LARGE' }));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (terminalError) return;
      stderr += String(chunk);
      if (Buffer.byteLength(stderr) > maximumFrameBytes) {
        terminateWith(Object.assign(new Error('sidecar stderr too large'), { code: 'ERR_CAPABILITY_SIDECAR_STDERR_TOO_LARGE' }));
      }
    });
    child.stdin.on('error', (error) => {
      stdinError = error;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      if (terminalError) {
        reject(terminalError);
        return;
      }
      if (status !== 0) {
        reject(Object.assign(new Error(`sidecar exited ${status}: stderr ${Buffer.byteLength(stderr)} bytes redacted`), { code: 'ERR_CAPABILITY_SIDECAR_EXIT' }));
        return;
      }
      if (stdinError) {
        reject(Object.assign(new Error(`sidecar stdin write failed: ${stdinError.code ?? 'error'}`), { code: 'ERR_CAPABILITY_SIDECAR_STDIN_WRITE' }));
        return;
      }
      try {
        resolve(decodeSidecarFrame(stdout, maximumFrameBytes));
      } catch (error) {
        error.code ??= 'ERR_CAPABILITY_SIDECAR_OUTPUT_INVALID';
        reject(error);
      }
    });
    try {
      child.stdin.end(input);
    } catch (error) {
      stdinError = error;
    }
  });
}

function runSidecarCommandSync({ argv, input, timeoutMs, maximumFrameBytes, env, cwd }) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), SIDECAR_SYNC_HELPER_ARG], {
    input: Buffer.from(JSON.stringify({
      argv,
      inputBase64: Buffer.from(input).toString('base64'),
      timeoutMs,
      maximumFrameBytes,
      env,
      cwd,
    })),
    timeout: timeoutMs + 1000,
    killSignal: 'SIGKILL',
    maxBuffer: maximumFrameBytes * 2 + 1024,
    shell: false,
    env: process.env,
  });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') fail('ERR_CAPABILITY_SIDECAR_TIMEOUT');
    if (result.error.code === 'ENOBUFS') fail('ERR_CAPABILITY_SIDECAR_FRAME_TOO_LARGE');
    throw result.error;
  }
  const stdout = result.stdout ? Buffer.from(result.stdout).toString('utf8') : '';
  if (result.status !== 0) {
    const stderr = result.stderr ? Buffer.from(result.stderr).toString('utf8') : '';
    fail('ERR_CAPABILITY_SIDECAR_EXIT', `sidecar helper exited ${result.status ?? result.signal}: stderr ${Buffer.byteLength(stderr)} bytes redacted`);
  }
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    fail('ERR_CAPABILITY_SIDECAR_OUTPUT_INVALID');
  }
  if (!payload.ok) fail(payload.code ?? 'ERR_CAPABILITY_SIDECAR_OUTPUT_INVALID', payload.message ?? payload.code);
  return decodeBytes(payload.response);
}

async function runSidecarSyncHelper() {
  try {
    let stdin = '';
    for await (const chunk of process.stdin) stdin += Buffer.from(chunk).toString('utf8');
    const payload = JSON.parse(stdin);
    const response = await runSidecarCommand({
      argv: payload.argv,
      input: Uint8Array.from(Buffer.from(payload.inputBase64, 'base64')),
      timeoutMs: payload.timeoutMs,
      maximumFrameBytes: payload.maximumFrameBytes,
      env: payload.env,
      cwd: payload.cwd,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, response: encodeBytes(response) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? 'ERR_CAPABILITY_SIDECAR_OUTPUT_INVALID',
      message: error?.message ?? String(error),
    })}\n`);
  }
}

function sidecarSpawnArgv(argv, cwd = undefined, env = undefined) {
  const emptyEnvFileArg = `--env-file=${EMPTY_BUN_ENV_FILE}`;
  const emptyConfigArg = `--config=${EMPTY_BUN_CONFIG_FILE}`;
  const noInstallArg = '--no-install';
  if (commandBaseName(argv[0]) !== 'bun') {
    const inspectionPath = commandInspectionPath(argv[0], cwd);
    const shebangRuntime = javascriptRuntimeShebangRuntime(inspectionPath);
    if (shebangRuntime === 'node' || shebangRuntime === 'deno') {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar Node and Deno shebang entrypoints must use explicit runtime commands');
    }
    const nonJavaScriptShebangArgv = nonJavaScriptShebangRuntimeArgv(inspectionPath);
    if (nonJavaScriptShebangArgv) assertSupportedNonJavaScriptShebangRuntimeCommand(nonJavaScriptShebangArgv);
    assertSupportedDirectRuntimeCommand(argv);
    if (wrappedJavaScriptRuntimeCommand(argv, cwd, env?.PATH)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar JavaScript runtimes must not run through command wrappers');
    }
    if (bunWrapperCommand(argv, cwd, env?.PATH)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars must not run through command wrappers');
    }
    assertNoPackageManagerCommand(argv, cwd, env?.PATH);
    assertSupportedNonJavaScriptRuntimeCommand(argv);
    assertSupportedWrappedNonJavaScriptRuntimeCommands(argv, cwd, env?.PATH);
    const bunShebangArgs = bunShebangRuntimeArgs(inspectionPath);
    if (bunShebangArgs) {
      const shebangArgv = ['bun', ...bunShebangArgs, ...argv];
      assertSupportedBunEnvFileOptions(shebangArgv);
      return [process.execPath, emptyEnvFileArg, emptyConfigArg, noInstallArg, ...bunShebangArgs, ...argv];
    }
    return argv;
  }
  assertSupportedBunEnvFileOptions(argv);
  return [argv[0], emptyEnvFileArg, emptyConfigArg, noInstallArg, ...argv.slice(1)];
}

function bunWrapperCommand(argv, cwd = undefined, searchPath = undefined) {
  const command = commandBaseName(argv[0]);
  if (BUN_SHELL_WRAPPER_COMMANDS.has(command)) return true;
  if (!BUN_ARGV_WRAPPER_COMMANDS.has(command)) return false;
  return wrapperCommandArguments(argv, cwd, searchPath).some(({ value, cwd: argumentCwd, searchPath: argumentSearchPath }) =>
    BUN_SHELL_WRAPPER_COMMANDS.has(commandBaseName(value)) || bunCommandArgument(value, argumentCwd, argumentSearchPath));
}

function wrappedJavaScriptRuntimeCommand(argv, cwd = undefined, searchPath = undefined) {
  const command = commandBaseName(argv[0]);
  if (BUN_SHELL_WRAPPER_COMMANDS.has(command)) return true;
  if (!BUN_ARGV_WRAPPER_COMMANDS.has(command)) return false;
  return wrapperCommandArguments(argv, cwd, searchPath).some(({ value, cwd: argumentCwd, searchPath: argumentSearchPath }) =>
    BUN_SHELL_WRAPPER_COMMANDS.has(commandBaseName(value)) || javascriptRuntimeCommandArgument(value, argumentCwd, argumentSearchPath));
}

function wrapperCommandArguments(argv, cwd = undefined, searchPath = undefined) {
  const command = commandBaseName(argv[0]);
  if (command === 'command') return commandWrapperCommandArguments(argv, cwd, searchPath);
  if (command === 'env') return envWrapperCommandArguments(argv, cwd, searchPath);
  if (command === 'gtimeout' || command === 'timeout') return timeoutWrapperCommandArguments(argv, cwd, searchPath);
  if (command === 'ionice') return optionWrapperCommandArguments(argv, cwd, searchPath, new Set(['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid']));
  if (command === 'nice') return niceWrapperCommandArguments(argv, cwd, searchPath);
  if (command === 'nohup') return nohupWrapperCommandArguments(argv, cwd, searchPath);
  if (command === 'setsid') return optionWrapperCommandArguments(argv, cwd, searchPath);
  if (command === 'stdbuf') return stdbufWrapperCommandArguments(argv, cwd, searchPath);
  if (command === 'time') return optionWrapperCommandArguments(argv, cwd, searchPath, new Set(['-f', '--format', '-o', '--output']));
  return wrapperCommandFromIndex(argv, 1, cwd, searchPath);
}

function commandWrapperCommandArguments(argv, cwd = undefined, searchPath = undefined) {
  let index = 1;
  for (; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') {
      index += 1;
      break;
    }
    if (value === '-p') continue;
    if (value.startsWith('-')) continue;
    break;
  }
  return wrapperCommandFromIndex(argv, index, cwd, searchPath);
}

function envWrapperCommandArguments(argv, cwd = undefined, searchPath = undefined) {
  let effectiveCwd = cwd;
  let effectiveSearchPath = searchPath;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') continue;
    const assignment = envAssignment(value);
    if (assignment) {
      if (unsupportedSidecarPreloadEnvKey(assignment.name)) {
        fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar env wrapper assignments must not set runtime preload options');
      }
      if (assignment.name === 'PATH') effectiveSearchPath = assignment.value;
      continue;
    }
    if (value === '-i' || value === '--ignore-environment' || value === '-0' || value === '--null' ||
      value === '-v' || value === '--debug' || value === '--list-signal-handling') continue;
    if (value === '-S' || value === '--split-string') {
      index += 1;
      return wrapperCommandArguments(['env', ...splitEnvString(argv[index] ?? ''), ...argv.slice(index + 1)], effectiveCwd, effectiveSearchPath);
    }
    if (value.startsWith('-S') && value !== '-S') {
      return wrapperCommandArguments(['env', ...splitEnvString(value.slice(2)), ...argv.slice(index + 1)], effectiveCwd, effectiveSearchPath);
    }
    if (value.startsWith('--split-string=')) {
      return wrapperCommandArguments(['env', ...splitEnvString(value.slice('--split-string='.length)), ...argv.slice(index + 1)], effectiveCwd, effectiveSearchPath);
    }
    if (value === '-u' || value === '--unset') {
      index += 1;
      continue;
    }
    if (value === '-P') {
      effectiveSearchPath = argv[index + 1] ?? effectiveSearchPath;
      index += 1;
      continue;
    }
    if (value.startsWith('-P') && value !== '-P') {
      effectiveSearchPath = value.slice(2);
      continue;
    }
    if (value === '-C' || value === '--chdir') {
      effectiveCwd = envChdirCwd(argv[index + 1], effectiveCwd);
      index += 1;
      continue;
    }
    if (value.startsWith('--unset=')) continue;
    if (value === '--argv0') {
      index += 1;
      continue;
    }
    if (value.startsWith('--argv0=') || value.startsWith('--block-signal') ||
      value.startsWith('--default-signal') || value.startsWith('--ignore-signal')) continue;
    if (value.startsWith('--chdir=')) {
      effectiveCwd = envChdirCwd(value.slice('--chdir='.length), effectiveCwd);
      continue;
    }
    if (value.startsWith('-')) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', `sidecar env wrapper option is unsupported: ${value}`);
    }
    return wrapperCommandFromIndex(argv, index, effectiveCwd, effectiveSearchPath);
  }
  return [];
}

function timeoutWrapperCommandArguments(argv, cwd = undefined, searchPath = undefined) {
  let index = 1;
  let optionsTerminated = false;
  for (; index < argv.length; index += 1) {
    const value = argv[index];
    if (!optionsTerminated && value === '--') {
      optionsTerminated = true;
      continue;
    }
    if (!optionsTerminated && (value === '-k' || value === '--kill-after' || value === '-s' || value === '--signal')) {
      index += 1;
      continue;
    }
    if (!optionsTerminated && value.startsWith('-') && !value.match(/^-?\d/)) continue;
    index += 1;
    break;
  }
  return wrapperCommandFromIndex(argv, index, cwd, searchPath);
}

function niceWrapperCommandArguments(argv, cwd = undefined, searchPath = undefined) {
  let index = 1;
  for (; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') {
      index += 1;
      break;
    }
    if (value === '-n' || value === '--adjustment') {
      index += 1;
      continue;
    }
    if (/^-\d+$/.test(value) || value.startsWith('-n') || value.startsWith('--adjustment=')) continue;
    if (value.startsWith('-')) continue;
    break;
  }
  return wrapperCommandFromIndex(argv, index, cwd, searchPath);
}

function optionWrapperCommandArguments(argv, cwd = undefined, searchPath = undefined, valueOptions = new Set()) {
  let index = 1;
  for (; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') {
      index += 1;
      break;
    }
    if (valueOptions.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('-')) continue;
    break;
  }
  return wrapperCommandFromIndex(argv, index, cwd, searchPath);
}

function nohupWrapperCommandArguments(argv, cwd = undefined, searchPath = undefined) {
  return wrapperCommandFromIndex(argv, argv[1] === '--' ? 2 : 1, cwd, searchPath);
}

function stdbufWrapperCommandArguments(argv, cwd = undefined, searchPath = undefined) {
  let index = 1;
  for (; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') {
      index += 1;
      break;
    }
    if (value === '-i' || value === '--input' || value === '-o' || value === '--output' || value === '-e' || value === '--error') {
      index += 1;
      continue;
    }
    if (/^-[ioe]/.test(value) || value.startsWith('--input=') || value.startsWith('--output=') || value.startsWith('--error=')) continue;
    if (value.startsWith('-')) continue;
    break;
  }
  return wrapperCommandFromIndex(argv, index, cwd, searchPath);
}

function wrapperCommandFromIndex(argv, index, cwd = undefined, searchPath = undefined) {
  const value = argv[index];
  if (!value) return [];
  const command = commandBaseName(value);
  if (BUN_ARGV_WRAPPER_COMMANDS.has(command)) {
    return wrapperCommandArguments(argv.slice(index), cwd, searchPath);
  }
  return [{ value, cwd, searchPath, argv: argv.slice(index) }];
}

function envChdirCwd(value, cwd = undefined) {
  if (!value) return cwd;
  return path.isAbsolute(value) ? value : path.resolve(cwd ?? process.cwd(), value);
}

function envAssignment(value) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(value);
  return match ? { name: match[1], value: match[2] } : null;
}

function splitEnvString(value) {
  if (/["'\\]/.test(value)) {
    fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar env -S arguments must not use quotes or escapes');
  }
  return value.trim().split(/\s+/).filter(Boolean);
}

function javascriptRuntimeCommandArgument(value, cwd = undefined, searchPath = undefined) {
  if (JS_RUNTIMES.has(commandBaseName(value))) return true;
  if ((value.includes('/') || value.includes('\\')) && javascriptRuntimeShebangEntrypoint(commandInspectionPath(value, cwd))) return true;
  if (JS_RUNTIMES.has(pathResolvedJavaScriptRuntimeShebang(value, searchPath, cwd))) return true;
  return /(?:^|[\s"'=:;|&()<>])(?:bun|node|deno)(?:\.exe)?(?:$|[\s"':;|&()<>])/.test(value.toLowerCase());
}

function bunCommandArgument(value, cwd = undefined, searchPath = undefined) {
  if (commandBaseName(value) === 'bun') return true;
  if ((value.includes('/') || value.includes('\\')) && bunShebangEntrypoint(commandInspectionPath(value, cwd))) return true;
  if (pathResolvedJavaScriptRuntimeShebang(value, searchPath, cwd) === 'bun') return true;
  return /(?:^|[\s"'=:;|&()<>])bun(?:\.exe)?(?:$|[\s"':;|&()<>])/.test(value.toLowerCase());
}

function commandInspectionPath(value, cwd = undefined) {
  if (!value.includes('/') && !value.includes('\\')) return value;
  if (path.isAbsolute(value)) return value;
  return path.resolve(cwd ?? process.cwd(), value);
}

function assertSupportedBunEnvFileOptions(argv) {
  let entrypointSeen = false;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (entrypointSeen) continue;
    if (bunRuntimeOptionValuePosition(argv, index)) continue;
    if (value === '--cwd' || value.startsWith('--cwd=')) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support --cwd');
    }
    if (value === '--no-config' || value.startsWith('--no-config=')) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support --no-config');
    }
    if (value === '--env-file' || value.startsWith('--env-file=')) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support caller-supplied env files');
    }
    if (unsupportedBunConfigOption(value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support caller-supplied config files');
    }
    if (unsupportedBunCodeLoadingOption(value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support inline code or preload options');
    }
    if (unsupportedBunEarlyExitOption(value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support early-exit flags before the entrypoint');
    }
    if (unsupportedBunNetworkOption(value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support preconnect options');
    }
    if (unsupportedBunTlsOption(value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support disabling TLS certificate verification');
    }
    if (unsupportedBunWatchOption(value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support watch or hot reload options');
    }
    if (unsupportedBunInstallOption(value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support package auto-install');
    }
    if (unsupportedBunSubcommand(value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support package or execution subcommands');
    }
    if (value === '--env-file-if-exists' || value.startsWith('--env-file-if-exists=')) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support --env-file-if-exists');
    }
    if (value === '--') {
      if (index + 1 < argv.length && !argv[index + 1].startsWith('-')) return;
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars must name an adapter entrypoint');
    }
    if (!value.startsWith('-')) entrypointSeen = true;
  }
  if (!entrypointSeen) fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars must name an adapter entrypoint');
}

function unsupportedBunConfigOption(value) {
  return value === '--config' || value.startsWith('--config=') ||
    value === '--config-file' || value.startsWith('--config-file=') ||
    value === '-c' || value.startsWith('-c=') || (value.startsWith('-c') && value !== '-c');
}

function unsupportedBunCodeLoadingOption(value) {
  return value === '-e' || value === '--eval' || value.startsWith('-e') || value.startsWith('--eval=') ||
    value === '-p' || value.startsWith('-p') || value === '--print' || value.startsWith('--print=') ||
    value === '--inspect' || value.startsWith('--inspect=') ||
    value === '--inspect-brk' || value.startsWith('--inspect-brk=') ||
    value === '--inspect-wait' || value.startsWith('--inspect-wait=') ||
    value === '--import' || value.startsWith('--import=') ||
    value === '-r' || value.startsWith('-r') ||
    value === '--require' || value.startsWith('--require=') ||
    value === '--preload' || value.startsWith('--preload=');
}

function unsupportedBunNetworkOption(value) {
  return value === '--fetch-preconnect' || value.startsWith('--fetch-preconnect=') ||
    value === '--redis-preconnect' || value.startsWith('--redis-preconnect=') ||
    value === '--prefer-latest' || value.startsWith('--prefer-latest=');
}

function unsupportedBunEarlyExitOption(value) {
  return value === '-v' || value === '--version' || value === '--revision' ||
    value === '-h' || value === '--help' ||
    (/^-[A-Za-z]{2,}$/.test(value) && /[vh]/.test(value.slice(1)));
}

function unsupportedBunTlsOption(value) {
  return value === '--unsafely-ignore-certificate-errors' || value.startsWith('--unsafely-ignore-certificate-errors=');
}

function unsupportedBunWatchOption(value) {
  return value === '--watch' || value.startsWith('--watch=') || value === '--hot' || value.startsWith('--hot=');
}

function unsupportedBunInstallOption(value) {
  return value === '-i' || value === '--install' || value.startsWith('--install=');
}

function unsupportedBunSubcommand(value) {
  return BUN_UNSUPPORTED_SUBCOMMANDS.has(value);
}

function bunRuntimeOptionValuePosition(argv, index) {
  const previous = argv[index - 1];
  return typeof previous === 'string' && BUN_RUNTIME_VALUE_OPTIONS.has(previous);
}

function assertSupportedDirectRuntimeCommand(argv) {
  const runtime = commandBaseName(argv[0]);
  if (PACKAGE_MANAGER_COMMANDS.has(runtime)) {
    fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar commands must use a path-qualified adapter entrypoint, not a package manager');
  }
  if (runtime === 'node') {
    assertSupportedNodeRuntimeCommand(argv);
    return;
  }
  if (runtime === 'deno') {
    assertSupportedDenoRuntimeCommand(argv);
  }
}

function assertSupportedNodeRuntimeCommand(argv) {
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') {
      if (index + 1 < argv.length) return;
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Node sidecars require a local entrypoint');
    }
    if (unsupportedNodeRuntimeOption(value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Node sidecars do not support env-file, inline code, or preload options');
    }
    if (NODE_ALLOWED_VALUE_OPTIONS.has(value)) {
      index += 1;
      continue;
    }
    if (NODE_ALLOWED_VALUE_PREFIXES.some((prefix) => value.startsWith(prefix))) continue;
    if (NODE_ALLOWED_FLAG_ONLY_OPTIONS.has(value)) continue;
    if (value.startsWith('-')) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Node sidecars do not support this runtime option before the entrypoint');
    }
    if (!value.startsWith('-')) return;
  }
  fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Node sidecars require a local entrypoint');
}

function unsupportedNodeRuntimeOption(value) {
  return value === 'inspect' || value === '-e' || value === '-p' || value === '--eval' || value === '--print' ||
    value.startsWith('--inspect') || value === '--debug-port' || value.startsWith('--debug-port=') ||
    NODE_UNSUPPORTED_EVAL_PREFIXES.some((prefix) => value.startsWith(prefix)) ||
    NODE_UNSUPPORTED_VALUE_OPTIONS.has(value) ||
    NODE_UNSUPPORTED_FLAG_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function assertSupportedDenoRuntimeCommand(argv) {
  let runSubcommandSeen = false;
  let configIsolated = false;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') {
      if (!runSubcommandSeen) {
        fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Deno sidecars require a local entrypoint');
      }
      continue;
    }
    if (denoOptionValuePosition(argv, index)) continue;
    if (value === 'eval') {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Deno sidecars do not support inline eval commands');
    }
    if (denoConfigOption(value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Deno sidecars must use --no-config instead of caller-supplied config files');
    }
    if (unsupportedDenoTlsOption(value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Deno sidecars do not support disabling TLS certificate verification');
    }
    if (unsupportedDenoPermissionOption(value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Deno sidecars do not support permission-granting flags');
    }
    if (value === '--no-config') {
      configIsolated = true;
      continue;
    }
    if (DENO_ALLOWED_FLAG_ONLY_OPTIONS.has(value)) continue;
    if (denoInlineOptionValue(value)) {
      continue;
    }
    if (denoOptionConsumesNext(value)) {
      index += 1;
      continue;
    }
    if (value === 'run' && !runSubcommandSeen) {
      runSubcommandSeen = true;
      continue;
    }
    if (!value.startsWith('-')) {
      if (!runSubcommandSeen) {
        fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Deno sidecars must use the run subcommand');
      }
      if (!configIsolated) {
        fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Deno sidecars must disable or pin config before the entrypoint');
      }
      assertLocalDenoEntrypoint(value);
      return;
    }
    fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Deno sidecars do not support this runtime option before the entrypoint');
  }
  fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Deno sidecars require a local entrypoint');
}

function assertSupportedNonJavaScriptRuntimeCommand(argv) {
  const runtime = nonJavaScriptRuntimeName(commandBaseName(argv[0]));
  if (!nonJavaScriptRuntimeSupportsInlineEval(runtime)) return;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') {
      if (index + 1 < argv.length && !argv[index + 1].startsWith('-')) return;
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar runtime commands must use path-qualified adapter entrypoints');
    }
    if (unsupportedNonJavaScriptRuntimeOption(runtime, value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar runtime commands must use path-qualified adapter entrypoints');
    }
    if (nonJavaScriptRuntimeOptionConsumesNext(runtime, value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith('-')) return;
  }
  fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar runtime commands must use path-qualified adapter entrypoints');
}

function assertSupportedNonJavaScriptShebangRuntimeCommand(argv) {
  const runtime = nonJavaScriptRuntimeName(commandBaseName(argv[0]));
  if (!nonJavaScriptRuntimeSupportsInlineEval(runtime)) return;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') return;
    if (unsupportedNonJavaScriptRuntimeOption(runtime, value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar shebang runtime commands must not evaluate code before the entrypoint');
    }
    if (nonJavaScriptRuntimeOptionConsumesNext(runtime, value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith('-')) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar shebang runtime commands must not name a second entrypoint');
    }
  }
}

function assertSupportedWrappedNonJavaScriptRuntimeCommands(argv, cwd = undefined, searchPath = undefined) {
  const command = commandBaseName(argv[0]);
  if (!BUN_ARGV_WRAPPER_COMMANDS.has(command)) return;
  for (const candidate of wrapperCommandArguments(argv, cwd, searchPath)) {
    assertSupportedNonJavaScriptRuntimeCommand(candidate.argv ?? [candidate.value]);
  }
}

function assertNoPackageManagerCommand(argv, cwd = undefined, searchPath = undefined) {
  const command = commandBaseName(argv[0]);
  if (PACKAGE_MANAGER_COMMANDS.has(command)) {
    fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar commands must not execute package managers');
  }
  if (!BUN_ARGV_WRAPPER_COMMANDS.has(command)) return;
  for (const candidate of wrapperCommandArguments(argv, cwd, searchPath)) {
    if (PACKAGE_MANAGER_COMMANDS.has(commandBaseName(candidate.value))) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar commands must not execute package managers');
    }
  }
}

function nonJavaScriptRuntimeSupportsInlineEval(runtime) {
  runtime = nonJavaScriptRuntimeName(runtime);
  return /^python(?:\d+(?:\.\d+)*)?$/.test(runtime) || /^pypy(?:\d+)?$/.test(runtime) ||
    NON_JS_INLINE_EVAL_RUNTIMES.has(runtime);
}

function nonJavaScriptRuntimeName(runtime) {
  if (/^php\d+(?:\.\d+)*$/.test(runtime)) return 'php';
  if (/^ruby\d+(?:\.\d+)*$/.test(runtime)) return 'ruby';
  if (/^perl\d+(?:\.\d+)*$/.test(runtime)) return 'perl';
  if (/^lua\d+(?:\.\d+)*$/.test(runtime)) return 'lua';
  if (/^luajit\d+(?:\.\d+)*$/.test(runtime)) return 'luajit';
  return runtime;
}

function unsupportedNonJavaScriptRuntimeOption(runtime, value) {
  runtime = nonJavaScriptRuntimeName(runtime);
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(runtime) || /^pypy(?:\d+)?$/.test(runtime)) {
    return value === '-c' || value.startsWith('-c') || value === '-m' || value.startsWith('-m') ||
      value === '-h' || value === '--help' || value === '-V' || value === '--version';
  }
  if (runtime === 'php') {
    return value === '-r' || value.startsWith('-r') ||
      value === '-B' || value.startsWith('-B') ||
      value === '-R' || value.startsWith('-R') ||
      value === '-E' || value.startsWith('-E') ||
      value === '-d' || value.startsWith('-d') ||
      value === '-c' || value.startsWith('-c') ||
      value === '-l' || value.startsWith('-l') ||
      value === '-?' ||
      value === '-a' || value.startsWith('-a') ||
      value === '-h' || value.startsWith('-h') ||
      value === '-i' || value.startsWith('-i') ||
      value === '-m' || value.startsWith('-m') ||
      value === '-s' || value.startsWith('-s') ||
      value === '-w' || value.startsWith('-w') ||
      unsupportedPhpLongRuntimeOption(value) ||
      value === '-v' || value === '--version' ||
      value === '-S' || value.startsWith('-S');
  }
  if (runtime === 'lua' || runtime === 'luajit') {
    return value === '-e' || value.startsWith('-e') || value === '-l' || value.startsWith('-l') ||
      value === '-v' || value === '--version' || value === '-h' || value === '--help' || value === '-';
  }
  if (runtime === 'ruby' || runtime === 'rscript') {
    return value === '-e' || value.startsWith('-e') || value === '--eval' || value.startsWith('--eval=') ||
      value === '-r' || value.startsWith('-r') ||
      (runtime === 'ruby' && (value === '-' || value === '-c' || value.startsWith('-c') || value === '-v' || value === '--version' || value === '-h' || value === '--help')) ||
      (runtime === 'rscript' && (value === '--version' || value === '--help' || value === '-'));
  }
  if (runtime === 'perl') {
    return value === '-' || value === '-e' || value.startsWith('-e') || value === '--eval' || value.startsWith('--eval=') ||
      value === '-m' || value.startsWith('-m') || value === '-M' || value.startsWith('-M') ||
      value === '-c' || value.startsWith('-c') || value === '-d' || value.startsWith('-d') ||
      value === '-v' || value.startsWith('-V') || value === '-h' || value === '--help';
  }
  return value === '-e' || value.startsWith('-e') || value === '--eval' || value.startsWith('--eval=');
}

function unsupportedPhpLongRuntimeOption(value) {
  const option = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
  return [
    '--help',
    '--info',
    '--ini',
    '--interactive',
    '--modules',
    '--ri',
    '--rc',
    '--re',
    '--rf',
    '--rz',
    '--strip',
    '--syntax-highlight',
  ].includes(option);
}

function nonJavaScriptRuntimeOptionConsumesNext(runtime, value) {
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(runtime) || /^pypy(?:\d+)?$/.test(runtime)) {
    return value === '-W' || value === '-X';
  }
  return false;
}

function unsupportedDenoPermissionOption(value) {
  const option = value.includes('=') ? value.slice(0, value.indexOf('=')) : value;
  return option === '-A' || option === '-E' || option === '-F' || option === '-N' ||
    option === '-P' || option === '-R' || option === '-S' || option === '-W' ||
    option === '--allow-all' || option === '--permission-set' || option.startsWith('--allow-');
}

function unsupportedDenoTlsOption(value) {
  return value === '--unsafely-ignore-certificate-errors' || value.startsWith('--unsafely-ignore-certificate-errors=');
}

function denoOptionConsumesNext(value) {
  return DENO_OPTION_VALUE_OPTIONS.has(value);
}

function denoOptionValuePosition(argv, index) {
  return DENO_OPTION_VALUE_OPTIONS.has(argv[index - 1]);
}

function denoInlineOptionValue(value) {
  if (value.startsWith('-c') && value !== '-c' && !value.startsWith('--')) return true;
  const separator = value.indexOf('=');
  if (separator < 0) return false;
  return DENO_OPTION_INLINE_VALUE_OPTIONS.has(value.slice(0, separator));
}

function denoConfigOption(value) {
  return value === '--config' || value.startsWith('--config=') ||
    value === '--config-file' || value.startsWith('--config-file=') ||
    value === '-c' || value.startsWith('-c=') ||
    (value.startsWith('-c') && value !== '-c' && !value.startsWith('--'));
}

function assertLocalDenoEntrypoint(value) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Deno sidecars require local entrypoints');
  }
}

function bareScriptEntrypoint(value) {
  if (value.includes('/') || value.includes('\\')) return false;
  return /\.(?:cjs|cts|js|jsx|mjs|mts|py|rb|sh|ts|tsx)$/.test(value.toLowerCase());
}

function pathQualifiedJavaScriptEntrypoint(value) {
  if (!value.includes('/') && !value.includes('\\')) return false;
  return /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(value.toLowerCase());
}

function commandBaseName(value) {
  return value.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}

function pathQualifiedSidecarRuntime(value) {
  if (!value.includes('/') && !value.includes('\\')) return false;
  if (!JS_RUNTIMES.has(commandBaseName(value))) return false;
  return path.resolve(value) !== path.resolve(process.execPath);
}

function bunShebangEntrypoint(value) {
  return javascriptRuntimeShebangRuntime(value) === 'bun';
}

function javascriptRuntimeShebangEntrypoint(value) {
  return javascriptRuntimeShebangRuntime(value) != null;
}

function javascriptRuntimeShebangRuntime(value) {
  if (!value.includes('/') && !value.includes('\\')) return null;
  const firstLine = shebangFirstLine(value);
  if (!firstLine) return null;
  return shebangRuntimeTokens(firstLine)
    .map((token) => commandBaseName(token))
    .find((runtime) => JS_RUNTIMES.has(runtime)) ?? null;
}

function bunShebangRuntimeArgs(value) {
  if (!value.includes('/') && !value.includes('\\')) return null;
  const firstLine = shebangFirstLine(value);
  if (!firstLine) return null;
  const tokens = shebangRuntimeTokens(firstLine);
  const bunIndex = tokens.findIndex((token) => commandBaseName(token) === 'bun');
  return bunIndex < 0 ? null : tokens.slice(bunIndex + 1);
}

function nonJavaScriptShebangRuntimeArgv(value) {
  if (!value.includes('/') && !value.includes('\\')) return null;
  const firstLine = shebangFirstLine(value);
  if (!firstLine) return null;
  const tokens = shebangRuntimeTokens(firstLine);
  const runtimeIndex = tokens.findIndex((token) => nonJavaScriptRuntimeSupportsInlineEval(commandBaseName(token)));
  return runtimeIndex < 0 ? null : tokens.slice(runtimeIndex);
}

function shebangFirstLine(value) {
  let fd;
  try {
    const bytes = Buffer.alloc(256);
    fd = openSync(value, 'r');
    const bytesRead = readSync(fd, bytes, 0, bytes.byteLength, 0);
    const firstLine = bytes.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
    return firstLine.startsWith('#!') ? firstLine : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function shebangRuntimeTokens(firstLine) {
  const body = firstLine.slice(2).trim();
  if (/["'\\]/.test(body)) {
    fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar shebang arguments must not use quotes or escapes');
  }
  return expandEnvSplitStringTokens(body.split(/\s+/).filter(Boolean));
}

function expandEnvSplitStringTokens(tokens) {
  if (commandBaseName(tokens[0] ?? '') !== 'env') return tokens;
  const splitOption = tokens[1] ?? '';
  if (splitOption === '-S') return tokens;
  if (splitOption === '--split-string') return [tokens[0], '-S', ...tokens.slice(2)];
  if (splitOption.startsWith('-S') && splitOption !== '-S') {
    return [tokens[0], '-S', ...splitEnvString(splitOption.slice(2)), ...tokens.slice(2)];
  }
  if (splitOption.startsWith('--split-string=')) {
    return [tokens[0], '-S', ...splitEnvString(splitOption.slice('--split-string='.length)), ...tokens.slice(2)];
  }
  return tokens;
}

function pathResolvedJavaScriptRuntimeShebang(value, searchPath, cwd = undefined) {
  if (value.includes('/') || value.includes('\\')) return false;
  const resolved = resolvePathCommand(value, searchPath, cwd);
  return resolved ? javascriptRuntimeShebangRuntime(resolved) : null;
}

function resolvePathCommand(value, searchPath, cwd = undefined) {
  if (!value || value.includes('\0') || value.includes('/') || value.includes('\\')) return null;
  for (const directory of String(searchPath ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const searchDirectory = path.isAbsolute(directory) ? directory : path.resolve(cwd ?? process.cwd(), directory);
    const candidate = path.join(searchDirectory, value);
    try {
      const fd = openSync(candidate, 'r');
      closeSync(fd);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function sidecarEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ERR_CAPABILITY_SIDECAR_ENV_INVALID');
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) fail('ERR_CAPABILITY_SIDECAR_ENV_INVALID');
    if (typeof child !== 'string') fail('ERR_CAPABILITY_SIDECAR_ENV_INVALID');
    return [key, child];
  })));
}

function sidecarUserEnv(value) {
  const env = sidecarEnv(value);
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') fail('ERR_CAPABILITY_SIDECAR_ENV_INVALID', 'sidecar environment must not override PATH');
    if (unsupportedSidecarPreloadEnvKey(key)) {
      fail('ERR_CAPABILITY_SIDECAR_ENV_INVALID', 'sidecar environment must not set runtime preload options');
    }
  }
  return env;
}

function unsupportedSidecarPreloadEnvKey(key) {
  const normalized = key.toUpperCase();
  return normalized === 'NODE_OPTIONS' ||
    normalized === 'RUBYOPT' ||
    normalized === 'PERL5OPT' ||
    normalized === 'PYTHONPATH' ||
    normalized === 'PYTHONHOME' ||
    normalized === 'PYTHONUSERBASE' ||
    normalized === 'PYTHONSTARTUP' ||
    normalized === 'LUA_INIT' ||
    normalized.startsWith('LUA_INIT_') ||
    normalized === 'PHPRC' ||
    normalized === 'PHP_INI_SCAN_DIR' ||
    normalized === 'R_PROFILE' ||
    normalized === 'R_PROFILE_USER' ||
    normalized === 'R_ENVIRON' ||
    normalized === 'R_ENVIRON_USER';
}

function sidecarPath() {
  const value = process.env.PATH;
  if (typeof value === 'string' && value.length > 0 && !value.includes('\0')) return value;
  return DEFAULT_SIDECAR_PATH;
}

function encodeBytes(value) {
  if (typeof value === 'bigint') return sidecarBigIntString(value);
  if (value instanceof Uint8Array) {
    return {
      [BYTES_SENTINEL_KEY]: BYTES_SENTINEL_VALUE,
      [BYTES_SENTINEL_PAYLOAD]: Buffer.from(value).toString('base64'),
    };
  }
  if (Array.isArray(value)) return value.map(encodeBytes);
  if (value instanceof Set) return [...value].map(encodeBytes);
  if (value instanceof Map) {
    const encoded = Object.fromEntries([...value.entries()].map(([key, child], index) => [
      typeof key === 'string' ? key : `map:${index}`,
      encodeBytes(child),
    ]));
    if (reservedSidecarObject(encoded)) {
      return {
        [BYTES_SENTINEL_KEY]: OBJECT_SENTINEL_VALUE,
        [OBJECT_SENTINEL_PAYLOAD]: encoded,
      };
    }
    return encoded;
  }
  if (!value || typeof value !== 'object') return value;
  const encoded = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encodeBytes(child)]));
  if (reservedSidecarObject(value)) {
    return {
      [BYTES_SENTINEL_KEY]: OBJECT_SENTINEL_VALUE,
      [OBJECT_SENTINEL_PAYLOAD]: encoded,
    };
  }
  return encoded;
}

function sidecarBigIntString(value) {
  const sign = value < 0n ? '-' : '';
  const magnitude = value < 0n ? -value : value;
  return `${sign}0x${magnitude.toString(16)}`;
}

function decodeBytes(value) {
  if (newBytesSentinel(value)) return Uint8Array.from(Buffer.from(value[BYTES_SENTINEL_PAYLOAD], 'base64'));
  if (legacyBytesSentinel(value)) return Uint8Array.from(Buffer.from(value[LEGACY_BYTES_KEY], 'base64'));
  if (escapedObjectSentinel(value)) return decodeEscapedObject(value[OBJECT_SENTINEL_PAYLOAD]);
  if (Array.isArray(value)) return value.map(decodeBytes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeBytes(child)]));
}

function reservedSidecarObject(value) {
  return Object.hasOwn(value, LEGACY_BYTES_KEY) || Object.hasOwn(value, BYTES_SENTINEL_KEY);
}

function newBytesSentinel(value) {
  return exactObjectKeys(value, [BYTES_SENTINEL_KEY, BYTES_SENTINEL_PAYLOAD])
    && value[BYTES_SENTINEL_KEY] === BYTES_SENTINEL_VALUE
    && typeof value[BYTES_SENTINEL_PAYLOAD] === 'string';
}

function legacyBytesSentinel(value) {
  return exactObjectKeys(value, [LEGACY_BYTES_KEY]) && typeof value[LEGACY_BYTES_KEY] === 'string';
}

function escapedObjectSentinel(value) {
  return exactObjectKeys(value, [BYTES_SENTINEL_KEY, OBJECT_SENTINEL_PAYLOAD])
    && value[BYTES_SENTINEL_KEY] === OBJECT_SENTINEL_VALUE;
}

function decodeEscapedObject(value) {
  if (Array.isArray(value)) return value.map(decodeBytes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeBytes(child)]));
}

function exactObjectKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function concat(left, right) {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

if (process.argv[2] === SIDECAR_SYNC_HELPER_ARG && process.argv[1] === fileURLToPath(import.meta.url)) {
  await runSidecarSyncHelper();
}
