import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // dispose() cancels the reconnect timer onClose scheduled — without this the
    // transport would open a stray socket ~500ms later, polluting a later test.
    transport.dispose();
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
      // Cursors persist as one JSON object; this batch carried no to_device_pos.
      expect(JSON.parse(readFileSync(posFile, "utf8")) as unknown).toEqual({ pos: "p1" });
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

  it("persists to_device_pos atomically with keys and acks BOTH cursors (PROTOCOL D.2)", async () => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const flush = vi.fn(() => Promise.resolve(undefined));
    const dir = mkdtempSync(path.join(os.tmpdir(), "c4k-td-"));
    const posFile = path.join(dir, "pos.json");
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
          pos: "r1",
          to_device_pos: "t1",
          lists: {},
          rooms: {},
          extensions: { to_device: { events: [{ type: "m.room.encrypted" }] } },
        }),
      });
      await p1;

      void transport.slidingSyncRequest({ lists: {} }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 0));

      expect(flush).toHaveBeenCalledTimes(1);
      const ack = ws.frames().find((f) => f.t === "sync_ack");
      expect(ack).toMatchObject({ pos: "r1", to_device_pos: "t1" });
      expect(JSON.parse(readFileSync(posFile, "utf8")) as unknown).toEqual({
        pos: "r1",
        to_device_pos: "t1",
      });
      transport.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT ack to_device_pos until the key flush resolves (PROTOCOL D.2)", async () => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const flush = vi.fn(() => gate);
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
      data: JSON.stringify({
        t: "sync",
        pos: "r1",
        to_device_pos: "t1",
        lists: {},
        rooms: {},
        extensions: { to_device: { events: [{ type: "m.room.encrypted" }] } },
      }),
    });
    await p1;

    void transport.slidingSyncRequest({ lists: {} }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    // Flush is in flight (unresolved) → the ack MUST NOT have been sent yet.
    expect(flush).toHaveBeenCalledTimes(1);
    expect(ws.frames().some((f) => f.t === "sync_ack")).toBe(false);

    release();
    await new Promise((r) => setTimeout(r, 0));
    const ack = ws.frames().find((f) => f.t === "sync_ack");
    expect(ack).toMatchObject({ pos: "r1", to_device_pos: "t1" });
    transport.dispose();
  });

  it("carries the last to_device_pos forward on a frame with no to-device section (D.2)", async () => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const flush = vi.fn(() => Promise.resolve(undefined));
    const dir = mkdtempSync(path.join(os.tmpdir(), "c4k-cf-"));
    const posFile = path.join(dir, "pos.json");
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

      // Frame 1 advances the to-device cursor to t1 (carries keys).
      const p1 = transport.slidingSyncRequest({ lists: {} });
      ws.emit("message", {
        data: JSON.stringify({
          t: "sync",
          pos: "r1",
          to_device_pos: "t1",
          lists: {},
          rooms: {},
          extensions: { to_device: { events: [{ type: "m.room.encrypted" }] } },
        }),
      });
      await p1;

      // Frame 2 has NO to-device section — only the room cursor moves.
      const p2 = transport.slidingSyncRequest({ lists: {} }); // this acks frame 1
      ws.emit("message", {
        data: JSON.stringify({ t: "sync", pos: "r2", lists: {}, rooms: {}, extensions: {} }),
      });
      await p2;

      // A third request acks frame 2 → to_device_pos carried forward as t1.
      void transport.slidingSyncRequest({ lists: {} }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 0));

      const acks = ws.frames().filter((f) => f.t === "sync_ack");
      expect(acks.at(-1)).toMatchObject({ pos: "r2", to_device_pos: "t1" });
      expect(JSON.parse(readFileSync(posFile, "utf8")) as unknown).toEqual({
        pos: "r2",
        to_device_pos: "t1",
      });
      transport.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes from persisted pos AND to_device_pos in sync_start (device is source of truth)", async () => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const dir = mkdtempSync(path.join(os.tmpdir(), "c4k-rs-"));
    const posFile = path.join(dir, "pos.json");
    try {
      writeFileSync(posFile, JSON.stringify({ pos: "r9", to_device_pos: "t9" }), "utf8");
      const transport = new GatewayTransport({
        gatewayUrl: "wss://gateway.chat4000.com/ws",
        accessToken: "syt",
        posFilePath: posFile,
      });
      const connectP = transport.connect();
      const ws = FakeWebSocket.instances[0];
      ws.emit("open", {});
      ws.emit("message", {
        data: JSON.stringify({ t: "auth_ok", user_id: "@p:hs", device_id: "D" }),
      });
      await connectP;

      void transport.slidingSyncRequest({ lists: {} }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 0));
      const start = ws.frames().find((f) => f.t === "sync_start");
      expect(start).toMatchObject({ pos: "r9", to_device_pos: "t9" });
      transport.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resends both cursors in sync_start after a dropped socket reconnects (D.2)", async () => {
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
    await new Promise((r) => setTimeout(r, 0));
    ws.emit("message", {
      data: JSON.stringify({
        t: "sync",
        pos: "r1",
        to_device_pos: "t1",
        lists: {},
        rooms: {},
        extensions: { to_device: { events: [{ type: "m.room.encrypted" }] } },
      }),
    });
    await p1;
    // Ack frame 1 so both cursors become durable, then drop the socket.
    void transport.slidingSyncRequest({ lists: {} }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    const beforeReconnect = FakeWebSocket.instances.length;
    ws.close();

    // Wait out the reconnect backoff (~500ms + jitter), then drive the new socket
    // (indexed from the count before close, so it's robust to any stray instance).
    await new Promise((r) => setTimeout(r, 900));
    const ws2 = FakeWebSocket.instances[beforeReconnect];
    expect(ws2).toBeTruthy();
    ws2.emit("open", {});
    ws2.emit("message", {
      data: JSON.stringify({ t: "auth_ok", user_id: "@p:hs", device_id: "D" }),
    });
    await new Promise((r) => setTimeout(r, 0));

    const start = ws2.frames().find((f) => f.t === "sync_start");
    expect(start).toMatchObject({ pos: "r1", to_device_pos: "t1" });
    transport.dispose();
  });

  it("sync_reset(pos_expired) discards the room pos but KEEPS to_device_pos (PROTOCOL D.2)", async () => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const flush = vi.fn(() => Promise.resolve(undefined));
    const dir = mkdtempSync(path.join(os.tmpdir(), "c4k-reset-"));
    const posFile = path.join(dir, "pos.json");
    try {
      // Start with BOTH cursors durably persisted from a prior session.
      writeFileSync(posFile, JSON.stringify({ pos: "r9", to_device_pos: "t9" }), "utf8");
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

      ws.emit("message", {
        data: JSON.stringify({ t: "sync_reset", reason: "pos_expired", cursors: ["pos"] }),
      });

      // Durable file now holds ONLY the surviving to-device cursor.
      expect(JSON.parse(readFileSync(posFile, "utf8")) as unknown).toEqual({ to_device_pos: "t9" });
      // Crypto state untouched, and we did NOT send a new sync_start.
      expect(flush).not.toHaveBeenCalled();
      expect(ws.frames().some((f) => f.t === "sync_start")).toBe(false);
      transport.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("after sync_reset, sync_start resumes WITHOUT the expired pos but with to_device_pos (D.2)", async () => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const dir = mkdtempSync(path.join(os.tmpdir(), "c4k-reset-rs-"));
    const posFile = path.join(dir, "pos.json");
    try {
      writeFileSync(posFile, JSON.stringify({ pos: "r9", to_device_pos: "t9" }), "utf8");
      const transport = new GatewayTransport({
        gatewayUrl: "wss://gateway.chat4000.com/ws",
        accessToken: "syt",
        posFilePath: posFile,
      });
      const connectP = transport.connect();
      const ws = FakeWebSocket.instances[0];
      ws.emit("open", {});
      ws.emit("message", {
        data: JSON.stringify({ t: "auth_ok", user_id: "@p:hs", device_id: "D" }),
      });
      await connectP;

      ws.emit("message", {
        data: JSON.stringify({ t: "sync_reset", reason: "pos_expired", cursors: ["pos"] }),
      });

      // The SDK's first sync request after the reset must NOT replay the stale pos.
      void transport.slidingSyncRequest({ lists: {} }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 0));
      const start = ws.frames().find((f) => f.t === "sync_start");
      expect(start).toBeTruthy();
      expect(defined(start).pos).toBeUndefined();
      expect(defined(start).to_device_pos).toBe("t9");
      transport.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps consuming fresh sync frames after a reset and persists the new pos via the ack flow (D.2)", async () => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const dir = mkdtempSync(path.join(os.tmpdir(), "c4k-reset-cont-"));
    const posFile = path.join(dir, "pos.json");
    try {
      writeFileSync(posFile, JSON.stringify({ pos: "r9", to_device_pos: "t9" }), "utf8");
      const transport = new GatewayTransport({
        gatewayUrl: "wss://gateway.chat4000.com/ws",
        accessToken: "syt",
        posFilePath: posFile,
      });
      const connectP = transport.connect();
      const ws = FakeWebSocket.instances[0];
      ws.emit("open", {});
      ws.emit("message", {
        data: JSON.stringify({ t: "auth_ok", user_id: "@p:hs", device_id: "D" }),
      });
      await connectP;

      ws.emit("message", {
        data: JSON.stringify({ t: "sync_reset", reason: "pos_expired", cursors: ["pos"] }),
      });

      // A fresh sync frame from the re-initialised upstream is consumed normally.
      const p1 = transport.slidingSyncRequest({ lists: {} });
      ws.emit("message", {
        data: JSON.stringify({ t: "sync", pos: "fresh1", lists: {}, rooms: {}, extensions: {} }),
      });
      const resp = await p1;
      expect(resp.pos).toBe("fresh1");

      // Its ack persists the new room pos alongside the preserved to-device cursor.
      void transport.slidingSyncRequest({ lists: {} }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 0));
      const ack = ws.frames().find((f) => f.t === "sync_ack");
      expect(ack).toMatchObject({ pos: "fresh1", to_device_pos: "t9" });
      expect(JSON.parse(readFileSync(posFile, "utf8")) as unknown).toEqual({
        pos: "fresh1",
        to_device_pos: "t9",
      });
      transport.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sync_reset removes the cursor file when no cursor survives (no to_device_pos yet)", async () => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const dir = mkdtempSync(path.join(os.tmpdir(), "c4k-reset-rm-"));
    const posFile = path.join(dir, "pos.json");
    try {
      writeFileSync(posFile, JSON.stringify({ pos: "r9" }), "utf8");
      const transport = new GatewayTransport({
        gatewayUrl: "wss://gateway.chat4000.com/ws",
        accessToken: "syt",
        posFilePath: posFile,
      });
      const connectP = transport.connect();
      const ws = FakeWebSocket.instances[0];
      ws.emit("open", {});
      ws.emit("message", {
        data: JSON.stringify({ t: "auth_ok", user_id: "@p:hs", device_id: "D" }),
      });
      await connectP;

      ws.emit("message", {
        data: JSON.stringify({ t: "sync_reset", reason: "pos_expired", cursors: ["pos"] }),
      });

      expect(existsSync(posFile)).toBe(false);
      transport.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sync_reset drops a not-yet-acked pre-reset pos instead of acking it (D.2)", async () => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    const flush = vi.fn(() => Promise.resolve(undefined));
    const dir = mkdtempSync(path.join(os.tmpdir(), "c4k-reset-pend-"));
    const posFile = path.join(dir, "pos.json");
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

      // A keyless frame is delivered to the SDK but not yet acked.
      const p1 = transport.slidingSyncRequest({ lists: {} });
      ws.emit("message", {
        data: JSON.stringify({ t: "sync", pos: "stale", lists: {}, rooms: {}, extensions: {} }),
      });
      await p1;

      // The room cursor expires before that batch could be acked.
      ws.emit("message", {
        data: JSON.stringify({ t: "sync_reset", reason: "pos_expired", cursors: ["pos"] }),
      });

      // The SDK asking again would normally ack "stale"; the reset must have
      // dropped it, so no sync_ack carrying the expired pos is ever sent.
      void transport.slidingSyncRequest({ lists: {} }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 0));
      expect(ws.frames().some((f) => f.t === "sync_ack" && f.pos === "stale")).toBe(false);
      transport.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
