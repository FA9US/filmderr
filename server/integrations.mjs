// Selected API routines adapted from Seerr e59ffce72dcde43105fb53cfc9eee9e5d0bfa34c.
// Copyright (c) 2020 sct. MIT: see ../licenses/Seerr-MIT.txt and THIRD_PARTY_NOTICES.md.
import { randomInt } from 'node:crypto';

const TMDB = 'https://api.themoviedb.org/3';
const DAY = 86_400_000;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const names = { radarr: 'Radarr', plex: 'Plex', seerr: 'Seerr', tmdb: 'TMDB' };

function fail(message, status = 502) {
  return Object.assign(new Error(message), { status });
}
function id(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw fail('Invalid movie identifier.', 400);
  return number;
}
function array(value, service) {
  if (!Array.isArray(value)) throw fail(`${names[service]} returned an unexpected response.`);
  return value;
}
function baseUrl(value, service) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, '');
  } catch { throw fail(`Set a valid ${names[service]} base URL without credentials, query or fragment.`, 400); }
}
function apiBase(value, service) {
  const base = baseUrl(value, service);
  const suffix = service === 'radarr' ? '/api/v3' : '/api/v1';
  return base.endsWith(suffix) ? base : base + suffix;
}
function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
async function mapLimit(items, limit, fn) {
  let next = 0;
  const result = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await fn(items[index], index);
    }
  }));
  return result;
}
function dateString(time) { return new Date(time).toISOString().slice(0, 10); }
function poster(path) {
  return typeof path === 'string' && /^\/[A-Za-z0-9_.-]+$/.test(path)
    ? `https://image.tmdb.org/t/p/w780${path}` : null;
}
function summary(movie, genres = new Map()) {
  const date = typeof movie.release_date === 'string' ? movie.release_date : '';
  return {
    id: id(movie.id), title: String(movie.title || movie.original_title || 'Untitled'),
    year: Number(date.slice(0, 4)) || null, poster: poster(movie.poster_path),
    overview: String(movie.overview || ''), rating: Number(movie.vote_average) || 0,
    votes: Number(movie.vote_count) || 0, runtime: Number(movie.runtime) || null,
    genres: movie.genres ? movie.genres.map(g => String(g.name)) : (movie.genre_ids || []).map(g => genres.get(g)).filter(Boolean),
    releaseDate: date,
  };
}

export class Integrations {
  constructor(settings, { fetchImpl = fetch } = {}) {
    this.settings = settings || {};
    this.fetch = fetchImpl;
    this.cache = new Map();
  }

  async cached(key, ttl, fn) {
    const old = this.cache.get(key);
    if (old && old.expires > Date.now()) return structuredClone(old.value);
    const value = await fn();
    if (this.cache.size > 600) this.cache.clear();
    this.cache.set(key, { value: structuredClone(value), expires: Date.now() + ttl });
    return value;
  }

  async request(service, path, { query = {}, method = 'GET', body, headers = {}, missing = false } = {}) {
    const settings = this.settings[service] || {};
    const key = service === 'plex' ? settings.token : settings.apiKey;
    if (!key || typeof key !== 'string') throw fail(`Configure the ${names[service]} credential in Settings.`, 400);
    const base = service === 'tmdb' ? TMDB : service === 'plex' ? baseUrl(settings.url, service) : apiBase(settings.url, service);
    const url = new URL(base + path);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    const auth = service === 'plex'
      ? { 'X-Plex-Token': key, 'X-Plex-Product': 'Filmderr', 'X-Plex-Client-Identifier': 'filmderr-server', 'X-Plex-Device-Name': 'Filmderr' }
      : service === 'tmdb' ? {} : { 'X-Api-Key': key };
    if (service === 'tmdb') {
      if (/^[a-f0-9]{32}$/i.test(key)) url.searchParams.set('api_key', key);
      else auth.Authorization = `Bearer ${key}`;
    }
    let response;
    try {
      response = await this.fetch(url, {
        method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { Accept: 'application/json', ...auth, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw fail(`${names[service]} could not be reached or timed out. Check its connection settings.`); }
    // Never follow redirects with credentials, or include upstream URLs/body/error text in errors.
    if (response.status >= 300 && response.status < 400) throw fail(`${names[service]} redirected the API request. Use its direct API base URL.`);
    if (response.status === 404 && missing) return null;
    if (!response.ok) throw fail(`${names[service]} returned HTTP ${response.status}. Check its access and configuration.`);
    if (response.status === 204) return null;
    try {
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_JSON_BYTES) throw new Error();
      const reader = response.body?.getReader();
      if (!reader) return null;
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_JSON_BYTES) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
      if (!size) return null;
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw fail(`${names[service]} returned an unreadable or oversized JSON response.`); }
  }

  async test(service) {
    if (service === 'radarr') {
      const [status, profiles, roots] = await Promise.all([
        this.request('radarr', '/system/status'), this.request('radarr', '/qualityprofile'), this.request('radarr', '/rootfolder'),
      ]);
      if (!status?.version) throw fail('Radarr returned an unexpected status response.');
      return { ok: true, profiles: array(profiles, 'radarr').map(p => ({ id: p.id, name: p.name })),
        rootFolders: array(roots, 'radarr').map(p => ({ id: p.id, path: p.path })), message: 'Radarr connected.' };
    }
    if (service === 'plex') return { ok: true, libraries: await this.plexLibraries(), message: 'Plex connected.' };
    if (service === 'tmdb') { await this.genres(); return { ok: true, message: 'TMDB connected.' }; }
    if (service === 'seerr') {
      await this.seerrTarget();
      return { ok: true, message: 'Seerr connected; auto-approval, Radarr identity, profile, root folder and search settings match. Requests are recorded under the Seerr API administrator.' };
    }
    throw fail('Unknown integration.', 400);
  }

  async plexLibraries() {
    const data = await this.request('plex', '/library/sections');
    const directories = array(data?.MediaContainer?.Directory, 'plex');
    return directories.filter(l => l.type === 'movie' && l.agent !== 'com.plexapp.agents.none')
      .map(l => ({ id: String(l.key), name: String(l.title), type: 'movie' }));
  }

  // Adapted from Seerr PlexScanner.getMediaIds; use canonical IDs, never title matching.
  async plexMovieId(item) {
    let references = [...(Array.isArray(item.Guid) ? item.Guid.map(g => g.id) : []), item.guid].filter(v => typeof v === 'string');
    if (!references.some(v => /(?:tmdb|themoviedb|imdb):\/\//.test(v)) && item.ratingKey) {
      const data = await this.request('plex', `/library/metadata/${encodeURIComponent(item.ratingKey)}`);
      const metadata = data?.MediaContainer?.Metadata?.[0];
      references = [...references, ...(metadata?.Guid || []).map(g => g.id), metadata?.guid].filter(v => typeof v === 'string');
    }
    for (const reference of references) {
      const match = reference.match(/(?:^|\.)(?:tmdb|themoviedb):\/\/(\d+)(?:\?|$)/);
      if (match) return id(match[1]);
    }
    for (const reference of references) {
      const match = reference.match(/(?:^|\.)imdb:\/\/(tt\d+)(?:\?|$)/);
      if (match) {
        return this.cached(`imdb:${match[1]}`, DAY, async () => {
          const result = await this.request('tmdb', `/find/${match[1]}`, { query: { external_source: 'imdb_id' } });
          return result?.movie_results?.[0]?.id ? id(result.movie_results[0].id) : null;
        });
      }
    }
    // Unmatched personal/demo videos have no canonical movie to exclude.
    return null;
  }

  async plexIds() {
    if (!this.settings.plex?.url && !this.settings.plex?.token) return new Set();
    const libraries = await this.plexLibraries();
    const selected = (this.settings.plex?.libraryIds || []).map(String);
    if (selected.some(key => !libraries.some(l => l.id === key))) throw fail('A selected Plex movie library is unavailable. Update Settings.');
    const chosen = selected.length ? libraries.filter(l => selected.includes(l.id)) : libraries;
    const ids = new Set();
    for (const library of chosen) {
      let offset = 0;
      while (true) {
        const data = await this.request('plex', `/library/sections/${encodeURIComponent(library.id)}/all`, {
          query: { includeGuids: 1, type: 1 },
          headers: { 'X-Plex-Container-Start': String(offset), 'X-Plex-Container-Size': '200' },
        });
        if (!data?.MediaContainer) throw fail('Plex returned an unexpected library response.');
        const items = array(data.MediaContainer.Metadata || [], 'plex');
        const total = Number(data.MediaContainer.totalSize);
        if (!items.length) {
          if (Number.isFinite(total) && offset < total) throw fail('Plex library scan stopped before all movies were read.');
          break;
        }
        for (const movieId of await mapLimit(items, 4, item => this.plexMovieId(item))) if (movieId) ids.add(movieId);
        offset += items.length;
        if (Number.isFinite(total) ? offset >= total : items.length < 200) break;
        if (offset >= 100_000) throw fail('Plex library exceeded the supported scan size.');
      }
    }
    return ids;
  }

  async library() {
    const [movies, exclusions, plexIds] = await Promise.all([
      this.request('radarr', '/movie'), this.request('radarr', '/exclusions'), this.plexIds(),
    ]);
    return {
      radarrIds: new Set(array(movies, 'radarr').map(m => id(m.tmdbId))),
      excludedIds: new Set(array(exclusions, 'radarr').map(m => id(m.tmdbId))), plexIds,
    };
  }

  async genres() {
    return this.cached('genres', DAY, async () => {
      const data = await this.request('tmdb', '/genre/movie/list', { query: { language: 'en-US' } });
      return array(data?.genres, 'tmdb').map(g => ({ id: id(g.id), name: String(g.name) }));
    });
  }

  async discover(preferences = {}) {
    const year = Number(preferences.year || new Date().getFullYear());
    if (!Number.isInteger(year) || year < 1874 || year > new Date().getFullYear() + 5) throw fail('Choose a supported release year.', 400);
    const genreMap = new Map((await this.genres()).map(g => [g.id, g.name]));
    const now = dateString(Date.now());
    const endDate = preferences.includeUpcoming ? `${year}-12-31` : [`${year}-12-31`, now].sort()[0];
    if (endDate < `${year}-01-01`) return [];
    const common = {
      language: 'en-US', include_adult: false, include_video: false,
      primary_release_year: year, sort_by: 'primary_release_date.asc',
      with_genres: (preferences.genres || []).map(id).join('|'),
      with_original_language: preferences.originalLanguage && preferences.originalLanguage !== 'all' ? preferences.originalLanguage : undefined,
      'vote_average.gte': Number(preferences.minRating) || 0,
      'vote_count.gte': Number(preferences.minVotes) || 0,
      ...(preferences.releaseType === 'digital' ? {
        region: this.settings.region || 'NL', with_release_type: 4,
        'release_date.gte': `${year}-01-01`, 'release_date.lte': preferences.includeUpcoming ? `${year + 5}-12-31` : now,
      } : {}),
    };
    const windows = [];
    for (let month = 0; month < 12; month++) {
      const start = dateString(Date.UTC(year, month, 1));
      const end = [dateString(Date.UTC(year, month + 1, 0)), endDate].sort()[0];
      if (start <= end) windows.push([start, end]);
    }
    let pageBudget = 96;
    const queryPage = async (start, end, page) => {
      if (--pageBudget < 0) throw fail('The discovery filter is too broad. Select a genre, language or minimum rating.', 400);
      const result = await this.request('tmdb', '/discover/movie', { query: {
        ...common, 'primary_release_date.gte': start, 'primary_release_date.lte': end, page,
      } });
      if (!Array.isArray(result?.results) || !Number.isFinite(Number(result.total_pages))) throw fail('TMDB returned an unexpected discovery response.');
      return result;
    };
    const sampleWindow = async ([start, end]) => {
      const first = await queryPage(start, end, 1);
      const totalPages = Math.max(0, Number(first.total_pages));
      // Split large windows so titles past TMDB's 500-page ceiling remain reachable.
      if (totalPages > 500 && start !== end) {
        const startMs = Date.parse(start), endMs = Date.parse(end);
        const midpoint = startMs + Math.floor((endMs - startMs) / DAY / 2) * DAY;
        return [...await sampleWindow([start, dateString(midpoint)]), ...await sampleWindow([dateString(midpoint + DAY), end])];
      }
      if (totalPages > 500) throw fail('Too many titles share a release date. Narrow the discovery filters.', 400);
      const pages = shuffle(Array.from({ length: totalPages }, (_, i) => i + 1)).slice(0, 3);
      const rows = [];
      for (const page of pages) rows.push(...(page === 1 ? first : await queryPage(start, end, page)).results);
      return rows;
    };
    // Sample every month before shuffling; never simply shuffle the first popularity page.
    const groups = await mapLimit(windows, 3, sampleWindow);
    const unique = new Map();
    for (const m of groups.flat()) {
      if (!m?.id || !m.poster_path || m.adult || !m.release_date) continue;
      // Region-filtered TMDB results can carry a regional date in another year;
      // primary_release_year is enforced by the upstream query, not inferred from that date.
      if (preferences.releaseType !== 'digital' && (m.release_date < `${year}-01-01` || m.release_date > endDate)) continue;
      if (Number(m.vote_average || 0) < Number(preferences.minRating || 0) || Number(m.vote_count || 0) < Number(preferences.minVotes || 0)) continue;
      if (preferences.originalLanguage && preferences.originalLanguage !== 'all' && m.original_language !== preferences.originalLanguage) continue;
      unique.set(Number(m.id), { ...summary(m, genreMap), year });
    }
    return shuffle([...unique.values()]);
  }

  async movie(movieId) {
    movieId = id(movieId);
    return this.cached(`movie:${movieId}`, 60 * 60 * 1000, async () => {
      // Adapted from Seerr TheMovieDb.getMovie and mapVideos; request English and language-neutral videos.
      const data = await this.request('tmdb', `/movie/${movieId}`, { query: { language: 'en-US', append_to_response: 'videos', include_video_language: 'en,null' } });
      if (Number(data?.id) !== movieId) throw fail('TMDB returned a different movie.');
      const videos = data.videos?.results || [];
      const trailer = videos.filter(v => v.site === 'YouTube' && v.type === 'Trailer' && /^[\w-]{11}$/.test(v.key))
        .sort((a, b) => Number(b.official || false) - Number(a.official || false) || Number(b.size || 0) - Number(a.size || 0))[0];
      return { ...summary(data), trailer: trailer ? { key: trailer.key, name: String(trailer.name || 'Trailer') } : null };
    });
  }

  async present(movieId) {
    const movies = array(await this.request('radarr', '/movie', { query: { tmdbId: id(movieId) } }), 'radarr');
    return movies.find(m => Number(m.tmdbId) === Number(movieId)) || null;
  }

  async seerrTarget() {
    const [user, servers] = await Promise.all([
      this.request('seerr', '/auth/me'), this.request('seerr', '/settings/radarr'),
    ]);
    // API-key authentication acts as Seerr's original admin; require that behavior rather than silently queueing approval.
    if (!(Number(user?.permissions) & 2)) throw fail('Seerr must authenticate its API administrator for automatic requests.', 400);
    const radarr = this.settings.radarr || {};
    const matching = array(servers, 'seerr').filter(server =>
      server.apiKey === radarr.apiKey && Number(server.activeProfileId) === Number(radarr.qualityProfileId) && server.activeDirectory === radarr.rootFolder);
    if (matching.length !== 1) throw fail('Seerr must contain exactly one Radarr server with the same API key, selected quality profile and root folder.', 400);
    const target = matching[0];
    if (target.preventSearch !== false) throw fail('Enable automatic movie searches for the matching Radarr server in Seerr.', 400);
    if (target.overrideRule?.length) throw fail('Disable request override rules for the matching Seerr Radarr server so Filmderr can verify its profile and destination.', 400);
    if (target.minimumAvailability !== (radarr.minimumAvailability || 'released')) throw fail('Match the Radarr minimum availability setting in Filmderr and Seerr.', 400);
    return target;
  }

  async addMovie(movie) {
    const movieId = id(movie.id);
    if (await this.present(movieId)) throw fail('This movie is already in Radarr. The existing movie was left unchanged.', 409);
    if (await this.findExclusion(movieId)) throw fail('This movie is excluded in Radarr. Review the exclusion before adding it.', 409);
    const radarr = this.settings.radarr || {};
    const profileId = id(radarr.qualityProfileId);
    if (!radarr.rootFolder) throw fail('Select a Radarr root folder in Settings.', 400);
    if (this.settings.seerr?.enabled) {
      const target = await this.seerrTarget();
      const result = await this.request('seerr', '/request', { method: 'POST', body: {
        mediaType: 'movie', mediaId: movieId, is4k: !!target.is4k,
        serverId: target.id, profileId, rootFolder: radarr.rootFolder,
      } });
      if (!Number.isSafeInteger(result?.id) || result.id <= 0) throw fail('Seerr did not confirm a request ID. Check Seerr before retrying.');
      return { externalId: result.id,
        message: [2, 5].includes(result.status)
          ? 'Requested through Seerr with automatic approval. Seerr will send it to Radarr; download completion is not yet verified.'
          : 'Request recorded in Seerr; approval or service processing needs attention in Seerr. No direct Radarr fallback was attempted.' };
    }
    const [lookup, profiles, folders] = await Promise.all([
      this.request('radarr', '/movie/lookup', { query: { term: `tmdb:${movieId}` } }),
      this.request('radarr', '/qualityprofile'), this.request('radarr', '/rootfolder'),
    ]);
    const found = array(lookup, 'radarr').find(m => Number(m.tmdbId) === movieId);
    if (!found) throw fail('Radarr could not identify this movie.', 404);
    if (found.id) throw fail('This movie was added to Radarr while you were browsing. It was left unchanged.', 409);
    if (!array(profiles, 'radarr').some(p => p.id === profileId) || !array(folders, 'radarr').some(f => f.path === radarr.rootFolder)) throw fail('The selected Radarr profile or root folder is no longer available.', 400);
    // Adapted from Seerr RadarrAPI.addMovie, without its update/remonitor-existing branches.
    const added = await this.request('radarr', '/movie', { method: 'POST', body: {
      title: found.title || movie.title, qualityProfileId: profileId,
      titleSlug: found.titleSlug || String(movieId), minimumAvailability: radarr.minimumAvailability || 'released',
      tmdbId: movieId, year: found.year || movie.year, rootFolderPath: radarr.rootFolder,
      images: Array.isArray(found.images) ? found.images : [], monitored: true, tags: [],
      addOptions: { monitor: 'movieOnly', searchForMovie: true },
    } });
    if (!Number.isSafeInteger(added?.id) || Number(added.tmdbId) !== movieId || added.monitored !== true) throw fail('Radarr did not confirm the monitored movie. Check Radarr before retrying.');
    return { externalId: added.id, message: 'Added to Radarr, monitored with Movie Only and search requested. Download completion is not yet verified.' };
  }

  async findExclusion(movieId) {
    movieId = id(movieId);
    const exclusions = array(await this.request('radarr', '/exclusions'), 'radarr');
    return exclusions.find(e => Number(e.tmdbId) === movieId) || null;
  }

  async exclude(movie) {
    const movieId = id(movie.id);
    const existing = await this.findExclusion(movieId);
    if (existing) return { id: id(existing.id), created: false };
    const created = await this.request('radarr', '/exclusions', { method: 'POST', body: {
      tmdbId: movieId, movieTitle: String(movie.title), movieYear: Number(movie.year) || 0,
    } });
    if (!created?.id || Number(created.tmdbId) !== movieId) throw fail('Radarr did not confirm the exclusion. Check Radarr before retrying.');
    return { id: id(created.id), created: true };
  }

  async removeExclusion(externalId, movieId) {
    externalId = id(externalId); movieId = id(movieId);
    const existing = await this.request('radarr', `/exclusions/${externalId}`, { missing: true });
    if (!existing) return;
    if (Number(existing.id) !== externalId || Number(existing.tmdbId) !== movieId) throw fail('The exclusion changed in Radarr. It was left unchanged.', 409);
    await this.request('radarr', `/exclusions/${externalId}`, { method: 'DELETE' });
  }
}
