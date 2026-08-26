# Nexus Edge Cloudflare Installer

This directory contains the public, browser-based D1 installer for Nexus Edge.
It provisions a prebuilt, signed Core release into the Cloudflare account chosen
by the user. The browser flow does not require GitHub, Node.js, pnpm, or Wrangler
on the customer's computer.

## Components

- `frontend/`: React/Vite interface in Portuguese and English;
- `worker/`: OAuth callback, Cloudflare API client, release verifier, provisioning
  state machine, and `InstallationSession` Durable Object;
- `release-build/`: ignored local output produced by the signed release builder.

The installer creates a D1 database, applies additive migrations, creates a
Queue and DLQ, uploads the Core Worker and static assets, configures Cron and the
Queue consumer, enables `workers.dev` or a reviewed Custom Domain, and verifies
the installation before revoking temporary OAuth access.

## Local validation

Use Node.js 24 and pnpm 11.19.0 from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm installer:cf-typegen
pnpm typecheck
pnpm test
pnpm test:matrix
pnpm openapi:check
pnpm build
pnpm verify:artifacts
pnpm verify:bundle
```

`pnpm test` includes tests inside the Workers runtime through Cloudflare's
Vitest integration. The test credentials in `vitest.config.ts` are inert local
fixtures, not Cloudflare credentials.

## Configuration

The staging configuration is `worker/wrangler.jsonc`. Its OAuth client ID,
approved scope IDs, redirect URI, and Ed25519 public key are public deployment
metadata. The following values must remain outside source control:

- Worker secrets: `OAUTH_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY`;
- release signing secret used only by CI:
  `INSTALLER_RELEASE_PRIVATE_KEY_PKCS8_BASE64`;
- Cloudflare deployment credential with only the staging resources it manages.

The Ed25519 public key is not secret and is configured as
`RELEASE_PUBLIC_KEY`. The signing private key must never be sent to the
installer Worker or written to the repository.

See [the architecture](../docs/INSTALLER-ARCHITECTURE.md),
[operations runbook](../docs/INSTALLER-OPERATIONS.md), and
[privacy policy](../docs/INSTALLER-PRIVACY.md) before provisioning or deploying
an environment.
