import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { Auth } from '../server/auth.mjs';

const TOKEN = 'unit-test-setup-token-with-32-characters';
const PASSWORD = 'a strong test passphrase 27';
function response() {
  const headers = new Map();
  return { setHeader: (key, value) => headers.set(key.toLowerCase(), value), getHeader: key => headers.get(key.toLowerCase()) };
}
function request(res, extra = {}) {
  const cookies = (res?.getHeader('Set-Cookie') || []).filter(value => !value.includes('Max-Age=0')).map(value => value.split(';')[0]).join('; ');
  return { headers: { cookie: cookies }, socket: { remoteAddress: '127.0.0.1' }, ...extra };
}
async function fixture(t, options = {}) {
  const prefix = join(tmpdir(), 'filmderr-auth-test-');
  const directory = mkdtempSync(prefix);
  const store = new Store(directory);
  const auth = await new Auth(store, { setupToken: TOKEN, secureCookies: true, ...options }).init();
  t.after(async () => { await store.close(); assert.ok(resolve(directory).startsWith(resolve(prefix))); rmSync(directory, { recursive: true, force: true }); });
  return { auth, store };
}
const setupBody = (authMode = 'both') => ({ token: TOKEN, email: 'Owner@Example.com', name: 'Owner', password: PASSWORD, authMode });

test('bootstrap requires a strong configured secret and cannot be repeated', async t => {
  const { auth } = (await fixture(t));
  await assert.rejects(auth.setup({ ...setupBody(), token: 'wrong' }, request(), response()), { status: 403 });
  assert.equal((await auth.configured()), false);
  const result = await auth.setup(setupBody(), request(), response());
  assert.equal(result.user.role, 'admin');
  assert.equal(result.user.email, 'owner@example.com');
  await assert.rejects(auth.setup(setupBody(), request(), response()), { status: 409 });
  const weak = (await fixture(t, { setupToken: 'short' })).auth;
  await assert.rejects(weak.setup({ ...setupBody(), token: 'short' }, request(), response()), { status: 503 });
});

test('Plex-only bootstrap never issues a local session; local login is disabled', async t => {
  const { auth } = (await fixture(t));
  const res = response();
  assert.deepEqual(await auth.setup(setupBody('plex'), request(), res), { configured: true, user: null, csrf: null });
  assert.equal(res.getHeader('Set-Cookie'), undefined);
  await assert.rejects(auth.localLogin({ email: 'owner@example.com', password: PASSWORD }, request(), response()), { status: 403 });
});

test('local credentials use scrypt and sessions persist only hashed tokens/CSRF', async t => {
  const { auth, store } = (await fixture(t));
  const res = response();
  const result = await auth.setup(setupBody(), request(), res);
  assert.match(res.getHeader('Set-Cookie')[0], /HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  const rawToken = res.getHeader('Set-Cookie')[0].split(';')[0].split('=')[1];
  const saved = (await store.get((await store.keys('session:'))[0]));
  assert.equal(JSON.stringify(saved).includes(rawToken), false);
  assert.equal(JSON.stringify(saved).includes(result.csrf), false);
  assert.equal((await store.keys('session:'))[0].includes(rawToken), false);
  assert.equal((await store.get((await store.keys('user:'))[0])).password.algorithm, 'scrypt');
  assert.equal(JSON.stringify((await store.get((await store.keys('user:'))[0]))).includes(PASSWORD), false);
  assert.equal(JSON.stringify((await auth.users())).includes('password'), false);
  assert.deepEqual((await auth.session(request(res))), result);
  assert.equal((await auth.session({ headers: { cookie: `filmderr_session=${'x'.repeat(43)}` } })), null);
  await assert.rejects(auth.localLogin({ email: 'owner@example.com', password: 'wrong' }, request(), response()), { status: 401 });
  await assert.rejects(auth.localLogin({ email: 'missing@example.com', password: PASSWORD }, request(), response()), { status: 401 });
  const loginRes = response();
  const login = await auth.localLogin({ email: 'OWNER@EXAMPLE.COM', password: PASSWORD }, request(res), loginRes);
  assert.equal(login.user.id, result.user.id);
  assert.equal((await auth.session(request(res))), null, 'old session rotates on login');
  assert.ok((await auth.session(request(loginRes))));
  (await auth.logout(request(loginRes), response()));
  assert.equal((await auth.session(request(loginRes))), null);
});

test('weak local passwords and duplicate invitations are rejected', async t => {
  const { auth } = (await fixture(t));
  await assert.rejects(auth.setup({ ...setupBody(), password: 'short' }, request(), response()), { status: 400 });
  assert.equal((await auth.configured()), false);
  await auth.setup(setupBody(), request(), response());
  const invited = await auth.addUser({ email: 'Friend@example.com', name: 'Friend', role: 'user' });
  assert.equal(invited.role, 'user');
  assert.equal('password' in invited, false);
  await assert.rejects(auth.addUser({ email: 'friend@example.com' }), { status: 409 });
  await assert.rejects(auth.addUser({ email: 'other@example.com', role: 'superuser' }), { status: 400 });
  await assert.rejects(auth.localLogin({ email: 'friend@example.com', password: PASSWORD }, request(), response()), { status: 401 });
});

test('expired sessions are invalidated', async t => {
  let clock = 100000;
  const { auth } = (await fixture(t, { now: () => clock }));
  const res = response();
  await auth.setup(setupBody(), request(), res);
  clock += 31 * 24 * 60 * 60 * 1000;
  assert.equal((await auth.session(request(res))), null);
});

function plexMock(profile, token = 'plex-access-token-private') {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const data = url.endsWith('pins?strong=true') ? { id: 42, code: 'pin_code_private_42' }
      : url.endsWith('pins/42') ? { id: 42, code: 'pin_code_private_42', authToken: token }
        : profile;
    return { ok: true, json: async () => data };
  };
  return { calls, fetchImpl };
}

test('Plex PIN is cookie bound, owner email verified, token never returned or put in URLs', async t => {
  const mock = plexMock({ id: 10, email: 'owner@example.com', confirmed: true, thumb: 'https://plex.tv/avatar.jpg' });
  const { auth, store } = (await fixture(t, { fetchImpl: mock.fetchImpl }));
  await auth.setup(setupBody('plex'), request(), response());
  const startRes = response();
  const start = await auth.plexStart(request(), startRes);
  assert.ok(start.url.startsWith('https://app.plex.tv/auth#?'));
  assert.equal(start.url.includes('authToken'), false);
  await assert.rejects(auth.plexPoll(request(), response()), { status: 401 });
  const loggedRes = response();
  const logged = await auth.plexPoll(request(startRes), loggedRes);
  assert.equal(logged.user.email, 'owner@example.com');
  assert.ok((await auth.session(request(loggedRes))));
  assert.equal((await store.keys('pin:')).length, 0);
  assert.equal(JSON.stringify(logged).includes('plex-access-token-private'), false);
  assert.equal(mock.calls.some(call => call.url.includes('plex-access-token-private')), false);
  assert.equal(mock.calls.at(-1).options.headers['X-Plex-Token'], 'plex-access-token-private');
  assert.equal((await Promise.all((await store.keys()).map(key => store.get(key)))).some(value => JSON.stringify(value).includes('plex-access-token-private')), false);
  await assert.rejects(auth.plexPoll(request(startRes), response()), { status: 401 }, 'a consumed PIN cannot be replayed');
});

test('uninvited, unverified and mismatched Plex identities cannot create sessions', async t => {
  for (const profile of [
    { id: 10, email: 'stranger@example.com', confirmed: true },
    { id: 10, email: 'owner@example.com', confirmed: false },
    { id: 99, email: 'owner@example.com', confirmed: true },
  ]) {
    const mock = plexMock(profile);
    const { auth, store } = (await fixture(t, { fetchImpl: mock.fetchImpl }));
    await auth.setup(setupBody('plex'), request(), response());
    if (profile.id === 99) {
      const key = (await store.keys('user:'))[0];
      (await store.set(key, { ...(await store.get(key)), plexId: '10' }));
    }
    const res = response();
    await auth.plexStart(request(), res);
    await assert.rejects(auth.plexPoll(request(res), response()), { status: 403 });
    assert.equal((await store.keys('session:')).length, 0);
    assert.equal((await auth.users()).length, 1);
  }
});

test('Plex polling is throttled, expires, and upstream failures are sanitized', async t => {
  let clock = 100000;
  let requests = 0;
  const fetchImpl = async url => {
    requests += 1;
    return { ok: true, json: async () => url.includes('?strong') ? { id: 42, code: 'pin_code' } : { id: 42, authToken: null } };
  };
  const { auth } = (await fixture(t, { now: () => clock, fetchImpl }));
  await auth.setup(setupBody('plex'), request(), response());
  const res = response();
  await auth.plexStart(request(), res);
  assert.deepEqual(await auth.plexPoll(request(res), response()), { pending: true });
  assert.deepEqual(await auth.plexPoll(request(res), response()), { pending: true });
  assert.equal(requests, 2);
  clock += 11 * 60 * 1000;
  await assert.rejects(auth.plexPoll(request(res), response()), { status: 410 });
  auth.fetchImpl = async () => { throw new Error('https://private-host?token=sensitive-value'); };
  await assert.rejects(auth.plexStart(request(), response()), error => error.status === 502 && !error.message.includes('sensitive'));
});

test('parallel bootstrap requests cannot create two owners', async t => {
  const { auth } = (await fixture(t));
  const outcomes = await Promise.allSettled([
    auth.setup(setupBody(), request(), response()),
    auth.setup({ ...setupBody(), email: 'other@example.com' }, request(), response()),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await auth.users()).length, 1);
});

test('parallel invitations remain unique with asynchronous database reads', async t => {
  const { auth, store } = await fixture(t);
  await auth.setup(setupBody(), request(), response());
  const originalGet = store.get.bind(store);
  store.get = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 2));
    return originalGet(...args);
  };
  const outcomes = await Promise.allSettled([
    auth.addUser({ email: 'friend@example.com' }),
    auth.addUser({ email: 'friend@example.com' }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await auth.users()).filter(user => user.email === 'friend@example.com').length, 1);
});
