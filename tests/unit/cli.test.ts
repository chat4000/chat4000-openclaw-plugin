import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerChat4000Cli } from "../../src/cli.js";

// Silence the ASCII QR (qrcode-terminal prints straight to the console).
vi.mock("qrcode-terminal", () => ({ default: { generate: vi.fn() } }));

type ActionHandler = (...args: unknown[]) => unknown;

/** Structural twin of the (unexported) CliCommand the host's Commander passes in. */
type FakeCommand = {
  command: (name: string, opts?: { hidden?: boolean }) => FakeCommand;
  description: (text: string) => FakeCommand;
  option: (flags: string, description?: string, defaultValue?: string) => FakeCommand;
  action: <A extends unknown[]>(handler: (...args: A) => void | Promise<void>) => FakeCommand;
};

/**
 * Register the real CLI against a fake Commander program and return the action
 * handlers keyed by command path (e.g. "chat4000 pair").
 */
function captureCliActions(): Map<string, ActionHandler> {
  const actions = new Map<string, ActionHandler>();
  const makeNode = (parts: string[]): FakeCommand => {
    const node: FakeCommand = {
      command: (name: string): FakeCommand => makeNode([...parts, name]),
      description: (): FakeCommand => node,
      option: (): FakeCommand => node,
      action: <A extends unknown[]>(handler: (...args: A) => void | Promise<void>): FakeCommand => {
        actions.set(parts.join(" "), handler as ActionHandler);
        return node;
      },
    };
    return node;
  };
  registerChat4000Cli({
    registerCli: (registrar): void => {
      registrar({ program: makeNode([]), config: {} });
    },
  });
  return actions;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const CRED_ENV_VARS = [
  "CHAT4000_GATEWAY_URL",
  "CHAT4000_HOMESERVER",
  "CHAT4000_USER_ID",
  "CHAT4000_ACCESS_TOKEN",
  "CHAT4000_DEVICE_ID",
] as const;

describe("chat4000 CLI error/exit-code boundary", () => {
  let stateDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let savedExitCode: typeof process.exitCode;

  function writtenOutput(): string {
    return stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
  }

  beforeEach(() => {
    savedExitCode = process.exitCode;
    stateDir = mkdtempSync(path.join(os.tmpdir(), "chat4000-cli-test-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    for (const name of CRED_ENV_VARS) delete process.env[name];
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    delete process.env.OPENCLAW_STATE_DIR;
    for (const name of CRED_ENV_VARS) delete process.env[name];
    stdoutSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** Point the resolved account at env credentials so `pair` reaches polling. */
  function configureEnvIdentity(): void {
    process.env.CHAT4000_GATEWAY_URL = "wss://gateway.test.invalid/ws";
    process.env.CHAT4000_USER_ID = "@plugin_x:chat4000.com";
    process.env.CHAT4000_ACCESS_TOKEN = "tok";
    process.env.CHAT4000_DEVICE_ID = "DEV1";
  }

  // BUG (live 2026-06-12): `openclaw chat4000 setup --self-redeem` printed
  // "chat4000 error: …" for invalid/missing tokens and missing identity, yet
  // exited 0 — the installer believed setup succeeded. Every handled CLI error
  // must mark the process failed.
  it("pair without a Matrix identity prints chat4000 error AND sets exitCode 1", async () => {
    const actions = captureCliActions();
    const pair = actions.get("chat4000 pair");
    expect(pair).toBeDefined();
    await pair?.({});
    expect(writtenOutput()).toContain("chat4000 error: No Matrix identity yet");
    expect(process.exitCode).toBe(1);
  });

  it("setup without credentials or --self-redeem sets exitCode 1", async () => {
    const actions = captureCliActions();
    const setup = actions.get("chat4000 setup");
    expect(setup).toBeDefined();
    await setup?.({});
    expect(writtenOutput()).toContain("chat4000 error: Provide either --self-redeem");
    expect(process.exitCode).toBe(1);
  });

  it("synchronous command errors (sessions bind) also set exitCode 1", async () => {
    const actions = captureCliActions();
    const bind = actions.get("chat4000 sessions bind");
    expect(bind).toBeDefined();
    await bind?.({});
    expect(writtenOutput()).toContain("chat4000 error: missing --room");
    expect(process.exitCode).toBe(1);
  });

  // BUG (live 2026-06-12, Hermes twin): a 429 M_LIMIT_EXCEEDED from
  // /pair/status killed pairing. The poll loop must retry transient errors
  // with exponential backoff (2s doubling, 30s cap) inside the ttl deadline.
  it("pair retries transient /pair/status errors with exponential backoff", async () => {
    // Fake only what the poll loop uses; keep setImmediate REAL so the stepping
    // loop below can yield genuine event-loop turns (the pre-poll QR-module
    // import needs them — without this the loop can finish all its iterations
    // before the import resolves and the run hangs).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    configureEnvIdentity();
    const statusCallTimes: number[] = [];
    let statusAttempts = 0;
    const fetchMock = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = urlOf(input);
      if (url.includes("/version")) return jsonResponse(200, { action: "ok" });
      if (url.includes("/pair/register")) {
        return jsonResponse(200, { ok: true, expires_at: Date.now() + 300_000 });
      }
      if (url.includes("/pair/status")) {
        statusCallTimes.push(Date.now());
        statusAttempts += 1;
        if (statusAttempts <= 2) {
          return jsonResponse(429, { errcode: "M_LIMIT_EXCEEDED", error: "Too Many Requests" });
        }
        return jsonResponse(200, { status: "completed" });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const actions = captureCliActions();
    const pair = actions.get("chat4000 pair");
    expect(pair).toBeDefined();
    const run = pair?.({ ttl: "300" });
    // Step the fake clock so each sleep/backoff timer fires in order, yielding
    // a real event-loop turn between steps (setImmediate is not faked).
    for (let i = 0; i < 120 && statusAttempts < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await run;
    // 429 → next poll after 4s (2s doubled); 429 again → next after 8s.
    // (Gaps, not absolute times: the pre-poll awaits — version check, register,
    // QR render — consume a few stepped fake-clock ticks before the loop.)
    expect(statusCallTimes.length).toBe(3);
    const gaps = statusCallTimes.slice(1).map((t, i) => t - (statusCallTimes[i] ?? 0));
    expect(gaps).toEqual([4_000, 8_000]);
    expect(writtenOutput()).toContain("✓ Device paired");
    expect(process.exitCode).not.toBe(1);
  });

  it("pair fails fast (no retry, exitCode 1) on a permanent 4xx from /pair/status", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    configureEnvIdentity();
    let statusAttempts = 0;
    const fetchMock = vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = urlOf(input);
      if (url.includes("/version")) return jsonResponse(200, { action: "ok" });
      if (url.includes("/pair/register")) {
        return jsonResponse(200, { ok: true, expires_at: Date.now() + 300_000 });
      }
      if (url.includes("/pair/status")) {
        statusAttempts += 1;
        return jsonResponse(401, { errcode: "M_UNKNOWN_TOKEN", error: "Invalid service token" });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const actions = captureCliActions();
    const pair = actions.get("chat4000 pair");
    expect(pair).toBeDefined();
    const run = pair?.({ ttl: "300" });
    for (let i = 0; i < 120 && statusAttempts < 1; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await run;
    expect(statusAttempts).toBe(1);
    expect(writtenOutput()).toContain("chat4000 error: Invalid service token");
    expect(process.exitCode).toBe(1);
  });
});
