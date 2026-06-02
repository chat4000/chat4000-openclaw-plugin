import { describe, expect, it } from "vitest";
import type { MatrixEvent } from "matrix-js-sdk";
import { decodeCommandEvent, decodeInboundEvent } from "../../src/matrix/inbound.js";

/** Build a fake MatrixEvent exposing just the accessors the decoders use. */
function fakeEvent(
  content: Record<string, unknown>,
  opts?: { type?: string; redacted?: boolean },
): MatrixEvent {
  return {
    getType: () => opts?.type ?? "m.room.message",
    isRedacted: () => opts?.redacted ?? false,
    getContent: () => content,
    getId: () => "$evt:hs",
    getRoomId: () => "!room:hs",
    getSender: () => "@u_x:hs",
    getTs: () => 1700000000000,
    sender: { name: "Alice" },
  } as unknown as MatrixEvent;
}

describe("inbound decoding", () => {
  it("decodes a text message to an inbound message", () => {
    const msg = decodeInboundEvent(fakeEvent({ msgtype: "m.text", body: "hello" }));
    expect(msg?.body).toEqual({ kind: "text", text: "hello" });
    expect(msg?.eventId).toBe("$evt:hs");
  });

  it("routes a chat4000.command to a command, not an agent message", () => {
    const ev = fakeEvent({ msgtype: "chat4000.command", command: "session.new", title: "x" });
    expect(decodeInboundEvent(ev)).toBeNull();
    const cmd = decodeCommandEvent(ev);
    expect(cmd?.command).toBe("session.new");
    expect(cmd?.kind).toBe("command");
  });

  it("ignores m.replace edits (they are streaming updates, not new turns)", () => {
    const ev = fakeEvent({
      msgtype: "m.text",
      body: "* edited",
      "m.relates_to": { rel_type: "m.replace", event_id: "$orig:hs" },
    });
    expect(decodeInboundEvent(ev)).toBeNull();
  });

  it("ignores redacted events", () => {
    expect(
      decodeInboundEvent(fakeEvent({ msgtype: "m.text", body: "x" }, { redacted: true })),
    ).toBeNull();
  });

  it("surfaces an image as a media body carrying the raw content (PROTOCOL D.3)", () => {
    const content = { msgtype: "m.image", body: "cat.png", url: "mxc://hs/abc" };
    const msg = decodeInboundEvent(fakeEvent(content));
    expect(msg?.body.kind).toBe("media");
    if (msg?.body.kind === "media") {
      expect(msg.body.mediaMsgType).toBe("m.image");
      expect(msg.body.caption).toBe("[Image: cat.png]");
      expect(msg.body.rawContent).toMatchObject({ url: "mxc://hs/abc" });
    }
  });
});
