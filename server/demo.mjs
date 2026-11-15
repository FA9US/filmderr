// Deliberate sample data for an isolated, loopback-only preview. Never used in normal mode.
export const demoMovies = [
  { id: 693134, title: 'Dune: Part Two', year: 2024, poster: 'https://image.tmdb.org/t/p/w780/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg', overview: 'Paul Atreides joins the Fremen on a journey across Arrakis, facing a choice between love and the fate of the universe.', rating: 8.1, votes: 1000, runtime: 167, genres: ['Science Fiction', 'Adventure'], releaseDate: '2024-02-27', trailer: null },
  { id: 1184918, title: 'The Wild Robot', year: 2024, poster: 'https://image.tmdb.org/t/p/w780/wTnV3PCVW5O92JMrFvvrRcV39RU.jpg', overview: 'A robot stranded on an uninhabited island learns to adapt to the wild and becomes the protector of an orphaned gosling.', rating: 8.3, votes: 1000, runtime: 102, genres: ['Animation', 'Adventure'], releaseDate: '2024-09-12', trailer: null },
  { id: 157336, title: 'Interstellar', year: 2014, poster: 'https://image.tmdb.org/t/p/w780/gEU2QniE6E77NI6lCU6MxlNBvIx2.jpg', overview: 'A team of explorers travels beyond this galaxy to discover whether mankind has a future among the stars.', rating: 8.4, votes: 1000, runtime: 169, genres: ['Science Fiction', 'Drama'], releaseDate: '2014-11-05', trailer: null },
];
export class DemoIntegrations {
  constructor() { this.added = new Set(); this.excluded = new Map(); }
  async library() { return { radarrIds: new Set(this.added), plexIds: new Set(), excludedIds: new Set(this.excluded.keys()) }; }
  async discover() { return demoMovies; }
  async movie(id) { const movie = demoMovies.find(m => m.id === Number(id)); if (!movie) throw Object.assign(new Error('Sample movie not found.'), { status: 404 }); return movie; }
  async genres() { return [{ id: 878, name: 'Science Fiction' }, { id: 12, name: 'Adventure' }, { id: 16, name: 'Animation' }, { id: 18, name: 'Drama' }]; }
  async test() { return { ok: true, message: 'Demo only. No external connection was made.', profiles: [{ id: 1, name: 'Sample 4K profile' }], rootFolders: [{ id: 1, path: '/movies' }], libraries: [{ key: '1', title: 'Movies' }] }; }
  async addMovie(movie) { this.added.add(movie.id); return { message: 'Simulated request. No movie was added to Radarr.' }; }
  async findExclusion(id) { return this.excluded.get(Number(id)) ?? null; }
  async exclude(movie) { const existing = this.excluded.get(movie.id); if (existing) return { id: existing.id, created: false }; this.excluded.set(movie.id, { id: movie.id, tmdbId: movie.id }); return { id: movie.id, created: true }; }
  async removeExclusion(id, tmdbId) { this.excluded.delete(tmdbId); }
}
