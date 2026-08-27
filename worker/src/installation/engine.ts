import type { InstallationSession } from "../durable-objects/InstallationSession.js";
import {
  CloudflareApiClient,
  CloudflareApiError,
  isAuthorizationFailure,
  isD1DatabaseLimitError,
} from "../cloudflare/client.js";
import { uploadCoreWorker } from "../cloudflare/deploy.js";
import {
  attachCustomDomain,
  configureQueueConsumer,
  configureSchedules,
  createDatabase,
  createQueue,
  enableWorkerSubdomain,
  ensureAccountSubdomain,
  listDatabases,
  listQueues,
} from "../cloudflare/resources.js";
import { readVerifiedRelease } from "../release/reader.js";
import { revokeAuthorization } from "../oauth/flow.js";
import type { SessionCapsule } from "../security/capsule.js";
import { sanitizedMessage } from "../security/redaction.js";
import {
  applyReleaseMigrations,
  releaseDatabaseSchemaVersion,
  synchronizeInstallationSettings,
} from "./migrations.js";
import { resourceNames } from "./names.js";
import { runPreflight } from "./preflight.js";
import type { InstallationError, InstallationState } from "./types.js";

type SessionStub = DurableObjectStub<InstallationSession>;

class AuthorizationExpiredError extends Error {
  constructor() {
    super("AUTHORIZATION_EXPIRED");
  }
}

function accessClient(
  capsule: SessionCapsule,
  requestId: string,
): CloudflareApiClient {
  if (
    !capsule.accessToken ||
    !capsule.accessTokenExpiresAt ||
    capsule.accessTokenExpiresAt <= Date.now() + 5_000
  )
    throw new AuthorizationExpiredError();
  return new CloudflareApiClient(capsule.accessToken, requestId);
}

function stepError(error: unknown, requestId: string): InstallationError {
  if (isD1DatabaseLimitError(error))
    return {
      code: "D1_DATABASE_LIMIT_REACHED",
      message:
        "This Cloudflare account has reached its D1 database limit. Delete only an unused test database, then try again.",
      requestId,
      retryable: true,
      status: error.status,
    };
  if (error instanceof CloudflareApiError)
    return {
      code: `CLOUDFLARE_${error.codes.join("_")}`.slice(0, 100),
      message: "Cloudflare rejected the installation step.",
      requestId,
      retryable: error.retryable,
      status: error.status,
    };
  const raw = error instanceof Error ? error.message.split(":", 1)[0]! : "";
  const code = /^[A-Z][A-Z0-9_]{2,99}$/u.test(raw)
    ? raw
    : "INSTALLATION_STEP_FAILED";
  return {
    code,
    message: sanitizedMessage(error),
    requestId,
    retryable: ![
      "MIGRATION_HASH_MISMATCH",
      "RELEASE_SIGNATURE_INVALID",
      "RELEASE_MANIFEST_HASH_MISMATCH",
      "RUNTIME_CREDENTIAL_PERMISSIONS_TOO_BROAD",
    ].includes(code),
  };
}

function withoutOauth(capsule: SessionCapsule): SessionCapsule {
  const {
    accessToken: _accessToken,
    accessTokenExpiresAt: _expires,
    grantedScope: _scope,
    oauthNonce: _nonce,
    oauthState: _state,
    pkceVerifier: _verifier,
    ...remaining
  } = capsule;
  return remaining;
}

function withoutRuntimeSecrets(capsule: SessionCapsule): SessionCapsule {
  const {
    coreSecrets: _coreSecrets,
    runtimeCredentialValue: _runtimeCredential,
    ...remaining
  } = capsule;
  return remaining;
}

async function boundedJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > 64_000) throw new Error("SMOKE_RESPONSE_TOO_LARGE");
  const text = (await response.text()).slice(0, 64_001);
  if (text.length > 64_000) throw new Error("SMOKE_RESPONSE_TOO_LARGE");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("SMOKE_RESPONSE_INVALID");
  }
}

async function endpointReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual" });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function smokeTest(
  baseUrl: string,
  release: Awaited<ReturnType<typeof readVerifiedRelease>>["release"],
): Promise<void> {
  let lastCode = "SMOKE_NOT_READY";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const healthResponse = await fetch(`${baseUrl}/health`, {
        redirect: "manual",
      });
      if (!healthResponse.ok)
        throw new Error(`SMOKE_HEALTH_HTTP_${healthResponse.status}`);
      const health = await boundedJson(healthResponse);
      if (
        health.ok !== true ||
        health.provider !== "d1" ||
        health.version !== release.appVersion
      )
        throw new Error("SMOKE_HEALTH_UNEXPECTED");
      const setupResponse = await fetch(`${baseUrl}/api/v1/setup/status`, {
        redirect: "manual",
      });
      if (!setupResponse.ok)
        throw new Error(`SMOKE_SETUP_HTTP_${setupResponse.status}`);
      const setup = await boundedJson(setupResponse);
      if (setup.state !== "open") throw new Error("SMOKE_SETUP_NOT_OPEN");
      const indexResponse = await fetch(baseUrl, { redirect: "manual" });
      if (!indexResponse.ok)
        throw new Error(`SMOKE_ASSETS_HTTP_${indexResponse.status}`);
      await indexResponse.body?.cancel();
      const javascriptAsset = release.assets.find(
        (asset) =>
          asset.path.toLowerCase().endsWith(".js") ||
          asset.path.toLowerCase().endsWith(".mjs"),
      );
      if (!javascriptAsset) throw new Error("SMOKE_SCRIPT_ASSET_MISSING");
      const scriptResponse = await fetch(`${baseUrl}/${javascriptAsset.path}`, {
        redirect: "manual",
      });
      if (!scriptResponse.ok)
        throw new Error(`SMOKE_SCRIPT_HTTP_${scriptResponse.status}`);
      const contentType =
        scriptResponse.headers.get("Content-Type")?.split(";", 1)[0] ?? "";
      await scriptResponse.body?.cancel();
      if (
        contentType !== "text/javascript" &&
        contentType !== "application/javascript"
      )
        throw new Error("SMOKE_SCRIPT_MIME_INVALID");
      return;
    } catch (error) {
      lastCode = error instanceof Error ? error.message : "SMOKE_NOT_READY";
      if (attempt < 7)
        await new Promise((resolve) =>
          setTimeout(resolve, 400 * 2 ** Math.min(attempt, 3)),
        );
    }
  }
  throw new Error(lastCode);
}

async function verifiedReleaseForState(env: Env, state: InstallationState) {
  const verified = await readVerifiedRelease(env);
  if (
    state.releaseManifestHash &&
    state.releaseManifestHash !== verified.manifestHash
  )
    throw new Error("INSTALLATION_RELEASE_CHANGED");
  return verified;
}

export type StepResult = {
  state: InstallationState;
  capsule: SessionCapsule;
  nextDelayMs?: number;
};

export async function executeNextStep(
  env: Env,
  stub: SessionStub,
  browserBindingHash: string,
  capsuleInput: SessionCapsule,
  requestId: string,
): Promise<StepResult> {
  let capsule = capsuleInput;
  const lease = await stub.beginStep(browserBindingHash);
  if (!lease.acquired || !lease.leaseId) return { state: lease.state, capsule };
  let state = lease.state;
  const leaseId = lease.leaseId;
  try {
    if (state.status === "configured") {
      const client = accessClient(capsule, requestId);
      let preflight: { accountSubdomain: string } | undefined;
      for (
        let collisionAttempt = 0;
        collisionAttempt < 5;
        collisionAttempt += 1
      ) {
        try {
          preflight = await runPreflight(client, state);
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "RESOURCE_NAME_COLLISION"
          )
            throw error;
          state = await stub.replaceNames(browserBindingHash, resourceNames());
        }
      }
      if (!preflight) throw new Error("RESOURCE_NAME_COLLISION");
      state = await stub.completeStep(
        browserBindingHash,
        leaseId,
        "preflight_complete",
        { resources: { accountSubdomain: preflight.accountSubdomain } },
      );
    } else if (state.status === "preflight_complete") {
      accessClient(capsule, requestId);
      const verified = await readVerifiedRelease(env);
      state = await stub.completeStep(
        browserBindingHash,
        leaseId,
        "release_verified",
        {
          releaseVersion: verified.release.appVersion,
          releaseManifestHash: verified.manifestHash,
        },
      );
    } else if (state.status === "release_verified") {
      const client = accessClient(capsule, requestId);
      const configuration = state.configuration!;
      const existing = (
        await listDatabases(client, configuration.accountId)
      ).find((database) => database.name === state.names.database);
      const database =
        existing ??
        (await createDatabase(
          client,
          configuration.accountId,
          state.names.database,
        ));
      state = await stub.completeStep(
        browserBindingHash,
        leaseId,
        "d1_created",
        {
          resources: { databaseId: database.uuid },
        },
      );
    } else if (state.status === "d1_created") {
      const client = accessClient(capsule, requestId);
      const verified = await verifiedReleaseForState(env, state);
      await applyReleaseMigrations(
        env,
        client,
        state.configuration!.accountId,
        state.resources.databaseId!,
        state.installationId,
        verified.release,
      );
      state = await stub.completeStep(
        browserBindingHash,
        leaseId,
        "migrations_applied",
      );
    } else if (state.status === "migrations_applied") {
      const client = accessClient(capsule, requestId);
      const accountId = state.configuration!.accountId;
      const existing = await listQueues(client, accountId);
      const deadLetterQueue =
        existing.find(
          (queue) => queue.queue_name === state.names.deadLetterQueue,
        ) ??
        (await createQueue(client, accountId, state.names.deadLetterQueue));
      const mainQueue =
        existing.find((queue) => queue.queue_name === state.names.queue) ??
        (await createQueue(client, accountId, state.names.queue));
      state = await stub.completeStep(
        browserBindingHash,
        leaseId,
        "queues_created",
        {
          resources: {
            queueId: mainQueue.queue_id,
            deadLetterQueueId: deadLetterQueue.queue_id,
          },
        },
      );
    } else if (state.status === "queues_created") {
      // The permanent Workers Scripts credential is only needed when an
      // administrator installs the first plugin. Keep the initial install
      // independent from that credential and onboard it inside the Core UI.
      state = await stub.completeStep(
        browserBindingHash,
        leaseId,
        "runtime_token_created",
      );
    } else if (state.status === "runtime_token_created") {
      const client = accessClient(capsule, requestId);
      const configuration = state.configuration!;
      const verified = await verifiedReleaseForState(env, state);
      const requestedSubdomain = state.resources.accountSubdomain;
      if (!requestedSubdomain) throw new Error("ACCOUNT_SUBDOMAIN_UNAVAILABLE");
      const accountSubdomain = await ensureAccountSubdomain(
        client,
        configuration.accountId,
        requestedSubdomain,
      );
      const finalUrl =
        configuration.addressMode === "custom_domain"
          ? `https://${configuration.customHostname}`
          : `https://${state.names.worker}.${accountSubdomain}.workers.dev`;
      if (!capsule.coreSecrets) throw new Error("RUNTIME_SECRETS_MISSING");
      const uploaded = await uploadCoreWorker(env, client, verified.release, {
        accountId: configuration.accountId,
        databaseId: state.resources.databaseId!,
        queueName: state.names.queue,
        workerName: state.names.worker,
        installationId: state.installationId,
        finalUrl,
        betterAuthSecret: capsule.coreSecrets.betterAuthSecret,
        webhookEncryptionKey: capsule.coreSecrets.webhookEncryptionKey,
      });
      state = await stub.completeStep(
        browserBindingHash,
        leaseId,
        "worker_uploaded",
        {
          finalUrl,
          resources: {
            accountSubdomain,
            ...(uploaded.etag ? { workerEtag: uploaded.etag } : {}),
            ...(uploaded.versionId
              ? { workerVersionId: uploaded.versionId }
              : {}),
          },
        },
      );
      capsule = withoutRuntimeSecrets(capsule);
    } else if (state.status === "worker_uploaded") {
      const client = accessClient(capsule, requestId);
      await enableWorkerSubdomain(
        client,
        state.configuration!.accountId,
        state.names.worker,
      );
      state = await stub.completeStep(
        browserBindingHash,
        leaseId,
        "worker_route_enabled",
      );
    } else if (state.status === "worker_route_enabled") {
      const client = accessClient(capsule, requestId);
      const release = await verifiedReleaseForState(env, state);
      await configureSchedules(
        client,
        state.configuration!.accountId,
        state.names.worker,
        release.release.cron,
      );
      state = await stub.completeStep(
        browserBindingHash,
        leaseId,
        "cron_configured",
      );
    } else if (state.status === "cron_configured") {
      const client = accessClient(capsule, requestId);
      const queues = await listQueues(client, state.configuration!.accountId);
      const queue = queues.find(
        (item) => item.queue_id === state.resources.queueId,
      );
      if (!queue)
        throw new Error("QUEUE_NOT_FOUND_DURING_CONSUMER_CONFIGURATION");
      await configureQueueConsumer(
        client,
        state.configuration!.accountId,
        queue,
        state.names.worker,
        state.names.deadLetterQueue,
      );
      state = await stub.completeStep(
        browserBindingHash,
        leaseId,
        "queue_consumer_configured",
      );
    } else if (state.status === "queue_consumer_configured") {
      const configuration = state.configuration!;
      if (configuration.addressMode === "custom_domain") {
        const client = accessClient(capsule, requestId);
        await attachCustomDomain(
          client,
          configuration.accountId,
          state.names.worker,
          configuration.customHostname!,
          configuration.zoneId!,
        );
        state = await stub.completeStep(
          browserBindingHash,
          leaseId,
          "waiting_for_domain",
        );
        return { state, capsule, nextDelayMs: 5_000 };
      }
      state = await stub.completeStep(
        browserBindingHash,
        leaseId,
        "custom_domain_attached",
      );
    } else if (state.status === "waiting_for_domain") {
      accessClient(capsule, requestId);
      if (await endpointReady(`${state.finalUrl}/health`)) {
        state = await stub.completeStep(
          browserBindingHash,
          leaseId,
          "custom_domain_attached",
        );
      } else if ((state.attempts.waiting_for_domain ?? 0) < 20) {
        state = await stub.completeStep(
          browserBindingHash,
          leaseId,
          "waiting_for_domain",
        );
        return { state, capsule, nextDelayMs: 10_000 };
      } else {
        throw new Error("CUSTOM_DOMAIN_NOT_READY");
      }
    } else if (state.status === "custom_domain_attached") {
      const client = accessClient(capsule, requestId);
      const release = await verifiedReleaseForState(env, state);
      await synchronizeInstallationSettings(
        client,
        state.configuration!.accountId,
        state.resources.databaseId!,
        state.installationId,
        releaseDatabaseSchemaVersion(release.release),
      );
      await smokeTest(state.finalUrl!, release.release);
      state = await stub.completeStep(
        browserBindingHash,
        leaseId,
        "health_verified",
      );
    } else if (state.status === "health_verified") {
      const accessToken = capsule.accessToken;
      if (!accessToken) throw new AuthorizationExpiredError();
      await revokeAuthorization(env, accessToken);
      capsule = withoutOauth(capsule);
      state = await stub.completeStep(
        browserBindingHash,
        leaseId,
        "oauth_revoked",
      );
    } else if (state.status === "oauth_revoked") {
      capsule = withoutOauth(withoutRuntimeSecrets(capsule));
      state = await stub.completeStep(browserBindingHash, leaseId, "completed");
    } else {
      throw new Error("INSTALLATION_STEP_NOT_AVAILABLE");
    }
    return { state, capsule };
  } catch (error) {
    const authorizationRequired =
      error instanceof AuthorizationExpiredError ||
      isAuthorizationFailure(error);
    state = await stub.failStep(
      browserBindingHash,
      leaseId,
      stepError(error, requestId),
      authorizationRequired,
    );
    return { state, capsule };
  }
}
