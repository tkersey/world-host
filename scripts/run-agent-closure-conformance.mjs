#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  runBranchingExample,
  runFixtureExample,
  runMigrationExample,
  runNegativeExamples,
  runReplayExample,
  runRetryExample,
  runSkeletonExample,
} from '../examples/agent_runtime/shared.mjs';

const root = process.cwd();
const worldRepo = valueAfter('--world-repo') ?? path.resolve(root, '../world');
const boundaryRepo = valueAfter('--boundary-repo') ?? path.resolve(root, '../boundary');

if (existsSync(path.join(boundaryRepo, 'build.zig'))) {
  const result = spawnSync('zig', ['build', 'check-boundary-agent-conformance-corpus', '--summary', 'all'], {
    cwd: boundaryRepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  assert.match(result.stdout + result.stderr, /check-boundary-agent-conformance-corpus success/);
} else {
  throw new Error(`Boundary repo not found at ${boundaryRepo}`);
}

if (existsSync(path.join(worldRepo, 'build.zig'))) {
  const result = spawnSync('zig', ['build', 'dist-world-agent-v0', '--summary', 'all'], {
    cwd: worldRepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  assert.match(result.stdout + result.stderr, /dist-world-agent-v0 success/);
  const corpusPath = path.join(worldRepo, 'zig-out/dist/world-v0.1.0/conformance/v0/world/corpus.json');
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  const required = [
    'Agent Closure skeleton',
    'Agent Closure fixture',
    'Agent Closure replay',
    'Agent Closure deterministic retry',
    'Agent Closure migration',
    'Agent Closure branching',
  ];
  for (const name of required) {
    assert.ok(JSON.stringify(corpus).includes(name), `World conformance corpus missing ${name}`);
  }
} else {
  throw new Error(`World repo not found at ${worldRepo}`);
}

const skeleton = await runSkeletonExample();
assert.equal(skeleton.completed, true);
assert.equal(skeleton.finalResult, 'final=actuate skeleton complete');
assert.equal(skeleton.modelDriverCalls, 2);
assert.equal(skeleton.internalToolboxRoutedByHost, false);

const fixture = await runFixtureExample();
assert.equal(fixture.completed, true);
assert.equal(fixture.outputFileVerified, true);
assert.equal(fixture.finalResult, 'final=fixture updated');
assert.equal(fixture.resolutionInputsPersistedBeforeSubmission, true);
assert.equal(fixture.writeRetryReusedPersistedResolution, true);
assert.equal(fixture.duplicateWriteAvoided, true);

const replay = await runReplayExample();
assert.equal(replay.freshCompleted, true);
assert.equal(replay.replayCompleted, true);
assert.equal(replay.finalResultMatches, true);
assert.equal(replay.replayFreshModelEffects, 0);
assert.equal(replay.replayFreshFileEffects, 0);
assert.ok(replay.replayReceipts.every((receipt) => receipt.fresh_called === false));

const retry = await runRetryExample();
assert.equal(retry.completed, true);
assert.equal(retry.persistedResolutionInputBeforeWorldSubmission, true);
assert.equal(retry.resultTurnClosureByteIdentical, true);
assert.equal(retry.fileWriteRepeated, false);

const migration = await runMigrationExample();
assert.equal(migration.authorityImported, false);
assert.equal(migration.receiverLocalPreflight, true);
assert.equal(migration.receiverCoveredRequiredActuators, true);
assert.equal(migration.finalResultMatches, true);
assert.equal(migration.sourceRunUnchanged, true);

const branching = await runBranchingExample();
assert.equal(branching.branchesValid, true);
assert.equal(branching.sourceBranchUnchangedByFork, true);
assert.equal(branching.sourceBranchImplicitlyMerged, false);

const negative = await runNegativeExamples();
assert.deepEqual(Object.values(negative), Object.values(negative).map(() => true));

const noHostSemantics = [skeleton, fixture, replay, retry, migration, branching].every((item) => (
  item.hostAuthoredWorldEvidence === false &&
  item.nativeHelperProcess === false &&
  item.generatedAgentTargetType === false
));
assert.equal(noHostSemantics, true);

console.log('agent_closure_conformance=passed');
console.log('boundary_agent_negative_gate=passed');
console.log('world_agent_dist_gate=passed');
console.log('carrier_agent_skeleton=passed');
console.log('carrier_agent_fixture=passed');
console.log('carrier_agent_replay=passed');
console.log('carrier_agent_retry=passed');
console.log('carrier_agent_migration=passed');
console.log('carrier_agent_branching=passed');
console.log('carrier_agent_negative=passed');

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : null;
}
