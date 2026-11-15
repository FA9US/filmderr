# Security

Do not publish API keys, Plex tokens, setup tokens, `.env`, databases, logs containing credentials, or the persistent data volume in issues or pull requests.

Report vulnerabilities privately using this repository's GitHub security reporting feature when available. If private reporting is unavailable, contact the maintainer through a private channel without posting exploit credentials in a public issue.

Filmderr is early-release software. Use HTTPS for remote access, invite only trusted accounts, retain backups, and update deliberately. Administrators can configure internal service endpoints and create accounts; treat administrator access accordingly.

Plex sign-in only admits invited verified emails. All library actions run with the configured service credentials and may affect the shared household library. Secrets stay on the server, state is encrypted at rest, session cookies are HttpOnly, and write routes require same-origin requests with CSRF protection after authentication. These controls do not protect a fully compromised Docker host.
