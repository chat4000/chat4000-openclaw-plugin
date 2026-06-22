/**
 * GatewayTransport — the plugin's pipe to the chat4000 WS Gateway (PROTOCOL D).
 *
 * The homeserver has NO public hostname (PROTOCOL section 0); plugins, like
 * devices, reach it ONLY through the gateway's single WebSocket, which wraps the
 * Matrix client-server API. This class is that pipe — and nothing more:
 *
 *   - `fetch` is a drop-in `fetchFn` for matrix-js-sdk's `createClient`. Every
 *     C-S REST call the SDK makes (send event, receipts, room create, state, AND
 *     all crypto key upload/query/claim + to-device) becomes a `req` frame and
 *     resolves from the matching `resp`. Because crypto rides the same fetchFn,
 *     the SDK's Rust crypto keeps doing ALL Olm/Megolm — we never touch it.
 *   - `slidingSyncRequest` bridges matrix-js-sdk's `SlidingSync` (which pulls one
 *     response per call) to the gateway's push model (`sync_start` then streamed
 *     `sync` frames). It is wired in as `client.slidingSync` — the SDK's own
 *     network seam (it takes a `proxyBaseUrl` precisely so sync can be redirected).
 *
 * Reconnect/backoff, re-auth, and request/sync correlation live here. No Matrix
 * semantics and no encryption — those stay in the SDK.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  MSC3575SlidingSyncRequest,
  MSC3575SlidingSyncResponse,
} from "matrix-js-sdk/lib/sliding-sync.js";
import { getPush } from "./push-registry.js";

type Logger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
};

/** Client identity sent on the first `auth` frame (PROTOCOL D.1). */
export type GatewayClientIdentity = {
  appId: string;
  clientVersion: string;
  platform: string;
  releaseChannel: string;
};

export type GatewayTransportOptions = {
  /** The gateway WebSocket URL from redeem, e.g. wss://gateway.chat4000.com/ws. */
  gatewayUrl: string;
  /** The device/plugin Matrix access token (authenticates the socket). */
  accessToken: string;
  /** Identity reported on the first auth frame (drives the gateway version gate). */
  clientIdentity?: GatewayClientIdentity;
  /**
   * File where the last durably-acked sync cursors are persisted (PROTOCOL D.2).
   * Holds BOTH the room cursor (`pos`) and the to-device cursor (`to_device_pos`)
   * as one JSON object `{ pos, to_device_pos }`, so they advance atomically (a
   * single write) and resume together. Loaded on construction → both resent in
   * `sync_start`; rewritten (after the crypto flush) before each ack. A legacy
   * bare-`pos` string file is still read (to_device_pos starts empty).
   */
  posFilePath?: string;
  /**
   * Flush the crypto store to durable storage. Called BEFORE `sync_ack` for any
   * batch that carried to-device keys, so the gateway only deletes server-side
   * room keys we have already saved (PROTOCOL D.2). The to-device cursor is
   * persisted only AFTER this resolves, so a crash can at worst force idempotent
   * re-delivery of keys we already saved — never deletion of unsaved keys.
   */
  flushBeforeAck?: (() => Promise<void>) | undefined;
  log?: Logger | undefined;
  /** Per-`req` response timeout. */
  requestTimeoutMs?: number;
  /** How long a sync wait blocks before returning an empty delta (long-poll-ish). */
  syncTimeoutMs?: number;
  /** Reconnect backoff ceiling. */
  maxBackoffMs?: number;
};

type PendingReq = {
  resolve: (r: { status: number; body: unknown }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type SyncWaiter = {
  resolve: (r: MSC3575SlidingSyncResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const EMPTY_DELTA = (pos: string): MSC3575SlidingSyncResponse => ({
  pos,
  lists: {},
  rooms: {},
  extensions: {},
});

/** Cap the unconsumed sync backlog so a stalled consumer can't grow it forever. */
const MAX_SYNC_QUEUE = 256;

/**
 * matrix-js-sdk's `createClient` needs an http(s) `baseUrl` to build request
 * URLs, but every request is tunneled through `fetch` here, so only the origin
 * is ever parsed back out — the gateway routes by path, not host. Map the
 * gateway's ws/wss URL to an http/https origin for that purpose.
 */
export function gatewayToBaseUrl(gatewayUrl: string): string {
  try {
    const u = new URL(gatewayUrl);
    const scheme = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
    return `${scheme}//${u.host}`;
  } catch {
    return "https://gateway.invalid";
  }
}

export class GatewayTransport {
  private readonly gatewayUrl: string;

  private readonly accessToken: string;

  private readonly clientIdentity?: GatewayClientIdentity | undefined;

  private readonly posFilePath?: string | undefined;

  private readonly flushBeforeAck?: (() => Promise<void>) | undefined;

  private readonly log?: Logger | undefined;

  private readonly requestTimeoutMs: number;

  private readonly syncTimeoutMs: number;

  private readonly maxBackoffMs: number;

  private ws: WebSocket | undefined;

  private connected = false;

  private closed = false;

  private reqCounter = 0;

  private backoffMs = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly pending = new Map<string, PendingReq>();

  private syncWaiters: SyncWaiter[] = [];

  private readonly syncQueue: MSC3575SlidingSyncResponse[] = [];

  /** Last sliding-sync body we sent (JSON), to detect when to `sync_update`. */
  private lastSyncBody: string | undefined;

  private syncStarted = false;

  /** Latest pos seen on any frame (for the empty-delta fallback). */
  private lastPos: string | undefined;

  /** Last room cursor we durably persisted + acked — resume point in sync_start. */
  private ackedPos: string | undefined;

  /**
   * Last to-device cursor we durably persisted + acked (PROTOCOL D.2). Tracked
   * SEPARATELY from `ackedPos` — the two are independent server-side cursors and
   * the to-device one is NEVER derived from `pos`. Carried forward across frames
   * that have no to-device section, and resent in `sync_start` on reconnect.
   */
  private ackedToDevicePos: string | undefined;

  /**
   * The last frame DELIVERED to the SDK, awaiting ack on its next sync request.
   * `pos` is normally the batch's room cursor, but becomes `undefined` if a
   * `sync_reset` dropped the room cursor before this batch could be acked — the
   * ack then carries only the to-device cursor (PROTOCOL D.2 cursor expiry).
   */
  private pendingAck:
    | { pos: string | undefined; toDevicePos: string | undefined; hadKeys: boolean }
    | undefined;

  /** Resolver for the in-progress (re)connect's auth handshake. */
  private authSettle: { resolve: () => void; reject: (e: Error) => void } | undefined;

  constructor(opts: GatewayTransportOptions) {
    this.gatewayUrl = opts.gatewayUrl;
    this.accessToken = opts.accessToken;
    this.clientIdentity = opts.clientIdentity;
    this.posFilePath = opts.posFilePath;
    this.flushBeforeAck = opts.flushBeforeAck;
    this.log = opts.log;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.syncTimeoutMs = opts.syncTimeoutMs ?? 30_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    const persisted = this.loadPersistedCursors();
    this.ackedPos = persisted.pos;
    this.ackedToDevicePos = persisted.toDevicePos;
  }

  /** Open the socket and resolve once the gateway accepts our `auth` frame. */
  connect(): Promise<void> {
    return this.openSocket();
  }

  /** matrix-js-sdk `fetchFn`: tunnel one C-S REST call as a `req`/`resp`. */
  fetch = async (resource: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const { method, path } = describeRequest(resource, init);
    // G1 (PROTOCOL D.3): binary media rides the HTTP media passthrough on the
    // gateway host, NOT the WS — the request URL already points there
    // (baseUrl = the gateway origin). Hand it straight to real HTTP.
    if (isMediaPath(path)) {
      return globalThis.fetch(resource, init);
    }
    let body = extractJsonBody(init);
    // G2 (PROTOCOL E): inject the cleartext `chat4000.push` flag into an outgoing
    // message send (keyed by the txnId in the path) so it sits outside the
    // encrypted payload where the homeserver push rule can read it.
    body = injectPushFlag(path, body);
    const { status, body: respBody } = await this.request(method, path, body);
    const text =
      typeof respBody === "string"
        ? respBody
        : respBody === undefined
          ? ""
          : JSON.stringify(respBody);
    return new Response(text, {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  /**
   * Bridge a SlidingSync request to the gateway. Start (or update) the gateway's
   * sync loop with this body, then resolve with the next pushed `sync` frame —
   * or, after `timeout`, an empty delta so the SDK's loop stays healthy.
   */
  slidingSyncRequest = async (
    req: MSC3575SlidingSyncRequest,
    _proxyBaseUrl?: string,
    abortSignal?: AbortSignal,
  ): Promise<MSC3575SlidingSyncResponse> => {
    // The SDK calling us again means it finished processing the frame we last
    // returned — its to-device room keys are now in the (in-memory) crypto store.
    // Persist them + the pos, THEN ack so the gateway may advance/delete upstream
    // (PROTOCOL D.2). Done before serving the next request, never concurrently.
    await this.flushAndAckPending();

    const syncBody = {
      lists: req.lists,
      room_subscriptions: req.room_subscriptions,
      unsubscribe_rooms: req.unsubscribe_rooms,
      extensions: req.extensions,
    };
    const bodyJson = JSON.stringify(syncBody);
    if (!this.syncStarted) {
      this.syncStarted = true;
      this.lastSyncBody = bodyJson;
      this.sendSyncStart(syncBody);
    } else if (bodyJson !== this.lastSyncBody) {
      this.lastSyncBody = bodyJson;
      this.safeSend({ t: "sync_update", body: syncBody });
    }
    return this.nextSyncFrame(req.timeout ?? this.syncTimeoutMs, abortSignal);
  };

  /** Stop the socket permanently and fail anything in flight. */
  dispose(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.failInFlight(new Error("gateway transport disposed"));
    this.syncStarted = false;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = undefined;
    this.connected = false;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.authSettle = { resolve, reject };
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.gatewayUrl);
      } catch (err) {
        this.authSettle = undefined;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.safeSend(this.authFrame());
      });
      ws.addEventListener("message", (ev: MessageEvent) => {
        this.onMessage(ev.data);
      });
      ws.addEventListener("close", () => {
        this.onClose();
      });
      ws.addEventListener("error", () => {
        // A failed connection always also emits `close`; reconnect is handled there.
        this.log?.debug?.("gateway socket error");
      });
    });
  }

  private onMessage(data: unknown): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(typeof data === "string" ? data : String(data)) as Record<string, unknown>;
    } catch {
      this.log?.warn?.("gateway sent a non-JSON frame");
      return;
    }
    const t = frame.t;
    switch (t) {
      case "auth_ok": {
        this.connected = true;
        this.backoffMs = 0;
        this.log?.info?.(`gateway auth ok (${str(frame.user_id)})`);
        this.authSettle?.resolve();
        this.authSettle = undefined;
        // On a reconnect, resume the sync stream where we left off.
        if (this.syncStarted && this.lastSyncBody) {
          this.sendSyncStart(JSON.parse(this.lastSyncBody) as Record<string, unknown>);
        }
        return;
      }
      case "auth_error": {
        const reason = str(frame.reason, "auth rejected");
        this.log?.error?.(`gateway auth error: ${reason}`);
        this.authSettle?.reject(new Error(`gateway auth error: ${reason}`));
        this.authSettle = undefined;
        // Token is bad; don't hammer the gateway. dispose() stops reconnects.
        this.closed = true;
        try {
          this.ws?.close();
        } catch {
          // ignore
        }
        return;
      }
      case "reauth": {
        // Upstream 401 — resend the same token (it's all we have). If it's truly
        // dead the gateway answers auth_error next.
        this.safeSend(this.authFrame());
        return;
      }
      case "resp": {
        const id = str(frame.id);
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve({ status: Number(frame.status ?? 0), body: frame.body });
        return;
      }
      case "error": {
        this.log?.warn?.(`gateway error frame: ${str(frame.reason)}`);
        return;
      }
      case "sync": {
        this.onSyncFrame(frame);
        return;
      }
      case "sync_reset": {
        this.onSyncReset(frame);
        return;
      }
      default:
        this.log?.debug?.(`gateway sent unknown frame "${String(t)}"`);
    }
  }

  private onSyncFrame(frame: Record<string, unknown>): void {
    // The gateway splices `t:"sync"` onto the upstream sliding-sync response;
    // strip the tag and the rest IS an MSC3575SlidingSyncResponse.
    const { t: _t, ...rest } = frame;
    const resp = rest as unknown as MSC3575SlidingSyncResponse;
    if (typeof resp.pos === "string") this.lastPos = resp.pos;
    const waiter = this.syncWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      this.markPending(resp); // delivered to the SDK now → ack on its next request
      waiter.resolve(resp);
      return;
    }
    this.syncQueue.push(resp);
    if (this.syncQueue.length > MAX_SYNC_QUEUE) {
      this.syncQueue.shift();
      this.log?.warn?.("gateway sync backlog exceeded; dropped oldest delta");
    }
  }

  /**
   * Handle a `sync_reset` frame (PROTOCOL D.1/D.2 "Cursor expiry recovery").
   *
   * The homeserver expired the room cursor (`M_UNKNOWN_POS`); the gateway has
   * ALREADY dropped the named cursor(s) and re-initialised the upstream sync from
   * scratch on THIS SAME socket. Our job is narrow and exact:
   *
   *   - Immediately discard from DURABLE storage exactly the cursor(s) the frame
   *     names — for `pos_expired` that is the room `pos` ONLY — so a later
   *     reconnect cannot replay a stale `pos` and re-trigger `M_UNKNOWN_POS`.
   *   - KEEP every cursor NOT named (a `pos_expired` reset names `["pos"]`, leaving
   *     `to_device_pos` intact — it is a separate, durable stream token the expiry
   *     does NOT invalidate).
   *   - Do NOT tear down crypto state, and do NOT send a new `sync_start`. We keep
   *     consuming the fresh `sync` frames already streaming on this socket; their
   *     new `pos` is persisted through the normal ack flow.
   */
  private onSyncReset(frame: Record<string, unknown>): void {
    const reason = str(frame.reason, "unknown");
    const cursors = Array.isArray(frame.cursors)
      ? frame.cursors.filter((c): c is string => typeof c === "string")
      : [];
    this.log?.info?.(`gateway sync_reset (reason=${reason}, cursors=[${cursors.join(", ")}])`);

    const dropPos = cursors.includes("pos");
    const dropToDevice = cursors.includes("to_device_pos");
    if (!dropPos && !dropToDevice) {
      this.log?.warn?.(
        `gateway sync_reset named no known cursor (cursors=[${cursors.join(", ")}])`,
      );
      return;
    }

    if (dropPos) {
      // The room cursor is gone server-side; forget it everywhere it could be
      // replayed: the resume point (ackedPos), the empty-delta fallback (lastPos),
      // and any not-yet-acked batch whose `pos` belongs to the pre-reset stream.
      this.ackedPos = undefined;
      this.lastPos = undefined;
      if (this.pendingAck) this.discardPendingAckPos();
    }
    if (dropToDevice) {
      this.ackedToDevicePos = undefined;
      if (this.pendingAck) this.pendingAck.toDevicePos = undefined;
    }
    // Rewrite durable storage to exactly the surviving cursor(s), atomically — or
    // remove the file when nothing survives (PROTOCOL D.2: discard immediately so
    // a later reconnect cannot replay an expired cursor).
    this.persistAckedCursors(this.ackedPos, this.ackedToDevicePos);
  }

  /**
   * A `sync_reset` dropped the room `pos`, but a batch may already be staged for
   * ack carrying the now-invalid pre-reset `pos`. Drop that stale room cursor from
   * the pending ack so we never ack it against the freshly re-initialised stream,
   * while preserving the batch's to-device cursor/keys (unaffected by the reset).
   */
  private discardPendingAckPos(): void {
    const pending = this.pendingAck;
    if (!pending) return;
    if (pending.toDevicePos === undefined && !pending.hadKeys) {
      // Nothing to ack once the room pos is gone — drop the batch entirely.
      this.pendingAck = undefined;
      return;
    }
    // Keep the to-device side so its keys still get flushed + acked normally; the
    // ack will carry only the to-device cursor (omitting the dropped room pos).
    pending.pos = undefined;
  }

  private nextSyncFrame(
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ): Promise<MSC3575SlidingSyncResponse> {
    const buffered = this.syncQueue.shift();
    if (buffered) {
      this.markPending(buffered); // delivering a real frame → ack it next request
      return Promise.resolve(buffered);
    }
    return new Promise<MSC3575SlidingSyncResponse>((resolve, reject) => {
      const waiter: SyncWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeSyncWaiter(waiter);
          resolve(EMPTY_DELTA(this.lastPos ?? ""));
        }, timeoutMs),
      };
      if (abortSignal) {
        abortSignal.addEventListener(
          "abort",
          () => {
            if (this.removeSyncWaiter(waiter)) {
              clearTimeout(waiter.timer);
              reject(new Error("sliding sync aborted"));
            }
          },
          { once: true },
        );
      }
      this.syncWaiters.push(waiter);
    });
  }

  private removeSyncWaiter(waiter: SyncWaiter): boolean {
    const idx = this.syncWaiters.indexOf(waiter);
    if (idx === -1) return false;
    this.syncWaiters.splice(idx, 1);
    return true;
  }

  private request(
    method: string,
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error("gateway not connected"));
    }
    const id = String((this.reqCounter += 1));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request ${id} (${method} ${path}) timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const frame: Record<string, unknown> = { t: "req", id, method, path };
      if (body !== undefined) frame.body = body;
      this.safeSend(frame);
    });
  }

  /** The `auth` frame, carrying client identity for the gateway version gate (D.1). */
  private authFrame(): Record<string, unknown> {
    const frame: Record<string, unknown> = { t: "auth", access_token: this.accessToken };
    if (this.clientIdentity) {
      frame.app_id = this.clientIdentity.appId;
      frame.client_version = this.clientIdentity.clientVersion;
      frame.platform = this.clientIdentity.platform;
      frame.release_channel = this.clientIdentity.releaseChannel;
    }
    return frame;
  }

  private sendSyncStart(body: unknown): void {
    const frame: Record<string, unknown> = { t: "sync_start", body };
    // Resume from the last DURABLY-acked cursors (not lastPos, which may include
    // an un-persisted batch) so the homeserver re-delivers any keys we hadn't
    // saved. BOTH cursors are the device's source of truth (PROTOCOL D.2): the
    // gateway holds neither across reconnects. `to_device_pos` is independent of
    // `pos` — omit it only when we've never durably acked one.
    if (this.ackedPos) frame.pos = this.ackedPos;
    if (this.ackedToDevicePos) frame.to_device_pos = this.ackedToDevicePos;
    this.safeSend(frame);
  }

  /** Record the frame just handed to the SDK; it gets acked on the next request. */
  private markPending(resp: MSC3575SlidingSyncResponse): void {
    if (typeof resp.pos !== "string") return;
    // `to_device_pos` is present only when THIS batch advanced the to-device
    // cursor (the gateway lifts it from extensions.to_device.next_batch). The ack
    // echoes this value EXACTLY (present iff the frame carried one); the DURABLE
    // cursor carries the last value forward across frames with none. Neither is
    // ever derived from `pos` (PROTOCOL D.1).
    this.pendingAck = {
      pos: resp.pos,
      toDevicePos: readToDevicePos(resp),
      hadKeys: respHasToDevice(resp),
    };
  }

  /**
   * Flush crypto (if the pending batch carried keys), persist BOTH cursors, then
   * `sync_ack` them (PROTOCOL D.2). Order is correctness-critical: keys are on
   * durable storage (flush) BEFORE the to-device cursor is persisted/acked, so we
   * never ack a `to_device_pos` whose keys aren't saved. Restores the pending
   * state on failure so the next request retries.
   */
  private async flushAndAckPending(): Promise<void> {
    const pending = this.pendingAck;
    if (!pending || !this.connected) return;
    this.pendingAck = undefined;
    try {
      if (pending.hadKeys && this.flushBeforeAck) await this.flushBeforeAck();
      // Two DISTINCT to-device values, do not conflate them (PROTOCOL D.1):
      //
      //   • DURABLE cursor — carry the last value forward when this frame had no
      //     to-device section, so the cursor we persist and resend in `sync_start`
      //     on reconnect (carry-forward of the durable cursor is a RESUME concern)
      //     keeps the latest value we hold instead of regressing to undefined.
      //
      //   • ACK echo — the gateway now requires `sync_ack.to_device_pos` to ECHO
      //     EXACTLY the `to_device_pos` of the `sync` frame being acked: present
      //     IFF that frame carried a to-device section, omitted otherwise, and
      //     NEVER a carried-forward earlier value. The gateway validates the echo
      //     against the cursor it last sent and closes the socket with
      //     `bad_sync_ack` on any mismatch, so the ack must use `pending.toDevicePos`
      //     verbatim — not the durable carry-forward value.
      const durableToDevicePos = pending.toDevicePos ?? this.ackedToDevicePos;
      const ackToDevicePos = pending.toDevicePos;
      // A `sync_reset` can clear the room cursor for an in-flight batch (D.2
      // cursor expiry); the batch then carries only the to-device cursor.
      // `sync_ack.pos` is required by the gateway, so we don't ack a missing room
      // cursor — we still durably commit any to-device cursor (its keys were
      // flushed above) so the gateway's separate to-device cursor stays threaded,
      // and the next real `sync` frame's `pos` resumes the normal ack flow.
      if (pending.pos === undefined) {
        this.persistAckedCursors(undefined, durableToDevicePos);
        return;
      }
      this.persistAckedCursors(pending.pos, durableToDevicePos);
      const ack: Record<string, unknown> = { t: "sync_ack", pos: pending.pos };
      // Echo the acked frame's to-device cursor EXACTLY — present iff that frame
      // carried one, omitted otherwise. Absent leaves the gateway's to-device
      // cursor unchanged; a carried-forward value here would fail the gateway's
      // echo check (`bad_sync_ack`).
      if (ackToDevicePos !== undefined) ack.to_device_pos = ackToDevicePos;
      this.safeSend(ack);
    } catch (err) {
      this.pendingAck = pending; // not persisted → retry on the next request
      this.log?.warn?.(`sync_ack flush failed (will retry): ${String(err)}`);
    }
  }

  private loadPersistedCursors(): { pos: string | undefined; toDevicePos: string | undefined } {
    if (!this.posFilePath || !existsSync(this.posFilePath)) {
      return { pos: undefined, toDevicePos: undefined };
    }
    try {
      const raw = readFileSync(this.posFilePath, "utf8").trim();
      if (!raw) return { pos: undefined, toDevicePos: undefined };
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object") {
          const o = parsed as { pos?: unknown; to_device_pos?: unknown };
          return {
            pos: typeof o.pos === "string" ? o.pos : undefined,
            toDevicePos: typeof o.to_device_pos === "string" ? o.to_device_pos : undefined,
          };
        }
      } catch {
        // Legacy format: a bare `pos` string (no to-device cursor yet).
      }
      return { pos: raw, toDevicePos: undefined };
    } catch {
      return { pos: undefined, toDevicePos: undefined };
    }
  }

  /**
   * Persist both cursors as one atomic write (temp file + rename) so a crash
   * mid-write can never leave a half-written/corrupt cursor file (PROTOCOL D.2:
   * "durably AND atomically"). The two cursors always land together.
   *
   * `pos` is `undefined` only after a `sync_reset` discarded the room cursor (D.2
   * cursor expiry): the file is then rewritten to just the surviving to-device
   * cursor, or removed entirely if no cursor survives — so a later reconnect can
   * never replay an expired `pos`.
   */
  private persistAckedCursors(pos: string | undefined, toDevicePos: string | undefined): void {
    this.ackedPos = pos;
    this.ackedToDevicePos = toDevicePos;
    if (!this.posFilePath) return;
    try {
      if (pos === undefined && toDevicePos === undefined) {
        rmSync(this.posFilePath, { force: true });
        return;
      }
      mkdirSync(path.dirname(this.posFilePath), { recursive: true });
      const payload: Record<string, string> = {};
      if (pos !== undefined) payload.pos = pos;
      if (toDevicePos !== undefined) payload.to_device_pos = toDevicePos;
      const tmp = `${this.posFilePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), "utf8");
      renameSync(tmp, this.posFilePath);
    } catch (err) {
      this.log?.warn?.(`sync cursor persist failed: ${String(err)}`);
    }
  }

  private safeSend(frame: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch (err) {
      this.log?.warn?.(`gateway send failed: ${String(err)}`);
    }
  }

  private onClose(): void {
    this.connected = false;
    this.failInFlight(new Error("gateway connection closed"));
    if (this.closed) return;
    // Reconnect with exponential backoff + jitter; auth_ok resumes the sync.
    this.backoffMs = this.backoffMs === 0 ? 500 : Math.min(this.backoffMs * 2, this.maxBackoffMs);
    const jitter = Math.floor(this.backoffMs * 0.25 * fractionalJitter());
    const delay = this.backoffMs + jitter;
    this.log?.info?.(`gateway disconnected; reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      if (this.closed) return;
      this.openSocket().catch((err) => {
        // openSocket's rejection on a reconnect has no external awaiter; onClose
        // (which always follows a failed socket) reschedules.
        this.log?.debug?.(`gateway reconnect attempt failed: ${String(err)}`);
      });
    }, delay);
  }

  private failInFlight(err: Error): void {
    // A dropped socket invalidates any un-acked batch — we resume from ackedPos
    // and the homeserver re-delivers it, so don't ack a stale pos after reconnect.
    this.pendingAck = undefined;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    const waiters = this.syncWaiters;
    this.syncWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }
}

/** Safely stringify an unknown frame field, falling back when it isn't a string. */
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : JSON.stringify(value);
}

// ── request shaping helpers ───────────────────────────────────────────────────

/** Media passthrough paths (PROTOCOL D.3) — these go over HTTP, not the WS. */
function isMediaPath(path: string): boolean {
  return path.startsWith("/_matrix/media/") || path.startsWith("/_matrix/client/v1/media/");
}

/**
 * Did this sync delta carry to-device messages (Olm-wrapped Megolm room keys)?
 * Only then must we flush the crypto store to disk before acking (PROTOCOL D.2) —
 * most deltas carry none, so we avoid a disk dump on every batch.
 */
function respHasToDevice(resp: MSC3575SlidingSyncResponse): boolean {
  const ext = (resp as { extensions?: Record<string, unknown> }).extensions;
  if (!ext) return false;
  const td = (ext.to_device ?? ext["m.to_device"]) as { events?: unknown[] } | undefined;
  return Array.isArray(td?.events) && td.events.length > 0;
}

/**
 * The to-device cursor the gateway lifted onto the top level of this `sync` frame
 * (PROTOCOL D.1) — present only when the batch advanced the to-device cursor.
 */
function readToDevicePos(resp: MSC3575SlidingSyncResponse): string | undefined {
  const v = (resp as { to_device_pos?: unknown }).to_device_pos;
  return typeof v === "string" ? v : undefined;
}

const SEND_EVENT_PATH = /\/rooms\/[^/]+\/send\/(m\.room\.encrypted|m\.room\.message)\/([^/?]+)/;

/**
 * If `path` is an outgoing message send and the send layer recorded a push
 * intent for its txnId, splice the cleartext `chat4000.push` field into the
 * (already-encrypted) wire content. The ciphertext is untouched — this only adds
 * a sibling boolean the homeserver can read (PROTOCOL E).
 */
function injectPushFlag(path: string, body: unknown): unknown {
  const m = SEND_EVENT_PATH.exec(path);
  if (!m?.[2]) return body;
  const txnId = decodeURIComponent(m[2]);
  const push = getPush(txnId);
  if (push === undefined) return body;
  const obj = body && typeof body === "object" ? { ...(body as Record<string, unknown>) } : {};
  obj["chat4000.push"] = push;
  return obj;
}

function describeRequest(
  resource: URL | RequestInfo,
  init?: RequestInit,
): {
  method: string;
  path: string;
} {
  let urlString: string;
  let method = init?.method;
  if (typeof resource === "string") {
    urlString = resource;
  } else if (resource instanceof URL) {
    urlString = resource.toString();
  } else {
    // Request object
    urlString = resource.url;
    method = method ?? resource.method;
  }
  const url = new URL(urlString);
  return {
    method: (method ?? "GET").toUpperCase(),
    path: url.pathname + url.search,
  };
}

function extractJsonBody(init?: RequestInit): unknown {
  const raw = init?.body;
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (raw instanceof URLSearchParams) return raw.toString();
  // Binary bodies (media uploads) cannot ride the gateway's JSON `req` frame.
  // FAIL LOUDLY rather than send an empty body and silently corrupt the upload:
  // native mxc media transport (C4) needs the gateway to carry binary first.
  if (
    raw instanceof ArrayBuffer ||
    ArrayBuffer.isView(raw) ||
    (typeof Blob !== "undefined" && raw instanceof Blob) ||
    (typeof ReadableStream !== "undefined" && raw instanceof ReadableStream)
  ) {
    throw new Error(
      "binary request body (media) is not supported over the chat4000 WS gateway yet — " +
        "native mxc media transport requires gateway binary support (C4)",
    );
  }
  return undefined;
}

/**
 * Deterministic-enough jitter without Math.random (blocked in some runtimes):
 * derive a [0,1) fraction from the current high-res time. Jitter only needs to
 * de-correlate reconnect storms, not be cryptographic.
 */
function fractionalJitter(): number {
  const ns = Number(process.hrtime.bigint() % 1000n);
  return ns / 1000;
}
