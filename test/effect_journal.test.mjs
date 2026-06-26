import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { EffectRecoveryClass } from '../src/core/actuator.mjs';
import { EffectJournal, EffectState, prepareHostRequest } from '../src/core/effect_journal.mjs';
import { fromUtf8 } from '../src/core/store.mjs';
import { HttpJsonDriver } from '../src/drivers/http_json_driver.mjs';
import { decodeResolutionInputBytes, encodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';
import { DirectoryStore } from '../src/stores/directory_store.mjs';
import { MemoryStore } from '../src/stores/memory_store.mjs';

describe('EffectJournal', () => {
  it('reuses persisted ResolutionInput for the same complete idempotency key', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, response: 'resolution:one' });
    const first = await journal.resolve({}, hostRequest(), driver);
    const second = await journal.resolve({}, hostRequest(), driver);

    assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
    assert.equal(driver.calls, 1);
    assert.deepEqual(decodeResolutionInputBytes(second.resolutionInputBytes).responseValueImageBytes, fromUtf8('resolution:one'));
  });

  it('serializes concurrent same-key resolutions before driver execution', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, response: 'resolution:one', delayMs: 10 });

    const [first, second] = await Promise.all([
      journal.resolve({}, hostRequest(), driver),
      journal.resolve({}, hostRequest(), driver),
    ]);

    assert.equal(driver.calls, 1);
    assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
    assert.deepEqual(decodeResolutionInputBytes(second.resolutionInputBytes).responseValueImageBytes, fromUtf8('resolution:one'));
  });

  it('serializes same-key resolutions across DirectoryStore instances with the same root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'world-host-effect-lock-'));
    try {
      const firstJournal = new EffectJournal({
        store: new DirectoryStore(root),
        runId: 'run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'turn:0',
      });
      const secondJournal = new EffectJournal({
        store: new DirectoryStore(root),
        runId: 'run',
        branchId: 'main',
        parentTurnClosureFingerprint: 'turn:0',
      });
      const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, response: 'resolution:one', delayMs: 10 });

      const [first, second] = await Promise.all([
        firstJournal.resolve({}, hostRequest(), driver),
        secondJournal.resolve({}, hostRequest(), driver),
      ]);

      assert.equal(driver.calls, 1);
      assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent same-key observations before idempotency checks', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });

    const results = await Promise.allSettled([
      journal.observe(hostRequest({ recoveryClass: EffectRecoveryClass.idempotent, requestBytes: fromUtf8('request:one') })),
      journal.observe(hostRequest({ recoveryClass: EffectRecoveryClass.idempotent, requestBytes: fromUtf8('request:two') })),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'ERR_EFFECT_IDEMPOTENCY_CONFLICT');
    assert.equal((await store.listEffectRecords('run')).length, 1);
  });

  it('rejects driver response limits outside receiver policy before execution', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({
      store,
      runId: 'run',
      branchId: 'main',
      parentTurnClosureFingerprint: 'turn:0',
      policy: { maximumResponseBytes: 1 },
    });
    const driver = fixtureDriver({
      recoveryClass: EffectRecoveryClass.idempotent,
      response: encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xa1n,
        status: 0,
        responseValueImageBytes: fromUtf8('too large'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: new Uint8Array(),
      }),
    });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), driver),
      { code: 'ERR_EFFECT_RESPONSE_LIMIT_EXCEEDS_POLICY' },
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, EffectState.observed);
    assert.equal(driver.calls, 0);
  });

  it('rejects actual driver responses that exceed manifest limits', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), fixtureDriver({
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1,
        response: encodeResolutionInputBytes({
          targetHostRequestFingerprint: 0xa1n,
          status: 0,
          responseValueImageBytes: fromUtf8('too large'),
          hostClaimBytes: new Uint8Array(),
          attemptNumber: 1,
          metadata: new Uint8Array(),
        }),
      })),
      { code: 'ERR_EFFECT_RESPONSE_TOO_LARGE' },
    );
  });

  it('rejects oversized ResolutionInput carried fields before persisting', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const request = hostRequest();

    await assert.rejects(
      () => journal.resolve({}, request, fixtureDriver({
        recoveryClass: EffectRecoveryClass.idempotent,
        maximumResponseBytes: 1,
        response: encodeResolutionInputBytes({
          targetHostRequestFingerprint: 0xa1n,
          status: 0,
          responseValueImageBytes: fromUtf8('x'),
          hostClaimBytes: fromUtf8('too large claim'),
          attemptNumber: 1,
          metadata: new Uint8Array(),
        }),
      })),
      { code: 'ERR_EFFECT_RESPONSE_TOO_LARGE' },
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, EffectState.failed);
    assert.equal(records[0].resolutionInputRef, undefined);
  });

  it('rejects driver ResolutionInput targeting another HostRequest before persisting it', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({
      recoveryClass: EffectRecoveryClass.idempotent,
      response: encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xa2n,
        status: 0,
        responseValueImageBytes: fromUtf8('wrong target'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: new Uint8Array(),
      }),
    });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), driver),
      { code: 'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH' },
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, EffectState.failed);
    assert.equal(records[0].resolutionInputRef, undefined);
    assert.equal(driver.calls, 1);
  });

  it('does not automatically re-run failed non-idempotent effects', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({
      recoveryClass: EffectRecoveryClass.transactional,
      response: encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xa2n,
        status: 0,
        responseValueImageBytes: fromUtf8('wrong target'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: new Uint8Array(),
      }),
    });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), driver),
      { code: 'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH' },
    );
    await assert.rejects(
      () => journal.resolve({}, hostRequest(), driver),
      { code: 'ERR_EFFECT_FAILED_REQUIRES_OPERATOR' },
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, EffectState.failed);
    assert.equal(driver.calls, 1);
  });

  it('rejects driver ResolutionInput statuses outside the HostRequest response schema', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), fixtureDriver({
        recoveryClass: EffectRecoveryClass.idempotent,
        response: fixtureResolutionInputBytes(hostRequest(), fromUtf8('not found'), 1),
      })),
      { code: 'ERR_EFFECT_RESPONSE_STATUS_MISMATCH' },
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, EffectState.failed);
    assert.equal(records[0].resolutionInputRef, undefined);
  });

  it('rejects schema-less ResolutionInput statuses outside the selected driver manifest', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const request = hostRequest({ responseSchema: undefined });

    await assert.rejects(
      () => journal.resolve({}, request, fixtureDriver({
        recoveryClass: EffectRecoveryClass.idempotent,
        supportedResponseStatuses: ['ok'],
        response: fixtureResolutionInputBytes(request, new Uint8Array(), 1),
      })),
      { code: 'ERR_RESPONSE_STATUS_NOT_SUPPORTED' },
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, EffectState.failed);
    assert.equal(records[0].resolutionInputRef, undefined);
  });

  it('rejects unknown response labels before invoking drivers', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({
      recoveryClass: EffectRecoveryClass.idempotent,
      supportedResponseStatuses: ['custom'],
    });

    await assert.rejects(
      () => journal.resolve({}, hostRequest({ responseSchema: { status: 'custom' } }), driver),
      { code: 'ERR_INVALID_DRIVER_MANIFEST' },
    );
    assert.equal(driver.calls, 0);
  });

  it('rejects non-responded ResolutionInputs that carry response bytes', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const request = hostRequest({ responseSchema: { status: 'not_found' } });

    await assert.rejects(
      () => journal.resolve({}, request, fixtureDriver({
        recoveryClass: EffectRecoveryClass.idempotent,
        supportedResponseStatuses: ['not_found'],
        response: fixtureResolutionInputBytes(request, fromUtf8('not found'), 1),
      })),
      { code: 'ERR_EFFECT_RESPONSE_FORBIDDEN' },
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, EffectState.failed);
    assert.equal(records[0].resolutionInputRef, undefined);
  });

  it('rejects responded ResolutionInputs without response bytes', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), fixtureDriver({
        recoveryClass: EffectRecoveryClass.idempotent,
        response: fixtureResolutionInputBytes(hostRequest(), new Uint8Array(), 0),
      })),
      { code: 'ERR_EFFECT_RESPONSE_REQUIRED' },
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, EffectState.failed);
    assert.equal(records[0].resolutionInputRef, undefined);
  });

  it('rejects unsupported driver ResolutionInput versions before persisting', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const unsupported = fixtureResolutionInputBytes(hostRequest(), fromUtf8('future response'));
    unsupported[0] = 2;

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), fixtureDriver({
        recoveryClass: EffectRecoveryClass.idempotent,
        response: unsupported,
      })),
      /unsupported ResolutionInput format version: 2/,
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, EffectState.failed);
    assert.equal(records[0].resolutionInputRef, undefined);
  });

  it('validates serialized fallback request bytes before driver execution', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, maximumRequestBytes: 1 });

    await assert.rejects(
      () => journal.resolve({}, hostRequest({ requestBytes: undefined, request: { payload: 'too large' } }), driver),
      { code: 'ERR_HOST_REQUEST_TOO_LARGE' },
    );
    assert.equal(driver.calls, 0);
    assert.equal((await store.listEffectRecords('run')).length, 0);
  });

  it('validates HostRequest fingerprints before driver execution', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });

    await assert.rejects(
      () => journal.resolve({}, hostRequest({ hostRequestFingerprint: 'not-a-world-fingerprint' }), driver),
      { code: 'ERR_HOST_REQUEST_FINGERPRINT_REQUIRED' },
    );
    await assert.rejects(
      () => journal.resolve({}, hostRequest({ hostRequestFingerprint: 'not-a-world-prefix-deadbeef' }), driver),
      { code: 'ERR_HOST_REQUEST_FINGERPRINT_REQUIRED' },
    );
    await assert.rejects(
      () => journal.resolve({}, hostRequest({ hostRequestFingerprint: 'world:host-request:10000000000000000' }), driver),
      { code: 'ERR_HOST_REQUEST_FINGERPRINT_RANGE' },
    );
    await assert.rejects(
      () => journal.resolve({}, hostRequest({ hostRequestFingerprint: -1n }), driver),
      { code: 'ERR_HOST_REQUEST_FINGERPRINT_RANGE' },
    );
    assert.equal(driver.calls, 0);
    assert.equal((await store.listEffectRecords('run')).length, 0);
  });

  it('rejects oversized observed requests before storing request bytes', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({
      store,
      runId: 'run',
      branchId: 'main',
      parentTurnClosureFingerprint: 'turn:0',
      policy: { maximumRequestBytes: 1 },
    });

    await assert.rejects(
      () => journal.observe(hostRequest({ requestBytes: fromUtf8('too large') }), { recoveryClass: EffectRecoveryClass.idempotent }),
      { code: 'ERR_HOST_REQUEST_TOO_LARGE' },
    );
    assert.equal((await store.listEffectRecords('run')).length, 0);
  });

  it('passes generated request identities to drivers and validation', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });
    const request = hostRequest({
      requestBytes: undefined,
      request: { payload: 'fallback identity path' },
      hostRequestFingerprint: undefined,
      idempotencyKeyWorldFingerprint: undefined,
    });
    const prepared = await prepareHostRequest(request);

    const resolved = await journal.resolve({}, request, driver);
    const decoded = decodeResolutionInputBytes(resolved.resolutionInputBytes);

    assert.equal(driver.calls, 1);
    assert.equal(driver.requests[0].hostRequestFingerprint, prepared.hostRequestFingerprint);
    assert.equal(driver.requests[0].idempotencyKeyWorldFingerprint, prepared.idempotencyKeyWorldFingerprint);
    assert.deepEqual(driver.requests[0].requestBytes, prepared.requestBytes);
    assert.equal(decoded.targetHostRequestFingerprint, requestTargetFingerprint(prepared));
    assert.equal(resolved.record.hostRequestFingerprint, prepared.hostRequestFingerprint);
    assert.equal(resolved.record.idempotencyKeyWorldFingerprint, prepared.idempotencyKeyWorldFingerprint);
  });

  it('includes response schema in generated request identity conflicts', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const request = hostRequest({
      requestBytes: undefined,
      request: { payload: 'same request bytes' },
      hostRequestFingerprint: undefined,
      responseSchema: { status: 'ok' },
    });
    await journal.resolve({}, request, fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, supportedResponseStatuses: ['ok', 'final'] }));

    await assert.rejects(
      () => journal.resolve({}, {
        ...request,
        hostRequestFingerprint: undefined,
        responseSchema: { status: 'final' },
      }, fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, supportedResponseStatuses: ['ok', 'final'] })),
      { code: 'ERR_EFFECT_IDEMPOTENCY_CONFLICT' },
    );
  });

  it('revalidates reused ResolutionInputs against current receiver policy', async () => {
    const store = new MemoryStore();
    const first = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, response: 'too large for resumed policy' });
    await first.resolve({}, hostRequest(), driver);
    const resumed = new EffectJournal({
      store,
      runId: 'run',
      branchId: 'main',
      parentTurnClosureFingerprint: 'turn:0',
      policy: { maximumResponseBytes: 1 },
    });

    await assert.rejects(
      () => resumed.resolve({}, hostRequest(), fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent })),
      { code: 'ERR_EFFECT_RESPONSE_TOO_LARGE' },
    );
  });

  it('normalizes direct journal policies before accepting driver response limits', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({
      store,
      runId: 'run',
      branchId: 'main',
      parentTurnClosureFingerprint: 'turn:0',
      policy: {},
    });
    const driver = fixtureDriver({
      recoveryClass: EffectRecoveryClass.idempotent,
      maximumResponseBytes: 1024 * 1024 + 1,
    });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), driver),
      { code: 'ERR_EFFECT_RESPONSE_LIMIT_EXCEEDS_POLICY' },
    );
    assert.equal(driver.calls, 0);
  });

  it('rejects the same full idempotency key with different request bytes', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    await journal.resolve({}, hostRequest(), fixtureDriver({ recoveryClass: EffectRecoveryClass.pure }));

    await assert.rejects(
      () => journal.resolve({}, hostRequest({ requestBytes: fromUtf8('different') }), fixtureDriver({ recoveryClass: EffectRecoveryClass.pure })),
      { code: 'ERR_EFFECT_IDEMPOTENCY_CONFLICT' },
    );
  });

  it('rejects the same full idempotency key with a different host request identity', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.pure });
    await journal.resolve({}, hostRequest({ hostRequestFingerprint: 'world:host-request:00000000000000a1' }), driver);

    await assert.rejects(
      () => journal.resolve({}, hostRequest({ hostRequestFingerprint: 'world:host-request:00000000000000a2' }), driver),
      { code: 'ERR_EFFECT_IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(driver.calls, 1);
  });

  it('forbids shortened idempotency-key hash authority', async () => {
    await assert.rejects(
      () => prepareHostRequest(hostRequest({ shortIdempotencyKeyHash: 'abc123' })),
      { code: 'ERR_SHORT_IDEMPOTENCY_KEY_FORBIDDEN' },
    );
  });

  it('rejects best_effort drivers for durable automatic runs without operator opt-in', async () => {
    const journal = new EffectJournal({ store: new MemoryStore(), runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    await assert.rejects(
      () => journal.resolve({}, hostRequest(), fixtureDriver({ recoveryClass: EffectRecoveryClass.bestEffort })),
      { code: 'ERR_BEST_EFFORT_REQUIRES_OPERATOR_OPT_IN' },
    );
  });

  it('rechecks best_effort policy before resolving an existing observed effect', async () => {
    const store = new MemoryStore();
    const approved = new EffectJournal({
      store,
      runId: 'run',
      branchId: 'main',
      parentTurnClosureFingerprint: 'turn:0',
      policy: { allowBestEffort: true },
    });
    await approved.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.bestEffort });
    const durable = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });

    await assert.rejects(
      () => durable.resolve({}, hostRequest(), fixtureDriver({ recoveryClass: EffectRecoveryClass.bestEffort })),
      { code: 'ERR_BEST_EFFORT_REQUIRES_OPERATOR_OPT_IN' },
    );
  });

  it('rejects selected driver recovery classes that differ from the observed effect', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });
    await journal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.pure });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), driver),
      { code: 'ERR_EFFECT_RECOVERY_CLASS_MISMATCH' },
    );
    assert.equal(driver.calls, 0);
  });

  it('recovers running effects instead of resolving them again', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.idempotent });
    await store.putEffectRecord({ ...observed, state: EffectState.running, attemptCount: 1 });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, recoverHostClaim: true });

    const recovered = await journal.resolve({}, hostRequest(), driver);

    assert.equal(recovered.record.state, EffectState.resolved);
    assert.deepEqual(await store.getBlob(recovered.record.hostClaimRef), fromUtf8('recovered-host-claim'));
    assert.equal(driver.calls, 0);
    assert.equal(driver.recoverCalls, 1);
  });

  it('serializes concurrent direct recovery for the same effect key', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.idempotent });
    const running = await store.putEffectRecord({ ...observed, state: EffectState.running, attemptCount: 1 });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, recoverHostClaim: true, delayMs: 10 });

    const [first, second] = await Promise.all([
      journal.recover({}, running, driver),
      journal.recover({}, running, driver),
    ]);

    assert.equal(driver.recoverCalls, 1);
    assert.deepEqual([first.reused, second.reused].sort(), [false, true]);
    assert.equal((await store.getEffectRecord('run', running.idempotencyKey, 'main')).state, EffectState.resolved);
  });

  it('recomputes running pure effects when no recover hook exists', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.pure });
    await store.putEffectRecord({ ...observed, state: EffectState.running, attemptCount: 1 });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.pure, recover: false });

    const recovered = await journal.resolve({}, hostRequest(), driver);

    assert.equal(recovered.record.state, EffectState.resolved);
    assert.equal(driver.calls, 1);
    assert.equal(driver.recoverCalls, 0);
  });

  it('reissues running idempotent effects when no recover hook exists', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.idempotent });
    await store.putEffectRecord({ ...observed, state: EffectState.running, attemptCount: 1 });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, recover: false });

    const recovered = await journal.resolve({}, hostRequest(), driver);

    assert.equal(recovered.record.state, EffectState.resolved);
    assert.equal(driver.calls, 1);
    assert.equal(driver.recoverCalls, 0);
  });

  it('recovers idempotent HTTP effects from persisted request bytes', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(httpHostRequest(), { recoveryClass: EffectRecoveryClass.idempotent });
    await store.putEffectRecord({ ...observed, state: EffectState.running, attemptCount: 1 });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = async (url, options) => {
        calls += 1;
        assert.equal(String(url), 'https://allowed.example/path');
        assert.equal(options.headers['Idempotency-Key'], 'world:key:http');
        return new Response('{"ok":true}', { status: 200, headers: { 'x-request-id': 'recover-1' } });
      };
      const recovered = await journal.resolve({}, httpHostRequest(), new HttpJsonDriver({ origins: ['https://allowed.example'] }));

      assert.equal(recovered.record.state, EffectState.resolved);
      assert.equal(recovered.record.driverTransactionRef, 'recover-1');
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes transactional resolve failures through recovery before retrying side effects', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.transactional });
    driver.resolve = async () => {
      driver.calls += 1;
      const error = new Error('transaction outcome unknown');
      error.code = 'ERR_TRANSACTION_UNKNOWN';
      throw error;
    };

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), driver),
      { code: 'ERR_TRANSACTION_UNKNOWN' },
    );
    const [running] = await store.listEffectRecords('run');
    assert.equal(running.state, EffectState.running);
    assert.equal(running.diagnostics.recoveryRequired, 'transactional_resolve_failed');

    const recovered = await journal.resolve({}, hostRequest(), driver);

    assert.equal(recovered.record.state, EffectState.resolved);
    assert.equal(driver.calls, 1);
    assert.equal(driver.recoverCalls, 1);
  });

  it('keeps pure driver failures recomputable before requiring operator recovery', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.pure, recover: false });
    driver.resolve = async (_context, request) => {
      driver.calls += 1;
      if (driver.calls === 1) {
        const error = new Error('pure result not produced');
        error.code = 'ERR_PURE_TRANSIENT';
        throw error;
      }
      return { resolutionInputBytes: fixtureResolutionInputBytes(request, fromUtf8('pure recomputed')) };
    };

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), driver),
      { code: 'ERR_PURE_TRANSIENT' },
    );
    const [running] = await store.listEffectRecords('run');
    assert.equal(running.state, EffectState.running);
    assert.equal(running.diagnostics.recoveryRequired, 'pure_resolve_failed');

    const recovered = await journal.resolve({}, hostRequest(), driver);

    assert.equal(recovered.record.state, EffectState.resolved);
    assert.equal(driver.calls, 2);
    assert.equal(driver.recoverCalls, 0);
  });

  it('keeps idempotent driver failures recoverable before retrying side effects', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });
    driver.resolve = async () => {
      driver.calls += 1;
      const error = new Error('idempotent outcome unknown');
      error.code = 'ERR_IDEMPOTENT_UNKNOWN';
      throw error;
    };

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), driver),
      { code: 'ERR_IDEMPOTENT_UNKNOWN' },
    );
    const [running] = await store.listEffectRecords('run');
    assert.equal(running.state, EffectState.running);
    assert.equal(running.diagnostics.recoveryRequired, 'idempotent_resolve_failed');

    const recovered = await journal.resolve({}, hostRequest(), driver);

    assert.equal(recovered.record.state, EffectState.resolved);
    assert.equal(driver.calls, 1);
    assert.equal(driver.recoverCalls, 1);
  });

  it('keeps idempotent persistence failures recoverable before retrying side effects', async () => {
    const store = new FailResolutionBlobStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, driverTransactionRef: 'txn:persisted-before-ref' });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), driver),
      { code: 'ERR_TEST_RESOLUTION_BLOB_WRITE_FAILED' },
    );
    const [running] = await store.listEffectRecords('run');
    assert.equal(running.state, EffectState.running);
    assert.equal(running.driverTransactionRef, 'txn:persisted-before-ref');
    assert.equal(running.diagnostics.recoveryRequired, 'idempotent_persistence_failed');

    const recovered = await journal.resolve({}, hostRequest(), driver);

    assert.equal(recovered.record.state, EffectState.resolved);
    assert.equal(driver.calls, 1);
    assert.equal(driver.recoverCalls, 1);
  });

  it('rejects externally recoverable drivers without recovery hooks before invocation', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.externallyRecoverable, recover: false });

    await assert.rejects(
      () => journal.resolve({}, hostRequest({ recoveryClass: EffectRecoveryClass.externallyRecoverable }), driver),
      { code: 'ERR_EFFECT_RECOVERY_HOOK_REQUIRED' },
    );
    assert.equal(driver.calls, 0);
    assert.equal((await store.listEffectRecords('run')).length, 0);
  });

  it('rejects transactional drivers without recovery hooks before invocation', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.transactional, recover: false });

    await assert.rejects(
      () => journal.resolve({}, hostRequest({ recoveryClass: EffectRecoveryClass.transactional }), driver),
      { code: 'ERR_EFFECT_RECOVERY_HOOK_REQUIRED' },
    );
    assert.equal(driver.calls, 0);
    assert.equal((await store.listEffectRecords('run')).length, 0);
  });

  it('marks unresolved best_effort recovery for operator intervention', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({
      store,
      runId: 'run',
      branchId: 'main',
      parentTurnClosureFingerprint: 'turn:0',
      policy: { allowBestEffort: true },
    });
    const observed = await journal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.bestEffort });
    const recovered = await journal.recover({}, { ...observed, state: EffectState.running }, fixtureDriver({ recoveryClass: EffectRecoveryClass.bestEffort }));

    assert.equal(recovered.operatorInterventionRequired, true);
    assert.equal(recovered.record.state, EffectState.operatorInterventionRequired);
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.bestEffort });
    const retried = await journal.resolve({}, hostRequest(), driver);
    assert.equal(retried.operatorInterventionRequired, true);
    assert.equal(retried.record.state, EffectState.operatorInterventionRequired);
    assert.equal(driver.calls, 0);
  });

  it('parks best_effort post-run validation failures for operator intervention', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({
      store,
      runId: 'run',
      branchId: 'main',
      parentTurnClosureFingerprint: 'turn:0',
      policy: { allowBestEffort: true },
    });
    const driver = fixtureDriver({
      recoveryClass: EffectRecoveryClass.bestEffort,
      response: encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xa2n,
        status: 0,
        responseValueImageBytes: fromUtf8('wrong target'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: new Uint8Array(),
      }),
    });

    await assert.rejects(
      () => journal.resolve({}, hostRequest(), driver),
      { code: 'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH' },
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records[0].state, EffectState.operatorInterventionRequired);
    const retried = await journal.resolve({}, hostRequest(), driver);
    assert.equal(retried.operatorInterventionRequired, true);
    assert.equal(driver.calls, 1);
  });

  it('validates recovery driver authority against the effect record', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.idempotent });

    await assert.rejects(
      () => journal.recover({}, observed, fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, descriptorFingerprint: 'descriptor:other' })),
      { code: 'ERR_DESCRIPTOR_NOT_SUPPORTED' },
    );
    await assert.rejects(
      () => journal.recover({}, observed, fixtureDriver({ recoveryClass: EffectRecoveryClass.pure })),
      { code: 'ERR_EFFECT_RECOVERY_CLASS_MISMATCH' },
    );
  });

  it('rechecks persisted request byte limits before driver recovery', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(hostRequest({ requestBytes: fromUtf8('oversized persisted request') }), { recoveryClass: EffectRecoveryClass.idempotent });
    const running = await store.putEffectRecord({ ...observed, state: EffectState.running, attemptCount: 1 });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent, maximumRequestBytes: 1 });

    await assert.rejects(
      () => journal.recover({}, running, driver),
      { code: 'ERR_HOST_REQUEST_TOO_LARGE' },
    );
    assert.equal(driver.recoverCalls, 0);
  });

  it('validates recovered effect targets before invoking recovery drivers', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.idempotent });
    const running = await store.putEffectRecord({
      ...observed,
      state: EffectState.running,
      attemptCount: 1,
      hostRequestFingerprint: 'not-a-world-fingerprint',
    });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });

    await assert.rejects(
      () => journal.recover({}, running, driver),
      { code: 'ERR_HOST_REQUEST_FINGERPRINT_REQUIRED' },
    );
    assert.equal(driver.recoverCalls, 0);
  });

  it('parks invalid recovery outputs instead of leaving effects running', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const observed = await journal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.idempotent });
    const running = await store.putEffectRecord({ ...observed, state: EffectState.running, attemptCount: 1 });
    const driver = fixtureDriver({
      recoveryClass: EffectRecoveryClass.idempotent,
      recoverResponse: encodeResolutionInputBytes({
        targetHostRequestFingerprint: 0xa2n,
        status: 0,
        responseValueImageBytes: fromUtf8('wrong target'),
        hostClaimBytes: new Uint8Array(),
        attemptNumber: 1,
        metadata: new Uint8Array(),
      }),
    });

    await assert.rejects(
      () => journal.recover({}, running, driver),
      { code: 'ERR_EFFECT_RESOLUTION_TARGET_MISMATCH' },
    );
    const record = await store.getEffectRecord('run', running.idempotencyKey, 'main');
    assert.equal(record.state, EffectState.failed);
    assert.equal(driver.recoverCalls, 1);
  });

  it('reconciles submitted effects from the committed head without crossing branch or parent', async () => {
    const store = new MemoryStore();
    const mainJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const otherParentJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:other' });
    const otherBranchJournal = new EffectJournal({ store, runId: 'run', branchId: 'alternate', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });

    const resolved = (await mainJournal.resolve({}, hostRequest({
      idempotencyKeyBytes: fromUtf8('key:resolved'),
      idempotencyKeyWorldFingerprint: 'world:key:resolved',
      requestBytes: fromUtf8('request:resolved'),
    }), driver)).record;
    const uncommittedResolved = (await mainJournal.resolve({}, hostRequest({
      idempotencyKeyBytes: fromUtf8('key:uncommitted-resolved'),
      idempotencyKeyWorldFingerprint: 'world:key:uncommitted-resolved',
      requestBytes: fromUtf8('request:uncommitted-resolved'),
    }), driver)).record;
    const uncommittedSubmitted = await mainJournal.markSubmitted((await mainJournal.resolve({}, hostRequest({
      idempotencyKeyBytes: fromUtf8('key:uncommitted-submitted'),
      idempotencyKeyWorldFingerprint: 'world:key:uncommitted-submitted',
      requestBytes: fromUtf8('request:uncommitted-submitted'),
    }), driver)).record);
    const matching = await mainJournal.markSubmitted((await mainJournal.resolve({}, hostRequest({ idempotencyKeyBytes: fromUtf8('key:matching') }), driver)).record);
    const otherParent = await otherParentJournal.markSubmitted((await otherParentJournal.resolve({}, hostRequest({
      idempotencyKeyBytes: fromUtf8('key:other-parent'),
      idempotencyKeyWorldFingerprint: 'world:key:other-parent',
      requestBytes: fromUtf8('request:other-parent'),
    }), driver)).record);
    const otherBranch = await otherBranchJournal.markSubmitted((await otherBranchJournal.resolve({}, hostRequest({
      idempotencyKeyBytes: fromUtf8('key:other-branch'),
      idempotencyKeyWorldFingerprint: 'world:key:other-branch',
      requestBytes: fromUtf8('request:other-branch'),
    }), driver)).record);

    const result = await mainJournal.reconcileCommittedHead({
      updateDiagnostics: {
        parentTurnClosureFingerprint: 'turn:0',
        committedEffectIds: [resolved.idempotencyKeyWorldFingerprint, matching.idempotencyKeyWorldFingerprint],
      },
    });
    const records = await store.listEffectRecords('run');

    assert.equal(result.committedCount, 1);
    assert.deepEqual(result.committed.map((record) => record.idempotencyKey.bytesHex).sort(), [
      matching.idempotencyKey.bytesHex,
    ].sort());
    assert.equal(records.find((record) => record.idempotencyKey.bytesHex === resolved.idempotencyKey.bytesHex).state, EffectState.resolved);
    assert.equal(records.find((record) => record.idempotencyKey.bytesHex === uncommittedResolved.idempotencyKey.bytesHex).state, EffectState.resolved);
    assert.equal(records.find((record) => record.idempotencyKey.bytesHex === matching.idempotencyKey.bytesHex).state, EffectState.closureCommitted);
    assert.equal(records.find((record) => record.idempotencyKey.bytesHex === uncommittedSubmitted.idempotencyKey.bytesHex).state, EffectState.submitted);
    assert.equal(records.find((record) => record.idempotencyKey.bytesHex === otherParent.idempotencyKey.bytesHex).state, EffectState.submitted);
    assert.equal(records.find((record) => record.idempotencyKey.bytesHex === otherBranch.idempotencyKey.bytesHex).state, EffectState.submitted);
    assert.equal(driver.calls, 6);
  });

  it('reuses same-key outcomes with a branch-local effect record', async () => {
    const store = new MemoryStore();
    const mainJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const alternateJournal = new EffectJournal({ store, runId: 'run', branchId: 'alternate', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });

    const main = await mainJournal.resolve({}, hostRequest(), driver);
    const alternate = await alternateJournal.resolve({}, hostRequest(), driver);
    const records = await store.listEffectRecords('run');

    assert.equal(main.record.branchId, 'main');
    assert.equal(alternate.record.branchId, 'alternate');
    assert.equal(alternate.reused, true);
    assert.equal(driver.calls, 1);
    assert.equal(records.length, 2);
    assert.equal(records.filter((record) => record.branchId === 'main').length, 1);
    assert.equal(records.filter((record) => record.branchId === 'alternate').length, 1);
  });

  it('scans all same-key records for conflicts before reusing a branch-local outcome', async () => {
    const store = new MemoryStore();
    const mainJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const alternateJournal = new EffectJournal({ store, runId: 'run', branchId: 'alternate', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });

    const main = await mainJournal.resolve({}, hostRequest(), driver);
    await store.putEffectRecord({
      ...main.record,
      branchId: 'shadow',
      requestBytesChecksum: 'sha256:shadow-conflict',
      diagnostics: { conflictFixture: true },
    });

    await assert.rejects(
      () => alternateJournal.resolve({}, hostRequest(), driver),
      { code: 'ERR_EFFECT_IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(driver.calls, 1);
  });

  it('prefers persisted same-key outcomes over running records after conflict scanning', async () => {
    const store = new MemoryStore();
    const mainJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const alternateJournal = new EffectJournal({ store, runId: 'run', branchId: 'alternate', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });

    const main = await mainJournal.resolve({}, hostRequest(), driver);
    await store.putEffectRecord({
      ...main.record,
      branchId: 'running',
      state: EffectState.running,
      resolutionInputRef: undefined,
      diagnostics: { runningFirstFixture: true },
    });
    const listEffectRecords = store.listEffectRecords.bind(store);
    store.listEffectRecords = async (runId) => (await listEffectRecords(runId)).sort((left, right) => {
      if (left.state === EffectState.running) return -1;
      if (right.state === EffectState.running) return 1;
      return 0;
    });

    const alternate = await alternateJournal.resolve({}, hostRequest(), driver);

    assert.equal(alternate.reused, true);
    assert.equal(alternate.record.state, EffectState.resolved);
    assert.equal(driver.calls, 1);
  });

  it('reparents same-branch reused outcomes to the current parent', async () => {
    const store = new MemoryStore();
    const firstJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const nextJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:1' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });

    await firstJournal.resolve({}, hostRequest(), driver);
    const reused = await nextJournal.resolve({}, hostRequest(), driver);
    const records = await store.listEffectRecords('run');

    assert.equal(reused.reused, true);
    assert.equal(reused.record.parentTurnClosureFingerprint, 'turn:1');
    assert.equal(reused.record.state, EffectState.resolved);
    assert.equal(records.length, 1);
    assert.equal(records[0].parentTurnClosureFingerprint, 'turn:1');
    assert.equal(driver.calls, 1);
  });

  it('reparents same-branch observed effects before resolving under the current parent', async () => {
    const store = new MemoryStore();
    const firstJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const nextJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:1' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });

    await firstJournal.observe(hostRequest(), { recoveryClass: EffectRecoveryClass.idempotent });
    const resolved = await nextJournal.resolve({}, hostRequest(), driver);
    const submitted = await nextJournal.markSubmitted(resolved.record);
    const result = await nextJournal.reconcileCommittedHead({
      updateDiagnostics: {
        parentTurnClosureFingerprint: 'turn:1',
        committedEffectIds: [submitted.idempotencyKeyWorldFingerprint],
      },
    });
    const records = await store.listEffectRecords('run');

    assert.equal(resolved.record.parentTurnClosureFingerprint, 'turn:1');
    assert.equal(submitted.parentTurnClosureFingerprint, 'turn:1');
    assert.equal(result.committedCount, 1);
    assert.equal(records[0].state, EffectState.closureCommitted);
    assert.equal(records[0].parentTurnClosureFingerprint, 'turn:1');
    assert.equal(driver.calls, 1);
  });

  it('fails closed when committed-head recovery lacks a parent fingerprint', async () => {
    const journal = new EffectJournal({ store: new MemoryStore(), runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });

    await assert.rejects(
      () => journal.reconcileCommittedHead({ updateDiagnostics: {} }),
      { code: 'ERR_EFFECT_RECONCILE_HEAD_PARENT_REQUIRED' },
    );
  });

  it('rejects out-of-scope records before transition or recovery writes', async () => {
    const store = new MemoryStore();
    const mainJournal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });
    const resolved = (await mainJournal.resolve({}, hostRequest(), driver)).record;

    await assert.rejects(
      () => mainJournal.markSubmitted({ ...resolved, branchId: 'alternate' }),
      { code: 'ERR_EFFECT_RECORD_SCOPE_MISMATCH' },
    );
    await assert.rejects(
      () => mainJournal.markClosureCommitted({ ...resolved, runId: 'other-run' }),
      { code: 'ERR_EFFECT_RECORD_SCOPE_MISMATCH' },
    );
    await assert.rejects(
      () => mainJournal.recover({}, { ...resolved, runId: 'other-run', state: EffectState.running, resolutionInputRef: undefined }, driver),
      { code: 'ERR_EFFECT_RECORD_SCOPE_MISMATCH' },
    );

    const records = await store.listEffectRecords('run');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, EffectState.resolved);
    assert.equal(driver.recoverCalls, 0);
    assert.deepEqual(await store.listEffectRecords('other-run'), []);
  });

  it('re-reads current effect state before advancing transitions', async () => {
    const store = new MemoryStore();
    const journal = new EffectJournal({ store, runId: 'run', branchId: 'main', parentTurnClosureFingerprint: 'turn:0' });
    const driver = fixtureDriver({ recoveryClass: EffectRecoveryClass.idempotent });
    const resolved = (await journal.resolve({}, hostRequest(), driver)).record;
    const submitted = await journal.markSubmitted(resolved);
    await journal.markClosureCommitted(submitted);

    await assert.rejects(
      () => journal.markSubmitted(resolved),
      { code: 'ERR_EFFECT_STATE_REGRESSION' },
    );
    const records = await store.listEffectRecords('run');
    assert.equal(records.length, 1);
    assert.equal(records[0].state, EffectState.closureCommitted);
  });
});

function hostRequest(overrides = {}) {
  return {
    actuatorRef: 'fixture:model',
    descriptorFingerprint: 'descriptor:fixture',
    actuationClass: 'fixture',
    responseSchema: { status: 'ok' },
    idempotencyKeyBytes: fromUtf8('complete-world-idempotency-key'),
    idempotencyKeyWorldFingerprint: 'world:idempotency:key',
    requestBytes: fromUtf8('request:one'),
    hostRequestFingerprint: 'world:host-request:00000000000000a1',
    ...overrides,
  };
}

class FailResolutionBlobStore extends MemoryStore {
  constructor() {
    super();
    this.putBlobCalls = 0;
    this.failedResolutionBlob = false;
  }

  async putBlob(bytes) {
    this.putBlobCalls += 1;
    if (!this.failedResolutionBlob && this.putBlobCalls === 2) {
      this.failedResolutionBlob = true;
      const error = new Error('test resolution blob write failed');
      error.code = 'ERR_TEST_RESOLUTION_BLOB_WRITE_FAILED';
      throw error;
    }
    return await super.putBlob(bytes);
  }
}

function httpHostRequest(overrides = {}) {
  return {
    actuatorRef: 'http:json',
    descriptorFingerprint: 'descriptor:http-json',
    actuationClass: 'http',
    responseSchema: { status: 'ok' },
    idempotencyKeyBytes: fromUtf8('complete-http-idempotency-key'),
    idempotencyKeyWorldFingerprint: 'world:key:http',
    requestBytes: fromUtf8(JSON.stringify({ url: 'https://allowed.example/path' })),
    hostRequestFingerprint: 'world:host-request:00000000000000a1',
    ...overrides,
  };
}

function fixtureDriver({ recoveryClass, response = 'resolution', recoverResponse = null, descriptorFingerprint = 'descriptor:fixture', recover = true, recoverHostClaim = false, driverTransactionRef = undefined, delayMs = 0, maximumRequestBytes = 1024, maximumResponseBytes = 1024, supportedResponseStatuses = ['ok'] }) {
  return {
    calls: 0,
    recoverCalls: 0,
    requests: [],
    manifest() {
      return {
        driverId: 'fixture-driver',
        supportedActuatorRefs: ['fixture:model'],
        supportedDescriptorFingerprints: [descriptorFingerprint],
        supportedActuationClasses: ['fixture'],
        supportedResponseStatuses,
        maximumRequestBytes,
        maximumResponseBytes,
        recoveryClass,
        concurrencyLimit: 1,
        authorityLabels: ['fixture'],
      };
    },
    async resolve(_context, request) {
      this.calls += 1;
      this.requests.push(request);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        resolutionInputBytes: response instanceof Uint8Array ? response : fixtureResolutionInputBytes(request, fromUtf8(response)),
        driverTransactionRef,
      };
    },
    recover: recover ? async function recoverFn(_context, record) {
      this.recoverCalls += 1;
      return {
        resolutionInputBytes: recoverResponse ?? fixtureResolutionInputBytes(record, fromUtf8(`recovered:${response}`)),
        hostClaimBytes: recoverHostClaim ? fromUtf8('recovered-host-claim') : undefined,
      };
    } : undefined,
  };
}

function fixtureResolutionInputBytes(request, responseValueImageBytes, status = 0) {
  return encodeResolutionInputBytes({
    targetHostRequestFingerprint: requestTargetFingerprint(request),
    status,
    responseValueImageBytes,
    hostClaimBytes: new Uint8Array(),
    attemptNumber: 1,
    metadata: new Uint8Array(),
  });
}

function requestTargetFingerprint(request) {
  const value = request.hostRequestFingerprint;
  if (typeof value === 'bigint' || typeof value === 'number') return BigInt(value);
  const match = String(value ?? '').match(/(?:0x)?([0-9a-f]+)$/i);
  return BigInt(`0x${match[1]}`);
}
