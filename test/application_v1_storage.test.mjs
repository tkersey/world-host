import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';

import {
  MemoryBlockStore,
  MemoryBranchHeadStore,
  blockRef,
  makeHead,
} from '../src/v1/index.mjs';

describe('World application v1 immutable blocks', () => {
  it('copies retained bytes and validates every block reference', async () => {
    const store = new MemoryBlockStore();
    const source = Buffer.from('frame');
    const ref = await store.putBlock(source);
    source.fill(0);

    assert.deepEqual(await store.getBlock(ref), Buffer.from('frame'));
    assert.equal(await store.hasBlock(ref), true);
    assert.deepEqual(ref, blockRef(Buffer.from('frame')));
    await assert.rejects(
      () => store.getBlock({ ...ref, byteLength: ref.byteLength + 1 }),
      { code: 'ERR_APPLICATION_V1_BLOCK_CORRUPT' },
    );
  });
});

describe('World application v1 conditional branch heads', () => {
  it('advances only from the exact expected head', async () => {
    const store = new MemoryBranchHeadStore();
    const genesis = fixtureHead(0, 1);
    const child = fixtureHead(1, 2);

    assert.equal((await store.advanceHeadIfCurrent('run', 'main', null, genesis)).advanced, true);
    assert.equal((await store.advanceHeadIfCurrent('run', 'main', null, child)).advanced, false);
    assert.equal((await store.advanceHeadIfCurrent('run', 'main', genesis, child)).advanced, true);
    assert.deepEqual(await store.readHead('run', 'main'), child);
  });

  it('rejects skipped generations', async () => {
    const store = new MemoryBranchHeadStore();
    const genesis = fixtureHead(0, 1);
    await store.advanceHeadIfCurrent('run', 'main', null, genesis);

    await assert.rejects(
      () => store.advanceHeadIfCurrent('run', 'main', genesis, fixtureHead(2, 2)),
      { code: 'ERR_APPLICATION_V1_HEAD_GENERATION' },
    );
  });
});

function fixtureHead(generation, marker) {
  const bytes = Buffer.from([marker]);
  return makeHead({
    generation,
    applicationId: Buffer.alloc(32, 1).toString('hex'),
    frameId: Buffer.alloc(32, marker).toString('hex'),
    frameRef: blockRef(bytes),
    status: 0,
  });
}
