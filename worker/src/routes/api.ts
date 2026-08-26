import { Hono } from "hono";
import { z } from "zod";
import { CloudflareApiClient } from "../cloudflare/client.js";
import {
  listAccounts,
  listZones,
  revokeRuntimeCredential,
} from "../cloudflare/resources.js";
import type { InstallationSession } from "../durable-objects/InstallationSession.js";
import { executeNextStep } from "../installation/engine.js";
import { installationId, resourceNames } from "../installation/names.js";
import type {
  InstallationConfiguration,
  InstallationState,
} from "../installation/types.js";
import {
  exchangeAuthorizationCode,
  prepareAuthorization,
  revokeAuthorization,
} from "../oauth/flow.js";
import { readVerifiedRelease } from "../release/reader.js";
import {
  newCapsule,
  openCapsule,
  sealCapsule,
  type SessionCapsule,
} from "../security/capsule.js";
import { sha256Hex, timingSafeEqual } from "../security/encoding.js";
import {
  assertJsonRequest,
  assertMutationOrigin,
  expiredSessionCookie,
  readCookie,
  sessionCookie,
  sessionCookieName,
} from "../security/http.js";

type InstallerHonoEnv = { Bindings: Env };
type SessionContext = {
  capsule: SessionCapsule;
  browserBindingHash: string;
  stub: DurableObjectStub<InstallationSession>;
};

const installationIdSchema = z
  .string()
  .regex(/^install_[A-Za-z0-9_-]{20,80}$/u);
const configureSchema = z
  .object({
    accountId: z.string().regex(/^[a-f0-9]{32}$/u),
    displayName: z.string().trim().min(2).max(80),
    addressMode: z.enum(["workers_dev", "custom_domain"]),
    zoneId: z
      .string()
      .regex(/^[a-f0-9]{32}$/u)
      .optional(),
    customHostname: z.string().trim().toLowerCase().max(253).optional(),
  })
  .strict();
function isHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    value
      .split(".")
      .every(
        (label) =>
          label.length >= 1 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  );
}

function requestId(request: Request): string {
  return request.headers.get("CF-Ray")?.split("-", 1)[0] ?? crypto.randomUUID();
}

function sessionTtl(env: Env): number {
  return Number(env.SESSION_TTL_SECONDS);
}

async function capsuleCookie(
  env: Env,
  capsule: SessionCapsule,
): Promise<string> {
  const ttl = sessionTtl(env);
  capsule.expiresAt = Date.now() + ttl * 1_000;
  return sessionCookie(
    await sealCapsule(capsule, env.SESSION_ENCRYPTION_KEY),
    ttl,
  );
}

async function session(request: Request, env: Env): Promise<SessionContext> {
  const cookie = readCookie(request, sessionCookieName);
  if (!cookie) throw new ApiError("SESSION_REQUIRED", 401);
  let capsule: SessionCapsule;
  try {
    capsule = await openCapsule(cookie, env.SESSION_ENCRYPTION_KEY);
  } catch {
    throw new ApiError("SESSION_INVALID_OR_EXPIRED", 401);
  }
  const browserBindingHash = await sha256Hex(capsule.browserBinding);
  return {
    capsule,
    browserBindingHash,
    stub: env.INSTALLATION_SESSION.getByName(capsule.installationId),
  };
}

function assertPathInstallation(capsule: SessionCapsule, value: string): void {
  if (
    !installationIdSchema.safeParse(value).success ||
    !timingSafeEqual(capsule.installationId, value)
  )
    throw new ApiError("INSTALLATION_ACCESS_DENIED", 403);
}

function assertCsrf(request: Request, capsule: SessionCapsule, env: Env): void {
  assertMutationOrigin(request, env.INSTALLER_ORIGIN);
  assertJsonRequest(request);
  const supplied = request.headers.get("X-CSRF-Token") ?? "";
  if (!timingSafeEqual(capsule.csrfToken, supplied))
    throw new ApiError("CSRF_VALIDATION_FAILED", 403);
}

function accessClient(
  capsule: SessionCapsule,
  request: Request,
): CloudflareApiClient {
  if (
    !capsule.accessToken ||
    !capsule.accessTokenExpiresAt ||
    capsule.accessTokenExpiresAt <= Date.now()
  )
    throw new ApiError("AUTHORIZATION_REQUIRED", 401);
  return new CloudflareApiClient(capsule.accessToken, requestId(request));
}

function publicState(
  state: InstallationState,
): Omit<InstallationState, "browserBindingHash" | "leaseId" | "leaseUntil"> {
  const {
    browserBindingHash: _binding,
    leaseId: _leaseId,
    leaseUntil: _leaseUntil,
    ...safe
  } = state;
  return safe;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export const api = new Hono<InstallerHonoEnv>();

api.get("/releases/stable", async (context) => {
  const verified = await readVerifiedRelease(context.env);
  return context.json({
    version: verified.release.appVersion,
    sourceCommit: verified.release.sourceCommit,
    createdAt: verified.release.createdAt,
    manifestHash: verified.manifestHash,
  });
});

api.post("/oauth/start", async (context) => {
  assertMutationOrigin(context.req.raw, context.env.INSTALLER_ORIGIN);
  assertJsonRequest(context.req.raw);
  const now = Date.now();
  const id = installationId();
  let capsule = newCapsule(id, now + sessionTtl(context.env) * 1_000);
  const prepared = await prepareAuthorization(context.env, capsule);
  capsule = prepared.capsule;
  const browserBindingHash = await sha256Hex(capsule.browserBinding);
  const initial: InstallationState = {
    installationId: id,
    browserBindingHash,
    status: "created",
    createdAt: now,
    updatedAt: now,
    expiresAt: capsule.expiresAt,
    names: resourceNames(),
    resources: {},
    attempts: {},
  };
  await context.env.INSTALLATION_SESSION.getByName(id).initialize(initial);
  context.header("Set-Cookie", await capsuleCookie(context.env, capsule));
  return context.json(
    { installationId: id, authorizationUrl: prepared.authorizationUrl },
    201,
  );
});

api.get("/cloudflare/accounts", async (context) => {
  const current = await session(context.req.raw, context.env);
  const accounts = await listAccounts(
    accessClient(current.capsule, context.req.raw),
  );
  context.header(
    "Set-Cookie",
    await capsuleCookie(context.env, current.capsule),
  );
  return context.json({ accounts });
});

api.get("/cloudflare/zones", async (context) => {
  const current = await session(context.req.raw, context.env);
  const accountId = z
    .string()
    .regex(/^[a-f0-9]{32}$/u)
    .parse(context.req.query("account"));
  const accounts = await listAccounts(
    accessClient(current.capsule, context.req.raw),
  );
  if (!accounts.some((account) => account.id === accountId))
    throw new ApiError("ACCOUNT_NOT_AUTHORIZED", 403);
  const zones = await listZones(
    accessClient(current.capsule, context.req.raw),
    accountId,
  );
  context.header(
    "Set-Cookie",
    await capsuleCookie(context.env, current.capsule),
  );
  return context.json({ zones });
});

api.get("/installations/:id", async (context) => {
  const current = await session(context.req.raw, context.env);
  assertPathInstallation(current.capsule, context.req.param("id"));
  const state = await current.stub.getState(current.browserBindingHash);
  context.header(
    "Set-Cookie",
    await capsuleCookie(context.env, current.capsule),
  );
  return context.json({
    installation: publicState(state),
    csrfToken: current.capsule.csrfToken,
  });
});

api.post("/installations/:id/configure", async (context) => {
  const current = await session(context.req.raw, context.env);
  assertPathInstallation(current.capsule, context.req.param("id"));
  assertCsrf(context.req.raw, current.capsule, context.env);
  const input = configureSchema.parse(await context.req.json());
  const client = accessClient(current.capsule, context.req.raw);
  const account = (await listAccounts(client)).find(
    (item) => item.id === input.accountId,
  );
  if (!account) throw new ApiError("ACCOUNT_NOT_AUTHORIZED", 403);
  let configuration: InstallationConfiguration = {
    accountId: account.id,
    accountName: account.name,
    displayName: input.displayName,
    addressMode: input.addressMode,
  };
  if (input.addressMode === "custom_domain") {
    if (
      !input.zoneId ||
      !input.customHostname ||
      !isHostname(input.customHostname)
    )
      throw new ApiError("CUSTOM_DOMAIN_INVALID", 400);
    const zone = (await listZones(client, account.id)).find(
      (item) => item.id === input.zoneId,
    );
    if (!zone) throw new ApiError("ZONE_NOT_AUTHORIZED", 403);
    if (
      input.customHostname !== zone.name &&
      !input.customHostname.endsWith(`.${zone.name}`)
    )
      throw new ApiError("CUSTOM_DOMAIN_OUTSIDE_ZONE", 400);
    configuration = {
      ...configuration,
      zoneId: zone.id,
      zoneName: zone.name,
      customHostname: input.customHostname,
    };
  }
  const state = await current.stub.configure(
    current.browserBindingHash,
    configuration,
  );
  context.header(
    "Set-Cookie",
    await capsuleCookie(context.env, current.capsule),
  );
  return context.json({ installation: publicState(state) });
});

api.post("/installations/:id/next", async (context) => {
  const current = await session(context.req.raw, context.env);
  assertPathInstallation(current.capsule, context.req.param("id"));
  assertCsrf(context.req.raw, current.capsule, context.env);
  const result = await executeNextStep(
    context.env,
    current.stub,
    current.browserBindingHash,
    current.capsule,
    requestId(context.req.raw),
  );
  context.header(
    "Set-Cookie",
    await capsuleCookie(context.env, result.capsule),
  );
  return context.json({
    installation: publicState(result.state),
    ...(result.nextDelayMs ? { nextDelayMs: result.nextDelayMs } : {}),
  });
});

api.post("/installations/:id/defer-runtime-token", async (context) => {
  const current = await session(context.req.raw, context.env);
  assertPathInstallation(current.capsule, context.req.param("id"));
  assertCsrf(context.req.raw, current.capsule, context.env);
  await context.req.json();
  const updated = await current.stub.deferRuntimeCredential(
    current.browserBindingHash,
  );
  context.header(
    "Set-Cookie",
    await capsuleCookie(context.env, current.capsule),
  );
  return context.json({ installation: publicState(updated) });
});

api.post("/installations/:id/retry", async (context) => {
  const current = await session(context.req.raw, context.env);
  assertPathInstallation(current.capsule, context.req.param("id"));
  assertCsrf(context.req.raw, current.capsule, context.env);
  const state = await current.stub.retry(current.browserBindingHash);
  context.header(
    "Set-Cookie",
    await capsuleCookie(context.env, current.capsule),
  );
  return context.json({ installation: publicState(state) });
});

api.post("/installations/:id/reauthorize", async (context) => {
  const current = await session(context.req.raw, context.env);
  assertPathInstallation(current.capsule, context.req.param("id"));
  assertCsrf(context.req.raw, current.capsule, context.env);
  const prepared = await prepareAuthorization(context.env, current.capsule);
  context.header(
    "Set-Cookie",
    await capsuleCookie(context.env, prepared.capsule),
  );
  return context.json({ authorizationUrl: prepared.authorizationUrl });
});

api.post("/installations/:id/cancel", async (context) => {
  const current = await session(context.req.raw, context.env);
  assertPathInstallation(current.capsule, context.req.param("id"));
  assertCsrf(context.req.raw, current.capsule, context.env);
  const state = await current.stub.getState(current.browserBindingHash);
  if (
    current.capsule.runtimeCredentialAutomatic &&
    state.resources.runtimeCredentialId &&
    ![
      "worker_uploaded",
      "worker_route_enabled",
      "cron_configured",
      "queue_consumer_configured",
      "waiting_for_domain",
      "custom_domain_attached",
      "health_verified",
      "oauth_revoked",
      "completed",
    ].includes(state.status) &&
    current.capsule.accessToken
  )
    await revokeRuntimeCredential(
      accessClient(current.capsule, context.req.raw),
      state.resources.runtimeCredentialId,
    ).catch(() => undefined);
  if (current.capsule.accessToken)
    await revokeAuthorization(context.env, current.capsule.accessToken).catch(
      () => undefined,
    );
  await current.stub.cancel(current.browserBindingHash);
  const report = await current.stub.report(current.browserBindingHash);
  context.header("Set-Cookie", expiredSessionCookie());
  return context.json({ report });
});

api.get("/installations/:id/report", async (context) => {
  const current = await session(context.req.raw, context.env);
  assertPathInstallation(current.capsule, context.req.param("id"));
  const report = await current.stub.report(current.browserBindingHash);
  const headers = new Headers({
    "Content-Disposition": `attachment; filename="nexus-edge-installation-${report.installationId}.json"`,
    "Content-Type": "application/json; charset=utf-8",
  });
  headers.append(
    "Set-Cookie",
    await capsuleCookie(context.env, current.capsule),
  );
  return new Response(`${JSON.stringify(report, null, 2)}\n`, { headers });
});

export async function oauthCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const current = await session(request, env);
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    await current.stub.cancel(current.browserBindingHash);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${env.INSTALLER_ORIGIN}/?oauth=denied`,
        "Set-Cookie": expiredSessionCookie(),
      },
    });
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new ApiError("OAUTH_CALLBACK_INVALID", 400);
  const capsule = await exchangeAuthorizationCode(
    env,
    current.capsule,
    code,
    state,
  );
  await current.stub.authorize(current.browserBindingHash);
  const headers = new Headers({
    Location: `${env.INSTALLER_ORIGIN}/?installation=${encodeURIComponent(capsule.installationId)}`,
  });
  headers.append("Set-Cookie", await capsuleCookie(env, capsule));
  return new Response(null, { status: 302, headers });
}
