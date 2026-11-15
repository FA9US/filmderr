import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** A small encrypted JSON store. Back up both the database and encryption.key. */
export class Store {
  #db;
  #key;

  constructor(directory) {
    const dir = resolve(directory);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyPath = join(dir, 'encryption.key');
    const dbPath = join(dir, 'filmderr.sqlite');
    if (!existsSync(keyPath)) {
      if (existsSync(dbPath) && statSync(dbPath).size > 0) {
        throw new Error('Encryption key is missing. Restore the original key with the database.');
      }
      try {
        writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    this.#key = readFileSync(keyPath);
    if (this.#key.length !== 32) throw new Error('Encryption key is invalid. Restore the original key.');
    chmodSync(keyPath, 0o600);
    this.#db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL) STRICT;');
  }

  get(key, fallback = null) {
    const row = this.#db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
      const bytes = Buffer.from(row.value);
      if (bytes.length < 29 || bytes[0] !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(1, 13));
      decipher.setAAD(Buffer.from(key));
      decipher.setAuthTag(bytes.subarray(13, 29));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8'));
    } catch {
      throw new Error('Stored data could not be decrypted. Restore a matching database and key backup.');
    }
  }

  set(key, value) {
    if (typeof key !== 'string' || !key || key.length > 512) throw new TypeError('Invalid store key.');
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('Store value must be JSON.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(key));
    const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const encrypted = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
    this.#db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, encrypted);
    return value;
  }

  delete(key) {
    return this.#db.prepare('DELETE FROM kv WHERE key = ?').run(key).changes > 0;
  }

  keys(prefix = '') {
    // A literal prefix, including '%' and '_', must not become a SQL pattern.
    return this.#db.prepare('SELECT key FROM kv WHERE substr(key, 1, ?) = ? ORDER BY key').all(prefix.length, prefix).map(row => row.key);
  }

  close() {
    this.#db.close();
    this.#key.fill(0);
  }
}
