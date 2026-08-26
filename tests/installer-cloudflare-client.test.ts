import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareApiClient } from "../installer/worker/src/cloudflare/client.js";
import {
  ensureAccountSubdomain,
  queryDatabase,
} from "../installer/worker/src/cloudflare/resources.js";
import { runPreflight } from "../installer/worker/src/installation/preflight.js";
import type { InstallationState } from "../installer/worker/src/installation/types.js";

describe("installer Cloudflare D1 client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps multiple D1 statements in the REST API batch property", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        result: [{ success: true }, { success: true }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new CloudflareApiClient("test-token", "request-id");
    const queries = [
      { sql: "CREATE TABLE example (id INTEGER PRIMARY KEY)" },
      { sql: "INSERT INTO example (id) VALUES (?)", params: [1] },
    ];

    await queryDatabase(client, "a".repeat(32), "database-id", queries);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/d1/database/database-id/query`,
    );
    expect(JSON.parse(String(init.body))).toEqual({ batch: queries });
  });

  it("keeps a single D1 statement as a single query object", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ success: true, result: [{ success: true }] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new CloudflareApiClient("test-token", "request-id");
    const query = { sql: "SELECT 1" };

    await queryDatabase(client, "a".repeat(32), "database-id", query);

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(query);
  });

  it("treats a missing workers.dev account subdomain as preflight-ready without creating it", async () => {
    const accountId = "a".repeat(32);
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/workers/subdomain"))
        return Response.json(
          {
            success: false,
            result: null,
            errors: [{ code: 10007, message: "not found" }],
          },
          { status: 404 },
        );
      if (url.includes("/d1/database") || url.includes("/queues"))
        return Response.json({ success: true, result: [] });
      if (url.endsWith("/workers/scripts"))
        return Response.json({ success: true, result: [] });
      if (url.includes("/accounts?"))
        return Response.json({
          success: true,
          result: [{ id: accountId, name: "Test account" }],
        });
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const state: InstallationState = {
      installationId: "install_abcdefghijklmnopqrstuvwxyz",
      browserBindingHash: "browser-binding-hash",
      status: "configured",
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 60_000,
      configuration: {
        accountId,
        accountName: "Test account",
        displayName: "Nexus Edge",
        addressMode: "workers_dev",
      },
      names: {
        worker: "nexus-test-worker",
        database: "nexus-test-db",
        queue: "nexus-test-queue",
        deadLetterQueue: "nexus-test-dlq",
      },
      resources: {},
      attempts: {},
    };

    await expect(
      runPreflight(new CloudflareApiClient("oauth-token", "request-id"), state),
    ).resolves.toEqual({ accountSubdomain: state.names.worker });
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
    ).toBe(false);
  });

  it("creates a missing workers.dev account subdomain idempotently", async () => {
    const accountId = "a".repeat(32);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            result: null,
            errors: [{ code: 10007, message: "not found" }],
          },
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: { subdomain: "nexus-test-worker" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      ensureAccountSubdomain(
        new CloudflareApiClient("oauth-token", "request-id"),
        accountId,
        "nexus-test-worker",
      ),
    ).resolves.toBe("nexus-test-worker");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(url.pathname).toBe(
      `/client/v4/accounts/${accountId}/workers/subdomain`,
    );
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      subdomain: "nexus-test-worker",
    });
  });
});
