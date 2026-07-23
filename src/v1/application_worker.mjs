import { assertBytes, fail } from './errors.mjs';
import {
  APPLICATION_ABI_VERSION,
  DEFAULT_ADMISSION_LIMITS,
  FrameStatus,
  decodeApplicationManifest,
  decodeFrame,
  decodeStepInput,
  validateEffectResultForRequest,
} from './protocol.mjs';
import { inspectApplicationWasm } from './wasm_module.mjs';

export const ApplicationWasmStatus = Object.freeze({
  success: 0,
  malformedInput: 1,
  applicationMismatch: 2,
  stateValidation: 3,
  effectResultValidation: 4,
  yieldedFuel: 5,
  resourceLimit: 6,
  deterministicFailure: 7,
});

const producingStatuses = new Set([
  ApplicationWasmStatus.success,
  ApplicationWasmStatus.yieldedFuel,
]);

const requiredExports = Object.freeze([
  'memory',
  'world_abi_version',
  'world_manifest_ptr',
  'world_manifest_len',
  'world_input_ptr',
  'world_input_capacity',
  'world_step',
  'world_output_ptr',
  'world_output_len',
  'world_error_ptr',
  'world_error_len',
  'world_reset',
]);

const textDecoder = new TextDecoder('utf-8', { fatal: false });

/// Disposable host adapter for one application-specific World WASM module.
/// The instance owns scratch buffers only; every semantic continuation enters
/// and leaves as canonical Frame bytes.
export class ApplicationWorker {
  constructor({
    admissionLimits = DEFAULT_ADMISSION_LIMITS,
    maximumMemoryBytes = 256 * 1024 * 1024,
  } = {}) {
    if (!Number.isSafeInteger(maximumMemoryBytes) || maximumMemoryBytes <= 0) {
      fail('ERR_APPLICATION_V1_HOST_MEMORY_LIMIT');
    }
    this.admissionLimits = admissionLimits;
    this.maximumMemoryBytes = maximumMemoryBytes;
    this.module = null;
    this.instance = null;
    this.memory = null;
    this.manifest = null;
    this.moduleInspection = null;
    this.disposed = false;
  }

  async instantiate(wasmBytes) {
    this.#assertLive();
    if (this.instance !== null) fail('ERR_APPLICATION_V1_WORKER_ALREADY_INSTANTIATED');
    const bytes = Buffer.from(assertBytes(wasmBytes, 'wasmBytes'));
    const inspection = inspectApplicationWasm(bytes);
    if (inspection.memory.maximumBytes > this.maximumMemoryBytes) {
      fail('ERR_APPLICATION_V1_HOST_MEMORY_LIMIT', `application declares ${inspection.memory.maximumBytes} bytes`);
    }

    let module;
    try {
      module = await WebAssembly.compile(bytes);
    } catch (error) {
      fail('ERR_APPLICATION_V1_WASM_COMPILE', error instanceof Error ? error.message : String(error));
    }
    const imports = WebAssembly.Module.imports(module);
    if (imports.length !== 0) fail('ERR_APPLICATION_V1_WASM_IMPORTS_FORBIDDEN');
    const declaredExports = new Map(WebAssembly.Module.exports(module).map((entry) => [entry.name, entry.kind]));
    for (const name of requiredExports) {
      const expectedKind = name === 'memory' ? 'memory' : 'function';
      if (declaredExports.get(name) !== expectedKind) fail('ERR_APPLICATION_V1_WASM_EXPORT_MISSING', name);
    }

    let instance;
    try {
      instance = await WebAssembly.instantiate(module, {});
    } catch (error) {
      fail('ERR_APPLICATION_V1_WASM_INSTANTIATE', error instanceof Error ? error.message : String(error));
    }
    if (!(instance.exports.memory instanceof WebAssembly.Memory)) fail('ERR_APPLICATION_V1_WASM_MEMORY_MISSING');

    this.module = module;
    this.instance = instance;
    this.memory = instance.exports.memory;
    this.moduleInspection = inspection;
    try {
      if (this.#callU32('world_abi_version') !== APPLICATION_ABI_VERSION) fail('ERR_APPLICATION_V1_WASM_ABI_VERSION');
      if (this.memory.buffer.byteLength !== inspection.memory.minimumBytes) {
        fail('ERR_APPLICATION_V1_WASM_MEMORY_INITIAL');
      }
      const manifestBytes = this.#copyRegion(
        this.#callU32('world_manifest_ptr'),
        this.#callU32('world_manifest_len'),
        'manifest',
      );
      this.manifest = decodeApplicationManifest(manifestBytes, this.admissionLimits);
      if (this.manifest.worldApplicationAbiVersion !== APPLICATION_ABI_VERSION) fail('ERR_APPLICATION_V1_WASM_ABI_VERSION');
      const inputPointer = this.#callU32('world_input_ptr');
      const inputCapacity = this.#callU32('world_input_capacity');
      if (inputCapacity === 0) fail('ERR_APPLICATION_V1_WASM_INPUT_REGION');
      this.#assertRegion(inputPointer, inputCapacity, 'input');
    } catch (error) {
      this.#clearInstance();
      throw error;
    }

    return Object.freeze({
      kind: 'world-host.application-worker-v1',
      abiVersion: APPLICATION_ABI_VERSION,
      applicationId: Buffer.from(this.manifest.applicationId),
      applicationName: this.manifest.applicationName,
      applicationVersion: this.manifest.applicationVersion,
      wasmByteLength: bytes.length,
      importCount: imports.length,
      initialMemoryBytes: inspection.memory.minimumBytes,
      maximumMemoryBytes: inspection.memory.maximumBytes,
      inputCapacity: this.#callU32('world_input_capacity'),
      semanticStateRetained: false,
    });
  }

  readManifest() {
    this.#assertInstantiated();
    return decodeApplicationManifest(this.manifest.encodedBytes, this.admissionLimits);
  }

  step(stepInputBytes) {
    this.#assertInstantiated();
    const bytes = Buffer.from(assertBytes(stepInputBytes, 'stepInputBytes'));
    const input = decodeStepInput(bytes, this.manifest.limits);
    if (!sameBytes(input.applicationId, this.manifest.applicationId)) fail('ERR_APPLICATION_V1_APPLICATION_MISMATCH');
    const prior = input.priorFrameBytes === null ? null : decodeFrame(input.priorFrameBytes, this.manifest.limits);
    if (prior !== null) {
      if (!sameBytes(prior.applicationId, this.manifest.applicationId) ||
          !sameBytes(prior.frameId, input.expectedParentFrameId)) {
        fail('ERR_APPLICATION_V1_PARENT_MISMATCH');
      }
      if (prior.status !== FrameStatus.needsEffect && prior.status !== FrameStatus.yieldedFuel) {
        fail('ERR_APPLICATION_V1_TERMINAL_FRAME');
      }
      if (prior.status === FrameStatus.needsEffect) {
        if (input.effectResult === null) fail('ERR_APPLICATION_V1_EFFECT_RESULT_REQUIRED');
        validateEffectResultForRequest(prior.pendingEffect, input.effectResult, this.manifest.limits);
      } else if (input.effectResult !== null) {
        fail('ERR_APPLICATION_V1_UNEXPECTED_RESULT');
      }
    }

    const inputCapacity = this.#callU32('world_input_capacity');
    if (bytes.length === 0 || bytes.length > inputCapacity) fail('ERR_APPLICATION_V1_WASM_INPUT_LIMIT');
    const inputPointer = this.#callU32('world_input_ptr');
    this.#assertRegion(inputPointer, bytes.length, 'input');
    new Uint8Array(this.memory.buffer, inputPointer, bytes.length).set(bytes);

    const status = this.#callU32('world_step', bytes.length);
    if (!producingStatuses.has(status)) {
      const outputLength = this.#callU32('world_output_len');
      if (outputLength !== 0) fail('ERR_APPLICATION_V1_WASM_PARTIAL_OUTPUT', `status=${status}`);
      fail('ERR_APPLICATION_V1_STEP_FAILED', this.readLastError() || `status=${status}`, { status });
    }
    const frameBytes = this.#copyRegion(
      this.#callU32('world_output_ptr'),
      this.#callU32('world_output_len'),
      'output',
    );
    if (frameBytes.length === 0) fail('ERR_APPLICATION_V1_WASM_OUTPUT_MISSING');
    const frame = decodeFrame(frameBytes, this.manifest.limits);
    this.#validateCausalOutput(input, prior, frame, status);
    return Object.freeze({ status, frameBytes, frame });
  }

  reset() {
    this.#assertInstantiated();
    const status = this.#callU32('world_reset');
    if (status !== ApplicationWasmStatus.success) {
      fail('ERR_APPLICATION_V1_RESET_FAILED', this.readLastError() || `status=${status}`, { status });
    }
  }

  readLastError() {
    this.#assertInstantiated();
    const length = this.#callU32('world_error_len');
    if (length === 0) return '';
    return textDecoder.decode(this.#copyRegion(this.#callU32('world_error_ptr'), length, 'error'));
  }

  dispose() {
    this.#clearInstance();
    this.disposed = true;
  }

  #validateCausalOutput(input, prior, frame, status) {
    if (!sameBytes(frame.applicationId, this.manifest.applicationId)) fail('ERR_APPLICATION_V1_APPLICATION_MISMATCH');
    if (prior === null) {
      if (frame.sequence !== 0n || frame.parentFrameId !== null) fail('ERR_APPLICATION_V1_GENESIS_FRAME');
    } else {
      if (frame.sequence !== prior.sequence + 1n || !sameBytes(frame.parentFrameId, prior.frameId)) {
        fail('ERR_APPLICATION_V1_CHILD_FRAME');
      }
      if (prior.status === FrameStatus.needsEffect) {
        if (input.effectResult === null || !sameBytes(frame.acceptedEffectResultId, input.effectResult.resultId)) {
          fail('ERR_APPLICATION_V1_ACCEPTED_RESULT');
        }
      } else if (input.effectResult !== null || frame.acceptedEffectResultId !== null) {
        fail('ERR_APPLICATION_V1_UNEXPECTED_RESULT');
      }
    }
    if ((status === ApplicationWasmStatus.yieldedFuel) !== (frame.status === FrameStatus.yieldedFuel)) {
      fail('ERR_APPLICATION_V1_WASM_STATUS_FRAME_MISMATCH');
    }
  }

  #copyRegion(pointer, length, label) {
    this.#assertRegion(pointer, length, label);
    return Buffer.from(new Uint8Array(this.memory.buffer, pointer, length));
  }

  #assertRegion(pointer, length, label) {
    const end = pointer + length;
    if (!Number.isSafeInteger(pointer) || !Number.isSafeInteger(length) || pointer < 0 || length < 0 ||
        !Number.isSafeInteger(end) || end > this.memory.buffer.byteLength) {
      fail('ERR_APPLICATION_V1_WASM_REGION', `${label} region is out of bounds`);
    }
  }

  #callU32(name, ...args) {
    const fn = this.instance?.exports?.[name];
    if (typeof fn !== 'function') fail('ERR_APPLICATION_V1_WASM_EXPORT_MISSING', name);
    let value;
    try {
      value = fn(...args);
    } catch (error) {
      fail('ERR_APPLICATION_V1_WASM_TRAP', `${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Number.isInteger(value)) fail('ERR_APPLICATION_V1_WASM_ABI_VALUE', name);
    return value >>> 0;
  }

  #assertLive() {
    if (this.disposed) fail('ERR_APPLICATION_V1_WORKER_DISPOSED');
  }

  #assertInstantiated() {
    this.#assertLive();
    if (this.instance === null || this.memory === null || this.manifest === null) {
      fail('ERR_APPLICATION_V1_WORKER_NOT_INSTANTIATED');
    }
  }

  #clearInstance() {
    this.module = null;
    this.instance = null;
    this.memory = null;
    this.manifest = null;
    this.moduleInspection = null;
  }
}

function sameBytes(left, right) {
  return left !== null && right !== null && Buffer.from(left).equals(Buffer.from(right));
}
