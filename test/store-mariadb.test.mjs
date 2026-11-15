import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import mariadb from 'mariadb';
import { openStore } from '../server/store.mjs';

const ENV = { FILMDERR_DB_TYPE: 'mariadb', FILMDERR_DB_HOST: '127.0.0.1', FILMDERR_DB_NAME: 'filmderr_test', FILMDERR_DB_USER: 'filmderr', FILMDERR_DB_PASSWORD: 'fake-test-password-only' };

function fixture(t) {
  const prefix = join(tmpdir(), 'filmderr-sql-test-');
  const dir = mkdtempSync(prefix), stores = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    assert.ok(resolve(dir).startsWith(resolve(prefix)));
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, stores, async open(env, options) { const store = await openStore(dir, env, options); stores.push(store); return store; } };
}

/** Protocol fake tests failure handling; the separately enabled integration test uses real MariaDB. */
class FakeDatabase {
  records = new Map();
  table = false;
  extraTables = [];
  lockOwner = null;
  offline = false;
  sql = [];
  connections = [];
  createConnection = async config => {
    this.lastConfig = config;
    const database = this;
    const connection = new class extends EventEmitter {
      async query({ sql }, params = []) {
        database.sql.push({ sql, params });
        if (database.offline) throw new Error('connection refused password=fake-test-password-only sql=private');
        if (sql === 'SELECT DATABASE() AS name') return [{ name: config.database }];
        if (sql.includes('GET_LOCK(')) {
          if (database.lockOwner && database.lockOwner !== this) return [{ acquired: 0 }];
          database.lockOwner = this; return [{ acquired: 1 }];
        }
        if (sql === 'SHOW TABLES') return [...(database.table ? ['filmderr_kv'] : []), ...database.extraTables].map(name => ({ table: name }));
        if (sql.startsWith('CREATE TABLE')) { database.table = true; return {}; }
        if (sql.startsWith('SELECT ENGINE')) return [{ engine: 'InnoDB' }];
        if (sql.startsWith('SELECT IF(IS_USED_LOCK')) return [{ held: database.lockOwner === this ? 1 : 0 }];
        if (sql === 'SELECT store_key, value FROM filmderr_kv ORDER BY store_key') return [...database.records].map(([key, value]) => ({ store_key: Buffer.from(key), value: Buffer.from(value) }));
        if (sql.startsWith('SELECT value')) return database.records.has(params[0].toString()) ? [{ value: Buffer.from(database.records.get(params[0].toString())) }] : [];
        if (sql.startsWith('INSERT INTO')) { database.records.set(params[0].toString(), Buffer.from(params[1])); return { affectedRows: 1 }; }
        if (sql.startsWith('DELETE FROM')) return { affectedRows: database.records.delete(params[0].toString()) ? 1 : 0 };
        if (sql.startsWith('SELECT store_key FROM')) return [...database.records.keys()].filter(key => Buffer.from(key).subarray(0, params[0]).equals(params[1])).sort().map(key => ({ store_key: Buffer.from(key) }));
        throw new Error('Unexpected test query');
      }
      async end() { if (database.lockOwner === this) database.lockOwner = null; }
      destroy() { if (database.lockOwner === this) database.lockOwner = null; }
    }();
    database.connections.push(connection);
    return connection;
  };
}

test('MariaDB contract encrypts persisted values, uses literal prefixes and survives reopening', async t => {
  const f = fixture(t), db = new FakeDatabase();
  let store = await f.open(ENV, { createConnection: db.createConnection });
  await store.set('settings', { apiKey: 'secret-api-value' });
  await store.set('user:%', { id: 3 });
  await store.set('user:é', { id: 4 });
  await store.set("'; DROP DATABASE anything; --", { id: 5 });
  assert.equal(db.records.get('settings').includes(Buffer.from('secret-api-value')), false);
  assert.deepEqual(await store.keys('user:%'), ['user:%']);
  assert.deepEqual(await store.keys('user:é'), ['user:é']);
  assert.equal((await store.get("'; DROP DATABASE anything; --")).id, 5);
  assert.equal(await store.health(), true);
  assert.equal(existsSync(join(f.dir, 'filmderr.sqlite')), false);
  await store.close();
  store = await f.open(ENV, { createConnection: db.createConnection });
  assert.deepEqual(await store.get('settings'), { apiKey: 'secret-api-value' });
  assert.equal(await store.delete('settings'), true);
  assert.equal(await store.delete('settings'), false);
  assert.equal(await store.get('settings', 'missing'), 'missing');
  assert.equal(db.sql.some(({ sql }) => /CREATE DATABASE|CREATE USER|GRANT /i.test(sql)), false);
  assert.equal(db.lastConfig.multipleStatements, false);
  assert.equal(db.lastConfig.logParam, false);
});

test('MariaDB refuses second instance and releases its lock only when connection closes', async t => {
  const f = fixture(t), other = fixture(t), db = new FakeDatabase();
  const store = await f.open(ENV, { createConnection: db.createConnection });
  await assert.rejects(other.open(ENV, { createConnection: db.createConnection }), /only one replica/);
  assert.equal(await store.health(), true);
  assert.equal(existsSync(join(other.dir, 'encryption.key')), false);
  await store.close();
  const restarted = await f.open(ENV, { createConnection: db.createConnection });
  assert.equal(await restarted.health(), true);
});

test('MariaDB refuses missing or wrong encryption keys for populated data', async t => {
  const f = fixture(t), missing = fixture(t), wrong = fixture(t), db = new FakeDatabase();
  const store = await f.open(ENV, { createConnection: db.createConnection });
  await store.set('settings', { secret: 'must-survive' });
  await store.close();
  await assert.rejects(missing.open(ENV, { createConnection: db.createConnection }), /Encryption key is missing/);
  assert.equal(existsSync(join(missing.dir, 'encryption.key')), false);
  writeFileSync(join(wrong.dir, 'encryption.key'), randomBytes(32));
  await assert.rejects(wrong.open(ENV, { createConnection: db.createConnection }), /could not be decrypted/);
  const valid = await f.open(ENV, { createConnection: db.createConnection });
  assert.equal((await valid.get('settings')).secret, 'must-survive');
});

test('MariaDB failure or lost lock disables all subsequent operations without fallback', async t => {
  const f = fixture(t), db = new FakeDatabase();
  const store = await f.open(ENV, { createConnection: db.createConnection });
  await store.set('settings', { secret: 'value' });
  db.offline = true;
  await assert.rejects(store.health(), error => error.status === 503 && !error.message.includes('password='));
  db.offline = false;
  await assert.rejects(store.get('settings'), { status: 503 });
  await assert.rejects(store.set('settings', { changed: true }), { status: 503 });
  assert.equal(existsSync(join(f.dir, 'filmderr.sqlite')), false);
  await store.close();
  const reopened = await f.open(ENV, { createConnection: db.createConnection });
  db.lockOwner = null;
  await assert.rejects(reopened.health(), /lost its database instance lock/);
  await assert.rejects(reopened.delete('settings'), { status: 503 });
});

test('MariaDB password files work; invalid schemas, unrelated data and connection errors fail safely', async t => {
  const f = fixture(t), db = new FakeDatabase();
  const passwordPath = join(f.dir, 'database-password.txt');
  writeFileSync(passwordPath, 'fixture-password-from-file\n');
  const store = await f.open({ ...ENV, FILMDERR_DB_PASSWORD: '', FILMDERR_DB_PASSWORD_FILE: passwordPath }, { createConnection: db.createConnection });
  assert.equal(db.lastConfig.password, 'fixture-password-from-file');
  await store.close();
  await assert.rejects(f.open({ ...ENV, FILMDERR_DB_NAME: 'mysql' }, { createConnection: db.createConnection }), /dedicated Filmderr database/);
  await assert.rejects(f.open({ ...ENV, FILMDERR_DB_USER: ' Root ' }, { createConnection: db.createConnection }), /not root/);
  await assert.rejects(f.open({ ...ENV, FILMDERR_DB_PASSWORD_FILE: passwordPath }, { createConnection: db.createConnection }), /not both/);
  db.extraTables.push('another_application');
  await assert.rejects(f.open(ENV, { createConnection: db.createConnection }), /unrelated tables/);
  await assert.rejects(f.open(ENV, { createConnection: async () => { throw new Error('password=do-not-leak'); } }), error => error.status === 503 && !error.message.includes('do-not-leak'));
});

const realEnabled = Boolean(process.env.FILMDERR_TEST_DB_HOST);
test('real MariaDB: persistence, encrypted rows, key rejection, lock contention and cleanup', { skip: !realEnabled }, async t => {
  const env = { FILMDERR_DB_TYPE: 'mariadb' };
  for (const key of ['HOST', 'PORT', 'NAME', 'USER', 'PASSWORD']) env[`FILMDERR_DB_${key}`] = process.env[`FILMDERR_TEST_DB_${key}`];
  assert.match(env.FILMDERR_DB_NAME || '', /^filmderr_test(?:_[a-zA-Z0-9]+)?$/, 'Use an isolated Filmderr test database only');
  assert.notEqual(env.FILMDERR_DB_USER?.toLowerCase(), 'root', 'Use a dedicated test database account');
  const f = fixture(t), missing = fixture(t), wrong = fixture(t);
  const control = await mariadb.createConnection({ host: env.FILMDERR_DB_HOST, port: Number(env.FILMDERR_DB_PORT || 3306), database: env.FILMDERR_DB_NAME, user: env.FILMDERR_DB_USER, password: env.FILMDERR_DB_PASSWORD, connectTimeout: 5000 });
  t.after(async () => {
    // The disposable CI database must be empty for the subsequent container smoke test.
    try { await control.query('DELETE FROM filmderr_kv'); } finally { await control.end(); }
  });
  let store = await f.open(env);
  const secret = `ci-private-value-${randomBytes(16).toString('hex')}`;
  await store.set('settings', { secret, array: [1, true, null] });
  await store.set('user:%', { count: 3 });
  assert.deepEqual(await store.keys('user:%'), ['user:%']);
  const rows = await control.query('SELECT value FROM filmderr_kv');
  assert.ok(rows.length >= 2);
  assert.equal(rows.some(row => Buffer.from(row.value).includes(Buffer.from(secret))), false);
  await assert.rejects(missing.open(env), /only one replica/);
  assert.equal(await store.health(), true);
  await store.close();
  await assert.rejects(missing.open(env), /Encryption key is missing/);
  writeFileSync(join(wrong.dir, 'encryption.key'), randomBytes(32));
  await assert.rejects(wrong.open(env), /could not be decrypted/);
  store = await f.open(env);
  assert.deepEqual(await store.get('settings'), { secret, array: [1, true, null] });
  assert.equal(await store.delete('user:%'), true);
  assert.equal(await store.delete('user:%'), false);
  assert.equal(await store.ping(), true);
  for (const key of await store.keys()) await store.delete(key);
  await store.close();
});
