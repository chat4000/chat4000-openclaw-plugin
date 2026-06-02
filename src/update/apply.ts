/**
 * Apply a self-update (install the latest plugin, optionally restart the gateway).
 *
 * Safety model:
 *   1. Run the read-only preflight; refuse unless `updatable` (or `force`).
 *   2. `openclaw plugins install --force <pkg>@<target>` (target defaults to the
 *      preflight's latest version — a PINNED version, never a bare tag).
 *   3. Restart the gateway only if `restart` is requested, using the detected
 *      method. Foreground restart uses a DETACHED helper because the plugin runs
 *      inside the gateway it is restarting.
 *
 * Honest limits:
 *   - The running process keeps the OLD code until the gateway restarts; "apply
 *     without restart" stages the new version on disk for the next boot.
 *   - Auto-rollback IS handled across a restart: when a restart is scheduled we
 *     drop a boot marker (boot-guard.ts); the next boot watches the new version
 *     and, if it never confirms healthy, reinstalls the previous pinned version.
 *     `rollbackTo()` remains for an explicit manual revert.
 */
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { readPackageName } from "../package-info.js";
import { writeUpdateMarker } from "./boot-guard.js";
import { checkUpdatePreflight, type RestartMethod, type UpdatePreflight } from "./preflight.js";

const run = promisify(execFile);

export type ApplyUpdateOptions = {
  /** Install this exact version. Defaults to the preflight's latest. */
  targetVersion?: string | undefined;
  /** Update even if preflight says not updatable (still requires a target). */
  force?: boolean | undefined;
  /** Restart the gateway after install so the new code loads. */
  restart?: boolean | undefined;
  /** Seconds to wait before a detached/foreground restart, so callers can reply first. */
  restartDelaySeconds?: number | undefined;
  timeoutMs?: number | undefined;
  log?: ((line: string) => void) | undefined;
};

export type ApplyUpdateResult = {
  ok: boolean;
  fromVersion: string;
  toVersion: string | null;
  installed: boolean;
  restartScheduled: boolean;
  restartMethod: RestartMethod;
  reason?: string;
  preflight: UpdatePreflight;
};

function resolveOpenclawBin(): string {
  return process.env.OPENCLAW_BIN?.trim() || "openclaw";
}

async function installVersion(
  packageName: string,
  version: string,
  timeoutMs: number,
  log: (l: string) => void,
): Promise<boolean> {
  const openclaw = resolveOpenclawBin();
  const spec = `${packageName}@${version}`;
  // Current CLI is `plugins install`; older is `plugin install`. Try both.
  for (const sub of [
    ["plugins", "install", "--force", spec],
    ["plugin", "install", "--force", spec],
  ]) {
    log(`$ ${openclaw} ${sub.join(" ")}`);
    try {
      const { stdout, stderr } = await run(openclaw, sub, { timeout: timeoutMs });
      if (stdout.trim()) log(stdout.trim());
      if (stderr.trim()) log(stderr.trim());
      return true;
    } catch (err) {
      log(`install attempt failed: ${String(err)}`);
    }
  }
  return false;
}

function scheduleRestart(
  method: RestartMethod,
  delaySeconds: number,
  log: (l: string) => void,
): boolean {
  const openclaw = resolveOpenclawBin();
  const delay = Math.max(1, delaySeconds);
  try {
    if (method === "docker") {
      // The container restart replaces this process; detach so we return first.
      const child = spawn("sh", ["-c", `sleep ${delay}; docker restart openclaw-gateway`], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      log(`scheduled: docker restart openclaw-gateway (in ${delay}s)`);
      return true;
    }
    if (method === "supervised") {
      const child = spawn("sh", ["-c", `sleep ${delay}; ${openclaw} gateway restart`], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      log(`scheduled: ${openclaw} gateway restart (in ${delay}s)`);
      return true;
    }
    if (method === "foreground") {
      // We run inside the gateway; a detached helper waits, kills it, relaunches.
      const script = `sleep ${delay}; pkill -f 'openclaw gateway run'; sleep 1; nohup ${openclaw} gateway run >/tmp/openclaw-gateway.log 2>&1 &`;
      const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
      child.unref();
      log(`scheduled: detached relaunch of 'openclaw gateway run' (in ${delay}s)`);
      return true;
    }
    log("restart method unknown — not scheduling a restart");
    return false;
  } catch (err) {
    log(`failed scheduling restart: ${String(err)}`);
    return false;
  }
}

export async function applyUpdate(opts: ApplyUpdateOptions = {}): Promise<ApplyUpdateResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const log = opts.log ?? (() => {});
  const packageName = readPackageName();
  const preflight = await checkUpdatePreflight({ timeoutMs: Math.min(timeoutMs, 8000) });

  const target = opts.targetVersion ?? preflight.latestVersion;

  if (!target) {
    return {
      ok: false,
      fromVersion: preflight.currentVersion,
      toVersion: null,
      installed: false,
      restartScheduled: false,
      restartMethod: preflight.restartMethod,
      reason: "could not resolve a target version to install",
      preflight,
    };
  }

  if (!preflight.updatable && !opts.force) {
    return {
      ok: false,
      fromVersion: preflight.currentVersion,
      toVersion: target,
      installed: false,
      restartScheduled: false,
      restartMethod: preflight.restartMethod,
      reason: preflight.newerAvailable
        ? "preflight blocked the update (a probe failed); pass force to override"
        : "already up to date",
      preflight,
    };
  }

  const installed = await installVersion(packageName, target, timeoutMs, log);
  if (!installed) {
    return {
      ok: false,
      fromVersion: preflight.currentVersion,
      toVersion: target,
      installed: false,
      restartScheduled: false,
      restartMethod: preflight.restartMethod,
      reason: "plugin install failed (see log)",
      preflight,
    };
  }

  let restartScheduled = false;
  if (opts.restart) {
    // Drop the boot marker BEFORE the restart fires so the next boot can guard
    // the new version and auto-roll-back if it fails to come up (boot-guard.ts).
    writeUpdateMarker(preflight.currentVersion, target);
    restartScheduled = scheduleRestart(preflight.restartMethod, opts.restartDelaySeconds ?? 3, log);
    if (!restartScheduled) {
      // No restart actually scheduled — don't leave a marker that would later
      // mis-fire a rollback.
      // (clearUpdateMarker is cheap and idempotent.)
      const { clearUpdateMarker } = await import("./boot-guard.js");
      clearUpdateMarker();
    }
  }

  return {
    ok: true,
    fromVersion: preflight.currentVersion,
    toVersion: target,
    installed: true,
    restartScheduled,
    restartMethod: preflight.restartMethod,
    reason: restartScheduled
      ? "installed; gateway restart scheduled"
      : "installed; restart the gateway to load the new version",
    preflight,
  };
}

/** Reinstall a pinned previous version (manual rollback). */
export async function rollbackTo(
  version: string,
  opts: { timeoutMs?: number; log?: (l: string) => void } = {},
): Promise<boolean> {
  const log = opts.log ?? (() => {});
  return installVersion(readPackageName(), version, opts.timeoutMs ?? 120_000, log);
}
