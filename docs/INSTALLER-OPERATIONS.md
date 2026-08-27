# Nexus Edge Installer Operations

This runbook applies to the Techify-hosted installer, not to normal Core
production deployment. Read `DEPLOYMENT.md` first. Staging and production must
use separate Workers, OAuth clients, Durable Object namespaces, R2 buckets,
session keys, and release-signing environments.

## Environment inventory

The initial test environment is:

- Worker: `nexus-edge-installer-staging`;
- canonical origin: `https://installer.francisconeto.net.br`;
- staging fallback: `https://nexus-edge-installer-staging.francisconeto.workers.dev` redirects to the canonical origin;
- OAuth client: `742459137762a85c561a53db69d1d515`, public with verified publisher domain `installer.francisconeto.net.br`;
- Wrangler file: `installer/worker/wrangler.jsonc`;
- private R2 bucket: `nexus-edge-releases-staging`;
- release channel: `stable` within that staging bucket.

Do not reuse the Core production token. The staging deployment credential needs
only Workers/DO management and write access to its R2 bucket. OAuth client
creation requires a user-level credential with OAuth Client Write. Store both
outside the repository and inject them only for the operation that needs them.

## First provisioning

1. Create the private R2 bucket and a private staging OAuth client.
2. Register exactly
   `https://installer.francisconeto.net.br/oauth/callback`.
3. Record the minimum approved scopes and capture Cloudflare's consent screen.
4. Generate an Ed25519 key pair in the release environment. Store the PKCS#8
   private key as `INSTALLER_RELEASE_PRIVATE_KEY_PKCS8_BASE64`; configure only
   the SPKI public key as `RELEASE_PUBLIC_KEY` in the Worker.
5. Generate independent 32-byte `SESSION_ENCRYPTION_KEY` values per environment.
6. Replace only the public placeholders in the environment's Wrangler config;
   inject `OAUTH_CLIENT_SECRET` and `SESSION_ENCRYPTION_KEY` as Worker secrets.
7. Run the full validation suite and deploy staging.
8. Verify `/health`, the CSP/security headers, OAuth redirect URI, and that
   R2 remains private.

Never put `.dev.vars`, `.env`, exported tokens, private signing keys, OAuth
client secrets, or session keys in a build artifact or Git commit.

## Publishing a signed release

Release tags run `.github/workflows/publish-installer-release.yml`. The workflow
uses Node 24, pnpm 11.19.0, the full mandatory validation suite, and a clean
lockfile. It builds a deterministic manifest, verifies the Ed25519 signature
locally, and uploads immutable objects first:

```bash
pnpm installer:release:build
pnpm installer:release:publish-objects
```

Promotion is a separate protected-environment job:

```bash
pnpm installer:release:promote
```

Approve promotion only after a clean-account canary installation has verified
D1, all migrations, Queue, DLQ, Worker/assets, Cron, consumer, `/health`,
`/api/v1/setup/status`, `/setup`, OAuth revocation, and first-plugin installation
through the Plugins screen with the dedicated runtime token. Confirm that the
initial installer never requests this token. Keep the canary report and
consent-screen capture as release evidence. `stable.json` is uploaded last.

Published version prefixes are immutable. A fix gets a new semantic version.

## Rollback

Rollback does not delete or rewrite a version. Rebuild a pointer that names a
previously approved manifest and signature, validate the hashes, and run the
same protected promotion job. An installation already in progress is pinned to
its recorded manifest hash and will stop if the pointer changes unexpectedly.
Never roll back customer D1 migrations automatically.

## OAuth client-secret rotation

1. Block new installer sessions or take the installer route offline.
2. Rotate the secret in the Cloudflare OAuth client.
3. update `OAUTH_CLIENT_SECRET` using the secret manager/Worker secret API;
4. deploy without changing the client ID or redirect URI;
5. complete a staging OAuth and cancellation test;
6. restore traffic and record the rotation time.

Existing installed Nexus instances are unaffected because they do not contain
the Techify OAuth client secret.

## Release-signing key rotation

1. Generate a new Ed25519 key pair and send the PKCS#8 private key directly to
   the `installer-release-build` environment secret. Never print or commit it.
2. Set its SPKI public key as `INSTALLER_RELEASE_PUBLIC_KEY_SPKI_BASE64` in the
   same GitHub environment and as the Worker's temporary
   `RELEASE_PUBLIC_KEY_NEXT` variable.
3. Deploy the Installer before promoting the first release signed by the new
   key. During this transition it accepts either configured public key.
4. Publish and verify a clean-account canary through the protected workflow.
5. In a later reviewed deployment, promote the new public key to
   `RELEASE_PUBLIC_KEY` and remove `RELEASE_PUBLIC_KEY_NEXT`.

## Security incident

1. Stop new sessions without touching installed customer Workers.
2. Revoke or rotate the affected OAuth client secret and deployment credentials.
3. Preserve sanitized event metadata only; do not collect customer tokens.
4. Remove a compromised release from the stable pointer and promote the last
   approved version.
5. Identify active installation IDs and let their one-hour sessions expire.
6. Tell affected users which Cloudflare authorization or dedicated token to
   revoke, without asking them to send its value.
7. Document scope, timestamps, public-key/signing-key impact, and corrective
   action before reopening the installer.

## Troubleshooting

- `OAUTH_CLIENT_NOT_CONFIGURED`: public OAuth placeholders remain or the wrong
  environment was deployed.
- `AUTHORIZATION_REQUIRED`: restart authorization; the state machine resumes at
  the recorded step and does not recreate completed resources.
- `PLUGIN_RUNTIME_CREDENTIAL_REQUIRED`: open Plugins, follow the automatic
  guided dialog and its account-specific Cloudflare link, then paste the token
  created with only Workers Scripts Edit for that account.
- `PLUGIN_RUNTIME_CREDENTIAL_INVALID` or
  `PLUGIN_RUNTIME_CREDENTIAL_TOO_BROAD`: verify the account resource and remove
  every permission except Workers Scripts Edit before trying again.
- `RELEASE_*` or `MIGRATION_HASH_MISMATCH`: stop. Check the signing key, public
  key, R2 objects, and immutable source migrations; do not bypass verification.
- `CUSTOM_DOMAIN_NOT_READY`: verify the reviewed hostname and zone in
  Cloudflare. Retry after TLS/DNS activation; do not attach a different domain.
- smoke-test failure: inspect the sanitized request ID and the customer-visible
  Worker health endpoints. Do not delete D1 or improvise a rollback.

For support, collect only the downloaded installation report. Its account ID is
masked and it contains no credentials.
