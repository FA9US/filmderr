import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RecordCipher, StorageError, validKey } from './store-crypto.mjs';

/** SQLite is for local disks only. Select MariaDB when persistent data belongs on NAS. */
export class Store {
  #db;
  #cipher;
  #closed = false;
  constructor(directory) {
    const dir = resolve(directory);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dbPath = join(dir, 'filmderr.sqlite');
    this.#cipher = new RecordCipher(dir, existsSync(dbPath) && statSync(dbPath).size > 0);
    try {
      this.#db = new DatabaseSync(dbPath);
      chmodSync(dbPath, 0o600);
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL) STRICT;');
      for (const row of this.#db.prepare('SELECT key, value FROM kv').all()) this.#cipher.decrypt(row.key, row.value);
    } catch (error) {
      this.#db?.close(); this.#cipher.close();
      if (error instanceof StorageError) throw error;
      throw new StorageError('Filmderr could not open its local SQLite database. Check the data directory.');
    }
  }
  async get(key, fallback = null) {
    validKey(key);
    const row = this.#db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? this.#cipher.decrypt(key, row.value) : fallback;
  }
  async set(key, value) {
    const encrypted = this.#cipher.encrypt(key, value);
    this.#db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, encrypted);
    return value;
  }
  async delete(key) {
    validKey(key);
    return this.#db.prepare('DELETE FROM kv WHERE key = ?').run(key).changes > 0;
  }
  async keys(prefix = '') {
    validKey(prefix, true);
    return this.#db.prepare('SELECT key FROM kv WHERE substr(key, 1, ?) = ? ORDER BY key').all(prefix.length, prefix).map(row => row.key);
  }
  async health() {
    try { this.#db.prepare('SELECT 1').get(); return true; }
    catch { throw new StorageError(); }
  }
  async ping() { return this.health(); }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close(); this.#cipher.close();
  }
}

export async function openStore(directory, env = process.env, options = {}) {
  const type = (env.FILMDERR_DB_TYPE || 'sqlite').toLowerCase();
  if (type === 'sqlite') return new Store(directory);
  if (type === 'mariadb') {
    const { MariaDbStore } = await import('./store-mariadb.mjs');
    return MariaDbStore.open(directory, env, options);
  }
  throw new StorageError('FILMDERR_DB_TYPE must be sqlite or mariadb.');
}
