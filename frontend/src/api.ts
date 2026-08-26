import type { Account, Installation, Zone } from "./types.js";

type ErrorBody = { error?: { code?: string; requestId?: string } };

export class InstallerApiError extends Error {
  constructor(
    readonly code: string,
    readonly requestId?: string,
  ) {
    super(code);
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & ErrorBody;
  if (!response.ok)
    throw new InstallerApiError(
      body.error?.code ?? `HTTP_${response.status}`,
      body.error?.requestId,
    );
  return body;
}

async function mutation<T>(
  path: string,
  csrfToken: string | undefined,
  body: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: JSON.stringify(body),
  });
  return responseJson<T>(response);
}

export const installerApi = {
  start: (): Promise<{ installationId: string; authorizationUrl: string }> =>
    mutation("/api/oauth/start", undefined),
  status: (
    id: string,
  ): Promise<{ installation: Installation; csrfToken: string }> =>
    fetch(`/api/installations/${encodeURIComponent(id)}`, {
      credentials: "same-origin",
    }).then((response) =>
      responseJson<{ installation: Installation; csrfToken: string }>(response),
    ),
  accounts: (): Promise<{ accounts: Account[] }> =>
    fetch("/api/cloudflare/accounts", { credentials: "same-origin" }).then(
      (response) => responseJson<{ accounts: Account[] }>(response),
    ),
  zones: (accountId: string): Promise<{ zones: Zone[] }> =>
    fetch(`/api/cloudflare/zones?account=${encodeURIComponent(accountId)}`, {
      credentials: "same-origin",
    }).then((response) => responseJson<{ zones: Zone[] }>(response)),
  stableRelease: (): Promise<{ version: string; manifestHash: string }> =>
    fetch("/api/releases/stable", { credentials: "same-origin" }).then(
      (response) =>
        responseJson<{ version: string; manifestHash: string }>(response),
    ),
  configure: (
    id: string,
    csrfToken: string,
    input: Record<string, unknown>,
  ): Promise<{ installation: Installation }> =>
    mutation(
      `/api/installations/${encodeURIComponent(id)}/configure`,
      csrfToken,
      input,
    ),
  next: (
    id: string,
    csrfToken: string,
  ): Promise<{ installation: Installation; nextDelayMs?: number }> =>
    mutation(`/api/installations/${encodeURIComponent(id)}/next`, csrfToken),
  retry: (
    id: string,
    csrfToken: string,
  ): Promise<{ installation: Installation }> =>
    mutation(`/api/installations/${encodeURIComponent(id)}/retry`, csrfToken),
  reauthorize: (
    id: string,
    csrfToken: string,
  ): Promise<{ authorizationUrl: string }> =>
    mutation(
      `/api/installations/${encodeURIComponent(id)}/reauthorize`,
      csrfToken,
    ),
  deferRuntimeToken: (
    id: string,
    csrfToken: string,
  ): Promise<{ installation: Installation }> =>
    mutation(
      `/api/installations/${encodeURIComponent(id)}/defer-runtime-token`,
      csrfToken,
    ),
  cancel: (id: string, csrfToken: string): Promise<void> =>
    mutation(`/api/installations/${encodeURIComponent(id)}/cancel`, csrfToken),
};
