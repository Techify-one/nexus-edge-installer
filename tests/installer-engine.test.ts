import { afterEach, describe, expect, it, vi } from "vitest";
import { executeNextStep } from "../installer/worker/src/installation/engine.js";
import type { InstallationState } from "../installer/worker/src/installation/types.js";
import type { SessionCapsule } from "../installer/worker/src/security/capsule.js";

describe("installer provisioning engine", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defers the limited token until the first plugin installation", async () => {
    const state: InstallationState = {
      installationId: "install_abcdefghijklmnopqrstuvwxyz",
      browserBindingHash: "browser-binding-hash",
      status: "queues_created",
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 60_000,
      leaseId: "lease-id",
      leaseUntil: Date.now() + 45_000,
      configuration: {
        accountId: "a".repeat(32),
        accountName: "Test account",
        displayName: "Nexus Edge",
        addressMode: "workers_dev",
      },
      names: {
        worker: "nexus-test",
        database: "nexus-test-db",
        queue: "nexus-test-queue",
        deadLetterQueue: "nexus-test-dlq",
      },
      resources: {
        databaseId: "database-id",
        queueId: "queue-id",
        deadLetterQueueId: "dlq-id",
      },
      attempts: { queues_created: 1 },
    };
    const advanced: InstallationState = {
      ...state,
      status: "runtime_token_created",
    };
    const stub = {
      beginStep: vi.fn().mockResolvedValue({
        acquired: true,
        leaseId: "lease-id",
        state,
      }),
      completeStep: vi.fn().mockResolvedValue(advanced),
    };
    const capsule: SessionCapsule = {
      version: 1,
      installationId: state.installationId,
      browserBinding: "browser-binding",
      csrfToken: "csrf-token",
      expiresAt: Date.now() + 60_000,
      accessToken: "temporary-oauth-access-token",
      accessTokenExpiresAt: Date.now() + 60_000,
    };

    const result = await executeNextStep(
      {} as Env,
      stub as never,
      state.browserBindingHash,
      capsule,
      "request-id",
    );

    expect(result.state.status).toBe("runtime_token_created");
    expect(stub.completeStep).toHaveBeenCalledWith(
      state.browserBindingHash,
      "lease-id",
      "runtime_token_created",
    );
  });

  it("reports the D1 account limit as retryable instead of requesting OAuth again", async () => {
    const state: InstallationState = {
      installationId: "install_abcdefghijklmnopqrstuvwxyz",
      browserBindingHash: "browser-binding-hash",
      status: "release_verified",
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 60_000,
      leaseId: "lease-id",
      leaseUntil: Date.now() + 45_000,
      configuration: {
        accountId: "a".repeat(32),
        accountName: "Test account",
        displayName: "Nexus Edge",
        addressMode: "workers_dev",
      },
      names: {
        worker: "nexus-test",
        database: "nexus-test-db",
        queue: "nexus-test-queue",
        deadLetterQueue: "nexus-test-dlq",
      },
      resources: {},
      attempts: { release_verified: 1 },
    };
    const failed: InstallationState = {
      ...state,
      status: "failed",
      resumeStatus: "release_verified",
      error: {
        code: "D1_DATABASE_LIMIT_REACHED",
        message: "limit reached",
        requestId: "request-id",
        retryable: true,
        status: 403,
      },
    };
    const stub = {
      beginStep: vi.fn().mockResolvedValue({
        acquired: true,
        leaseId: "lease-id",
        state,
      }),
      failStep: vi.fn().mockResolvedValue(failed),
    };
    const capsule: SessionCapsule = {
      version: 1,
      installationId: state.installationId,
      browserBinding: "browser-binding",
      csrfToken: "csrf-token",
      expiresAt: Date.now() + 60_000,
      accessToken: "temporary-oauth-access-token",
      accessTokenExpiresAt: Date.now() + 60_000,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ success: true, result: [] }))
      .mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            result: null,
            errors: [
              {
                code: 7406,
                message: "System limit reached: databases per account (10)",
              },
            ],
          },
          { status: 403 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeNextStep(
      {} as Env,
      stub as never,
      state.browserBindingHash,
      capsule,
      "request-id",
    );

    expect(result.state.status).toBe("failed");
    expect(stub.failStep).toHaveBeenCalledWith(
      state.browserBindingHash,
      "lease-id",
      expect.objectContaining({
        code: "D1_DATABASE_LIMIT_REACHED",
        retryable: true,
        status: 403,
      }),
      false,
    );
  });

  it("waits for a workers.dev address before running the smoke test", async () => {
    const state: InstallationState = {
      installationId: "install_abcdefghijklmnopqrstuvwxyz",
      browserBindingHash: "browser-binding-hash",
      status: "queue_consumer_configured",
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 60_000,
      leaseId: "lease-id",
      leaseUntil: Date.now() + 45_000,
      configuration: {
        accountId: "a".repeat(32),
        accountName: "Test account",
        displayName: "Nexus Edge",
        addressMode: "workers_dev",
      },
      names: {
        worker: "nexus-test",
        database: "nexus-test-db",
        queue: "nexus-test-queue",
        deadLetterQueue: "nexus-test-dlq",
      },
      resources: {
        databaseId: "database-id",
        queueId: "queue-id",
        deadLetterQueueId: "dlq-id",
      },
      finalUrl: "https://nexus-test.example.workers.dev",
      attempts: { queue_consumer_configured: 1 },
    };
    const waiting: InstallationState = {
      ...state,
      status: "waiting_for_domain",
    };
    const stub = {
      beginStep: vi.fn().mockResolvedValue({
        acquired: true,
        leaseId: "lease-id",
        state,
      }),
      completeStep: vi.fn().mockResolvedValue(waiting),
    };
    const capsule: SessionCapsule = {
      version: 1,
      installationId: state.installationId,
      browserBinding: "browser-binding",
      csrfToken: "csrf-token",
      expiresAt: Date.now() + 60_000,
      accessToken: "temporary-oauth-access-token",
      accessTokenExpiresAt: Date.now() + 60_000,
    };

    const result = await executeNextStep(
      {} as Env,
      stub as never,
      state.browserBindingHash,
      capsule,
      "request-id",
    );

    expect(result.state.status).toBe("waiting_for_domain");
    expect(result.nextDelayMs).toBe(5_000);
    expect(stub.completeStep).toHaveBeenCalledWith(
      state.browserBindingHash,
      "lease-id",
      "waiting_for_domain",
    );
  });

  it("keeps a workers.dev installation pending while health returns 404", async () => {
    const state: InstallationState = {
      installationId: "install_abcdefghijklmnopqrstuvwxyz",
      browserBindingHash: "browser-binding-hash",
      status: "waiting_for_domain",
      createdAt: 1,
      updatedAt: 1,
      expiresAt: Date.now() + 60_000,
      leaseId: "lease-id",
      leaseUntil: Date.now() + 45_000,
      configuration: {
        accountId: "a".repeat(32),
        accountName: "Test account",
        displayName: "Nexus Edge",
        addressMode: "workers_dev",
      },
      names: {
        worker: "nexus-test",
        database: "nexus-test-db",
        queue: "nexus-test-queue",
        deadLetterQueue: "nexus-test-dlq",
      },
      resources: {
        databaseId: "database-id",
        queueId: "queue-id",
        deadLetterQueueId: "dlq-id",
      },
      finalUrl: "https://nexus-test.example.workers.dev",
      attempts: { waiting_for_domain: 1 },
    };
    const stub = {
      beginStep: vi.fn().mockResolvedValue({
        acquired: true,
        leaseId: "lease-id",
        state,
      }),
      completeStep: vi.fn().mockResolvedValue(state),
    };
    const capsule: SessionCapsule = {
      version: 1,
      installationId: state.installationId,
      browserBinding: "browser-binding",
      csrfToken: "csrf-token",
      expiresAt: Date.now() + 60_000,
      accessToken: "temporary-oauth-access-token",
      accessTokenExpiresAt: Date.now() + 60_000,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );

    const result = await executeNextStep(
      {} as Env,
      stub as never,
      state.browserBindingHash,
      capsule,
      "request-id",
    );

    expect(result.state.status).toBe("waiting_for_domain");
    expect(result.nextDelayMs).toBe(10_000);
    expect(stub.completeStep).toHaveBeenCalledWith(
      state.browserBindingHash,
      "lease-id",
      "waiting_for_domain",
    );
  });
});
