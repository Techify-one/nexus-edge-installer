/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { InstallationState } from "../src/installation/types.js";

function initialState(
  installationId = `install_${crypto.randomUUID().replaceAll("-", "")}`,
  createdAt = Date.now(),
): InstallationState {
  return {
    installationId,
    browserBindingHash: "binding-hash",
    status: "created",
    createdAt,
    updatedAt: createdAt,
    expiresAt: createdAt + 3_600_000,
    names: {
      worker: "nexus-test-worker",
      database: "nexus-test-db",
      queue: "nexus-test-queue",
      deadLetterQueue: "nexus-test-dlq",
    },
    resources: {},
    attempts: {},
  };
}

describe("installer Worker", () => {
  it("redirects alternate hosts to the canonical installer origin", async () => {
    const worker = await import("../src/index.js");
    const response = await worker.default.fetch(
      new Request("https://alternate.test/path?source=workers-dev"),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(
      "https://installer.test/path?source=workers-dev",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("serves health with hardened response headers", async () => {
    const worker = await import("../src/index.js");
    const responseFromWorker = await worker.default.fetch(
      new Request("https://installer.test/health"),
      env,
      {} as ExecutionContext,
    );
    expect(responseFromWorker.status).toBe(200);
    await expect(responseFromWorker.json()).resolves.toMatchObject({
      ok: true,
      service: "nexus-edge-installer",
      environment: "staging",
    });
    expect(responseFromWorker.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(responseFromWorker.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("adds hardened headers to immutable static asset responses", async () => {
    const worker = await import("../src/index.js");
    const response = await worker.default.fetch(
      new Request("https://installer.test/"),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("rejects cross-origin mutations before creating a session", async () => {
    const worker = await import("../src/index.js");
    const response = await worker.default.fetch(
      new Request("https://installer.test/api/oauth/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.test",
        },
        body: "{}",
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_ORIGIN" },
    });
  });

  it("returns the encrypted HttpOnly session cookie on OAuth start", async () => {
    const worker = await import("../src/index.js");
    const response = await worker.default.fetch(
      new Request("https://installer.test/api/oauth/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://installer.test",
        },
        body: "{}",
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Set-Cookie")).toMatch(
      /^__Host-nexus_installer_session=.*HttpOnly; Secure; SameSite=Lax$/u,
    );
    await expect(response.json()).resolves.toMatchObject({
      authorizationUrl: expect.stringContaining(
        "https://dash.cloudflare.com/oauth2/auth",
      ),
    });
  });
});

describe("InstallationSession Durable Object", () => {
  it("isolates access and grants a single concurrent step lease", async () => {
    const stub = env.INSTALLATION_SESSION.getByName(crypto.randomUUID());
    await stub.initialize(initialState());
    const denied = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.getState("different-binding");
        return "unexpected-success";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown-error";
      }
    });
    expect(denied).toBe("SESSION_ACCESS_DENIED");

    const [first, second] = await Promise.all([
      stub.beginStep("binding-hash", 1_000),
      stub.beginStep("binding-hash", 1_000),
    ]);
    expect([first.acquired, second.acquired].filter(Boolean)).toHaveLength(1);
  });

  it("refuses to persist sensitive fields", async () => {
    const stub = env.INSTALLATION_SESSION.getByName(crypto.randomUUID());
    const unsafe = {
      ...initialState(),
      accessToken: "must-never-be-stored",
    } as InstallationState;
    const denied = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.initialize(unsafe);
        return "unexpected-success";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown-error";
      }
    });
    expect(denied).toContain("Forbidden sensitive state field");
  });

  it("persists official token-named statuses in the attempts map", async () => {
    const stub = env.INSTALLATION_SESSION.getByName(crypto.randomUUID());
    await stub.initialize(initialState());

    const firstLease = await stub.beginStep("binding-hash");
    expect(firstLease).toMatchObject({ acquired: true });
    await stub.completeStep(
      "binding-hash",
      firstLease.leaseId!,
      "runtime_token_created",
    );

    const workerUploadLease = await stub.beginStep("binding-hash");
    expect(workerUploadLease).toMatchObject({
      acquired: true,
      state: {
        status: "runtime_token_created",
        attempts: { runtime_token_created: 1 },
      },
    });
  });

  it("deletes expired session metadata when its alarm runs", async () => {
    const stub = env.INSTALLATION_SESSION.getByName(crypto.randomUUID());
    await stub.initialize(initialState());
    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ state_json: string }>(
          "SELECT state_json FROM installation_state WHERE id = 1",
        )
        .toArray();
      const stored = JSON.parse(rows[0]!.state_json) as InstallationState;
      stored.expiresAt = Date.now() - 1;
      state.storage.sql.exec(
        "UPDATE installation_state SET state_json = ? WHERE id = 1",
        JSON.stringify(stored),
      );
      await state.storage.setAlarm(Date.now() + 1_000);
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    const missing = await runInDurableObject(stub, async (instance) => {
      try {
        await instance.getState("binding-hash");
        return "unexpected-success";
      } catch (error) {
        return error instanceof Error ? error.message : "unknown-error";
      }
    });
    expect(missing).toBe("INSTALLATION_NOT_FOUND");
  });
});
