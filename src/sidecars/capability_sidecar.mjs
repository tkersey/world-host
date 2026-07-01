import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

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

export class CapabilitySidecar {
  constructor({ command, timeoutMs = 5000, maximumFrameBytes = 1024 * 1024, env = {} } = {}) {
    if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== 'string' || item.length === 0)) {
      fail('ERR_CAPABILITY_SIDECAR_COMMAND_INVALID', 'sidecar command must be an argv array');
    }
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.maximumFrameBytes = maximumFrameBytes;
    this.env = sidecarEnv(env);
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
  constructor({ command, vectors = [] } = {}) {
    this.command = command;
    this.vectors = Object.freeze([...vectors]);
    Object.freeze(this);
  }

  async run() {
    const sidecar = new CapabilitySidecar({ command: this.command });
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

async function runSidecarCommand({ argv, input, timeoutMs, maximumFrameBytes, env }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env,
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

function sidecarEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ERR_CAPABILITY_SIDECAR_ENV_INVALID');
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) fail('ERR_CAPABILITY_SIDECAR_ENV_INVALID');
    if (typeof child !== 'string') fail('ERR_CAPABILITY_SIDECAR_ENV_INVALID');
    return [key, child];
  })));
}

function encodeBytes(value) {
  if (value instanceof Uint8Array) return { __bytes: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeBytes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encodeBytes(child)]));
}

function decodeBytes(value) {
  if (value && typeof value === 'object' && typeof value.__bytes === 'string') return Uint8Array.from(Buffer.from(value.__bytes, 'base64'));
  if (Array.isArray(value)) return value.map(decodeBytes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeBytes(child)]));
}

function concat(left, right) {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}
