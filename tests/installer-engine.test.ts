import { describe, expect, it, vi } from "vitest";
import { executeNextStep } from "../installer/worker/src/installation/engine.js";
import type { InstallationState } from "../installer/worker/src/installation/types.js";
import type { SessionCapsule } from "../installer/worker/src/security/capsule.js";

describe("installer provisioning engine", () => {
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
});
