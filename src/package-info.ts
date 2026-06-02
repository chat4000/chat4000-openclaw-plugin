import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readOwnPackageJson(): { version?: string | undefined; name?: string | undefined } {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(moduleDir, "..", "package.json"), "utf8"),
  );
  if (parsed && typeof parsed === "object") {
    const pkg = parsed as { version?: unknown; name?: unknown };
    return {
      version: typeof pkg.version === "string" ? pkg.version : undefined,
      name: typeof pkg.name === "string" ? pkg.name : undefined,
    };
  }
  return {};
}

export function readPackageVersion(): string {
  try {
    return readOwnPackageJson().version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function readPackageName(): string {
  try {
    return readOwnPackageJson().name || "@chat4000/openclaw-plugin";
  } catch {
    return "@chat4000/openclaw-plugin";
  }
}

/** The plugin package root (the dir containing its package.json). */
export function resolvePackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
