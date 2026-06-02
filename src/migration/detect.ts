/**
 * Detect leftover chat4000 **v1** (custom-relay) on-disk state for an account.
 *
 * v1 stored:
 *   ~/.openclaw/plugins/chat4000/keys/<account>.json     32-byte group key
 *   ~/.openclaw/plugins/chat4000/state/<account>.sqlite  ack watermark + dedupe
 *
 * v2 replaces those with credentials/<account>.json + state/<account>/ (a dir).
 * Presence of the v1 key file or sqlite is the migration trigger.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveChat4000PluginDir } from "../paths.js";

export type V1StateDetection = {
  present: boolean;
  keyFile?: string | undefined;
  sqliteFile?: string | undefined;
  /** All v1 paths that exist (for snapshotting). */
  paths: string[];
};

function normalizeAccountId(accountId: string | undefined): string {
  return (accountId ?? "default").trim() || "default";
}

export function detectV1State(accountId: string): V1StateDetection {
  const acct = normalizeAccountId(accountId);
  const pluginDir = resolveChat4000PluginDir();
  const keyFile = path.join(pluginDir, "keys", `${acct}.json`);
  const sqliteFile = path.join(pluginDir, "state", `${acct}.sqlite`);

  const paths: string[] = [];
  let present = false;
  if (existsSync(keyFile)) {
    paths.push(keyFile);
    present = true;
  }
  for (const sibling of [sqliteFile, `${sqliteFile}-wal`, `${sqliteFile}-shm`]) {
    if (existsSync(sibling)) {
      paths.push(sibling);
      present = true;
    }
  }

  return {
    present,
    keyFile: existsSync(keyFile) ? keyFile : undefined,
    sqliteFile: existsSync(sqliteFile) ? sqliteFile : undefined,
    paths,
  };
}
