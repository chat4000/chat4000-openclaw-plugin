/**
 * Interactive install wizard — `openclaw chat4000 wizard`.
 *
 * A guided, three-step wrapper around the existing setup + gateway-restart +
 * pairing internals. Ported from the Hermes plugin's `install_wizard.py`
 * (the UX single-source-of-truth): banner -> environment summary ->
 *   Step 1/3  Prepare the plugin   (self-redeem a bot identity, no pairing yet)
 *   Step 2/3  Bring the gateway online (restart so it loads the plugin, wait ready)
 *   Step 3/3  Pair a device         (QR + code; the live gateway invites the user)
 * -> success panel.
 *
 * Adaptations to OpenClaw (vs. the Hermes reference):
 *   - No venv. The wizard runs in-process and reuses the plugin's own setup/pair
 *     internals (cli.ts `runSetup` / `runPair`, injected via `WizardDeps`) rather
 *     than shelling out to a sibling CLI binary.
 *   - Identity is minted via `setup --self-redeem --no-pair` (this repo's
 *     equivalent of Hermes' `prepare`), reusing `provisionBot`.
 *   - Gateway restart-method detection reuses the self-update preflight
 *     (`checkUpdatePreflight().restartMethod`: docker | supervised | foreground).
 *   - Readiness is detected by tailing the plugin's own `runtime.log` for a
 *     `runtime.rooms_ready` / `runtime.hello_ok` line written AT OR AFTER the
 *     restart instant — the OpenClaw analogue of Hermes' fresh "ready marker".
 *
 * KNOWN DEFECT IN THE HERMES REFERENCE — deliberately NOT reproduced: the Hermes
 * wizard detects a live gateway only by matching the exact string
 * "hermes gateway run", so a gateway started as "hermes gateway" is missed, a
 * second colliding gateway is launched, and the loader hangs at 99%. Here
 * `gatewayIsRunning()` matches ANY gateway invocation form (`openclaw gateway`,
 * `openclaw gateway run`, the `openclaw-gateway` binary, a `docker` container),
 * and the restart prefers the explicit detected method over guessing.
 */
import { stdout as output } from "node:process";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { readPackageVersion } from "./package-info.js";
import { resolveOpenClawHome } from "./paths.js";
import { resolveEnv, type Chat4000Env } from "./pairing/env.js";
import { checkUpdatePreflight, type RestartMethod } from "./update/preflight.js";

const run = promisify(execFile);

// Icons — same glyph vocabulary the Hermes wizard uses; render in any modern
// terminal and match the rest of this CLI's output (✓ / ✗ / ⚠).
const ICO_OK = "✓";
const ICO_INFO = "ℹ";
const ICO_WAIT = "⏳";
const ICO_LOCK = "🔐";
const ICO_ROCKET = "🚀";
const ICO_PHONE = "📱";
const ICO_SPARK = "✨";

/** A single line written to the wizard's output stream (newline appended). */
function line(text = ""): void {
  output.write(`${text}\n`);
}

// ─── Presentation ────────────────────────────────────────────────────────────

function banner(): void {
  line();
  line(`${ICO_LOCK}  chat4000  ·  OpenClaw plugin installer`);
  line("   Native iPhone / Mac / CLI app for your OpenClaw agent");
  line();
}

/** A small "Step N/M  Title" rule, matching the Hermes wizard's section headers. */
function stepRule(title: string, step: number, total: number): void {
  line();
  line(`── Step ${step}/${total}  ${title} ${"─".repeat(Math.max(0, 48 - title.length))}`);
}

export type WizardEnvSummary = {
  openclawCmd: string;
  pluginVersion: string;
  env: Chat4000Env;
  configured: boolean;
};

function printEnvSummary(summary: WizardEnvSummary): void {
  line(`  openclaw  ${summary.openclawCmd || "(not on PATH)"}`);
  line(`  plugin    ${summary.pluginVersion}`);
  line(`  env       ${summary.env}`);
  line(
    `  identity  ${
      summary.configured ? `${ICO_OK} configured` : `${ICO_WAIT} not yet (will mint now)`
    }`,
  );
  line();
}

function successPanel(): void {
  line();
  line(`${ICO_SPARK}  Setup complete!`);
  line();
  line("Send a message from the chat4000 app — your OpenClaw agent will reply.");
  line();
  line("Useful commands:");
  line("  openclaw chat4000 status        show config + identity");
  line("  openclaw chat4000 pair          pair another device");
  line(`  tail -f ${gatewayLogPath()}   follow gateway logs`);
  line();
}

// ─── Gateway process detection + restart ─────────────────────────────────────

/** The OpenClaw CLI binary (honours OPENCLAW_BIN, same as the self-update path). */
function resolveOpenclawBin(): string {
  return process.env.OPENCLAW_BIN?.trim() || "openclaw";
}

/** Well-known log file the foreground-started gateway writes (and the user tails). */
function gatewayLogPath(): string {
  return process.env.OPENCLAW_GATEWAY_LOG?.trim() || "/tmp/openclaw-gateway.log";
}

/** The plugin runtime log we poll for a readiness line. Mirrors runtime-logger.ts. */
function runtimeLogPath(): string {
  return path.join(resolveOpenClawHome(), "plugins", "chat4000", "logs", "runtime.log");
}

/**
 * Process-name patterns that mean "an OpenClaw gateway is running", in ANY
 * invocation form. This is the explicit fix for the Hermes defect (which matched
 * only "hermes gateway run"): we match the bare `openclaw gateway` prefix (so
 * `openclaw gateway`, `openclaw gateway run`, `openclaw gateway start`, … all
 * count) and the `openclaw-gateway` standalone binary.
 */
const GATEWAY_PATTERNS: readonly string[] = ["openclaw gateway", "openclaw-gateway"];

/**
 * True if a gateway process is running under ANY invocation form. Uses `pgrep -f`
 * per pattern; `pgrep` missing (non-Linux/-mac) or no match yields false. Never
 * throws — detection is best-effort.
 */
async function gatewayIsRunning(): Promise<boolean> {
  for (const pattern of GATEWAY_PATTERNS) {
    try {
      // pgrep exits 0 with matches, 1 with none (rejects the promise on 1).
      await run("pgrep", ["-f", pattern], { timeout: 4000 });
      return true;
    } catch {
      // no match for this pattern, or pgrep unavailable — try the next.
    }
  }
  return false;
}

type GatewayRestartPlan = {
  method: RestartMethod;
  /** Human description of what will happen, shown to the user before it runs. */
  detail: string;
};

/**
 * Decide HOW to restart the gateway, reusing the self-update preflight's probe
 * (docker container / supervised service / bare foreground). We always prefer an
 * explicit, method-appropriate restart over guessing or spawning a second
 * gateway alongside a running one.
 */
async function planGatewayRestart(): Promise<GatewayRestartPlan> {
  const preflight = await checkUpdatePreflight({ timeoutMs: 6000 });
  const detail =
    preflight.restartMethod === "docker"
      ? "docker: restart the openclaw-gateway container"
      : preflight.restartMethod === "supervised"
        ? "supervised: openclaw gateway restart"
        : preflight.restartMethod === "foreground"
          ? "foreground: stop any running gateway, then relaunch detached"
          : "unknown: will best-effort (re)launch the gateway";
  return { method: preflight.restartMethod, detail };
}

/**
 * Restart (or start) the gateway so it loads the freshly-prepared plugin.
 *
 * For docker/supervised we issue the managed restart and let the supervisor own
 * the lifecycle. For foreground (or unknown) we KILL every running gateway form
 * first — this is the anti-collision fix: we never leave an old gateway polling
 * while a new one comes up — then relaunch one detached `openclaw gateway run`.
 *
 * Returns ok=false only when we could not even attempt a start (e.g. the
 * `openclaw` binary is missing for a foreground relaunch).
 */
async function restartGateway(
  plan: GatewayRestartPlan,
  log: (l: string) => void,
): Promise<{ ok: boolean; reason?: string }> {
  const openclaw = resolveOpenclawBin();
  try {
    if (plan.method === "docker") {
      await run("docker", ["restart", "openclaw-gateway"], { timeout: 30_000 });
      log(`${ICO_OK}  Restarted the openclaw-gateway container.`);
      return { ok: true };
    }
    if (plan.method === "supervised") {
      await run(openclaw, ["gateway", "restart"], { timeout: 30_000 });
      log(`${ICO_OK}  Restarted the supervised gateway.`);
      return { ok: true };
    }
    // foreground | unknown: ensure NO gateway (any form) survives, then relaunch.
    await killAllGateways();
    const child = spawn(
      "sh",
      ["-c", `nohup ${openclaw} gateway run >>${gatewayLogPath()} 2>&1 &`],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    log(`${ICO_OK}  Started a fresh gateway (detached). Log: ${gatewayLogPath()}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Kill every running gateway under ANY invocation form and wait until none
 * remain (re-killing stragglers), so a relaunched foreground gateway can never
 * overlap and double-connect. Best-effort; never throws.
 */
async function killAllGateways(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await gatewayIsRunning())) return;
    for (const pattern of GATEWAY_PATTERNS) {
      try {
        await run("pkill", ["-9", "-f", pattern], { timeout: 4000 });
      } catch {
        // nothing matched this pattern, or pkill unavailable — fine.
      }
    }
    await sleep(300);
  }
}

// ─── Readiness wait ──────────────────────────────────────────────────────────

/** Log events the plugin writes once it has loaded + connected through the gateway. */
const READY_EVENTS: readonly string[] = ["runtime.rooms_ready", "runtime.hello_ok"];

/**
 * True if the runtime log contains a readiness line whose timestamp is AT OR
 * AFTER `sinceEpochMs` — i.e. written by the gateway we just restarted, not a
 * stale line from a prior boot. The log format is
 * `YYYY-MM-DD HH:MM:SS.mmm [tid:N] INFO runtime.rooms_ready ...` (runtime-logger.ts).
 */
export function runtimeLogReadySince(logText: string, sinceEpochMs: number): boolean {
  // -1s slack: the log clock and our Date.now() can differ slightly; we'd rather
  // accept a borderline-fresh line than spin until timeout on a clock skew.
  const floor = sinceEpochMs - 1000;
  for (const raw of logText.split("\n")) {
    if (!READY_EVENTS.some((event) => raw.includes(event))) continue;
    const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})/.exec(raw);
    const stamp = match?.[1];
    if (!stamp) continue;
    // The logger writes local-time stamps; parse as local by replacing the space.
    const ts = Date.parse(stamp.replace(" ", "T"));
    if (Number.isFinite(ts) && ts >= floor) return true;
  }
  return false;
}

function readRuntimeLog(): string {
  const file = runtimeLogPath();
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * Block (printing periodic progress) until the gateway has loaded the chat4000
 * plugin and connected — detected by a fresh readiness line in the runtime log —
 * or until `timeoutMs`. On timeout we WARN and continue (pairing can still
 * proceed; a slow gateway may yet come up and live-invite the user), exactly as
 * the Hermes wizard does.
 */
export async function waitForGatewayReady(
  sinceEpochMs: number,
  opts: { timeoutMs?: number; pollMs?: number; log?: (l: string) => void } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 1500;
  const log = opts.log ?? line;
  log(
    `${ICO_WAIT}  Waiting for the gateway to load the chat4000 plugin and connect — ` +
      "this can take a minute or two…",
  );
  const start = Date.now();
  let lastTick = 0;
  for (;;) {
    if (runtimeLogReadySince(readRuntimeLog(), sinceEpochMs)) {
      log(`${ICO_OK}  Gateway is up — plugin connected.`);
      return true;
    }
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      log(
        `${ICO_INFO}  Gateway didn't report ready within ${Math.round(timeoutMs / 1000)}s — ` +
          `continuing. Check \`tail -f ${runtimeLogPath()}\`.`,
      );
      return false;
    }
    // Throttled heartbeat so the user sees we're alive without flooding the log.
    if (elapsed - lastTick >= 10_000) {
      lastTick = elapsed;
      log(`${ICO_WAIT}  …still waiting (${Math.round(elapsed / 1000)}s elapsed).`);
    }
    await sleep(pollMs);
  }
}

function tailRuntimeLogPanel(n = 12): void {
  const text = readRuntimeLog();
  if (!text) return;
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-n);
  if (tail.length === 0) return;
  line();
  line(`── ${runtimeLogPath()} ─────────`);
  for (const l of tail) line(`  ${l}`);
  line();
}

// ─── Orchestration ───────────────────────────────────────────────────────────

/** The two steps the wizard delegates back into the CLI, injected to avoid a cycle. */
export type WizardDeps = {
  /** Step 1: mint identity + enable plugin, NO pairing (setup --self-redeem --no-pair). */
  prepare: () => Promise<void>;
  /** Step 3: run the human pairing handshake (chat4000 pair). */
  pair: () => Promise<void>;
  /** Resolve the env summary shown in the banner panel. */
  envSummary: () => WizardEnvSummary;
};

export type RunWizardOptions = {
  /** Override the readiness wait (tests pass a short timeout). */
  readyTimeoutMs?: number;
  readyPollMs?: number;
};

/**
 * Drive the full wizard. Reuses the injected setup/pair internals; owns only the
 * UX and the gateway lifecycle. Throws on a hard failure (caught by the CLI's
 * `handleCliError` boundary); returns normally on success.
 */
export async function runWizard(deps: WizardDeps, opts: RunWizardOptions = {}): Promise<void> {
  banner();
  const summary = deps.envSummary();
  printEnvSummary(summary);

  if (!summary.openclawCmd) {
    throw new Error(
      "`openclaw` not found on PATH. Install OpenClaw first, then re-run the wizard.",
    );
  }

  // Step 1/3 — Prepare the plugin (identity + enable; no pairing yet).
  stepRule(`${ICO_LOCK}  Prepare the plugin`, 1, 3);
  line("Registering the bot identity and enabling the plugin…");
  await deps.prepare();

  // Step 2/3 — Bring the gateway online and wait until it has loaded the plugin.
  stepRule(`${ICO_ROCKET}  Bring the gateway online`, 2, 3);
  // Anything logged before this instant is stale; only a readiness line at/after
  // restartT0 proves THIS gateway loaded the plugin.
  const restartT0 = Date.now();
  const running = await gatewayIsRunning();
  line(
    running
      ? `${ICO_INFO}  A gateway is already running — restarting it to load the new plugin.`
      : `${ICO_INFO}  No gateway running — starting one.`,
  );
  const plan = await planGatewayRestart();
  line(`${ICO_INFO}  Restart method: ${plan.detail}`);
  const restart = await restartGateway(plan, line);
  if (!restart.ok) {
    throw new Error(
      `Could not bring the gateway online (${restart.reason ?? "unknown error"}). ` +
        "Start it manually with `openclaw gateway run`, then re-run pairing with " +
        "`openclaw chat4000 pair`.",
    );
  }
  await waitForGatewayReady(restartT0, {
    ...(opts.readyTimeoutMs !== undefined ? { timeoutMs: opts.readyTimeoutMs } : {}),
    ...(opts.readyPollMs !== undefined ? { pollMs: opts.readyPollMs } : {}),
    log: line,
  });
  tailRuntimeLogPanel();

  // Step 3/3 — Pair a device. The now-running gateway live-invites the user.
  stepRule(`${ICO_PHONE}  Pair a device`, 3, 3);
  line("Scan the QR with the chat4000 iOS/macOS app, or paste the code into the CLI client.");
  line();
  await deps.pair();

  successPanel();
}

/** Build the env summary shown in the wizard banner. */
export function buildWizardEnvSummary(params: {
  envFlag?: string | undefined;
  configured: boolean;
}): WizardEnvSummary {
  return {
    openclawCmd: resolveOpenclawBin(),
    pluginVersion: readPackageVersion(),
    env: resolveEnv(params.envFlag),
    configured: params.configured,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
