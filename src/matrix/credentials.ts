/**
 * Read/write persisted Matrix credentials for a chat4000 account.
 *
 * Stored at ~/.openclaw/plugins/chat4000/credentials/<account>.json with 0600
 * perms. This is the v2 durable secret (replaces the v1 group-key file): it
 * holds the plugin bot's Matrix access token + device id.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { AppError } from "../app-error.js";
import { resolveChat4000CredentialsPath } from "../paths.js";
import type { MatrixCredentials } from "./types.js";

/**
 * Parse + validate a credentials-file blob into `MatrixCredentials`, as an
 * errors-as-values `Result` (Production Standards Rule 2). The on-disk shape is
 * untrusted JSON, so this is genuine domain validation rather than an exception
 * path.
 */
function parseMatrixCredentials(raw: string): Result<MatrixCredentials, AppError> {
  let parsed: (Partial<MatrixCredentials> & { homeserver?: string }) | undefined;
  try {
    parsed = JSON.parse(raw) as Partial<MatrixCredentials> & { homeserver?: string };
  } catch (cause) {
    return err({
      kind: "decode",
      message: cause instanceof Error ? cause.message : "invalid JSON",
    });
  }
  // `gatewayUrl` is the v2 field; fall back to a legacy `homeserver` value so an
  // older creds file still loads (the value is the connection URL either way).
  const gatewayUrl = typeof parsed.gatewayUrl === "string" ? parsed.gatewayUrl : parsed.homeserver;
  if (
    typeof gatewayUrl !== "string" ||
    typeof parsed.userId !== "string" ||
    typeof parsed.accessToken !== "string" ||
    typeof parsed.deviceId !== "string"
  ) {
    return err({ kind: "validation", message: "credentials file is missing required fields" });
  }
  return ok({
    gatewayUrl,
    userId: parsed.userId,
    accessToken: parsed.accessToken,
    deviceId: parsed.deviceId,
  });
}

export function loadMatrixCredentials(accountId: string): MatrixCredentials | null {
  const file = resolveChat4000CredentialsPath(accountId);
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // A credentials file that cannot be read is treated as absent by callers.
    return null;
  }
  return parseMatrixCredentials(raw).match(
    (credentials) => credentials,
    () => null,
  );
}

export function saveMatrixCredentials(accountId: string, credentials: MatrixCredentials): string {
  const file = resolveChat4000CredentialsPath(accountId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort perm tightening
  }
  return file;
}

export function deleteMatrixCredentials(accountId: string): boolean {
  const file = resolveChat4000CredentialsPath(accountId);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}
