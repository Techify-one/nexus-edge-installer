import {
  canonicalJson,
  installerReleaseSchema,
  migrationArtifactSchema,
  stableReleasePointerSchema,
  verifyReleaseSignatureWithKeys,
  type InstallerRelease,
  type MigrationArtifact,
  type ReleaseObject,
} from "@app/installer-release-schema";
import { sha256Hex } from "../security/encoding.js";

const maximumManifestSize = 2 * 1024 * 1024;

async function objectBytes(
  bucket: R2Bucket,
  key: string,
  maximumSize: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const object = await bucket.get(key);
  if (!object) throw new Error("RELEASE_OBJECT_NOT_FOUND");
  if (object.size > maximumSize) throw new Error("RELEASE_OBJECT_TOO_LARGE");
  const buffer = await object.arrayBuffer();
  if (buffer.byteLength > maximumSize)
    throw new Error("RELEASE_OBJECT_TOO_LARGE");
  return new Uint8Array(buffer);
}

async function objectText(
  bucket: R2Bucket,
  key: string,
  maximumSize: number,
): Promise<string> {
  return new TextDecoder().decode(await objectBytes(bucket, key, maximumSize));
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .split("-", 1)[0]!
      .split(".")
      .map((part) => Number(part));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export type VerifiedRelease = {
  release: InstallerRelease;
  manifestHash: string;
};

export async function readVerifiedRelease(env: Env): Promise<VerifiedRelease> {
  const pointer = stableReleasePointerSchema.parse(
    JSON.parse(
      await objectText(
        env.RELEASES,
        `releases/${env.RELEASE_CHANNEL}.json`,
        32_000,
      ),
    ),
  );
  const release = installerReleaseSchema.parse(
    JSON.parse(
      await objectText(
        env.RELEASES,
        pointer.manifestObjectKey,
        maximumManifestSize,
      ),
    ),
  );
  const canonical = canonicalJson(release);
  const manifestHash = await sha256Hex(canonical);
  if (manifestHash !== pointer.manifestSha256)
    throw new Error("RELEASE_MANIFEST_HASH_MISMATCH");
  const signature = (
    await objectText(env.RELEASES, pointer.signatureObjectKey, 4_096)
  ).trim();
  if (
    !(await verifyReleaseSignatureWithKeys(release, signature, [
      env.RELEASE_PUBLIC_KEY,
      env.RELEASE_PUBLIC_KEY_NEXT,
    ]))
  )
    throw new Error("RELEASE_SIGNATURE_INVALID");
  if (
    compareVersions(env.INSTALLER_VERSION, release.minimumInstallerVersion) < 0
  )
    throw new Error("INSTALLER_VERSION_TOO_OLD");
  if (release.appVersion !== pointer.version)
    throw new Error("RELEASE_POINTER_VERSION_MISMATCH");
  return { release, manifestHash };
}

export async function readVerifiedObject(
  env: Env,
  descriptor: ReleaseObject,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await objectBytes(
    env.RELEASES,
    descriptor.objectKey,
    descriptor.size,
  );
  if (
    bytes.byteLength !== descriptor.size ||
    (await sha256Hex(bytes)) !== descriptor.sha256
  )
    throw new Error("RELEASE_OBJECT_HASH_MISMATCH");
  return bytes;
}

export async function readMigration(
  env: Env,
  descriptor: InstallerRelease["d1Migrations"][number],
): Promise<MigrationArtifact> {
  const artifact = migrationArtifactSchema.parse(
    JSON.parse(
      new TextDecoder().decode(await readVerifiedObject(env, descriptor)),
    ),
  );
  if (
    artifact.id !== descriptor.id ||
    artifact.statements.length !== descriptor.statementCount
  )
    throw new Error("RELEASE_MIGRATION_DESCRIPTOR_MISMATCH");
  return artifact;
}
