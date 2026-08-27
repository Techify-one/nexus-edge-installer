import { useEffect, useMemo, useState } from "react";
import { installerApi, InstallerApiError } from "./api.js";
import { useI18n } from "./i18n.js";
import type {
  Account,
  Installation,
  InstallationStatus,
  Zone,
} from "./types.js";

const statusOrder: InstallationStatus[] = [
  "created",
  "oauth_authorized",
  "configured",
  "preflight_complete",
  "release_verified",
  "d1_created",
  "migrations_applied",
  "queues_created",
  "runtime_token_created",
  "worker_uploaded",
  "worker_route_enabled",
  "cron_configured",
  "queue_consumer_configured",
  "waiting_for_domain",
  "custom_domain_attached",
  "health_verified",
  "oauth_revoked",
  "completed",
];

type Stage = {
  label: string;
  completedAt: InstallationStatus;
};

function statusIndex(
  status: InstallationStatus,
  resume?: InstallationStatus,
): number {
  const effective =
    status === "runtime_token_required"
      ? "queues_created"
      : status === "failed" || status === "authorization_required"
        ? resume
        : status;
  return effective ? statusOrder.indexOf(effective) : -1;
}

function Panel({
  children,
  className = "",
  ...props
}: React.ComponentPropsWithoutRef<"section">) {
  return (
    <section className={`panel ${className}`} {...props}>
      {children}
    </section>
  );
}

export function App() {
  const { t, locale, toggle } = useI18n();
  const initialId = new URLSearchParams(location.search).get("installation");
  const [installationIdValue, setInstallationId] = useState(initialId);
  const [installation, setInstallation] = useState<Installation>();
  const [csrfToken, setCsrfToken] = useState<string>();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [releaseVersion, setReleaseVersion] = useState<string>();
  const [busy, setBusy] = useState(Boolean(initialId));
  const [installing, setInstalling] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<{ code: string; requestId?: string }>();
  const [accountId, setAccountId] = useState("");
  const [displayName, setDisplayName] = useState("Nexus Edge");
  const [addressMode, setAddressMode] = useState<
    "workers_dev" | "custom_domain"
  >("workers_dev");
  const [zoneId, setZoneId] = useState("");
  const [prefix, setPrefix] = useState("nexus");
  const [nextDelayMs, setNextDelayMs] = useState(350);

  const stages = useMemo<Stage[]>(
    () => [
      { label: t("stagePreflight"), completedAt: "preflight_complete" },
      { label: t("stageRelease"), completedAt: "release_verified" },
      { label: t("stageDatabase"), completedAt: "d1_created" },
      { label: t("stageMigrations"), completedAt: "migrations_applied" },
      { label: t("stageQueues"), completedAt: "queues_created" },
      { label: t("stageCredential"), completedAt: "runtime_token_created" },
      { label: t("stageWorker"), completedAt: "worker_route_enabled" },
      { label: t("stageCron"), completedAt: "queue_consumer_configured" },
      { label: t("stageDomain"), completedAt: "custom_domain_attached" },
      { label: t("stageHealth"), completedAt: "health_verified" },
      { label: t("stageRevoke"), completedAt: "completed" },
    ],
    [locale],
  );

  const captureError = (caught: unknown): void => {
    setBusy(false);
    if (caught instanceof InstallerApiError)
      setError({
        code: caught.code,
        ...(caught.requestId ? { requestId: caught.requestId } : {}),
      });
    else setError({ code: "INTERNAL_ERROR" });
  };

  useEffect(() => {
    installerApi
      .stableRelease()
      .then((release) => setReleaseVersion(release.version))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!installationIdValue) return;
    setBusy(true);
    installerApi
      .status(installationIdValue)
      .then(({ installation: state, csrfToken: csrf }) => {
        setInstallation(state);
        setCsrfToken(csrf);
        setInstalling(
          statusIndex(state.status, state.resumeStatus) >
            statusOrder.indexOf("configured"),
        );
        if (state.configuration) {
          setAccountId(state.configuration.accountId);
          setDisplayName(state.configuration.displayName);
          setAddressMode(state.configuration.addressMode);
          setZoneId(state.configuration.zoneId ?? "");
          setPrefix(
            state.configuration.customHostname?.split(".", 1)[0] ?? "nexus",
          );
        }
      })
      .catch(captureError)
      .finally(() => setBusy(false));
  }, [installationIdValue]);

  useEffect(() => {
    if (installation?.status !== "oauth_authorized" || accounts.length) return;
    installerApi
      .accounts()
      .then(({ accounts: available }) => {
        setAccounts(available);
        if (available.length === 1) setAccountId(available[0]!.id);
      })
      .catch(captureError);
  }, [installation?.status]);

  useEffect(() => {
    if (addressMode !== "custom_domain" || !accountId) return;
    installerApi
      .zones(accountId)
      .then(({ zones: available }) => {
        setZones(available);
        if (available.length === 1) setZoneId(available[0]!.id);
      })
      .catch(captureError);
  }, [addressMode, accountId]);

  useEffect(() => {
    if (
      !installing ||
      !installation ||
      !installationIdValue ||
      !csrfToken ||
      [
        "completed",
        "failed",
        "authorization_required",
        "runtime_token_required",
        "cancelled",
      ].includes(installation.status)
    )
      return;
    const timer = window.setTimeout(() => {
      installerApi
        .next(installationIdValue, csrfToken)
        .then(({ installation: state, nextDelayMs: requestedDelay }) => {
          setInstallation(state);
          setNextDelayMs(requestedDelay ?? 350);
        })
        .catch(captureError);
    }, nextDelayMs);
    return () => window.clearTimeout(timer);
  }, [installation, installing, installationIdValue, csrfToken, nextDelayMs]);

  // Sessions created by the previous release can be paused at the former
  // token screen. Resume them silently; new sessions never enter this state.
  useEffect(() => {
    if (
      installation?.status !== "runtime_token_required" ||
      !installationIdValue ||
      !csrfToken
    )
      return;
    setBusy(true);
    installerApi
      .deferRuntimeToken(installationIdValue, csrfToken)
      .then(({ installation: state }) => {
        setInstallation(state);
        setInstalling(true);
        setError(undefined);
      })
      .catch(captureError)
      .finally(() => setBusy(false));
  }, [installation?.status, installationIdValue, csrfToken]);

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await installerApi.start();
      setInstallationId(result.installationId);
      location.assign(result.authorizationUrl);
    } catch (caught) {
      captureError(caught);
    }
  };

  const configure = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!installationIdValue || !csrfToken) return;
    setBusy(true);
    setError(undefined);
    try {
      const zone = zones.find((item) => item.id === zoneId);
      const result = await installerApi.configure(
        installationIdValue,
        csrfToken,
        {
          accountId,
          displayName,
          addressMode,
          ...(addressMode === "custom_domain" && zone
            ? { zoneId, customHostname: `${prefix}.${zone.name}`.toLowerCase() }
            : {}),
        },
      );
      setInstallation(result.installation);
      setEditing(false);
    } catch (caught) {
      captureError(caught);
    } finally {
      setBusy(false);
    }
  };

  const retry = async (): Promise<void> => {
    if (!installationIdValue || !csrfToken) return;
    setBusy(true);
    try {
      const result = await installerApi.retry(installationIdValue, csrfToken);
      setInstallation(result.installation);
      setInstalling(true);
      setError(undefined);
    } catch (caught) {
      captureError(caught);
    } finally {
      setBusy(false);
    }
  };

  const reauthorize = async (): Promise<void> => {
    if (!installationIdValue || !csrfToken) return;
    setBusy(true);
    try {
      const result = await installerApi.reauthorize(
        installationIdValue,
        csrfToken,
      );
      location.assign(result.authorizationUrl);
    } catch (caught) {
      captureError(caught);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!installationIdValue || !csrfToken) return;
    setBusy(true);
    try {
      await installerApi.cancel(installationIdValue, csrfToken);
      location.assign("/");
    } catch (caught) {
      captureError(caught);
    }
  };

  const selectedZone = zones.find((zone) => zone.id === zoneId);
  const currentIndex = installation
    ? statusIndex(installation.status, installation.resumeStatus)
    : -1;
  const d1LimitReached =
    installation?.error?.code === "D1_DATABASE_LIMIT_REACHED";
  const d1DashboardUrl = installation?.configuration?.accountId
    ? `https://dash.cloudflare.com/${installation.configuration.accountId}/workers/d1`
    : "https://dash.cloudflare.com/?to=/:account/workers/d1";
  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label={t("brand")}>
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span>
            <strong>{t("brand")}</strong>
            <small>{t("installer")}</small>
          </span>
        </a>
        <button className="button ghost" type="button" onClick={toggle}>
          {t("language")}
        </button>
      </header>

      {error && (
        <div className="alert error" role="alert">
          <strong>{t("genericError")}</strong>
          <span>{error.code}</span>
          {error.requestId && (
            <small>
              {t("requestId")}: {error.requestId}
            </small>
          )}
        </div>
      )}

      {!installationIdValue && (
        <div className="hero-grid">
          <section className="hero">
            <span className="eyebrow">{t("eyebrow")}</span>
            <h1>{t("introTitle")}</h1>
            <p>{t("introBody")}</p>
            <button
              className="button primary large"
              type="button"
              disabled={busy}
              onClick={start}
            >
              {busy ? t("loading") : t("signIn")}
            </button>
            {releaseVersion && (
              <small>
                {t("release")}: {releaseVersion}
              </small>
            )}
          </section>
          <div className="stack">
            <Panel>
              <h2>{t("creates")}</h2>
              <p>{t("createsBody")}</p>
            </Panel>
            <Panel className="privacy" id="privacy">
              <h2>{t("privacy")}</h2>
              <p>{t("privacyBody")}</p>
            </Panel>
            <a
              className="source-link"
              href="https://github.com/Techify-one/nexus-edge"
              rel="noreferrer"
            >
              {t("source")} ↗
            </a>
          </div>
        </div>
      )}

      {installationIdValue && busy && !installation && (
        <Panel className="center">
          <div className="spinner" aria-hidden="true" />
          <h1>{t("connecting")}</h1>
        </Panel>
      )}

      {installation &&
        (installation.status === "oauth_authorized" || editing) && (
          <Panel className="form-panel">
            <div className="section-heading">
              <span className="step-number">1</span>
              <div>
                <h1>{t("configTitle")}</h1>
                <p>{t("introBody")}</p>
              </div>
            </div>
            <form onSubmit={configure}>
              <label>
                {t("account")}
                <select
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                  required
                >
                  <option value="">{t("select")}</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("displayName")}
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  minLength={2}
                  maxLength={80}
                  required
                />
              </label>
              <fieldset>
                <legend>{t("address")}</legend>
                <label className="choice">
                  <input
                    type="radio"
                    checked={addressMode === "workers_dev"}
                    onChange={() => setAddressMode("workers_dev")}
                  />{" "}
                  <span>
                    <strong>{t("workersDev")}</strong>
                    <small>{t("workersDevDetail")}</small>
                  </span>
                </label>
                <label className="choice">
                  <input
                    type="radio"
                    checked={addressMode === "custom_domain"}
                    onChange={() => setAddressMode("custom_domain")}
                  />{" "}
                  <span>
                    <strong>{t("customDomain")}</strong>
                    <small>{t("customDomainDetail")}</small>
                  </span>
                </label>
              </fieldset>
              {addressMode === "custom_domain" && (
                <div className="domain-grid">
                  <label>
                    {t("prefix")}
                    <input
                      value={prefix}
                      onChange={(event) =>
                        setPrefix(
                          event.target.value
                            .toLowerCase()
                            .replace(/[^a-z0-9-]/gu, ""),
                        )
                      }
                      required
                    />
                  </label>
                  <label>
                    {t("zone")}
                    <select
                      value={zoneId}
                      onChange={(event) => setZoneId(event.target.value)}
                      required
                    >
                      <option value="">{t("select")}</option>
                      {zones.map((zone) => (
                        <option key={zone.id} value={zone.id}>
                          {zone.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedZone && (
                    <output className="domain-preview">
                      https://{prefix}.{selectedZone.name}
                    </output>
                  )}
                </div>
              )}
              <div className="actions">
                <button
                  className="button primary"
                  disabled={busy}
                  type="submit"
                >
                  {busy ? t("loading") : t("continue")}
                </button>
              </div>
            </form>
          </Panel>
        )}

      {installation?.status === "configured" && !editing && !installing && (
        <Panel className="review-panel">
          <div className="section-heading">
            <span className="step-number">2</span>
            <div>
              <h1>{t("reviewTitle")}</h1>
              <p>{t("reviewBody")}</p>
            </div>
          </div>
          <dl className="review-list">
            <div>
              <dt>{t("account")}</dt>
              <dd>{installation.configuration?.accountName}</dd>
            </div>
            <div>
              <dt>{t("release")}</dt>
              <dd>{releaseVersion ?? "1.0.0"}</dd>
            </div>
            <div>
              <dt>{t("address")}</dt>
              <dd>
                {installation.configuration?.customHostname
                  ? `https://${installation.configuration.customHostname}`
                  : t("workersDev")}
              </dd>
            </div>
            <div>
              <dt>{t("resources")}</dt>
              <dd>
                {installation.names.worker}
                <br />
                {installation.names.database}
                <br />
                {installation.names.queue}
              </dd>
            </div>
          </dl>
          <div className="actions split">
            <button
              className="button ghost"
              type="button"
              onClick={() => setEditing(true)}
            >
              {t("back")}
            </button>
            <button
              className="button primary"
              type="button"
              onClick={() => setInstalling(true)}
            >
              {t("install")}
            </button>
          </div>
        </Panel>
      )}

      {installation && installing && installation.status !== "completed" && (
        <Panel className="progress-panel">
          <div className="section-heading">
            <span className="step-number">3</span>
            <div>
              <h1>{t("progressTitle")}</h1>
              <p>{t("progressBody")}</p>
            </div>
          </div>
          <ol className="progress-list">
            {stages.map((stage, index) => {
              const completedIndex = statusOrder.indexOf(stage.completedAt);
              const complete = currentIndex >= completedIndex;
              const active =
                !complete &&
                index ===
                  stages.findIndex(
                    (item) =>
                      currentIndex < statusOrder.indexOf(item.completedAt),
                  );
              const failed = active && installation.status === "failed";
              return (
                <li
                  className={
                    complete
                      ? "complete"
                      : active
                        ? failed
                          ? "stage-failed"
                          : "active"
                        : "pending"
                  }
                  key={stage.completedAt}
                >
                  <span className="status-dot" aria-hidden="true">
                    {complete ? "✓" : index + 1}
                  </span>
                  <span>{stage.label}</span>
                  <small>
                    {complete
                      ? t("done")
                      : active
                        ? failed
                          ? t("failed")
                          : t("running")
                        : t("pending")}
                  </small>
                </li>
              );
            })}
          </ol>

          {installation.status === "failed" &&
            installation.error?.retryable && (
              <button
                className="button primary"
                type="button"
                disabled={busy}
                onClick={retry}
              >
                {t("retry")}
              </button>
            )}
          {installation.status === "authorization_required" && (
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={reauthorize}
            >
              {t("reconnect")}
            </button>
          )}
          {installation.error && (
            <div className="alert error">
              <strong>{installation.error.code}</strong>
              <span>
                {d1LimitReached
                  ? t("d1LimitMessage")
                  : installation.error.message}
              </span>
              {d1LimitReached && (
                <>
                  <small>{t("d1LimitSteps")}</small>
                  <a
                    className="button ghost alert-action"
                    href={d1DashboardUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("openD1Dashboard")}
                  </a>
                </>
              )}
              <small>
                {t("requestId")}: {installation.error.requestId}
              </small>
            </div>
          )}
          {!["health_verified", "oauth_revoked"].includes(
            installation.status,
          ) && (
            <button
              className="button danger-link"
              type="button"
              disabled={busy}
              onClick={cancel}
            >
              {t("cancel")}
            </button>
          )}
        </Panel>
      )}

      {installation?.status === "completed" && (
        <Panel className="success-panel">
          <div className="success-icon" aria-hidden="true">
            ✓
          </div>
          <h1>{t("successTitle")}</h1>
          <p>{t("successBody")}</p>
          <a
            className="final-url"
            href={installation.finalUrl}
            rel="noreferrer"
          >
            {installation.finalUrl}
          </a>
          <div className="actions success-actions">
            <a
              className="button primary"
              href={`${installation.finalUrl}/setup`}
            >
              {t("createAdmin")}
            </a>
            <a
              className="button ghost"
              href={`/api/installations/${encodeURIComponent(installation.installationId)}/report`}
            >
              {t("downloadReport")}
            </a>
          </div>
        </Panel>
      )}
    </main>
  );
}
