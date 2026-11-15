import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SESSION_COOKIE = 'filmderr_session';
const PIN_COOKIE = 'filmderr_plex';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PIN_MS = 10 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex'));
const publicUser = user => ({ id: user.id, name: user.name, email: user.email, role: user.role, avatar: user.avatar || null, plexLinked: Boolean(user.plexId), localEnabled: Boolean(user.password) });

function emailOf(value) {
  if (typeof value !== 'string') throw fail(400, 'A valid email address is required.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[^\x21-\x7e]/.test(email)) throw fail(400, 'A valid email address is required.');
  return email;
}

function passwordCheck(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256 || !/\S/.test(password)) {
    throw fail(400, 'Use a password or passphrase with 12–256 characters.');
  }
}

async function passwordHash(password) {
  passwordCheck(password);
  const salt = randomBytes(16).toString('hex');
  const digest = await scryptAsync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { algorithm: 'scrypt', salt, hash: digest.toString('hex') };
}

async function passwordVerify(password, record) {
  const candidate = typeof password === 'string' && password.length <= 256 ? password : '';
  // Perform the same expensive work for missing accounts and invalid passwords.
  const salt = record?.salt || '00000000000000000000000000000000';
  const digest = await scryptAsync(candidate, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const expected = record?.algorithm === 'scrypt' && /^[0-9a-f]{128}$/.test(record.hash || '') ? Buffer.from(record.hash, 'hex') : Buffer.alloc(64);
  return Boolean(record) && timingSafeEqual(digest, expected);
}

function cookie(req, name) {
  const raw = req?.headers?.cookie || '';
  for (const entry of raw.split(';')) {
    const [key, ...value] = entry.trim().split('=');
    if (key === name) {
      const token = value.join('=');
      return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
    }
  }
  return null;
}

function setCookie(res, name, value, maxAge, secure) {
  const header = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const prior = res.getHeader?.('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prior) ? prior : prior ? [prior] : []), header]);
}

/** The HTTP router additionally enforces same-origin, CSRF and admin permissions. */
export class Auth {
  constructor(store, { setupToken = '', secureCookies = true, fetchImpl = fetch, now = Date.now } = {}) {
    this.store = store;
    this.setupToken = setupToken;
    this.secureCookies = secureCookies;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.rates = new Map();
    this.setupBusy = false;
    this.userBusy = false;
    this.pollBusy = new Set();

  }

  async init() {
    if (!(await this.store.get('auth:csrf-key'))) (await this.store.set('auth:csrf-key', randomBytes(32).toString('hex')));
    if (!(await this.store.get('auth:plex-client'))) (await this.store.set('auth:plex-client', randomUUID()));
    return this;
  }

  async configured() { return (await this.store.keys('user:')).length > 0; }
  async cookiesSecure() { return this.secureCookies || (await this.store.get('settings', {}))?.publicUrl?.startsWith('https://') === true; }
  async mode() {
    const mode = (await this.store.get('settings', {}))?.authMode;
    return ['local', 'both', 'plex'].includes(mode) ? mode : 'plex';
  }
  async users() { return Promise.all((await this.store.keys('user:')).map(async key => publicUser(await this.store.get(key)))); }
  async findEmail(email) { return (await Promise.all((await this.store.keys('user:')).map(key => this.store.get(key)))).find(user => user.email === email); }

  rate(key, limit, duration) {
    const current = this.now();
    if (this.rates.size > 1000) for (const [id, value] of this.rates) if (value.expires <= current) this.rates.delete(id);
    if (this.rates.size > 10000 && !this.rates.has(key)) throw fail(429, 'Too many authentication attempts. Try again later.');
    let entry = this.rates.get(key);
    if (!entry || entry.expires <= current) entry = { count: 0, expires: current + duration };
    entry.count += 1;
    this.rates.set(key, entry);
    if (entry.count > limit) throw fail(429, 'Too many authentication attempts. Try again later.');
  }

  async session(req) {
    const token = cookie(req, SESSION_COOKIE);
    if (!token) return null;
    const key = `session:${hash(token)}`;
    const session = (await this.store.get(key));
    if (!session) return null;
    if (session.expiresAt <= this.now()) { (await this.store.delete(key)); return null; }
    const user = (await this.store.get(`user:${session.userId}`));
    if (!user) return null;
    const csrf = createHmac('sha256', Buffer.from((await this.store.get('auth:csrf-key')), 'hex')).update(token).digest('base64url');
    if (!equal(hash(csrf), session.csrfHash)) return null;
    return { user: publicUser(user), csrf };
  }

  async establish(user, req, res) {
    const old = cookie(req, SESSION_COOKIE);
    if (old) (await this.store.delete(`session:${hash(old)}`));
    const sessions = [];
    for (const key of (await this.store.keys('session:'))) {
      const existing = (await this.store.get(key));
      if (!existing) continue;
      if (existing.expiresAt <= this.now()) (await this.store.delete(key));
      else if (existing.userId === user.id) sessions.push({ key, ...existing });
    }
    sessions.sort((a, b) => a.createdAt - b.createdAt);
    while (sessions.length >= 20) (await this.store.delete(sessions.shift().key));
    const token = randomBytes(32).toString('base64url');
    const csrf = createHmac('sha256', Buffer.from((await this.store.get('auth:csrf-key')), 'hex')).update(token).digest('base64url');
    (await this.store.set(`session:${hash(token)}`, { userId: user.id, csrfHash: hash(csrf), createdAt: this.now(), expiresAt: this.now() + SESSION_MS }));
    setCookie(res, SESSION_COOKIE, token, SESSION_MS / 1000, (await this.cookiesSecure()));
    return { user: publicUser(user), csrf };
  }

  async setup(body, req, res) {
    if (this.setupBusy) throw fail(409, 'Filmderr has already been configured.');
    this.setupBusy = true;
    try {
      if (await this.configured()) throw fail(409, 'Filmderr has already been configured.');
      this.rate('setup', 10, 15 * 60 * 1000);
      if (typeof this.setupToken !== 'string' || this.setupToken.length < 24) throw fail(503, 'Set FILMDERR_SETUP_TOKEN to a random value of at least 24 characters before setup.');
      if (!equal(body?.token, this.setupToken)) throw fail(403, 'Invalid setup token.');
      const email = emailOf(body?.email);
      const mode = body?.authMode || 'plex';
      if (!['plex', 'local', 'both'].includes(mode)) throw fail(400, 'Choose Plex, local, or both sign-in methods.');
      const password = mode === 'plex' && !body.password ? null : await passwordHash(body.password);
      const user = { id: randomUUID(), email, name: String(body.name || email.split('@')[0]).trim().slice(0, 80), role: 'admin', avatar: null, password, plexId: null, createdAt: this.now() };
      (await this.store.set('settings', { ...(await this.store.get('settings', {})), authMode: mode }));
      (await this.store.set(`user:${user.id}`, user));
      // The setup token authorizes configuration; Plex identity is still verified by Plex.
      return mode === 'plex' ? { configured: true, user: null, csrf: null } : (await this.establish(user, req, res));
    } finally { this.setupBusy = false; }
  }

  async addUser(body) {
    if (!(await this.configured())) throw fail(409, 'Complete owner setup first.');
    if (this.userBusy) throw fail(409, 'Another account update is in progress. Try again.');
    const email = emailOf(body?.email);
    const role = body?.role || 'user';
    if (!['user', 'admin'].includes(role)) throw fail(400, 'Invalid account role.');
    this.userBusy = true;
    try {
      if (await this.findEmail(email)) throw fail(409, 'That email is already invited.');
      if ((await this.users()).length >= 100) throw fail(400, 'This installation supports up to 100 accounts.');
      const password = body.password ? await passwordHash(body.password) : null;
      if ((await this.mode()) === 'local' && !password) throw fail(400, 'A password is required for local sign-in.');
      const user = { id: randomUUID(), email, name: String(body.name || email.split('@')[0]).trim().slice(0, 80), role, avatar: null, password, plexId: null, createdAt: this.now() };
      (await this.store.set(`user:${user.id}`, user));
      return publicUser(user);
    } finally { this.userBusy = false; }
  }

  async localLogin(body, req, res) {
    if (!['local', 'both'].includes((await this.mode()))) throw fail(403, 'Local sign-in is disabled.');
    const rawEmail = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    this.rate(`local-ip:${hash(req?.socket?.remoteAddress || 'unknown')}`, 30, 15 * 60 * 1000);
    this.rate(`local-email:${hash(rawEmail)}`, 8, 15 * 60 * 1000);
    const user = (await this.findEmail(rawEmail));
    if (!await passwordVerify(body?.password, user?.password)) throw fail(401, 'Email or password is incorrect.');
    this.rates.delete(`local-email:${hash(rawEmail)}`);
    return (await this.establish(user, req, res));
  }

  async plexHeaders(token) {
    return { Accept: 'application/json', 'X-Plex-Product': 'Filmderr', 'X-Plex-Version': '0.1.0', 'X-Plex-Client-Identifier': (await this.store.get('auth:plex-client')), ...(token ? { 'X-Plex-Token': token } : {}) };
  }

  async plexRequest(path, options = {}) {
    try {
      const response = await this.fetchImpl(`https://plex.tv/api/v2/${path}`, { redirect: 'error', signal: AbortSignal.timeout(10000), ...options });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch { throw fail(502, 'Plex sign-in could not be completed. Please try again.'); }
  }

  async plexStart(req, res) {
    if (!(await this.configured())) throw fail(409, 'Complete owner setup first.');
    if (!['plex', 'both'].includes((await this.mode()))) throw fail(403, 'Plex sign-in is disabled.');
    this.rate(`plex-start:${hash(req?.socket?.remoteAddress || 'unknown')}`, 12, 15 * 60 * 1000);
    for (const key of await this.store.keys('pin:')) {
      const existing = await this.store.get(key);
      if (existing && existing.expiresAt <= this.now()) await this.store.delete(key);
    }
    const old = cookie(req, PIN_COOKIE);
    if (old) (await this.store.delete(`pin:${hash(old)}`));
    const pin = await this.plexRequest('pins?strong=true', { method: 'POST', headers: (await this.plexHeaders()) });
    if (!Number.isSafeInteger(pin.id) || pin.id <= 0 || typeof pin.code !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(pin.code)) throw fail(502, 'Plex returned an invalid sign-in response.');
    const binding = randomBytes(32).toString('base64url');
    const plexExpiry = Date.parse(pin.expiresAt);
    const expiresAt = Math.min(this.now() + PIN_MS, Number.isFinite(plexExpiry) ? plexExpiry : Infinity);
    if (expiresAt <= this.now()) throw fail(502, 'Plex returned an expired sign-in request.');
    (await this.store.set(`pin:${hash(binding)}`, { id: pin.id, code: pin.code, expiresAt, polls: 0, lastPoll: 0 }));
    setCookie(res, PIN_COOKIE, binding, Math.ceil((expiresAt - this.now()) / 1000), (await this.cookiesSecure()));
    const query = new URLSearchParams({ clientID: (await this.store.get('auth:plex-client')), code: pin.code, 'context[device][product]': 'Filmderr' });
    return { url: `https://app.plex.tv/auth#?${query}` };
  }

  async plexPoll(req, res) {
    if (!['plex', 'both'].includes((await this.mode()))) throw fail(403, 'Plex sign-in is disabled.');
    const binding = cookie(req, PIN_COOKIE);
    const key = binding ? `pin:${hash(binding)}` : null;
    const pin = key ? (await this.store.get(key)) : null;
    if (!pin) throw fail(401, 'Start a new Plex sign-in from this browser.');
    if (pin.expiresAt <= this.now() || pin.polls >= 600) {
      (await this.store.delete(key));
      setCookie(res, PIN_COOKIE, '', 0, (await this.cookiesSecure()));
      throw fail(410, 'Plex sign-in expired. Start again.');
    }
    if (this.pollBusy.has(key) || (pin.lastPoll && this.now() - pin.lastPoll < 900)) return { pending: true };
    this.pollBusy.add(key);
    pin.lastPoll = this.now();
    pin.polls += 1;
    try {
      await this.store.set(key, pin);
      const result = await this.plexRequest(`pins/${pin.id}`, { headers: (await this.plexHeaders()) });
      if (result.id !== pin.id || (result.code && result.code !== pin.code)) throw fail(502, 'Plex returned an invalid sign-in response.');
      if (!result.authToken) return { pending: true };
      if (typeof result.authToken !== 'string' || result.authToken.length > 8192) throw fail(502, 'Plex returned an invalid sign-in response.');
      const profile = await this.plexRequest('user', { headers: (await this.plexHeaders(result.authToken)) });
      (await this.store.delete(key));
      setCookie(res, PIN_COOKIE, '', 0, (await this.cookiesSecure()));
      let email;
      try { email = emailOf(profile.email); } catch { throw fail(403, 'This Plex account is not invited.'); }
      const user = (await this.findEmail(email));
      const plexId = typeof profile.id === 'number' || typeof profile.id === 'string' ? String(profile.id) : '';
      if (!user || !plexId || profile.confirmed !== true || (user.plexId && user.plexId !== plexId)) throw fail(403, 'This Plex account is not invited or its email is not verified.');
      user.plexId = plexId;
      try {
        const avatar = new URL(profile.thumb);
        user.avatar = avatar.protocol === 'https:' && (avatar.hostname === 'plex.tv' || avatar.hostname.endsWith('.plex.tv')) ? avatar.href : null;
      } catch { user.avatar = null; }
      (await this.store.set(`user:${user.id}`, user));
      return (await this.establish(user, req, res));
    } finally { this.pollBusy.delete(key); }
  }

  async logout(req, res) {
    const token = cookie(req, SESSION_COOKIE);
    if (token) (await this.store.delete(`session:${hash(token)}`));
    const pin = cookie(req, PIN_COOKIE);
    if (pin) (await this.store.delete(`pin:${hash(pin)}`));
    setCookie(res, SESSION_COOKIE, '', 0, (await this.cookiesSecure()));
    setCookie(res, PIN_COOKIE, '', 0, (await this.cookiesSecure()));
    return { user: null, csrf: null };
  }
}
