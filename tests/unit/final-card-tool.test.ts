import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendHtmlCard, getHandle } = vi.hoisted(() => ({
  sendHtmlCard: vi.fn(() => Promise.resolve("$evt:hs")),
  getHandle: vi.fn((): { client: object } | undefined => ({ client: {} })),
}));

vi.mock("../../src/matrix/send.js", () => ({ sendHtmlCard }));
vi.mock("../../src/channel-runtime.js", () => ({ getHandle }));
vi.mock("../../src/telemetry.js", () => ({ report: vi.fn() }));

import { registerFinalCardTool } from "../../src/final-card-tool.js";
import { consumeCardFinalized } from "../../src/matrix/card-finalize.js";

type ToolCtx = {
  deliveryContext?: { channel?: string; to?: string; accountId?: string };
  messageChannel?: string;
  agentAccountId?: string;
};
type FinalCardTool = {
  name: string;
  execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
};
type Factory = (ctx: ToolCtx) => FinalCardTool | null;

function captureFactory(): Factory {
  let captured: Factory | undefined;
  registerFinalCardTool({
    registerTool: (f: unknown) => {
      captured = f as Factory;
    },
  });
  if (!captured) throw new Error("registerTool was not called");
  return captured;
}

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]?.text ?? "{}");
}

function expectTool(tool: FinalCardTool | null): FinalCardTool {
  if (!tool) throw new Error("expected the final_card tool to be exposed");
  return tool;
}

beforeEach(() => {
  getHandle.mockReturnValue({ client: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("final_card tool factory", () => {
  it("is not exposed off chat4000 turns", () => {
    const factory = captureFactory();
    expect(factory({ deliveryContext: { channel: "telegram", to: "x" } })).toBeNull();
    expect(factory({ messageChannel: "discord" })).toBeNull();
  });

  it("is not exposed without a target room", () => {
    const factory = captureFactory();
    expect(factory({ deliveryContext: { channel: "chat4000" } })).toBeNull();
  });

  it("sends the card for a chat4000 turn and marks the turn finalized", async () => {
    const factory = captureFactory();
    const tool = expectTool(
      factory({
        deliveryContext: { channel: "chat4000", to: "!room:hs", accountId: "default" },
      }),
    );
    expect(tool.name).toBe("final_card");
    const res = await tool.execute("tc1", { html: "<div class='c4k'>hi</div>" });
    expect(sendHtmlCard).toHaveBeenCalledWith({}, "!room:hs", "<div class='c4k'>hi</div>");
    expect(parse(res)).toMatchObject({ ok: true, sent: true, event_id: "$evt:hs" });
    // The channel will now suppress the streamed text final for this turn.
    expect(consumeCardFinalized("!room:hs")).toBe(true);
  });

  it("rejects empty html without sending or finalizing", async () => {
    const factory = captureFactory();
    const tool = expectTool(factory({ deliveryContext: { channel: "chat4000", to: "!r2:hs" } }));
    const res = await tool.execute("tc2", { html: "   " });
    expect(sendHtmlCard).not.toHaveBeenCalled();
    expect(parse(res)).toMatchObject({ ok: false, sent: false });
    expect(consumeCardFinalized("!r2:hs")).toBe(false);
  });

  it("reports a no client without throwing", async () => {
    const factory = captureFactory();
    getHandle.mockReturnValue(undefined);
    const tool = expectTool(factory({ deliveryContext: { channel: "chat4000", to: "!r3:hs" } }));
    const res = await tool.execute("tc3", { html: "<div>x</div>" });
    expect(sendHtmlCard).not.toHaveBeenCalled();
    expect(parse(res)).toMatchObject({ ok: false, sent: false });
  });
});
