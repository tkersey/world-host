import { EffectRecoveryClass } from '../core/actuator.mjs';
import { assertBytes, fail, fromUtf8, stableJson } from '../core/store.mjs';
import { encodeResolutionInputBytes } from '../protocol/world_appliance_wire_codec.mjs';

export class HttpJsonDriver {
  constructor({ origins = [], methods = ['GET', 'POST'], timeoutMs = 5000, maximumRequestBytes = 64 * 1024, maximumResponseBytes = 1024 * 1024, idempotencyHeader = 'Idempotency-Key', credentials = {} } = {}) {
    this.origins = new Set(origins);
    this.methods = new Set(methods.map((method) => method.toUpperCase()));
    this.timeoutMs = timeoutMs;
    this.maximumRequestBytes = maximumRequestBytes;
    this.maximumResponseBytes = maximumResponseBytes;
    this.idempotencyHeader = idempotencyHeader;
    this.credentials = credentials;
  }

  manifest() {
    return {
      driverId: 'http-json',
      supportedActuatorRefs: ['http:json'],
      supportedDescriptorFingerprints: ['descriptor:http-json'],
      supportedActuationClasses: ['http'],
      supportedResponseStatuses: ['ok', 'http_error'],
      maximumRequestBytes: this.maximumRequestBytes,
      maximumResponseBytes: this.maximumResponseBytes,
      recoveryClass: EffectRecoveryClass.idempotent,
      concurrencyLimit: 4,
      authorityLabels: ['network:http'],
      diagnostics: { origins: [...this.origins], methods: [...this.methods] },
    };
  }

  async resolve(context, hostRequest) {
    const request = parseJsonBytes(hostRequest.requestBytes);
    const url = new URL(request.url);
    if (!this.origins.has(url.origin)) fail('ERR_HTTP_ORIGIN_REJECTED');
    const method = String(request.method ?? 'GET').toUpperCase();
    if (!this.methods.has(method)) fail('ERR_HTTP_METHOD_REJECTED');
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (body && fromUtf8(body).byteLength > this.maximumRequestBytes) fail('ERR_HTTP_REQUEST_TOO_LARGE');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = {
        Accept: 'application/json',
        [this.idempotencyHeader]: hostRequest.idempotencyKeyWorldFingerprint,
        ...(this.credentials.headers ?? {}),
      };
      const response = await fetch(url, { method, headers, body, signal: controller.signal });
      const text = await response.text();
      const bytes = fromUtf8(text);
      if (bytes.byteLength > this.maximumResponseBytes) fail('ERR_HTTP_RESPONSE_TOO_LARGE');
      return {
        resolutionInputBytes: encodeResolutionInputBytes({
          targetHostRequestFingerprint: resolutionTarget(hostRequest),
          status: response.ok ? 0 : 1,
          responseValueImageBytes: fromUtf8(stableJson({ status: response.ok ? 'ok' : 'http_error', statusCode: response.status, body: text })),
          hostClaimBytes: new Uint8Array(),
          attemptNumber: 1,
          metadata: fromUtf8('http-json'),
        }),
        driverTransactionRef: response.headers.get('x-request-id') ?? null,
        diagnostics: { url: `${url.origin}${url.pathname}`, status: response.status },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function resolutionTarget(hostRequest = {}) {
  const value = hostRequest.hostRequestFingerprint;
  if (value === undefined) return 0n;
  if (typeof value === 'bigint' || typeof value === 'number') return BigInt(value);
  const match = String(value).match(/(?:0x)?([0-9a-f]+)$/i);
  if (!match) fail('ERR_HOST_REQUEST_FINGERPRINT_REQUIRED');
  return BigInt(`0x${match[1]}`);
}

function parseJsonBytes(bytes) {
  assertBytes(bytes, 'requestBytes');
  return JSON.parse(new TextDecoder().decode(bytes));
}
