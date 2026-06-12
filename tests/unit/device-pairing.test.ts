import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DevicePairingManager,
  type DevicePairingDeps,
  type DeviceRedeem,
} from "../../src/device-pairing.js";
import { addOutstandingCode, loadOutstandingCodes } from "../../src/pairing/outstanding-codes.js";
import { RegistrarError, type RegistrarClient } from "../../src/pairing/registrar.js";

const ACCOUNT = "default";

function makeRegistrar(over: Record<string, unknown> = {}): RegistrarClient {
  return {
    registerPairing: vi.fn(() => Promise.resolve({ ok: true, expiresAt: 0 })),
    getPairingStatus: vi.fn(() =>
      Promise.resolve({ status: "pending", redeems: [], redeemedCount: 0 }),
    ),
    ...over,
  } as unknown as RegistrarClient;
}

function makeManager(over: Partial<DevicePairingDeps> = {}): DevicePairingManager {
  return new DevicePairingManager({
    accountId: ACCOUNT,
    registrar: makeRegistrar(),
    pluginId: "plug1",
    sendPairStatus: vi.fn(() => Promise.resolve()),
    onDeviceRedeemed: vi.fn(),
    report: vi.fn(),
    pollIntervalMs: 5,
    ttlSeconds: 1,
    ...over,
  });
}

describe("DevicePairingManager (gateway-resident completion listener)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "chat4000-pairing-test-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.OPENCLAW_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("start registers a kind=user code bound to the requester and persists it (C.1 + C.4)", async () => {
    const registerPairing = vi.fn(() => Promise.resolve({ ok: true, expiresAt: 0 }));
    const mgr = makeManager({ registrar: makeRegistrar({ registerPairing }) });
    const res = await mgr.start("@alice:hs");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toMatch(/^[0-9]{6}$/);
      expect(res.pairId).toMatch(/^p_/);
      // C.4: outstanding codes are part of the plugin's persistent state.
      const stored = loadOutstandingCodes(ACCOUNT);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ code: res.code, pairId: res.pairId, reusable: false });
    }
    expect(registerPairing).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "user", pluginId: "plug1", userId: "@alice:hs" }),
    );
    mgr.dispose();
  });

  it("start errors when plugin_id is missing", async () => {
    const mgr = makeManager({ pluginId: "" });
    expect(await mgr.start("@a:hs")).toEqual({ ok: false, error: "plugin_id missing" });
  });

  it("on completed: fires onDeviceRedeemed per redeem + a 'completed' pair_status (PL4)", async () => {
    const registrar = makeRegistrar({
      getPairingStatus: vi.fn(() =>
        Promise.resolve({
          status: "completed",
          userId: "@new:hs",
          clientId: "phone-1",
          redeems: [{ deviceId: "DEV9", clientId: "phone-1", redeemedAt: 1 }],
          redeemedCount: 1,
        }),
      ),
    });
    const onDeviceRedeemed = vi.fn();
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const sendPairStatus = vi.fn((_pairId: string, state: string) => {
      if (state === "completed") resolveDone();
      return Promise.resolve();
    });
    const mgr = makeManager({ registrar, sendPairStatus, onDeviceRedeemed, ttlSeconds: 5 });
    const res = await mgr.start("@alice:hs");
    expect(res.ok).toBe(true);
    await done;
    expect(onDeviceRedeemed).toHaveBeenCalledTimes(1);
    expect(onDeviceRedeemed).toHaveBeenCalledWith({
      deviceId: "DEV9",
      clientId: "phone-1",
      userId: "@new:hs",
    });
    expect(sendPairStatus).toHaveBeenCalledWith(expect.any(String), "completed");
    // A settled single-use code leaves the persistent store.
    await vi.waitFor(() => expect(loadOutstandingCodes(ACCOUNT)).toHaveLength(0));
    mgr.dispose();
  });

  it("old-registrar shape (completed, no redeems[]) still completes via a synthesized redeem", async () => {
    const registrar = makeRegistrar({
      getPairingStatus: vi.fn(() =>
        Promise.resolve({
          status: "completed",
          userId: "@new:hs",
          clientId: "phone-1",
          redeems: [],
          redeemedCount: 0,
        }),
      ),
    });
    const onDeviceRedeemed = vi.fn();
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const sendPairStatus = vi.fn((_pairId: string, state: string) => {
      if (state === "completed") resolveDone();
      return Promise.resolve();
    });
    const mgr = makeManager({ registrar, sendPairStatus, onDeviceRedeemed, ttlSeconds: 5 });
    const res = await mgr.start("@alice:hs");
    expect(res.ok).toBe(true);
    await done;
    expect(onDeviceRedeemed).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "phone-1", userId: "@new:hs" }),
    );
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
      return Promise.resolve({
        status: "completed",
        userId: "@new:hs",
        redeems: [{ deviceId: "DEV1", redeemedAt: 1 }],
        redeemedCount: 1,
      });
    });
    const registrar = makeRegistrar({ getPairingStatus });
    const onDeviceRedeemed = vi.fn();
    const sendPairStatus = vi.fn(() => Promise.resolve());
    const report = vi.fn();
    const mgr = makeManager({
      registrar,
      sendPairStatus,
      onDeviceRedeemed,
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
    expect(onDeviceRedeemed).toHaveBeenCalledTimes(1);
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
    const mgr = makeManager({ registrar, sendPairStatus, ttlSeconds: 5 });
    const res = await mgr.start("@alice:hs");
    expect(res.ok).toBe(true);
    await done;
    expect(states).toEqual(["error"]);
    expect(getPairingStatus).toHaveBeenCalledTimes(1);
    mgr.dispose();
  });

  it("cancel: unknown id errors; a known id aborts, reports 'cancelled', and clears the store", async () => {
    const sendPairStatus = vi.fn(() => Promise.resolve());
    const mgr = makeManager({ sendPairStatus, pollIntervalMs: 50, ttlSeconds: 60 });
    expect(mgr.cancel("nope")).toEqual({ ok: false, error: "unknown pair_id" });
    const res = await mgr.start("@alice:hs");
    if (!res.ok) throw new Error("start should have succeeded");
    expect(mgr.cancel(res.pairId)).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(sendPairStatus).toHaveBeenCalledWith(res.pairId, "cancelled");
    expect(loadOutstandingCodes(ACCOUNT)).toHaveLength(0);
    mgr.dispose();
  });

  it("resume(): completes a CLI-registered store code with no CLI running (C.4 completion listening)", async () => {
    // The CLI registered this code and exited — only the store remembers it.
    addOutstandingCode(ACCOUNT, {
      code: "428913",
      reusable: false,
      expiresAt: Date.now() + 60_000,
      registeredAt: Date.now(),
      deviceIds: [],
    });
    const getPairingStatus = vi.fn(() =>
      Promise.resolve({
        status: "completed",
        userId: "@u_x:hs",
        redeems: [{ deviceId: "DEV1", clientId: "phone-1", redeemedAt: 1 }],
        redeemedCount: 1,
      }),
    );
    const redeemed: DeviceRedeem[] = [];
    const onDeviceRedeemed = vi.fn((redeem: DeviceRedeem) => {
      redeemed.push(redeem);
    });
    const sendPairStatus = vi.fn(() => Promise.resolve());
    const mgr = makeManager({
      registrar: makeRegistrar({ getPairingStatus }),
      onDeviceRedeemed,
      sendPairStatus,
    });
    mgr.resume();
    await vi.waitFor(() => expect(onDeviceRedeemed).toHaveBeenCalledTimes(1));
    expect(redeemed).toEqual([
      {
        deviceId: "DEV1",
        clientId: "phone-1",
        userId: "@u_x:hs",
      },
    ]);
    // No pair_id → a CLI code has no control-room lifecycle events.
    expect(sendPairStatus).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(loadOutstandingCodes(ACCOUNT)).toHaveLength(0));
    mgr.dispose();
  });

  it("reusable code: records each redeem once, stays tracked while pending, settles on expiry (C.3)", async () => {
    addOutstandingCode(ACCOUNT, {
      code: "511222",
      reusable: true,
      expiresAt: Date.now() + 60_000,
      registeredAt: Date.now(),
      deviceIds: [],
    });
    const responses = [
      // First redeem arrives — a reusable code STAYS pending (never `completed`).
      {
        status: "pending",
        userId: "@u_x:hs",
        redeems: [{ deviceId: "DEV1", clientId: "phone-1", redeemedAt: 1 }],
        redeemedCount: 1,
        expiresAt: Date.now() + 60_000,
      },
      // Same redeem re-reported + a second device: only DEV2 is new.
      {
        status: "pending",
        userId: "@u_x:hs",
        redeems: [
          { deviceId: "DEV1", clientId: "phone-1", redeemedAt: 1 },
          { deviceId: "DEV2", redeemedAt: 2 },
        ],
        redeemedCount: 2,
        expiresAt: Date.now() + 60_000,
      },
      // TTL elapsed — the only way a reusable code settles.
      {
        status: "expired",
        userId: "@u_x:hs",
        redeems: [
          { deviceId: "DEV1", clientId: "phone-1", redeemedAt: 1 },
          { deviceId: "DEV2", redeemedAt: 2 },
        ],
        redeemedCount: 2,
      },
    ];
    let call = 0;
    const getPairingStatus = vi.fn(() => {
      const res = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return Promise.resolve(res);
    });
    const onDeviceRedeemed = vi.fn();
    const sendPairStatus = vi.fn(() => Promise.resolve());
    const mgr = makeManager({
      registrar: makeRegistrar({ getPairingStatus }),
      onDeviceRedeemed,
      sendPairStatus,
    });
    mgr.resume();
    await vi.waitFor(() => expect(loadOutstandingCodes(ACCOUNT)).toHaveLength(0));
    // Exactly one event per device, despite DEV1 riding three responses.
    expect(onDeviceRedeemed).toHaveBeenCalledTimes(2);
    expect(onDeviceRedeemed).toHaveBeenNthCalledWith(1, {
      deviceId: "DEV1",
      clientId: "phone-1",
      userId: "@u_x:hs",
    });
    expect(onDeviceRedeemed).toHaveBeenNthCalledWith(2, {
      deviceId: "DEV2",
      clientId: undefined,
      userId: "@u_x:hs",
    });
    expect(sendPairStatus).not.toHaveBeenCalled();
    mgr.dispose();
  });

  it("a registrar 404 (record GC'd) drops the code from the persistent store", async () => {
    addOutstandingCode(ACCOUNT, {
      code: "909090",
      reusable: false,
      expiresAt: Date.now() + 60_000,
      registeredAt: Date.now(),
      deviceIds: [],
    });
    const getPairingStatus = vi.fn(() =>
      Promise.reject(new RegistrarError("unknown code", 404, "M_NOT_FOUND")),
    );
    const report = vi.fn();
    const sendPairStatus = vi.fn(() => Promise.resolve());
    const mgr = makeManager({
      registrar: makeRegistrar({ getPairingStatus }),
      report,
      sendPairStatus,
    });
    mgr.resume();
    await vi.waitFor(() => expect(loadOutstandingCodes(ACCOUNT)).toHaveLength(0));
    // GC after retention is expected, not an error to stream or report.
    expect(sendPairStatus).not.toHaveBeenCalled();
    mgr.dispose();
  });
});
