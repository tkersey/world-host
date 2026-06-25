import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export class NodeStoreLock {
  constructor(lockPath) {
    this.lockPath = lockPath;
    this.handle = null;
    this.ownerToken = null;
  }

  async acquire({ breakStale = false } = {}) {
    await mkdir(path.dirname(this.lockPath), { recursive: true }).catch(() => {});
    if (breakStale) await rm(this.lockPath, { force: true });
    const ownerToken = randomUUID();
    this.handle = await open(this.lockPath, 'wx');
    await this.handle.writeFile(JSON.stringify({
      ownerToken,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      staleRecoveryRequiresExplicitOperatorAction: true,
    }));
    await this.handle.sync();
    this.ownerToken = ownerToken;
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
