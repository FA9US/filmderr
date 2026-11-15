import test from 'node:test';
import assert from 'node:assert/strict';
import { Filmderr, preferences, redactSettings, DEFAULT_SETTINGS, mergeSettings } from '../server/domain.mjs';

class MemoryStore {
  data = new Map();
  get(key, fallback = null) { return this.data.has(key) ? structuredClone(this.data.get(key)) : fallback; }
  set(key, value) { this.data.set(key, structuredClone(value)); }
  delete(key) { this.data.delete(key); }
  keys(prefix = '') { return [...this.data.keys()].filter(k => k.startsWith(prefix)); }
}
function fixture() {
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
  const app = new Filmderr(store, { integrationFactory: () => api, now: () => time, graceMs: 5000 });
  return { store, app, api, calls, movies, plex, exclusions, advance() { time += 6000; } };
}
test('deck removes every Radarr, Plex and exclusion ID plus personal skip', async () => {
  const f = fixture(); f.movies.add(1); f.plex.add(2); f.exclusions.set(3,{id:103});
  await f.app.decide('a', { tmdbId: 4, action: 'skip' });
  assert.deepEqual((await f.app.deck('a')).movies.map(m => m.id), [5]);
  assert.equal((await f.app.deck('b')).movies.length, 2);
});
test('like has durable grace, supports undo, never sends before deadline', async () => {
  const f = fixture(); const {decision} = await f.app.decide('a',{tmdbId:1,action:'like'});
  await f.app.processDue(); assert.equal(f.calls.length,0);
  await f.app.undo('a',decision.id); f.advance(); await f.app.processDue(); assert.equal(f.calls.length,0);
});
test('duplicate request and concurrent workers add once', async () => {
  const f = fixture(); const [a,b] = await Promise.all([f.app.decide('a',{tmdbId:1,action:'like'}),f.app.decide('a',{tmdbId:1,action:'like'})]);
  assert.equal(a.decision.id,b.decision.id); f.advance(); await Promise.all([f.app.processDue(),f.app.processDue()]);
  assert.deepEqual(f.calls,[['add',1]]);
  await assert.rejects(f.app.undo('a',a.decision.id), /already been submitted/);
});
test('fresh library/exclusion recheck prevents acquisition race', async () => {
  const f = fixture(); await f.app.decide('a',{tmdbId:1,action:'like'}); f.exclusions.set(1,{id:101}); f.advance(); await f.app.processDue();
  assert.equal(f.calls.length,0); assert.equal(f.app.history('a')[0].status,'failed');
});
test('pre-existing exclusions survive undo', async () => {
  const f = fixture(); f.exclusions.set(1,{id:101,tmdbId:1}); const {decision} = await f.app.decide('a',{tmdbId:1,action:'dislike'});
  f.advance(); await f.app.processDue(); await f.app.undo('a',decision.id); assert.ok(f.exclusions.has(1)); assert.equal(f.calls.length,0);
});
test('owned exclusion survives one household undo and is removed for last dislike', async () => {
  const f = fixture(); const a = await f.app.decide('a',{tmdbId:1,action:'dislike'}); f.advance(); await f.app.processDue();
  const b = await f.app.decide('b',{tmdbId:1,action:'dislike'}); f.advance(); await f.app.processDue();
  await f.app.undo('a',a.decision.id); assert.ok(f.exclusions.has(1)); await f.app.undo('b',b.decision.id); assert.ok(!f.exclusions.has(1));
});
test('exclusion replaced by another tool is never deleted on undo', async () => {
  const f = fixture(); const a = await f.app.decide('a',{tmdbId:1,action:'dislike'}); f.advance(); await f.app.processDue();
  f.exclusions.set(1,{id:888,tmdbId:1}); await f.app.undo('a',a.decision.id); assert.equal(f.exclusions.get(1).id,888);
});
test('personal dislikes never write Radarr or hide from other users', async () => {
  const f = fixture(); f.app.saveSettings({sharedExclusions:false}); await f.app.decide('a',{tmdbId:1,action:'dislike'}); f.advance(); await f.app.processDue();
  assert.equal(f.calls.length,0); assert.equal((await f.app.deck('b')).movies.length,5);
});
test('failed submission is visible, not falsely successful, and cannot leak unknown exception text', async () => {
  const f = fixture(); f.api.addMovie = async () => { throw new Error('secret-token'); };
  await f.app.decide('a',{tmdbId:1,action:'like'}); f.advance(); await f.app.processDue();
  const d = f.app.history('a')[0]; assert.equal(d.status,'failed'); assert.ok(!d.message.includes('secret-token'));
});
test('preferences persist separately; invalid values are rejected', () => {
  const f = fixture(); f.app.savePrefs('a',{year:2020,includeUpcoming:true,genres:[12],originalLanguage:'fa'});
  assert.equal(f.app.prefs('a').year,2020); assert.equal(f.app.prefs('b').year,new Date().getFullYear());
  assert.throws(() => preferences({minRating:99})); assert.throws(() => preferences({year:1}));
});
test('settings redact and preserve secrets; public URL rejects credential/query injection', () => {
  const saved = mergeSettings(DEFAULT_SETTINGS,{radarr:{apiKey:'secret',url:'http://radarr:7878'}});
  assert.equal(redactSettings(saved).radarr.apiKey,''); assert.equal(redactSettings(saved).radarr.hasApiKey,true);
  assert.equal(mergeSettings(saved,{radarr:{apiKey:''}}).radarr.apiKey,'secret');
  assert.throws(() => mergeSettings(saved,{publicUrl:'https://user:pass@example.com'}));
});
test('pending work survives restart, in-flight work is marked uncertain and not repeated', async () => {
  const f = fixture(); const {decision} = await f.app.decide('a',{tmdbId:1,action:'like'});
  const raw = f.store.get(`decision:${decision.id}`); raw.status='processing'; f.store.set(`decision:${decision.id}`,raw);
  const restart = new Filmderr(f.store,{integrationFactory:()=>f.api}); await restart.processDue();
  assert.equal(restart.history('a')[0].status,'failed'); assert.equal(f.calls.length,0);
});
test('integration settings cannot change beneath pending decisions', async () => {
  const f = fixture(); await f.app.decide('a',{tmdbId:1,action:'like'});
  assert.throws(() => f.app.saveSettings({radarr:{url:'http://other:7878'}}), /pending swipes/);
});
test('ownership cannot cross Radarr connections even when numeric exclusion IDs collide', async () => {
  const f = fixture(); const {decision} = await f.app.decide('a',{tmdbId:1,action:'dislike'});
  f.advance(); await f.app.processDue(); f.app.saveSettings({radarr:{url:'http://other:7878'}});
  await assert.rejects(f.app.undo('a',decision.id), /different Radarr/);
  assert.ok(f.exclusions.has(1));
});
