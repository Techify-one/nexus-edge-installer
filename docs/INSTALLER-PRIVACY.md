# Nexus Edge Installer Privacy

## What the installer handles

The installer handles a temporary Cloudflare OAuth access token while it creates
the reviewed resources. The token and generated Core secrets are kept in an
encrypted, short-lived, HttpOnly browser cookie. They are not written to the
installer database, Durable Object state, R2, logs, analytics, or support
reports. Refresh tokens are rejected.

Techify does not receive the customer's Cloudflare password. The temporary
authorization is revoked at the end of a successful installation. If a user
cancels, the installer attempts to revoke that temporary authorization.

## Data retained

During an active installation, the installer stores resource names and IDs,
status, attempts, release version/hash, timestamps, the selected account ID, and
a one-way browser-binding hash. Active state expires after one hour. Completed
metadata expires within 24 hours. No customer business data is read from D1.

The initial installer never requests the dedicated plugin token. On the first
plugin installation, the authenticated Core interface accepts a token limited
to one Cloudflare account and Workers Scripts Write, validates its narrow scope,
and sends it directly to Cloudflare as the Core Worker's `CF_API_TOKEN` secret.
The Core does not write the value to D1, logs, support reports, or API responses.

## Logs and third parties

Installer routes use sanitized event logs only. Authorization headers, cookies,
request bodies, OAuth codes, tokens, and secrets are not logged. Persistent
request observability is disabled for the installer because OAuth callbacks can
contain sensitive query parameters. The flow includes no advertising pixels,
third-party analytics, session recording, or remote scripts.

## Support

Support may request the installer-generated JSON report. It must never request
a Global API Key, API token, OAuth token, browser cookie, Core secret, database
connection string, or administrator password. If Cloudflare logs are supplied,
the customer should redact headers and query parameters first.
