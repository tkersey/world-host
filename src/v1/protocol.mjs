import { createHash } from 'node:crypto';

import { assertBytes, fail } from './errors.mjs';

export const APPLICATION_FORMAT_VERSION = 1;
export const APPLICATION_ABI_VERSION = 1;
export const DIGEST_LENGTH = 32;
export const ZERO_DIGEST = Buffer.alloc(DIGEST_LENGTH);

export const EffectStatus = Object.freeze({
  ok: 0,
  rejected: 1,
  failed: 2,
  deferred: 3,
  cancelled: 4,
});

export const FrameStatus = Object.freeze({
  needsEffect: 0,
  completed: 1,
  failed: 2,
  yieldedFuel: 3,
  cancelled: 4,
});

export const DEFAULT_ADMISSION_LIMITS = Object.freeze({
  maximumManifestBytes: 1 << 20,
  maximumInitialArgsBytes: 1 << 20,
  maximumStateBytes: 1 << 20,
  maximumPayloadBytes: 1 << 20,
  maximumResultBytes: 1 << 20,
  maximumHostClaimBytes: 64 << 10,
  maximumHostMetadataBytes: 64 << 10,
  maximumFailureBytes: 64 << 10,
  maximumNameBytes: 4 << 10,
  maximumInternalHandlers: 256,
  maximumResidualEffects: 256,
  maximumFuelPerStep: 100_000n,
  maximumFrameDepth: 64,
  maximumProviderDepth: 8,
});

const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function decodeApplicationManifest(encoded, admission = DEFAULT_ADMISSION_LIMITS) {
  const limits = normalizeLimits(admission, 'admission limits');
  const bytes = boundedBytes(encoded, limits.maximumManifestBytes, 'ApplicationManifest');
  const reader = new Reader(bytes);
  reader.magic('WRLDMNF1');
  reader.version();
  const manifest = {
    applicationId: reader.digest(),
    applicationNameBytes: reader.lenBytes(limits.maximumNameBytes, 'application name'),
    applicationVersionBytes: reader.lenBytes(limits.maximumNameBytes, 'application version'),
    boundaryPackageVersionBytes: reader.lenBytes(limits.maximumNameBytes, 'Boundary package version'),
    boundaryStaticMachineAbiVersion: reader.u32(),
    worldPackageVersionBytes: null,
    worldApplicationAbiVersion: 0,
    rootProgramId: null,
    internalHandlerIds: [],
    residualEffects: [],
    limits: null,
    requiredHostCapabilities: 0n,
  };
  manifest.worldPackageVersionBytes = reader.lenBytes(limits.maximumNameBytes, 'World package version');
  manifest.worldApplicationAbiVersion = reader.u32();
  manifest.rootProgramId = reader.digest();
  const handlerCount = reader.count(limits.maximumInternalHandlers, 'internal handler count');
  for (let index = 0; index < handlerCount; index += 1) manifest.internalHandlerIds.push(reader.digest());
  const residualCount = reader.count(limits.maximumResidualEffects, 'residual effect count');
  for (let index = 0; index < residualCount; index += 1) {
    manifest.residualEffects.push({
      interfaceId: reader.digest(),
      siteId: reader.u64(),
      payloadSchemaId: reader.digest(),
      resultSchemaId: reader.digest(),
      allowedStatuses: reader.u8(),
      authorityRequirements: reader.u64(),
    });
  }
  manifest.limits = readLimits(reader);
  manifest.requiredHostCapabilities = reader.u64();
  reader.finish();

  manifest.applicationName = decodeRequiredText(manifest.applicationNameBytes, 'application name');
  manifest.applicationVersion = decodeRequiredText(manifest.applicationVersionBytes, 'application version');
  manifest.boundaryPackageVersion = decodeRequiredText(manifest.boundaryPackageVersionBytes, 'Boundary package version');
  manifest.worldPackageVersion = decodeRequiredText(manifest.worldPackageVersionBytes, 'World package version');
  validateManifest(manifest, limits, bytes.length);
  return freezeRecord(manifest, bytes);
}

export function decodeEffectRequest(encoded, limits = DEFAULT_ADMISSION_LIMITS) {
  const admitted = normalizeLimits(limits, 'effect limits');
  const maximum = checkedAggregate([admitted.maximumPayloadBytes], 512, 'EffectRequest');
  const bytes = boundedBytes(encoded, maximum, 'EffectRequest');
  const reader = new Reader(bytes);
  reader.magic('WRLDERQ1');
  reader.version();
  const request = {
    requestId: reader.digest(),
    applicationId: reader.digest(),
    parentFrameId: reader.digest(),
    sequence: reader.u64(),
    ordinal: reader.u32(),
    siteId: reader.u64(),
    interfaceId: reader.digest(),
    payloadSchemaId: reader.digest(),
    resultSchemaId: reader.digest(),
    allowedStatuses: reader.u8(),
    payloadBytes: reader.lenBytes(admitted.maximumPayloadBytes, 'effect payload'),
    idempotencyKey: reader.digest(),
    authorityRequirements: reader.u64(),
    limits: {
      maximumResultBytes: reader.u32(),
      maximumAttempts: reader.u32(),
    },
  };
  reader.finish();
  validateRequest(request, admitted);
  return freezeRecord(request, bytes);
}

export function createEffectResult({
  requestId,
  status,
  resultSchemaId,
  resultBytes = null,
  hostClaims = new Uint8Array(0),
  attempt = 1,
}, limits = DEFAULT_ADMISSION_LIMITS) {
  const admitted = normalizeLimits(limits, 'effect limits');
  const result = {
    resultId: Buffer.from(ZERO_DIGEST),
    requestId: digest(requestId, 'requestId'),
    status: effectStatus(status),
    resultSchemaId: digest(resultSchemaId, 'resultSchemaId'),
    resultBytes: optionalOwnedBytes(resultBytes, 'resultBytes'),
    hostClaims: ownedBytes(hostClaims, 'hostClaims'),
    attempt: u32Number(attempt, 'attempt'),
  };
  validateResultShape(result, admitted, false);
  result.resultId = semanticDigest('world.effect-result.v1', encodeEffectResultCanonical(result, false));
  const bytes = encodeEffectResultCanonical(result, true);
  return freezeRecord(result, bytes);
}

export function decodeEffectResult(encoded, limits = DEFAULT_ADMISSION_LIMITS) {
  const admitted = normalizeLimits(limits, 'effect limits');
  const maximum = checkedAggregate([
    admitted.maximumResultBytes,
    admitted.maximumHostClaimBytes,
  ], 256, 'EffectResult');
  const bytes = boundedBytes(encoded, maximum, 'EffectResult');
  const reader = new Reader(bytes);
  reader.magic('WRLDERS1');
  reader.version();
  const result = {
    resultId: reader.digest(),
    requestId: reader.digest(),
    status: reader.effectStatus(),
    resultSchemaId: reader.digest(),
    resultBytes: reader.optionalBytes(admitted.maximumResultBytes, 'effect result'),
    hostClaims: reader.lenBytes(admitted.maximumHostClaimBytes, 'host claims'),
    attempt: reader.u32(),
  };
  reader.finish();
  validateResultShape(result, admitted, true);
  return freezeRecord(result, bytes);
}

export function decodeFrame(encoded, limits = DEFAULT_ADMISSION_LIMITS) {
  const admitted = normalizeLimits(limits, 'frame limits');
  const maximum = checkedAggregate([
    admitted.maximumStateBytes,
    admitted.maximumPayloadBytes,
    admitted.maximumResultBytes,
    admitted.maximumFailureBytes,
  ], 1024, 'Frame');
  const bytes = boundedBytes(encoded, maximum, 'Frame');
  const reader = new Reader(bytes);
  reader.magic('WRLDFRM1');
  reader.version();
  const frame = {
    frameId: reader.digest(),
    applicationId: reader.digest(),
    parentFrameId: reader.optionalDigest(),
    sequence: reader.u64(),
    stateBytes: reader.lenBytes(admitted.maximumStateBytes, 'application state'),
    pendingEffect: null,
    acceptedEffectResultId: null,
    status: 0,
    finalResultSchemaId: null,
    finalResultBytes: null,
    failure: null,
    resourceCounters: null,
    semanticWarnings: 0n,
  };
  if (reader.bool()) {
    const requestMaximum = checkedAggregate([admitted.maximumPayloadBytes], 512, 'EffectRequest');
    frame.pendingEffect = decodeEffectRequest(reader.lenBytes(requestMaximum, 'pending EffectRequest'), admitted);
  }
  frame.acceptedEffectResultId = reader.optionalDigest();
  frame.status = reader.frameStatus();
  frame.finalResultSchemaId = reader.optionalDigest();
  frame.finalResultBytes = reader.optionalBytes(admitted.maximumResultBytes, 'final result');
  frame.failure = reader.optionalBytes(admitted.maximumFailureBytes, 'failure');
  frame.resourceCounters = {
    instructions: reader.u64(),
    continuationOperations: reader.u64(),
    internalHandlerCalls: reader.u64(),
    externalEffects: reader.u64(),
    valueBytes: reader.u64(),
  };
  frame.semanticWarnings = reader.u64();
  reader.finish();
  validateFrame(frame, admitted);
  return freezeRecord(frame, bytes);
}

export function encodeStepInput({
  applicationId,
  expectedParentFrameId = null,
  priorFrameBytes = null,
  initialArgsBytes = null,
  effectResult = null,
  fuel,
  hostMetadata = new Uint8Array(0),
}, limits = DEFAULT_ADMISSION_LIMITS) {
  const admitted = normalizeLimits(limits, 'step limits');
  const result = effectResult === null
    ? null
    : effectResult.encodedBytes instanceof Uint8Array
      ? decodeEffectResult(effectResult.encodedBytes, admitted)
      : effectResult instanceof Uint8Array
        ? decodeEffectResult(effectResult, admitted)
        : createEffectResult(effectResult, admitted);
  const input = {
    applicationId: digest(applicationId, 'applicationId'),
    expectedParentFrameId: optionalDigest(expectedParentFrameId, 'expectedParentFrameId'),
    priorFrameBytes: optionalOwnedBytes(priorFrameBytes, 'priorFrameBytes'),
    initialArgsBytes: optionalOwnedBytes(initialArgsBytes, 'initialArgsBytes'),
    effectResult: result,
    fuel: u64BigInt(fuel, 'fuel'),
    hostMetadata: ownedBytes(hostMetadata, 'hostMetadata'),
  };
  validateStepInput(input, admitted);
  const writer = new Writer();
  writer.magic('WRLDSTP1');
  writer.u32(APPLICATION_FORMAT_VERSION);
  writer.digest(input.applicationId);
  writer.optionalDigest(input.expectedParentFrameId);
  writer.optionalBytes(input.priorFrameBytes);
  writer.optionalBytes(input.initialArgsBytes);
  writer.bool(input.effectResult !== null);
  if (input.effectResult !== null) writer.lenBytes(input.effectResult.encodedBytes);
  writer.u64(input.fuel);
  writer.lenBytes(input.hostMetadata);
  return writer.finish();
}

export function decodeStepInput(encoded, limits = DEFAULT_ADMISSION_LIMITS) {
  const admitted = normalizeLimits(limits, 'step limits');
  const maximum = checkedAggregate([
    admitted.maximumStateBytes,
    admitted.maximumPayloadBytes,
    admitted.maximumResultBytes,
    admitted.maximumFailureBytes,
    admitted.maximumInitialArgsBytes,
    admitted.maximumResultBytes,
    admitted.maximumHostClaimBytes,
    admitted.maximumHostMetadataBytes,
  ], 4096, 'StepInput');
  const bytes = boundedBytes(encoded, maximum, 'StepInput');
  const reader = new Reader(bytes);
  reader.magic('WRLDSTP1');
  reader.version();
  const frameMaximum = checkedAggregate([
    admitted.maximumStateBytes,
    admitted.maximumPayloadBytes,
    admitted.maximumResultBytes,
    admitted.maximumFailureBytes,
  ], 1024, 'prior Frame');
  const resultMaximum = checkedAggregate([
    admitted.maximumResultBytes,
    admitted.maximumHostClaimBytes,
  ], 256, 'EffectResult');
  const input = {
    applicationId: reader.digest(),
    expectedParentFrameId: reader.optionalDigest(),
    priorFrameBytes: reader.optionalBytes(frameMaximum, 'prior Frame'),
    initialArgsBytes: reader.optionalBytes(admitted.maximumInitialArgsBytes, 'initial arguments'),
    effectResult: reader.bool() ? decodeEffectResult(reader.lenBytes(resultMaximum, 'EffectResult'), admitted) : null,
    fuel: reader.u64(),
    hostMetadata: reader.lenBytes(admitted.maximumHostMetadataBytes, 'host metadata'),
  };
  reader.finish();
  validateStepInput(input, admitted);
  return freezeRecord(input, bytes);
}

export function validateEffectResultForRequest(request, result, limits = DEFAULT_ADMISSION_LIMITS) {
  const admitted = normalizeLimits(limits, 'effect limits');
  validateRequest(request, admitted);
  validateResultShape(result, admitted, true);
  if (!sameBytes(request.requestId, result.requestId)) fail('ERR_APPLICATION_V1_RESULT_TARGET');
  if ((request.allowedStatuses & (1 << result.status)) === 0) fail('ERR_APPLICATION_V1_RESULT_STATUS');
  if (!sameBytes(request.resultSchemaId, result.resultSchemaId)) fail('ERR_APPLICATION_V1_RESULT_SCHEMA');
  if (result.attempt > request.limits.maximumAttempts) fail('ERR_APPLICATION_V1_RESULT_ATTEMPT');
  if (result.resultBytes !== null && result.resultBytes.length > request.limits.maximumResultBytes) {
    fail('ERR_APPLICATION_V1_RESULT_LIMIT');
  }
  return true;
}

function validateManifest(manifest, admission, encodedLength) {
  const declared = normalizeLimits(manifest.limits, 'declared application limits');
  if (!limitsAdmit(admission, declared)) fail('ERR_APPLICATION_V1_MANIFEST_LIMITS');
  if (encodedLength > declared.maximumManifestBytes) fail('ERR_APPLICATION_V1_MANIFEST_LIMITS');
  if (manifest.worldApplicationAbiVersion !== APPLICATION_ABI_VERSION || manifest.boundaryStaticMachineAbiVersion === 0) {
    fail('ERR_APPLICATION_V1_MANIFEST_ABI');
  }
  if (isZeroDigest(manifest.rootProgramId)) fail('ERR_APPLICATION_V1_MANIFEST_IDENTITY');
  for (const field of [
    manifest.applicationNameBytes,
    manifest.applicationVersionBytes,
    manifest.boundaryPackageVersionBytes,
    manifest.worldPackageVersionBytes,
  ]) {
    if (field.length === 0 || field.length > declared.maximumNameBytes) fail('ERR_APPLICATION_V1_MANIFEST_NAME');
  }
  if (manifest.internalHandlerIds.length > declared.maximumInternalHandlers ||
      manifest.residualEffects.length > declared.maximumResidualEffects) {
    fail('ERR_APPLICATION_V1_MANIFEST_LIMITS');
  }
  for (let index = 1; index < manifest.internalHandlerIds.length; index += 1) {
    if (Buffer.compare(manifest.internalHandlerIds[index - 1], manifest.internalHandlerIds[index]) >= 0) {
      fail('ERR_APPLICATION_V1_MANIFEST_HANDLER_ORDER');
    }
  }
  for (const handlerId of manifest.internalHandlerIds) {
    if (isZeroDigest(handlerId)) fail('ERR_APPLICATION_V1_MANIFEST_IDENTITY');
  }
  let required = 0n;
  for (let index = 0; index < manifest.residualEffects.length; index += 1) {
    const effect = manifest.residualEffects[index];
    if (isZeroDigest(effect.interfaceId) || isZeroDigest(effect.payloadSchemaId) ||
        isZeroDigest(effect.resultSchemaId)) {
      fail('ERR_APPLICATION_V1_MANIFEST_IDENTITY');
    }
    validateAllowedStatuses(effect.allowedStatuses);
    required |= effect.authorityRequirements;
    if (index > 0 && compareResidual(manifest.residualEffects[index - 1], effect) >= 0) {
      fail('ERR_APPLICATION_V1_MANIFEST_EFFECT_ORDER');
    }
  }
  if (required !== manifest.requiredHostCapabilities) fail('ERR_APPLICATION_V1_MANIFEST_CAPABILITIES');
  const expectedId = semanticDigest('world.application-manifest.v1', encodeManifestCanonical(manifest, false));
  if (!sameBytes(expectedId, manifest.applicationId)) fail('ERR_APPLICATION_V1_MANIFEST_IDENTITY');
}

function validateRequest(request, limits) {
  validateAllowedStatuses(request.allowedStatuses);
  if (isZeroDigest(request.applicationId) || isZeroDigest(request.interfaceId) ||
      isZeroDigest(request.payloadSchemaId) || isZeroDigest(request.resultSchemaId)) {
    fail('ERR_APPLICATION_V1_REQUEST');
  }
  if ((request.sequence === 0n) !== isZeroDigest(request.parentFrameId)) {
    fail('ERR_APPLICATION_V1_REQUEST');
  }
  if (request.ordinal !== 0 || request.payloadBytes.length > limits.maximumPayloadBytes) fail('ERR_APPLICATION_V1_REQUEST');
  if (request.limits.maximumResultBytes === 0 || request.limits.maximumResultBytes > limits.maximumResultBytes ||
      request.limits.maximumAttempts === 0) {
    fail('ERR_APPLICATION_V1_REQUEST_LIMITS');
  }
  const expectedRequestId = semanticDigest('world.effect-request.v1', encodeRequestCanonical(request, false));
  if (!sameBytes(expectedRequestId, request.requestId)) fail('ERR_APPLICATION_V1_REQUEST_IDENTITY');
  const expectedKey = semanticDigestParts('world.idempotency-key.v1', [
    request.requestId,
    request.interfaceId,
    request.applicationId,
  ]);
  if (!sameBytes(expectedKey, request.idempotencyKey)) fail('ERR_APPLICATION_V1_IDEMPOTENCY_IDENTITY');
}

function validateResultShape(result, limits, checkIdentity) {
  effectStatus(result.status);
  if (isZeroDigest(result.requestId) || isZeroDigest(result.resultSchemaId)) {
    fail('ERR_APPLICATION_V1_RESULT');
  }
  if (result.attempt === 0 || result.hostClaims.length > limits.maximumHostClaimBytes) fail('ERR_APPLICATION_V1_RESULT');
  if (result.resultBytes !== null && result.resultBytes.length > limits.maximumResultBytes) fail('ERR_APPLICATION_V1_RESULT_LIMIT');
  if (result.status === EffectStatus.ok && result.resultBytes === null) fail('ERR_APPLICATION_V1_RESULT');
  if (result.status === EffectStatus.deferred && result.resultBytes !== null) fail('ERR_APPLICATION_V1_RESULT');
  if (checkIdentity) {
    const expected = semanticDigest('world.effect-result.v1', encodeEffectResultCanonical(result, false));
    if (!sameBytes(expected, result.resultId)) fail('ERR_APPLICATION_V1_RESULT_IDENTITY');
  }
}

function validateFrame(frame, limits) {
  if (isZeroDigest(frame.applicationId)) fail('ERR_APPLICATION_V1_FRAME_SHAPE');
  if (frame.stateBytes.length > limits.maximumStateBytes ||
      (frame.finalResultBytes !== null && frame.finalResultBytes.length > limits.maximumResultBytes) ||
      (frame.failure !== null && frame.failure.length > limits.maximumFailureBytes)) {
    fail('ERR_APPLICATION_V1_FRAME_LIMIT');
  }
  if (frame.sequence === 0n) {
    if (frame.parentFrameId !== null || frame.acceptedEffectResultId !== null) {
      fail('ERR_APPLICATION_V1_FRAME_PARENT');
    }
  } else if (frame.parentFrameId === null || isZeroDigest(frame.parentFrameId)) {
    fail('ERR_APPLICATION_V1_FRAME_PARENT');
  }
  if (frame.acceptedEffectResultId !== null && isZeroDigest(frame.acceptedEffectResultId)) {
    fail('ERR_APPLICATION_V1_FRAME_SHAPE');
  }
  if (frame.finalResultSchemaId !== null && isZeroDigest(frame.finalResultSchemaId)) {
    fail('ERR_APPLICATION_V1_FRAME_SHAPE');
  }
  switch (frame.status) {
    case FrameStatus.needsEffect: {
      const request = frame.pendingEffect;
      if (request === null || frame.finalResultSchemaId !== null || frame.finalResultBytes !== null || frame.failure !== null || frame.stateBytes.length === 0) {
        fail('ERR_APPLICATION_V1_FRAME_SHAPE');
      }
      if (request.ordinal !== 0 || request.sequence !== frame.sequence || !sameBytes(request.applicationId, frame.applicationId)) {
        fail('ERR_APPLICATION_V1_FRAME_REQUEST');
      }
      const expectedParent = frame.parentFrameId ?? ZERO_DIGEST;
      if (!sameBytes(request.parentFrameId, expectedParent)) fail('ERR_APPLICATION_V1_FRAME_REQUEST');
      break;
    }
    case FrameStatus.completed:
      if (frame.pendingEffect !== null || frame.failure !== null || frame.finalResultSchemaId === null || frame.finalResultBytes === null) {
        fail('ERR_APPLICATION_V1_FRAME_SHAPE');
      }
      break;
    case FrameStatus.failed:
      if (frame.pendingEffect !== null || frame.finalResultSchemaId !== null || frame.finalResultBytes !== null || frame.failure === null) {
        fail('ERR_APPLICATION_V1_FRAME_SHAPE');
      }
      break;
    case FrameStatus.yieldedFuel:
      if (frame.pendingEffect !== null || frame.finalResultSchemaId !== null || frame.finalResultBytes !== null || frame.failure !== null || frame.stateBytes.length === 0) {
        fail('ERR_APPLICATION_V1_FRAME_SHAPE');
      }
      break;
    case FrameStatus.cancelled:
      if (frame.pendingEffect !== null || frame.finalResultSchemaId !== null ||
          frame.finalResultBytes !== null || frame.failure !== null) {
        fail('ERR_APPLICATION_V1_FRAME_SHAPE');
      }
      break;
    default:
      fail('ERR_APPLICATION_V1_FRAME_STATUS');
  }
  const expected = semanticDigest('world.frame.v1', encodeFrameCanonical(frame, false));
  if (!sameBytes(expected, frame.frameId)) fail('ERR_APPLICATION_V1_FRAME_IDENTITY');
}

function validateStepInput(input, limits) {
  if (input.fuel === 0n || input.fuel > limits.maximumFuelPerStep || input.hostMetadata.length > limits.maximumHostMetadataBytes) {
    fail('ERR_APPLICATION_V1_STEP_LIMIT');
  }
  const genesis = input.priorFrameBytes === null;
  if (genesis) {
    if (input.expectedParentFrameId !== null || input.initialArgsBytes === null || input.effectResult !== null) {
      fail('ERR_APPLICATION_V1_STEP_SHAPE');
    }
  } else if (input.expectedParentFrameId === null || input.initialArgsBytes !== null) {
    fail('ERR_APPLICATION_V1_STEP_SHAPE');
  }
  if (input.priorFrameBytes !== null) {
    const maximum = checkedAggregate([
      limits.maximumStateBytes,
      limits.maximumPayloadBytes,
      limits.maximumResultBytes,
      limits.maximumFailureBytes,
    ], 1024, 'prior Frame');
    if (input.priorFrameBytes.length > maximum) fail('ERR_APPLICATION_V1_STEP_LIMIT');
  }
  if (input.initialArgsBytes !== null && input.initialArgsBytes.length > limits.maximumInitialArgsBytes) {
    fail('ERR_APPLICATION_V1_STEP_LIMIT');
  }
  if (input.effectResult !== null) validateResultShape(input.effectResult, limits, true);
}

function encodeRequestCanonical(request, includeIdentity) {
  const writer = new Writer();
  writer.magic('WRLDERQ1');
  writer.u32(APPLICATION_FORMAT_VERSION);
  writer.digest(includeIdentity ? request.requestId : ZERO_DIGEST);
  writer.digest(request.applicationId);
  writer.digest(request.parentFrameId);
  writer.u64(request.sequence);
  writer.u32(request.ordinal);
  writer.u64(request.siteId);
  writer.digest(request.interfaceId);
  writer.digest(request.payloadSchemaId);
  writer.digest(request.resultSchemaId);
  writer.u8(request.allowedStatuses);
  writer.lenBytes(request.payloadBytes);
  writer.digest(includeIdentity ? request.idempotencyKey : ZERO_DIGEST);
  writer.u64(request.authorityRequirements);
  writer.u32(request.limits.maximumResultBytes);
  writer.u32(request.limits.maximumAttempts);
  return writer.finish();
}

function encodeEffectResultCanonical(result, includeIdentity) {
  const writer = new Writer();
  writer.magic('WRLDERS1');
  writer.u32(APPLICATION_FORMAT_VERSION);
  writer.digest(includeIdentity ? result.resultId : ZERO_DIGEST);
  writer.digest(result.requestId);
  writer.u8(result.status);
  writer.digest(result.resultSchemaId);
  writer.optionalBytes(result.resultBytes);
  writer.lenBytes(result.hostClaims);
  writer.u32(result.attempt);
  return writer.finish();
}

function encodeFrameCanonical(frame, includeIdentity) {
  const writer = new Writer();
  writer.magic('WRLDFRM1');
  writer.u32(APPLICATION_FORMAT_VERSION);
  writer.digest(includeIdentity ? frame.frameId : ZERO_DIGEST);
  writer.digest(frame.applicationId);
  writer.optionalDigest(frame.parentFrameId);
  writer.u64(frame.sequence);
  writer.lenBytes(frame.stateBytes);
  writer.bool(frame.pendingEffect !== null);
  if (frame.pendingEffect !== null) writer.lenBytes(frame.pendingEffect.encodedBytes);
  writer.optionalDigest(frame.acceptedEffectResultId);
  writer.u8(frame.status);
  writer.optionalDigest(frame.finalResultSchemaId);
  writer.optionalBytes(frame.finalResultBytes);
  writer.optionalBytes(frame.failure);
  writer.u64(frame.resourceCounters.instructions);
  writer.u64(frame.resourceCounters.continuationOperations);
  writer.u64(frame.resourceCounters.internalHandlerCalls);
  writer.u64(frame.resourceCounters.externalEffects);
  writer.u64(frame.resourceCounters.valueBytes);
  writer.u64(frame.semanticWarnings);
  return writer.finish();
}

function encodeManifestCanonical(manifest, includeIdentity) {
  const writer = new Writer();
  writer.magic('WRLDMNF1');
  writer.u32(APPLICATION_FORMAT_VERSION);
  writer.digest(includeIdentity ? manifest.applicationId : ZERO_DIGEST);
  writer.lenBytes(manifest.applicationNameBytes);
  writer.lenBytes(manifest.applicationVersionBytes);
  writer.lenBytes(manifest.boundaryPackageVersionBytes);
  writer.u32(manifest.boundaryStaticMachineAbiVersion);
  writer.lenBytes(manifest.worldPackageVersionBytes);
  writer.u32(manifest.worldApplicationAbiVersion);
  writer.digest(manifest.rootProgramId);
  writer.u32(manifest.internalHandlerIds.length);
  for (const handlerId of manifest.internalHandlerIds) writer.digest(handlerId);
  writer.u32(manifest.residualEffects.length);
  for (const effect of manifest.residualEffects) {
    writer.digest(effect.interfaceId);
    writer.u64(effect.siteId);
    writer.digest(effect.payloadSchemaId);
    writer.digest(effect.resultSchemaId);
    writer.u8(effect.allowedStatuses);
    writer.u64(effect.authorityRequirements);
  }
  writeLimits(writer, manifest.limits);
  writer.u64(manifest.requiredHostCapabilities);
  return writer.finish();
}

function readLimits(reader) {
  return normalizeLimits({
    maximumManifestBytes: reader.u32(),
    maximumInitialArgsBytes: reader.u32(),
    maximumStateBytes: reader.u32(),
    maximumPayloadBytes: reader.u32(),
    maximumResultBytes: reader.u32(),
    maximumHostClaimBytes: reader.u32(),
    maximumHostMetadataBytes: reader.u32(),
    maximumFailureBytes: reader.u32(),
    maximumNameBytes: reader.u32(),
    maximumInternalHandlers: reader.u32(),
    maximumResidualEffects: reader.u32(),
    maximumFuelPerStep: reader.u64(),
    maximumFrameDepth: reader.u32(),
    maximumProviderDepth: reader.u32(),
  }, 'declared application limits');
}

function writeLimits(writer, limits) {
  writer.u32(limits.maximumManifestBytes);
  writer.u32(limits.maximumInitialArgsBytes);
  writer.u32(limits.maximumStateBytes);
  writer.u32(limits.maximumPayloadBytes);
  writer.u32(limits.maximumResultBytes);
  writer.u32(limits.maximumHostClaimBytes);
  writer.u32(limits.maximumHostMetadataBytes);
  writer.u32(limits.maximumFailureBytes);
  writer.u32(limits.maximumNameBytes);
  writer.u32(limits.maximumInternalHandlers);
  writer.u32(limits.maximumResidualEffects);
  writer.u64(limits.maximumFuelPerStep);
  writer.u32(limits.maximumFrameDepth);
  writer.u32(limits.maximumProviderDepth);
}

function normalizeLimits(value, label) {
  if (!value || typeof value !== 'object') fail('ERR_APPLICATION_V1_LIMITS', `${label} are required`);
  const limits = {
    maximumManifestBytes: positiveU32(value.maximumManifestBytes, `${label}.maximumManifestBytes`),
    maximumInitialArgsBytes: positiveU32(value.maximumInitialArgsBytes, `${label}.maximumInitialArgsBytes`),
    maximumStateBytes: positiveU32(value.maximumStateBytes, `${label}.maximumStateBytes`),
    maximumPayloadBytes: positiveU32(value.maximumPayloadBytes, `${label}.maximumPayloadBytes`),
    maximumResultBytes: positiveU32(value.maximumResultBytes, `${label}.maximumResultBytes`),
    maximumHostClaimBytes: u32Number(value.maximumHostClaimBytes, `${label}.maximumHostClaimBytes`),
    maximumHostMetadataBytes: u32Number(value.maximumHostMetadataBytes, `${label}.maximumHostMetadataBytes`),
    maximumFailureBytes: u32Number(value.maximumFailureBytes, `${label}.maximumFailureBytes`),
    maximumNameBytes: positiveU32(value.maximumNameBytes, `${label}.maximumNameBytes`),
    maximumInternalHandlers: u32Number(value.maximumInternalHandlers, `${label}.maximumInternalHandlers`),
    maximumResidualEffects: u32Number(value.maximumResidualEffects, `${label}.maximumResidualEffects`),
    maximumFuelPerStep: u64BigInt(value.maximumFuelPerStep, `${label}.maximumFuelPerStep`),
    maximumFrameDepth: positiveU32(value.maximumFrameDepth, `${label}.maximumFrameDepth`),
    maximumProviderDepth: positiveU32(value.maximumProviderDepth, `${label}.maximumProviderDepth`),
  };
  if (limits.maximumFuelPerStep === 0n) fail('ERR_APPLICATION_V1_LIMITS', `${label}.maximumFuelPerStep must be positive`);
  return limits;
}

function limitsAdmit(admission, declared) {
  for (const key of Object.keys(admission)) {
    if (declared[key] > admission[key]) return false;
  }
  return true;
}

function validateAllowedStatuses(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 0x1f) fail('ERR_APPLICATION_V1_ALLOWED_STATUSES');
}

function compareResidual(left, right) {
  const interfaceOrder = Buffer.compare(left.interfaceId, right.interfaceId);
  if (interfaceOrder !== 0) return interfaceOrder;
  return left.siteId < right.siteId ? -1 : left.siteId > right.siteId ? 1 : 0;
}

function semanticDigest(domain, canonicalBytes) {
  return semanticDigestParts(domain, [canonicalBytes]);
}

function semanticDigestParts(domain, parts) {
  const hasher = createHash('sha256');
  hasher.update(domain);
  hasher.update(Buffer.from([0]));
  for (const part of parts) hasher.update(part);
  return hasher.digest();
}

function decodeRequiredText(value, label) {
  try {
    return textDecoder.decode(value);
  } catch {
    fail('ERR_APPLICATION_V1_MANIFEST_UTF8', `${label} is not UTF-8`);
  }
}

function effectStatus(value) {
  if (!Number.isInteger(value) || value < EffectStatus.ok || value > EffectStatus.cancelled) {
    fail('ERR_APPLICATION_V1_EFFECT_STATUS');
  }
  return value;
}

function checkedAggregate(values, extra, label) {
  let total = extra;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total) || total > 0xffffffff) fail('ERR_APPLICATION_V1_LIMITS', `${label} aggregate limit overflows u32`);
  }
  return total;
}

function freezeRecord(record, encoded) {
  return Object.freeze({ ...record, encodedBytes: Buffer.from(encoded) });
}

function ownedBytes(value, label) {
  return Buffer.from(assertBytes(value, label));
}

function optionalOwnedBytes(value, label) {
  return value === null ? null : ownedBytes(value, label);
}

function digest(value, label) {
  const result = ownedBytes(value, label);
  if (result.length !== DIGEST_LENGTH) fail('ERR_APPLICATION_V1_DIGEST', `${label} must be 32 bytes`);
  return result;
}

function optionalDigest(value, label) {
  return value === null ? null : digest(value, label);
}

function boundedBytes(value, maximum, label) {
  const result = ownedBytes(value, label);
  if (result.length > maximum) fail('ERR_APPLICATION_V1_LIMIT', `${label} exceeds ${maximum} bytes`);
  return result;
}

function sameBytes(left, right) {
  return Buffer.from(left).equals(Buffer.from(right));
}

function isZeroDigest(value) {
  return sameBytes(value, ZERO_DIGEST);
}

function u32Number(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) fail('ERR_APPLICATION_V1_U32', `${label} must fit u32`);
  return value;
}

function positiveU32(value, label) {
  const result = u32Number(value, label);
  if (result === 0) fail('ERR_APPLICATION_V1_U32', `${label} must be positive`);
  return result;
}

function u64BigInt(value, label) {
  const result = typeof value === 'bigint'
    ? value
    : Number.isSafeInteger(value)
      ? BigInt(value)
      : null;
  if (result === null || result < 0n || result > 0xffffffffffffffffn) fail('ERR_APPLICATION_V1_U64', `${label} must fit u64`);
  return result;
}

class Writer {
  constructor() {
    this.chunks = [];
  }

  magic(value) { this.chunks.push(Buffer.from(value, 'ascii')); }
  bytes(value) { this.chunks.push(Buffer.from(value)); }
  bool(value) { this.u8(value ? 1 : 0); }
  u8(value) {
    const admitted = u32Number(value, 'u8');
    if (admitted > 0xff) fail('ERR_APPLICATION_V1_U8');
    this.chunks.push(Buffer.from([admitted]));
  }
  u32(value) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(u32Number(value, 'u32'));
    this.chunks.push(bytes);
  }
  u64(value) {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(u64BigInt(value, 'u64'));
    this.chunks.push(bytes);
  }
  digest(value) { this.chunks.push(digest(value, 'digest')); }
  optionalDigest(value) {
    this.bool(value !== null);
    if (value !== null) this.digest(value);
  }
  lenBytes(value) {
    this.u32(value.length);
    this.bytes(value);
  }
  optionalBytes(value) {
    this.bool(value !== null);
    if (value !== null) this.lenBytes(value);
  }
  finish() { return Buffer.concat(this.chunks); }
}

class Reader {
  constructor(value) {
    this.value = Buffer.from(value);
    this.offset = 0;
  }

  bytes(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.value.length) {
      fail('ERR_APPLICATION_V1_TRUNCATED');
    }
    const result = this.value.subarray(this.offset, this.offset + length);
    this.offset += length;
    return Buffer.from(result);
  }
  magic(expected) {
    if (this.bytes(expected.length).toString('ascii') !== expected) fail('ERR_APPLICATION_V1_MAGIC');
  }
  version() {
    if (this.u32() !== APPLICATION_FORMAT_VERSION) fail('ERR_APPLICATION_V1_VERSION');
  }
  bool() {
    const value = this.u8();
    if (value > 1) fail('ERR_APPLICATION_V1_BOOLEAN');
    return value === 1;
  }
  u8() { return this.bytes(1)[0]; }
  u32() { return this.bytes(4).readUInt32LE(); }
  u64() { return this.bytes(8).readBigUInt64LE(); }
  digest() { return this.bytes(DIGEST_LENGTH); }
  optionalDigest() { return this.bool() ? this.digest() : null; }
  lenBytes(maximum, label) {
    const length = this.u32();
    if (length > maximum) fail('ERR_APPLICATION_V1_LIMIT', `${label} exceeds ${maximum} bytes`);
    return this.bytes(length);
  }
  optionalBytes(maximum, label) { return this.bool() ? this.lenBytes(maximum, label) : null; }
  count(maximum, label) {
    const value = this.u32();
    if (value > maximum) fail('ERR_APPLICATION_V1_LIMIT', `${label} exceeds ${maximum}`);
    return value;
  }
  effectStatus() { return effectStatus(this.u8()); }
  frameStatus() {
    const value = this.u8();
    if (value < FrameStatus.needsEffect || value > FrameStatus.cancelled) fail('ERR_APPLICATION_V1_FRAME_STATUS');
    return value;
  }
  finish() {
    if (this.offset !== this.value.length) fail('ERR_APPLICATION_V1_TRAILING_BYTES');
  }
}
