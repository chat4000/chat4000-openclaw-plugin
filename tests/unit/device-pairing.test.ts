import { describe, expect, it, vi } from "vitest";
import { DevicePairingManager } from "../../src/device-pairing.js";
import type { RegistrarClient } from "../../src/pairing/registrar.js";

function makeRegistrar(over: Record<string, unknown> = {}): RegistrarClient {
  return {
    registerPairing: vi.fn(() => Promise.resolve({ ok: true, expiresAt: 0 })),
    getPairingStatus: vi.fn(() => Promise.resolve({ status: "pending" })),
    ...over,
  } as unknown as RegistrarClient;
}

describe("DevicePairingManager", () => {
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
