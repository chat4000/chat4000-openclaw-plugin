import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reconcileUpdateMarker, writeUpdateMarker } from "../../src/update/boot-guard.js";

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.OPENCLAW_STATE_DIR;
  dir = mkdtempSync(path.join(os.tmpdir(), "c4k-bootguard-"));
  process.env.OPENCLAW_STATE_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("boot-guard", () => {
  it("reports none when there is no pending update", () => {
    expect(reconcileUpdateMarker({ currentVersion: "2.0.0" }).action).toBe("none");
  });

  it("guards the new version then clears the marker on confirmHealthy", () => {
    writeUpdateMarker("2.0.0", "2.1.0");
    const guard = reconcileUpdateMarker({ currentVersion: "2.1.0" });
    expect(guard.action).toBe("guard");
    guard.confirmHealthy();
    expect(reconcileUpdateMarker({ currentVersion: "2.1.0" }).action).toBe("none");
  });

  it("drops the marker if a different version is running (install never took)", () => {
    writeUpdateMarker("2.0.0", "2.1.0");
    expect(reconcileUpdateMarker({ currentVersion: "2.0.0" }).action).toBe("none");
  });

  it("rolls back to the previous version after repeated failed boots", () => {
    writeUpdateMarker("2.0.0", "2.1.0");
    expect(reconcileUpdateMarker({ currentVersion: "2.1.0" }).action).toBe("guard");
    expect(reconcileUpdateMarker({ currentVersion: "2.1.0" }).action).toBe("guard");
    const guard = reconcileUpdateMarker({ currentVersion: "2.1.0" });
    expect(guard.action).toBe("rollback");
    expect(guard.rollbackToVersion).toBe("2.0.0");
  });
});
