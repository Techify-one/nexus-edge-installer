import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const objectKeySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/") && !value.includes(".."));
const relativePathSchema = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !value.startsWith("/") && !value.includes(".."));
const semanticVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
const compatibilityDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(
    (value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)),
    "Invalid compatibility date",
  );

export const releaseObjectSchema = z
  .object({
    path: relativePathSchema,
    objectKey: objectKeySchema,
    mimeType: z.string().min(1).max(160),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(50 * 1024 * 1024),
    sha256: sha256Schema,
  })
  .strict();

export const releaseAssetSchema = releaseObjectSchema
  .extend({
    uploadHash: z.string().regex(/^[a-f0-9]{32}$/u),
  })
  .strict();

export const releaseMigrationSchema = releaseObjectSchema
  .extend({
    id: z.string().regex(/^\d{4}_[a-z0-9_]+$/u),
    statementCount: z.number().int().positive().max(2_000),
  })
  .strict();

export const installerReleaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    appVersion: semanticVersionSchema,
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    createdAt: z.iso.datetime({ offset: true }),
    compatibilityDate: compatibilityDateSchema,
    compatibilityFlags: z.array(z.string().min(1).max(100)).max(20),
    entrypoint: relativePathSchema,
    modules: z.array(releaseObjectSchema).min(1).max(100),
    assets: z.array(releaseAssetSchema).min(1).max(20_000),
    d1Migrations: z.array(releaseMigrationSchema).min(1).max(1_000),
    databaseSchemaVersion: z
      .number()
      .int()
      .positive()
      .max(1_000_000)
      .optional(),
    requiredBindings: z
      .array(z.enum(["ASSETS", "DB", "WEBHOOK_QUEUE"]))
      .min(3)
      .max(3),
    cron: z.array(z.string().min(1).max(100)).min(1).max(10),
    healthChecks: z.array(z.string().startsWith("/")).min(1).max(10),
    minimumInstallerVersion: semanticVersionSchema,
  })
  .strict()
  .superRefine((release, context) => {
    const paths = [
      ...release.modules.map((item) => item.path),
      ...release.assets.map((item) => item.path),
      ...release.d1Migrations.map((item) => item.path),
    ];
    if (new Set(paths).size !== paths.length)
      context.addIssue({
        code: "custom",
        message: "Release paths must be unique",
      });
    if (!release.modules.some((item) => item.path === release.entrypoint))
      context.addIssue({
        code: "custom",
        message: "Entrypoint must reference a release module",
        path: ["entrypoint"],
      });
    if (new Set(release.requiredBindings).size !== 3)
      context.addIssue({
        code: "custom",
        message: "Required bindings must be unique",
        path: ["requiredBindings"],
      });
  });

export const migrationArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^\d{4}_[a-z0-9_]+$/u),
    sourceSha256: sha256Schema,
    statements: z.array(z.string().min(1).max(250_000)).min(1).max(2_000),
  })
  .strict();

export const stableReleasePointerSchema = z
  .object({
    schemaVersion: z.literal(1),
    channel: z.literal("stable"),
    version: semanticVersionSchema,
    manifestObjectKey: objectKeySchema,
    manifestSha256: sha256Schema,
    signatureObjectKey: objectKeySchema,
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type InstallerRelease = z.infer<typeof installerReleaseSchema>;
export type MigrationArtifact = z.infer<typeof migrationArtifactSchema>;
export type ReleaseAsset = z.infer<typeof releaseAssetSchema>;
export type ReleaseObject = z.infer<typeof releaseObjectSchema>;
export type StableReleasePointer = z.infer<typeof stableReleasePointerSchema>;

export const workerModuleContentTypes = [
  "application/javascript+module",
  "application/wasm",
  "text/plain",
  "application/octet-stream",
] as const;
export type WorkerModuleContentType = (typeof workerModuleContentTypes)[number];
const workerModuleContentTypeSet = new Set<string>(workerModuleContentTypes);

export function isWorkerModuleContentType(
  value: string,
): value is WorkerModuleContentType {
  return workerModuleContentTypeSet.has(value);
}

export function workerModuleContentType(
  path: string,
): WorkerModuleContentType | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".mjs"))
    return "application/javascript+module";
  if (lower.endsWith(".wasm")) return "application/wasm";
  if (
    lower.endsWith(".txt") ||
    lower.endsWith(".html") ||
    lower.endsWith(".sql")
  )
    return "text/plain";
  if (lower.endsWith(".bin")) return "application/octet-stream";
  return undefined;
}

function normalizeCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeCanonical(entry)]),
    );
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  throw new TypeError("Canonical JSON accepts only finite JSON values");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonical(value));
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (!quote && character === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!quote && character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote && next === quote) {
        current += next;
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      current += character;
    } else if (character === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (quote || blockComment)
    throw new Error("Unterminated SQL literal or comment");
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function verifyReleaseSignature(
  release: InstallerRelease,
  signatureBase64: string,
  publicKeySpkiBase64: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "spki",
    decodeBase64(publicKeySpkiBase64),
    "Ed25519",
    false,
    ["verify"],
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(release)),
  );
  return crypto.subtle.verify(
    "Ed25519",
    key,
    decodeBase64(signatureBase64),
    digest,
  );
}
