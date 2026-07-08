#!/usr/bin/env bun
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { clearTimeout as clearHostTimeout, setTimeout as setHostTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';
import { inspect as inspectValue } from 'node:util';

import {
  assertCapabilityConformanceReceipt,
  assertCapabilityPackChecksums,
  validateCapabilityPackManifest,
} from '../src/core/capability_pack.mjs';
import { assertDriverManifest } from '../src/core/actuator.mjs';
import { assertCapabilityResolutionBoundary, assertNoWorldEvidenceKeys, defineCapabilityDriver } from '../src/core/capability_driver.mjs';
import { assertResolutionAccepted } from '../src/core/effect_journal.mjs';
import { fromUtf8, stableJson } from '../src/core/store.mjs';
import { CapabilitySidecar, CapabilitySidecarCommand } from '../src/sidecars/capability_sidecar.mjs';

const trustedExecuteAdapters = process.argv.includes('--trusted-execute-adapters');
const root = path.resolve('capability-packs');
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const PROBE_SETTLE_MS = 25;
let probeGlobalLock = Promise.resolve();
const names = (await readdir(root).catch(() => [])).filter((name) => name.startsWith('capability-pack-v0.2-')).sort();
if (!names.length) {
  console.error('no capability packs found');
  process.exit(1);
}

const results = [];
for (const name of names) {
  const packRoot = path.join(root, name);
  const manifest = JSON.parse(await readPackFile(packRoot, 'manifest.json', 'utf8'));
  if (!Array.isArray(manifest.checksums) || manifest.checksums.length === 0) throw new Error(`ERR_CAPABILITY_PACK_CHECKSUMS_REQUIRED:${name}`);
  const checked = await validateCapabilityPackManifest(manifest, { requirePackFingerprint: true, verifyFingerprint: true });
  const artifacts = {};
  for (const item of checked.checksums) artifacts[item.path] = new Uint8Array(await readPackFile(packRoot, item.path));
  await assertCapabilityPackChecksums(checked, artifacts);
  if (trustedExecuteAdapters) await assertAdapterManifestMatchesPack(checked, artifacts, name, packRoot);
  if (checked.conformanceCorpusFingerprint != null) {
    const receipt = JSON.parse(await readPackFile(packRoot, 'conformance.json', 'utf8'));
    assertCapabilityConformanceReceipt(receipt);
    if (receipt.packFingerprint !== checked.packFingerprint) throw new Error(`ERR_CAPABILITY_CONFORMANCE_PACK_FINGERPRINT:${name}`);
    if (receipt.driverId !== checked.driverId) throw new Error(`ERR_CAPABILITY_CONFORMANCE_DRIVER:${name}`);
    if (receipt.corpusFingerprint !== checked.conformanceCorpusFingerprint) throw new Error(`ERR_CAPABILITY_CONFORMANCE_CORPUS:${name}`);
  }
  results.push({
    pack: name,
    driverId: checked.driverId,
    packFingerprint: checked.packFingerprint,
    artifactCount: checked.checksums.length,
    trustedAdapterExecution: trustedExecuteAdapters,
  });
}

console.log(JSON.stringify({ capabilityPacks: results, status: 'passed' }, null, 2));

async function readPackFile(packRoot, relativePath, encoding = null) {
  const rootPath = await safePackRoot(packRoot);
  const target = path.resolve(packRoot, relativePath);
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_UNSAFE:${relativePath}`);
  if (!info.isFile()) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_MISSING:${relativePath}`);
  const actual = await realpath(target);
  if (!pathInside(rootPath, actual)) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_UNSAFE:${relativePath}`);
  return encoding ? await readFile(actual, encoding) : await readFile(actual);
}

async function safePackRoot(packRoot) {
  const normalizedRoot = path.resolve(packRoot);
  const info = await lstat(normalizedRoot);
  if (info.isSymbolicLink()) throw new Error(`ERR_CAPABILITY_PACK_ROOT_UNSAFE:${packRoot}`);
  if (!info.isDirectory()) throw new Error(`ERR_CAPABILITY_PACK_ROOT_INVALID:${packRoot}`);
  return await realpath(normalizedRoot);
}

function pathInside(rootPath, target) {
  const relative = path.relative(rootPath, target);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function assertAdapterManifestMatchesPack(packManifest, artifacts, name, packRoot) {
  await withDeterministicProbeNetwork(packManifest, null, async (probeNetwork) => {
    let driver;
    let sidecar = false;
    if (packManifest.adapter.kind === 'in_process') {
      const module = await withProbeTimeout('import', import(await adapterImportUrl(packManifest, artifacts)));
      await probeNetwork?.assertNoViolations();
      const Driver = module[packManifest.adapter.exportName];
      if (typeof Driver !== 'function') throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_EXPORT:${name}`);
      driver = new Driver(adapterOptions(packManifest));
      await probeNetwork?.assertNoViolations();
    } else if (packManifest.adapter.kind === 'sidecar') {
      if (externalEffectProbe(packManifest, null)) {
        throw new Error('ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED:network sidecar probes must not perform live external effects');
      }
      driver = new CapabilitySidecar({ command: packManifest.adapter.command, cwd: packRoot });
      sidecar = true;
    } else {
      return;
    }
    const capabilityDriver = defineCapabilityDriver(driver);
    if (packManifest.canRecover === true && typeof driver.recover !== 'function') throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_RECOVER:${name}`);
    const driverManifest = sidecar
      ? await withProbeTimeout('manifest', sidecarManifest(driver, packManifest))
      : capabilityDriver.manifest();
    await probeNetwork?.assertNoViolations();
    if (driverManifest.packFingerprint !== packManifest.packFingerprint) throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_MANIFEST_MISMATCH:${name}:packFingerprint`);
    for (const field of [
      'driverId',
      'supportedActuatorRefs',
      'supportedDescriptorFingerprints',
      'supportedActuationClasses',
      'supportedResponseStatuses',
      'recoveryClass',
      'maximumRequestBytes',
      'maximumResponseBytes',
      'authorityLabels',
    ]) {
      assertSameManifestField(name, field, packManifest[field], driverManifest[field]);
    }
    await assertAdapterProbeCommands(packManifest, capabilityDriver, driverManifest, { driver, sidecar, probeNetwork });
  });
}

async function sidecarManifest(sidecarDriver, packManifest) {
  const raw = await sidecarDriver.requestPayload(CapabilitySidecarCommand.manifest, { packFingerprint: packManifest.packFingerprint });
  const manifest = assertDriverManifest(raw);
  if (raw.packFingerprint != null && typeof raw.packFingerprint !== 'string') throw new Error('ERR_INVALID_DRIVER_MANIFEST:packFingerprint');
  return raw.packFingerprint == null ? manifest : Object.freeze({ ...manifest, packFingerprint: raw.packFingerprint });
}

async function assertAdapterProbeCommands(packManifest, capabilityDriver, driverManifest, { driver, sidecar = false, probeNetwork = null } = {}) {
  const hostRequest = sidecarProbeHostRequest(driverManifest);
  const policy = sidecarProbePolicy(driverManifest, hostRequest);
  const context = { worldHostCapabilityPackAbiProbe: true, policy };
  if (sidecar && externalEffectProbe(driverManifest, hostRequest)) {
    throw new Error('ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED:network sidecar probes must not perform live external effects');
  }
  probeNetwork?.setNetworkAllowed(networkEffectProbe(driverManifest, hostRequest));
  probeNetwork?.setPhase('preflight');
  const preflight = await withProbeTimeout('preflight', capabilityDriver.preflight(context, hostRequest));
  await probeNetwork?.assertNoViolations();
  if (preflight.accepted !== true || preflight.blockers.length > 0) {
    throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_PREFLIGHT:${preflight.blockers.join(',')}`);
  }
  probeNetwork?.setPhase('dryRun');
  await withProbeTimeout('dryRun', capabilityDriver.dryRun(context, hostRequest));
  await probeNetwork?.assertNoViolations();
  probeNetwork?.setPhase('shadow');
  await withProbeTimeout('shadow', capabilityDriver.shadow(context, hostRequest, { worldHostCapabilityPackAbiProbe: true }));
  await probeNetwork?.assertNoViolations();
  probeNetwork?.setPhase('resolve');
  const resolution = driver.resolve(context, hostRequest);
  probeNetwork?.allowReturnedPromise(resolution);
  if (isThenable(resolution)) {
    probeNetwork?.setPhase('resolve-await');
  } else {
    probeNetwork?.setPhase('resolve-returned');
  }
  const resolvedResolution = await withProbeTimeout('resolve', resolution);
  probeNetwork?.setPhase('resolve-returned');
  assertSidecarProbeResolution(
    resolvedResolution,
    hostRequest,
    driverManifest,
    policy,
  );
  await probeNetwork?.assertNoViolations();
  if (packManifest.canRecover === true) {
    if (typeof capabilityDriver.recover !== 'function') throw new Error('ERR_CAPABILITY_PACK_ADAPTER_RECOVER');
    probeNetwork?.setPhase('recover');
    const recoveryResult = driver.recover(context, sidecarProbeEffectRecord(driverManifest, hostRequest));
    probeNetwork?.allowReturnedPromise(recoveryResult);
    if (isThenable(recoveryResult)) {
      probeNetwork?.setPhase('recover-await');
    } else {
      probeNetwork?.setPhase('recover-returned');
    }
    const recovery = await withProbeTimeout('recover', recoveryResult);
    probeNetwork?.setPhase('recover-returned');
    if (recovery?.operatorInterventionRequired !== true) {
      assertSidecarProbeResolution(recovery, hostRequest, driverManifest, policy);
    } else {
      assertNoWorldEvidenceKeys(recovery);
    }
    await probeNetwork?.assertNoViolations();
  }
}

async function withProbeTimeout(phase, value) {
  const timeoutMs = probeTimeoutMs();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setHostTimeout(() => reject(probeTimeoutError(phase, timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve(value), timeout]);
  } finally {
    clearHostTimeout(timer);
  }
}

function probeTimeoutMs() {
  const parsed = Number.parseInt(process.env.WORLD_HOST_CAPABILITY_PACK_PROBE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROBE_TIMEOUT_MS;
}

function probeTimeoutError(phase, timeoutMs) {
  return Object.assign(new Error(`ERR_CAPABILITY_PACK_ADAPTER_PROBE_TIMEOUT:${phase}:${timeoutMs}`), {
    code: 'ERR_CAPABILITY_PACK_ADAPTER_PROBE_TIMEOUT',
    phase,
    timeoutMs,
  });
}

async function withDeterministicProbeNetwork(driverManifest, hostRequest, fn) {
  if (driverManifest?.adapter?.kind === 'sidecar') {
    return await withProbeGlobalLock(fn);
  }
  return await withProbeGlobalLock(async () => {
    const previousGlobals = {
      fetch: globalThis.fetch,
      WebSocket: globalThis.WebSocket,
      EventSource: globalThis.EventSource,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setImmediate: globalThis.setImmediate,
      clearImmediate: globalThis.clearImmediate,
      bunSleep: globalThis.Bun?.sleep,
      promiseResolve: globalThis.Promise?.resolve,
      queueMicrotask: globalThis.queueMicrotask,
    };
    const hadGlobals = {
      fetch: Object.prototype.hasOwnProperty.call(globalThis, 'fetch'),
      WebSocket: Object.prototype.hasOwnProperty.call(globalThis, 'WebSocket'),
      EventSource: Object.prototype.hasOwnProperty.call(globalThis, 'EventSource'),
      setTimeout: Object.prototype.hasOwnProperty.call(globalThis, 'setTimeout'),
      clearTimeout: Object.prototype.hasOwnProperty.call(globalThis, 'clearTimeout'),
      setInterval: Object.prototype.hasOwnProperty.call(globalThis, 'setInterval'),
      clearInterval: Object.prototype.hasOwnProperty.call(globalThis, 'clearInterval'),
      setImmediate: Object.prototype.hasOwnProperty.call(globalThis, 'setImmediate'),
      clearImmediate: Object.prototype.hasOwnProperty.call(globalThis, 'clearImmediate'),
      bunSleep: globalThis.Bun != null && Object.prototype.hasOwnProperty.call(globalThis.Bun, 'sleep'),
      promiseResolve: globalThis.Promise != null && Object.prototype.hasOwnProperty.call(globalThis.Promise, 'resolve'),
      queueMicrotask: Object.prototype.hasOwnProperty.call(globalThis, 'queueMicrotask'),
    };
    const deterministicFetch = async () => new Response(stableJson({ worldHostCapabilityPackAbiProbe: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'world-host-capability-pack-abi-probe',
      },
    });
    const deterministicNetwork = deterministicProbeNetwork({
      fetch: deterministicFetch,
      setTimeout: previousGlobals.setTimeout.bind(globalThis),
      clearTimeout: previousGlobals.clearTimeout.bind(globalThis),
      setInterval: previousGlobals.setInterval.bind(globalThis),
      clearInterval: previousGlobals.clearInterval.bind(globalThis),
      setImmediate: typeof previousGlobals.setImmediate === 'function' ? previousGlobals.setImmediate.bind(globalThis) : null,
      clearImmediate: typeof previousGlobals.clearImmediate === 'function' ? previousGlobals.clearImmediate.bind(globalThis) : null,
      sleep: typeof previousGlobals.bunSleep === 'function' ? previousGlobals.bunSleep.bind(globalThis.Bun) : null,
      promiseResolve: previousGlobals.promiseResolve.bind(globalThis.Promise),
      queueMicrotask: previousGlobals.queueMicrotask.bind(globalThis),
      failNetworkEffect: (api) => {
        throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED:${api} is only supported during deterministic resolve/recover capability pack probes`);
      },
    });
    globalThis.fetch = deterministicNetwork.fetch;
    if (hadGlobals.WebSocket) globalThis.WebSocket = deterministicNetwork.WebSocket;
    if (hadGlobals.EventSource) globalThis.EventSource = deterministicNetwork.EventSource;
    globalThis.setTimeout = deterministicNetwork.setTimeout;
    globalThis.clearTimeout = deterministicNetwork.clearTimeout;
    globalThis.setInterval = deterministicNetwork.setInterval;
    globalThis.clearInterval = deterministicNetwork.clearInterval;
    if (typeof previousGlobals.setImmediate === 'function') globalThis.setImmediate = deterministicNetwork.setImmediate;
    if (typeof previousGlobals.clearImmediate === 'function') globalThis.clearImmediate = deterministicNetwork.clearImmediate;
    if (globalThis.Bun && typeof previousGlobals.bunSleep === 'function') globalThis.Bun.sleep = deterministicNetwork.sleep;
    globalThis.Promise.resolve = deterministicNetwork.promiseResolve;
    globalThis.queueMicrotask = deterministicNetwork.queueMicrotask;
    let result;
    let fnError = null;
    try {
      result = await fn(deterministicNetwork);
    } catch (error) {
      fnError = error;
    } finally {
      try {
        deterministicNetwork.setPhase('closed');
        await deterministicNetwork.assertNoViolations();
      } finally {
        restoreProbeGlobal('fetch', previousGlobals.fetch, hadGlobals.fetch);
        restoreProbeGlobal('WebSocket', previousGlobals.WebSocket, hadGlobals.WebSocket);
        restoreProbeGlobal('EventSource', previousGlobals.EventSource, hadGlobals.EventSource);
        restoreProbeGlobal('setTimeout', previousGlobals.setTimeout, hadGlobals.setTimeout);
        restoreProbeGlobal('clearTimeout', previousGlobals.clearTimeout, hadGlobals.clearTimeout);
        restoreProbeGlobal('setInterval', previousGlobals.setInterval, hadGlobals.setInterval);
        restoreProbeGlobal('clearInterval', previousGlobals.clearInterval, hadGlobals.clearInterval);
        restoreProbeGlobal('setImmediate', previousGlobals.setImmediate, hadGlobals.setImmediate);
        restoreProbeGlobal('clearImmediate', previousGlobals.clearImmediate, hadGlobals.clearImmediate);
        if (globalThis.Bun) restoreProbeGlobalProperty(globalThis.Bun, 'sleep', previousGlobals.bunSleep, hadGlobals.bunSleep);
        restoreProbeGlobalProperty(globalThis.Promise, 'resolve', previousGlobals.promiseResolve, hadGlobals.promiseResolve);
        restoreProbeGlobal('queueMicrotask', previousGlobals.queueMicrotask, hadGlobals.queueMicrotask);
      }
    }
    if (fnError) throw fnError;
    return result;
  });
}

async function withProbeGlobalLock(fn) {
  const previous = probeGlobalLock;
  let release;
  probeGlobalLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

function deterministicProbeNetwork({ fetch, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, sleep, promiseResolve, queueMicrotask, failNetworkEffect }) {
  let phase = 'capture';
  let phaseToken = 0;
  let networkAllowed = false;
  let violations = [];
  const pendingTimeouts = new Set();
  const pendingIntervals = new Set();
  const pendingImmediates = new Set();
  const assertAllowed = (api) => {
    if (((phase === 'resolve' || phase === 'recover') || asyncContinuationNetworkAllowedDepth > 0) && networkAllowed === true) return;
    violations.push(api);
    if (phase === 'closed' || phase === 'resolve-await' || phase === 'resolve-returned' ||
      phase === 'recover-await' || phase === 'recover-returned') return;
    failNetworkEffect(api);
  };
  const cancelPendingTimers = () => {
    for (const timer of pendingTimeouts) clearTimeout(timer);
    for (const timer of pendingIntervals) clearInterval(timer);
    if (typeof clearImmediate === 'function') {
      for (const immediate of pendingImmediates) clearImmediate(immediate);
    }
    pendingTimeouts.clear();
    pendingIntervals.clear();
    pendingImmediates.clear();
  };
  const recordPendingTimers = () => {
    if (pendingTimeouts.size === 0 && pendingIntervals.size === 0 && pendingImmediates.size === 0) return;
    violations.push('async-timer');
    cancelPendingTimers();
  };
  const trackedPromiseStates = new WeakMap();
  let asyncContinuationNetworkAllowedDepth = 0;
  const runAsyncContinuation = (callback, value, { allowNetwork = false } = {}) => {
    const previousPhase = phase;
    const effectiveAllowNetwork = allowNetwork || asyncContinuationNetworkAllowedDepth > 0;
    const phaseChanged = !effectiveAllowNetwork;
    let restoreDeferred = false;
    if (effectiveAllowNetwork) {
      asyncContinuationNetworkAllowedDepth += 1;
    } else {
      phase = 'closed';
    }
    const restoreContinuation = () => {
      if (phaseChanged) phase = previousPhase;
      if (effectiveAllowNetwork) asyncContinuationNetworkAllowedDepth = Math.max(0, asyncContinuationNetworkAllowedDepth - 1);
    };
    try {
      const result = callback(value);
      if (effectiveAllowNetwork && isThenable(result)) {
        restoreDeferred = true;
        promiseResolve(result).then(restoreContinuation, restoreContinuation);
      }
      return result;
    } catch (error) {
      if (!effectiveAllowNetwork) violations.push('async-callback');
      throw error;
    } finally {
      if (!restoreDeferred) restoreContinuation();
    }
  };
  const trackedPromise = (promise, state = { allowNetwork: false }) => {
    const wrapped = {
      then(onFulfilled, onRejected) {
        const childState = { allowNetwork: state.allowNetwork };
        return trackedPromise(promise.then(
          typeof onFulfilled === 'function' ? (value) => runAsyncContinuation(onFulfilled, value, childState) : onFulfilled,
          typeof onRejected === 'function' ? (reason) => runAsyncContinuation(onRejected, reason, childState) : onRejected,
        ), childState);
      },
      catch(onRejected) {
        return this.then(undefined, onRejected);
      },
      finally(onFinally) {
        return this.then(
          (value) => promiseResolve(typeof onFinally === 'function' ? runAsyncContinuation(onFinally, undefined, state) : undefined).then(() => value),
          (reason) => promiseResolve(typeof onFinally === 'function' ? runAsyncContinuation(onFinally, undefined, state) : undefined).then(() => { throw reason; }),
        );
      },
      [Symbol.toStringTag]: 'Promise',
    };
    trackedPromiseStates.set(wrapped, state);
    return wrapped;
  };

  class DeterministicWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url, protocols = '') {
      assertAllowed('WebSocket');
      this.url = String(url);
      this.protocol = Array.isArray(protocols) ? String(protocols[0] ?? '') : String(protocols ?? '');
      this.extensions = '';
      this.binaryType = 'blob';
      this.readyState = DeterministicWebSocket.CLOSED;
      this.worldHostCapabilityPackAbiProbe = true;
    }

    close() {
      this.readyState = DeterministicWebSocket.CLOSED;
    }

    send() {
      throw new Error('ERR_CAPABILITY_PACK_ADAPTER_EXTERNAL_PROBE_UNSUPPORTED:WebSocket send is not supported during deterministic capability pack probes');
    }

    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
  }

  class DeterministicEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    constructor(url) {
      assertAllowed('EventSource');
      this.url = String(url);
      this.readyState = DeterministicEventSource.CLOSED;
      this.withCredentials = false;
      this.worldHostCapabilityPackAbiProbe = true;
    }

    close() {
      this.readyState = DeterministicEventSource.CLOSED;
    }

    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
  }

  return {
    setNetworkAllowed(allowed) {
      networkAllowed = allowed === true;
    },
    setPhase(nextPhase) {
      phase = nextPhase;
      phaseToken += 1;
    },
    allowReturnedPromise(value) {
      const state = trackedPromiseStates.get(value);
      if (state) {
        state.allowNetwork = true;
        return;
      }
      if (!(value instanceof Promise) || !inspectValue(value).includes('<pending>')) return;
      asyncContinuationNetworkAllowedDepth += 1;
      promiseResolve(value).then(
        () => { asyncContinuationNetworkAllowedDepth = Math.max(0, asyncContinuationNetworkAllowedDepth - 1); },
        () => { asyncContinuationNetworkAllowedDepth = Math.max(0, asyncContinuationNetworkAllowedDepth - 1); },
      );
    },
    promiseResolve(value) {
      return trackedPromise(promiseResolve(value), { allowNetwork: asyncContinuationNetworkAllowedDepth > 0 });
    },
    queueMicrotask(callback) {
      return queueMicrotask(() => runAsyncContinuation(callback));
    },
    async assertNoViolations() {
      await promiseResolve();
      await new Promise((resolve) => setTimeout(resolve, PROBE_SETTLE_MS));
      recordPendingTimers();
      if (violations.length === 0) return;
      const blockedApis = [...new Set(violations)].join(',');
      violations = [];
      failNetworkEffect(blockedApis);
    },
    fetch: (...args) => {
      assertAllowed('fetch');
      return fetch(...args);
    },
    sleep: () => {
      assertAllowed('Bun.sleep');
      const scheduledPhase = phase;
      const scheduledPhaseToken = phaseToken;
      let timer;
      const runContinuation = (callback, value) => {
        const previousPhase = phase;
        if (scheduledPhaseToken === phaseToken) {
          phase = scheduledPhase;
        } else {
          violations.push('async-callback');
          phase = 'closed';
        }
        try {
          return callback(value);
        } catch {
          violations.push('async-callback');
          return undefined;
        } finally {
          phase = previousPhase;
        }
      };
      const promise = new Promise((resolve) => {
        timer = setTimeout(() => {
          pendingTimeouts.delete(timer);
          const previousPhase = phase;
          if (scheduledPhaseToken === phaseToken) {
            phase = scheduledPhase;
          } else {
            violations.push('async-callback');
            phase = 'closed';
          }
          try {
            resolve();
          } finally {
            phase = previousPhase;
          }
        }, 0);
        pendingTimeouts.add(timer);
      });
      return {
        then(onFulfilled, onRejected) {
          return promise.then(
            typeof onFulfilled === 'function' ? (value) => runContinuation(onFulfilled, value) : onFulfilled,
            typeof onRejected === 'function' ? (reason) => runContinuation(onRejected, reason) : onRejected,
          );
        },
        catch(onRejected) {
          return this.then(undefined, onRejected);
        },
        finally(onFinally) {
          return this.then(
            (value) => promiseResolve(typeof onFinally === 'function' ? runContinuation(onFinally) : undefined).then(() => value),
            (reason) => promiseResolve(typeof onFinally === 'function' ? runContinuation(onFinally) : undefined).then(() => { throw reason; }),
          );
        },
        [Symbol.toStringTag]: 'Promise',
      };
    },
    setTimeout: (callback, delay, ...args) => {
      if (typeof callback !== 'function') return setTimeout(callback, delay, ...args);
      const scheduledPhase = phase;
      const scheduledPhaseToken = phaseToken;
      let timer;
      timer = setTimeout((...callbackArgs) => {
        pendingTimeouts.delete(timer);
        const previousPhase = phase;
        if (scheduledPhaseToken === phaseToken) {
          phase = scheduledPhase;
        } else {
          violations.push('async-callback');
          phase = 'closed';
        }
        try {
          return callback(...callbackArgs);
        } catch {
          violations.push('async-callback');
        } finally {
          phase = previousPhase;
        }
      }, delay, ...args);
      pendingTimeouts.add(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      pendingTimeouts.delete(timer);
      return clearTimeout(timer);
    },
    setInterval: (callback, delay, ...args) => {
      if (typeof callback !== 'function') return setInterval(callback, delay, ...args);
      const scheduledPhase = phase;
      const scheduledPhaseToken = phaseToken;
      const timer = setInterval((...callbackArgs) => {
        const previousPhase = phase;
        if (scheduledPhaseToken === phaseToken) {
          phase = scheduledPhase;
        } else {
          violations.push('async-callback');
          phase = 'closed';
        }
        try {
          return callback(...callbackArgs);
        } catch {
          violations.push('async-callback');
        } finally {
          phase = previousPhase;
        }
      }, delay, ...args);
      pendingIntervals.add(timer);
      return timer;
    },
    clearInterval: (timer) => {
      pendingIntervals.delete(timer);
      return clearInterval(timer);
    },
    setImmediate: (callback, ...args) => {
      if (typeof setImmediate !== 'function') return undefined;
      if (typeof callback !== 'function') return setImmediate(callback, ...args);
      const scheduledPhase = phase;
      const scheduledPhaseToken = phaseToken;
      let immediate;
      immediate = setImmediate((...callbackArgs) => {
        pendingImmediates.delete(immediate);
        const previousPhase = phase;
        if (scheduledPhaseToken === phaseToken) {
          phase = scheduledPhase;
        } else {
          violations.push('async-callback');
          phase = 'closed';
        }
        try {
          return callback(...callbackArgs);
        } catch {
          violations.push('async-callback');
        } finally {
          phase = previousPhase;
        }
      }, ...args);
      pendingImmediates.add(immediate);
      return immediate;
    },
    clearImmediate: (immediate) => {
      pendingImmediates.delete(immediate);
      if (typeof clearImmediate !== 'function') return undefined;
      return clearImmediate(immediate);
    },
    WebSocket: DeterministicWebSocket,
    EventSource: DeterministicEventSource,
  };
}

function restoreProbeGlobal(name, value, hadOwnProperty) {
  if (hadOwnProperty) {
    globalThis[name] = value;
  } else {
    delete globalThis[name];
  }
}

function restoreProbeGlobalProperty(target, name, value, hadOwnProperty) {
  if (hadOwnProperty) {
    target[name] = value;
  } else {
    delete target[name];
  }
}

function externalEffectProbe(driverManifest, hostRequest) {
  return manifestNetworkEffectProbe(driverManifest);
}

function networkEffectProbe(driverManifest, hostRequest = null) {
  if (hostRequest?.actuationClass === 'http') return true;
  if (hostRequest?.actuationClass === 'model') {
    return networkAuthorityLabel(driverManifest);
  }
  if (hostRequest) return false;
  return manifestNetworkEffectProbe(driverManifest);
}

function isThenable(value) {
  return value != null && typeof value.then === 'function';
}

function manifestNetworkEffectProbe(driverManifest) {
  return (driverManifest.supportedActuationClasses ?? []).includes('http') ||
    networkAuthorityLabel(driverManifest);
}

function networkAuthorityLabel(driverManifest) {
  return (driverManifest.authorityLabels ?? []).some((label) => label === 'model:http-json' || (typeof label === 'string' && label.startsWith('network:')));
}

function assertSidecarProbeResolution(value, hostRequest, driverManifest, policy) {
  assertCapabilityResolutionBoundary(value);
  assertResolutionAccepted(value.resolutionInputBytes, hostRequest, driverManifest, policy);
}

function sidecarProbePolicy(driverManifest, hostRequest) {
  const actuationClasses = new Set(driverManifest.supportedActuationClasses ?? []);
  const diagnostics = driverManifest.diagnostics ?? {};
  const { origins, methods } = sidecarProbeHttpPolicy(diagnostics, hostRequest);
  return Object.freeze({
    allowLiveEffects: true,
    allowNetworkEffects: true,
    allowFileEffects: true,
    allowHumanEffects: true,
    allowBestEffort: true,
    requireApprovalForDestructiveEffects: false,
    requireApprovalForNetworkEffects: false,
    requireApprovalForBestEffort: false,
    maximumLiveModelCalls: actuationClasses.has('model') ? 1 : 0,
    allowedAuthorityLabels: [...(driverManifest.authorityLabels ?? [])],
    allowedCapabilityPacks: [driverManifest.packFingerprint, driverManifest.driverId].filter((item) => typeof item === 'string' && item.length > 0),
    allowedOrigins: origins,
    allowedMethods: methods,
    allowedHttpOrigins: origins,
    allowedHttpMethods: methods,
    allowedFileRoots: sidecarProbeFileRoots(driverManifest),
    maximumConcurrentEffects: Math.max(1, driverManifest.concurrencyLimit ?? 1),
    maximumRequestBytes: Math.max(1, driverManifest.maximumRequestBytes ?? 1, hostRequest.requestBytes?.byteLength ?? 0),
    maximumPromptBytes: Math.max(1, driverManifest.maximumRequestBytes ?? 1, hostRequest.requestBytes?.byteLength ?? 0),
    maximumResponseBytes: Math.max(1, driverManifest.maximumResponseBytes ?? 1),
  });
}

function sidecarProbeHttpPolicy(diagnostics, hostRequest) {
  const origins = new Set();
  for (const origin of diagnostics.origins ?? []) addHttpOrigin(origins, origin);
  addHttpOrigin(origins, diagnostics.configuredOrigin);
  addHttpOrigin(origins, diagnostics.configuredEndpointUrl);
  const request = parseProbeJson(hostRequest.requestBytes);
  addHttpOrigin(origins, request?.url);
  const methods = new Set((diagnostics.methods ?? []).map((item) => String(item).toUpperCase()));
  if (diagnostics.defaultMethod) methods.add(String(diagnostics.defaultMethod).toUpperCase());
  if (request?.method) methods.add(String(request.method).toUpperCase());
  return { origins: [...origins], methods: [...methods] };
}

function sidecarProbeFileRoots(driverManifest) {
  return [
    driverManifest.diagnostics?.root,
    ...(driverManifest.diagnostics?.allowedFileRoots ?? []),
  ].filter((item) => typeof item === 'string' && item.length > 0);
}

function addHttpOrigin(origins, value) {
  if (typeof value !== 'string' || value.length === 0) return;
  try {
    origins.add(new URL(value).origin);
  } catch {
    // Non-URL diagnostics are ignored; concrete probe bytes still provide a target when needed.
  }
}

function parseProbeJson(bytes) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function sidecarProbeHostRequest(driverManifest) {
  const actuationClass = driverManifest.supportedActuationClasses[0];
  const requestBytes = sidecarProbeRequestBytes(driverManifest, actuationClass);
  return Object.freeze({
    actuatorRef: driverManifest.supportedActuatorRefs[0],
    descriptorFingerprint: driverManifest.supportedDescriptorFingerprints[0],
    actuationClass,
    idempotencyKeyBytes: fromUtf8('world-host-capability-pack-sidecar-abi-probe-key'),
    idempotencyKeyWorldFingerprint: 'world:idempotency-key:world-host-capability-pack-sidecar-abi-probe',
    requestBytes,
    hostRequestFingerprint: 'world:host-request:0000000000000abc',
  });
}

function sidecarProbeRequestBytes(driverManifest, actuationClass) {
  const diagnostics = driverManifest.diagnostics ?? {};
  if (actuationClass === 'http') {
    return fromUtf8(stableJson({
      url: diagnostics.configuredEndpointUrl ??
        httpProbeUrlForOrigin(diagnostics.configuredOrigin) ??
        httpProbeUrlForOrigin(diagnostics.origins?.[0]) ??
        'https://example.invalid/world-host-abi-probe',
      method: diagnostics.defaultMethod ?? diagnostics.methods?.[0] ?? 'POST',
      body: { worldHostCapabilityPackAbiProbe: true },
    }));
  }
  if (actuationClass === 'model') {
    return fromUtf8(stableJson({
      schema: 'boundary.Agent.DecisionPrompt.v0',
      observation: 'goal=fixture',
    }));
  }
  if (actuationClass === 'human') {
    return fromUtf8(stableJson({ action: 'world-host capability pack sidecar ABI probe' }));
  }
  if (actuationClass === 'file') {
    return fromUtf8(stableJson({ operation: 'read', path: 'world-host-abi-probe.txt' }));
  }
  return fromUtf8(stableJson({ worldHostCapabilityPackAbiProbe: true }));
}

function httpProbeUrlForOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return null;
  try {
    return new URL('/world-host-abi-probe', origin).href;
  } catch {
    return null;
  }
}

function sidecarProbeEffectRecord(driverManifest, hostRequest) {
  const requestBytesChecksum = `sha256:${sha256BytesHex(hostRequest.requestBytes)}`;
  const requestBytesRef = sidecarProbeBlobRef(hostRequest.requestBytes);
  return Object.freeze({
    runId: 'world-host-capability-pack-sidecar-abi-probe-run',
    branchId: 'main',
    parentTurnClosureFingerprint: 'world:turn-closure:0000000000000abc',
    state: 'running',
    attemptCount: 1,
    driverId: driverManifest.driverId,
    driverRecoveryClass: driverManifest.recoveryClass,
    actuatorRef: hostRequest.actuatorRef,
    descriptorFingerprint: hostRequest.descriptorFingerprint,
    actuationClass: hostRequest.actuationClass,
    responseSchema: hostRequest.responseSchema,
    idempotencyKey: {
      format: 'world-idempotency-key-bytes.hex',
      bytesHex: bytesHex(hostRequest.idempotencyKeyBytes),
    },
    idempotencyKeyWorldFingerprint: hostRequest.idempotencyKeyWorldFingerprint,
    hostRequestFingerprint: hostRequest.hostRequestFingerprint,
    requestBytes: hostRequest.requestBytes,
    requestBytesRef,
    requestBytesChecksum,
    requestIdentityChecksum: requestBytesChecksum,
    effectIdentityBytesRef: requestBytesRef,
    effectIdentityBytes: hostRequest.requestBytes,
    diagnostics: { worldHostCapabilityPackAbiProbe: true },
  });
}

function sidecarProbeBlobRef(bytes) {
  return Object.freeze({
    algorithm: 'sha256',
    checksum: sha256BytesHex(bytes),
    byteLength: bytes.byteLength,
  });
}

function sha256BytesHex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function adapterImportUrl(packManifest, artifacts) {
  const checksum = packManifest.checksums.find((item) => item.path === packManifest.adapter.module)?.checksum;
  if (!checksum) throw new Error(`ERR_CAPABILITY_PACK_CHECKSUM_REQUIRED:${packManifest.adapter.module}`);
  const root = await mkdtemp(path.join(tmpdir(), 'world-host-capability-adapter-imports-'));
  for (const item of packManifest.checksums) {
    const bytes = artifacts[item.path];
    if (!(bytes instanceof Uint8Array)) throw new Error(`ERR_CAPABILITY_PACK_ARTIFACT_MISSING:${item.path}`);
    const target = path.resolve(root, item.path);
    if (!pathInside(root, target)) throw new Error(`ERR_CAPABILITY_HOST_PATH_FORBIDDEN:${item.path}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  return pathToFileURL(path.resolve(root, packManifest.adapter.module)).href;
}

function adapterOptions(packManifest) {
  const base = { packFingerprint: packManifest.packFingerprint };
  if (packManifest.driverId === 'generic-http-json') return { ...base, endpointUrl: 'https://example.invalid/decide' };
  return base;
}

function assertSameManifestField(name, field, packValue, driverValue) {
  if (JSON.stringify(packValue) !== JSON.stringify(driverValue)) {
    throw new Error(`ERR_CAPABILITY_PACK_ADAPTER_MANIFEST_MISMATCH:${name}:${field}`);
  }
}
