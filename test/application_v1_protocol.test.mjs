import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  EffectStatus,
  FrameStatus,
  createEffectResult,
  decodeApplicationManifest,
  decodeEffectRequest,
  decodeEffectResult,
  decodeFrame,
  decodeStepInput,
  encodeStepInput,
  inspectApplicationWasm,
  validateEffectResultForRequest,
} from '../src/v1/index.mjs';

const MANIFEST = fromBase64('V1JMRE1ORjEBAAAAtDwC7u0NbaCT5c6hHDc1i1E5EnRtsBXb4iQz3ae+W5AKAAAAb25lLWVmZmVjdAUAAAAxLjAuMBEAAAAwLjcuMC1kZXYuOTUxMGQxMwEAAAAOAAAAMS4wLjAtcmMuMS1kZXYBAAAAzDpwk1kTGucAGLDyUZkV6ZA9SX6iumJoj8UxGM5W8XUAAAAAAQAAAFAOuPt+TdJFHEcMnwMDF07P2lMo2Kj4dXbc7+PUBmzP+PnsVNnMCk/Ax0f6CI5Tp47fkBz22fx9/eABleLsWKFviRyzqslRgqgZdZeTbv0p2pOGJhty8r8euEW7oJ+2/tyqdOMDJIwzFwEAAAAAAAAAAAAQAAAAEAAAABAAAAAQAAAAEAAAAAEAAAABAAAAAQAAEAAAAAEAAAABAACghgEAAAAAAEAAAAAIAAAAAQAAAAAAAAA=');
const GENESIS_INPUT = fromBase64('V1JMRFNUUDEBAAAAtDwC7u0NbaCT5c6hHDc1i1E5EnRtsBXb4iQz3ae+W5AAAAEAAAAAAGQAAAAAAAAAAAAAAA==');
const PARENT_FRAME = fromBase64('V1JMREZSTTEBAAAA9rjycuD4oSPFFuUZwxJVsRMZoj4L9I2eVW3rtPYoILC0PALu7Q1toJPlzqEcNzWLUTkSdG2wFdviJDPdp75bkAAAAAAAAAAAAFABAABXUkxEQVBQMQEAAAC0PALu7Q1toJPlzqEcNzWLUTkSdG2wFdviJDPdp75bkAEAAAAAAAAA/////xQBAABBQkxfU1RNMQEAAAABAAAADQAAAAAAAAB3b3JsZC12MS1yb290DQAAAAAAAAB3b3JsZC12MS1yb290NaLSwzfn0FMOJwAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAgABAAcAAAAAAAAAcGF5bG9hZAEAAAABAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAABwAAAAAAAABwYXlsb2FktCRs6wK2QEoCAQABAAAAAAAAAAAA5I4b5sYGwt0BIAEAAFdSTERFUlExAQAAAM7L+D4zqiKcenyIc9z6UCEH0AaQSYBj5f2YQetbDyEOtDwC7u0NbaCT5c6hHDc1i1E5EnRtsBXb4iQz3ae+W5AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPj57FTZzApPUA64+35N0kUcRwyfAwMXTs/aUyjYqPh1dtzv49QGbM/Ax0f6CI5Tp47fkBz22fx9/eABleLsWKFviRyzqslRgqgZdZeTbv0p2pOGJhty8r8euEW7oJ+2/tyqdOMDJIwzFwsAAAAHAAAAcGF5bG9hZPfskR2ko9r9MqMyTPDniocvbdNpL1HzfDtbM1efXo/XAQAAAAAAAAAAABAAAwAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAALAAAAAAAAAAAAAAAAAAAA');
const REQUEST = fromBase64('V1JMREVSUTEBAAAAzsv4PjOqIpx6fIhz3PpQIQfQBpBJgGPl/ZhB61sPIQ60PALu7Q1toJPlzqEcNzWLUTkSdG2wFdviJDPdp75bkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+PnsVNnMCk9QDrj7fk3SRRxHDJ8DAxdOz9pTKNio+HV23O/j1AZsz8DHR/oIjlOnjt+QHPbZ/H394AGV4uxYoW+JHLOqyVGCqBl1l5Nu/Snak4YmG3Lyvx64Rbugn7b+3Kp04wMkjDMXCwAAAAcAAABwYXlsb2Fk9+yRHaSj2v0yozJM8OeKhy9t02kvUfN8O1szV59ej9cBAAAAAAAAAAAAEAADAAAA');

describe('World application protocol v1', () => {
  it('decodes and authenticates a World-produced application manifest', () => {
    const manifest = decodeApplicationManifest(MANIFEST);

    assert.equal(manifest.applicationName, 'one-effect');
    assert.equal(manifest.applicationVersion, '1.0.0');
    assert.equal(manifest.boundaryStaticMachineAbiVersion, 1);
    assert.equal(manifest.worldApplicationAbiVersion, 1);
    assert.equal(manifest.internalHandlerIds.length, 0);
    assert.equal(manifest.residualEffects.length, 1);
    assert.equal(manifest.requiredHostCapabilities, 1n);
  });

  it('decodes a Frame and its exact pending EffectRequest', () => {
    const manifest = decodeApplicationManifest(MANIFEST);
    const frame = decodeFrame(PARENT_FRAME, manifest.limits);
    const request = decodeEffectRequest(REQUEST, manifest.limits);

    assert.equal(frame.status, FrameStatus.needsEffect);
    assert.equal(frame.sequence, 0n);
    assert.equal(frame.parentFrameId, null);
    assert.equal(frame.pendingEffect.payloadBytes.toString('hex'), '070000007061796c6f6164');
    assert.deepEqual(frame.pendingEffect.encodedBytes, request.encodedBytes);
  });

  it('encodes the exact World genesis StepInput bytes', () => {
    const manifest = decodeApplicationManifest(MANIFEST);
    const encoded = encodeStepInput({
      applicationId: manifest.applicationId,
      initialArgsBytes: new Uint8Array(0),
      fuel: 100n,
    }, manifest.limits);

    assert.deepEqual(encoded, GENESIS_INPUT);
    const decoded = decodeStepInput(encoded, manifest.limits);
    assert.equal(decoded.fuel, 100n);
    assert.equal(decoded.priorFrameBytes, null);
  });

  it('authors only a sealed EffectResult and validates it against the request', () => {
    const manifest = decodeApplicationManifest(MANIFEST);
    const request = decodeEffectRequest(REQUEST, manifest.limits);
    const value = Buffer.alloc(8);
    value.writeBigInt64LE(41n);
    const result = createEffectResult({
      requestId: request.requestId,
      status: EffectStatus.ok,
      resultSchemaId: request.resultSchemaId,
      resultBytes: value,
      attempt: 1,
    }, manifest.limits);
    const decoded = decodeEffectResult(result.encodedBytes, manifest.limits);

    assert.equal(validateEffectResultForRequest(request, decoded, manifest.limits), true);
    assert.equal(decoded.resultBytes.readBigInt64LE(), 41n);
  });

  it('rejects identity tampering and trailing bytes', () => {
    const tamperedManifest = Buffer.from(MANIFEST);
    tamperedManifest[12] ^= 1;
    assert.throws(() => decodeApplicationManifest(tamperedManifest), { code: 'ERR_APPLICATION_V1_MANIFEST_IDENTITY' });

    const tamperedFrame = Buffer.from(PARENT_FRAME);
    tamperedFrame[12] ^= 1;
    assert.throws(() => decodeFrame(tamperedFrame, decodeApplicationManifest(MANIFEST).limits), { code: 'ERR_APPLICATION_V1_FRAME_IDENTITY' });

    assert.throws(
      () => decodeEffectRequest(Buffer.concat([REQUEST, Buffer.from([0])]), decodeApplicationManifest(MANIFEST).limits),
      { code: 'ERR_APPLICATION_V1_TRAILING_BYTES' },
    );
  });

  it('mirrors World digest and causal-shape validation', () => {
    const manifest = decodeApplicationManifest(MANIFEST);
    assert.throws(
      () => decodeApplicationManifest(manifestWithZeroRoot()),
      { code: 'ERR_APPLICATION_V1_MANIFEST_IDENTITY' },
    );
    assert.throws(
      () => decodeApplicationManifest(manifestWithUndersizedDeclaredLimit()),
      { code: 'ERR_APPLICATION_V1_MANIFEST_LIMITS' },
    );
    assert.throws(
      () => decodeEffectRequest(resealedRequest((bytes) => bytes.fill(0, 128, 160)), manifest.limits),
      { code: 'ERR_APPLICATION_V1_REQUEST' },
    );
    assert.throws(
      () => decodeEffectRequest(resealedRequest((bytes) => bytes.fill(1, 76, 108)), manifest.limits),
      { code: 'ERR_APPLICATION_V1_REQUEST' },
    );

    const request = decodeEffectRequest(REQUEST, manifest.limits);
    const result = createEffectResult({
      requestId: request.requestId,
      status: EffectStatus.ok,
      resultSchemaId: request.resultSchemaId,
      resultBytes: Buffer.from('value'),
    }, manifest.limits);
    assert.throws(
      () => decodeEffectResult(resealedResultWithZeroSchema(result.encodedBytes), manifest.limits),
      { code: 'ERR_APPLICATION_V1_RESULT' },
    );
    assert.throws(
      () => decodeFrame(genesisFrameWithAcceptedResult(), manifest.limits),
      { code: 'ERR_APPLICATION_V1_FRAME_PARENT' },
    );
  });

  it('permits failure bytes only on failed Frames', () => {
    assert.throws(
      () => decodeFrame(cancelledFrameWithFailure(), decodeApplicationManifest(MANIFEST).limits),
      { code: 'ERR_APPLICATION_V1_FRAME_SHAPE' },
    );
  });
});

describe('World application WASM inspection', () => {
  it('requires one bounded wasm32 memory', () => {
    const bounded = Buffer.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x05, 0x04, 0x01, 0x01, 0x01, 0x02,
    ]);
    const unbounded = Buffer.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x05, 0x03, 0x01, 0x00, 0x01,
    ]);

    assert.deepEqual(inspectApplicationWasm(bounded).memory, {
      minimumPages: 1,
      maximumPages: 2,
      minimumBytes: 65_536,
      maximumBytes: 131_072,
    });
    assert.throws(() => inspectApplicationWasm(unbounded), { code: 'ERR_APPLICATION_V1_WASM_MEMORY_LIMITS' });
  });
});

function fromBase64(value) {
  return Buffer.from(value, 'base64');
}

function cancelledFrameWithFailure() {
  return frameFixture({
    status: FrameStatus.cancelled,
    failure: Buffer.from('failure'),
  });
}

function genesisFrameWithAcceptedResult() {
  return frameFixture({
    status: FrameStatus.cancelled,
    acceptedResultId: Buffer.alloc(32, 2),
  });
}

function frameFixture({
  status,
  failure = null,
  acceptedResultId = null,
}) {
  const u32 = (value) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
  };
  const u64 = (value) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(value);
    return bytes;
  };
  const canonical = Buffer.concat([
    Buffer.from('WRLDFRM1', 'ascii'),
    u32(1),
    Buffer.alloc(32),
    Buffer.alloc(32, 1),
    Buffer.from([0]),
    u64(0n),
    u32(0),
    Buffer.from([0]),
    acceptedResultId === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), acceptedResultId]),
    Buffer.from([status]),
    Buffer.from([0]),
    Buffer.from([0]),
    failure === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), u32(failure.length), failure]),
    u64(0n),
    u64(0n),
    u64(0n),
    u64(0n),
    u64(0n),
    u64(0n),
  ]);
  const frameId = createHash('sha256')
    .update('world.frame.v1')
    .update(Buffer.from([0]))
    .update(canonical)
    .digest();
  frameId.copy(canonical, 12);
  return canonical;
}

function manifestWithZeroRoot() {
  const manifest = decodeApplicationManifest(MANIFEST);
  const bytes = Buffer.from(MANIFEST);
  const offset = bytes.indexOf(manifest.rootProgramId, 44);
  assert.notEqual(offset, -1);
  bytes.fill(0, offset, offset + 32);
  resealSemantic(bytes, 'world.application-manifest.v1', 12);
  return bytes;
}

function manifestWithUndersizedDeclaredLimit() {
  const bytes = Buffer.from(MANIFEST);
  bytes.writeUInt32LE(1, bytes.length - 68);
  resealSemantic(bytes, 'world.application-manifest.v1', 12);
  return bytes;
}

function resealedRequest(mutate) {
  const bytes = Buffer.from(REQUEST);
  mutate(bytes);
  const payloadLength = bytes.readUInt32LE(225);
  const idempotencyOffset = 229 + payloadLength;
  bytes.fill(0, 12, 44);
  bytes.fill(0, idempotencyOffset, idempotencyOffset + 32);
  const requestId = semanticDigest('world.effect-request.v1', bytes);
  requestId.copy(bytes, 12);
  const idempotencyKey = semanticDigestParts('world.idempotency-key.v1', [
    requestId,
    bytes.subarray(128, 160),
    bytes.subarray(44, 76),
  ]);
  idempotencyKey.copy(bytes, idempotencyOffset);
  return bytes;
}

function resealedResultWithZeroSchema(encoded) {
  const bytes = Buffer.from(encoded);
  bytes.fill(0, 77, 109);
  resealSemantic(bytes, 'world.effect-result.v1', 12);
  return bytes;
}

function resealSemantic(bytes, domain, identityOffset) {
  bytes.fill(0, identityOffset, identityOffset + 32);
  semanticDigest(domain, bytes).copy(bytes, identityOffset);
}

function semanticDigest(domain, bytes) {
  return semanticDigestParts(domain, [bytes]);
}

function semanticDigestParts(domain, parts) {
  const hasher = createHash('sha256')
    .update(domain)
    .update(Buffer.from([0]));
  for (const part of parts) hasher.update(part);
  return hasher.digest();
}
