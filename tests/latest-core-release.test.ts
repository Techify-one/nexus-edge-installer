import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  installerReleaseSchema,
  stableReleasePointerSchema,
  type InstallerRelease,
} from "@app/installer-release-schema";
import { readVerifiedRelease } from "../worker/src/release/reader.js";

function signedRelease(version: string, sourceCommit: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const release = installerReleaseSchema.parse({
    schemaVersion: 1,
    appVersion: version,
    sourceCommit,
    createdAt: "2026-09-12T00:00:00.000Z",
    compatibilityDate: "2026-09-12",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "index.js",
    modules: [
      {
        path: "index.js",
        objectKey: `releases/${version}/modules/core`,
        mimeType: "application/javascript+module",
        size: 1,
        sha256: "a".repeat(64),
      },
    ],
    assets: [
      {
        path: "index.html",
        objectKey: `releases/${version}/assets/index`,
        mimeType: "text/html",
        size: 1,
        sha256: "b".repeat(64),
        uploadHash: "c".repeat(32),
      },
    ],
    d1Migrations: [
      {
        id: "0001_init",
        path: "migrations/d1/0001_init.json",
        objectKey: `releases/${version}/migrations/d1/0001_init.json`,
        mimeType: "application/json",
        size: 1,
        sha256: "d".repeat(64),
        statementCount: 1,
      },
    ],
    databaseSchemaVersion: 1,
    requiredBindings: ["ASSETS", "DB", "WEBHOOK_QUEUE"],
    cron: ["* * * * *"],
    healthChecks: ["/health", "/api/v1/setup/status"],
    minimumInstallerVersion: "1.0.0",
  }) satisfies InstallerRelease;
  const canonical = canonicalJson(release);
  const digest = createHash("sha256").update(canonical).digest();
  const signature = sign(null, digest, privateKey).toString("base64");
  const publicKeyBase64 = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const pointer = stableReleasePointerSchema.parse({
    schemaVersion: 1,
    channel: "stable",
    version,
    manifestObjectKey: `releases/${version}/release.json`,
    manifestSha256: digest.toString("hex"),
    signatureObjectKey: `releases/${version}/release.sig`,
    updatedAt: release.createdAt,
  });
  return { canonical, pointer, publicKeyBase64, release, signature };
}

describe("latest signed Core release", () => {
  it("resolves the stable pointer for every new installation instead of caching a version", async () => {
    let current = signedRelease("1.1.0-beta.8", "a".repeat(40));
    const object = (body: string) => ({
      size: new TextEncoder().encode(body).byteLength,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    });
    const bucket = {
      get: async (key: string) => {
        if (key === "releases/stable.json")
          return object(JSON.stringify(current.pointer));
        if (key === current.pointer.manifestObjectKey)
          return object(current.canonical);
        if (key === current.pointer.signatureObjectKey)
          return object(current.signature);
        return null;
      },
    };
    const env = {
      RELEASES: bucket,
      RELEASE_CHANNEL: "stable",
      RELEASE_PUBLIC_KEY: current.publicKeyBase64,
      RELEASE_PUBLIC_KEY_NEXT: "",
      INSTALLER_VERSION: "1.0.1",
    } as unknown as Env;

    await expect(readVerifiedRelease(env)).resolves.toMatchObject({
      release: { appVersion: "1.1.0-beta.8" },
    });

    current = signedRelease("1.1.0-beta.9", "b".repeat(40));
    Object.assign(env, { RELEASE_PUBLIC_KEY: current.publicKeyBase64 });

    await expect(readVerifiedRelease(env)).resolves.toMatchObject({
      release: { appVersion: "1.1.0-beta.9" },
    });
  });
});
