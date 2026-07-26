import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

describe('World Application Host v1 retirement boundary', () => {
  it('keeps v1 on every default surface and Carrier v0 explicit', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

    assert.equal(packageJson.bin['world-host'], './bin/world-host-v1.mjs');
    assert.equal(packageJson.bin['world-host-v1'], './bin/world-host-v1.mjs');
    assert.equal(packageJson.bin['world-host-legacy'], './bin/world-host.mjs');

    assert(packageJson.scripts.proof.includes('proof:v1-tests'));
    assert(packageJson.scripts.proof.includes('check:agent-runtime-v1-release'));
    assert(!packageJson.scripts.proof.includes('run-world-conformance'));
    assert(!Object.prototype.hasOwnProperty.call(packageJson.scripts, 'build:agent-runtime'));
    assert(!Object.prototype.hasOwnProperty.call(packageJson.scripts, 'check:agent-runtime'));
    assert.equal(packageJson.scripts['build:agent-runtime-legacy'], 'bun scripts/build-agent-runtime-pack.mjs');
    assert(packageJson.scripts['check:agent-runtime-legacy'].includes('run-agent-runtime-conformance.mjs'));
  });
});
