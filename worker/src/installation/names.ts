import { randomBase64Url } from "../security/encoding.js";
import type { ResourceNames } from "./types.js";

export function installationId(): string {
  return `install_${randomBase64Url(24).replaceAll("-", "a").replaceAll("_", "b")}`;
}

export function resourceNames(): ResourceNames {
  const suffix = randomBase64Url(8)
    .toLowerCase()
    .replaceAll("-", "a")
    .replaceAll("_", "b")
    .slice(0, 10);
  const prefix = `nexus-edge-${suffix}`;
  return {
    worker: prefix,
    database: `${prefix}-db`,
    queue: `${prefix}-webhooks`,
    deadLetterQueue: `${prefix}-webhooks-dlq`,
  };
}

export function validResourceName(value: string): boolean {
  return /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);
}
