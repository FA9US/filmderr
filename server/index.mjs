import http from 'node:http';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Store } from './store.mjs';
import { Auth } from './auth.mjs';
import { Filmderr, redactSettings, fail } from './domain.mjs';
import { DemoIntegrations } from './demo.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demo = process.env.FILMDERR_DEMO === '1';
const host = demo ? '127.0.0.1' : (process.env.HOST || '0.0.0.0');
const port = Number(process.env.PORT || 3678);
const store = new Store(demo ? mkdtempSync(resolve(tmpdir(), 'filmderr-demo-')) : (process.env.FILMDERR_DATA_DIR || resolve(root, 'data')));
const preview = demo ? new DemoIntegrations() : null;
const app = new Filmderr(store, demo ? { integrationFactory: () => preview } : {});
if (process.env.FILMDERR_PUBLIC_URL && !demo) app.saveSettings({ publicUrl: process.env.FILMDERR_PUBLIC_URL });
const setupToken = process.env.FILMDERR_SETUP_TOKEN_FILE ? readFileSync(process.env.FILMDERR_SETUP_TOKEN_FILE, 'utf8').trim() : (process.env.FILMDERR_SETUP_TOKEN || '');
const auth = new Auth(store, { setupToken, secureCookies: process.env.FILMDERR_SECURE_COOKIES === 'true' || app.settings().publicUrl.startsWith('https://') });
const demoSession = { user: { id: 'demo', name: 'Movie lover', email: 'demo@example.invalid', role: 'admin', avatar: null }, csrf: 'filmderr-demo-csrf' };
const rates = new Map();
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail('Send JSON with Content-Type: application/json.', 415);
  let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 32768) throw fail('Request is too large.', 413); }
  try { const parsed = JSON.parse(raw || '{}'); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw Error(); return parsed; }
  catch { throw fail('Invalid JSON request.'); }
}
function checkOrigin(req) {
  const configured = app.settings().publicUrl;
  const origin = req.headers.origin;
  const expected = configured || `http://${req.headers.host}`;
  if (!origin || (origin !== expected && !(demo && origin === `http://${req.headers.host}`))) throw fail('Request origin is not allowed.', 403);
  if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('Cross-site requests are not allowed.', 403);
}
function limit(req, route) {
  const key = `${req.socket.remoteAddress}:${route}`, now = Date.now();
  let bucket = rates.get(key); if (!bucket || now > bucket.until) { bucket = { count: 0, until: now + 300000 }; rates.set(key, bucket); }
  if (++bucket.count > (route === 'poll' ? 180 : 30)) throw fail('Too many sign-in attempts. Try again in five minutes.', 429);
}
function status(req) { const session = demo ? demoSession : auth.session(req); return { configured: demo || auth.configured(), user: session?.user ?? null, csrf: session?.csrf ?? null, authMode: app.settings().authMode, demo }; }
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, 'http://filmderr.invalid'), path = url.pathname, method = req.method;
    if (path === '/healthz' && method === 'GET') return json(res, { status: 'ok', version: '0.1.0' });
    if (!path.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(method)) throw fail('Method not allowed.', 405);
      const name = decodeURIComponent(path === '/' ? '/index.html' : path), file = resolve(root, 'public', `.${name}`);
      if (!file.startsWith(resolve(root, 'public') + sep) || !mime[extname(file)] || !existsSync(file)) throw fail('Not found.', 404);
      const contents = readFileSync(file); res.writeHead(200, { 'Content-Type': mime[extname(file)], 'Cache-Control': 'no-cache' }); return res.end(method === 'HEAD' ? undefined : contents);
    }
    if (path === '/api/session' && method === 'GET') return json(res, status(req));
    let input;
    if (!['GET', 'HEAD'].includes(method)) { checkOrigin(req); input = await body(req); }
    if (path === '/api/setup' && method === 'POST') { if (demo) return json(res, status(req)); limit(req, 'login'); const result = await auth.setup(input, req, res); return json(res, { ...status(req), ...result }); }
    if (path === '/api/auth/local' && method === 'POST') { if (demo) return json(res, status(req)); limit(req, 'login'); const result = await auth.localLogin(input, req, res); return json(res, { ...status(req), ...result }); }
    if (path === '/api/auth/plex/start' && method === 'POST') { if (demo) throw fail('Plex sign-in is disabled in the isolated demo.'); limit(req, 'login'); return json(res, await auth.plexStart(req, res)); }
    if (path === '/api/auth/plex/poll' && method === 'POST') { if (demo) throw fail('Plex sign-in is disabled in the isolated demo.'); limit(req, 'poll'); const result = await auth.plexPoll(req, res); return json(res, result.pending ? result : { ...status(req), ...result }); }
    const session = demo ? demoSession : auth.session(req);
    if (!session) throw fail('Sign in to continue.', 401);
    if (!['GET', 'HEAD'].includes(method) && req.headers['x-csrf-token'] !== session.csrf) throw fail('Session protection expired. Reload the page.', 403);
    const userId = session.user.id;
    if (path === '/api/auth/logout' && method === 'POST') { if (!demo) await auth.logout(req, res); return json(res, { ok: true }); }
    if (path === '/api/preferences' && method === 'GET') return json(res, app.prefs(userId));
    if (path === '/api/preferences' && method === 'PUT') return json(res, app.savePrefs(userId, input));
    if (path === '/api/deck' && method === 'GET') { const data = await app.deck(userId); if (demo) data.warning = 'Isolated demo: sample films span release years. All requests are simulated.'; return json(res, data); }
    if (path === '/api/genres' && method === 'GET') return json(res, { genres: await app.integration().genres() });
    if (/^\/api\/movies\/\d+$/.test(path) && method === 'GET') return json(res, await app.integration().movie(Number(path.split('/').at(-1))));
    if (path === '/api/decisions' && method === 'POST') return json(res, await app.decide(userId, input), 201);
    if (/^\/api\/decisions\/[\w-]+\/undo$/.test(path) && method === 'POST') return json(res, await app.undo(userId, path.split('/')[3]));
    if (path === '/api/history' && method === 'GET') return json(res, { decisions: app.history(userId) });
    if (path === '/api/history/reset-skips' && method === 'POST') return json(res, app.resetSkips(userId));
    if (path.startsWith('/api/settings') || path === '/api/users') {
      if (session.user.role !== 'admin') throw fail('Administrator access is required.', 403);
      if (path === '/api/settings' && method === 'GET') return json(res, { settings: redactSettings(app.settings()), users: demo ? [demoSession.user] : auth.users() });
      if (demo && ['PUT', 'POST'].includes(method)) throw fail('Integration and account changes are disabled in this isolated demo.');
      if (path === '/api/settings' && method === 'PUT') {
        if (input.authMode === 'plex' && !session.user.plexLinked && app.settings().authMode !== 'plex') throw fail('Sign in with Plex before disabling local sign-in. Use Both to link your account first.');
        if (input.authMode === 'local' && !session.user.localEnabled) throw fail('This administrator needs a local password before Plex sign-in can be disabled.');
        return json(res, { settings: await app.serialized(() => app.saveSettings(input)) });
      }
      if (path === '/api/settings/test' && method === 'POST') {
        if (!['radarr', 'plex', 'tmdb', 'seerr'].includes(input.service)) throw fail('Choose a supported service.');
        return json(res, await app.integration().test(input.service));
      }
      if (path === '/api/users' && method === 'POST') return json(res, { user: await auth.addUser(input) }, 201);
    }
    throw fail('Endpoint not found.', 404);
  } catch (error) {
    // Unexpected errors may contain upstream credentials. Never echo or log them.
    if (!res.headersSent) json(res, { error: error.status ? error.message : 'The request could not be completed. Check the saved integration settings and try again.' }, error.status || 500);
    else res.end();
  }
});
server.requestTimeout = 30000; server.headersTimeout = 15000;
let workerRunning = false;
const worker = setInterval(() => {
  if (workerRunning) return;
  workerRunning = true;
  app.processDue().catch(() => {}).finally(() => { workerRunning = false; });
}, 500); worker.unref();
const rateCleanup = setInterval(() => { for (const [key,b] of rates) if (Date.now() > b.until) rates.delete(key); }, 300000); rateCleanup.unref();
server.listen(port, host, () => console.log(`Filmderr${demo ? ' isolated demo' : ''} listening on http://${host}:${server.address().port}`));
function close() { clearInterval(worker); clearInterval(rateCleanup); server.close(() => { store.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGINT', close); process.on('SIGTERM', close);
