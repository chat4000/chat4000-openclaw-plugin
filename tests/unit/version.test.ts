import { describe, expect, it } from "vitest";
import { formatVersionNotice, pluginPlatform } from "../../src/pairing/version-check.js";
import type { VersionPolicyResult } from "../../src/pairing/registrar.js";

function verdict(partial: Partial<VersionPolicyResult>): VersionPolicyResult {
  return {
    action: "ok",
    minVersion: null,
    minNag: null,
    recommended: null,
    currentTermsVersion: 0,
    message: null,
    ...partial,
  };
}

describe("formatVersionNotice", () => {
  it("returns null when the build is current", () => {
    expect(formatVersionNotice(verdict({ action: "ok" }))).toBeNull();
  });

  it("flags a force_upgrade as REQUIRED and mentions it stops relaying", () => {
    const notice = formatVersionNotice(verdict({ action: "force_upgrade", recommended: "2.1.0" }));
    expect(notice).toContain("REQUIRED");
    expect(notice).toContain("will not relay");
  });

  it("flags a recommend_upgrade softly", () => {
    const notice = formatVersionNotice(
      verdict({ action: "recommend_upgrade", recommended: "2.1.0" }),
    );
    expect(notice).toContain("recommended");
    expect(notice).not.toContain("REQUIRED");
  });
});

describe("pluginPlatform", () => {
  it("returns a stable platform label", () => {
    expect(["macos", "linux", "windows", process.platform]).toContain(pluginPlatform());
  });
});
