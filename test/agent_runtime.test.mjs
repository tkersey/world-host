import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';

import {
  runBranchingExample,
  runFixtureExample,
  runMigrationExample,
  runNegativeExamples,
  runReplayExample,
  runRetryExample,
  runSkeletonExample,
} from '../examples/agent_runtime/shared.mjs';
import { FixtureAgentModelDriver } from '../src/drivers/fixture_agent_model_driver.mjs';
import { fromUtf8 } from '../src/core/store.mjs';
import { decodeResolutionInputBytes } from '../src/protocol/world_appliance_wire_codec.mjs';

describe('Agent Carrier runtime fixtures', () => {
  it('resolves fixture model decisions deterministically by HostRequest identity', async () => {
    const driver = new FixtureAgentModelDriver({ scenario: 'skeleton' });
    const request = modelRequest('same', 'goal=invoke');
    const first = await driver.resolve({}, request);
    const second = await driver.resolve({}, { ...request, requestBytes: modelPrompt('actuate') });
    const decoded = decodeResolutionInputBytes(first.resolutionInputBytes);

    assert.deepEqual([...second.resolutionInputBytes], [...first.resolutionInputBytes]);
    assert.equal(decoded.targetHostRequestFingerprint, 0xabc1n);
    assert.equal(driver.calls, 1);
  });

  it('runs skeleton and fixture examples without host-owned agent semantics', async () => {
    const skeleton = await runSkeletonExample();
    const fixture = await runFixtureExample();

    assert.equal(skeleton.completed, true);
    assert.equal(skeleton.finalResult, 'final=actuate skeleton complete');
    assert.equal(skeleton.internalToolboxRoutedByHost, false);
    assert.equal(skeleton.hostAuthoredWorldEvidence, false);
    assert.equal(fixture.completed, true);
    assert.equal(fixture.outputFileVerified, true);
    assert.equal(fixture.finalResult, 'final=fixture updated');
    assert.equal(fixture.resolutionInputsPersistedBeforeSubmission, true);
    assert.equal(fixture.writeRetryReusedPersistedResolution, true);
    assert.equal(fixture.hostAuthoredWorldEvidence, false);
  });

  it('proves replay, retry, migration, branching, and negative host boundaries', async () => {
    const replay = await runReplayExample();
    const retry = await runRetryExample();
    const migration = await runMigrationExample();
    const branching = await runBranchingExample();
    const negative = await runNegativeExamples();

    assert.equal(replay.replayFreshModelEffects, 0);
    assert.equal(replay.replayFreshFileEffects, 0);
    assert.equal(retry.fileWriteRepeated, false);
    assert.equal(retry.resultTurnClosureByteIdentical, true);
    assert.equal(migration.receiverLocalPreflight, true);
    assert.equal(migration.authorityImported, false);
    assert.equal(migration.sourceReceiverPolicyExported, true);
    assert.equal(migration.senderReceiverPolicyDropped, true);
    assert.equal(branching.branchesValid, true);
    assert.equal(branching.sourceBranchImplicitlyMerged, false);
    assert.deepEqual(Object.values(negative), Object.values(negative).map(() => true));
  });
});

function modelRequest(key, observation) {
  return {
    hostRequestFingerprint: 'world:host-request:000000000000abc1',
    idempotencyKeyWorldFingerprint: `world:key:${key}`,
    requestBytes: modelPrompt(observation),
  };
}

function modelPrompt(observation) {
  return fromUtf8(JSON.stringify({
    schema: 'boundary.Agent.DecisionPrompt.v0',
    observation,
  }));
}
