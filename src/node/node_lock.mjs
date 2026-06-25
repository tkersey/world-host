import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export class NodeStoreLock {
  constructor(lockPath) {
    this.lockPath = lockPath;
    this.handle = null;
  }

  async acquire({ breakStale = false } = {}) {
    await mkdir(path.dirname(this.lockPath), { recursive: true }).catch(() => {});
    if (breakStale) await rm(this.lockPath, { force: true });
    this.handle = await open(this.lockPath, 'wx');
    await this.handle.writeFile(JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      staleRecoveryRequiresExplicitOperatorAction: true,
    }));
    await this.handle.sync();
    return this;
  }

  async release() {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
    await rm(this.lockPath, { force: true });
  }
}
