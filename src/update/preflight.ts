/**
 * Self-update preflight — a read-only "can I update?" check.
 *
 * Runs cheap probes and reports whether a self-update could succeed, WITHOUT
 * touching anything. Use this before ever attempting an actual update (and as
 * the answer to a future client-side `plugin.update` control command).
 *
 * Probes:
 *   - version:  is a newer published version available? (npm view)
 *   - writable: can we write the plugin's install dir? (fs.access W_OK)
 *   - restart:  how is the gateway run, and can we restart it?
 *   - registry: is the npm registry reachable?
 *   - tooling:  is npm on PATH?
 *
 * Each probe is best-effort and never throws. The overall `updatable` flag is
 * true only when a newer version exists AND nothing blocks applying it.
 */
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readPackageName, readPackageVersion, resolvePackageRoot } from "../package-info.js";

const run = promisify(execFile);

type ProbeStatus = "ok" | "blocked" | "unknown";

type Probe = {
  name: string;
  status: ProbeStatus;
  detail: string;
};

export type RestartMethod = "docker" | "supervised" | "foreground" | "unknown";

export type UpdatePreflight = {
  packageName: string;
  currentVersion: string;
  latestVersion: string | null;
  /** True only when a newer version exists and no probe blocks applying it. */
  updatable: boolean;
  newerAvailable: boolean;
  restartMethod: RestartMethod;
  probes: Probe[];
};

function compareSemver(a: string, b: string): number {
  const pa = a
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = b
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

async function probeLatestVersion(packageName: string, timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await run("npm", ["view", packageName, "version"], { timeout: timeoutMs });
    const v = stdout.trim();
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function probeWritable(): Probe {
  const root = resolvePackageRoot();
  try {
    accessSync(root, fsConstants.W_OK);
    return { name: "writable", status: "ok", detail: `install dir is writable: ${root}` };
  } catch {
    return {
      name: "writable",
      status: "blocked",
      detail: `install dir is not writable (likely root/managed): ${root}`,
    };
  }
}

async function probeNpm(timeoutMs: number): Promise<Probe> {
  try {
    const { stdout } = await run("npm", ["--version"], { timeout: timeoutMs });
    return { name: "tooling", status: "ok", detail: `npm ${stdout.trim()} on PATH` };
  } catch {
    return { name: "tooling", status: "blocked", detail: "npm not found on PATH" };
  }
}

async function probeRegistry(timeoutMs: number): Promise<Probe> {
  try {
    await run("npm", ["ping"], { timeout: timeoutMs });
    return { name: "registry", status: "ok", detail: "npm registry reachable" };
  } catch {
    return {
      name: "registry",
      status: "unknown",
      detail: "could not reach npm registry (npm ping failed)",
    };
  }
}

function inContainer(): boolean {
  if (existsSync("/.dockerenv")) return true;
  if (process.env.KUBERNETES_SERVICE_HOST) return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    return /docker|kubepods|containerd|podman/.test(cgroup);
  } catch {
    return false;
  }
}

async function probeRestart(timeoutMs: number): Promise<{ probe: Probe; method: RestartMethod }> {
  // docker container named openclaw-gateway?
  try {
    const { stdout } = await run(
      "docker",
      ["ps", "--filter", "name=openclaw-gateway", "--format", "{{.Names}}"],
      { timeout: timeoutMs },
    );
    if (stdout.includes("openclaw-gateway")) {
      return {
        method: "docker",
        probe: {
          name: "restart",
          status: "ok",
          detail: "docker: restart openclaw-gateway container",
        },
      };
    }
  } catch {
    // docker not present; fall through
  }

  // supervised service?
  try {
    const { stdout, stderr } = await run("openclaw", ["gateway", "status"], { timeout: timeoutMs });
    const out = `${stdout}${stderr}`.toLowerCase();
    if (!out.includes("service disabled") && !out.includes("not installed")) {
      return {
        method: "supervised",
        probe: { name: "restart", status: "ok", detail: "supervised: openclaw gateway restart" },
      };
    }
  } catch {
    // openclaw not resolvable here; fall through
  }

  // bare foreground — restartable only if we can spawn a detached helper
  return {
    method: "foreground",
    probe: {
      name: "restart",
      status: inContainer() ? "ok" : "unknown",
      detail: "foreground gateway: needs a detached helper to relaunch (best-effort)",
    },
  };
}

export async function checkUpdatePreflight(
  opts: { timeoutMs?: number } = {},
): Promise<UpdatePreflight> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const packageName = readPackageName();
  const currentVersion = readPackageVersion();

  const [latestVersion, npmProbe, registryProbe, restart] = await Promise.all([
    probeLatestVersion(packageName, timeoutMs),
    probeNpm(timeoutMs),
    probeRegistry(timeoutMs),
    probeRestart(timeoutMs),
  ]);
  const writableProbe = probeWritable();

  const newerAvailable = latestVersion != null && compareSemver(latestVersion, currentVersion) > 0;

  const versionProbe: Probe = latestVersion
    ? {
        name: "version",
        status: newerAvailable ? "ok" : "blocked",
        detail: newerAvailable
          ? `newer version ${latestVersion} available (have ${currentVersion})`
          : `already up to date (${currentVersion})`,
      }
    : {
        name: "version",
        status: "unknown",
        detail: "could not resolve the latest published version",
      };

  const probes = [versionProbe, writableProbe, npmProbe, registryProbe, restart.probe];

  // Updatable only when there's something to update AND nothing hard-blocks it.
  const hardBlocked = probes.some(
    (p) => (p.name === "writable" || p.name === "tooling") && p.status === "blocked",
  );
  const updatable = newerAvailable && !hardBlocked;

  return {
    packageName,
    currentVersion,
    latestVersion,
    updatable,
    newerAvailable,
    restartMethod: restart.method,
    probes,
  };
}

/** Human-readable one-line-per-probe summary. */
export function formatPreflight(p: UpdatePreflight): string {
  const icon = (s: ProbeStatus): string => (s === "ok" ? "✓" : s === "blocked" ? "✗" : "?");
  const lines = [
    `package: ${p.packageName}`,
    `current: ${p.currentVersion}`,
    `latest:  ${p.latestVersion ?? "(unknown)"}`,
    `restart method: ${p.restartMethod}`,
    "",
    ...p.probes.map((probe) => `  ${icon(probe.status)} ${probe.name}: ${probe.detail}`),
    "",
    p.updatable
      ? `→ updatable: YES (run "openclaw chat4000 update" once that lands)`
      : p.newerAvailable
        ? `→ updatable: NO — a newer version exists but a probe is blocking (see ✗ above)`
        : `→ updatable: NO — already up to date`,
  ];
  return lines.join("\n");
}
