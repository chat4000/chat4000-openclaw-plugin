import { describe, expect, it, vi } from "vitest";
import {
  decideVersionPoll,
  pollIntervalMsForEnv,
  VersionPoller,
} from "../../src/update/version-poller.js";
import type { PluginVersionResult, RegistrarClient } from "../../src/pairing/registrar.js";
import type { ApplyUpdateResult } from "../../src/update/apply.js";

function pluginVersion(partial: Partial<PluginVersionResult>): PluginVersionResult {
  return { currentVersion: "2.0.0", source: "github:chat4000/openclaw-plugin#v2.0.0", ...partial };
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

function applyResult(partial: Partial<ApplyUpdateResult>): ApplyUpdateResult {
  return {
    ok: true,
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    installed: true,
    restartScheduled: true,
    restartMethod: "docker",
    preflight: {
      packageName: "@chat4000/openclaw-plugin",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      updatable: true,
      newerAvailable: true,
      restartMethod: "docker",
      probes: [],
    },
    ...partial,
  };
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

  it("schedules an update with the source when the versions differ (upgrade)", () => {
    const d = decideVersionPoll(
      "1.0.0",
      pluginVersion({ currentVersion: "2.0.0", source: "pkg@2.0.0" }),
    );
    expect(d).toEqual({
      kind: "update",
      installedVersion: "1.0.0",
      currentVersion: "2.0.0",
      source: "pkg@2.0.0",
    });
  });

  it("schedules an update even when current_version is OLDER (a pin-down/rollback is exact-match, not semver-newer)", () => {
    const d = decideVersionPoll(
      "2.5.0",
      pluginVersion({ currentVersion: "2.0.0", source: "pkg@2.0.0" }),
    );
    expect(d.kind).toBe("update");
    if (d.kind === "update") expect(d.currentVersion).toBe("2.0.0");
  });
});

describe("VersionPoller.tick (apply + deferral)", () => {
  const baseOpts = {
    env: "stage" as const,
    readInstalledVersion: () => "1.0.0",
  };

  it("does nothing when the installed version matches current_version", async () => {
    const { registrar, calls } = stubRegistrar(pluginVersion({ currentVersion: "1.0.0" }));
    const apply = vi.fn();
    const poller = new VersionPoller({ ...baseOpts, registrar, apply });

    await poller.tick();

    expect(calls).toHaveLength(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it("DEFERS the install+restart while an agent turn is in flight (PROTOCOL C.5 not-on-message-path)", async () => {
    const { registrar } = stubRegistrar(pluginVersion({ currentVersion: "2.0.0" }));
    const apply = vi.fn();
    const poller = new VersionPoller({
      ...baseOpts,
      registrar,
      apply,
      isTurnInFlight: () => true,
    });

    await poller.tick();

    expect(apply).not.toHaveBeenCalled();
  });

  it("installs source + schedules a restart when versions differ and no turn is in flight (C.5.2)", async () => {
    const { registrar } = stubRegistrar(
      pluginVersion({ currentVersion: "2.0.0", source: "github:chat4000/openclaw-plugin#v2.0.0" }),
    );
    const apply = vi.fn(() => Promise.resolve(applyResult({ restartScheduled: true })));
    const poller = new VersionPoller({
      ...baseOpts,
      registrar,
      apply,
      isTurnInFlight: () => false,
    });

    await poller.tick();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        targetVersion: "2.0.0",
        source: "github:chat4000/openclaw-plugin#v2.0.0",
        force: true,
        restart: true,
      }),
    );
  });

  it("never throws when the registrar check fails — logs and returns (robust)", async () => {
    const { registrar } = stubRegistrar(() => Promise.reject(new Error("registrar unreachable")));
    const apply = vi.fn();
    const errors: unknown[] = [];
    const poller = new VersionPoller({
      ...baseOpts,
      registrar,
      apply,
      report: (err) => errors.push(err),
    });

    await expect(poller.tick()).resolves.toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });

  it("passes the agent_install_id through as the X-Client-Id rollout key (C.5.2)", async () => {
    const { registrar, calls } = stubRegistrar(pluginVersion({ currentVersion: "1.0.0" }));
    const poller = new VersionPoller({ ...baseOpts, registrar, clientId: "install-id-xyz" });

    await poller.tick();

    expect(calls[0]?.clientId).toBe("install-id-xyz");
  });
});
