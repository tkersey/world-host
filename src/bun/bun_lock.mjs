import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export class BunStoreLock {
  constructor(lockPath, options = {}) {
    this.lockPath = lockPath;
    this.handle = null;
    this.ownerToken = null;
    this.writeMetadata = options.writeMetadata ?? ((handle, metadata) => handle.writeFile(metadata));
  }

  async acquire({ breakStale = false } = {}) {
    await mkdir(path.dirname(this.lockPath), { recursive: true }).catch(() => {});
    if (breakStale) await rm(this.lockPath, { force: true });
    const ownerToken = randomUUID();
    const handle = await open(this.lockPath, 'wx');
    try {
      await this.writeMetadata(handle, JSON.stringify({
        ownerToken,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        staleRecoveryRequiresExplicitOperatorAction: true,
      }));
      await handle.sync();
      this.handle = handle;
      this.ownerToken = ownerToken;
    } catch (error) {
      await removeLockPathIfSameFile(this.lockPath, handle).catch(() => {});
      await handle.close().catch(() => {});
      throw error;
    }
    return this;
  }

  async release() {
    if (!this.handle) return;
    const ownerToken = this.ownerToken;
    await this.handle.close();
    this.handle = null;
    this.ownerToken = null;
    if (!ownerToken) return;
    let currentToken = null;
    try {
      currentToken = JSON.parse(await readFile(this.lockPath, 'utf8'))?.ownerToken ?? null;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (currentToken === ownerToken) await rm(this.lockPath, { force: true });
  }
}

async function removeLockPathIfSameFile(lockPath, handle) {
  const [handleStat, pathStat] = await Promise.all([
    handle.stat(),
    stat(lockPath),
  ]);
  if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) return;
  await rm(lockPath, { force: true });
}
