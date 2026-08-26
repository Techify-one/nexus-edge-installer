export const installationStatuses = [
  "created",
  "oauth_authorized",
  "configured",
  "preflight_complete",
  "release_verified",
  "d1_created",
  "migrations_applied",
  "queues_created",
  "runtime_token_created",
  "runtime_token_required",
  "worker_uploaded",
  "worker_route_enabled",
  "cron_configured",
  "queue_consumer_configured",
  "waiting_for_domain",
  "custom_domain_attached",
  "health_verified",
  "oauth_revoked",
  "completed",
  "failed",
  "authorization_required",
  "cancelled",
] as const;

export type InstallationStatus = (typeof installationStatuses)[number];
export type AddressMode = "workers_dev" | "custom_domain";

export type InstallationError = {
  code: string;
  message: string;
  requestId: string;
  retryable: boolean;
  status?: number;
};

export type ResourceNames = {
  worker: string;
  database: string;
  queue: string;
  deadLetterQueue: string;
};

export type InstallationConfiguration = {
  accountId: string;
  accountName: string;
  displayName: string;
  addressMode: AddressMode;
  customHostname?: string;
  zoneId?: string;
  zoneName?: string;
};

export type InstallationResources = {
  databaseId?: string;
  queueId?: string;
  deadLetterQueueId?: string;
  runtimeCredentialId?: string;
  workerEtag?: string;
  workerVersionId?: string;
  accountSubdomain?: string;
};

export type InstallationState = {
  installationId: string;
  browserBindingHash: string;
  status: InstallationStatus;
  resumeStatus?: InstallationStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  leaseUntil?: number;
  leaseId?: string;
  configuration?: InstallationConfiguration;
  names: ResourceNames;
  resources: InstallationResources;
  releaseVersion?: string;
  releaseManifestHash?: string;
  finalUrl?: string;
  completedAt?: number;
  error?: InstallationError;
  attempts: Partial<Record<InstallationStatus, number>>;
};

export type InstallationReport = {
  installationId: string;
  releaseVersion?: string;
  releaseManifestHash?: string;
  status: InstallationStatus;
  createdAt: string;
  completedAt?: string;
  accountIdMasked?: string;
  resources: {
    worker: string;
    database: string;
    queue: string;
    deadLetterQueue: string;
    databaseId?: string;
    queueId?: string;
    deadLetterQueueId?: string;
  };
  finalUrl?: string;
  error?: InstallationError;
};

export type StepLease = {
  acquired: boolean;
  leaseId?: string;
  state: InstallationState;
};
