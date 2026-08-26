type CloudflareEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
  result_info?: Record<string, unknown>;
};

const apiOrigin = "https://api.cloudflare.com";
const apiPrefix = "/client/v4";
const maximumResponseBytes = 2 * 1024 * 1024;

async function readBoundedText(response: Response): Promise<string> {
  const declaredSize = Number(response.headers.get("Content-Length") ?? "0");
  if (declaredSize > maximumResponseBytes)
    throw new CloudflareApiError(
      response.status,
      ["RESPONSE_TOO_LARGE"],
      false,
    );
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumResponseBytes) {
      await reader.cancel();
      throw new CloudflareApiError(
        response.status,
        ["RESPONSE_TOO_LARGE"],
        false,
      );
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("Retry-After");
  if (header && /^\d+$/u.test(header))
    return Math.min(Number(header) * 1_000, 8_000);
  return Math.min(
    250 * 2 ** attempt + (crypto.getRandomValues(new Uint16Array(1))[0]! % 200),
    4_000,
  );
}

export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    readonly codes: string[],
    readonly retryable: boolean,
  ) {
    super(`Cloudflare API failed (${status}): ${codes.join(",") || "UNKNOWN"}`);
  }
}

export class CloudflareApiClient {
  constructor(
    private readonly accessToken: string,
    readonly requestId: string,
  ) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith("/"))
      throw new Error("Cloudflare path must be absolute");
    const url = new URL(`${apiPrefix}${path}`, apiOrigin);
    if (url.origin !== apiOrigin || !url.pathname.startsWith(apiPrefix))
      throw new Error("Cloudflare API destination rejected");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.accessToken}`,
          "X-Correlation-Id": this.requestId,
          ...(init.headers ?? {}),
        },
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await response.body?.cancel();
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelay(response, attempt)),
        );
        continue;
      }
      const text = await readBoundedText(response);
      let envelope: CloudflareEnvelope<T> | undefined;
      try {
        envelope = text
          ? (JSON.parse(text) as CloudflareEnvelope<T>)
          : undefined;
      } catch {
        throw new CloudflareApiError(
          response.status,
          ["MALFORMED_RESPONSE"],
          false,
        );
      }
      if (!response.ok || !envelope?.success) {
        const codes = (envelope?.errors ?? []).map((entry) =>
          String(entry.code ?? "API_ERROR"),
        );
        throw new CloudflareApiError(
          response.status,
          codes.length ? codes : [String(response.status)],
          response.status === 429 || response.status >= 500,
        );
      }
      return envelope.result;
    }
    throw new CloudflareApiError(503, ["RETRY_EXHAUSTED"], true);
  }
}

export function isAuthorizationFailure(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    (error.status === 401 || error.status === 403)
  );
}
