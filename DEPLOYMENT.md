# Nexus Edge Installer deployment

The canonical test Installer is deployed from this repository to
`https://installer.francisconeto.net.br`.

Normal publication is performed by `.github/workflows/ci.yml` after validation
on `main`. The workflow builds the frontend, deploys
`nexus-edge-installer-staging`, and verifies the health and current signed Core
release endpoints. Do not publish the Installer from the Core repository.

The repository needs only `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets. The existing Worker secrets
`OAUTH_CLIENT_SECRET` and `SESSION_ENCRYPTION_KEY` remain attached to the Worker
and are never copied into source control or build artifacts.

Every new installation resolves `releases/stable.json` from the private R2
release bucket at installation time, verifies its Ed25519 signature and object
hashes, and pins that manifest for the duration of the installation. Core
release production belongs to `Techify-one/nexus-edge`; this repository only
consumes the signed distribution.

New Core Workers are provisioned with the native `API_RATE_LIMITER` binding at
600 requests per 60 seconds. This keeps request throttling out of D1's write
path and prevents concurrent first-page loads from contending on one counter.

For exceptional recovery only, use a secret-injected Cloudflare credential and
run `pnpm deploy`. Stop on any build, deployment, health, OAuth, or release
verification error.
