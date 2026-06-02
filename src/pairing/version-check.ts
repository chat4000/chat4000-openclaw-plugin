/**
 * Plugin version-policy check (PROTOCOL C.5).
 *
 * The plugin checks the registrar's version policy **on boot** and **before
 * lifecycle/privileged calls** (e.g. `/pair/*`), never on the message path.
 *   - `force_upgrade` → refuse to operate and surface an error (the caller stops
 *     relaying messages and reports to its owner via the control room).
 *   - `recommend_upgrade` → warn (log / notify the owner).
 *   - `ok` → nothing.
 */
import { readPackageName, readPackageVersion } from "../package-info.js";
import type { RegistrarClient, VersionPolicyResult } from "./registrar.js";

/** Map the Node platform to the policy's platform label (analytics only). */
export function pluginPlatform(): string {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return process.platform;
  }
}

/** Ask the registrar whether this plugin build is servable / must upgrade. */
export async function checkPluginVersion(params: {
  registrar: RegistrarClient;
  releaseChannel?: string | undefined;
}): Promise<VersionPolicyResult> {
  return params.registrar.checkVersion({
    appId: readPackageName(),
    clientVersion: readPackageVersion(),
    releaseChannel: params.releaseChannel?.trim() || "dev",
    platform: pluginPlatform(),
  });
}

/**
 * Human-readable notice for a non-`ok` verdict (for logs + the control room),
 * or null when the build is current.
 */
export function formatVersionNotice(r: VersionPolicyResult): string | null {
  const target = r.recommended ?? "the latest version";
  if (r.action === "force_upgrade") {
    return (
      `chat4000 plugin update REQUIRED: ${r.message ?? `upgrade to ${target}`}. ` +
      "The plugin will not relay messages until updated " +
      '(run: "openclaw chat4000 update --apply --restart").'
    );
  }
  if (r.action === "recommend_upgrade") {
    return `chat4000 plugin update recommended: ${r.message ?? `upgrade to ${target}`}.`;
  }
  return null;
}
