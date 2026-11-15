import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mariadb from 'mariadb';
import { RecordCipher, StorageError, validKey } from './store-crypto.mjs';

const SCHEMA = 'CREATE TABLE IF NOT EXISTS filmderr_kv (store_key VARBINARY(512) NOT NULL PRIMARY KEY, value LONGBLOB NOT NULL) ENGINE=InnoDB';
const noLog = () => {};

function configuration(env) {
  const host = env.FILMDERR_DB_HOST, database = env.FILMDERR_DB_NAME, user = env.FILMDERR_DB_USER;
  const port = Number(env.FILMDERR_DB_PORT || 3306);
  if (typeof host !== 'string' || !/^[\w.:[\]-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new StorageError('Set a valid FILMDERR_DB_HOST and FILMDERR_DB_PORT.');
  if (typeof database !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(database) || ['mysql', 'information_schema', 'performance_schema', 'sys'].includes(database.toLowerCase())) throw new StorageError('Set FILMDERR_DB_NAME to a dedicated Filmderr database.');
  if (typeof user !== 'string' || !user.trim() || user.length > 128 || user.trim().toLowerCase() === 'root') throw new StorageError('Set FILMDERR_DB_USER to a dedicated Filmderr database account, not root.');
  let password = env.FILMDERR_DB_PASSWORD;
  if (env.FILMDERR_DB_PASSWORD_FILE) {
    if (password) throw new StorageError('Set either FILMDERR_DB_PASSWORD or FILMDERR_DB_PASSWORD_FILE, not both.');
    try { password = readFileSync(env.FILMDERR_DB_PASSWORD_FILE, 'utf8').replace(/[\r\n]+$/, ''); }
    catch { throw new StorageError('The configured MariaDB password file cannot be read.'); }
  }
  if (typeof password !== 'string' || !password || password.length > 4096) throw new StorageError('Set FILMDERR_DB_PASSWORD or FILMDERR_DB_PASSWORD_FILE.');
  return { host, port, database, user, password, connectTimeout: 5000, multipleStatements: false, permitLocalInfile: false,
    trace: false, debug: false, logParam: false, logger: { network: noLog, query: noLog, error: noLog, warning: noLog } };
}

/** A dedicated connection owns the single-instance lock for the entire store lifetime. */
export class MariaDbStore {
  #connection;
  #cipher;
  #lock;
  #unavailable = false;
  #closed = false;

  static async open(directory, env, { createConnection = mariadb.createConnection } = {}) {
    const config = configuration(env);
    let connection, cipher;
    try {
      connection = await createConnection(config);
      connection.on?.('error', noLog);
      const identity = await connection.query({ sql: 'SELECT DATABASE() AS name', timeout: 10000 });
      if (!identity?.[0]?.name) throw new StorageError('MariaDB did not select the dedicated Filmderr database.');
      const lock = `filmderr:${createHash('sha256').update(String(identity[0].name)).digest('hex').slice(0, 48)}`;
      const acquired = await connection.query({ sql: 'SELECT GET_LOCK(?, 0) AS acquired', timeout: 10000 }, [lock]);
      if (Number(acquired?.[0]?.acquired) !== 1) throw new StorageError('Another Filmderr instance is using this database. Run only one replica.');
      const tables = await connection.query({ sql: 'SHOW TABLES', timeout: 10000 });
      if (tables.some(row => Object.values(row).some(name => name !== 'filmderr_kv'))) throw new StorageError('Use a dedicated Filmderr database. The selected database contains unrelated tables.');
      await connection.query({ sql: SCHEMA, timeout: 10000 });
      const engine = await connection.query({ sql: "SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'filmderr_kv'", timeout: 10000 });
      if (String(engine?.[0]?.engine).toLowerCase() !== 'innodb') throw new StorageError('The Filmderr database table must use InnoDB. No data was changed.');
      const rows = await connection.query({ sql: 'SELECT store_key, value FROM filmderr_kv ORDER BY store_key', timeout: 10000 });
      cipher = new RecordCipher(directory, rows.length > 0);
      for (const row of rows) cipher.decrypt(Buffer.from(row.store_key).toString('utf8'), row.value);
      const store = new MariaDbStore();
      store.#connection = connection; store.#cipher = cipher; store.#lock = lock;
      connection.on?.('error', () => { store.#unavailable = true; });
      await store.health();
      return store;
    } catch (error) {
      cipher?.close();
      if (connection) { try { await connection.end(); } catch { connection.destroy?.(); } }
      if (error instanceof StorageError) throw error;
      throw new StorageError('Filmderr could not connect to its MariaDB database or initialize its table. Check the dedicated database account and connection.');
    }
  }

  async #query(sql, params = []) {
    if (this.#closed || this.#unavailable) throw new StorageError();
    try { return await this.#connection.query({ sql, timeout: 10000 }, params); }
    catch { this.#unavailable = true; throw new StorageError(); }
  }
  async get(key, fallback = null) {
    validKey(key);
    const rows = await this.#query('SELECT value FROM filmderr_kv WHERE store_key = ?', [Buffer.from(key)]);
    if (!rows.length) return fallback;
    try { return this.#cipher.decrypt(key, rows[0].value); }
    catch (error) { this.#unavailable = true; throw error; }
  }
  async set(key, value) {
    const encrypted = this.#cipher.encrypt(key, value);
    await this.#query('INSERT INTO filmderr_kv (store_key, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [Buffer.from(key), encrypted]);
    return value;
  }
  async delete(key) {
    validKey(key);
    const result = await this.#query('DELETE FROM filmderr_kv WHERE store_key = ?', [Buffer.from(key)]);
    return Number(result.affectedRows) > 0;
  }
  async keys(prefix = '') {
    validKey(prefix, true);
    const bytes = Buffer.from(prefix);
    const rows = await this.#query('SELECT store_key FROM filmderr_kv WHERE LEFT(store_key, ?) = ? ORDER BY store_key', [bytes.length, bytes]);
    return rows.map(row => Buffer.from(row.store_key).toString('utf8'));
  }
  async health() {
    const rows = await this.#query('SELECT IF(IS_USED_LOCK(?) = CONNECTION_ID(), 1, 0) AS held', [this.#lock]);
    if (Number(rows?.[0]?.held) !== 1) { this.#unavailable = true; throw new StorageError('Filmderr lost its database instance lock. Restart it after checking for another instance.'); }
    return true;
  }
  async ping() { return this.health(); }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.#connection.end(); }
    catch { this.#connection.destroy?.(); throw new StorageError('Filmderr could not close its database connection cleanly.'); }
    finally { this.#cipher.close(); }
  }
}
