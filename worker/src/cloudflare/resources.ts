import { CloudflareApiClient, CloudflareApiError } from "./client.js";

export type CloudflareAccount = { id: string; name: string };
export type CloudflareZone = { id: string; name: string; status?: string };
export type D1Database = { uuid: string; name: string };
export type Queue = {
  queue_id: string;
  queue_name: string;
  consumers?: Array<{
    consumer_id: string;
    script?: string;
    service?: string;
  }>;
};
export type WorkerScript = { id: string; etag?: string };

const accountPath = (accountId: string): string =>
  `/accounts/${encodeURIComponent(accountId)}`;

export async function listAccounts(
  client: CloudflareApiClient,
): Promise<CloudflareAccount[]> {
  return client.request<CloudflareAccount[]>("/accounts?per_page=50");
}

export async function listZones(
  client: CloudflareApiClient,
  accountId: string,
): Promise<CloudflareZone[]> {
  return client.request<CloudflareZone[]>(
    `/zones?account.id=${encodeURIComponent(accountId)}&per_page=50`,
  );
}

export async function listDatabases(
  client: CloudflareApiClient,
  accountId: string,
): Promise<D1Database[]> {
  return client.request<D1Database[]>(
    `${accountPath(accountId)}/d1/database?per_page=100`,
  );
}

export async function listQueues(
  client: CloudflareApiClient,
  accountId: string,
): Promise<Queue[]> {
  return client.request<Queue[]>(
    `${accountPath(accountId)}/queues?per_page=100`,
  );
}

export async function listWorkers(
  client: CloudflareApiClient,
  accountId: string,
): Promise<WorkerScript[]> {
  return client.request<WorkerScript[]>(
    `${accountPath(accountId)}/workers/scripts`,
  );
}

export async function accountSubdomain(
  client: CloudflareApiClient,
  accountId: string,
): Promise<string> {
  const result = await client.request<{ subdomain: string }>(
    `${accountPath(accountId)}/workers/subdomain`,
  );
  if (!result.subdomain) throw new Error("ACCOUNT_SUBDOMAIN_UNAVAILABLE");
  return result.subdomain;
}

export function isAccountSubdomainMissing(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.codes.includes("10007");
}

export async function ensureAccountSubdomain(
  client: CloudflareApiClient,
  accountId: string,
  requestedSubdomain: string,
): Promise<string> {
  try {
    return await accountSubdomain(client, accountId);
  } catch (error) {
    if (!isAccountSubdomainMissing(error)) throw error;
  }
  const result = await client.request<{ subdomain: string }>(
    `${accountPath(accountId)}/workers/subdomain`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subdomain: requestedSubdomain }),
    },
  );
  if (!result.subdomain) throw new Error("ACCOUNT_SUBDOMAIN_UNAVAILABLE");
  return result.subdomain;
}

export async function createDatabase(
  client: CloudflareApiClient,
  accountId: string,
  name: string,
): Promise<D1Database> {
  return client.request<D1Database>(`${accountPath(accountId)}/d1/database`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export type D1Query = { sql: string; params?: Array<string | number | null> };
export type D1QueryResult = {
  success: boolean;
  results?: Array<Record<string, unknown>>;
  meta?: Record<string, unknown>;
};

export async function queryDatabase(
  client: CloudflareApiClient,
  accountId: string,
  databaseId: string,
  queries: D1Query | D1Query[],
): Promise<D1QueryResult | D1QueryResult[]> {
  return client.request<D1QueryResult | D1QueryResult[]>(
    `${accountPath(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        Array.isArray(queries) ? { batch: queries } : queries,
      ),
    },
  );
}

export async function createQueue(
  client: CloudflareApiClient,
  accountId: string,
  name: string,
): Promise<Queue> {
  return client.request<Queue>(`${accountPath(accountId)}/queues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queue_name: name }),
  });
}

export async function revokeRuntimeCredential(
  client: CloudflareApiClient,
  credentialId: string,
): Promise<void> {
  await client.request<unknown>(
    `/user/tokens/${encodeURIComponent(credentialId)}`,
    {
      method: "DELETE",
    },
  );
}

export async function enableWorkerSubdomain(
  client: CloudflareApiClient,
  accountId: string,
  workerName: string,
): Promise<void> {
  await client.request<unknown>(
    `${accountPath(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/subdomain`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
    },
  );
}

export async function configureSchedules(
  client: CloudflareApiClient,
  accountId: string,
  workerName: string,
  schedules: string[],
): Promise<void> {
  const path = `${accountPath(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/schedules`;
  await client.request<unknown>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(schedules.map((cron) => ({ cron }))),
  });
  const configured = await client.request<Array<{ cron: string }>>(path);
  if (
    configured.length !== schedules.length ||
    schedules.some((cron) => !configured.some((item) => item.cron === cron))
  )
    throw new Error("CRON_VERIFICATION_FAILED");
}

export async function configureQueueConsumer(
  client: CloudflareApiClient,
  accountId: string,
  queue: Queue,
  workerName: string,
  deadLetterQueueName: string,
): Promise<void> {
  const existing = (queue.consumers ?? []).find(
    (consumer) =>
      consumer.script === workerName || consumer.service === workerName,
  );
  const path = `${accountPath(accountId)}/queues/${encodeURIComponent(queue.queue_id)}/consumers${
    existing ? `/${encodeURIComponent(existing.consumer_id)}` : ""
  }`;
  await client.request<unknown>(path, {
    method: existing ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "worker",
      script_name: workerName,
      dead_letter_queue: deadLetterQueueName,
      settings: { batch_size: 5, max_retries: 6, max_wait_time_ms: 5_000 },
    }),
  });
  const queues = await listQueues(client, accountId);
  const verified = queues.find((item) => item.queue_id === queue.queue_id);
  if (
    !(verified?.consumers ?? []).some(
      (consumer) =>
        consumer.script === workerName || consumer.service === workerName,
    )
  )
    throw new Error("QUEUE_CONSUMER_VERIFICATION_FAILED");
}

export async function attachCustomDomain(
  client: CloudflareApiClient,
  accountId: string,
  workerName: string,
  hostname: string,
  zoneId: string,
): Promise<void> {
  await client.request<unknown>(`${accountPath(accountId)}/workers/domains`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostname, service: workerName, zone_id: zoneId }),
  });
}
