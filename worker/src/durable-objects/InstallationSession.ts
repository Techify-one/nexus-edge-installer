import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "../security/encoding.js";
import type {
  InstallationConfiguration,
  InstallationError,
  InstallationReport,
  InstallationResources,
  InstallationState,
  InstallationStatus,
  StepLease,
} from "../installation/types.js";
import { installationStatuses } from "../installation/types.js";

type StoredRow = { state_json: string };
type CompletionPatch = {
  resources?: InstallationResources;
  releaseVersion?: string;
  releaseManifestHash?: string;
  finalUrl?: string;
};

const forbiddenStateKey =
  /(?:access|refresh|api|oauth)?_?token|secret|password|authorization|cookie|code_verifier/iu;
const installationStatusSet = new Set<string>(installationStatuses);

function assertSafeState(value: unknown, path = "state"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeState(entry, `${path}.${index}`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const isAttemptStatus =
      path === "state.attempts" && installationStatusSet.has(key);
    if (!isAttemptStatus && forbiddenStateKey.test(key) && !key.endsWith("Id"))
      throw new Error(`Forbidden sensitive state field at ${path}.${key}`);
    assertSafeState(entry, `${path}.${key}`);
  }
}

export class InstallationSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS installation_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          state_json TEXT NOT NULL
        );
        INSERT OR IGNORE INTO _sql_schema_migrations(id) VALUES (1);
      `);
    });
  }

  private load(): InstallationState | null {
    const rows = this.ctx.storage.sql
      .exec<StoredRow>("SELECT state_json FROM installation_state WHERE id = 1")
      .toArray();
    return rows[0]
      ? (JSON.parse(rows[0].state_json) as InstallationState)
      : null;
  }

  private save(state: InstallationState): void {
    assertSafeState(state);
    this.ctx.storage.sql.exec(
      `INSERT INTO installation_state(id, state_json) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json`,
      JSON.stringify(state),
    );
  }

  private assertAccess(
    state: InstallationState,
    browserBindingHash: string,
  ): void {
    if (!timingSafeEqual(state.browserBindingHash, browserBindingHash))
      throw new Error("SESSION_ACCESS_DENIED");
  }

  private sessionTtlMs(): number {
    return Number(this.env.SESSION_TTL_SECONDS) * 1_000;
  }

  private metadataTtlMs(): number {
    return Number(this.env.METADATA_TTL_SECONDS) * 1_000;
  }

  private async touch(state: InstallationState, now: number): Promise<void> {
    if (state.completedAt) {
      state.expiresAt = state.completedAt + this.metadataTtlMs();
    } else {
      state.expiresAt = now + this.sessionTtlMs();
    }
    state.updatedAt = now;
    this.save(state);
    await this.ctx.storage.setAlarm(state.expiresAt);
  }

  async initialize(initial: InstallationState): Promise<InstallationState> {
    const current = this.load();
    if (current) return current;
    if (initial.status !== "created") throw new Error("INVALID_INITIAL_STATE");
    await this.touch(initial, initial.createdAt);
    return initial;
  }

  async getState(
    browserBindingHash: string,
    now = Date.now(),
  ): Promise<InstallationState> {
    const state = this.load();
    if (!state) throw new Error("INSTALLATION_NOT_FOUND");
    this.assertAccess(state, browserBindingHash);
    if (state.expiresAt <= now) throw new Error("INSTALLATION_EXPIRED");
    await this.touch(state, now);
    return state;
  }

  async authorize(
    browserBindingHash: string,
    now = Date.now(),
  ): Promise<InstallationState> {
    const state = this.load();
    if (!state) throw new Error("INSTALLATION_NOT_FOUND");
    this.assertAccess(state, browserBindingHash);
    if (
      state.status === "created" ||
      state.status === "authorization_required"
    ) {
      state.status = state.resumeStatus ?? "oauth_authorized";
      delete state.resumeStatus;
      delete state.error;
    }
    await this.touch(state, now);
    return state;
  }

  async configure(
    browserBindingHash: string,
    configuration: InstallationConfiguration,
    now = Date.now(),
  ): Promise<InstallationState> {
    const state = this.load();
    if (!state) throw new Error("INSTALLATION_NOT_FOUND");
    this.assertAccess(state, browserBindingHash);
    if (state.status !== "oauth_authorized" && state.status !== "configured")
      throw new Error("INSTALLATION_NOT_CONFIGURABLE");
    state.configuration = configuration;
    state.status = "configured";
    delete state.error;
    await this.touch(state, now);
    return state;
  }

  async replaceNames(
    browserBindingHash: string,
    names: InstallationState["names"],
    now = Date.now(),
  ): Promise<InstallationState> {
    const state = this.load();
    if (!state) throw new Error("INSTALLATION_NOT_FOUND");
    this.assertAccess(state, browserBindingHash);
    if (state.status !== "configured" || Object.keys(state.resources).length)
      throw new Error("RESOURCE_NAMES_LOCKED");
    state.names = names;
    await this.touch(state, now);
    return state;
  }

  async authorizationRequired(
    browserBindingHash: string,
    error: InstallationError,
    now = Date.now(),
  ): Promise<InstallationState> {
    const state = this.load();
    if (!state) throw new Error("INSTALLATION_NOT_FOUND");
    this.assertAccess(state, browserBindingHash);
    if (state.status !== "completed" && state.status !== "cancelled") {
      state.resumeStatus = state.status;
      state.status = "authorization_required";
      state.error = error;
      delete state.leaseId;
      delete state.leaseUntil;
    }
    await this.touch(state, now);
    return state;
  }

  async beginStep(
    browserBindingHash: string,
    now = Date.now(),
  ): Promise<StepLease> {
    const state = this.load();
    if (!state) throw new Error("INSTALLATION_NOT_FOUND");
    this.assertAccess(state, browserBindingHash);
    if (state.leaseUntil && state.leaseUntil > now)
      return { acquired: false, state };
    if (
      state.status === "failed" ||
      state.status === "authorization_required" ||
      state.status === "runtime_token_required" ||
      state.status === "completed" ||
      state.status === "cancelled"
    )
      return { acquired: false, state };
    const leaseId = crypto.randomUUID();
    state.leaseId = leaseId;
    state.leaseUntil = now + 45_000;
    state.attempts[state.status] = (state.attempts[state.status] ?? 0) + 1;
    await this.touch(state, now);
    return { acquired: true, leaseId, state };
  }

  async completeStep(
    browserBindingHash: string,
    leaseId: string,
    nextStatus: InstallationStatus,
    patch: CompletionPatch = {},
    now = Date.now(),
  ): Promise<InstallationState> {
    const state = this.load();
    if (!state) throw new Error("INSTALLATION_NOT_FOUND");
    this.assertAccess(state, browserBindingHash);
    if (!timingSafeEqual(state.leaseId ?? "", leaseId))
      throw new Error("STEP_LEASE_MISMATCH");
    state.status = nextStatus;
    delete state.leaseId;
    delete state.leaseUntil;
    delete state.error;
    if (patch.resources)
      state.resources = { ...state.resources, ...patch.resources };
    if (patch.releaseVersion) state.releaseVersion = patch.releaseVersion;
    if (patch.releaseManifestHash)
      state.releaseManifestHash = patch.releaseManifestHash;
    if (patch.finalUrl) state.finalUrl = patch.finalUrl;
    if (nextStatus === "completed") state.completedAt = now;
    await this.touch(state, now);
    return state;
  }

  async failStep(
    browserBindingHash: string,
    leaseId: string,
    error: InstallationError,
    authorizationRequired = false,
    now = Date.now(),
  ): Promise<InstallationState> {
    const state = this.load();
    if (!state) throw new Error("INSTALLATION_NOT_FOUND");
    this.assertAccess(state, browserBindingHash);
    if (!timingSafeEqual(state.leaseId ?? "", leaseId))
      throw new Error("STEP_LEASE_MISMATCH");
    state.resumeStatus = state.status;
    state.status = authorizationRequired ? "authorization_required" : "failed";
    state.error = error;
    delete state.leaseId;
    delete state.leaseUntil;
    await this.touch(state, now);
    return state;
  }

  async deferRuntimeCredential(
    browserBindingHash: string,
    now = Date.now(),
  ): Promise<InstallationState> {
    const state = this.load();
    if (!state) throw new Error("INSTALLATION_NOT_FOUND");
    this.assertAccess(state, browserBindingHash);
    if (state.status !== "runtime_token_required")
      throw new Error("RUNTIME_CREDENTIAL_NOT_EXPECTED");
    state.status = "runtime_token_created";
    delete state.resumeStatus;
    delete state.error;
    await this.touch(state, now);
    return state;
  }

  async retry(
    browserBindingHash: string,
    now = Date.now(),
  ): Promise<InstallationState> {
    const state = this.load();
    if (!state) throw new Error("INSTALLATION_NOT_FOUND");
    this.assertAccess(state, browserBindingHash);
    if (
      state.status !== "failed" ||
      !state.resumeStatus ||
      !state.error?.retryable
    )
      throw new Error("INSTALLATION_NOT_RETRYABLE");
    state.status = state.resumeStatus;
    delete state.resumeStatus;
    delete state.error;
    await this.touch(state, now);
    return state;
  }

  async cancel(
    browserBindingHash: string,
    now = Date.now(),
  ): Promise<InstallationState> {
    const state = this.load();
    if (!state) throw new Error("INSTALLATION_NOT_FOUND");
    this.assertAccess(state, browserBindingHash);
    if (state.status !== "completed") state.status = "cancelled";
    delete state.leaseId;
    delete state.leaseUntil;
    delete state.error;
    await this.touch(state, now);
    return state;
  }

  async report(browserBindingHash: string): Promise<InstallationReport> {
    const state = await this.getState(browserBindingHash);
    const accountId = state.configuration?.accountId;
    return {
      installationId: state.installationId,
      ...(state.releaseVersion ? { releaseVersion: state.releaseVersion } : {}),
      ...(state.releaseManifestHash
        ? { releaseManifestHash: state.releaseManifestHash }
        : {}),
      status: state.status,
      createdAt: new Date(state.createdAt).toISOString(),
      ...(state.completedAt
        ? { completedAt: new Date(state.completedAt).toISOString() }
        : {}),
      ...(accountId
        ? { accountIdMasked: `${accountId.slice(0, 6)}…${accountId.slice(-4)}` }
        : {}),
      resources: {
        worker: state.names.worker,
        database: state.names.database,
        queue: state.names.queue,
        deadLetterQueue: state.names.deadLetterQueue,
        ...(state.resources.databaseId
          ? { databaseId: state.resources.databaseId }
          : {}),
        ...(state.resources.queueId
          ? { queueId: state.resources.queueId }
          : {}),
        ...(state.resources.deadLetterQueueId
          ? { deadLetterQueueId: state.resources.deadLetterQueueId }
          : {}),
      },
      ...(state.finalUrl ? { finalUrl: state.finalUrl } : {}),
      ...(state.error ? { error: state.error } : {}),
    };
  }

  async alarm(): Promise<void> {
    const state = this.load();
    if (!state) return;
    if (state.expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(state.expiresAt);
      return;
    }
    this.ctx.storage.sql.exec("DELETE FROM installation_state");
  }
}
