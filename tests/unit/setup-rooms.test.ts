import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MatrixClient } from "matrix-js-sdk";
import { setupPluginRoomsWithClient } from "../../src/matrix/rooms.js";
import { readPluginRooms } from "../../src/matrix/space.js";

const ACCOUNT = "default";

type FakeClient = {
  createRoom: ReturnType<typeof vi.fn>;
  getJoinedRooms: ReturnType<typeof vi.fn>;
  sendStateEvent: ReturnType<typeof vi.fn>;
  invite: ReturnType<typeof vi.fn>;
  getUserId: () => string;
};

function fakeClient(joinedRooms: string[]): FakeClient {
  return {
    createRoom: vi.fn((opts: { creation_content?: { type?: string } }) =>
      Promise.resolve({
        room_id: opts.creation_content?.type === "m.space" ? "!space:hs" : "!control:hs",
      }),
    ),
    getJoinedRooms: vi.fn(() => Promise.resolve({ joined_rooms: joinedRooms })),
    sendStateEvent: vi.fn(() => Promise.resolve({ event_id: "$state" })),
    invite: vi.fn(() => Promise.resolve({})),
    getUserId: () => "@plugin_x:hs",
  };
}

function asClient(fake: FakeClient): MatrixClient {
  return fake as unknown as MatrixClient;
}

describe("setupPluginRoomsWithClient (PROTOCOL C.6 step 3)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "chat4000-setup-rooms-test-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("first run: creates the encrypted space + control room and invites the user to both", async () => {
    const client = fakeClient([]);
    const rooms = await setupPluginRoomsWithClient(asClient(client), {
      accountId: ACCOUNT,
      pluginName: "chat4000",
      userId: "@u_one:hs",
    });

    expect(rooms).toEqual({ spaceId: "!space:hs", controlRoomId: "!control:hs" });
    expect(client.createRoom).toHaveBeenCalledTimes(2);
    // C.6: BOTH rooms get m.room.encryption at creation; only the control room
    // is marked chat4000.room_kind: control, and it carries a readable name (E).
    const spaceOpts = client.createRoom.mock.calls[0]?.[0] as {
      creation_content?: { type?: string };
      initial_state?: Array<{ type: string; content: Record<string, unknown> }>;
    };
    expect(spaceOpts.creation_content).toEqual({ type: "m.space" });
    expect(spaceOpts.initial_state).toEqual([
      expect.objectContaining({ type: "m.room.encryption" }),
    ]);
    const controlOpts = client.createRoom.mock.calls[1]?.[0] as {
      name?: string;
      initial_state?: Array<{ type: string; content: Record<string, unknown> }>;
    };
    expect(controlOpts.name).toBe("Commands");
    expect(controlOpts.initial_state).toEqual([
      expect.objectContaining({ type: "m.room.encryption" }),
      expect.objectContaining({
        type: "chat4000.room_kind",
        content: { kind: "control" },
      }),
    ]);
    // The user is invited to both — the invites PRE-EXIST before any device pairs.
    expect(client.invite).toHaveBeenCalledWith("!space:hs", "@u_one:hs");
    expect(client.invite).toHaveBeenCalledWith("!control:hs", "@u_one:hs");
    // Ids persist so the gateway (and a setup re-run) reuse the same rooms.
    expect(readPluginRooms(ACCOUNT)).toEqual({
      spaceId: "!space:hs",
      controlRoomId: "!control:hs",
    });
  });

  it("re-run is idempotent: still-joined rooms are reused, already-sent invites tolerated", async () => {
    // First run persists the ids.
    await setupPluginRoomsWithClient(asClient(fakeClient([])), {
      accountId: ACCOUNT,
      pluginName: "chat4000",
      userId: "@u_one:hs",
    });

    // Second run: bot is joined to both (per /joined_rooms) and the user is
    // already invited — Matrix answers M_FORBIDDEN "already in the room".
    const client = fakeClient(["!space:hs", "!control:hs"]);
    client.invite = vi.fn(() =>
      Promise.reject(new Error("MatrixError: [403] @u_one:hs is already in the room")),
    );
    const rooms = await setupPluginRoomsWithClient(asClient(client), {
      accountId: ACCOUNT,
      pluginName: "chat4000",
      userId: "@u_one:hs",
    });

    expect(rooms).toEqual({ spaceId: "!space:hs", controlRoomId: "!control:hs" });
    expect(client.createRoom).not.toHaveBeenCalled();
    expect(client.invite).toHaveBeenCalledTimes(2);
  });

  it("a real invite failure still surfaces (only already-member answers are tolerated)", async () => {
    const client = fakeClient([]);
    client.invite = vi.fn(() => Promise.reject(new Error("MatrixError: [500] internal error")));
    await expect(
      setupPluginRoomsWithClient(asClient(client), {
        accountId: ACCOUNT,
        pluginName: "chat4000",
        userId: "@u_one:hs",
      }),
    ).rejects.toThrow("internal error");
  });
});
