import { createHash } from 'node:crypto';

import { EffectRecoveryClass } from '../core/actuator.mjs';
import { CapabilityPreflightReport, DryRunReport, ShadowReport, capabilityHostClaimBytes, defaultCapabilityPreflight } from '../core/capability_driver.mjs';
import { assertCapabilityPolicyAllows, createCapabilityPolicy } from '../core/capability_policy.mjs';
import { assertRequiredSecretsAvailable } from '../core/secrets.mjs';
import { assertBytes, fail, fromUtf8, stableJson } from '../core/store.mjs';
import { encodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';
import { encodeCanonicalValueImage } from '../protocol/world_loaded_value_codec.mjs';

const DEFAULT_MAXIMUM_RESPONSE_ENVELOPE_BYTES = 1024 * 1024;
const REQUEST_ENVELOPE_OVERHEAD_BYTES = 4096;
const RESPONSE_ENVELOPE_OVERHEAD_BYTES = 8192;
const DEFAULT_MAXIMUM_RESPONSE_BODY_BYTES = Math.floor((DEFAULT_MAXIMUM_RESPONSE_ENVELOPE_BYTES - RESPONSE_ENVELOPE_OVERHEAD_BYTES) / 6);

export class GenericHttpJsonCapabilityDriver {
  constructor({
    endpointUrl,
    methods = ['POST'],
    origins = [],
    secretHeaders = {},
    secretProvider = null,
    requestTemplate = null,
    responseExtractionPath = null,
    timeoutMs = 5000,
    retryPolicy = { attempts: 1 },
    maximumRequestBytes = 64 * 1024,
    maximumResponseBytes = DEFAULT_MAXIMUM_RESPONSE_BODY_BYTES,
    idempotencyHeaderName = 'Idempotency-Key',
    allowEndpointFromRequest = false,
    redactionRules = [],
    packFingerprint = null,
  } = {}) {
    if (!endpointUrl) fail('ERR_HTTP_CAPABILITY_ENDPOINT_REQUIRED');
    assertNoReservedSecretHeaders(secretHeaders, idempotencyHeaderName);
    const parsedEndpointUrl = parseHttpUrl(endpointUrl);
    this.endpointUrl = endpointUrl;
    this.endpointOrigin = parsedEndpointUrl.origin;
    this.methods = new Set(methods.map((method) => String(method).toUpperCase()));
    this.origins = new Set(origins.length ? origins : [parsedEndpointUrl.origin]);
    this.secretHeaders = secretHeaders;
    this.secretProvider = secretProvider;
    this.requestTemplate = requestTemplate;
    this.responseExtractionPath = responseExtractionPath;
    this.timeoutMs = timeoutMs;
    this.retryPolicy = normalizeRetryPolicy(retryPolicy);
    this.maximumRequestBytes = maximumRequestBytes;
    this.maximumResponseBytes = maximumResponseBytes;
    this.idempotencyHeaderName = idempotencyHeaderName;
    this.allowEndpointFromRequest = allowEndpointFromRequest;
    this.redactionRules = redactionRules;
    this.packFingerprint = packFingerprint;
  }

  manifest() {
    return {
      driverId: 'generic-http-json',
      ...(this.packFingerprint ? { packFingerprint: this.packFingerprint } : {}),
      supportedActuatorRefs: ['http:json'],
      supportedDescriptorFingerprints: ['descriptor:http-json'],
      supportedActuationClasses: ['http'],
      supportedResponseStatuses: ['ok', 'http_error', 'deferred'],
      maximumRequestBytes: encodedJsonStringEnvelopeLimit(this.maximumRequestBytes, REQUEST_ENVELOPE_OVERHEAD_BYTES),
      maximumResponseBytes: encodedJsonStringEnvelopeLimit(this.maximumResponseBytes, RESPONSE_ENVELOPE_OVERHEAD_BYTES),
      recoveryClass: EffectRecoveryClass.idempotent,
      concurrencyLimit: 4,
      authorityLabels: ['network:http'],
      diagnostics: {
        origins: [...this.origins],
        methods: [...this.methods],
        endpointSource: this.allowEndpointFromRequest ? 'request-or-config' : 'config',
        configuredEndpointUrl: this.endpointUrl,
        configuredOrigin: this.endpointOrigin,
        defaultMethod: [...this.methods][0] ?? 'POST',
        secretHeaders: Object.keys(this.secretHeaders),
        requestRendering: {
          requestTemplateFingerprint: this.requestTemplate == null ? null : sha256Json(this.requestTemplate),
          secretHeadersFingerprint: sha256Json(this.secretHeaders),
          idempotencyHeaderName: this.idempotencyHeaderName,
          responseExtractionPathFingerprint: this.responseExtractionPath == null ? null : sha256Json(this.responseExtractionPath),
        },
      },
    };
  }

  preflight(context, hostRequest) {
    const structural = defaultCapabilityPreflight(this.manifest(), hostRequest);
    const blockers = [...structural.blockers];
    if (!blockers.length) {
      try {
        this.#assertPolicyAllows(context, hostRequest);
        this.#assertSecrets();
      } catch (error) {
        blockers.push(error.code ?? 'ERR_HTTP_CAPABILITY_PREFLIGHT_REJECTED');
      }
    }
    return new CapabilityPreflightReport({ accepted: blockers.length === 0, blockers });
  }

  dryRun(context, hostRequest) {
    const request = this.#request(hostRequest);
    return new DryRunReport({
      wouldInvoke: true,
      proposedAction: {
        method: request.method,
        url: new URL(request.url).href,
        bodyBytes: request.bodyBytes,
      },
      diagnostics: { driverId: 'generic-http-json' },
    });
  }

  shadow(context, hostRequest, recordedResolution) {
    const dryRun = this.dryRun(context, hostRequest);
    return new ShadowReport({
      liveInvoked: false,
      schemaAccepted: Boolean(recordedResolution),
      diagnostics: { proposedAction: dryRun.proposedAction },
    });
  }

  async resolve(context, hostRequest) {
    this.#assertPolicyAllows(context, hostRequest);
    assertResolvableHttpHostRequest(hostRequest);
    this.#assertSecrets();
    const secretValues = await this.#secretValues();
    const request = this.#request(hostRequest);
    try {
      return await this.#fetchWithRetry(request, hostRequest, secretValues, async (response) => {
        if (response.status >= 300 && response.status < 400) {
          await discardResponseBody(response, this.maximumResponseBytes);
          fail('ERR_HTTP_REDIRECT_REJECTED');
        }
        if (!response.ok) {
          await discardResponseBody(response, this.maximumResponseBytes);
          const transactionRef = response.headers.get('x-request-id');
          assertNoKnownSecretEcho(transactionRef, secretValues);
          return this.#resolution(hostRequest, { status: 'http_error', statusCode: response.status }, 1, transactionRef);
        }
        const bytes = await readResponseBytes(response, this.maximumResponseBytes);
        const json = bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : null;
        const body = extractPath(json, this.responseExtractionPath);
        const payload = { status: 'ok', statusCode: response.status, body };
        assertNoKnownSecretEcho(payload, secretValues);
        const transactionRef = response.headers.get('x-request-id');
        assertNoKnownSecretEcho(transactionRef, secretValues);
        return this.#resolution(hostRequest, payload, 0, transactionRef);
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        return this.#resolution(hostRequest, { status: 'deferred', reason: 'timeout' }, 4, null);
      }
      throw error;
    }
  }

  async recover(context, effectRecord) {
    if (!effectRecord.requestBytes) fail('ERR_HTTP_RECOVERY_REQUEST_BYTES_REQUIRED');
    return await this.resolve(context, {
      actuatorRef: effectRecord.actuatorRef,
      descriptorFingerprint: effectRecord.descriptorFingerprint,
      actuationClass: effectRecord.actuationClass,
      requestBytes: effectRecord.requestBytes,
      responseSchema: effectRecord.responseSchema,
      idempotencyKeyWorldFingerprint: effectRecord.idempotencyKeyWorldFingerprint,
      hostRequestFingerprint: effectRecord.hostRequestFingerprint,
    });
  }

  #request(hostRequest) {
    const payload = parseJsonBytes(hostRequest.requestBytes);
    const url = this.allowEndpointFromRequest && Object.prototype.hasOwnProperty.call(payload, 'url') ? payload.url : this.endpointUrl;
    const parsedUrl = parseHttpUrl(url);
    if (!this.origins.has(parsedUrl.origin)) fail('ERR_HTTP_ORIGIN_REJECTED');
    const method = String(payload.method ?? [...this.methods][0] ?? 'POST').toUpperCase();
    if (!this.methods.has(method)) fail('ERR_HTTP_METHOD_REJECTED');
    const bodyValue = this.requestTemplate ?? (Object.prototype.hasOwnProperty.call(payload, 'body') ? payload.body : payload);
    const body = method === 'GET' ? undefined : stableJson(bodyValue);
    const bodyBytes = body ? fromUtf8(body).byteLength : 0;
    if (bodyBytes > this.maximumRequestBytes) fail('ERR_HTTP_REQUEST_TOO_LARGE');
    return { url, method, body, bodyBytes };
  }

  #policyHostRequest(hostRequest, request = this.#request(hostRequest)) {
    return { ...hostRequest, requestBytes: fromUtf8(stableJson({ url: request.url, method: request.method })) };
  }

  #assertPolicyAllows(context, hostRequest) {
    const manifest = this.manifest();
    const policy = context?.policy ?? {};
    const action = context?.action ?? null;
    assertCapabilityPolicyAllows({
      manifest,
      hostRequest,
      policy,
      mode: 'live',
      action,
      enforceNetworkTarget: false,
    });
    const request = this.#request(hostRequest);
    assertRenderedRequestWithinPolicy(request, policy);
    assertCapabilityPolicyAllows({
      manifest,
      hostRequest: this.#policyHostRequest(hostRequest, request),
      policy,
      mode: 'live',
      action,
    });
  }

  async #headers(hostRequest, secretValues = null) {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      [this.idempotencyHeaderName]: hostRequest.idempotencyKeyWorldFingerprint,
    };
    assertNoReservedSecretHeaders(this.secretHeaders, this.idempotencyHeaderName);
    const values = secretValues ?? await this.#secretValues();
    for (const [header, secretName] of Object.entries(this.secretHeaders)) {
      headers[header] = values.get(secretName);
    }
    return headers;
  }

  async #fetchWithRetry(request, hostRequest, secretValues, handleResponse) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.retryPolicy.attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        let response;
        try {
          response = await fetch(request.url, {
            method: request.method,
            headers: await this.#headers(hostRequest, secretValues),
            body: request.body,
            signal: controller.signal,
            redirect: 'manual',
          });
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          lastError = error;
          if (attempt >= this.retryPolicy.attempts) throw error;
          continue;
        }
        return await handleResponse(response);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  async #secret(name) {
    if (!this.secretProvider) fail('ERR_SECRET_PROVIDER_REQUIRED');
    const value = await this.secretProvider.get(name, `http-header:${name}`);
    if (typeof value !== 'string' || value.length === 0) fail('ERR_SECRET_MISSING');
    return value;
  }

  async #secretValues() {
    const values = new Map();
    for (const secretName of new Set(Object.values(this.secretHeaders))) {
      values.set(secretName, await this.#secret(secretName));
    }
    return values;
  }

  #assertSecrets() {
    if (!Object.keys(this.secretHeaders).length) return;
    if (!this.secretProvider) fail('ERR_SECRET_PROVIDER_REQUIRED');
    assertRequiredSecretsAvailable(this.secretProvider, Object.values(this.secretHeaders));
  }

  #resolution(hostRequest, payload, status, transactionRef) {
    const responseValueImageBytes = status === 0
      ? encodeCanonicalValueImage({ bytes: fromUtf8(stableJson(payload)), dynamicSize: true })
      : new Uint8Array();
    return {
      resolutionInputBytes: encodeResolutionInputBytes({
        targetHostRequestFingerprint: resolutionTarget(hostRequest),
        status,
        responseValueImageBytes,
        hostClaimBytes: capabilityHostClaimBytes({ driver: 'generic-http-json', status: payload.status }),
        attemptNumber: 1,
        metadata: fromUtf8(stableJson({ driver: 'generic-http-json', status: payload.status, statusCode: payload.statusCode ?? null })),
      }),
      driverTransactionRef: transactionRef,
      diagnostics: { status: payload.status, statusCode: payload.statusCode ?? null },
    };
  }
}

function parseJsonBytes(bytes) {
  assertBytes(bytes, 'requestBytes');
  return JSON.parse(new TextDecoder().decode(bytes));
}

function sha256Json(value) {
  return `sha256:${createHash('sha256').update(fromUtf8(stableJson(value))).digest('hex')}`;
}

function parseHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('ERR_HTTP_URL_INVALID');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('ERR_HTTP_URL_SCHEME_REJECTED');
  if (parsed.username || parsed.password) fail('ERR_HTTP_URL_CREDENTIALS_FORBIDDEN');
  assertNoCredentialPathOrFragment(parsed);
  assertNoCredentialQuery(parsed);
  return parsed;
}

function assertNoCredentialPathOrFragment(url) {
  const pathname = decodeUrlComponent(url.pathname);
  const hash = decodeUrlComponent(url.hash);
  if (credentialQueryValue(pathname) || credentialQueryValue(hash) || credentialAssignmentText(hash)) {
    fail('ERR_HTTP_URL_CREDENTIALS_FORBIDDEN');
  }
  const pathSegments = pathname.split('/').filter(Boolean);
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    if (credentialPathKey(pathSegments[index]) && !credentialUrlSentinel(pathSegments[index + 1])) {
      fail('ERR_HTTP_URL_CREDENTIALS_FORBIDDEN');
    }
  }
}

function assertNoCredentialQuery(url) {
  for (const [key, value] of url.searchParams) {
    if (credentialQueryKey(key) || credentialQueryValue(value)) fail('ERR_HTTP_URL_CREDENTIALS_FORBIDDEN');
  }
}

function credentialQueryKey(value) {
  return /credential|authorization|bearer|token|secret|password|(?:api|access|private)[_-]?key/i.test(value);
}

function credentialQueryValue(value) {
  return /\b(?:bearer|basic)\s+\S+/i.test(value) || /sk-[A-Za-z0-9_-]{8,}/.test(value);
}

function credentialAssignmentText(value) {
  return /(?:^|[#?&;,\s{])(?:credential|authorization|token|secret|password|(?:api|access|private)[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}={0,2}/i.test(value);
}

function credentialPathKey(value) {
  return /^(?:credentials?|authorization|bearer|tokens?|secrets?|password|(?:api|access|private)[_-]?keys?)$/i.test(value);
}

function credentialUrlSentinel(value) {
  return /^(?:redacted|opaque|required|none|null|example(?:[-_].*)?|fixture(?:[-_].*)?|no-(?:credentials?|secrets?|tokens?))$/i.test(value);
}

function decodeUrlComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeRetryPolicy(value = {}) {
  const attempts = value?.attempts ?? 1;
  if (!Number.isSafeInteger(attempts) || attempts < 1) fail('ERR_HTTP_RETRY_POLICY_INVALID');
  return Object.freeze({ attempts });
}

function assertNoReservedSecretHeaders(secretHeaders, idempotencyHeaderName) {
  const reserved = normalizedHeaderName(idempotencyHeaderName);
  for (const header of Object.keys(secretHeaders ?? {})) {
    if (normalizedHeaderName(header) === reserved) fail('ERR_HTTP_SECRET_HEADER_RESERVED', `${idempotencyHeaderName} is reserved for World idempotency`);
  }
}

function normalizedHeaderName(value) {
  return String(value).trim().toLowerCase();
}

function assertNoKnownSecretEcho(value, secretValues) {
  const candidates = secretEchoCandidates(secretValues);
  if (!candidates.length) return;
  visitPayloadStrings(value, (text) => {
    for (const candidate of candidates) {
      if (text.includes(candidate)) fail('ERR_SECRET_PERSISTED', 'HTTP response echoed a local secret');
    }
  });
}

function secretEchoCandidates(secretValues) {
  const candidates = new Set();
  for (const value of secretValues.values()) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    candidates.add(trimmed);
    const scheme = trimmed.match(/^(?:Bearer|Basic)\s+(.+)$/i);
    if (scheme?.[1]?.trim()) candidates.add(scheme[1].trim());
  }
  return [...candidates];
}

function visitPayloadStrings(value, visit) {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitPayloadStrings(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    visit(key);
    visitPayloadStrings(child, visit);
  }
}

function assertRenderedRequestWithinPolicy(request, inputPolicy) {
  const policy = createCapabilityPolicy(inputPolicy);
  if (request.bodyBytes > policy.maximumRequestBytes) fail('ERR_CAPABILITY_PROMPT_TOO_LARGE');
}

function extractPath(value, path) {
  if (!path) return value;
  let current = value;
  for (const part of path.split('.')) current = current?.[part];
  if (current === undefined) fail('ERR_HTTP_RESPONSE_SCHEMA_INVALID');
  return current;
}

function resolutionTarget(hostRequest = {}) {
  const value = hostRequest.hostRequestFingerprint;
  if (typeof value === 'bigint' || typeof value === 'number') return BigInt(value);
  const match = String(value ?? '').match(/(?:0x|world:host-request:)?([0-9a-f]+)$/i);
  if (!match) fail('ERR_HOST_REQUEST_FINGERPRINT_REQUIRED');
  return BigInt(`0x${match[1]}`);
}

function assertResolvableHttpHostRequest(hostRequest = {}) {
  resolutionTarget(hostRequest);
  if (typeof hostRequest.idempotencyKeyWorldFingerprint !== 'string' || hostRequest.idempotencyKeyWorldFingerprint.length === 0) {
    fail('ERR_HTTP_IDEMPOTENCY_KEY_REQUIRED');
  }
}

async function readResponseBytes(response, maximumResponseBytes) {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maximumResponseBytes) fail('ERR_HTTP_RESPONSE_TOO_LARGE');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maximumResponseBytes) fail('ERR_HTTP_RESPONSE_TOO_LARGE');
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return concatChunks(chunks, total);
}

async function discardResponseBody(response, maximumResponseBytes) {
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maximumResponseBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    await reader.cancel().catch(() => {});
  }
}

function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function encodedJsonStringEnvelopeLimit(logicalBytes, overheadBytes) {
  if (logicalBytes > Math.floor((Number.MAX_SAFE_INTEGER - overheadBytes) / 6)) return Number.MAX_SAFE_INTEGER;
  return logicalBytes * 6 + overheadBytes;
}
