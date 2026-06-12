/**
 * Device-to-device pairing (PROTOCOL E). An already-paired device asks the plugin
 * — via a `device.pair_start` control-room command — to pair ANOTHER device. The
 * plugin registers a fresh `kind=user` code bound to itself + the requesting
 * user, hands the code back in the command result, polls `/pair/status`, and
 * streams `chat4000.pair_status` events as the new device redeems it.
 * `device.pair_cancel` aborts an in-flight attempt. Ported from the hermes
 * plugin's `_device_pair_start` / `_device_pair_cancel` / `_poll_pairing`.
 */
import { randomBytes } from "node:crypto";
import {
  generatePairingCode,
  isTransientRegistrarError,
  type RegistrarClient,
} from "./pairing/registrar.js";

const DEVICE_PAIR_TTL_SECONDS = 120;
const PAIR_STATUS_POLL_INTERVAL_MS = 1_500;
/** Exponential-backoff cap for transient /pair/status failures. */
const PAIR_STATUS_MAX_BACKOFF_MS = 30_000;

export type PairStatusState = "completed" | "expired" | "error" | "cancelled";

export type DevicePairingDeps = {
  registrar: RegistrarClient;
  pluginId: string;
  /** Stream a `chat4000.pair_status` event into the control room. */
  sendPairStatus: (pairId: string, state: PairStatusState, error?: string) => Promise<void>;
  /** PL4: a device completed pairing — emit the join event (clientId may be absent). */
  onCompleted: (clientId: string | undefined) => void;
  /** Route an unexpected error to the sink. */
  report: (err: unknown, context: string) => void;
  ttlSeconds?: number;
  pollIntervalMs?: number;
};

export type StartResult =
  | { ok: true; pairId: string; code: string }
  | { ok: false; error: string };

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
  private readonly pending = new Map<string, AbortController>();

  private readonly ttlSeconds: number;

  private readonly pollIntervalMs: number;

  constructor(private readonly deps: DevicePairingDeps) {
    this.ttlSeconds = deps.ttlSeconds ?? DEVICE_PAIR_TTL_SECONDS;
    this.pollIntervalMs = deps.pollIntervalMs ?? PAIR_STATUS_POLL_INTERVAL_MS;
  }

  /** `device.pair_start`: register a fresh code for the requester and poll it. */
  async start(senderId: string): Promise<StartResult> {
    if (!senderId) return { ok: false, error: "event sender missing" };
    if (!this.deps.pluginId) return { ok: false, error: "plugin_id missing" };
    const pairId = genPairId();
    const code = generatePairingCode();
    try {
      await this.deps.registrar.registerPairing({
        code,
        kind: "user",
        pluginId: this.deps.pluginId,
        userId: senderId,
        ttlSeconds: this.ttlSeconds,
      });
    } catch (err) {
      return { ok: false, error: String(err) };
    }
    const abort = new AbortController();
    this.pending.set(pairId, abort);
    void this.poll(pairId, code, abort.signal);
    return { ok: true, pairId, code };
  }

  /** `device.pair_cancel`: abort an in-flight attempt and report `cancelled`. */
  cancel(pairId: string): CancelResult {
    const abort = this.pending.get(pairId);
    if (!abort) return { ok: false, error: "unknown pair_id" };
    abort.abort();
    this.pending.delete(pairId);
    void this.deps
      .sendPairStatus(pairId, "cancelled")
      .catch((err: unknown) => this.deps.report(err, "device_pairing.cancel_status"));
    return { ok: true };
  }

  /** Abort every in-flight attempt (channel shutdown). */
  dispose(): void {
    for (const abort of this.pending.values()) abort.abort();
    this.pending.clear();
  }

  private async poll(pairId: string, code: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.ttlSeconds * 1000;
    let delayMs = this.pollIntervalMs;
    try {
      while (Date.now() < deadline && !signal.aborted) {
        let status: Awaited<ReturnType<RegistrarClient["getPairingStatus"]>> | undefined;
        try {
          status = await this.deps.registrar.getPairingStatus(code);
          delayMs = this.pollIntervalMs; // a successful poll resets the backoff
        } catch (err) {
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
        if (status?.status === "completed") {
          this.deps.onCompleted(status.clientId);
          await this.deps.sendPairStatus(pairId, "completed");
          return;
        }
        if (status?.status === "expired") {
          await this.deps.sendPairStatus(pairId, "expired");
          return;
        }
        await sleep(Math.min(delayMs, Math.max(0, deadline - Date.now())), signal);
      }
      if (!signal.aborted) await this.deps.sendPairStatus(pairId, "expired");
    } catch (err) {
      this.deps.report(err, "device_pairing.poll");
      if (!signal.aborted) {
        await this.deps
          .sendPairStatus(pairId, "error", String(err))
          .catch((e: unknown) => this.deps.report(e, "device_pairing.error_status"));
      }
    } finally {
      this.pending.delete(pairId);
    }
  }
}
