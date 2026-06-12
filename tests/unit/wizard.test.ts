import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWizardEnvSummary,
  runtimeLogReadySince,
  waitForGatewayReady,
} from "../../src/wizard.js";

/**
 * The wizard's readiness detection is the load-bearing correctness here: it must
 * (a) recognise a fresh `runtime.rooms_ready` / `runtime.hello_ok` line, and
 * (b) IGNORE a stale line written before the restart instant — otherwise the
 * "gateway up" signal could flash on a prior boot's log (the Hermes "fresh
 * marker" guarantee, ported). The log line format mirrors runtime-logger.ts.
 */

function logLine(stamp: string, event: string): string {
  return `${stamp} [tid:0] INFO ${event} account_id=default group_id=control`;
}

/** Format a Date as the runtime logger's local-time stamp `YYYY-MM-DD HH:MM:SS.mmm`. */
function stampFor(date: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`
  );
}

describe("runtimeLogReadySince", () => {
  it("returns true for a rooms_ready line written at/after the restart instant", () => {
    const t0 = Date.now();
    const fresh = stampFor(new Date(t0 + 2000));
    const log = `some boot noise\n${logLine(fresh, "runtime.rooms_ready")}\n`;
    expect(runtimeLogReadySince(log, t0)).toBe(true);
  });

  it("recognises runtime.hello_ok as a readiness signal too", () => {
    const t0 = Date.now();
    const fresh = stampFor(new Date(t0 + 500));
    expect(runtimeLogReadySince(logLine(fresh, "runtime.hello_ok"), t0)).toBe(true);
  });

  it("IGNORES a stale readiness line written before the restart instant", () => {
    const t0 = Date.now();
    const stale = stampFor(new Date(t0 - 60_000));
    const log = logLine(stale, "runtime.rooms_ready");
    expect(runtimeLogReadySince(log, t0)).toBe(false);
  });

  it("returns false when no readiness event is present at all", () => {
    const t0 = Date.now();
    const now = stampFor(new Date(t0 + 1000));
    expect(runtimeLogReadySince(logLine(now, "runtime.inbound"), t0)).toBe(false);
  });

  it("returns false on an empty log", () => {
    expect(runtimeLogReadySince("", Date.now())).toBe(false);
  });

  it("accepts a borderline line within the 1s clock-skew slack", () => {
    const t0 = Date.now();
    // 700ms BEFORE t0 — still within the -1s floor, so it should count.
    const borderline = stampFor(new Date(t0 - 700));
    expect(runtimeLogReadySince(logLine(borderline, "runtime.rooms_ready"), t0)).toBe(true);
  });
});

describe("waitForGatewayReady", () => {
  let tmpRoot: string;
  let runtimeLog: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "c4k-wiz-"));
    process.env.OPENCLAW_STATE_DIR = tmpRoot;
    runtimeLog = path.join(tmpRoot, "plugins", "chat4000", "logs", "runtime.log");
    mkdirSync(path.dirname(runtimeLog), { recursive: true });
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("resolves true as soon as a fresh readiness line appears in the log", async () => {
    const t0 = Date.now();
    writeFileSync(runtimeLog, logLine(stampFor(new Date(t0 + 100)), "runtime.rooms_ready") + "\n");
    const ready = await waitForGatewayReady(t0, {
      timeoutMs: 2000,
      pollMs: 20,
      log: () => {},
    });
    expect(ready).toBe(true);
  });

  it("returns false on timeout when only a stale line exists (no false-positive flash)", async () => {
    const t0 = Date.now();
    // A readiness line from a PRIOR boot must never satisfy the wait.
    writeFileSync(
      runtimeLog,
      logLine(stampFor(new Date(t0 - 120_000)), "runtime.rooms_ready") + "\n",
    );
    const ready = await waitForGatewayReady(t0, {
      timeoutMs: 120,
      pollMs: 20,
      log: () => {},
    });
    expect(ready).toBe(false);
  });

  it("returns false on timeout when the log is missing entirely", async () => {
    rmSync(runtimeLog, { force: true });
    const ready = await waitForGatewayReady(Date.now(), {
      timeoutMs: 100,
      pollMs: 20,
      log: () => {},
    });
    expect(ready).toBe(false);
  });
});

describe("buildWizardEnvSummary", () => {
  const savedEnv = process.env.CHAT4000_ENV;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CHAT4000_ENV;
    else process.env.CHAT4000_ENV = savedEnv;
  });

  it("defaults to prod and reports configured=false", () => {
    delete process.env.CHAT4000_ENV;
    const summary = buildWizardEnvSummary({ configured: false });
    expect(summary.env).toBe("prod");
    expect(summary.configured).toBe(false);
    expect(summary.pluginVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(summary.openclawCmd).toBeTruthy();
  });

  it("honours an explicit stage env flag", () => {
    const summary = buildWizardEnvSummary({ envFlag: "stage", configured: true });
    expect(summary.env).toBe("stage");
    expect(summary.configured).toBe(true);
  });
});
