import { EffectRecoveryClass } from '../core/actuator.mjs';
import { CapabilityPreflightReport, DryRunReport, ShadowReport, capabilityHostClaimBytes, defaultCapabilityPreflight } from '../core/capability_driver.mjs';
import { assertCapabilityPolicyAllows, createCapabilityPolicy } from '../core/capability_policy.mjs';
import { assertRequiredSecretsAvailable } from '../core/secrets.mjs';
import { assertBytes, fail, fromUtf8, stableJson } from '../core/store.mjs';
import { encodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';
import { encodeCanonicalValueImage } from '../protocol/world_loaded_value_codec.mjs';

const DEFAULT_MAXIMUM_RESPONSE_ENVELOPE_BYTES = 1024 * 1024;
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
  } = {}) {
    if (!endpointUrl) fail('ERR_HTTP_CAPABILITY_ENDPOINT_REQUIRED');
    const parsedEndpointUrl = parseHttpUrl(endpointUrl);
    this.endpointUrl = endpointUrl;
    this.methods = new Set(methods.map((method) => String(method).toUpperCase()));
    this.origins = new Set(origins.length ? origins : [parsedEndpointUrl.origin]);
    this.secretHeaders = secretHeaders;
    this.secretProvider = secretProvider;
    this.requestTemplate = requestTemplate;
    this.responseExtractionPath = responseExtractionPath;
    this.timeoutMs = timeoutMs;
    this.retryPolicy = retryPolicy;
    this.maximumRequestBytes = maximumRequestBytes;
    this.maximumResponseBytes = maximumResponseBytes;
    this.idempotencyHeaderName = idempotencyHeaderName;
    this.allowEndpointFromRequest = allowEndpointFromRequest;
    this.redactionRules = redactionRules;
  }

  manifest() {
    return {
      driverId: 'generic-http-json',
      supportedActuatorRefs: ['http:json'],
      supportedDescriptorFingerprints: ['descriptor:http-json'],
      supportedActuationClasses: ['http'],
      supportedResponseStatuses: ['ok', 'http_error', 'deferred', 'failed'],
      maximumRequestBytes: this.maximumRequestBytes,
      maximumResponseBytes: encodedJsonStringEnvelopeLimit(this.maximumResponseBytes, RESPONSE_ENVELOPE_OVERHEAD_BYTES),
      recoveryClass: EffectRecoveryClass.idempotent,
      concurrencyLimit: 4,
      authorityLabels: ['network:http'],
      diagnostics: {
        origins: [...this.origins],
        methods: [...this.methods],
        endpointSource: this.allowEndpointFromRequest ? 'request-or-config' : 'config',
        secretHeaders: Object.keys(this.secretHeaders),
      },
    };
  }

  preflight(context, hostRequest) {
    const structural = defaultCapabilityPreflight(this.manifest(), hostRequest);
    const blockers = [...structural.blockers];
    try {
      this.#assertSecrets();
      this.#assertPolicyAllows(context, hostRequest);
    } catch (error) {
      blockers.push(error.code ?? 'ERR_HTTP_CAPABILITY_PREFLIGHT_REJECTED');
    }
    return new CapabilityPreflightReport({ accepted: blockers.length === 0, blockers });
  }

  dryRun(context, hostRequest) {
    const request = this.#request(hostRequest);
    return new DryRunReport({
      wouldInvoke: true,
      proposedAction: {
        method: request.method,
        url: `${new URL(request.url).origin}${new URL(request.url).pathname}`,
        bodyBytes: request.bodyBytes,
      },
      diagnostics: { driverId: 'generic-http-json' },
    });
  }

  shadow(context, hostRequest, recordedResolution) {
    const dryRun = this.dryRun(context, hostRequest);
    return new ShadowReport({
      liveInvoked: context?.allowShadowNetwork === true,
      schemaAccepted: Boolean(recordedResolution),
      diagnostics: { proposedAction: dryRun.proposedAction },
    });
  }

  async resolve(context, hostRequest) {
    this.#assertSecrets();
    this.#assertPolicyAllows(context, hostRequest);
    const request = this.#request(hostRequest);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: await this.#headers(hostRequest),
        body: request.body,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) fail('ERR_HTTP_REDIRECT_REJECTED');
      if (!response.ok) return this.#resolution(hostRequest, { status: 'http_error', statusCode: response.status }, 1, response.headers.get('x-request-id'));
      const bytes = await readResponseBytes(response, this.maximumResponseBytes);
      const json = bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : null;
      const body = extractPath(json, this.responseExtractionPath);
      return this.#resolution(hostRequest, { status: 'ok', statusCode: response.status, body }, 0, response.headers.get('x-request-id'));
    } catch (error) {
      if (error?.name === 'AbortError') {
        return this.#resolution(hostRequest, { status: 'deferred', reason: 'timeout' }, 4, null);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
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
    const url = this.allowEndpointFromRequest && payload.url ? payload.url : this.endpointUrl;
    const parsedUrl = parseHttpUrl(url);
    if (!this.origins.has(parsedUrl.origin)) fail('ERR_HTTP_ORIGIN_REJECTED');
    const method = String(payload.method ?? [...this.methods][0] ?? 'POST').toUpperCase();
    if (!this.methods.has(method)) fail('ERR_HTTP_METHOD_REJECTED');
    const bodyValue = this.requestTemplate ?? payload.body ?? payload;
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

  async #headers(hostRequest) {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      [this.idempotencyHeaderName]: hostRequest.idempotencyKeyWorldFingerprint,
    };
    for (const [header, secretName] of Object.entries(this.secretHeaders)) {
      headers[header] = await this.#secret(secretName);
    }
    return headers;
  }

  async #secret(name) {
    if (!this.secretProvider) fail('ERR_SECRET_PROVIDER_REQUIRED');
    const value = await this.secretProvider.get(name, `http-header:${name}`);
    if (typeof value !== 'string' || value.length === 0) fail('ERR_SECRET_MISSING');
    return value;
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

function parseHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('ERR_HTTP_URL_INVALID');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('ERR_HTTP_URL_SCHEME_REJECTED');
  return parsed;
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
