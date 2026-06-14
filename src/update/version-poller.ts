/**
 * Resident plugin-version poller (PROTOCOL C.5.2 `POST /plugin-version`).
 *
 * The gateway-resident plugin periodically asks the registrar **which exact
 * build it should be running and where the install source is** (C.5.2), and —
 * when its installed version is not that build — installs `source` and restarts
 * into it (reusing the self-update apply/restart path in {@link applyUpdate}).
 *
 * This is distinct from the boot-time version-POLICY check (C.5.1
 * `POST /version`, force/recommend/terms): that one decides whether to refuse
 * to operate; THIS one keeps the resident build at the registrar-selected
 * version. C.5 forbids putting either on the message path, so:
 *
 *   - Cadence is env-gated and slow: **stage 60 s, prod 3600 s** — never tied to
 *     message traffic.
 *   - A pending install/restart is DEFERRED while an agent turn / relay is in
 *     flight ({@link agentTurnInFlight}); the poller re-checks on the next tick
 *     and applies once the path is clear. This honors C.5 "not on the message
 *     path": a restart never drops a live reply.
 *
 * Robustness: a failed/unreachable registrar check logs and retries next tick;
 * it never throws out of the timer and never crashes the plugin.
 */
import { type Chat4000Env } from "../pairing/env.js";
import { readPackageName, readPackageVersion } from "../package-info.js";
import { type PluginVersionResult, type RegistrarClient } from "../pairing/registrar.js";
import { agentTurnInFlight } from "../turn-tracker.js";
import { applyUpdate } from "./apply.js";

/** Poll cadence by environment (PROTOCOL C.5 "not on the message path"). */
const POLL_INTERVAL_MS: Record<Chat4000Env, number> = {
  stage: 60_000, // 60 s
  prod: 3_600_000, // 3600 s = 1 hour
};

/** The env→interval mapping (stage 60 s / prod 3600 s). Exported for tests. */
export function pollIntervalMsForEnv(env: Chat4000Env): number {
  return POLL_INTERVAL_MS[env];
}

/**
 * The decision a single `POST /plugin-version` result implies, given the
 * installed version. Pure + side-effect-free so it is unit-testable on its own.
 *
 *   - `noop`    — installed version already equals `current_version`.
 *   - `update`  — versions differ; install `source` and restart into it.
 */
export type VersionPollDecision =
  | { kind: "noop"; installedVersion: string; currentVersion: string }
  | {
      kind: "update";
      installedVersion: string;
      currentVersion: string;
      source: string;
    };

/**
 * PROTOCOL C.5.2 caller rule: the plugin must either already be **exactly**
 * `current_version`, or install `source` and restart into it. Exact string
 * compare (the registrar names the precise build; this is not a semver "newer"
 * test — a pin-down/rollback names an older version and must still apply).
 */
export function decideVersionPoll(
  installedVersion: string,
  result: PluginVersionResult,
): VersionPollDecision {
  if (installedVersion === result.currentVersion) {
    return { kind: "noop", installedVersion, currentVersion: result.currentVersion };
  }
  return {
    kind: "update",
    installedVersion,
    currentVersion: result.currentVersion,
    source: result.source,
  };
}

export type VersionPollerOptions = {
  /** Registrar client carrying the SERVICE token (C.5.2 is service-token auth). */
  registrar: RegistrarClient;
  /** Backend env — fixes the cadence (stage 60 s / prod 3600 s). */
  env: Chat4000Env;
  /** The machine analytics id (agent_install_id); null when telemetry is off. */
  clientId?: string | null | undefined;
  /** Structured logger sink. */
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Route unexpected errors to the telemetry sink. */
  report?: (err: unknown, where: string) => void;
  /** Injectable installed-version reader (defaults to the package.json version). */
  readInstalledVersion?: () => string;
  /** Injectable apply (defaults to {@link applyUpdate}); for tests. */
  apply?: typeof applyUpdate;
  /** Injectable "is a relay in flight" gate (defaults to {@link agentTurnInFlight}). */
  isTurnInFlight?: () => boolean;
};

/**
 * Resident poller. `start()` schedules the first tick one interval out (the
 * boot-time C.5.1 check already ran at startup, so there is no need to also hit
 * C.5.2 immediately); `stop()` clears the timer cleanly on shutdown.
 */
export class VersionPoller {
  private timer: ReturnType<typeof setTimeout> | undefined;

  private running = false;

  private readonly intervalMs: number;

  private readonly appId: string;

  constructor(private readonly opts: VersionPollerOptions) {
    this.intervalMs = pollIntervalMsForEnv(opts.env);
    this.appId = readPackageName();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.log?.("runtime.version_poll_start", {
      env: this.opts.env,
      interval_ms: this.intervalMs,
    });
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      // Never let a tick reject out of the timer — that would be an unhandled
      // rejection. Run the whole tick inside the safe wrapper.
      void this.tick().finally(() => this.schedule());
    }, this.intervalMs);
    // Don't hold the process open on the poll timer alone.
    this.timer.unref?.();
  }

  /**
   * One poll: ask the registrar (C.5.2), decide, and — if an update is due —
   * apply it UNLESS a relay is in flight (defer to the next tick). Never throws.
   */
  async tick(): Promise<void> {
    try {
      const installedVersion = (this.opts.readInstalledVersion ?? readPackageVersion)();
      const result = await this.opts.registrar.checkPluginVersion({
        appId: this.appId,
        clientId: this.opts.clientId,
      });
      const decision = decideVersionPoll(installedVersion, result);
      if (decision.kind === "noop") {
        this.opts.log?.("runtime.version_poll_ok", { version: installedVersion });
        return;
      }

      // PROTOCOL C.5: defer the restart while a turn/relay is in flight so we
      // never drop a live reply. Re-checked on the next tick.
      const isTurnInFlight = this.opts.isTurnInFlight ?? agentTurnInFlight;
      if (isTurnInFlight()) {
        this.opts.log?.("runtime.version_poll_deferred", {
          from: decision.installedVersion,
          to: decision.currentVersion,
          reason: "agent_turn_in_flight",
        });
        return;
      }

      this.opts.log?.("runtime.version_poll_applying", {
        from: decision.installedVersion,
        to: decision.currentVersion,
        source: decision.source,
      });
      const apply = this.opts.apply ?? applyUpdate;
      const res = await apply({
        targetVersion: decision.currentVersion,
        source: decision.source,
        force: true,
        restart: true,
        trigger: "command",
        log: (line) => this.opts.log?.("runtime.version_poll_log", { detail: line }),
      });
      this.opts.log?.("runtime.version_poll_applied", {
        ok: res.ok,
        installed: res.installed,
        restart_scheduled: res.restartScheduled,
        reason: res.reason,
      });
      // A scheduled restart will replace this process shortly; stop polling so we
      // don't fire another install in the gap before the restart lands.
      if (res.restartScheduled) this.stop();
    } catch (err) {
      // Robust: a failed/unreachable check logs and retries next tick.
      this.opts.log?.("runtime.version_poll_error", { error: String(err) });
      this.opts.report?.(err, "update.versionPoller");
    }
  }
}
