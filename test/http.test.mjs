import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'correct horse Filmderr test 783';

async function serverFixture(t, demo = false) {
  const prefix = join(tmpdir(), 'filmderr-http-test-');
  const directory = mkdtempSync(prefix);
  const setupToken = randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: '0', FILMDERR_DATA_DIR: join(directory, 'data'),
      FILMDERR_SETUP_TOKEN: setupToken, FILMDERR_SETUP_TOKEN_FILE: '', FILMDERR_PUBLIC_URL: '',
      FILMDERR_SECURE_COOKIES: 'false', FILMDERR_DEMO: demo ? '1' : '',
      TMPDIR: directory, TEMP: directory, TMP: directory,
    },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      child.kill();
      await exited;
    }
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const origin = await new Promise((resolveReady, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Local test server did not become ready.')), 10000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Local test server exited before ready (${code}).`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolveReady(match[1]); }
    });
  });
  function client() {
    const cookies = new Map();
    let csrf;
    return {
      get csrf() { return csrf; },
      async call(path, { method = 'GET', body, origin: chosenOrigin = origin, csrf: chosenCsrf, headers = {} } = {}) {
        const requestHeaders = { ...headers };
        if (chosenOrigin !== null) requestHeaders.Origin = chosenOrigin;
        if (cookies.size) requestHeaders.Cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
        const token = chosenCsrf === undefined ? csrf : chosenCsrf;
        if (token !== undefined && token !== null) requestHeaders['X-CSRF-Token'] = token;
        if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
        const response = await fetch(`${origin}${path}`, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        for (const cookie of response.headers.getSetCookie()) {
          const first = cookie.split(';')[0];
          const equals = first.indexOf('=');
          const key = first.slice(0, equals), value = first.slice(equals + 1);
          if (cookie.includes('Max-Age=0')) cookies.delete(key);
          else cookies.set(key, value);
        }
        const text = await response.text();
        let data; try { data = JSON.parse(text); } catch { data = text; }
        if (data && typeof data === 'object' && 'csrf' in data) csrf = data.csrf;
        return { status: response.status, data, text, headers: response.headers };
      },
    };
  }
  return { origin, setupToken, client, ownerBody: (mode = 'both') => ({ token: setupToken, email: 'owner@example.test', name: 'Owner', password: PASSWORD, authMode: mode }) };
}

test('HTTP bootstrap and local login return the new session, and logout invalidates it', async t => {
  const f = await serverFixture(t), owner = f.client(), anonymous = f.client();
  assert.equal((await anonymous.call('/api/settings')).status, 401);
  assert.equal((await anonymous.call('/api/users', { method: 'POST', body: { email: 'intruder@example.test' } })).status, 401);
  assert.equal((await owner.call('/api/setup', { method: 'POST', body: { ...f.ownerBody(), token: 'incorrect' } })).status, 403);
  const setup = await owner.call('/api/setup', { method: 'POST', body: f.ownerBody() });
  assert.equal(setup.status, 200);
  assert.equal(setup.data.configured, true);
  assert.equal(setup.data.user.email, 'owner@example.test');
  assert.equal(setup.data.user.role, 'admin');
  assert.equal(typeof setup.data.csrf, 'string');
  assert.equal(setup.data.user.localEnabled, true);
  assert.equal(setup.data.user.plexLinked, false);
  assert.match(setup.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax/);
  assert.equal((await owner.call('/api/session')).data.user.id, setup.data.user.id);
  assert.equal((await anonymous.call('/api/setup', { method: 'POST', body: f.ownerBody() })).status, 409);
  const login = await anonymous.call('/api/auth/local', { method: 'POST', body: { email: 'owner@example.test', password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.id, setup.data.user.id);
  assert.ok(login.data.csrf);
  assert.equal((await anonymous.call('/api/settings')).status, 200);
  assert.equal((await anonymous.call('/api/auth/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await anonymous.call('/api/session')).data.user, null);
  assert.equal((await anonymous.call('/api/settings')).status, 401);
});

test('HTTP Plex bootstrap requires verified Plex login and does not create a session', async t => {
  const f = await serverFixture(t), owner = f.client();
  const setup = await owner.call('/api/setup', { method: 'POST', body: f.ownerBody('plex') });
  assert.equal(setup.status, 200);
  assert.equal(setup.data.configured, true);
  assert.equal(setup.data.user, null);
  assert.equal(setup.data.csrf, null);
  assert.equal(setup.headers.getSetCookie().length, 0);
  assert.equal((await owner.call('/api/settings')).status, 401);
  assert.equal((await owner.call('/api/auth/local', { method: 'POST', body: { email: 'owner@example.test', password: PASSWORD } })).status, 403);
  assert.equal((await owner.call('/api/auth/plex/poll', { method: 'POST', body: { pinId: 42 } })).status, 401);
});

test('HTTP origin, CSRF and role boundaries protect settings and invitations', async t => {
  const f = await serverFixture(t), owner = f.client(), member = f.client();
  const setup = await owner.call('/api/setup', { method: 'POST', body: f.ownerBody() });
  assert.equal(setup.status, 200);
  const invitation = { email: 'member@example.test', name: 'Member', role: 'user', password: PASSWORD };
  assert.equal((await owner.call('/api/users', { method: 'POST', body: invitation, origin: null })).status, 403);
  assert.equal((await owner.call('/api/users', { method: 'POST', body: invitation, origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await owner.call('/api/users', { method: 'POST', body: invitation, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await owner.call('/api/users', { method: 'POST', body: invitation, csrf: null })).status, 403);
  assert.equal((await owner.call('/api/users', { method: 'POST', body: invitation, csrf: 'wrong' })).status, 403);
  assert.equal((await owner.call('/api/users', { method: 'POST', body: invitation })).status, 201);
  const login = await member.call('/api/auth/local', { method: 'POST', body: { email: invitation.email, password: PASSWORD } });
  assert.equal(login.data.user.role, 'user');
  assert.equal((await member.call('/api/settings')).status, 403);
  assert.equal((await member.call('/api/settings', { method: 'PUT', body: { region: 'US' } })).status, 403);
  assert.equal((await member.call('/api/settings/test', { method: 'POST', body: { service: 'radarr' } })).status, 403);
  assert.equal((await member.call('/api/users', { method: 'POST', body: { email: 'new-admin@example.test', role: 'admin', password: PASSWORD } })).status, 403);
  assert.equal((await member.call('/api/preferences', { method: 'PUT', body: { year: 2024, genres: [12] } })).status, 200);
  assert.equal((await member.call('/api/preferences')).data.year, 2024);
  assert.notEqual((await owner.call('/api/preferences')).data.year, 2024);
  assert.equal((await owner.call('/api/settings', { method: 'PUT', body: { authMode: 'plex' } })).status, 400, 'local owner cannot lock itself out');
});

test('HTTP settings redact secrets, preserve blank inputs, clear explicitly and reject injected URLs', async t => {
  const f = await serverFixture(t), owner = f.client();
  await owner.call('/api/setup', { method: 'POST', body: f.ownerBody() });
  const secrets = {
    radarr: { apiKey: 'radarr-secret-not-for-response', url: 'http://127.0.0.1:9' },
    plex: { token: 'plex-secret-not-for-response' },
    tmdb: { apiKey: 'tmdb-secret-not-for-response' },
    seerr: { apiKey: 'seerr-secret-not-for-response' },
  };
  const saved = await owner.call('/api/settings', { method: 'PUT', body: secrets });
  assert.equal(saved.status, 200);
  for (const secret of ['radarr-secret', 'plex-secret', 'tmdb-secret', 'seerr-secret']) assert.equal(saved.text.includes(secret), false);
  assert.equal(saved.data.settings.radarr.hasApiKey, true);
  assert.equal(saved.data.settings.plex.hasToken, true);
  const read = await owner.call('/api/settings');
  assert.equal(read.data.settings.radarr.apiKey, '');
  assert.equal(read.data.settings.plex.token, '');
  assert.equal(read.data.users.some(user => 'password' in user || 'plexId' in user), false);
  const preserved = await owner.call('/api/settings', { method: 'PUT', body: { radarr: { apiKey: '' } } });
  assert.equal(preserved.data.settings.radarr.hasApiKey, true);
  const cleared = await owner.call('/api/settings', { method: 'PUT', body: { clearSecrets: ['radarr.apiKey'] } });
  assert.equal(cleared.data.settings.radarr.hasApiKey, false);
  assert.equal(cleared.data.settings.tmdb.hasApiKey, true);
  assert.equal((await owner.call('/api/settings', { method: 'PUT', body: { publicUrl: 'https://user:secret@example.invalid' } })).status, 400);
  const badQuery = await owner.call('/api/settings', { method: 'PUT', body: { radarr: { url: 'http://127.0.0.1:9/?token=hidden-key' } } });
  assert.equal(badQuery.status, 400);
  assert.equal(badQuery.text.includes('hidden-key'), false);
});

test('HTTP static server never serves source/data outside public and sends browser protections', async t => {
  const f = await serverFixture(t), anonymous = f.client();
  const page = await anonymous.call('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const path of ['/server/index.mjs', '/data/encryption.key', '/package.json', '/..%2fserver%2findex.mjs', '/..%5cserver%5cindex.mjs', '/%00']) {
    const response = await anonymous.call(path);
    assert.ok(response.status >= 400, path);
    assert.equal(response.text.includes('const setupToken'), false);
  }
  assert.equal((await anonymous.call('/healthz')).status, 200);
});

test('isolated demo disables real integration tests, account changes and Plex authentication', async t => {
  const f = await serverFixture(t, true), visitor = f.client();
  const session = await visitor.call('/api/session');
  assert.equal(session.data.demo, true);
  assert.equal(session.data.user.role, 'admin');
  for (const [path, method, body] of [
    ['/api/settings', 'PUT', { radarr: { url: 'http://127.0.0.1:9', apiKey: 'not-saved' } }],
    ['/api/settings/test', 'POST', { service: 'radarr' }],
    ['/api/users', 'POST', { email: 'new@example.test', password: PASSWORD }],
    ['/api/auth/plex/start', 'POST', {}],
  ]) assert.equal((await visitor.call(path, { method, body })).status, 400, path);
  const settings = await visitor.call('/api/settings');
  assert.equal(settings.data.settings.radarr.hasApiKey, false);
  assert.equal(settings.data.users.length, 1);
  const deck = await visitor.call('/api/deck');
  assert.equal(deck.status, 200);
  assert.match(deck.data.warning, /simulated/);
  const decision = await visitor.call('/api/decisions', { method: 'POST', body: { tmdbId: deck.data.movies[0].id, action: 'like' } });
  assert.equal(decision.status, 201);
  assert.equal(decision.data.decision.status, 'pending');
  assert.equal((await visitor.call(`/api/decisions/${decision.data.decision.id}/undo`, { method: 'POST', body: {} })).data.decision.status, 'undone');
});
