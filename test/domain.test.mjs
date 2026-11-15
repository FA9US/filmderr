import test from 'node:test';
import assert from 'node:assert/strict';
import { Filmderr, preferences, redactSettings, DEFAULT_SETTINGS, mergeSettings } from '../server/domain.mjs';

class MemoryStore {
  data = new Map();
  async get(key, fallback = null) { await Promise.resolve(); return this.data.has(key) ? structuredClone(this.data.get(key)) : fallback; }
  async set(key, value) { await Promise.resolve(); this.data.set(key, structuredClone(value)); }
  async delete(key) { await Promise.resolve(); this.data.delete(key); }
  async keys(prefix = '') { await Promise.resolve(); return [...this.data.keys()].filter(k => k.startsWith(prefix)); }
}
async function fixture() {
  const store = new MemoryStore(), calls = [], movies = new Set(), plex = new Set(), exclusions = new Map();
  const api = {
    async discover() { return [1,2,3,4,5].map(id => ({ id, title: `Movie ${id}` })); },
    async movie(id) { return { id, title: `Movie ${id}`, year: 2026 }; },
    async library() { return { radarrIds: new Set(movies), plexIds: new Set(plex), excludedIds: new Set(exclusions.keys()) }; },
    async addMovie(m) { calls.push(['add', m.id]); movies.add(m.id); return { message: 'Added and searching.' }; },
    async exclude(m) { const existing = exclusions.get(m.id); if (existing) return { id: existing.id, created: false }; const e = { id: 100 + m.id, tmdbId: m.id }; exclusions.set(m.id, e); calls.push(['exclude', m.id]); return { id: e.id, created: true }; },
    async findExclusion(id) { return exclusions.get(id); },
    async removeExclusion(id, movieId) { calls.push(['remove', movieId]); exclusions.delete(movieId); },
  };
  let time = 1800000000000;
  const app = await new Filmderr(store, { integrationFactory: () => api, now: () => time, graceMs: 5000 }).init();
  return { store, app, api, calls, movies, plex, exclusions, advance() { time += 6000; } };
}
test('deck removes every Radarr, Plex and exclusion ID plus personal skip', async () => {
  const f = await fixture(); f.movies.add(1); f.plex.add(2); f.exclusions.set(3,{id:103});
  await f.app.decide('a', { tmdbId: 4, action: 'skip' });
  assert.deepEqual((await f.app.deck('a')).movies.map(m => m.id), [5]);
  assert.equal((await f.app.deck('b')).movies.length, 2);
});
test('like has durable grace, supports undo, never sends before deadline', async () => {
  const f = await fixture(); const {decision} = await f.app.decide('a',{tmdbId:1,action:'like'});
  await f.app.processDue(); assert.equal(f.calls.length,0);
  await f.app.undo('a',decision.id); f.advance(); await f.app.processDue(); assert.equal(f.calls.length,0);
});
test('duplicate request and concurrent workers add once', async () => {
  const f = await fixture(); const [a,b] = await Promise.all([f.app.decide('a',{tmdbId:1,action:'like'}),f.app.decide('a',{tmdbId:1,action:'like'})]);
  assert.equal(a.decision.id,b.decision.id); f.advance(); await Promise.all([f.app.processDue(),f.app.processDue()]);
  assert.deepEqual(f.calls,[['add',1]]);
  await assert.rejects(f.app.undo('a',a.decision.id), /already been submitted/);
});
test('fresh library/exclusion recheck prevents acquisition race', async () => {
  const f = await fixture(); await f.app.decide('a',{tmdbId:1,action:'like'}); f.exclusions.set(1,{id:101}); f.advance(); await f.app.processDue();
  assert.equal(f.calls.length,0); assert.equal((await f.app.history('a'))[0].status,'failed');
});
test('pre-existing exclusions survive undo', async () => {
  const f = await fixture(); f.exclusions.set(1,{id:101,tmdbId:1}); const {decision} = await f.app.decide('a',{tmdbId:1,action:'dislike'});
  f.advance(); await f.app.processDue(); await f.app.undo('a',decision.id); assert.ok(f.exclusions.has(1)); assert.equal(f.calls.length,0);
});
test('owned exclusion survives one household undo and is removed for last dislike', async () => {
  const f = await fixture(); const a = await f.app.decide('a',{tmdbId:1,action:'dislike'}); f.advance(); await f.app.processDue();
  const b = await f.app.decide('b',{tmdbId:1,action:'dislike'}); f.advance(); await f.app.processDue();
  await f.app.undo('a',a.decision.id); assert.ok(f.exclusions.has(1)); await f.app.undo('b',b.decision.id); assert.ok(!f.exclusions.has(1));
});
test('exclusion replaced by another tool is never deleted on undo', async () => {
  const f = await fixture(); const a = await f.app.decide('a',{tmdbId:1,action:'dislike'}); f.advance(); await f.app.processDue();
  f.exclusions.set(1,{id:888,tmdbId:1}); await f.app.undo('a',a.decision.id); assert.equal(f.exclusions.get(1).id,888);
});
test('personal dislikes never write Radarr or hide from other users', async () => {
  const f = await fixture(); await f.app.saveSettings({sharedExclusions:false}); await f.app.decide('a',{tmdbId:1,action:'dislike'}); f.advance(); await f.app.processDue();
  assert.equal(f.calls.length,0); assert.equal((await f.app.deck('b')).movies.length,5);
});
test('failed submission is visible, not falsely successful, and cannot leak unknown exception text', async () => {
  const f = await fixture(); f.api.addMovie = async () => { throw new Error('secret-token'); };
  await f.app.decide('a',{tmdbId:1,action:'like'}); f.advance(); await f.app.processDue();
  const d = (await f.app.history('a'))[0]; assert.equal(d.status,'failed'); assert.ok(!d.message.includes('secret-token'));
});
test('preferences persist separately; invalid values are rejected', async () => {
  const f = await fixture(); await f.app.savePrefs('a',{year:2020,includeUpcoming:true,genres:[12],originalLanguage:'fa'});
  assert.equal((await f.app.prefs('a')).year,2020); assert.equal((await f.app.prefs('b')).year,new Date().getFullYear());
  assert.throws(() => preferences({minRating:99})); assert.throws(() => preferences({year:1}));
});
test('settings redact and preserve secrets; public URL rejects credential/query injection', () => {
  const saved = mergeSettings(DEFAULT_SETTINGS,{radarr:{apiKey:'secret',url:'http://radarr:7878'}});
  assert.equal(redactSettings(saved).radarr.apiKey,''); assert.equal(redactSettings(saved).radarr.hasApiKey,true);
  assert.equal(mergeSettings(saved,{radarr:{apiKey:''}}).radarr.apiKey,'secret');
  assert.throws(() => mergeSettings(saved,{publicUrl:'https://user:pass@example.com'}));
});
test('pending work survives restart, in-flight work is marked uncertain and not repeated', async () => {
  const f = await fixture(); const {decision} = await f.app.decide('a',{tmdbId:1,action:'like'});
  const raw = await f.store.get(`decision:${decision.id}`); raw.status='processing'; await f.store.set(`decision:${decision.id}`,raw);
  const restart = await new Filmderr(f.store,{integrationFactory:()=>f.api}).init(); await restart.processDue();
  assert.equal((await restart.history('a'))[0].status,'failed'); assert.equal(f.calls.length,0);
});
test('integration settings cannot change beneath pending decisions', async () => {
  const f = await fixture(); await f.app.decide('a',{tmdbId:1,action:'like'});
  await assert.rejects(f.app.saveSettings({radarr:{url:'http://other:7878'}}), /pending swipes/);
  await assert.rejects(f.app.saveSettings({clearSecrets:['radarr.apiKey']}), /pending swipes/);
});
test('ownership cannot cross Radarr connections even when numeric exclusion IDs collide', async () => {
  const f = await fixture(); const {decision} = await f.app.decide('a',{tmdbId:1,action:'dislike'});
  f.advance(); await f.app.processDue(); await f.app.saveSettings({radarr:{url:'http://other:7878'}});
  await assert.rejects(f.app.undo('a',decision.id), /different Radarr/);
  assert.ok(f.exclusions.has(1));
});

test('initialization waits for durable defaults and completes recovery before returning', async () => {
  const store = new MemoryStore();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const set = store.set.bind(store);
  store.set = async (key, value) => {
    if (key === 'settings') { entered.resolve(); await release.promise; }
    return set(key, value);
  };
  const app = new Filmderr(store);
  let ready = false;
  const initialized = app.init().then(value => { ready = true; return value; });
  await entered.promise;
  assert.equal(ready, false);
  assert.equal(await store.get('settings'), null);
  release.resolve();
  assert.equal(await initialized, app);
  assert.deepEqual(await app.settings(), DEFAULT_SETTINGS);
});

test('decision acknowledgement and worker wait for the pending decision commit', async () => {
  const f = await fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const set = f.store.set.bind(f.store);
  f.store.set = async (key, value) => {
    if (key.startsWith('decision:') && value.status === 'pending') { entered.resolve(); await release.promise; }
    return set(key, value);
  };
  let acknowledged = false;
  const deciding = f.app.decide('a', { tmdbId: 1, action: 'like' }).then(result => { acknowledged = true; return result; });
  await entered.promise;
  f.advance(); const processing = f.app.processDue();
  assert.equal(acknowledged, false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.store.keys('decision:'), []);
  release.resolve();
  const result = await deciding;
  await processing;
  assert.equal(acknowledged, true);
  assert.deepEqual(f.calls, [['add', 1]]);
  assert.equal((await f.store.get(`decision:${result.decision.id}`)).status, 'added');
});

test('remote acquisition cannot precede the durable processing transition', async () => {
  const f = await fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const { decision } = await f.app.decide('a', { tmdbId: 1, action: 'like' }); f.advance();
  const set = f.store.set.bind(f.store);
  f.store.set = async (key, value) => {
    if (key.startsWith('decision:') && value.status === 'processing') { entered.resolve(); await release.promise; }
    return set(key, value);
  };
  const processing = f.app.processDue(); await entered.promise;
  assert.deepEqual(f.calls, []);
  assert.equal((await f.store.get(`decision:${decision.id}`)).status, 'pending');
  release.resolve(); await processing;
  assert.deepEqual(f.calls, [['add', 1]]);
});

test('database outage before processing commit prevents every remote mutation', async () => {
  const f = await fixture();
  await f.app.decide('a', { tmdbId: 1, action: 'like' }); f.advance();
  const set = f.store.set.bind(f.store);
  f.store.set = async (key, value) => {
    if (value.status === 'processing') throw new Error('database unavailable');
    return set(key, value);
  };
  await assert.rejects(f.app.processDue(), /database unavailable/);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.app.history('a'))[0].status, 'pending');
});

test('lost result commit after acquisition remains uncertain and is never replayed after restart', async () => {
  const f = await fixture();
  await f.app.decide('a', { tmdbId: 1, action: 'like' }); f.advance();
  const set = f.store.set.bind(f.store);
  f.store.set = async (key, value) => {
    if (value.status === 'added') throw new Error('database unavailable');
    return set(key, value);
  };
  await assert.rejects(f.app.processDue(), /database unavailable/);
  assert.deepEqual(f.calls, [['add', 1]]);
  assert.equal((await f.app.history('a'))[0].status, 'processing');
  f.store.set = set;
  const restarted = await new Filmderr(f.store, { integrationFactory: () => f.api }).init();
  await restarted.processDue();
  assert.equal((await restarted.history('a'))[0].status, 'failed');
  assert.deepEqual(f.calls, [['add', 1]]);
});

test('exclusion ownership persistence failure is not reported as successful exclusion', async () => {
  const f = await fixture();
  const { decision } = await f.app.decide('a', { tmdbId: 1, action: 'dislike' }); f.advance();
  const set = f.store.set.bind(f.store);
  f.store.set = async (key, value) => {
    if (key.startsWith('exclusion:')) throw new Error('database unavailable');
    return set(key, value);
  };
  await f.app.processDue();
  assert.equal((await f.app.history('a'))[0].status, 'failed');
  assert.ok(f.exclusions.has(1));
  await f.app.undo('a', decision.id);
  assert.ok(f.exclusions.has(1), 'uncertain ownership cannot authorize removal');
  assert.deepEqual(f.calls, [['exclude', 1]]);
});

test('undo waits for ownership retirement before removing an exclusion', async () => {
  const f = await fixture();
  const { decision } = await f.app.decide('a', { tmdbId: 1, action: 'dislike' }); f.advance(); await f.app.processDue();
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), set = f.store.set.bind(f.store);
  f.store.set = async (key, value) => {
    if (key.startsWith('exclusion:') && value.releasing) { entered.resolve(); await release.promise; }
    return set(key, value);
  };
  const undoing = f.app.undo('a', decision.id); await entered.promise;
  assert.ok(f.exclusions.has(1));
  assert.deepEqual(f.calls, [['exclude', 1]]);
  assert.equal((await f.app.history('a'))[0].status, 'undoing');
  release.resolve(); await undoing;
  assert.deepEqual(f.calls, [['exclude', 1], ['remove', 1]]);
});

test('outage after exclusion removal cannot authorize deleting a later reused exclusion ID', async () => {
  const f = await fixture();
  const { decision } = await f.app.decide('a', { tmdbId: 1, action: 'dislike' }); f.advance(); await f.app.processDue();
  const remove = f.store.delete.bind(f.store);
  f.store.delete = async key => {
    if (key.startsWith('exclusion:')) throw new Error('database unavailable');
    return remove(key);
  };
  await assert.rejects(f.app.undo('a', decision.id), /database unavailable/);
  assert.ok(!f.exclusions.has(1));
  const ownershipKey = (await f.store.keys('exclusion:'))[0];
  assert.equal((await f.store.get(ownershipKey)).owned, false);
  f.store.delete = remove;
  const restarted = await new Filmderr(f.store, { integrationFactory: () => f.api, graceMs: 0 }).init();
  assert.equal((await restarted.history('a'))[0].status, 'failed');
  f.exclusions.set(1, { id: 101, tmdbId: 1 }); // Another tool creates the same numeric ID.
  const second = await restarted.decide('a', { tmdbId: 1, action: 'dislike' });
  await restarted.processDue(); await restarted.undo('a', second.decision.id);
  assert.ok(f.exclusions.has(1));
  assert.deepEqual(f.calls, [['exclude', 1], ['remove', 1]]);
});

test('concurrent asynchronous settings updates are serialized and preserve both patches', async () => {
  const f = await fixture();
  await Promise.all([
    f.app.saveSettings({ radarr: { url: 'http://radarr-new:7878' } }),
    f.app.saveSettings({ region: 'US' }),
  ]);
  const settings = await f.app.settings();
  assert.equal(settings.radarr.url, 'http://radarr-new:7878');
  assert.equal(settings.region, 'US');
});

test('settings update queued during decision preparation cannot change the saved action target', async () => {
  const f = await fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.api.movie = async id => { entered.resolve(); await release.promise; return { id, title: 'Movie' }; };
  const deciding = f.app.decide('a', { tmdbId: 1, action: 'like' });
  await entered.promise;
  const changing = f.app.saveSettings({ radarr: { url: 'http://other:7878' } });
  const rejected = assert.rejects(changing, /pending swipes/);
  release.resolve(); await deciding; await rejected;
  assert.equal((await f.app.settings()).radarr.url, '');
});

test('discovery finishing after a settings change cannot populate a stale cached deck', async () => {
  const f = await fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.api.discover = async () => { entered.resolve(); await release.promise; return [{ id: 1 }]; };
  const loading = f.app.deck('a'); await entered.promise;
  await f.app.saveSettings({ radarr: { url: 'http://other:7878' } });
  const rejected = assert.rejects(loading, /settings changed/);
  release.resolve(); await rejected;
  assert.equal(f.app.pools.size, 0);
});

test('pending decisions loaded against a changed connection cannot write to the new server', async () => {
  const f = await fixture(); await f.app.decide('a', { tmdbId: 1, action: 'like' }); f.advance();
  const settings = await f.app.settings(); settings.radarr.url = 'http://different:7878';
  await f.store.set('settings', settings); // External recovery/configuration change, bypassing the app guard.
  await f.app.processDue();
  assert.deepEqual(f.calls, []);
  assert.equal((await f.app.history('a'))[0].status, 'failed');
});
