import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { resolveOpenClawHome } from "./paths.js";
import { rotateLogIfOversized } from "./log-rotate.js";

export type RuntimeLogLevel = "info" | "debug";

export type RuntimeLoggerContext = {
  accountId: string;
  groupId: string;
};

function resolveRuntimeLogPath(): string {
  return path.join(resolveOpenClawHome(), "plugins", "chat4000", "logs", "runtime.log");
}

function nowTimestamp(): string {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

function formatValue(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value.includes(" ") ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  // Objects / functions: JSON where possible, else a stable marker.
  return JSON.stringify(value) ?? "[unserializable]";
}

export class RuntimeLogger {
  private readonly logPath = resolveRuntimeLogPath();

  constructor(
    private readonly level: RuntimeLogLevel,
    private readonly context: RuntimeLoggerContext,
  ) {}

  info(event: string, fields?: Record<string, unknown>): void {
    this.write("INFO", event, fields);
  }

  debug(event: string, fields?: Record<string, unknown>): void {
    if (this.level !== "debug") {
      return;
    }
    this.write("DEBUG", event, fields);
  }

  private write(level: "INFO" | "DEBUG", event: string, fields?: Record<string, unknown>): void {
    const merged: Record<string, unknown> = {
      account_id: this.context.accountId,
      group_id: this.context.groupId,
      ...fields,
    };

    const details = Object.entries(merged)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(" ");

    const line = `${nowTimestamp()} [tid:${threadId}] ${level} ${event}${details ? ` ${details}` : ""}`;

    try {
      mkdirSync(path.dirname(this.logPath), { recursive: true });
      const payload = `${line}\n`;
      rotateLogIfOversized(this.logPath, Buffer.byteLength(payload, "utf8"));
      appendFileSync(this.logPath, payload, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(this.logPath, 0o600);
    } catch {
      // Logging must never break runtime behavior.
    }
  }
}
