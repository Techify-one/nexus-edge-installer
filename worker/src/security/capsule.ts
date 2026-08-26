import {
  base64UrlToBytes,
  bytesToBase64Url,
  randomBase64Url,
} from "./encoding.js";

export type CoreSecrets = {
  betterAuthSecret: string;
  webhookEncryptionKey: string;
};

export type SessionCapsule = {
  version: 1;
  installationId: string;
  browserBinding: string;
  csrfToken: string;
  expiresAt: number;
  oauthState?: string;
  oauthNonce?: string;
  pkceVerifier?: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  grantedScope?: string;
  coreSecrets?: CoreSecrets;
  runtimeCredentialValue?: string;
  runtimeCredentialAutomatic?: boolean;
};

const additionalData = new TextEncoder().encode(
  "nexus-edge-installer:session:v1",
);

async function importKey(value: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(value);
  if (bytes.byteLength !== 32)
    throw new Error("SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sealCapsule(
  capsule: SessionCapsule,
  encryptionKey: string,
): Promise<string> {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData },
      await importKey(encryptionKey),
      new TextEncoder().encode(JSON.stringify(capsule)),
    ),
  );
  const value = `v1.${bytesToBase64Url(nonce)}.${bytesToBase64Url(ciphertext)}`;
  if (value.length > 3_700)
    throw new Error("Encrypted session exceeds cookie capacity");
  return value;
}

export async function openCapsule(
  value: string,
  encryptionKey: string,
  now = Date.now(),
): Promise<SessionCapsule> {
  const [version, nonceValue, ciphertextValue, extra] = value.split(".");
  if (version !== "v1" || !nonceValue || !ciphertextValue || extra)
    throw new Error("Invalid session capsule");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(nonceValue),
      additionalData,
    },
    await importKey(encryptionKey),
    base64UrlToBytes(ciphertextValue),
  );
  const capsule = JSON.parse(
    new TextDecoder().decode(plaintext),
  ) as SessionCapsule;
  if (
    capsule.version !== 1 ||
    !capsule.installationId ||
    !capsule.browserBinding ||
    !capsule.csrfToken ||
    capsule.expiresAt <= now
  )
    throw new Error("Session expired or malformed");
  return capsule;
}

export function newCapsule(
  installationId: string,
  expiresAt: number,
): SessionCapsule {
  return {
    version: 1,
    installationId,
    browserBinding: randomBase64Url(),
    csrfToken: randomBase64Url(),
    expiresAt,
    coreSecrets: {
      betterAuthSecret: randomBase64Url(48),
      webhookEncryptionKey: randomBase64Url(32),
    },
  };
}
