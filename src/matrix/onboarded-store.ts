/**
 * Durable per-account record of users who already had their initial session room
 * auto-created (PROTOCOL E auto-create; mirrors the hermes plugin's onboarded
 * store). Survives restarts so re-inviting a known user on boot never mints a
 * SECOND initial room. Keyed `userId -> roomId`.
 *
 * Lives under the account state dir (persists across restarts; removed on a
 * `chat4000 reset`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChat4000AccountStateDir } from "../paths.js";

const ONBOARDED_FILE = "onboarded.json";

function onboardedPath(accountId: string): string {
  return path.join(resolveChat4000AccountStateDir(accountId), ONBOARDED_FILE);
}

/** Read the `userId -> initialRoomId` map for an account (empty when absent). */
export function loadOnboarded(accountId: string): Record<string, string> {
  try {
    const file = onboardedPath(accountId);
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
    }
  } catch {
    // Best-effort — treat an unreadable store as empty.
  }
  return {};
}

/** True iff this user already had an initial session room auto-created. */
export function isOnboarded(accountId: string, userId: string): boolean {
  return Boolean(loadOnboarded(accountId)[userId]);
}

/** Record that `userId` got an initial session room, so we never make a second. */
export function markOnboarded(accountId: string, userId: string, roomId: string): void {
  try {
    const current = loadOnboarded(accountId);
    current[userId] = roomId;
    const file = onboardedPath(accountId);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort — a missed mark only risks one duplicate room next boot.
  }
}
