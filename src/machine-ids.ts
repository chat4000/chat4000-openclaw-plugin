/**
 * Machine identity for analytics (analytics plan v5 — IDN7/IDN8/IDN9).
 *
 * Two ids, mirroring the phone's two-marker design:
 *
 * - `env_id` (IDN7, the CHURNY one): the existing `~/.config/chat4000/install-id`
 *   owned by {@link ./telemetry.ts}. Identifies the runtime ENVIRONMENT; dies
 *   with a docker rebuild / fresh home. Rides as a property on machine events.
 * - `agent_install_id` (IDN8, the STABLE one): THE machine analytics id — the
 *   PostHog `distinct_id` and the `X-Client-Id` header on registrar calls. Lives
 *   at the resolved OpenClaw state-dir ROOT (the volume-mounted part), next to
 *   the credentials + crypto stores, so it survives container rebuilds AND
 *   plugin uninstall. NEVER under `plugins/chat4000/` (uninstall deletes that and
 *   would churn the "stable" id). Never deleted by uninstall or telemetry-disable
 *   — with telemetry off the file is inert and the id never rides any wire. The
 *   installer mints/reads the SAME file via the SAME resolver order.
 *
 * Resolver order is the contract (registry IDN8):
 *   `$OPENCLAW_STATE_DIR || $OPENCLAW_HOME/.openclaw || ~/.openclaw`
 * — exactly {@link resolveOpenClawStateDir}, the resolver the plugin already uses
 * for its durable state. Split-id guard: if the resolved root has no id but the
 * plain `~/.openclaw` fallback does (the installer ran without the env overrides
 * set), adopt the fallback's id instead of minting a second one.
 *
 * IDN9 classifier: at boot, agent_install_id present while the env_id file is
 * absent (about to be minted fresh) ⇒ the runtime env was rebuilt around the
 * durable data dir → `container_rebuilt`. Both fresh ⇒ a genuinely new machine
 * (no event; the first `plugin_started` covers it).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveOpenClawStateDir } from "./paths.js";
import { INSTALL_ID_PATH } from "./telemetry.js";

const AGENT_INSTALL_ID_FILENAME = "chat4000-install-id";

let cachedAgentInstallId: string | undefined;
let bootContainerRebuilt: boolean | undefined;

/** The durable id file, at the resolved OpenClaw state-dir ROOT (IDN8). */
export function agentInstallIdPath(): string {
  return path.join(resolveOpenClawStateDir(), AGENT_INSTALL_ID_FILENAME);
}

/** The plain `~/.openclaw` fallback path — used only by the split-id guard. */
function fallbackAgentInstallIdPath(): string {
  return path.join(os.homedir(), ".openclaw", AGENT_INSTALL_ID_FILENAME);
}

function readIdFile(filePath: string): string | undefined {
  try {
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    // Unreadable — treat as absent.
  }
  return undefined;
}

function writeIdFile(filePath: string, id: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${id}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * IDN8: read the durable machine id, minting it on first run (uuid4, mode 0600,
 * trailing newline — same format as the env-id file). Split-id guard: if the
 * resolved root has none but the plain `~/.openclaw` fallback does, copy that id
 * to the resolved path rather than minting a second one.
 */
export function readOrMintAgentInstallId(): string {
  if (cachedAgentInstallId) return cachedAgentInstallId;
  const resolvedPath = agentInstallIdPath();
  try {
    const existing = readIdFile(resolvedPath);
    if (existing) {
      cachedAgentInstallId = existing;
      return existing;
    }
    // Split-id guard: adopt the fallback-root id when the resolved root has none.
    const fallbackPath = fallbackAgentInstallIdPath();
    if (fallbackPath !== resolvedPath) {
      const fallback = readIdFile(fallbackPath);
      if (fallback) {
        writeIdFile(resolvedPath, fallback);
        cachedAgentInstallId = fallback;
        return fallback;
      }
    }
    const newId = randomUUID();
    writeIdFile(resolvedPath, newId);
    cachedAgentInstallId = newId;
    return newId;
  } catch {
    // Read-only / sandboxed fs — fall back to a process-local id, cached so the
    // session's distinct_id at least stays stable.
    cachedAgentInstallId = randomUUID();
    return cachedAgentInstallId;
  }
}

/**
 * IDN9: true iff the durable agent_install_id exists but the env-id file does
 * not (it is about to be minted fresh) — the docker-rebuild signature.
 *
 * MUST be sampled BEFORE telemetry/analytics init mints the env-id file, which
 * would erase the freshness signal — see {@link snapshotContainerRebuilt}.
 */
export function detectContainerRebuilt(): boolean {
  return fileHasContent(agentInstallIdPath()) && !fileHasContent(INSTALL_ID_PATH);
}

/**
 * Snapshot the IDN9 signal once, as early in the process as possible (before
 * telemetry init mints the env-id file). Idempotent: later callers (the gateway
 * boot, which emits the events) get the value captured at process start.
 */
export function snapshotContainerRebuilt(): boolean {
  bootContainerRebuilt ??= detectContainerRebuilt();
  return bootContainerRebuilt;
}

function fileHasContent(filePath: string): boolean {
  return readIdFile(filePath) !== undefined;
}
