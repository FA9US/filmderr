import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';

function fixture(t) {
  const prefix = join(tmpdir(), 'filmderr-store-test-');
  const directory = mkdtempSync(prefix);
  t.after(() => { assert.ok(resolve(directory).startsWith(resolve(prefix))); rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

test('encrypted JSON survives restart; secrets never appear in SQLite/WAL files', t => {
  const directory = fixture(t);
  const store = new Store(directory);
  const value = { apiKey: 'private-api-key-test-value', password: 'private-password-test-value', flags: [true, 3, null] };
  store.set('settings', value);
  assert.deepEqual(store.get('settings'), value);
  for (const file of readdirSync(directory).filter(name => name !== 'encryption.key')) {
    const bytes = readFileSync(join(directory, file));
    assert.equal(bytes.includes(Buffer.from(value.apiKey)), false);
    assert.equal(bytes.includes(Buffer.from(value.password)), false);
  }
  store.close();
  const reopened = new Store(directory);
  assert.deepEqual(reopened.get('settings'), value);
  reopened.set('settings', { replaced: true });
  assert.deepEqual(reopened.get('settings'), { replaced: true });
  assert.equal(reopened.delete('settings'), true);
  assert.equal(reopened.delete('settings'), false);
  assert.equal(reopened.get('settings', 'fallback'), 'fallback');
  reopened.close();
});

test('prefix keys are literal and JSON keys cannot inject SQL', t => {
  const store = new Store(fixture(t));
  try {
    store.set('user:a', { id: 1 });
    store.set('user:%b', { id: 2 });
    store.set("'; DROP TABLE kv; --", { id: 3 });
    assert.deepEqual(store.keys('user:%'), ['user:%b']);
    assert.equal(store.get("'; DROP TABLE kv; --").id, 3);
    assert.equal(store.keys().length, 3);
  } finally { store.close(); }
});

test('a database with a missing key is never silently reset', t => {
  const directory = fixture(t);
  const store = new Store(directory);
  store.set('settings', { apiKey: 'private' });
  store.close();
  unlinkSync(join(directory, 'encryption.key'));
  assert.throws(() => new Store(directory), /Encryption key is missing/);
});

test('wrong keys and swapped ciphertext fail authentication', t => {
  const directory = fixture(t);
  let store = new Store(directory);
  store.set('a', { secret: 'alpha' });
  store.set('b', { secret: 'beta' });
  store.close();
  const db = new DatabaseSync(join(directory, 'filmderr.sqlite'));
  const encrypted = db.prepare('SELECT value FROM kv WHERE key = ?').get('a').value;
  db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(encrypted, 'b');
  db.close();
  store = new Store(directory);
  assert.deepEqual(store.get('a'), { secret: 'alpha' });
  assert.throws(() => store.get('b'), /could not be decrypted/);
  store.close();
  writeFileSync(join(directory, 'encryption.key'), randomBytes(32));
  store = new Store(directory);
  assert.throws(() => store.get('a'), /could not be decrypted/);
  store.close();
});
