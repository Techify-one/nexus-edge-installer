import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const testSessionKey = "dGVzdC1zZXNzaW9uLWtleS0zMi1ieXRlcy0xMjM0NTY";
process.env.OAUTH_CLIENT_SECRET ??= "test-oauth-secret";
process.env.SESSION_ENCRYPTION_KEY ??= testSessionKey;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          INSTALLER_ORIGIN: "https://installer.test",
          OAUTH_CLIENT_ID: "test-oauth-client",
          OAUTH_CLIENT_SECRET: "test-oauth-secret",
          OAUTH_REDIRECT_URI: "https://installer.test/oauth/callback",
          OAUTH_SCOPES: "account:read workers:write d1:write queues:write",
          SESSION_ENCRYPTION_KEY: testSessionKey,
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
