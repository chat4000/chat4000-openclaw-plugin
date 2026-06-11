import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ErrorEvent, EventHint } from "@sentry/node";
import { readPackageVersion } from "./package-info.js";
import { SENTRY_DSN } from "./telemetry-dsn.generated.js";

// Sentry project creation/auth tokens must stay outside the repo. The runtime
// DSN is generated locally into telemetry-dsn.generated.ts before packaging.
const PACKAGE_VERSION = readPackageVersion();
const CONFIG_DIR = path.join(os.homedir(), ".config", "chat4000");
/**
 * The env_id file (analytics plan v5 IDN7 — the CHURNY machine id). Exported so
 * the IDN9 classifier can test its presence and analytics can read its value.
 */
export const INSTALL_ID_PATH = path.join(CONFIG_DIR, "install-id");
const TELEMETRY_ENABLED_PATH = path.join(CONFIG_DIR, "telemetry-enabled");

let sentryClient: typeof import("@sentry/node") | undefined;
let telemetryInitialized = false;
let sentryReady: Promise<void> | undefined;

export type TelemetryStatus = {
  enabled: boolean;
  reason: "flag" | "env" | "config" | "default";
  installId: string;
  persistentConfigPath: string;
};

export function initializeChat4000Telemetry(): void {
  if (telemetryInitialized) return;
  telemetryInitialized = true;
  if (isTelemetryControlCommand(process.argv)) return;

  const status = getTelemetryStatus();
  if (!status.enabled) return;

  if (!SENTRY_DSN) return;

  sentryReady = import("@sentry/node")
    .then((Sentry) => {
      sentryClient = Sentry;
      Sentry.init({
        dsn: SENTRY_DSN,
        sendDefaultPii: false,
        attachStacktrace: true,
        sampleRate: 0.2,
        tracesSampleRate: 0,
        beforeSend: (event, hint) => {
          const limited = rateLimitEvent(event, hint);
          return limited ? scrubEvent(limited) : null;
        },
        release: `chat4000-plugin@${PACKAGE_VERSION}`,
        environment: process.env.NODE_ENV || "production",
        initialScope: {
          user: { id: status.installId },
          tags: {
            node_version: process.version,
            os_platform: os.platform(),
            os_arch: os.arch(),
            plugin_version: PACKAGE_VERSION,
          },
        },
        defaultIntegrations: false,
        integrations: [
          Sentry.consoleIntegration(),
          Sentry.onUnhandledRejectionIntegration(),
          Sentry.onUncaughtExceptionIntegration(),
        ],
      });
    })
    .catch(() => {
      // Telemetry must never affect plugin startup.
    });
}

function isTelemetryControlCommand(argv: string[]): boolean {
  const chat4000Index = argv.indexOf("chat4000");
  if (chat4000Index === -1) return false;
  return argv.slice(chat4000Index + 1).includes("telemetry");
}

export function captureChat4000Exception(error: unknown, scope?: string): void {
  if (!sentryClient) return;
  sentryClient.withScope((sentryScope) => {
    if (scope) sentryScope.setTag("chat4000_scope", scrubSecrets(scope));
    sentryClient?.captureException(error);
  });
}

// ─── Error sink (Rule 6) ─────────────────────────────────────────────────────

const RATE_LIMIT_MS = 3_600_000; // 1 hour per fingerprint
const seen = new Map<string, { last: number; count: number }>();

function errorNameMessage(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  if (error && typeof error === "object") {
    const e = error as { name?: unknown; message?: unknown };
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      message: typeof e.message === "string" ? e.message : JSON.stringify(error),
    };
  }
  return { name: "Error", message: String(error) };
}

/**
 * The single error sink. Drops `AbortError`/cancellation silently, fingerprints
 * by error name + message, rate-limits to one report per hour per fingerprint
 * (carrying an occurrence count), never alters the error, and is non-blocking.
 * Route every previously-swallowed UNEXPECTED catch through here.
 */
export function report(error: unknown, context: string): void {
  const { name, message } = errorNameMessage(error);
  if (name === "AbortError") return;

  const fingerprint = `${name}|${message}`;
  const now = Date.now();
  const prior = seen.get(fingerprint);
  if (prior && now - prior.last < RATE_LIMIT_MS) {
    prior.count += 1;
    return;
  }
  const count = (prior?.count ?? 0) + 1;
  seen.set(fingerprint, { last: now, count });

  if (!sentryClient) return;
  sentryClient.withScope((sentryScope) => {
    sentryScope.setTag("chat4000_scope", scrubSecrets(context));
    if (count > 1) sentryScope.setExtra("occurrence_count", count);
    sentryClient?.captureException(error);
  });
}

/**
 * `beforeSend` rate-limit (mirrors {@link report} for events Sentry captures
 * automatically — uncaught exceptions / unhandled rejections). Drops AbortError
 * and dedupes by name|message to 1/hour. Returns null to drop the event.
 */
function rateLimitEvent(event: ErrorEvent, hint: EventHint): ErrorEvent | null {
  const original = hint.originalException;
  const { name, message } = errorNameMessage(original);
  if (name === "AbortError") return null;
  const fingerprint = `${name}|${message}`;
  const now = Date.now();
  const prior = seen.get(fingerprint);
  if (prior && now - prior.last < RATE_LIMIT_MS) {
    prior.count += 1;
    return null;
  }
  seen.set(fingerprint, { last: now, count: (prior?.count ?? 0) + 1 });
  return event;
}

export async function captureChat4000TestException(): Promise<boolean> {
  initializeChat4000Telemetry();
  await sentryReady;
  if (!sentryClient) return false;
  captureChat4000Exception(
    new Error("chat4000 telemetry test exception token=secret sk-abcdefghijklmnopqrstuvwxyz123456"),
    "telemetry-test",
  );
  await sentryClient.flush(2_000);
  return true;
}

export function getTelemetryStatus(argv: string[] = process.argv): TelemetryStatus {
  const installId = resolveInstallId();
  if (argv.includes("--no-telemetry")) {
    return {
      enabled: false,
      reason: "flag",
      installId,
      persistentConfigPath: TELEMETRY_ENABLED_PATH,
    };
  }

  const envVar = process.env.CHAT4000_TELEMETRY_DISABLED?.trim().toLowerCase();
  if (envVar === "1" || envVar === "true" || envVar === "yes") {
    return {
      enabled: false,
      reason: "env",
      installId,
      persistentConfigPath: TELEMETRY_ENABLED_PATH,
    };
  }

  try {
    if (existsSync(TELEMETRY_ENABLED_PATH)) {
      const value = readFileSync(TELEMETRY_ENABLED_PATH, "utf8").trim().toLowerCase();
      if (value === "false") {
        return {
          enabled: false,
          reason: "config",
          installId,
          persistentConfigPath: TELEMETRY_ENABLED_PATH,
        };
      }
      if (value === "true") {
        return {
          enabled: true,
          reason: "config",
          installId,
          persistentConfigPath: TELEMETRY_ENABLED_PATH,
        };
      }
    }
  } catch {
    // Fall through to the default if persistent state cannot be read.
  }

  return {
    enabled: true,
    reason: "default",
    installId,
    persistentConfigPath: TELEMETRY_ENABLED_PATH,
  };
}

export function setTelemetryEnabled(enabled: boolean): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(TELEMETRY_ENABLED_PATH, `${enabled ? "true" : "false"}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.stacktrace?.frames) {
        for (const frame of ex.stacktrace.frames) {
          if (frame.filename) {
            frame.filename = scrubPath(frame.filename);
          }
        }
      }
      if (ex.value) ex.value = scrubSecrets(ex.value);
    }
  }

  if (event.message) event.message = scrubSecrets(event.message);
  if (event.extra) {
    delete event.extra.env;
    delete event.extra.argv;
    delete event.extra.argv0;
  }
  if (event.contexts?.runtime) {
    delete (event.contexts.runtime as Record<string, unknown>).env;
  }
  if (event.contexts?.os) {
    delete (event.contexts.os as Record<string, unknown>).kernel_version;
  }
  return event;
}

export function scrubSecrets(text: string): string {
  return text
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "[REDACTED_API_KEY]")
    .replace(/ghp_[a-zA-Z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_KEY]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/password["\s:=]+[^\s",}]+/gi, "password=[REDACTED]")
    .replace(/token["\s:=]+[^\s",}]+/gi, "token=[REDACTED]");
}

function scrubPath(value: string): string {
  return value.replaceAll(os.homedir(), "~").replace(/\/(Users|home)\/[^/]+/g, "/$1/<user>");
}

/**
 * The env_id value (IDN7) — the churny `~/.config/chat4000/install-id`, minted
 * on first read. Rides as a property on analytics events.
 */
export function getEnvId(): string {
  return resolveInstallId();
}

function resolveInstallId(): string {
  try {
    if (existsSync(INSTALL_ID_PATH)) {
      const existing = readFileSync(INSTALL_ID_PATH, "utf8").trim();
      if (existing) return existing;
    }
    const installId = randomUUID();
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(INSTALL_ID_PATH, `${installId}\n`, { encoding: "utf8", mode: 0o600 });
    return installId;
  } catch {
    return randomUUID();
  }
}
