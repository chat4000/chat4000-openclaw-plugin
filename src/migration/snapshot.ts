/**
 * Pre-migration snapshot.
 *
 * Mirrors OpenClaw's own Matrix-migration safety model: before mutating any
 * state, copy the v1 files into a timestamped archive under
 * ~/Backups/openclaw-migrations/ and drop a marker. If the snapshot can't be
 * created, the caller must abort the migration rather than mutate without a
 * recovery point.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveOpenClawHomeDir } from "../paths.js";

export type SnapshotResult = {
  ok: boolean;
  archiveDir: string;
  copied: string[];
  error?: string;
};

function snapshotRoot(): string {
  return path.join(resolveOpenClawHomeDir(), "Backups", "openclaw-migrations");
}

function timestampSlug(): string {
  // Plain plugin runtime — Date is fine here (not a workflow script).
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function createV1MigrationSnapshot(params: {
  accountId: string;
  paths: string[];
}): SnapshotResult {
  const archiveDir = path.join(
    snapshotRoot(),
    `chat4000-v1-${params.accountId}-${timestampSlug()}`,
  );
  const copied: string[] = [];
  try {
    mkdirSync(archiveDir, { recursive: true });
    for (const src of params.paths) {
      if (!existsSync(src)) continue;
      const dest = path.join(archiveDir, path.basename(src));
      copyFileSync(src, dest);
      copied.push(dest);
    }
    writeFileSync(
      path.join(archiveDir, "MIGRATION.json"),
      `${JSON.stringify(
        {
          kind: "chat4000-v1-to-v2",
          accountId: params.accountId,
          createdAt: new Date().toISOString(),
          sources: params.paths,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return { ok: true, archiveDir, copied };
  } catch (err) {
    return { ok: false, archiveDir, copied, error: String(err) };
  }
}
