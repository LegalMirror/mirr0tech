import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Single-process development store. Atomic replacement and fsync persist each intent before signing.
// A process lock prevents two backends from spending the same ledger concurrently.
export class Store {
  constructor(directory) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.path = resolve(this.directory, 'state.json');
    this.lock = resolve(this.directory, 'server.lock');
    try {
      this.lockFd = openSync(this.lock, 'wx', 0o600);
      writeFileSync(this.lockFd, `${process.pid}\n`);
    } catch { throw new Error(`Data directory is locked: ${this.lock}. Stop its owner before removing a stale lock.`); }
    try {
      try { this.state = JSON.parse(readFileSync(this.path, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.state = { version: 1, namespace: null, investors: {}, deposits: {}, operations: {}, withdrawals: {}, audit: [], chain: { supply: '0', processed: {} } };
      }
      if (this.state.version !== 1) throw new Error('Unsupported ledger version');
    } catch (error) { this.close(); throw error; }
  }

  update(mutator) {
    const next = structuredClone(this.state);
    const result = mutator(next);
    const temporary = `${this.path}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, this.path);
    const directoryFd = openSync(this.directory, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    this.state = next;
    return structuredClone(result);
  }

  close() {
    if (this.lockFd !== undefined) {
      closeSync(this.lockFd);
      this.lockFd = undefined;
      rmSync(this.lock);
    }
  }
}
