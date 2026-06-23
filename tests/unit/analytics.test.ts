import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * PL1/PL2/PL4/PL5 emission + identity/gating. telemetry + machine-ids are mocked
 * so the tests assert the wire shape and the telemetry gate, not the id files.
 */
let tmpRoot: string;
let telemetryEnabled = true;
const reportSpy = vi.fn();

type Analytics = typeof import("../../src/analytics.js");

async function loadModule(): Promise<Analytics> {
  vi.resetModules();
  vi.doMock("../../src/telemetry.js", () => ({
    getTelemetryStatus: () => ({ enabled: telemetryEnabled }),
    getEnvId: () => "env-id-123",
    report: reportSpy,
    flushTelemetry: () => Promise.resolve(),
  }));
  vi.doMock("../../src/machine-ids.js", () => ({
    readOrMintAgentInstallId: () => "agent-id-456",
  }));
  return import("../../src/analytics.js");
}

function fetchMock(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function lastBody(fn: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fn.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(init.body as string);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "c4k-an-"));
  process.env.OPENCLAW_STATE_DIR = path.join(tmpRoot, "state");
  delete process.env.OPENCLAW_HOME;
  delete process.env.CHAT4000_POSTHOG_HOST;
  delete process.env.CHAT4000_POSTHOG_API_KEY;
  telemetryEnabled = true;
  reportSpy.mockReset();
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("../../src/telemetry.js");
  vi.doUnmock("../../src/machine-ids.js");
});

describe("analytics — gating + identity (INF5/DEC9)", () => {
  it("does not POST anything when telemetry is disabled", async () => {
    telemetryEnabled = false;
    const fetchFn = fetchMock();
    const a = await loadModule();
    a.track("plugin_started", {});
    await a.flushAnalytics();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("POSTs to the self-hosted /capture/ with distinct_id = agent_install_id (IDN8)", async () => {
    const fetchFn = fetchMock();
    const a = await loadModule();
    a.track("plugin_started", { agent_kind: "openclaw" });
    await a.flushAnalytics();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://posthog.chat4000.com/capture/");
    const body = lastBody(fetchFn);
    expect(body.event).toBe("plugin_started");
    expect(body.distinct_id).toBe("agent-id-456");
    expect(body.api_key).toBe("phc_wNRtzk3h5FTw2X6h4CvieEoxdSdqUd42eUqbgW6nD7B4");
    const props = body.properties as Record<string, unknown>;
    expect(props.source).toBe("openclaw-plugin"); // DEC9: no plugin_id anywhere
    expect(props.env_id).toBe("env-id-123"); // IDN7 rides as a property
    expect(props).not.toHaveProperty("plugin_id");
  });

  it("machineClientId returns the agent id only when telemetry is on (PL3 gating)", async () => {
    let a = await loadModule();
    expect(a.machineClientId()).toBe("agent-id-456");
    telemetryEnabled = false;
    a = await loadModule();
    expect(a.machineClientId()).toBeNull();
  });
});

describe("analytics — boot + pairing emission", () => {
  it("emitPluginBootAnalytics fires container_rebuilt then plugin_started (PL5+PL1)", async () => {
    const fetchFn = fetchMock();
    const a = await loadModule();
    a.emitPluginBootAnalytics({ containerRebuilt: true });
    await a.flushAnalytics();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(lastBody(fetchFn, 0).event).toBe("container_rebuilt");
    const second = lastBody(fetchFn, 1);
    expect(second.event).toBe("plugin_started");
    expect((second.properties as Record<string, unknown>).agent_kind).toBe("openclaw");
  });

  it("emitPluginBootAnalytics fires only plugin_started when not rebuilt", async () => {
    const fetchFn = fetchMock();
    const a = await loadModule();
    a.emitPluginBootAnalytics({ containerRebuilt: false });
    await a.flushAnalytics();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const props = lastBody(fetchFn, 0).properties as Record<string, unknown>;
    expect(lastBody(fetchFn, 0).event).toBe("plugin_started");
    // agent_version must resolve the real OpenClaw host version (exports map
    // blocks openclaw/package.json, so we walk up from the resolved entry).
    expect(props.agent_version).not.toBe("unknown");
    expect(props.agent_version).toMatch(/^\d/);
  });

  it("registerPairedClientId persists the join id so later events carry it (FLW4)", async () => {
    const fetchFn = fetchMock();
    const a = await loadModule();
    a.registerPairedClientId("phone-uuid-789");
    a.track("pairing_completed", { paired_client_id: "phone-uuid-789" });
    a.track("plugin_started", {});
    await a.flushAnalytics();
    // The follow-up plugin_started picks up the super property from the store.
    expect((lastBody(fetchFn, 1).properties as Record<string, unknown>).paired_client_id).toBe(
      "phone-uuid-789",
    );
  });
});
