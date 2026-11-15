import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, openStore } from '../server/store.mjs';

function fixture(t) {
  const prefix = join(tmpdir(), 'filmderr-store-test-');
  const directory = mkdtempSync(prefix);
  t.after(() => { assert.ok(resolve(directory).startsWith(resolve(prefix))); rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

test('encrypted JSON survives restart; secrets never appear in SQLite/WAL files', async t => {
  const directory = fixture(t);
  const store = new Store(directory);
  const value = { apiKey: 'private-api-key-test-value', password: 'private-password-test-value', flags: [true, 3, null] };
  await store.set('settings', value);
  assert.deepEqual(await store.get('settings'), value);
  for (const file of readdirSync(directory).filter(name => name !== 'encryption.key')) {
    const bytes = readFileSync(join(directory, file));
    assert.equal(bytes.includes(Buffer.from(value.apiKey)), false);
    assert.equal(bytes.includes(Buffer.from(value.password)), false);
  }
  await store.close();
  const reopened = new Store(directory);
  assert.deepEqual(await reopened.get('settings'), value);
  await reopened.set('settings', { replaced: true });
  assert.deepEqual(await reopened.get('settings'), { replaced: true });
  assert.equal(await reopened.delete('settings'), true);
  assert.equal(await reopened.delete('settings'), false);
  assert.equal(await reopened.get('settings', 'fallback'), 'fallback');
  assert.equal(await reopened.health(), true);
  await reopened.close();
});

test('prefix keys are literal and JSON keys cannot inject SQL', async t => {
  const store = new Store(fixture(t));
  try {
    await store.set('user:a', { id: 1 });
    await store.set('user:%b', { id: 2 });
    await store.set("'; DROP TABLE kv; --", { id: 3 });
    assert.deepEqual(await store.keys('user:%'), ['user:%b']);
    assert.equal((await store.get("'; DROP TABLE kv; --")).id, 3);
    assert.equal((await store.keys()).length, 3);
  } finally { await store.close(); }
});

test('a database with a missing key is never silently reset', async t => {
  const directory = fixture(t);
  const store = new Store(directory);
  await store.set('settings', { apiKey: 'private' });
  await store.close();
  unlinkSync(join(directory, 'encryption.key'));
  assert.throws(() => new Store(directory), /Encryption key is missing/);
});

test('wrong keys and swapped ciphertext fail authentication at startup', async t => {
  const directory = fixture(t);
  let store = new Store(directory);
  await store.set('a', { secret: 'alpha' });
  await store.set('b', { secret: 'beta' });
  await store.close();
  const db = new DatabaseSync(join(directory, 'filmderr.sqlite'));
  const encrypted = db.prepare('SELECT value FROM kv WHERE key = ?').get('a').value;
  db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(encrypted, 'b');
  db.close();
  assert.throws(() => new Store(directory), /could not be decrypted/);
  writeFileSync(join(directory, 'encryption.key'), randomBytes(32));
  assert.throws(() => new Store(directory), /could not be decrypted/);
});

test('openStore defaults to SQLite and rejects an unknown database type', async t => {
  const dir = fixture(t);
  const store = await openStore(dir, {});
  assert.equal(await store.ping(), true);
  await store.close();
  await assert.rejects(openStore(dir, { FILMDERR_DB_TYPE: 'unknown' }), /must be sqlite or mariadb/);
});
