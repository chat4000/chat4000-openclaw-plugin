/**
 * Filesystem path resolution for chat4000 plugin state.
 *
 * In v2 the plugin stores Matrix credentials + the per-account crypto/sync
 * stores under the OpenClaw home, replacing the v1 group-key files.
 *
 *   ~/.openclaw/plugins/chat4000/
 *     credentials/<account>.json     Matrix session (userId, accessToken, deviceId), 0600
 *     state/<account>/               matrix-js-sdk sync store + Rust crypto store
 *     logs/                          runtime.log, pairing.log, errors.log
 *     session-bindings.json          room <-> OpenClaw session links
 *
 * Replaces the path helpers that lived in the deleted v1 `key-store.ts`
 * (`resolveOpenClawHome`, `resolveOpenClawHomeDir`, `resolveOpenClawStateDir`).
 */
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR_ENV = "OPENCLAW_STATE_DIR";
const HOME_DIR_ENV = "OPENCLAW_HOME";

/** The user's OS home dir (or `OPENCLAW_HOME` override). */
export function resolveOpenClawHomeDir(): string {
  return process.env[HOME_DIR_ENV]?.trim() || os.homedir();
}

/** The OpenClaw state dir, `~/.openclaw` (or `OPENCLAW_STATE_DIR` override). */
export function resolveOpenClawStateDir(): string {
  const explicit = process.env[STATE_DIR_ENV]?.trim();
  if (explicit) {
    return explicit;
  }
  return path.join(resolveOpenClawHomeDir(), ".openclaw");
}

/**
 * Back-compat alias. v1 modules called `resolveOpenClawHome()` expecting the
 * **state** dir (`~/.openclaw`), not the OS home. Keep that meaning.
 */
export function resolveOpenClawHome(): string {
  return resolveOpenClawStateDir();
}

/** `~/.openclaw/plugins/chat4000`. */
export function resolveChat4000PluginDir(): string {
  return path.join(resolveOpenClawStateDir(), "plugins", "chat4000");
}

function normalizeAccountId(accountId: string | undefined): string {
  return (accountId ?? "default").trim() || "default";
}

/** `~/.openclaw/plugins/chat4000/credentials/<account>.json`. */
export function resolveChat4000CredentialsPath(accountId: string): string {
  return path.join(
    resolveChat4000PluginDir(),
    "credentials",
    `${normalizeAccountId(accountId)}.json`,
  );
}

/** `~/.openclaw/plugins/chat4000/state/<account>` — matrix-js-sdk + crypto stores. */
export function resolveChat4000AccountStateDir(accountId: string): string {
  return path.join(resolveChat4000PluginDir(), "state", normalizeAccountId(accountId));
}

/**
 * `~/.openclaw/plugins/chat4000/update-marker.json` — plugin-global self-update
 * boot marker used to auto-roll-back a version that fails to come up healthy.
 */
export function resolveChat4000UpdateMarkerPath(): string {
  return path.join(resolveChat4000PluginDir(), "update-marker.json");
}

/** Ensure a directory exists, returning it. */
export function ensureDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
