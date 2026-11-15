import test from 'node:test';
import assert from 'node:assert/strict';
import { Integrations } from '../server/integrations.mjs';

const settings = () => ({
  radarr: { url: 'http://radarr.internal:7878/base', apiKey: 'radarr-secret', qualityProfileId: 7, rootFolder: '/movies', minimumAvailability: 'released' },
  plex: { url: '', token: '', libraryIds: [] },
  tmdb: { apiKey: 'tmdb-read-token' },
  seerr: { enabled: false, url: 'http://seerr.internal:5055', apiKey: 'seerr-secret' }, region: 'NL',
});
const movie = { id: 123, title: 'Example', year: 2026 };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function mocked(configuration, handler) {
  const calls = [];
  const api = new Integrations(configuration, { fetchImpl: async (url, options) => {
    const request = { url: new URL(url), ...options, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(request);
    const result = await handler(request);
    assert.ok(result instanceof Response, `Unexpected request: ${request.method} ${request.url.pathname}`);
    return result;
  } });
  return { api, calls };
}
function radarrDefaults(r) {
  if (r.url.pathname.endsWith('/exclusions')) return json([]);
  if (r.url.pathname.endsWith('/qualityprofile')) return json([{ id: 7, name: 'Cinema' }]);
  if (r.url.pathname.endsWith('/rootfolder')) return json([{ id: 1, path: '/movies' }]);
  if (r.url.pathname.endsWith('/movie/lookup')) return json([{ tmdbId: 123, title: 'Canonical title', year: 2026, images: [] }]);
  if (r.url.pathname.endsWith('/movie') && r.method === 'GET') return json([]);
}

test('Radarr add uses validated profile/root, Movie Only, monitoring and immediate search', async () => {
  const { api, calls } = mocked(settings(), r => r.method === 'POST' ? json({ id: 45, tmdbId: 123, monitored: true }) : radarrDefaults(r));
  const result = await api.addMovie(movie);
  assert.equal(result.externalId, 45);
  const post = calls.find(r => r.method === 'POST');
  assert.equal(post.url.pathname, '/base/api/v3/movie');
  assert.equal(post.body.title, 'Canonical title');
  assert.equal(post.body.qualityProfileId, 7);
  assert.equal(post.body.rootFolderPath, '/movies');
  assert.equal(post.body.monitored, true);
  assert.deepEqual(post.body.addOptions, { monitor: 'movieOnly', searchForMovie: true });
  assert.ok(calls.every(r => r.redirect === 'manual' && r.signal instanceof AbortSignal));
  assert.ok(calls.every(r => r.headers['X-Api-Key'] === 'radarr-secret' && !r.url.search.includes('secret')));
});

test('existing unmonitored Radarr title is not changed or searched', async () => {
  const { api, calls } = mocked(settings(), () => json([{ id: 9, tmdbId: 123, monitored: false, hasFile: false }]));
  await assert.rejects(api.addMovie(movie), e => e.status === 409 && /already in Radarr/.test(e.message));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
});

test('lookup race and pre-existing exclusions prevent movie writes', async () => {
  for (const cause of ['lookup', 'excluded']) {
    const { api, calls } = mocked(settings(), r => {
      if (cause === 'lookup' && r.url.pathname.endsWith('/movie/lookup')) return json([{ id: 77, tmdbId: 123 }]);
      if (cause === 'excluded' && r.url.pathname.endsWith('/exclusions')) return json([{ id: 10, tmdbId: 123 }]);
      return radarrDefaults(r);
    });
    await assert.rejects(api.addMovie(movie), e => e.status === 409);
    assert.ok(calls.every(r => r.method === 'GET'));
  }
});

test('removed Radarr profile prevents movie submission', async () => {
  const { api, calls } = mocked(settings(), r => r.url.pathname.endsWith('/qualityprofile') ? json([]) : radarrDefaults(r));
  await assert.rejects(api.addMovie(movie), /no longer available/);
  assert.ok(calls.every(r => r.method === 'GET'));
});

test('Radarr and Plex libraries include all Radarr statuses and canonical Plex IDs', async () => {
  const config = settings();
  config.plex = { url: 'http://plex.internal:32400', token: 'plex-secret', libraryIds: ['1'] };
  const { api, calls } = mocked(config, r => {
    if (r.url.pathname.endsWith('/movie')) return json([{ tmdbId: 1, hasFile: true }, { tmdbId: 2, monitored: true }, { tmdbId: 3, monitored: false }]);
    if (r.url.pathname.endsWith('/exclusions')) return json([{ id: 1, tmdbId: 4 }]);
    if (r.url.pathname === '/library/sections') return json({ MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie', agent: 'tv.plex.agents.movie' }, { key: '2', title: 'TV', type: 'show' }] } });
    if (r.url.pathname === '/library/sections/1/all') {
      assert.equal(r.url.searchParams.get('includeGuids'), '1');
      const offset = Number(r.headers['X-Plex-Container-Start']);
      return json({ MediaContainer: { totalSize: 3, Metadata: offset === 0 ? [
        { ratingKey: '10', guid: 'plex://movie/a', Guid: [{ id: 'tmdb://5' }] },
        { ratingKey: '11', guid: 'com.plexapp.agents.themoviedb://6?lang=en' },
      ] : [{ ratingKey: '12', guid: 'plex://movie/b' }] } });
    }
    if (r.url.pathname === '/library/metadata/12') return json({ MediaContainer: { Metadata: [{ Guid: [{ id: 'imdb://tt0012345' }] }] } });
    if (r.url.pathname === '/3/find/tt0012345') return json({ movie_results: [{ id: 7 }] });
  });
  const data = await api.library();
  assert.deepEqual([...data.radarrIds], [1, 2, 3]);
  assert.deepEqual([...data.excludedIds], [4]);
  assert.deepEqual([...data.plexIds], [5, 6, 7]);
  const plexCalls = calls.filter(r => r.url.hostname === 'plex.internal');
  assert.ok(plexCalls.every(r => r.headers.Accept === 'application/json' && r.headers['X-Plex-Token'] === 'plex-secret'));
  assert.equal(plexCalls.filter(r => r.url.pathname.endsWith('/all')).length, 2);
  assert.equal(calls.find(r => r.url.hostname === 'api.themoviedb.org').headers.Authorization, 'Bearer tmdb-read-token');
});

test('failed or incomplete configured Plex scan fails closed instead of returning an empty library', async () => {
  const config = settings();
  config.plex = { url: 'http://plex.internal', token: 'plex-secret', libraryIds: [] };
  for (const mode of ['offline', 'incomplete']) {
    const { api } = mocked(config, r => {
      if (r.url.hostname !== 'plex.internal') return radarrDefaults(r);
      if (mode === 'offline') return json({ token: 'DO-NOT-LEAK' }, 503);
      if (r.url.pathname === '/library/sections') return json({ MediaContainer: { Directory: [{ key: '1', title: 'Movies', type: 'movie' }] } });
      return json({ MediaContainer: { totalSize: 10, Metadata: [] } });
    });
    await assert.rejects(api.library(), e => /Plex/.test(e.message) && !e.message.includes('DO-NOT-LEAK'));
  }
});

test('errors never expose upstream credentials, bodies, URLs or fetch exception text', async () => {
  for (const mode of ['http', 'redirect', 'network', 'json']) {
    const { api, calls } = mocked(settings(), () => {
      if (mode === 'network') throw new Error('radarr-secret http://sensitive-host/');
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.invalid/steal' } });
      if (mode === 'json') return new Response('radarr-secret <html>', { status: 200 });
      return json({ message: 'radarr-secret http://sensitive-host/' }, 401);
    });
    await assert.rejects(api.findExclusion(123), e => !/secret|sensitive-host|evil.invalid|<html>/.test(e.message));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, 'manual');
  }
});

test('base URLs reject credentials and preserve supported API suffix without doubling', async () => {
  const bad = settings(); bad.radarr.url = 'http://admin:secret@radarr.internal';
  const { api, calls } = mocked(bad, () => json([]));
  await assert.rejects(api.findExclusion(123), /valid Radarr base URL/);
  assert.equal(calls.length, 0);
  const good = settings(); good.radarr.url = 'http://radarr.internal/base/api/v3/';
  const accepted = mocked(good, () => json([]));
  await accepted.api.findExclusion(123);
  assert.equal(accepted.calls[0].url.pathname, '/base/api/v3/exclusions');
});

test('exclusion create tracks ownership; existing exclusions are never claimed', async () => {
  let exists = false;
  const { api, calls } = mocked(settings(), r => {
    if (r.method === 'GET') return json(exists ? [{ id: 77, tmdbId: 123 }] : []);
    exists = true;
    assert.deepEqual(r.body, { tmdbId: 123, movieTitle: 'Example', movieYear: 2026 });
    return json({ id: 77, tmdbId: 123 });
  });
  assert.deepEqual(await api.exclude(movie), { id: 77, created: true });
  assert.deepEqual(await api.exclude(movie), { id: 77, created: false });
  assert.equal(calls.filter(r => r.method === 'POST').length, 1);
});

test('exclusion undo verifies both identifiers and tolerates already-removed exclusions', async () => {
  for (const mode of ['match', 'different', 'missing']) {
    const { api, calls } = mocked(settings(), r => {
      if (r.method === 'DELETE') return new Response(null, { status: 204 });
      return mode === 'missing' ? json({}, 404) : json({ id: 77, tmdbId: mode === 'match' ? 123 : 456 });
    });
    if (mode === 'different') await assert.rejects(api.removeExclusion(77, 123), e => e.status === 409);
    else await api.removeExclusion(77, 123);
    assert.equal(calls.filter(r => r.method === 'DELETE').length, mode === 'match' ? 1 : 0);
  }
});

const seerrServer = () => ({ id: 0, apiKey: 'radarr-secret', activeProfileId: 7, activeDirectory: '/movies', preventSearch: false, minimumAvailability: 'released', is4k: true, overrideRule: [] });
test('Seerr mode uses verified profile mapping, preserves request history and never writes Radarr directly', async () => {
  const config = settings(); config.seerr.enabled = true;
  const { api, calls } = mocked(config, r => {
    if (r.url.pathname.endsWith('/auth/me')) return json({ id: 1, permissions: 2 });
    if (r.url.pathname.endsWith('/settings/radarr')) return json([seerrServer()]);
    if (r.url.pathname.endsWith('/request')) return json({ id: 12, status: 2 });
    return radarrDefaults(r);
  });
  const result = await api.addMovie(movie);
  assert.equal(result.externalId, 12);
  assert.match(result.message, /Requested through Seerr/);
  const posts = calls.filter(r => r.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url.hostname, 'seerr.internal');
  assert.deepEqual(posts[0].body, { mediaType: 'movie', mediaId: 123, is4k: true, serverId: 0, profileId: 7, rootFolder: '/movies' });
});

test('Seerr mismatch and submission errors never fall back to direct Radarr add', async () => {
  for (const mode of ['identity', 'profile', 'search', 'overrides', 'submit']) {
    const config = settings(); config.seerr.enabled = true;
    const { api, calls } = mocked(config, r => {
      if (r.url.pathname.endsWith('/auth/me')) return json({ id: 1, permissions: 2 });
      if (r.url.pathname.endsWith('/settings/radarr')) {
        const server = seerrServer();
        if (mode === 'identity') server.apiKey = 'different-secret';
        if (mode === 'profile') server.activeProfileId = 99;
        if (mode === 'search') server.preventSearch = true;
        if (mode === 'overrides') server.overrideRule = [1];
        return json([server]);
      }
      if (r.url.pathname.endsWith('/request')) return json({ error: 'seerr-secret' }, 500);
      return radarrDefaults(r);
    });
    await assert.rejects(api.addMovie(movie));
    assert.equal(calls.filter(r => r.method === 'POST' && r.url.hostname === 'radarr.internal').length, 0);
  }
});

test('discovery spans year/months and pages, applies filters and removes duplicate IDs', async () => {
  const year = new Date().getFullYear() - 1;
  const { api, calls } = mocked(settings(), r => {
    if (r.url.pathname.endsWith('/genre/movie/list')) return json({ genres: [{ id: 28, name: 'Action' }] });
    assert.equal(r.url.pathname, '/3/discover/movie');
    assert.equal(r.url.searchParams.get('primary_release_year'), String(year));
    assert.equal(r.url.searchParams.get('sort_by'), 'primary_release_date.asc');
    assert.equal(r.url.searchParams.get('with_genres'), '28');
    assert.equal(r.url.searchParams.get('with_original_language'), 'en');
    assert.equal(r.url.searchParams.get('vote_average.gte'), '6');
    const start = r.url.searchParams.get('primary_release_date.gte');
    const month = Number(start.slice(5, 7));
    const page = Number(r.url.searchParams.get('page'));
    const row = { id: month * 100 + page, title: `Film ${month}/${page}`, release_date: start, poster_path: '/poster.jpg', genre_ids: [28], vote_average: 7, vote_count: 100, original_language: 'en' };
    return json({ total_pages: 3, results: [row, row, { ...row, id: 99999, adult: true }] });
  });
  const movies = await api.discover({ year, genres: [28], originalLanguage: 'en', minRating: 6, minVotes: 50 });
  assert.equal(movies.length, 36);
  assert.equal(new Set(movies.map(m => m.id)).size, 36);
  assert.ok(movies.every(m => m.genres[0] === 'Action' && m.poster.endsWith('/poster.jpg')));
  assert.equal(new Set(calls.filter(r => r.url.pathname.endsWith('/discover/movie')).map(r => r.url.searchParams.get('primary_release_date.gte'))).size, 12);
  assert.equal(calls.filter(r => r.url.pathname.endsWith('/discover/movie')).length, 36);
});

test('digital discovery sends regional digital availability dates and future years obey upcoming toggle', async () => {
  const config = settings(); const year = new Date().getFullYear() + 1;
  const { api, calls } = mocked(config, r => r.url.pathname.endsWith('/genre/movie/list') ? json({ genres: [] }) : json({ total_pages: 0, results: [] }));
  assert.deepEqual(await api.discover({ year, releaseType: 'digital', includeUpcoming: false }), []);
  assert.equal(calls.length, 1);
  await api.discover({ year, releaseType: 'digital', includeUpcoming: true });
  const queries = calls.filter(r => r.url.pathname.endsWith('/discover/movie'));
  assert.equal(queries.length, 12);
  assert.ok(queries.every(r => r.url.searchParams.get('region') === 'NL' && r.url.searchParams.get('with_release_type') === '4'));
});

test('large TMDB windows split instead of ignoring titles beyond the 500-page cap', async () => {
  const year = new Date().getFullYear() - 1;
  const { api, calls } = mocked(settings(), r => {
    if (r.url.pathname.endsWith('/genre/movie/list')) return json({ genres: [] });
    const start = r.url.searchParams.get('primary_release_date.gte');
    const end = r.url.searchParams.get('primary_release_date.lte');
    const split = start === `${year}-01-01` && end === `${year}-01-31`;
    return json({ total_pages: split ? 501 : 0, results: [] });
  });
  await api.discover({ year });
  const ranges = calls.filter(r => r.url.pathname.endsWith('/discover/movie')).map(r => [r.url.searchParams.get('primary_release_date.gte'), r.url.searchParams.get('primary_release_date.lte')]);
  assert.ok(ranges.some(([start, end]) => start === `${year}-01-01` && end === `${year}-01-16`));
  assert.ok(ranges.some(([start, end]) => start === `${year}-01-17` && end === `${year}-01-31`));
});

test('movie detail permits valid YouTube trailer keys and prefers official trailers', async () => {
  const { api, calls } = mocked(settings(), () => json({
    id: 123, title: 'Example', release_date: '2026-05-01', poster_path: '/a.jpg', genres: [{ id: 28, name: 'Action' }],
    videos: { results: [
      { site: 'YouTube', type: 'Trailer', key: 'AAAAAAAAAAA', size: 2160, official: false },
      { site: 'YouTube', type: 'Trailer', key: 'BBBBBBBBBBB', size: 1080, official: true, name: 'Official trailer' },
      { site: 'YouTube', type: 'Trailer', key: 'bad/<script>', size: 9999, official: true },
      { site: 'Vimeo', type: 'Trailer', key: 'CCCCCCCCCCC', size: 9999, official: true },
    ] },
  }));
  const detail = await api.movie(123);
  assert.deepEqual(detail.trailer, { key: 'BBBBBBBBBBB', name: 'Official trailer' });
  detail.trailer.key = 'mutated';
  assert.equal((await api.movie(123)).trailer.key, 'BBBBBBBBBBB');
  assert.equal(calls.length, 1);
});

test('read-only test returns only selected connection metadata, never upstream secrets', async () => {
  const { api, calls } = mocked(settings(), r => {
    if (r.url.pathname.endsWith('/system/status')) return json({ version: '6.0', private: 'SECRET' });
    if (r.url.pathname.endsWith('/qualityprofile')) return json([{ id: 7, name: 'Cinema', apiKey: 'SECRET' }]);
    if (r.url.pathname.endsWith('/rootfolder')) return json([{ id: 1, path: '/movies', apiKey: 'SECRET' }]);
  });
  const result = await api.test('radarr');
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.ok(calls.every(r => r.method === 'GET'));
});
