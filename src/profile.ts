import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from './store.js';

export class Profile {
  readonly store: Store;
  private readonly ownership: Database.Database;

  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error('An explicit absolute profile directory is required');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const lockPath = join(directory, 'ownership.sqlite');
    closeSync(openSync(lockPath, 'a', 0o600)); chmodSync(lockPath, 0o600);
    this.ownership = new Database(join(directory, 'ownership.sqlite'), { timeout: 0 });
    try {
      this.ownership.exec('BEGIN EXCLUSIVE');
      const statePath = join(directory, 'state.sqlite');
      closeSync(openSync(statePath, 'a', 0o600)); chmodSync(statePath, 0o600);
      this.store = new Store(statePath);
    } catch (error) {
      this.ownership.close();
      throw error;
    }
  }

  close(): void {
    this.store.close();
    this.ownership.close();
  }
}
