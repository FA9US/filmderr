import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class StorageError extends Error {
  constructor(message = 'Filmderr storage is unavailable. Check its database connection and restart Filmderr.') {
    super(message);
    this.status = 503;
    this.code = 'FILMDERR_STORAGE';
  }
}

export function validKey(key, allowEmpty = false) {
  if (typeof key !== 'string' || (!key && !allowEmpty) || Buffer.byteLength(key) > 512) throw new TypeError('Invalid store key.');
}

/** Only encrypted records leave the application. Keep this key with the database backup. */
export class RecordCipher {
  #key;
  constructor(directory, populated) {
    try {
      const dir = resolve(directory);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, 'encryption.key');
      if (!existsSync(path)) {
        if (populated) throw new StorageError('Encryption key is missing. Restore the original key with the database.');
        let fd;
        try {
          fd = openSync(path, 'wx', 0o600);
          writeSync(fd, randomBytes(32));
          fsyncSync(fd);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        } finally { if (fd !== undefined) closeSync(fd); }
        // File fsync alone does not make a newly created directory entry durable on POSIX.
        if (process.platform !== 'win32') {
          const directoryFd = openSync(dir, 'r');
          try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
        }
      }
      this.#key = readFileSync(path);
      if (this.#key.length !== 32) throw new StorageError('Encryption key is invalid. Restore the original key.');
      chmodSync(path, 0o600);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('Filmderr cannot read or create its encryption key. Check the appdata directory permissions.');
    }
  }
  encrypt(key, value) {
    validKey(key);
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('Store value must be JSON.');
    if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw new TypeError('Store value is too large.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(key));
    const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
  }
  decrypt(key, value) {
    try {
      const bytes = Buffer.from(value);
      if (bytes.length < 29 || bytes[0] !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(1, 13));
      decipher.setAAD(Buffer.from(key));
      decipher.setAuthTag(bytes.subarray(13, 29));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8'));
    } catch {
      throw new StorageError('Stored data could not be decrypted. Restore a matching database and key backup.');
    }
  }
  close() { this.#key?.fill(0); }
}
