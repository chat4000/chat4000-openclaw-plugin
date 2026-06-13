import { describe, expect, it } from "vitest";
import { shouldProcessTimelineEvent } from "../../src/matrix/client.js";

/**
 * The timeline gate replaces the old hard `getTs() < startedAtTs` drop that
 * silently lost the user's first message (sent during the pair → startup
 * window, so its ts predated client construction). The gate must:
 *   - DELIVER an event whose ts is slightly before startup but within the
 *     history horizon (the pre-startup first message),
 *   - DELIVER it exactly once (de-dup by event id),
 *   - still SKIP genuinely ancient backlog older than the horizon.
 */
describe("shouldProcessTimelineEvent — history horizon + de-dup", () => {
  const startedAtTs = 1_700_000_000_000;
  const HORIZON_MS = 10 * 60 * 1000;
  const horizonStart = startedAtTs - HORIZON_MS;

  it("delivers a message sent slightly BEFORE startup (within the horizon), exactly once", () => {
    const delivered = new Set<string>();
    // 30s before construction — exactly the pair → first-message window the old
    // cutoff dropped.
    const preStartupTs = startedAtTs - 30_000;

    // First sight: admitted.
    expect(shouldProcessTimelineEvent("$first:hs", preStartupTs, horizonStart, delivered)).toBe(
      true,
    );
    expect(delivered.has("$first:hs")).toBe(true);

    // A (re)sync re-emits the very same event — must NOT be processed again.
    expect(shouldProcessTimelineEvent("$first:hs", preStartupTs, horizonStart, delivered)).toBe(
      false,
    );
  });

  it("skips genuinely ancient backlog older than the horizon", () => {
    const delivered = new Set<string>();
    const ancientTs = horizonStart - 1; // one ms past the horizon
    expect(shouldProcessTimelineEvent("$old:hs", ancientTs, horizonStart, delivered)).toBe(false);
    // Dropped events are NOT recorded as delivered (set stays bounded to admits).
    expect(delivered.has("$old:hs")).toBe(false);
  });

  it("delivers events at/after startup (the normal live path)", () => {
    const delivered = new Set<string>();
    expect(shouldProcessTimelineEvent("$live:hs", startedAtTs + 5, horizonStart, delivered)).toBe(
      true,
    );
  });

  it("admits an event exactly at the horizon boundary (inclusive)", () => {
    const delivered = new Set<string>();
    expect(shouldProcessTimelineEvent("$edge:hs", horizonStart, horizonStart, delivered)).toBe(
      true,
    );
  });

  it("skips an event with no id (cannot be de-duped, not a real message)", () => {
    const delivered = new Set<string>();
    expect(shouldProcessTimelineEvent(undefined, startedAtTs + 1, horizonStart, delivered)).toBe(
      false,
    );
    expect(delivered.size).toBe(0);
  });

  it("de-dups across distinct ids independently", () => {
    const delivered = new Set<string>();
    expect(shouldProcessTimelineEvent("$a:hs", startedAtTs, horizonStart, delivered)).toBe(true);
    expect(shouldProcessTimelineEvent("$b:hs", startedAtTs, horizonStart, delivered)).toBe(true);
    expect(shouldProcessTimelineEvent("$a:hs", startedAtTs, horizonStart, delivered)).toBe(false);
    expect(shouldProcessTimelineEvent("$b:hs", startedAtTs, horizonStart, delivered)).toBe(false);
  });
});
