import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GatewayTransport, gatewayToBaseUrl } from "../../src/matrix/gateway-transport.js";
import { _resetPushRegistry, markPush } from "../../src/matrix/push-registry.js";

/** Minimal stand-in for the global WebSocket the transport opens. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;

  readonly sent: string[] = [];

  private readonly listeners: Record<string, ((ev: unknown) => void)[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close", {});
  }

  emit(type: string, ev: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

/** Narrow a possibly-undefined lookup, failing the test if it's missing. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value but found none");
  return value;
}

const realWebSocket = globalThis.WebSocket;

afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  FakeWebSocket.instances = [];
});

async function connected(): Promise<{ transport: GatewayTransport; ws: FakeWebSocket }> {
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  const transport = new GatewayTransport({
    gatewayUrl: "wss://gateway.chat4000.com/ws",
    accessToken: "syt_token",
  });
  const connectP = transport.connect();
  const ws = FakeWebSocket.instances[0];
  ws.emit("open", {});
  ws.emit("message", {
    data: JSON.stringify({ t: "auth_ok", user_id: "@plugin_x:hs", device_id: "D1" }),
  });
  await connectP;
  return { transport, ws };
}

describe("gatewayToBaseUrl", () => {
  it("maps wss/ws to https/http origin and drops the path", () => {
    expect(gatewayToBaseUrl("wss://gateway.chat4000.com/ws")).toBe("https://gateway.chat4000.com");
    expect(gatewayToBaseUrl("ws://localhost:8090/ws")).toBe("http://localhost:8090");
  });
});

describe("GatewayTransport", () => {
  it("sends an auth frame on open and resolves connect on auth_ok", async () => {
    const { ws } = await connected();
    expect(ws.frames()[0]).toEqual({ t: "auth", access_token: "syt_token" });
  });

  it("tunnels a C-S call as a req frame and resolves the matching resp", async () => {
    const { transport, ws } = await connected();
    const respP = transport.fetch("https://gateway.chat4000.com/_matrix/client/v3/whoami", {
      method: "GET",
    });
    // fetch awaits async body extraction before sending — let that microtask run.
    await new Promise((r) => setTimeout(r, 0));
    const req = ws.frames().find((f) => f.t === "req");
    expect(req).toMatchObject({ t: "req", method: "GET", path: "/_matrix/client/v3/whoami" });

    ws.emit("message", {
      data: JSON.stringify({
        t: "resp",
        id: defined(req).id,
        status: 200,
        body: { user_id: "@plugin_x:hs" },
      }),
    });
    const res = await respP;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: "@plugin_x:hs" });
  });

  it("starts sync via sync_start and resolves slidingSyncRequest from a sync frame", async () => {
    const { transport, ws } = await connected();
    const syncP = transport.slidingSyncRequest({ lists: { all: { ranges: [[0, 10]] } } });
    // slidingSyncRequest awaits the prior-batch ack before sending sync_start.
    await new Promise((r) => setTimeout(r, 0));
    const start = ws.frames().find((f) => f.t === "sync_start");
    expect(start).toBeTruthy();

    ws.emit("message", {
      data: JSON.stringify({ t: "sync", pos: "p1", lists: {}, rooms: {}, extensions: {} }),
    });
    const resp = await syncP;
    expect(resp.pos).toBe("p1");
    expect(resp.rooms).toEqual({});
  });

  it("rejects an in-flight req when the socket closes", async () => {
    const { transport, ws } = await connected();
    const respP = transport
      .fetch("https://gateway.chat4000.com/_matrix/client/v3/whoami", {
        method: "GET",
      })
      .catch((e: Error) => e);
    ws.close();
    const err = await respP;
    expect(err).toBeInstanceOf(Error);
  });

  it("routes media paths to real HTTP, not the WS (PROTOCOL D.3)", async () => {
    const { transport, ws } = await connected();
    const realFetch = globalThis.fetch;
    const mock = vi.fn(() => Promise.resolve(new Response("bytes", { status: 200 })));
    (globalThis as { fetch: unknown }).fetch = mock;
    try {
      const res = await transport.fetch(
        "https://gateway.chat4000.com/_matrix/client/v1/media/download/hs/abc",
        { method: "GET" },
      );
      expect(res.status).toBe(200);
      expect(mock).toHaveBeenCalledTimes(1);
      // No `req` frame should have been sent for media.
      expect(ws.frames().some((f) => f.t === "req")).toBe(false);
    } finally {
      (globalThis as { fetch: unknown }).fetch = realFetch;
    }
  });

  it("flushes crypto + sync_acks a batch that carried to-device keys (PROTOCOL D.2)", async () => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const flush = vi.fn(() => Promise.resolve(undefined));
    const dir = mkdtempSync(path.join(os.tmpdir(), "c4k-pos-"));
    const posFile = path.join(dir, "pos.txt");
    try {
      const transport = new GatewayTransport({
        gatewayUrl: "wss://gateway.chat4000.com/ws",
        accessToken: "syt",
        flushBeforeAck: flush,
        posFilePath: posFile,
      });
      const connectP = transport.connect();
      const ws = FakeWebSocket.instances[0];
      ws.emit("open", {});
      ws.emit("message", {
        data: JSON.stringify({ t: "auth_ok", user_id: "@p:hs", device_id: "D" }),
      });
      await connectP;

      const p1 = transport.slidingSyncRequest({ lists: {} });
      ws.emit("message", {
        data: JSON.stringify({
          t: "sync",
          pos: "p1",
          lists: {},
          rooms: {},
          extensions: { to_device: { events: [{ type: "m.room.encrypted" }] } },
        }),
      });
      await p1;

      // The SDK asking again means it processed p1 → flush + ack p1.
      void transport.slidingSyncRequest({ lists: {} }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 0));

      expect(flush).toHaveBeenCalledTimes(1);
      const ack = ws.frames().find((f) => f.t === "sync_ack");
      expect(ack?.pos).toBe("p1");
      expect(readFileSync(posFile, "utf8")).toBe("p1");
      transport.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sync_acks a keyless batch WITHOUT flushing crypto (PROTOCOL D.2)", async () => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const flush = vi.fn(() => Promise.resolve(undefined));
    const transport = new GatewayTransport({
      gatewayUrl: "wss://gateway.chat4000.com/ws",
      accessToken: "syt",
      flushBeforeAck: flush,
    });
    const connectP = transport.connect();
    const ws = FakeWebSocket.instances[0];
    ws.emit("open", {});
    ws.emit("message", {
      data: JSON.stringify({ t: "auth_ok", user_id: "@p:hs", device_id: "D" }),
    });
    await connectP;

    const p1 = transport.slidingSyncRequest({ lists: {} });
    ws.emit("message", {
      data: JSON.stringify({ t: "sync", pos: "p2", lists: {}, rooms: {}, extensions: {} }),
    });
    await p1;
    void transport.slidingSyncRequest({ lists: {} }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));

    expect(flush).not.toHaveBeenCalled();
    expect(ws.frames().find((f) => f.t === "sync_ack")?.pos).toBe("p2");
    transport.dispose();
  });

  it("injects chat4000.push into an encrypted send keyed by txnId (PROTOCOL E)", async () => {
    _resetPushRegistry();
    const { transport, ws } = await connected();
    markPush("TXN42", false);
    void transport.fetch(
      "https://gateway.chat4000.com/_matrix/client/v3/rooms/!r:hs/send/m.room.encrypted/TXN42",
      {
        method: "PUT",
        body: JSON.stringify({ algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x" }),
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    const req = ws.frames().find((f) => f.t === "req");
    expect((defined(req).body as Record<string, unknown>)["chat4000.push"]).toBe(false);
  });
});
