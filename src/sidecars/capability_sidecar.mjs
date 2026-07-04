import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

import { assertBytes, fail, fromUtf8 } from '../core/store.mjs';

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

export class CapabilitySidecar {
  constructor({ command, cwd = null, timeoutMs = 5000, maximumFrameBytes = 1024 * 1024, env = {} } = {}) {
    if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== 'string' || item.length === 0)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar command must be an argv array');
    }
    if (cwd != null && (typeof cwd !== 'string' || cwd.length === 0)) {
      fail('ERR_CAPABILITY_SIDECAR_CWD_INVALID', 'sidecar cwd must be a path string');
    }
    if (bareScriptEntrypoint(command[0])) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar script entrypoints must be path-qualified');
    }
    if (pathQualifiedJavaScriptEntrypoint(command[0])) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar JavaScript entrypoints must use an explicit runtime command');
    }
    if (pathResolvedBunShebangEntrypoint(command[0], env.PATH ?? sidecarPath())) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar Bun shebang entrypoints must be path-qualified');
    }
    this.command = command;
    this.cwd = cwd == null ? undefined : path.resolve(cwd);
    this.timeoutMs = timeoutMs;
    this.maximumFrameBytes = maximumFrameBytes;
    this.env = sidecarEnv({ PATH: sidecarPath(), ...env });
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

  manifest() {
    return this.request(CapabilitySidecarCommand.manifest);
  }

  preflight(payload) {
    return this.request(CapabilitySidecarCommand.preflight, payload);
  }

  resolve(payload) {
    return this.request(CapabilitySidecarCommand.resolve, payload);
  }

  recover(payload) {
    return this.request(CapabilitySidecarCommand.recover, payload);
  }

  dryRun(payload) {
    return this.request(CapabilitySidecarCommand.dryRun, payload);
  }

  shadow(payload) {
    return this.request(CapabilitySidecarCommand.shadow, payload);
  }
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
    return Object.freeze({
      manifest,
      vectorCount: this.vectors.length,
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
    const spawnArgv = sidecarSpawnArgv(argv, cwd);
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

function sidecarSpawnArgv(argv, cwd = undefined) {
  const emptyEnvFileArg = `--env-file=${EMPTY_BUN_ENV_FILE}`;
  const emptyConfigArg = `--config=${EMPTY_BUN_CONFIG_FILE}`;
  if (commandBaseName(argv[0]) !== 'bun') {
    const bunShebangArgs = bunShebangRuntimeArgs(commandInspectionPath(argv[0], cwd));
    if (bunShebangArgs) {
      const shebangArgv = ['bun', ...bunShebangArgs, ...argv];
      assertSupportedBunEnvFileOptions(shebangArgv);
      const isolationArgs = [];
      if (!bunEnvFileOptionPresent(shebangArgv)) isolationArgs.push(emptyEnvFileArg);
      if (!bunConfigOptionPresent(shebangArgv)) isolationArgs.push(emptyConfigArg);
      return [process.execPath, ...isolationArgs, ...bunShebangArgs, ...argv];
    }
    return argv;
  }
  assertSupportedBunEnvFileOptions(argv);
  const isolationArgs = [];
  if (!bunEnvFileOptionPresent(argv)) isolationArgs.push(emptyEnvFileArg);
  if (!bunConfigOptionPresent(argv)) isolationArgs.push(emptyConfigArg);
  return [argv[0], ...isolationArgs, ...argv.slice(1)];
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
    if (value === '--cwd' || value.startsWith('--cwd=')) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support --cwd');
    }
    if (value === '--no-config' || value.startsWith('--no-config=')) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support --no-config');
    }
    if (unsupportedBunConfigOption(value)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars only support --config=... for config isolation');
    }
    if (bunRuntimeOptionValuePosition(argv, index)) continue;
    if (value === 'run') {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support package script commands');
    }
    if (value === '--env-file-if-exists' || value.startsWith('--env-file-if-exists=')) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'Bun sidecars do not support --env-file-if-exists');
    }
    if (value === '--') return;
    if (!value.startsWith('-')) entrypointSeen = true;
  }
}

function bunEnvFileOptionPresent(argv) {
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (bunRuntimeOptionValuePosition(argv, index)) continue;
    if (value === '--env-file' || value.startsWith('--env-file=')) return true;
    if (!value.startsWith('-') || value === '--') return false;
  }
  return false;
}

function bunConfigOptionPresent(argv) {
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (bunRuntimeOptionValuePosition(argv, index)) continue;
    if (value.startsWith('--config=')) return true;
    if (!value.startsWith('-') || value === '--') return false;
  }
  return false;
}

function unsupportedBunConfigOption(value) {
  return value === '--config' || value === '--config-file' || value.startsWith('--config-file=') ||
    value === '-c' || value.startsWith('-c=') || (value.startsWith('-c') && value !== '-c');
}

function bunRuntimeOptionValuePosition(argv, index) {
  const previous = argv[index - 1];
  return typeof previous === 'string' && BUN_RUNTIME_VALUE_OPTIONS.has(previous);
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

function bunShebangEntrypoint(value) {
  if (!value.includes('/') && !value.includes('\\')) return false;
  const firstLine = shebangFirstLine(value);
  if (!firstLine) return false;
  return shebangTokens(firstLine).some((token) => commandBaseName(token) === 'bun');
}

function bunShebangRuntimeArgs(value) {
  if (!value.includes('/') && !value.includes('\\')) return null;
  const firstLine = shebangFirstLine(value);
  if (!firstLine) return null;
  const tokens = shebangTokens(firstLine);
  const bunIndex = tokens.findIndex((token) => commandBaseName(token) === 'bun');
  return bunIndex < 0 ? null : tokens.slice(bunIndex + 1);
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

function shebangTokens(firstLine) {
  const body = firstLine.slice(2).trim();
  if (/["'\\]/.test(body)) {
    fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar Bun shebang arguments must not use quotes or escapes');
  }
  return body.split(/\s+/).filter(Boolean);
}

function pathResolvedBunShebangEntrypoint(value, searchPath) {
  if (value.includes('/') || value.includes('\\')) return false;
  const resolved = resolvePathCommand(value, searchPath);
  return resolved ? bunShebangEntrypoint(resolved) : false;
}

function resolvePathCommand(value, searchPath) {
  if (!value || value.includes('\0') || value.includes('/') || value.includes('\\')) return null;
  for (const directory of String(searchPath ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, value);
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

function sidecarPath() {
  const value = process.env.PATH;
  if (typeof value === 'string' && value.length > 0 && !value.includes('\0')) return value;
  return DEFAULT_SIDECAR_PATH;
}

function encodeBytes(value) {
  if (value instanceof Uint8Array) {
    return {
      [BYTES_SENTINEL_KEY]: BYTES_SENTINEL_VALUE,
      [BYTES_SENTINEL_PAYLOAD]: Buffer.from(value).toString('base64'),
    };
  }
  if (Array.isArray(value)) return value.map(encodeBytes);
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
