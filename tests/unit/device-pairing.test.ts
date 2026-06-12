import { afterEach, describe, expect, it, vi } from "vitest";
import { DevicePairingManager } from "../../src/device-pairing.js";
import { RegistrarError, type RegistrarClient } from "../../src/pairing/registrar.js";

function makeRegistrar(over: Record<string, unknown> = {}): RegistrarClient {
  return {
    registerPairing: vi.fn(() => Promise.resolve({ ok: true, expiresAt: 0 })),
    getPairingStatus: vi.fn(() => Promise.resolve({ status: "pending" })),
    ...over,
  } as unknown as RegistrarClient;
}

describe("DevicePairingManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start registers a kind=user code bound to the requester and returns it", async () => {
    const registerPairing = vi.fn(() => Promise.resolve({ ok: true, expiresAt: 0 }));
    const registrar = makeRegistrar({ registerPairing });
    const mgr = new DevicePairingManager({
      registrar,
      pluginId: "plug1",
      sendPairStatus: vi.fn(() => Promise.resolve()),
      onCompleted: vi.fn(),
      report: vi.fn(),
      pollIntervalMs: 5,
      ttlSeconds: 1,
    });
    const res = await mgr.start("@alice:hs");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toMatch(/^[0-9]{6}$/);
      expect(res.pairId).toMatch(/^p_/);
    }
    expect(registerPairing).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "user", pluginId: "plug1", userId: "@alice:hs" }),
    );
    mgr.dispose();
  });

  it("start errors when plugin_id is missing", async () => {
    const mgr = new DevicePairingManager({
      registrar: makeRegistrar(),
      pluginId: "",
      sendPairStatus: vi.fn(() => Promise.resolve()),
      onCompleted: vi.fn(),
      report: vi.fn(),
    });
    expect(await mgr.start("@a:hs")).toEqual({ ok: false, error: "plugin_id missing" });
  });

  it("on completed: fires onCompleted(clientId) + a 'completed' pair_status (PL4)", async () => {
    const registrar = makeRegistrar({
      getPairingStatus: vi.fn(() =>
        Promise.resolve({ status: "completed", userId: "@new:hs", clientId: "phone-1" }),
      ),
    });
    const onCompleted = vi.fn();
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const sendPairStatus = vi.fn((_pairId: string, state: string) => {
      if (state === "completed") resolveDone();
      return Promise.resolve();
    });
    const mgr = new DevicePairingManager({
      registrar,
      pluginId: "plug1",
      sendPairStatus,
      onCompleted,
      report: vi.fn(),
      pollIntervalMs: 5,
      ttlSeconds: 5,
    });
    const res = await mgr.start("@alice:hs");
    expect(res.ok).toBe(true);
    await done;
    expect(onCompleted).toHaveBeenCalledWith("phone-1");
    expect(sendPairStatus).toHaveBeenCalledWith(expect.any(String), "completed");
    mgr.dispose();
  });

  it("retries transient /pair/status errors with exponential backoff (capped) until completed", async () => {
    // Live failure 2026-06-12: a 429 M_LIMIT_EXCEEDED from /pair/status killed
    // pairing in the Hermes twin. Transient errors must back off (doubling,
    // 30s cap) and keep polling inside the same overall deadline.
    vi.useFakeTimers();
    const callTimes: number[] = [];
    let attempts = 0;
    const getPairingStatus = vi.fn(() => {
      callTimes.push(Date.now());
      attempts += 1;
      if (attempts <= 6) {
        return Promise.reject(new RegistrarError("rate limited", 429, "M_LIMIT_EXCEEDED"));
      }
      return Promise.resolve({ status: "completed", userId: "@new:hs" });
    });
    const registrar = makeRegistrar({ getPairingStatus });
    const onCompleted = vi.fn();
    const sendPairStatus = vi.fn(() => Promise.resolve());
    const report = vi.fn();
    const mgr = new DevicePairingManager({
      registrar,
      pluginId: "plug1",
      sendPairStatus,
      onCompleted,
      report,
      pollIntervalMs: 1000,
      ttlSeconds: 300,
    });
    const t0 = Date.now();
    const res = await mgr.start("@alice:hs");
    expect(res.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    // Backoff after each failure: 2s, 4s, 8s, 16s, 30s (32s capped), 30s.
    expect(callTimes).toEqual([
      t0,
      t0 + 2_000,
      t0 + 6_000,
      t0 + 14_000,
      t0 + 30_000,
      t0 + 60_000,
      t0 + 90_000,
    ]);
    expect(report).toHaveBeenCalledTimes(6);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(sendPairStatus).toHaveBeenCalledWith(expect.any(String), "completed");
    mgr.dispose();
  });

  it("fails fast (streams 'error') on a permanent registrar error — no retry", async () => {
    const getPairingStatus = vi.fn(() =>
      Promise.reject(new RegistrarError("Invalid service token", 401, "M_UNKNOWN_TOKEN")),
    );
    const registrar = makeRegistrar({ getPairingStatus });
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const states: string[] = [];
    const sendPairStatus = vi.fn((_pairId: string, state: string) => {
      states.push(state);
      if (state === "error") resolveDone();
      return Promise.resolve();
    });
    const mgr = new DevicePairingManager({
      registrar,
      pluginId: "plug1",
      sendPairStatus,
      onCompleted: vi.fn(),
      report: vi.fn(),
      pollIntervalMs: 5,
      ttlSeconds: 5,
    });
    const res = await mgr.start("@alice:hs");
    expect(res.ok).toBe(true);
    await done;
    expect(states).toEqual(["error"]);
    expect(getPairingStatus).toHaveBeenCalledTimes(1);
    mgr.dispose();
  });

  it("cancel: unknown id errors; a known id aborts and reports 'cancelled'", async () => {
    const sendPairStatus = vi.fn(() => Promise.resolve());
    const mgr = new DevicePairingManager({
      registrar: makeRegistrar(),
      pluginId: "plug1",
      sendPairStatus,
      onCompleted: vi.fn(),
      report: vi.fn(),
      pollIntervalMs: 50,
      ttlSeconds: 60,
    });
    expect(mgr.cancel("nope")).toEqual({ ok: false, error: "unknown pair_id" });
    const res = await mgr.start("@alice:hs");
    if (!res.ok) throw new Error("start should have succeeded");
    expect(mgr.cancel(res.pairId)).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(sendPairStatus).toHaveBeenCalledWith(res.pairId, "cancelled");
    mgr.dispose();
  });
});
