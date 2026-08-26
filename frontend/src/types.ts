export type InstallationStatus =
  | "created"
  | "oauth_authorized"
  | "configured"
  | "preflight_complete"
  | "release_verified"
  | "d1_created"
  | "migrations_applied"
  | "queues_created"
  | "runtime_token_created"
  | "runtime_token_required"
  | "worker_uploaded"
  | "worker_route_enabled"
  | "cron_configured"
  | "queue_consumer_configured"
  | "waiting_for_domain"
  | "custom_domain_attached"
  | "health_verified"
  | "oauth_revoked"
  | "completed"
  | "failed"
  | "authorization_required"
  | "cancelled";

export type Installation = {
  installationId: string;
  status: InstallationStatus;
  resumeStatus?: InstallationStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  configuration?: {
    accountId: string;
    accountName: string;
    displayName: string;
    addressMode: "workers_dev" | "custom_domain";
    customHostname?: string;
    zoneId?: string;
    zoneName?: string;
  };
  names: {
    worker: string;
    database: string;
    queue: string;
    deadLetterQueue: string;
  };
  resources: {
    databaseId?: string;
    queueId?: string;
    deadLetterQueueId?: string;
    runtimeCredentialId?: string;
    accountSubdomain?: string;
  };
  releaseVersion?: string;
  releaseManifestHash?: string;
  finalUrl?: string;
  completedAt?: number;
  error?: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    status?: number;
  };
  attempts: Partial<Record<InstallationStatus, number>>;
};

export type Account = { id: string; name: string };
export type Zone = { id: string; name: string; status?: string };
