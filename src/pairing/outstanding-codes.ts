/**
 * Persistent store of outstanding pairing codes (PROTOCOL C.4 "Completion
 * listening"): the gateway-resident plugin polls `GET /codes/{code}` for EVERY
 * outstanding code it has registered — including reusable ones — for the code's
 * whole lifetime, SURVIVING its own restarts. That makes outstanding codes part
 * of the plugin's persistent state, kept here.
 *
 * Writers: the CLI `pair` command (install-time codes, possibly long-lived /
 * reusable) and the resident listener (`device.pair_start` codes + redeem
 * bookkeeping). Both processes read-modify-write the same per-account JSON file
 * under the account state dir (removed by `chat4000 reset`); the per-device
 * check-and-set in {@link recordRedeemedDevices} is what keeps the two pollers
 * (CLI watcher + resident listener) from double-counting a redeem.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChat4000AccountStateDir } from "../paths.js";

const OUTSTANDING_FILE = "outstanding-codes.json";

/**
 * Keep a settled/expired record on disk this long before pruning, mirroring the
 * registrar's own PAIR_RECORD_RETENTION (C.4) so late observers can still
 * dedupe against it.
 */
const PRUNE_AFTER_EXPIRY_MS = 86_400_000;

export type OutstandingCode = {
  /** The 6-digit pairing code (the registrar key). */
  code: string;
  /** PROTOCOL C.1 `reusable`: redeemable many times until expiry. */
  reusable: boolean;
  /** Unix ms the code expires (from the register response). */
  expiresAt: number;
  /** Unix ms the code was registered (drives the poll-cadence backoff). */
  registeredAt: number;
  /**
   * PROTOCOL E correlator, present only for `device.pair_start` codes — its
   * presence is what makes the listener emit `chat4000.pair_status` lifecycle
   * events for this code.
   */
  pairId?: string | undefined;
  /** Device ids whose redeems have already been recorded (analytics dedupe). */
  deviceIds: string[];
};

function storePath(accountId: string): string {
  return path.join(resolveChat4000AccountStateDir(accountId), OUTSTANDING_FILE);
}

function isOutstandingCode(value: unknown): value is OutstandingCode {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    typeof v.reusable === "boolean" &&
    typeof v.expiresAt === "number" &&
    typeof v.registeredAt === "number" &&
    (v.pairId === undefined || typeof v.pairId === "string") &&
    Array.isArray(v.deviceIds) &&
    v.deviceIds.every((d) => typeof d === "string")
  );
}

/**
 * Read the outstanding codes for an account, pruning entries that expired more
 * than the retention window ago. Best-effort: an unreadable store is empty
 * (worst case the listener re-observes a redeem the registrar still reports).
 */
export function loadOutstandingCodes(accountId: string): OutstandingCode[] {
  const file = storePath(accountId);
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const cutoff = Date.now() - PRUNE_AFTER_EXPIRY_MS;
  return parsed.filter(isOutstandingCode).filter((entry) => entry.expiresAt > cutoff);
}

function save(accountId: string, entries: OutstandingCode[]): void {
  const file = storePath(accountId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Add (or replace, keyed by code) an outstanding code. */
export function addOutstandingCode(accountId: string, entry: OutstandingCode): void {
  const entries = loadOutstandingCodes(accountId).filter((e) => e.code !== entry.code);
  entries.push(entry);
  save(accountId, entries);
}

/** Drop a settled/expired/cancelled code from the store. */
export function removeOutstandingCode(accountId: string, code: string): void {
  const entries = loadOutstandingCodes(accountId);
  const next = entries.filter((e) => e.code !== code);
  if (next.length !== entries.length) save(accountId, next);
}

/**
 * Check-and-set the redeemed devices of a code: records every device id not yet
 * seen and returns ONLY the newly recorded ones, so each redeem is processed
 * (analytics, pair_status, keying hooks) exactly once across the CLI watcher
 * and the resident listener. Unknown codes record nothing and return
 * everything as new (the entry was pruned — better a duplicate than a loss).
 */
export function recordRedeemedDevices<T extends { deviceId: string }>(
  accountId: string,
  code: string,
  redeems: T[],
): T[] {
  if (redeems.length === 0) return [];
  const entries = loadOutstandingCodes(accountId);
  const entry = entries.find((e) => e.code === code);
  if (!entry) return redeems;
  const seen = new Set(entry.deviceIds);
  const fresh = redeems.filter((r) => !seen.has(r.deviceId));
  if (fresh.length === 0) return [];
  entry.deviceIds = [...entry.deviceIds, ...fresh.map((r) => r.deviceId)];
  save(accountId, entries);
  return fresh;
}
