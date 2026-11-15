# Filmderr

**A movie night starts with a swipe.**

Filmderr is a self-hosted, mobile-first movie discovery app for Radarr and Plex. Browse a shuffled poster deck, hold a poster for its trailer, and choose what to watch next.

- **Swipe left / heart:** add, monitor and search in Radarr.
- **Swipe right / cross:** exclude the film from automatic Radarr list imports, or hide it personally when shared exclusions are disabled.
- **Genre button in the middle**, with personal year, upcoming-release, language, rating and vote filters.
- **Plex sign-in** with invited accounts, plus optional local sign-in.
- **Five-second undo**, skip for later, and persistent personal activity.
- **Plex-aware discovery:** omit movies already in Plex or in Radarr, including unmonitored movies.
- **Optional Seerr requests** to preserve Seerr request history; Seerr is not required.

Movies only. Filmderr does not manage TV shows, download files itself, delete media, or change existing Radarr quality profiles.

## Install with Docker Compose

Requires Docker Compose and a TMDB API credential. Radarr and Plex stay in their own containers/hosts. Obtain your own TMDB API credential from [TMDB](https://www.themoviedb.org/settings/api).

```sh
git clone https://github.com/FA9US/filmderr.git
cd filmderr
cp .env.example .env
```

Set `FILMDERR_SETUP_TOKEN` in `.env` to a randomly generated secret of at least 24 characters. For example, generate a value with `openssl rand -hex 32`. Do not publish `.env`.

```sh
docker compose pull
docker compose up -d
```

Open `http://localhost:3678`. The supplied Compose file binds only the Docker host's loopback interface. Use an SSH tunnel or an authenticated HTTPS reverse proxy when the Docker host is remote. For a local source build, use `docker compose up -d --build --pull never` instead.

In the setup screen, enter the setup token and the exact verified email of your Plex account. Plex-only mode still requires signing in with Plex after setup. Invite other household accounts by exact Plex email in **Settings → People**; public signup is disabled. Choose **Both** during setup if local sign-in is also wanted. Local passwords require at least 12 characters.

## Connect your library

1. Save the Radarr URL and API key, then test the saved connection. Choose a returned quality profile and root folder and save again. Filmderr uses **Movie Only**, monitoring and immediate search.
2. Save your TMDB API key or API read-access token. Filmderr uses it only on the server.
3. To hide Plex-only movies, save the Plex server URL and a server-owner token, test, and select movie libraries. Leaving all libraries unselected scans all movie libraries. Plex sign-in and Plex library access are separate connections; Filmderr does not reuse a visitor's account token as the server credential.
4. Invite other users. Each gets personal filters and history; shared exclusions affect the whole Radarr library.

Use direct internal service URLs where possible, for example `http://radarr:7878` on a shared Docker network. A reverse-proxy login page is not an API endpoint. TLS certificates must validate; Filmderr does not disable certificate checks.

Blank secret fields preserve saved credentials. Credentials and application state are encrypted in SQLite or MariaDB using a separate key in the persistent data volume. This protects accidental database-only disclosure, not a compromised host that can read both the database and its key.

## Use an existing MariaDB server

Filmderr can share your existing MariaDB server while keeping its own dedicated database and restricted account. It does not need another database container. The [MariaDB Compose example](compose.mariadb.yaml) connects to an existing Docker network and uses private bind mounts for the encryption key and secret files. When adding Filmderr to an existing stack, merge the service into your central YAML and reuse its existing network definitions.

Have the database administrator create an **empty, dedicated `filmderr` database** and a user granted only `SELECT, INSERT, UPDATE, DELETE, CREATE` on `filmderr.*`. Do not give Filmderr the root account or another application's database. The app creates its own encrypted `filmderr_kv` table; it refuses system schemas or databases containing unrelated tables. Configure:

| Variable | Value |
| --- | --- |
| `FILMDERR_DB_TYPE` | `mariadb` (default is `sqlite`) |
| `FILMDERR_DB_HOST` | Existing MariaDB service hostname on a shared network |
| `FILMDERR_DB_PORT` | `3306`, unless your server uses another port |
| `FILMDERR_DB_NAME` | Dedicated database name |
| `FILMDERR_DB_USER` | Dedicated database user |
| `FILMDERR_DB_PASSWORD_FILE` | Mounted private password file; alternatively use `FILMDERR_DB_PASSWORD` |

MariaDB owns the database files through its existing data volume. Filmderr's `/app/data` bind contains only its encryption key in MariaDB mode; keep this directory private and writable by container UID 1000. A private NAS directory can hold the key. Confirm that the intended mount is actually present before starting; `create_host_path: false` alone cannot detect an unmounted NAS.

Run **one Filmderr instance per database**. A connection-held database lock rejects a second instance. Database outages fail requests and health checks; Filmderr does not silently fall back to local storage or automatically reconnect a session that lost ownership. Restart Filmderr after the database is healthy. An existing SQLite installation is not automatically migrated when changing database type; keep its database and matching key together until an explicit migration is completed.

Use a trusted private network for this connection. Filmderr does not publish MariaDB's port. Do not bind SQLite files to NFS/SMB: its default WAL mode requires local storage. Switching to MariaDB does not relocate the existing MariaDB volume; inspect that container's actual storage mount separately.

## Optional Seerr integration

Enable Seerr when you want likes recorded in its request history, for example where a cleanup rule uses Seerr requests as a protection. Save Seerr's URL and API key, then test. Filmderr checks that the selected Seerr Radarr target matches the Radarr API key, quality profile, root folder, minimum availability and immediate-search configuration, and that requests can be auto-approved. It refuses mismatches instead of bypassing Seerr with a direct request.

Seerr requests are recorded under the account associated with its API key; Filmderr keeps the individual user's history. This is not automatic per-user Seerr account synchronization. Request override rules on the matching Seerr target must be disabled so Filmderr can verify the destination. **Requested** means Seerr accepted the request, not that a download has completed. Filmderr does not install or change Maintainerr rules. Direct Radarr requests do not automatically gain Seerr-request protection.

## Reverse proxy

Set `FILMDERR_PUBLIC_URL` to the exact external origin, such as `https://films.example.com`, and `FILMDERR_SECURE_COOKIES=true`. Preserve the Host header. The app uses same-origin JSON requests and CSRF tokens; it is served at `/`, not under a subpath.

For Traefik, join the existing proxy network and route the hostname to container port **3678**. Keep the data volume. The generic [Traefik example](docs/traefik.example.yaml) deliberately uses placeholder network, entrypoint and certificate-resolver names. DNS, HTTPS routing and authentication must be configured for your installation; creating a CNAME alone is insufficient.

## Decision behavior

- Pending likes/dislikes are saved and submitted after five seconds, even if the browser closes. Undo cancels pending work.
- Filmderr checks the library again immediately before submission. Submitted likes are never undone by deleting downloaded media.
- Radarr import-list exclusions block automatic list imports, not every manual/API request. They do not delete existing files or cancel an existing download.
- Undo only removes an exclusion created by this Filmderr instance on the same Radarr connection, and preserves it while another household dislike remains. Existing exclusions created elsewhere are preserved.
- Exclusions and library data can change between remote reads. External acquisition tools must check Radarr exclusions themselves. Filmderr cannot cancel another tool's in-flight request.
- Interrupted in-flight work is marked uncertain/failed, not automatically repeated. Review the service before retrying. An unavailable configured library prevents new decisions rather than pretending the library is empty.
- **Skip for now** is personal. Activity can restore skipped movies without resetting dislikes.
- Discovery is a bounded shuffled sample across monthly date windows and result pages, not a uniformly random sample of every movie in TMDB. Filters and metadata availability affect the pool. Refreshes retain decisions; a depleted deck suggests changing filters or restoring skips.
- The year defaults dynamically to the current year. The upcoming switch and digital release filter are personal settings. Trailers depend on provider availability and browser playback rules; a blocked embed can be opened on YouTube.

## Backup and updates

For SQLite, back up the **whole `filmderr_data` volume**, including `filmderr.sqlite`, its WAL files if present, and `encryption.key`. For a consistent simple backup, stop Filmderr during the copy. For MariaDB, stop Filmderr and take a consistent dump of its dedicated database plus a copy of `/app/data/encryption.key`; restore both together. Do not copy MariaDB's live data directory as a database backup. Losing the encryption key makes the stored configuration unrecoverable. Keep the database password and setup token in your private secret-management/backup process.

Before updating, keep a consistent data backup and record the previous image digest. Pull and recreate only Filmderr. Roll back to that digest and its matching data backup if required; never downgrade a database blindly. Published images target `linux/amd64` and `linux/arm64`.

## Development and isolated preview

Requires Node.js 24 or newer. The official MariaDB connector is pinned in the lockfile.

```sh
npm ci --ignore-scripts
node --test test/*.test.mjs
FILMDERR_DEMO=1 node server/index.mjs
```

PowerShell:

```powershell
$env:FILMDERR_DEMO='1'
node server/index.mjs
```

Demo mode binds to `127.0.0.1`, uses disposable sample data spanning multiple years, simulates decisions, and rejects integration/account changes. It never contacts your Radarr, Plex or Seerr. Poster images are fetched by the browser from TMDB. Restarting the demo resets it.

Tests cover mocked service protocols, ownership-aware undo, duplicate/race handling, persistence, encryption and actual loopback HTTP authentication/CSRF boundaries. CI also runs MariaDB persistence checks against an isolated database, then builds and smoke-tests the container before publishing. Locally the real MariaDB tests require the `FILMDERR_TEST_DB_*` variables and a disposable dedicated database; never point them at production. These checks do not establish live Plex PIN authorization, physical iPhone Safari behavior, household reverse-proxy operation or a successful real movie download; test those on your own installation.

## Credits

Selected service-adapter routines are adapted from [Seerr](https://github.com/seerr-team/seerr), with its MIT notices retained. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for exact source provenance. Filmderr is an independent project.

This product uses the TMDB API but is not endorsed or certified by TMDB. Movie metadata and poster rights belong to their respective owners; they are not part of Filmderr's MIT-licensed source. Trailer playback uses YouTube.

