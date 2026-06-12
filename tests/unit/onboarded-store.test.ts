import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MatrixClient } from "matrix-js-sdk";
import { isOnboarded, loadOnboarded, markOnboarded } from "../../src/matrix/onboarded-store.js";
import { ensureInitialSession } from "../../src/matrix/space.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "c4k-onb-"));
  process.env.OPENCLAW_STATE_DIR = tmpRoot;
  delete process.env.OPENCLAW_HOME;
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("onboarded-store", () => {
  it("starts empty, records, and persists per account", () => {
    expect(loadOnboarded("default")).toEqual({});
    expect(isOnboarded("default", "@u:hs")).toBe(false);
    markOnboarded("default", "@u:hs", "!room:hs");
    expect(isOnboarded("default", "@u:hs")).toBe(true);
    expect(loadOnboarded("default")).toEqual({ "@u:hs": "!room:hs" });
    // Other accounts are isolated.
    expect(isOnboarded("other", "@u:hs")).toBe(false);
  });
});

describe("ensureInitialSession", () => {
  function stubClient(createRoom: () => Promise<{ room_id: string }>): MatrixClient {
    return {
      createRoom,
      getUserId: () => "@plugin:hs",
      sendStateEvent: () => Promise.resolve({ event_id: "$s:hs" }),
    } as unknown as MatrixClient;
  }

  it("creates one room + marks onboarded for a fresh user", async () => {
    const createRoom = vi.fn(() => Promise.resolve({ room_id: "!new:hs" }));
    const roomId = await ensureInitialSession(stubClient(createRoom), {
      spaceId: "!space:hs",
      accountId: "default",
      userId: "@alice:hs",
    });
    expect(roomId).toBe("!new:hs");
    expect(createRoom).toHaveBeenCalledTimes(1);
    expect(isOnboarded("default", "@alice:hs")).toBe(true);
  });

  it("is a no-op (returns null, never creates) when the user is already onboarded", async () => {
    markOnboarded("default", "@alice:hs", "!existing:hs");
    const createRoom = vi.fn(() => Promise.resolve({ room_id: "!should-not:hs" }));
    const roomId = await ensureInitialSession(stubClient(createRoom), {
      spaceId: "!space:hs",
      accountId: "default",
      userId: "@alice:hs",
    });
    expect(roomId).toBeNull();
    expect(createRoom).not.toHaveBeenCalled();
  });

  it("returns null for an empty user id without creating", async () => {
    const createRoom = vi.fn(() => Promise.resolve({ room_id: "!x:hs" }));
    const roomId = await ensureInitialSession(stubClient(createRoom), {
      spaceId: "!space:hs",
      accountId: "default",
      userId: "   ",
    });
    expect(roomId).toBeNull();
    expect(createRoom).not.toHaveBeenCalled();
  });
});
