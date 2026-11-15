import { randomUUID, randomInt, createHash } from 'node:crypto';
import { Integrations } from './integrations.mjs';

export const DEFAULT_SETTINGS = {
  radarr: { url: '', apiKey: '', qualityProfileId: null, rootFolder: '', minimumAvailability: 'released' },
  plex: { url: '', token: '', libraryIds: [] }, tmdb: { apiKey: '' },
  seerr: { enabled: false, url: '', apiKey: '' }, authMode: 'plex',
  sharedExclusions: true, publicUrl: '', region: 'NL',
};
export function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }
export function preferences(input = {}) {
  const year = Number(input.year ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 1874 || year > new Date().getFullYear() + 5) throw fail('Choose a valid release year.');
  const genres = [...new Set(input.genres ?? [])].map(Number);
  if (genres.length > 20 || genres.some(id => !Number.isInteger(id) || id < 1)) throw fail('Choose valid genres.');
  const originalLanguage = String(input.originalLanguage ?? '');
  if (originalLanguage && !/^[a-z]{2}$/.test(originalLanguage)) throw fail('Choose a two-letter original language.');
  const minRating = Number(input.minRating ?? 0), minVotes = Number(input.minVotes ?? 0);
  if (!Number.isFinite(minRating) || minRating < 0 || minRating > 10 || !Number.isInteger(minVotes) || minVotes < 0 || minVotes > 1000000) throw fail('Check the rating and vote filters.');
  if (input.includeUpcoming !== undefined && typeof input.includeUpcoming !== 'boolean') throw fail('Upcoming releases must be on or off.');
  if (input.releaseType !== undefined && !['any', 'digital'].includes(input.releaseType)) throw fail('Choose cinema or digital release filtering.');
  return { year, includeUpcoming: input.includeUpcoming ?? false, releaseType: input.releaseType ?? 'any', genres, originalLanguage, minRating, minVotes };
}
function validateUrl(value, name, publicOnly = false) {
  if (!value) return '';
  let url; try { url = new URL(value); } catch { throw fail(`${name} must be a valid HTTP or HTTPS URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail(`${name} must not contain credentials, queries or fragments.`);
  if (publicOnly && url.pathname !== '/') throw fail('Public URL must use a dedicated hostname, without a path.');
  return url.href.replace(/\/$/, '');
}
export function mergeSettings(current, patch) {
  const result = structuredClone(current);
  for (const section of ['radarr', 'plex', 'tmdb', 'seerr']) {
    const value = patch[section];
    if (!value) continue;
    if (typeof value !== 'object' || Array.isArray(value)) throw fail('Invalid integration settings.');
    for (const key of Object.keys(DEFAULT_SETTINGS[section])) {
      if (!(key in value)) continue;
      if (['apiKey', 'token'].includes(key)) {
        if (typeof value[key] !== 'string' || value[key].length > 4096) throw fail('Invalid credential.');
        if (value[key].trim()) result[section][key] = value[key].trim();
      } else result[section][key] = value[key];
    }
  }
  for (const secret of patch.clearSecrets ?? []) {
    if (!['radarr.apiKey', 'plex.token', 'tmdb.apiKey', 'seerr.apiKey'].includes(secret)) throw fail('Unknown credential field.');
    const [section, key] = secret.split('.'); result[section][key] = '';
  }
  for (const key of ['authMode', 'sharedExclusions', 'publicUrl', 'region']) if (key in patch) result[key] = patch[key];
  for (const section of ['radarr', 'plex', 'seerr']) result[section].url = validateUrl(result[section].url, section);
  result.publicUrl = validateUrl(result.publicUrl, 'Public URL', true);
  if (!['plex', 'local', 'both'].includes(result.authMode)) throw fail('Choose Plex, local or both sign-in methods.');
  if (typeof result.sharedExclusions !== 'boolean' || typeof result.seerr.enabled !== 'boolean') throw fail('Invalid on/off setting.');
  if (!/^[A-Z]{2}$/.test(result.region)) throw fail('Region must be a two-letter country code.');
  const profile = result.radarr.qualityProfileId;
  if (profile !== null && (!Number.isInteger(Number(profile)) || Number(profile) < 1)) throw fail('Choose a valid Radarr quality profile.');
  result.radarr.qualityProfileId = profile === null ? null : Number(profile);
  if (typeof result.radarr.rootFolder !== 'string' || result.radarr.rootFolder.length > 1024) throw fail('Invalid Radarr root folder.');
  if (!['announced', 'inCinemas', 'released'].includes(result.radarr.minimumAvailability)) throw fail('Invalid minimum availability.');
  if (!Array.isArray(result.plex.libraryIds) || result.plex.libraryIds.length > 100 || result.plex.libraryIds.some(id => !/^\d+$/.test(String(id)))) throw fail('Invalid Plex libraries.');
  result.plex.libraryIds = result.plex.libraryIds.map(String);
  return result;
}
export function redactSettings(settings) {
  const clean = structuredClone(settings);
  for (const [section, key] of [['radarr', 'apiKey'], ['plex', 'token'], ['tmdb', 'apiKey'], ['seerr', 'apiKey']]) {
    clean[section][`has${key[0].toUpperCase()}${key.slice(1)}`] = Boolean(clean[section][key]); clean[section][key] = '';
  }
  return clean;
}
export function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = randomInt(i + 1); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}

export class Filmderr {
  constructor(store, { integrationFactory = settings => new Integrations(settings), now = Date.now, graceMs = 5000 } = {}) {
    this.store = store; this.factory = integrationFactory; this.now = now; this.graceMs = graceMs;
    this.lock = Promise.resolve(); this.pools = new Map(); this.adapter = null;
    this.adapterKey = null; this.settingsRevision = 0; this.initializing = null;
  }
  async init() {
    this.initializing ??= this.serialized(async () => {
      if (!await this.store.get('settings')) await this.store.set('settings', structuredClone(DEFAULT_SETTINGS));
      // Recovery is durable before the HTTP server/worker starts. Never replay uncertain external effects.
      for (const decision of await this.allDecisions()) if (['processing', 'undoing'].includes(decision.status)) {
        decision.message = decision.status === 'undoing'
          ? 'Interrupted during exclusion undo. Review the exclusion in Radarr; no automatic removal will be retried.'
          : 'Interrupted during submission. Check your request history or Radarr before trying again.';
        decision.status = 'failed';
        await this.store.set(`decision:${decision.id}`, decision);
      }
      return this;
    });
    return this.initializing;
  }
  async settings() { return await this.store.get('settings'); }
  async connectionIdentity(settings) {
    const { url, apiKey } = (settings || await this.settings()).radarr;
    return createHash('sha256').update(JSON.stringify([url, apiKey])).digest('hex');
  }
  async saveSettings(patch) {
    return this.serialized(async () => {
      const changesIntegrations = ['radarr', 'plex', 'tmdb', 'seerr', 'sharedExclusions', 'clearSecrets'].some(key => key in patch);
      if (changesIntegrations && (await this.allDecisions()).some(d => ['pending', 'processing', 'undoing'].includes(d.status))) throw fail('Finish or undo pending swipes before changing integrations.', 409);
      const next = mergeSettings(await this.settings(), patch);
      await this.store.set('settings', next);
      this.settingsRevision++; this.adapter = null; this.adapterKey = null; this.pools.clear();
      return redactSettings(next);
    });
  }
  async integration(settings) {
    const current = settings || await this.settings();
    const key = JSON.stringify(current);
    if (!this.adapter || this.adapterKey !== key) {
      this.adapter = this.factory(current); this.adapterKey = key;
    }
    return this.adapter;
  }
  async prefs(userId) { return preferences(await this.store.get(`prefs:${userId}`, {})); }
  async savePrefs(userId, value) {
    const p = preferences(value);
    return this.serialized(async () => { await this.store.set(`prefs:${userId}`, p); return p; });
  }
  async allDecisions() {
    const keys = await this.store.keys('decision:');
    return (await Promise.all(keys.map(key => this.store.get(key)))).filter(Boolean);
  }
  async history(userId) { return (await this.allDecisions()).filter(d => d.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(this.publicDecision); }
  publicDecision(decision) { const { userId, movie, externalId, connectionIdentity, ...safe } = decision; return safe; }
  serialized(fn) { const operation = this.lock.then(fn); this.lock = operation.catch(() => {}); return operation; }
  async deck(userId) {
    const revision = this.settingsRevision;
    const p = await this.prefs(userId), settings = await this.settings(), api = await this.integration(settings), key = JSON.stringify(p);
    let cached = this.pools.get(key);
    if (!cached || this.now() - cached.at > 15 * 60 * 1000) {
      const candidates = await api.discover(p);
      if (revision !== this.settingsRevision) throw fail('Connection settings changed. Refresh the deck.', 409);
      cached = { at: this.now(), movies: shuffle(candidates), warning: candidates.warning }; this.pools.set(key, cached);
      if (this.pools.size > 50) this.pools.delete(this.pools.keys().next().value);
    }
    const library = await api.library();
    const hidden = new Set((await this.allDecisions()).filter(d => !['undone', 'failed'].includes(d.status) && (d.userId === userId || d.action === 'like' || (d.action === 'dislike' && d.shared))).map(d => d.tmdbId));
    if (revision !== this.settingsRevision) throw fail('Connection settings changed. Refresh the deck.', 409);
    const movies = cached.movies.filter(m => !library.radarrIds.has(m.id) && !library.plexIds.has(m.id) && !library.excludedIds.has(m.id) && !hidden.has(m.id));
    return { movies: movies.slice(0, 30), remaining: movies.length, syncedAt: new Date(this.now()).toISOString(), ...(cached.warning ? { warning: cached.warning } : {}) };
  }
  async decide(userId, { tmdbId, action }) {
    const id = Number(tmdbId);
    if (!Number.isSafeInteger(id) || id < 1 || !['like', 'dislike', 'skip'].includes(action)) throw fail('Choose a valid movie and action.');
    return this.serialized(async () => {
      const decisions = await this.allDecisions();
      const previous = decisions.find(d => d.userId === userId && d.tmdbId === id && !['undone', 'failed'].includes(d.status));
      if (previous) return { decision: this.publicDecision(previous) };
      const settings = await this.settings(), api = await this.integration(settings);
      const movie = await api.movie(id);
      if (action !== 'skip') {
        const library = await api.library();
        if (library.radarrIds.has(id) || library.plexIds.has(id)) throw fail('This movie is already in your library or Radarr. Refresh the deck.', 409);
        if (action === 'like' && library.excludedIds.has(id)) throw fail('This movie is excluded in Radarr. Review its exclusion before requesting it.', 409);
        const blocking = decisions.find(d => d.tmdbId === id && d.userId !== userId && ['pending', 'processing', 'undoing'].includes(d.status) && (d.action === 'like' || (d.action === 'dislike' && d.shared)));
        if (blocking) throw fail('Another household member is deciding on this movie. Refresh in a moment.', 409);
      }
      const decision = { id: randomUUID(), userId, tmdbId: id, title: movie.title, movie, action,
        shared: action === 'dislike' && settings.sharedExclusions, connectionIdentity: await this.connectionIdentity(settings),
        status: action === 'skip' ? 'skipped' : 'pending', createdAt: new Date(this.now()).toISOString(),
        ...(action === 'skip' ? {} : { executeAt: new Date(this.now() + this.graceMs).toISOString() }) };
      await this.store.set(`decision:${decision.id}`, decision);
      return { decision: this.publicDecision(decision) };
    });
  }
  async processDue() {
    return this.serialized(async () => {
      const settings = await this.settings(), api = await this.integration(settings), connection = await this.connectionIdentity(settings);
      for (const d of (await this.allDecisions()).filter(d => d.status === 'pending' && Date.parse(d.executeAt) <= this.now()).sort((a,b) => a.executeAt.localeCompare(b.executeAt))) {
        // This commit MUST finish before any external side effect. A failed/uncertain commit stops the worker.
        d.status = 'processing'; await this.store.set(`decision:${d.id}`, d);
        try {
          if (d.connectionIdentity !== connection) throw fail('This pending decision belongs to a different Radarr connection. No change was made.', 409);
          const library = await api.library();
          if (library.radarrIds.has(d.tmdbId) || library.plexIds.has(d.tmdbId)) {
            d.status = 'already-present'; d.message = 'Already in Radarr or Plex; no change made.';
          } else if (d.action === 'like') {
            if (library.excludedIds.has(d.tmdbId)) throw fail('A household exclusion now exists. Nothing was requested.', 409);
            const result = await api.addMovie(d.movie);
            d.status = settings.seerr.enabled ? 'requested' : 'added';
            d.message = result.message; d.externalId = result.externalId;
          } else if (d.shared) {
            const result = await api.exclude(d.movie);
            if (result.created) await this.store.set(`exclusion:${d.connectionIdentity}:${d.tmdbId}`, { externalId: result.id, owned: true });
            d.externalId = result.id; d.status = 'excluded'; d.message = 'Excluded from automatic Radarr list imports.';
          } else { d.status = 'hidden'; d.message = 'Hidden from your Filmderr deck.'; }
        } catch (error) {
          d.status = 'failed'; d.message = error.status ? error.message : 'Submission could not be verified. Check the service before retrying.';
        }
        d.completedAt = new Date(this.now()).toISOString(); await this.store.set(`decision:${d.id}`, d);
      }
    });
  }
  async undo(userId, id) {
    return this.serialized(async () => {
      const d = await this.store.get(`decision:${id}`);
      if (!d || d.userId !== userId) throw fail('Decision not found.', 404);
      if (d.status === 'undone') return { decision: this.publicDecision(d) };
      if (['added', 'requested', 'processing', 'undoing', 'already-present'].includes(d.status)) throw fail('This request has already been submitted. Review it in Radarr or Seerr; Filmderr will not delete media.', 409);
      if (d.status === 'excluded') {
        const settings = await this.settings(), api = await this.integration(settings);
        if (d.connectionIdentity !== await this.connectionIdentity(settings)) throw fail('This dislike belongs to a different Radarr connection. Restore that connection before undoing it.', 409);
        const ownershipKey = `exclusion:${d.connectionIdentity}:${d.tmdbId}`;
        const owned = await this.store.get(ownershipKey);
        const other = (await this.allDecisions()).some(item => item.id !== d.id && item.tmdbId === d.tmdbId && item.connectionIdentity === d.connectionIdentity && item.action === 'dislike' && item.shared && ['pending', 'processing', 'undoing', 'excluded'].includes(item.status));
        if (owned?.owned && !other) {
          const current = await api.findExclusion(d.tmdbId);
          if (current && String(current.id) === String(owned.externalId)) {
            // Retire ownership durably BEFORE delete. An outage after delete must never leave
            // authority to delete a later exclusion that happens to reuse the numeric ID.
            d.status = 'undoing'; await this.store.set(`decision:${id}`, d);
            await this.store.set(ownershipKey, { ...owned, owned: false, releasing: true });
            try { await api.removeExclusion(current.id, d.tmdbId); }
            catch {
              d.status = 'failed'; d.message = 'Exclusion removal could not be verified. Review it in Radarr before retrying.';
              await this.store.set(`decision:${id}`, d);
              throw fail(d.message, 502);
            }
          }
          await this.store.delete(ownershipKey);
        }
        d.message = other ? 'Your dislike was undone; another household exclusion remains.' : owned?.owned ? 'Filmderr exclusion removed.' : 'Your dislike was undone. The pre-existing Radarr exclusion was preserved.';
      }
      d.status = 'undone'; await this.store.set(`decision:${id}`, d); return { decision: this.publicDecision(d) };
    });
  }
  async resetSkips(userId) {
    return this.serialized(async () => {
      for (const d of (await this.allDecisions()).filter(d => d.userId === userId && d.status === 'skipped')) {
        d.status = 'undone'; await this.store.set(`decision:${d.id}`, d);
      }
      return { ok: true };
    });
  }
}
