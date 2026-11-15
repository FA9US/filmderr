# Third-party code and services

## Seerr

Filmderr's `server/integrations.mjs` selectively adapts API routines from
[Seerr](https://github.com/seerr-team/seerr) at commit
[`e59ffce72dcde43105fb53cfc9eee9e5d0bfa34c`](https://github.com/seerr-team/seerr/commit/e59ffce72dcde43105fb53cfc9eee9e5d0bfa34c)
(13 November 2026). Copyright (c) 2020 sct. The complete MIT notice is retained in
[`licenses/Seerr-MIT.txt`](licenses/Seerr-MIT.txt).

Adapted source paths and behavior:

- `server/api/servarr/radarr.ts`: TMDB-ID movie lookup and monitored movie add payload;
  Filmderr refuses existing movies instead of changing their monitoring settings.
- `server/api/servarr/base.ts`: quality-profile, root-folder and status endpoint usage.
- `server/api/plexapi.ts`: JSON library selection, GUID-inclusive pagination and metadata reads.
- `server/lib/scanners/plex/index.ts`: canonical TMDB/IMDb GUID extraction and IMDb fallback.
- `server/api/themoviedb/index.ts`: release/genre discovery parameters and movie video retrieval.
- `server/models/common.ts`, `src/components/MovieDetails/index.tsx`: trailer metadata mapping
  and selecting YouTube trailers; Filmderr prefers official trailers and restricts video keys.

The adapters use Node's built-in fetch instead of Seerr's Axios/cache/settings system.
Filmderr adds independent discovery sampling, safe errors, timeout and redirect handling,
Radarr import-list exclusions, and matching checks for optional Seerr submission.
No Seerr application credential is copied. Filmderr is an independent project and is not
endorsed by Seerr, Radarr, Plex or TMDB.

## TMDB metadata

This product uses the TMDB API but is not endorsed or certified by TMDB.
Every installation supplies its own TMDB API key or API Read Access Token.
Movie metadata and poster images are fetched from TMDB; they are not bundled as project assets.
See [TMDB API FAQ and attribution](https://developer.themoviedb.org/docs/faq).

## Operational limits

Discovery samples up to three randomly selected pages per monthly release-date window,
then shuffles the combined pool. Oversized windows are split to avoid TMDB's 500-page cap;
a 96-request limit asks users to narrow filters rather than silently claiming full coverage.
This is a broad random sample, not a uniform random draw over every movie in TMDB.
The year filter refers to the primary release year. Digital mode additionally requires a
digital release in the configured region, up to today unless upcoming titles are enabled.

Plex exclusion matching uses external movie identifiers, including an IMDb-to-TMDB lookup.
Personal/demo videos with no resolvable external movie identifier cannot be matched.
Optional Seerr requests are recorded under the original Seerr API administrator, not the
individual Filmderr user. Filmderr keeps its own user decision history. A recorded Seerr
request is not proof of Radarr acceptance or download completion, and cleanup protection
still depends on the installation's actual cleanup rules. Seerr request overrides must be
disabled for the selected server; its profile, root folder, minimum availability and search
configuration must match Filmderr. No failed Seerr request falls back to direct Radarr writes.

Radarr Import List Exclusions prevent list imports. They do not delete files, cancel existing
downloads, or universally prohibit explicit API/manual additions.
