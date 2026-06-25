import { WorldWorker } from '../core/worker.mjs';
import { assertBytes, fail } from '../core/store.mjs';
import { decodeApplianceManifest, decodeRuntimeManifest } from '../protocol/world_appliance_wire_codec.mjs';
import { carrierManifest } from '../protocol/world_manifest.mjs';

export const applianceStatus = Object.freeze({
  ok: 0,
  needsHost: 2,
  completed: 3,
  invalidCommand: 7,
});

const textDecoder = new TextDecoder();

export class NodeWorldWorker extends WorldWorker {
  constructor() {
    super();
    this.module = null;
    this.instance = null;
    this.memory = null;
    this.lastSubmitStatus = null;
  }

  async instantiate(wasmBytes) {
    const bytes = assertBytes(wasmBytes, 'wasmBytes');
    const module = await WebAssembly.compile(bytes);
    const imports = WebAssembly.Module.imports(module);
    if (imports.length !== 0) fail('ERR_WORLD_WASM_IMPORTS_FORBIDDEN');
    this.module = module;
    this.instance = await WebAssembly.instantiate(module, {});
    this.memory = this.instance.exports.memory ?? null;
    this.#requireExport('world_appliance_abi_version');
    const abiVersion = this.instance.exports.world_appliance_abi_version();
    if (`v${abiVersion}` !== carrierManifest.applianceAbiVersion) {
      fail('ERR_WORLD_WASM_ABI_VERSION_MISMATCH', `expected ${carrierManifest.applianceAbiVersion}, got v${abiVersion}`);
    }
    this.runtimeManifest = Object.freeze({
      kind: 'world-host.node-world-worker',
      wasmByteLength: bytes.byteLength,
      importCount: imports.length,
      abiVersion: `v${abiVersion}`,
      runtimeManifestText: this.#readRuntimeManifestText(),
      runtimeProfile: decodeRuntimeManifest(this.#readRuntimeManifestText()),
      memoryPages: this.memory?.buffer?.byteLength ? this.memory.buffer.byteLength / 65536 : 0,
      nativeHelperProcess: false,
      childProcessProtocolEncoding: false,
    });
    return this.runtimeManifest;
  }

  async loadExecutable(imageBytes) {
    this.#assertInstantiated();
    const bytes = assertBytes(imageBytes, 'imageBytes');
    const status = this.instance.exports.world_appliance_load_executable(this.#writeGuest(bytes), bytes.length);
    if (status !== applianceStatus.ok) {
      fail('ERR_WORLD_EXECUTABLE_LOAD_FAILED', this.readLastError() || `status=${status}`, { status });
    }
    await super.loadExecutable(bytes);
    return {
      executableImageFingerprint: this.loadedExecutableFingerprint,
      status,
    };
  }

  readApplianceManifest() {
    this.#assertInstantiated();
    const len = this.instance.exports.world_appliance_manifest_len();
    if (len === 0) fail('ERR_WORLD_APPLIANCE_MANIFEST_NOT_AVAILABLE');
    const bytes = this.#readExportedBytes('world_appliance_read_manifest', len);
    return Object.freeze({
      bytes,
      decoded: decodeApplianceManifest(bytes),
      evidenceAuthority: false,
    });
  }

  async submitTurn(turnInputBytes) {
    this.#assertInstantiated();
    const bytes = assertBytes(turnInputBytes, 'turnInputBytes');
    const status = this.instance.exports.world_appliance_submit_turn(this.#writeGuest(bytes), bytes.length);
    this.lastSubmitStatus = status;
    if (status !== applianceStatus.needsHost && status !== applianceStatus.completed) {
      fail('ERR_WORLD_TURN_SUBMIT_FAILED', this.readLastError() || `status=${status}`, { status });
    }
    this.lastTurnClosureBytes = this.#readClosureBytes();
    return {
      status,
      turnClosureBytes: new Uint8Array(this.lastTurnClosureBytes),
    };
  }

  readTurnClosure() {
    const bytes = super.readTurnClosure();
    return new Uint8Array(bytes);
  }

  reset() {
    this.#assertInstantiated();
    if (this.instance.exports.world_appliance_reset() !== applianceStatus.ok) {
      fail('ERR_WORLD_APPLIANCE_RESET_FAILED', this.readLastError());
    }
    super.reset();
    this.lastSubmitStatus = null;
  }

  unload() {
    this.#assertInstantiated();
    if (this.instance.exports.world_appliance_unload_executable() !== applianceStatus.ok) {
      fail('ERR_WORLD_EXECUTABLE_UNLOAD_FAILED', this.readLastError());
    }
    super.unload();
    this.lastSubmitStatus = null;
  }

  readLastError() {
    this.#assertInstantiated();
    const len = this.instance.exports.world_appliance_last_error_len();
    if (len === 0) return '';
    return this.#readGuestText(this.#readExportedBytes('world_appliance_read_last_error', len));
  }

  dispose() {
    this.module = null;
    this.instance = null;
    this.memory = null;
    this.lastSubmitStatus = null;
    super.dispose();
  }

  #readRuntimeManifestText() {
    const len = this.instance.exports.world_appliance_runtime_manifest_len();
    if (len === 0) fail('ERR_WORLD_RUNTIME_MANIFEST_NOT_AVAILABLE');
    return this.#readGuestText(this.#readExportedBytes('world_appliance_read_runtime_manifest', len));
  }

  #readClosureBytes() {
    const len = this.instance.exports.world_appliance_closure_len();
    if (len === 0) fail('ERR_TURN_CLOSURE_NOT_AVAILABLE');
    return this.#readExportedBytes('world_appliance_read_closure', len);
  }

  #readExportedBytes(exportName, len) {
    this.#requireExport(exportName);
    const ptr = this.#alloc(len);
    const copied = this.instance.exports[exportName](ptr, len);
    if (copied !== len) fail('ERR_WORLD_EXPORT_READ_FAILED', `${exportName} copied ${copied} of ${len}`);
    return new Uint8Array(this.memory.buffer, ptr, len).slice();
  }

  #writeGuest(bytes) {
    const ptr = this.#alloc(bytes.length);
    new Uint8Array(this.memory.buffer, ptr, bytes.length).set(bytes);
    return ptr;
  }

  #alloc(len) {
    this.#requireExport('world_appliance_alloc');
    const ptr = this.instance.exports.world_appliance_alloc(len);
    if (ptr === 0) fail('ERR_WORLD_GUEST_ALLOCATION_FAILED');
    return ptr;
  }

  #readGuestText(bytes) {
    return textDecoder.decode(bytes);
  }

  #assertInstantiated() {
    if (!this.instance || !this.memory) fail('ERR_WORKER_NOT_INSTANTIATED');
  }

  #requireExport(name) {
    if (typeof this.instance?.exports?.[name] !== 'function') {
      fail('ERR_WORLD_WASM_EXPORT_MISSING', name);
    }
  }
}
