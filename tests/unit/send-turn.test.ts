import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
import {
  editToolEnd,
  sendAgentStatus,
  sendToolStart,
  sendTurnAnchor,
} from "../../src/matrix/send.js";

type SentEvent = { type: string; content: Record<string, unknown> };
type SentState = { type: string; content: Record<string, unknown>; stateKey: string };

function mockClient(): { client: MatrixClient; sent: SentEvent[]; state: SentState[] } {
  const sent: SentEvent[] = [];
  const state: SentState[] = [];
  const client = {
    makeTxnId: () => `txn-${sent.length + 1}`,
    sendEvent: vi.fn((_roomId: string, type: string, content: Record<string, unknown>) => {
      sent.push({ type, content });
      return Promise.resolve({ event_id: `$ev${sent.length}` });
    }),
    sendStateEvent: vi.fn(
      (_roomId: string, type: string, content: Record<string, unknown>, stateKey: string) => {
        state.push({ type, content, stateKey });
        return Promise.resolve({ event_id: "$st" });
      },
    ),
  } as unknown as MatrixClient;
  return { client, sent, state };
}

describe("turn / tool / status sends (PROTOCOL E)", () => {
  it("sendToolStart links the tool to the turn via an ENCRYPTED field, not m.relates_to", async () => {
    const m = mockClient();
    const id = await sendToolStart(m.client, "!r:hs", "$anchor", {
      tool_id: "t1",
      name: "bash",
      args: "ls",
      status: "running",
      result: "",
      duration_ms: 0,
    });
    expect(id).toBe("$ev1");
    const c = m.sent[0].content;
    expect(c.msgtype).toBe("chat4000.tool");
    expect((c["chat4000.tool"] as { name: string }).name).toBe("bash");
    // Linked via the encrypted content field (stays inside the ciphertext).
    expect(c["chat4000.turn_id"]).toBe("$anchor");
    // NOT m.relates_to — that would be lifted to cleartext and leak the grouping.
    expect(c["m.relates_to"]).toBeUndefined();
  });

  it("editToolEnd is an m.replace of the tool event with the terminal status", async () => {
    const m = mockClient();
    await editToolEnd(m.client, "!r:hs", "$tool", {
      tool_id: "t1",
      name: "bash",
      args: "ls",
      status: "done",
      result: "ok",
      duration_ms: 5,
    });
    const c = m.sent[0].content;
    expect(c["m.relates_to"] as { rel_type: string; event_id: string }).toEqual({
      rel_type: "m.replace",
      event_id: "$tool",
    });
    expect(
      ((c["m.new_content"] as Record<string, unknown>)["chat4000.tool"] as { status: string })
        .status,
    ).toBe("done");
  });

  it("sendAgentStatus writes a cleartext chat4000.status state event", async () => {
    const m = mockClient();
    await sendAgentStatus(m.client, "!r:hs", "thinking");
    expect(m.state[0]).toMatchObject({
      type: "chat4000.status",
      stateKey: "",
      content: { state: "thinking" },
    });
  });

  it("sendTurnAnchor posts a normal text message (the answer anchor)", async () => {
    const m = mockClient();
    const id = await sendTurnAnchor(m.client, "!r:hs");
    expect(id).toBe("$ev1");
    expect(m.sent[0].content.msgtype).toBe("m.text");
  });
});
