import { Hono } from "hono";
import { ZodError } from "zod";
import { api, ApiError, oauthCallback } from "./routes/api.js";
import {
  HttpSecurityError,
  secureResponse,
  securityHeaders,
} from "./security/http.js";
import { safeLog } from "./security/redaction.js";

export { InstallationSession } from "./durable-objects/InstallationSession.js";

type InstallerHonoEnv = { Bindings: Env };
const app = new Hono<InstallerHonoEnv>();

app.use("*", secureResponse);
app.use("*", async (context, next) => {
  const requested = new URL(context.req.url);
  const canonical = new URL(context.env.INSTALLER_ORIGIN);
  if (requested.origin !== canonical.origin) {
    canonical.pathname = requested.pathname;
    canonical.search = requested.search;
    return context.redirect(canonical.toString(), 308);
  }
  await next();
});
app.get("/health", (context) =>
  context.json({
    ok: true,
    service: "nexus-edge-installer",
    version: context.env.INSTALLER_VERSION,
    environment: context.env.ENVIRONMENT,
  }),
);
app.get("/oauth/callback", (context) =>
  oauthCallback(context.req.raw, context.env),
);
app.route("/api", api);
app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));

app.onError((error, context) => {
  const requestId =
    context.req.header("CF-Ray")?.split("-", 1)[0] ?? crypto.randomUUID();
  let code = "INTERNAL_ERROR";
  let status = 500;
  let details: Record<string, unknown> | undefined;
  if (error instanceof ApiError || error instanceof HttpSecurityError) {
    code = error.code;
    status = error.status;
    if (error instanceof ApiError) details = error.details;
  } else if (error instanceof ZodError) {
    code = "VALIDATION_FAILED";
    status = 400;
    details = {
      fields: error.issues.map((issue) => issue.path.join(".")).slice(0, 20),
    };
  }
  safeLog("error", "request_failed", { requestId, code, status });
  const response = Response.json(
    {
      error: {
        code,
        message:
          code === "INTERNAL_ERROR" ? "An unexpected error occurred." : code,
        requestId,
        ...(details ? { details } : {}),
      },
    },
    { status },
  );
  securityHeaders(response.headers);
  response.headers.set("Cache-Control", "no-store");
  return response;
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
