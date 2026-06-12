/**
 * Gateway-resident pairing-completion listener (PROTOCOL C.4 "Completion
 * listening" + E device pairing).
 *
 * The resident plugin OWNS pairing-completion handling: it polls `/pair/status`
 * for every outstanding code it has registered — including reusable ones — for
 * the code's whole lifetime, surviving restarts (outstanding codes live in the
 * persistent {@link loadOutstandingCodes} store; `resume()` reloads them on
 * boot and a rescan picks up codes the CLI registers while the gateway runs).
 * The short-lived CLI watcher is only the immediate-feedback path during
 * installs — when it exits, nothing is lost, because this listener is still
 * listening.
 *
 * Per new redeem the listener's jobs are (C.3): record the device + hand the
 * redeem to `onDeviceRedeemed` (analytics, the machine↔phone join). Room
 * KEYING needs no action here: the live plugin's normal next-send key share
 * reaches the new device, and setup/listener never pre-share keys (C.6
 * single-crypto-owner rule). Membership needs no action either: the user's
 * invites pre-exist from setup (C.6).
 *
 * Interactive `device.pair_start` codes (E) additionally stream
 * `chat4000.pair_status` lifecycle events keyed by `pair_id`;
 * `device.pair_cancel` aborts one. Those codes stay single-use with a short
 * TTL; the long-TTL / reusable options are installer-driven (CLI) only.
 */
import { randomBytes } from "node:crypto";
import {
  generatePairingCode,
  isTransientRegistrarError,
  redeemIndexOf,
  RegistrarError,
  type PairStatusResult,
  type RegistrarClient,
} from "./pairing/registrar.js";
import {
  addOutstandingCode,
  loadOutstandingCodes,
  recordRedeemedDevices,
  removeOutstandingCode,
  type OutstandingCode,
} from "./pairing/outstanding-codes.js";

const DEVICE_PAIR_TTL_SECONDS = 120;
/** Fast cadence while a pairing is actively expected (C.4: ~1 s recommended). */
const PAIR_STATUS_POLL_INTERVAL_MS = 1_500;
/** Slow cadence for long-lived codes (C.4: back off to >= 30 s). */
const PAIR_STATUS_LONG_POLL_INTERVAL_MS = 30_000;
/** Exponential-backoff cap for transient /pair/status failures. */
const PAIR_STATUS_MAX_BACKOFF_MS = 30_000;
/** A code whose whole TTL is within this window is "actively expected" (C.4). */
const ACTIVE_WINDOW_MS = 600_000;
/** How often to rescan the store for codes registered by another process (CLI). */
const STORE_RESCAN_INTERVAL_MS = 15_000;

export type PairStatusState = "completed" | "expired" | "error" | "cancelled";

/** One observed redeem, handed to the channel for analytics + onboarding. */
export type DeviceRedeem = {
  deviceId: string;
  /** The redeeming device's analytics id; absent when its telemetry was off. */
  clientId?: string | undefined;
  /** The code's bound user (the plugin's one user, C.1). */
  userId?: string | undefined;
  /** PL4: whether the redeemed code was reusable (C.1). */
  reusable: boolean;
  /** PL4: 1-based per-code redeem index, wire-derived; absent when underivable. */
  redeemIndex?: number | undefined;
};

export type DevicePairingDeps = {
  /** Account whose persistent outstanding-codes store this listener owns. */
  accountId: string;
  registrar: RegistrarClient;
  pluginId: string;
  /** Stream a `chat4000.pair_status` event into the control room (E). */
  sendPairStatus: (pairId: string, state: PairStatusState, error?: string) => Promise<void>;
  /** C.3: a device redeemed a code — fired once per redeem (never re-fired). */
  onDeviceRedeemed: (redeem: DeviceRedeem) => void;
  /** Route an unexpected error to the sink. */
  report: (err: unknown, context: string) => void;
  ttlSeconds?: number;
  pollIntervalMs?: number;
  longPollIntervalMs?: number;
  rescanIntervalMs?: number;
};

export type StartResult = { ok: true; pairId: string; code: string } | { ok: false; error: string };

export type CancelResult = { ok: true } | { ok: false; error: string };

function genPairId(): string {
  return `p_${randomBytes(6).toString("hex")}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class DevicePairingManager {
  /** One poller per outstanding code (interactive AND resumed/CLI codes). */
  private readonly active = new Map<string, AbortController>();

  /** pair_id → code, for `device.pair_cancel`. */
  private readonly interactive = new Map<string, string>();

  private rescanTimer: ReturnType<typeof setInterval> | undefined;

  private disposed = false;

  private readonly ttlSeconds: number;

  private readonly pollIntervalMs: number;

  private readonly longPollIntervalMs: number;

  private readonly rescanIntervalMs: number;

  constructor(private readonly deps: DevicePairingDeps) {
    this.ttlSeconds = deps.ttlSeconds ?? DEVICE_PAIR_TTL_SECONDS;
    this.pollIntervalMs = deps.pollIntervalMs ?? PAIR_STATUS_POLL_INTERVAL_MS;
    this.longPollIntervalMs = deps.longPollIntervalMs ?? PAIR_STATUS_LONG_POLL_INTERVAL_MS;
    this.rescanIntervalMs = deps.rescanIntervalMs ?? STORE_RESCAN_INTERVAL_MS;
  }

  /**
   * C.4 completion listening: start polling every outstanding code in the
   * persistent store (codes from before a restart AND codes the CLI registered)
   * and keep rescanning so CLI codes registered while the gateway runs get a
   * poller too. Idempotent per code.
   */
  resume(): void {
    this.scanStore();
    if (this.rescanTimer) return;
    this.rescanTimer = setInterval(() => this.scanStore(), this.rescanIntervalMs);
    this.rescanTimer.unref?.();
  }

  private scanStore(): void {
    if (this.disposed) return;
    for (const entry of loadOutstandingCodes(this.deps.accountId)) {
      if (this.active.has(entry.code)) continue;
      if (entry.expiresAt <= Date.now()) {
        // Already past TTL: confirm/settle once instead of opening a poll loop.
        removeOutstandingCode(this.deps.accountId, entry.code);
        continue;
      }
      this.spawn(entry);
    }
  }

  /** `device.pair_start`: register a fresh single-use code bound to the requester. */
  async start(senderId: string): Promise<StartResult> {
    if (!senderId) return { ok: false, error: "event sender missing" };
    if (!this.deps.pluginId) return { ok: false, error: "plugin_id missing" };
    const pairId = genPairId();
    const code = generatePairingCode();
    let expiresAt = Date.now() + this.ttlSeconds * 1000;
    try {
      // PROTOCOL E (security-critical): bind to the SENDER's MXID, never a
      // body value — a member can enroll a device only onto their own account.
      const registered = await this.deps.registrar.registerPairing({
        code,
        kind: "user",
        pluginId: this.deps.pluginId,
        userId: senderId,
        ttlSeconds: this.ttlSeconds,
      });
      if (Number.isFinite(registered.expiresAt) && registered.expiresAt > 0) {
        expiresAt = registered.expiresAt;
      }
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    const entry: OutstandingCode = {
      code,
      reusable: false,
      expiresAt,
      registeredAt: Date.now(),
      pairId,
      deviceIds: [],
    };
    addOutstandingCode(this.deps.accountId, entry);
    this.interactive.set(pairId, code);
    this.spawn(entry);
    return { ok: true, pairId, code };
  }

  /** `device.pair_cancel`: abort an in-flight attempt and report `cancelled`. */
  cancel(pairId: string): CancelResult {
    const code = this.interactive.get(pairId);
    if (!code) return { ok: false, error: "unknown pair_id" };
    this.interactive.delete(pairId);
    this.active.get(code)?.abort();
    this.active.delete(code);
    removeOutstandingCode(this.deps.accountId, code);
    void this.deps
      .sendPairStatus(pairId, "cancelled")
      .catch((err: unknown) => this.deps.report(err, "device_pairing.cancel_status"));
    return { ok: true };
  }

  /** Abort every in-flight poller (channel shutdown). The store keeps the codes. */
  dispose(): void {
    this.disposed = true;
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = undefined;
    }
    for (const abort of this.active.values()) abort.abort();
    this.active.clear();
    this.interactive.clear();
  }

  private spawn(entry: OutstandingCode): void {
    const abort = new AbortController();
    this.active.set(entry.code, abort);
    void this.poll(entry, abort.signal).finally(() => {
      this.active.delete(entry.code);
      if (entry.pairId) this.interactive.delete(entry.pairId);
    });
  }

  /**
   * Poll cadence (C.4): ~`pollIntervalMs` while the pairing is actively
   * expected — a short-TTL code (pair_start / install window) or the first
   * minutes after registration — then back off to `longPollIntervalMs`; a late
   * redeem of a 2-year reusable code is not latency-sensitive.
   */
  private baseDelay(entry: OutstandingCode): number {
    const shortLived = entry.expiresAt - entry.registeredAt <= ACTIVE_WINDOW_MS;
    const recentlyRegistered = Date.now() - entry.registeredAt <= ACTIVE_WINDOW_MS;
    return shortLived || recentlyRegistered ? this.pollIntervalMs : this.longPollIntervalMs;
  }

  private async poll(entry: OutstandingCode, signal: AbortSignal): Promise<void> {
    const { pairId, code } = entry;
    // A redeem observed in a previous process already announced "completed".
    let announced = entry.deviceIds.length > 0;
    let delayMs = this.baseDelay(entry);
    try {
      while (Date.now() < entry.expiresAt && !signal.aborted) {
        let status: PairStatusResult | undefined;
        try {
          status = await this.deps.registrar.getPairingStatus(code);
          delayMs = this.baseDelay(entry); // a successful poll resets the backoff
        } catch (err) {
          if (err instanceof RegistrarError && err.isNotFound) {
            // The registrar GC'd the record (C.4 retention) — nothing left to
            // observe; drop it from our persistent state too.
            removeOutstandingCode(this.deps.accountId, code);
            return;
          }
          // Permanent registrar error (e.g. bad service token) — fail fast via
          // the outer catch, which streams an `error` pair_status.
          if (!isTransientRegistrarError(err)) throw err;
          // Transient (429 / 502-504 / network) — report and keep polling with
          // exponential backoff inside the same deadline (observed live
          // 2026-06-12: a 429 from /pair/status killed the Hermes twin's pairing).
          this.deps.report(err, "device_pairing.status");
          delayMs = Math.min(delayMs * 2, PAIR_STATUS_MAX_BACKOFF_MS);
        }
        if (signal.aborted) return;
        if (status) {
          announced = this.handleRedeems(entry, status, announced);
          if (status.status === "completed") {
            // Single-use settle (a reusable code never reports `completed`).
            removeOutstandingCode(this.deps.accountId, code);
            return;
          }
          if (status.status === "expired") {
            if (pairId && !announced) await this.emit(pairId, "expired");
            removeOutstandingCode(this.deps.accountId, code);
            return;
          }
        }
        await sleep(Math.min(delayMs, Math.max(0, entry.expiresAt - Date.now())), signal);
      }
      if (signal.aborted) return;
      // TTL elapsed locally without the registrar settling it for us.
      if (pairId && !announced) await this.emit(pairId, "expired");
      removeOutstandingCode(this.deps.accountId, code);
    } catch (err) {
      this.deps.report(err, "device_pairing.poll");
      removeOutstandingCode(this.deps.accountId, code);
      if (pairId && !signal.aborted) {
        await this.deps
          .sendPairStatus(pairId, "error", String(err))
          .catch((e: unknown) => this.deps.report(e, "device_pairing.error_status"));
      }
    }
  }

  /**
   * Record any not-yet-seen redeems (check-and-set in the persistent store, so
   * the CLI watcher and this listener never double-process one) and fire
   * `onDeviceRedeemed` per new device. Returns whether a `completed`
   * pair_status has been announced for this code.
   */
  private handleRedeems(
    entry: OutstandingCode,
    status: PairStatusResult,
    announced: boolean,
  ): boolean {
    let redeems = status.redeems;
    if (redeems.length === 0 && status.status === "completed") {
      // Old-registrar shape (no redeems[]): synthesize the one redeem from the
      // top-level fields so completion still flows.
      redeems = [{ deviceId: `legacy:${entry.code}`, clientId: status.clientId, redeemedAt: 0 }];
    }
    const fresh = recordRedeemedDevices(this.deps.accountId, entry.code, redeems);
    for (const redeem of fresh) {
      try {
        this.deps.onDeviceRedeemed({
          deviceId: redeem.deviceId,
          clientId: redeem.clientId,
          userId: status.userId,
          reusable: entry.reusable, // PL4 prop
          redeemIndex: redeemIndexOf(status, redeem.deviceId), // PL4 prop (wire-derived)
        });
      } catch (err) {
        this.deps.report(err, "device_pairing.on_device_redeemed");
      }
    }
    if (fresh.length > 0 && entry.pairId && !announced) {
      void this.emit(entry.pairId, "completed");
      return true;
    }
    return announced || fresh.length > 0;
  }

  private async emit(pairId: string, state: PairStatusState): Promise<void> {
    await this.deps
      .sendPairStatus(pairId, state)
      .catch((err: unknown) => this.deps.report(err, "device_pairing.pair_status"));
  }
}
