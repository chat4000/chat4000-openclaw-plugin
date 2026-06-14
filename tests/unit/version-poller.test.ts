import { spawn } from "node:child_process";

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  decideVersionPoll,
  launchInstaller,
  pollIntervalMsForEnv,
  VersionPoller,
} from "../../src/update/version-poller.js";
import type { PluginVersionResult, RegistrarClient } from "../../src/pairing/registrar.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

/** The registrar `source` is now the WHOLE installer command, run verbatim. */
const INSTALLER_CMD =
  "curl -fsSL https://example/install.sh | bash -s -- --openclaw-branch v2.0.0 --no-pair --stage";

function pluginVersion(partial: Partial<PluginVersionResult>): PluginVersionResult {
  return { currentVersion: "2.0.0", source: INSTALLER_CMD, ...partial };
}

/** A RegistrarClient stub whose only used method is checkPluginVersion. */
function stubRegistrar(result: PluginVersionResult | (() => Promise<PluginVersionResult>)): {
  registrar: RegistrarClient;
  calls: { appId: string; clientId?: string | null | undefined }[];
} {
  const calls: { appId: string; clientId?: string | null | undefined }[] = [];
  const registrar = {
    checkPluginVersion: vi.fn(async (params: { appId: string; clientId?: string | null }) => {
      calls.push(params);
      return typeof result === "function" ? await result() : result;
    }),
  } as unknown as RegistrarClient;
  return { registrar, calls };
}

describe("pollIntervalMsForEnv (PROTOCOL C.5 cadence)", () => {
  it("polls every 60 s on stage", () => {
    expect(pollIntervalMsForEnv("stage")).toBe(60_000);
  });

  it("polls every 3600 s (1 hour) on prod", () => {
    expect(pollIntervalMsForEnv("prod")).toBe(3_600_000);
  });
});

describe("decideVersionPoll (PROTOCOL C.5.2 caller rule)", () => {
  it("is a no-op when the installed version already equals current_version", () => {
    const d = decideVersionPoll("2.0.0", pluginVersion({ currentVersion: "2.0.0" }));
    expect(d.kind).toBe("noop");
  });

  it("returns an update carrying the source command when the versions differ", () => {
    const d = decideVersionPoll("1.0.0", pluginVersion({ currentVersion: "2.0.0" }));
    expect(d).toEqual({
      kind: "update",
      installedVersion: "1.0.0",
      currentVersion: "2.0.0",
      source: INSTALLER_CMD,
    });
  });

  it("updates even when current_version is OLDER (a pin-down/rollback is exact-match, not semver-newer)", () => {
    const d = decideVersionPoll("2.5.0", pluginVersion({ currentVersion: "2.0.0" }));
    expect(d.kind).toBe("update");
    if (d.kind === "update") expect(d.currentVersion).toBe("2.0.0");
  });
});

describe("VersionPoller.tick (launch installer + deferral)", () => {
  const baseOpts = {
    env: "stage" as const,
    readInstalledVersion: () => "1.0.0",
  };

  it("does nothing when the installed version matches current_version", async () => {
    const { registrar, calls } = stubRegistrar(pluginVersion({ currentVersion: "1.0.0" }));
    const launch = vi.fn(() => true);
    const poller = new VersionPoller({ ...baseOpts, registrar, launchInstaller: launch });

    await poller.tick();

    expect(calls).toHaveLength(1);
    expect(launch).not.toHaveBeenCalled();
  });

  it("DEFERS the installer launch while an agent turn is in flight (PROTOCOL C.5 not-on-message-path)", async () => {
    const { registrar } = stubRegistrar(pluginVersion({ currentVersion: "2.0.0" }));
    const launch = vi.fn(() => true);
    const poller = new VersionPoller({
      ...baseOpts,
      registrar,
      launchInstaller: launch,
      isTurnInFlight: () => true,
    });

    await poller.tick();

    expect(launch).not.toHaveBeenCalled();
  });

  it("runs the registrar's source command VERBATIM when versions differ and no turn is in flight (C.5.2)", async () => {
    const { registrar } = stubRegistrar(
      pluginVersion({ currentVersion: "2.0.0", source: INSTALLER_CMD }),
    );
    const launch = vi.fn(() => true);
    const poller = new VersionPoller({
      ...baseOpts,
      registrar,
      launchInstaller: launch,
      isTurnInFlight: () => false,
    });

    await poller.tick();

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(INSTALLER_CMD);
  });

  it("never throws when the registrar check fails — logs and returns (robust)", async () => {
    const { registrar } = stubRegistrar(() => Promise.reject(new Error("registrar unreachable")));
    const launch = vi.fn(() => true);
    const errors: unknown[] = [];
    const poller = new VersionPoller({
      ...baseOpts,
      registrar,
      launchInstaller: launch,
      report: (err) => errors.push(err),
    });

    await expect(poller.tick()).resolves.toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });

  it("passes the agent_install_id through as the X-Client-Id rollout key (C.5.2)", async () => {
    const { registrar, calls } = stubRegistrar(pluginVersion({ currentVersion: "1.0.0" }));
    const poller = new VersionPoller({ ...baseOpts, registrar, clientId: "install-id-xyz" });

    await poller.tick();

    expect(calls[0]?.clientId).toBe("install-id-xyz");
  });
});

describe("launchInstaller (run source verbatim, detached)", () => {
  const spawnMock = spawn as unknown as Mock;

  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("spawns the source through sh -c, detached + stdio ignored, and unrefs", () => {
    const unref = vi.fn();
    spawnMock.mockReturnValue({ unref });

    expect(launchInstaller(INSTALLER_CMD)).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith("sh", ["-c", INSTALLER_CMD], {
      detached: true,
      stdio: "ignore",
    });
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("returns false when the process cannot be spawned", () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    expect(launchInstaller("anything")).toBe(false);
  });
});
