/**
 * Product analytics → self-hosted PostHog (analytics plan v5 — PL section).
 *
 * Distinct from {@link ./telemetry.ts} (Sentry crash reporting): this module
 * emits the small set of plugin lifecycle EVENTS the plan allows (DEC3):
 * `plugin_started` (PL1), `container_rebuilt` (PL5), `plugin_upgrading` (PL2),
 * and `pairing_completed` (PL4). Nothing else — there is no message/runtime
 * event surface here.
 *
 * Identity (plan v5): `distinct_id` is the STABLE machine id `agent_install_id`
 * (IDN8, {@link ./machine-ids.ts}); the churny `env_id` (IDN7) rides as a
 * property on every event, and `paired_client_id` (FLW4, latest pairing wins)
 * rides as an emulated super property the same way. No `plugin_id` anywhere
 * (DEC9). Target instance: self-hosted only (INF5).
 *
 * Transport mirrors the installer's: a stdlib `fetch` POST to `/capture/`, no
 * SDK dependency. Everything is gated on the telemetry toggle
 * (`CHAT4000_TELEMETRY_DISABLED` / the telemetry-disable command), best-effort,
 * and never throws into the caller.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readPackageVersion } from "./package-info.js";
import { flushTelemetry, getEnvId, getTelemetryStatus, report } from "./telemetry.js";
import { readOrMintAgentInstallId } from "./machine-ids.js";
import { resolveChat4000PluginDir } from "./paths.js";

// INF5 / IN4 — self-hosted PostHog only, one unified project. The key is the
// public, write-only ingestion key (same project the installer + iOS/Mac apps
// use); public-by-design, hence committed here like the installer commits it.
const POSTHOG_HOST = (
  process.env.CHAT4000_POSTHOG_HOST?.trim() || "https://posthog.chat4000.com"
).replace(/\/+$/, "");
const POSTHOG_API_KEY =
  process.env.CHAT4000_POSTHOG_API_KEY?.trim() ||
  "phc_wNRtzk3h5FTw2X6h4CvieEoxdSdqUd42eUqbgW6nD7B4";

const PACKAGE_VERSION = readPackageVersion();
const SESSION_ID = randomUUID();
const CAPTURE_TIMEOUT_MS = 3_000;
const PAIRED_CLIENT_ID_FILENAME = "paired-client-id";

const inflight = new Set<Promise<void>>();

/**
 * Emit a PostHog event with `distinct_id = agent_install_id` (IDN8) plus the
 * universal properties. No-op when telemetry is off. Fire-and-forget: the
 * capture promise is tracked for {@link flushAnalytics} but never awaited here.
 */
export function track(event: string, properties?: Record<string, unknown>): void {
  if (!getTelemetryStatus().enabled) return;
  const body = JSON.stringify({
    api_key: POSTHOG_API_KEY,
    event,
    distinct_id: readOrMintAgentInstallId(),
    properties: { ...universalProperties(), ...(properties ?? {}) },
  });
  const pending = sendCapture(body);
  inflight.add(pending);
  void pending.finally(() => inflight.delete(pending));
}

/**
 * Await in-flight captures (bounded) — call before a process-ending action
 * (e.g. the self-update restart in PL2) so a just-emitted event isn't dropped.
 */
export async function flushAnalytics(timeoutMs: number = CAPTURE_TIMEOUT_MS): Promise<void> {
  const pending = [...inflight];
  if (pending.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.allSettled(pending).then(() => undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Flush BOTH telemetry transports before a process-ending action: PostHog
 * (await in-flight `/capture/` POSTs) and Sentry (drain its background
 * transport). Call this from every shutdown/exit path so no analytics or crash
 * event is lost when the process exits, restarts, or a short-lived task ends.
 * Best-effort and bounded; never throws.
 */
export async function flushAllTelemetry(timeoutMs: number = CAPTURE_TIMEOUT_MS): Promise<void> {
  await Promise.allSettled([flushAnalytics(timeoutMs), flushTelemetry(timeoutMs)]);
}

let shutdownHooksRegistered = false;

/**
 * Register one-time process signal/exit handlers that flush both telemetry
 * transports. Plugins run many short-lived and signal-terminated paths; without
 * this, boot events (`plugin_started`/`container_rebuilt`) and any captured
 * exception are dropped when the host sends SIGINT/SIGTERM or the event loop
 * drains. Idempotent. Handlers do NOT call `process.exit()` — they only flush,
 * leaving the host's own teardown and exit code intact.
 */
export function registerTelemetryShutdownHooks(): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;

  let flushing: Promise<void> | undefined;
  const flushOnce = (): Promise<void> => {
    if (!flushing) flushing = flushAllTelemetry();
    return flushing;
  };

  // `beforeExit` fires when the loop is about to drain on a normal exit; async
  // work scheduled here keeps the process alive until the flush resolves.
  process.once("beforeExit", () => {
    void flushOnce();
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    // `once` auto-removes our handler after it fires, so the re-raised signal
    // below hits whatever the host registered (or the default action) — we
    // never clobber other listeners.
    process.once(signal, () => {
      void flushOnce().finally(() => {
        // Re-raise so the host's own handler / default disposition (and exit
        // code) is honored once telemetry has drained, rather than swallowed.
        process.kill(process.pid, signal);
      });
    });
  }
}

/**
 * PL3: the agent_install_id for `X-Client-Id` registrar headers — or null when
 * telemetry is off, so the id never rides any wire then.
 */
export function machineClientId(): string | null {
  if (!getTelemetryStatus().enabled) return null;
  return readOrMintAgentInstallId();
}

/**
 * FLW4: persist the paired phone's client_id as an emulated super property —
 * latest pairing wins; every subsequent plugin event carries it via the
 * universal properties. Best-effort: an unwritable store only costs the join
 * property, never the event.
 */
export function registerPairedClientId(clientId: string): void {
  const value = clientId.trim().slice(0, 64);
  if (!value) return;
  try {
    const filePath = pairedClientIdPath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    report(err, "analytics.paired_client_id");
  }
}

/**
 * Boot events (plan v5: PL1 + PL5). `container_rebuilt` first when the IDN9
 * classifier fired, then `plugin_started`. plugin_version / env_id /
 * paired_client_id ride via the universal properties.
 */
export function emitPluginBootAnalytics(opts: { containerRebuilt: boolean }): void {
  if (opts.containerRebuilt) track("container_rebuilt", {}); // PL5 — env_id rides via universal props
  track("plugin_started", { agent_kind: "openclaw", agent_version: hostAgentVersion() }); // PL1
}

// ─── Internals ─────────────────────────────────────────────────────────────

async function sendCapture(body: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
  try {
    await fetch(`${POSTHOG_HOST}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    // Telemetry is best-effort; route the (rate-limited, AbortError-dropping)
    // failure to the sink rather than crashing the plugin or silently eating it.
    report(err, "analytics.capture");
  } finally {
    clearTimeout(timer);
  }
}

function universalProperties(): Record<string, unknown> {
  const props: Record<string, unknown> = {
    source: "openclaw-plugin", // filters these events apart from the iOS client's
    plugin_version: PACKAGE_VERSION,
    node_version: process.version,
    os_platform: os.platform(),
    session_id: SESSION_ID,
    build_channel: process.env.CHAT4000_ENV?.trim() || process.env.NODE_ENV?.trim() || "production",
    env_id: getEnvId(), // IDN7 — the churny environment id rides as a property
  };
  const paired = loadPairedClientId();
  if (paired) props.paired_client_id = paired; // FLW4 emulated super property
  return props;
}

function pairedClientIdPath(): string {
  return path.join(resolveChat4000PluginDir(), PAIRED_CLIENT_ID_FILENAME);
}

function loadPairedClientId(): string | undefined {
  try {
    const filePath = pairedClientIdPath();
    if (existsSync(filePath)) {
      const value = readFileSync(filePath, "utf8").trim();
      if (value) return value;
    }
  } catch {
    // Best-effort — a missing/unreadable store just omits the join property.
  }
  return undefined;
}

/**
 * PL1 prop `agent_version`: the OpenClaw host version, best-effort. The package
 * blocks `openclaw/package.json` via its `exports` map, so resolve the main
 * entry (allowed by `exports["."]`) and walk up to the root package.json.
 */
function hostAgentVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    let dir = path.dirname(require.resolve("openclaw"));
    for (let i = 0; i < 8; i += 1) {
      const manifestPath = path.join(dir, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (
          manifest.name === "openclaw" &&
          typeof manifest.version === "string" &&
          manifest.version
        )
          return manifest.version;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Host package version not resolvable from here.
  }
  return "unknown";
}
