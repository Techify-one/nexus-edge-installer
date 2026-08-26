import { CloudflareApiClient } from "../cloudflare/client.js";
import {
  accountSubdomain,
  isAccountSubdomainMissing,
  listAccounts,
  listDatabases,
  listQueues,
  listWorkers,
  listZones,
} from "../cloudflare/resources.js";
import type { InstallationState } from "./types.js";

export async function runPreflight(
  client: CloudflareApiClient,
  state: InstallationState,
): Promise<{ accountSubdomain: string }> {
  const configuration = state.configuration;
  if (!configuration) throw new Error("INSTALLATION_NOT_CONFIGURED");
  const subdomainPromise = accountSubdomain(
    client,
    configuration.accountId,
  ).catch((error: unknown) => {
    if (!isAccountSubdomainMissing(error)) throw error;
    return state.names.worker;
  });
  const [accounts, databases, queues, workers, subdomain] = await Promise.all([
    listAccounts(client),
    listDatabases(client, configuration.accountId),
    listQueues(client, configuration.accountId),
    listWorkers(client, configuration.accountId),
    subdomainPromise,
  ]);
  if (!accounts.some((account) => account.id === configuration.accountId))
    throw new Error("ACCOUNT_NOT_AUTHORIZED");
  const collisions = [
    databases.some((database) => database.name === state.names.database),
    queues.some((queue) =>
      [state.names.queue, state.names.deadLetterQueue].includes(
        queue.queue_name,
      ),
    ),
    workers.some((worker) => worker.id === state.names.worker),
  ];
  if (collisions.some(Boolean)) throw new Error("RESOURCE_NAME_COLLISION");

  if (configuration.addressMode === "custom_domain") {
    if (
      !configuration.zoneId ||
      !configuration.zoneName ||
      !configuration.customHostname
    )
      throw new Error("CUSTOM_DOMAIN_CONFIGURATION_INCOMPLETE");
    const zones = await listZones(client, configuration.accountId);
    const zone = zones.find((item) => item.id === configuration.zoneId);
    if (!zone || zone.name !== configuration.zoneName)
      throw new Error("CUSTOM_DOMAIN_ZONE_NOT_AUTHORIZED");
    if (
      configuration.customHostname !== configuration.zoneName &&
      !configuration.customHostname.endsWith(`.${configuration.zoneName}`)
    )
      throw new Error("CUSTOM_DOMAIN_OUTSIDE_ZONE");
  }
  return { accountSubdomain: subdomain };
}
