import type { Context, Next } from "hono";

export const sessionCookieName = "__Host-nexus_installer_session";

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

export function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${sessionCookieName}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function expiredSessionCookie(): string {
  return `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function securityHeaders(headers: Headers): void {
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  headers.set(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), payment=()",
  );
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
}

export async function secureResponse(
  context: Context,
  next: Next,
): Promise<void> {
  await next();
  const response = context.res;
  const headers = new Headers(response.headers);
  securityHeaders(headers);
  if (
    new URL(context.req.url).pathname.startsWith("/api/") ||
    new URL(context.req.url).pathname.startsWith("/oauth/")
  )
    headers.set("Cache-Control", "no-store");
  context.res = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function assertMutationOrigin(
  request: Request,
  expectedOrigin: string,
): void {
  const origin = request.headers.get("Origin");
  if (origin !== expectedOrigin)
    throw new HttpSecurityError("INVALID_ORIGIN", 403);
}

export function assertJsonRequest(request: Request): void {
  const contentType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim();
  if (contentType !== "application/json")
    throw new HttpSecurityError("JSON_CONTENT_TYPE_REQUIRED", 415);
}

export class HttpSecurityError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
