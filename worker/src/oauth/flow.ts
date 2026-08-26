import {
  randomBase64Url,
  sha256Base64Url,
  timingSafeEqual,
} from "../security/encoding.js";
import type { SessionCapsule } from "../security/capsule.js";

const authorizationEndpoint = "https://dash.cloudflare.com/oauth2/auth";
const tokenEndpoint = "https://dash.cloudflare.com/oauth2/token";
const revokeEndpoint = "https://dash.cloudflare.com/oauth2/revoke";

export async function prepareAuthorization(
  env: Env,
  capsule: SessionCapsule,
): Promise<{ capsule: SessionCapsule; authorizationUrl: string }> {
  if (
    env.OAUTH_CLIENT_ID.startsWith("configure-") ||
    env.OAUTH_SCOPES.startsWith("configure-")
  )
    throw new Error("OAUTH_CLIENT_NOT_CONFIGURED");
  const verifier = randomBase64Url(48);
  const state = randomBase64Url(32);
  const nonce = randomBase64Url(32);
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("client_id", env.OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.OAUTH_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", env.OAUTH_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", await sha256Base64Url(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return {
    authorizationUrl: url.toString(),
    capsule: {
      ...capsule,
      oauthState: state,
      oauthNonce: nonce,
      pkceVerifier: verifier,
    },
  };
}

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  refresh_token?: string;
};

async function oauthResponse(response: Response): Promise<TokenResponse> {
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > 64_000) throw new Error("OAUTH_RESPONSE_TOO_LARGE");
  const text = (await response.text()).slice(0, 64_001);
  if (text.length > 64_000) throw new Error("OAUTH_RESPONSE_TOO_LARGE");
  let body: TokenResponse;
  try {
    body = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error("OAUTH_RESPONSE_INVALID");
  }
  if (!response.ok) throw new Error(`OAUTH_EXCHANGE_FAILED:${response.status}`);
  return body;
}

export async function exchangeAuthorizationCode(
  env: Env,
  capsule: SessionCapsule,
  code: string,
  returnedState: string,
): Promise<SessionCapsule> {
  if (
    !capsule.oauthState ||
    !timingSafeEqual(capsule.oauthState, returnedState)
  )
    throw new Error("OAUTH_STATE_MISMATCH");
  if (!capsule.pkceVerifier) throw new Error("OAUTH_PKCE_MISSING");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.OAUTH_REDIRECT_URI,
    code_verifier: capsule.pkceVerifier,
  });
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${env.OAUTH_CLIENT_ID}:${env.OAUTH_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const token = await oauthResponse(response);
  if (!token.access_token || token.token_type?.toLowerCase() !== "bearer")
    throw new Error("OAUTH_ACCESS_TOKEN_MISSING");
  if (token.refresh_token) throw new Error("OAUTH_REFRESH_TOKEN_NOT_ALLOWED");
  const {
    oauthState: _oauthState,
    oauthNonce: _oauthNonce,
    pkceVerifier: _pkceVerifier,
    ...remaining
  } = capsule;
  return {
    ...remaining,
    accessToken: token.access_token,
    accessTokenExpiresAt:
      Date.now() + Math.max(60, token.expires_in ?? 3_600) * 1_000,
    ...(token.scope ? { grantedScope: token.scope } : {}),
  };
}

export async function revokeAuthorization(
  env: Env,
  accessToken: string,
): Promise<void> {
  const response = await fetch(revokeEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${env.OAUTH_CLIENT_ID}:${env.OAUTH_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ token: accessToken }),
  });
  if (!response.ok) throw new Error(`OAUTH_REVOKE_FAILED:${response.status}`);
  await response.body?.cancel();
}
