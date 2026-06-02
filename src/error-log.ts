import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resolveOpenClawHome } from "./paths.js";
import { rotateLogIfOversized } from "./log-rotate.js";
import { captureChat4000Exception } from "./telemetry.js";

function resolveChat4000LogDir(): string {
  return path.join(resolveOpenClawHome(), "plugins", "chat4000", "logs");
}

function resolveChat4000ErrorLogPath(): string {
  return path.join(resolveChat4000LogDir(), "errors.log");
}

export function dumpChat4000Trace(
  scope: string,
  error: unknown,
  context?: Record<string, unknown>,
): string {
  captureChat4000Exception(error, scope);

  const logPath = resolveChat4000ErrorLogPath();
  const detail =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : JSON.stringify(error));

  mkdirSync(path.dirname(logPath), { recursive: true });

  const lines = [`=== ${new Date().toISOString()} [${scope}] ===`, `message: ${detail.message}`];

  if (context && Object.keys(context).length > 0) {
    lines.push(`context: ${JSON.stringify(context)}`);
  }

  if (detail.stack) {
    lines.push(detail.stack);
  }

  lines.push("");

  const payload = `${lines.join("\n")}\n`;
  rotateLogIfOversized(logPath, Buffer.byteLength(payload, "utf8"));
  appendFileSync(logPath, payload, {
    encoding: "utf8",
    mode: 0o600,
  });

  try {
    chmodSync(logPath, 0o600);
  } catch {
    // Best-effort permission tightening.
  }

  return logPath;
}
