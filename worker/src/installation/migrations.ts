import type { InstallerRelease } from "@app/installer-release-schema";
import { CloudflareApiClient } from "../cloudflare/client.js";
import { queryDatabase, type D1QueryResult } from "../cloudflare/resources.js";
import { readMigration } from "../release/reader.js";

const controls = [
  `CREATE TABLE IF NOT EXISTS d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nexus_release_migrations(
    name TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`,
];

const legacyDatabaseSchemaVersion = 1;

export function releaseDatabaseSchemaVersion(
  release: Pick<InstallerRelease, "databaseSchemaVersion">,
): number {
  return release.databaseSchemaVersion ?? legacyDatabaseSchemaVersion;
}

function rows(
  result: D1QueryResult | D1QueryResult[],
): Array<Record<string, unknown>> {
  const entries = Array.isArray(result) ? result : [result];
  return entries.flatMap((entry) => entry.results ?? []);
}

export async function synchronizeInstallationSettings(
  client: CloudflareApiClient,
  accountId: string,
  databaseId: string,
  installationId: string,
  schemaVersion: number,
): Promise<void> {
  await queryDatabase(client, accountId, databaseId, [
    {
      sql: `INSERT OR IGNORE INTO app_settings(
              id, installation_id, database_provider, schema_version, bootstrap_state
            ) VALUES ('system', ?, 'd1', ?, 'open')`,
      params: [installationId, schemaVersion],
    },
    {
      sql: `UPDATE app_settings
            SET schema_version = ?
            WHERE id = 'system' AND installation_id = ?
              AND database_provider = 'd1' AND bootstrap_state = 'open'`,
      params: [schemaVersion, installationId],
    },
  ]);

  const verification = rows(
    await queryDatabase(client, accountId, databaseId, {
      sql: `SELECT installation_id, database_provider, schema_version, bootstrap_state
       FROM app_settings WHERE id = 'system'`,
    }),
  )[0];
  if (
    verification?.installation_id !== installationId ||
    verification.database_provider !== "d1" ||
    verification.schema_version !== schemaVersion ||
    verification.bootstrap_state !== "open"
  )
    throw new Error("SCHEMA_VERIFICATION_FAILED");
}

export async function applyReleaseMigrations(
  env: Env,
  client: CloudflareApiClient,
  accountId: string,
  databaseId: string,
  installationId: string,
  release: InstallerRelease,
): Promise<void> {
  await queryDatabase(
    client,
    accountId,
    databaseId,
    controls.map((sql) => ({ sql })),
  );
  const appliedRows = rows(
    await queryDatabase(client, accountId, databaseId, {
      sql: `SELECT d.name, h.sha256
       FROM d1_migrations d
       LEFT JOIN nexus_release_migrations h ON h.name = d.name
       ORDER BY d.id`,
    }),
  );
  const applied = new Map(
    appliedRows.map((row) => [
      String(row.name),
      row.sha256 ? String(row.sha256) : undefined,
    ]),
  );

  for (const [ordinal, descriptor] of release.d1Migrations.entries()) {
    const artifact = await readMigration(env, descriptor);
    const migrationName = `${artifact.id}.sql`;
    const priorHash = applied.get(migrationName);
    if (applied.has(migrationName)) {
      if (priorHash !== artifact.sourceSha256)
        throw new Error(`MIGRATION_HASH_MISMATCH:${migrationName}`);
      continue;
    }
    const queries = [
      ...artifact.statements.map((sql) => ({ sql })),
      {
        sql: "INSERT INTO d1_migrations(name) VALUES (?)",
        params: [migrationName],
      },
      {
        sql: `INSERT INTO nexus_release_migrations(name, ordinal, sha256)
              VALUES (?, ?, ?)`,
        params: [migrationName, ordinal + 1, artifact.sourceSha256],
      },
    ];
    const result = await queryDatabase(client, accountId, databaseId, queries);
    const outcomes = Array.isArray(result) ? result : [result];
    if (outcomes.some((entry) => !entry.success))
      throw new Error(`MIGRATION_FAILED:${migrationName}`);
  }

  await synchronizeInstallationSettings(
    client,
    accountId,
    databaseId,
    installationId,
    releaseDatabaseSchemaVersion(release),
  );
}
