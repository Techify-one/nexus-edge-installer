import type {
  InstallerRelease,
  ReleaseAsset,
} from "@app/installer-release-schema";
import { CloudflareApiClient } from "./client.js";
import { readVerifiedObject } from "../release/reader.js";

type AssetUploadSession = { buckets: string[][]; jwt: string };
type WorkerUploadResult = {
  id?: string;
  etag?: string;
  deployment_id?: string;
};

const accountPath = (accountId: string): string =>
  `/accounts/${encodeURIComponent(accountId)}`;

function base64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  return btoa(binary);
}

async function uploadAssets(
  env: Env,
  client: CloudflareApiClient,
  accountId: string,
  workerName: string,
  assets: ReleaseAsset[],
): Promise<string> {
  const descriptors = new Map(assets.map((asset) => [asset.uploadHash, asset]));
  const manifest = Object.fromEntries(
    assets.map((asset) => [
      `/${asset.path}`,
      { hash: asset.uploadHash, size: asset.size },
    ]),
  );
  const session = await client.request<AssetUploadSession>(
    `${accountPath(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/assets-upload-session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest }),
    },
  );
  if (!session.jwt || !Array.isArray(session.buckets))
    throw new Error("ASSET_UPLOAD_SESSION_INVALID");
  let completionJwt = session.jwt;
  for (const bucket of session.buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const descriptor = descriptors.get(hash);
      if (!descriptor) throw new Error("ASSET_UPLOAD_REQUESTED_UNKNOWN_HASH");
      const content = await readVerifiedObject(env, descriptor);
      form.append(
        hash,
        new File([base64(content)], hash, { type: descriptor.mimeType }),
        hash,
      );
    }
    const assetClient = new CloudflareApiClient(session.jwt, client.requestId);
    const uploaded = await assetClient.request<{ jwt?: string }>(
      `${accountPath(accountId)}/workers/assets/upload?base64=true`,
      { method: "POST", body: form },
    );
    if (uploaded.jwt) completionJwt = uploaded.jwt;
  }
  return completionJwt;
}

export type CoreDeployment = {
  accountId: string;
  databaseId: string;
  queueName: string;
  workerName: string;
  installationId: string;
  finalUrl: string;
  betterAuthSecret: string;
  webhookEncryptionKey: string;
};

export async function uploadCoreWorker(
  env: Env,
  client: CloudflareApiClient,
  release: InstallerRelease,
  deployment: CoreDeployment,
): Promise<{ etag?: string; versionId?: string }> {
  const assetJwt = await uploadAssets(
    env,
    client,
    deployment.accountId,
    deployment.workerName,
    release.assets,
  );
  const metadata = {
    main_module: release.entrypoint,
    compatibility_date: release.compatibilityDate,
    compatibility_flags: release.compatibilityFlags,
    annotations: {
      "workers/message": `Install Nexus Edge ${release.appVersion}`,
    },
    assets: {
      jwt: assetJwt,
      config: {
        not_found_handling: "single-page-application",
        run_worker_first: ["/api/*", "/health"],
      },
    },
    bindings: [
      { type: "assets", name: "ASSETS" },
      { type: "d1", name: "DB", database_id: deployment.databaseId },
      {
        type: "queue",
        name: "WEBHOOK_QUEUE",
        queue_name: deployment.queueName,
      },
      { type: "plain_text", name: "APP_VERSION", text: release.appVersion },
      {
        type: "plain_text",
        name: "APP_INSTALLATION_ID",
        text: deployment.installationId,
      },
      { type: "plain_text", name: "DATABASE_PROVIDER", text: "d1" },
      {
        type: "plain_text",
        name: "BETTER_AUTH_URL",
        text: deployment.finalUrl,
      },
      {
        type: "plain_text",
        name: "TRUSTED_ORIGINS",
        text: deployment.finalUrl,
      },
      {
        type: "plain_text",
        name: "CORE_WORKER_NAME",
        text: deployment.workerName,
      },
      {
        type: "plain_text",
        name: "D1_DATABASE_ID",
        text: deployment.databaseId,
      },
      { type: "plain_text", name: "WEBHOOK_ALLOWED_DOMAINS", text: "" },
      { type: "plain_text", name: "API_RATE_LIMIT_MAX", text: "120" },
      {
        type: "plain_text",
        name: "API_RATE_LIMIT_WINDOW_SECONDS",
        text: "60",
      },
      {
        type: "plain_text",
        name: "PLUGIN_COMPATIBILITY_FLAGS",
        text: release.compatibilityFlags.join(","),
      },
      {
        type: "secret_text",
        name: "BETTER_AUTH_SECRET",
        text: deployment.betterAuthSecret,
      },
      {
        type: "secret_text",
        name: "WEBHOOK_ENCRYPTION_KEY",
        text: deployment.webhookEncryptionKey,
      },
      {
        type: "plain_text",
        name: "CF_ACCOUNT_ID",
        text: deployment.accountId,
      },
    ],
  };
  const form = new FormData();
  form.set(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    "metadata.json",
  );
  for (const descriptor of release.modules) {
    form.set(
      descriptor.path,
      new Blob([await readVerifiedObject(env, descriptor)], {
        type: descriptor.mimeType,
      }),
      descriptor.path,
    );
  }
  const result = await client.request<WorkerUploadResult>(
    `${accountPath(deployment.accountId)}/workers/scripts/${encodeURIComponent(deployment.workerName)}`,
    { method: "PUT", body: form },
  );
  return {
    ...(result.etag ? { etag: result.etag } : {}),
    ...(result.deployment_id ? { versionId: result.deployment_id } : {}),
  };
}
