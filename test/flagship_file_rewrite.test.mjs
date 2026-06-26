import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';

import { runExample } from '../examples/file_rewrite_agent/run.mjs';

describe('flagship file rewrite example', () => {
  it('persists real sandbox file effects and inspects completion after restart', async () => {
    const result = await runExample();

    assert.equal(result.completed, true);
    assert.equal(result.outputAfterRestart, 'world carrier updated the fixture');
    assert.equal(result.effectCount, 2);
    assert.deepEqual(result.effectStates, ['closure_committed', 'closure_committed']);
    assert.equal(result.committedEffectCount, 2);
    assert.equal(result.writeRetryReusedPersistedResolution, true);
    assert.equal(result.duplicateWriteAvoided, true);
    assert.equal(result.sandboxDriverCalls, 2);
    assert.equal(result.sandboxDriverWriteCalls, 1);
    assert.equal(result.restartInspectionInvokedDriver, false);
    assert.equal(result.restartInspectedCommittedClosure, true);
    assert.equal(result.archiveAppendBatchRetained, true);
    assert.ok(result.retainedImmutableBlobCount >= 5);
    assert.equal(result.hostFixtureOnly, true);
    assert.match(result.worldSemanticEvidenceSource, /run-world-conformance/);
  });
});
