import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * IDN7/IDN8/IDN9 — the two-id machine identity. The resolved state-dir root is
 * driven by OPENCLAW_STATE_DIR; the `~/.openclaw` split-id fallback is driven by
 * a spied `os.homedir()`; the env-id file path is the mocked telemetry constant.
 */
const AGENT_FILE = "chat4000-install-id";

let tmpRoot: string;
let stateDir: string;
let fakeHome: string;
let envIdPath: string;

type MachineIds = typeof import("../../src/machine-ids.js");

async function loadModule(): Promise<MachineIds> {
  vi.resetModules();
  vi.doMock("../../src/telemetry.js", () => ({ INSTALL_ID_PATH: envIdPath }));
  return import("../../src/machine-ids.js");
}

function write(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "c4k-mid-"));
  stateDir = path.join(tmpRoot, "state");
  fakeHome = path.join(tmpRoot, "home");
  envIdPath = path.join(tmpRoot, "config", "install-id");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  delete process.env.OPENCLAW_HOME;
  vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.doUnmock("../../src/telemetry.js");
});

describe("machine-ids — IDN8 agent_install_id", () => {
  it("mints a fresh uuid at the resolved state-dir root when none exists", async () => {
    const m = await loadModule();
    const id = m.readOrMintAgentInstallId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const file = path.join(stateDir, AGENT_FILE);
    expect(m.agentInstallIdPath()).toBe(file);
    expect(readFileSync(file, "utf8").trim()).toBe(id);
  });

  it("reads the existing id at the resolved root without re-minting", async () => {
    write(path.join(stateDir, AGENT_FILE), "EXISTING-ID\n");
    const m = await loadModule();
    expect(m.readOrMintAgentInstallId()).toBe("EXISTING-ID");
  });

  it("split-id guard: adopts the ~/.openclaw fallback id instead of minting a second", async () => {
    // Installer ran without OPENCLAW_STATE_DIR set → id landed at the home fallback.
    write(path.join(fakeHome, ".openclaw", AGENT_FILE), "FALLBACK-ID\n");
    const m = await loadModule();
    const id = m.readOrMintAgentInstallId();
    expect(id).toBe("FALLBACK-ID");
    // ...and it is copied to the resolved root so both locations now agree.
    expect(readFileSync(path.join(stateDir, AGENT_FILE), "utf8").trim()).toBe("FALLBACK-ID");
  });

  it("caches within a process — a later file change does not change the returned id", async () => {
    const m = await loadModule();
    const first = m.readOrMintAgentInstallId();
    write(path.join(stateDir, AGENT_FILE), "CHANGED-OUT-OF-BAND\n");
    expect(m.readOrMintAgentInstallId()).toBe(first);
  });
});

describe("machine-ids — IDN9 container_rebuilt", () => {
  it("is true when the agent id survived but the env-id file is absent", async () => {
    write(path.join(stateDir, AGENT_FILE), "AGENT-ID\n");
    // envIdPath intentionally not created (about to be minted fresh this boot).
    const m = await loadModule();
    expect(m.detectContainerRebuilt()).toBe(true);
  });

  it("is false when the env-id file is present (normal restart)", async () => {
    write(path.join(stateDir, AGENT_FILE), "AGENT-ID\n");
    write(envIdPath, "ENV-ID\n");
    const m = await loadModule();
    expect(m.detectContainerRebuilt()).toBe(false);
  });

  it("is false on a genuinely new machine (no agent id yet)", async () => {
    const m = await loadModule();
    expect(m.detectContainerRebuilt()).toBe(false);
  });

  it("snapshotContainerRebuilt is idempotent (captured before env-id mint)", async () => {
    write(path.join(stateDir, AGENT_FILE), "AGENT-ID\n");
    const m = await loadModule();
    const first = m.snapshotContainerRebuilt();
    expect(first).toBe(true);
    // Even if the env-id file appears afterwards, the snapshot stays put.
    write(envIdPath, "ENV-ID\n");
    expect(m.snapshotContainerRebuilt()).toBe(true);
  });
});
