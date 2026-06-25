/**
 * Matrix client lifecycle for one chat4000 account.
 *
 * Wraps matrix-js-sdk: builds the client from persisted credentials, brings up
 * Rust E2E crypto (PROTOCOL: all session content is end-to-end encrypted — if
 * crypto can't initialize, the channel does not start), runs the sync loop, and
 * surfaces decrypted room messages + connection state to the channel layer.
 *
 * The plugin uses the Matrix client-server API directly against the homeserver;
 * the WS Gateway (PROTOCOL section 4) is for end-user devices, not required here.
 *
 * Reference: /tmp/openclaw/extensions/matrix/src/matrix/{client,sdk}.ts.
 */
import path from "node:path";
// fake-indexeddb/auto installs an in-memory IndexedDB into global scope so the
// Rust crypto WASM store has somewhere to live under Node.
// NOTE(persistence): in-memory only; durable crypto-store snapshotting to
// state/<account>/crypto is a follow-up (see reference idb-persistence.ts).
import "fake-indexeddb/auto";
import {
  ClientEvent,
  createClient,
  type MatrixClient,
  type MatrixEvent,
  MatrixEventEvent,
  RoomEvent,
  SyncState,
} from "matrix-js-sdk";
import {
  type MSC3575List,
  type MSC3575RoomSubscription,
  SlidingSync,
} from "matrix-js-sdk/lib/sliding-sync.js";
import { readPackageName, readPackageVersion } from "../package-info.js";
import { report } from "../telemetry.js";
import { pluginPlatform } from "../pairing/version-check.js";
import { ensureDir, resolveChat4000AccountStateDir } from "../paths.js";
import { GatewayTransport, gatewayToBaseUrl } from "./gateway-transport.js";
import {
  IDB_PERSIST_INTERVAL_MS,
  persistIdbToDisk,
  restoreIdbFromDisk,
} from "./idb-persistence.js";
import { sendText } from "./send.js";
import { ensurePluginRooms, type PluginRooms } from "./space.js";
import {
  decodeCommandEvent,
  decodeInboundEvent,
  type MatrixInboundCommand,
  ROOM_KIND_STATE_EVENT,
} from "./inbound.js";
import type { MatrixConnectionState, MatrixCredentials, MatrixInboundMessage } from "./types.js";

const INITIAL_SYNC_TIMEOUT_MS = 60_000;

/** Read the `kind` field off a `chat4000.room_kind` state-event content. */
function readRoomKind(content: unknown): string | undefined {
  if (content && typeof content === "object") {
    const kind = (content as { kind?: unknown }).kind;
    if (typeof kind === "string") return kind;
  }
  return undefined;
}

export type MatrixClientHandleOptions = {
  accountId: string;
  credentials: MatrixCredentials;
  /** Release channel for the gateway auth identity (PROTOCOL D.1). */
  releaseChannel?: string | undefined;
  initialSyncLimit?: number | undefined;
  abortSignal?: AbortSignal | undefined;
  onConnectionState?: ((state: MatrixConnectionState) => void) | undefined;
  onMessage?: ((message: MatrixInboundMessage) => void) | undefined;
  /** chat4000.command control events (PROTOCOL section 5). */
  onCommand?: ((command: MatrixInboundCommand) => void) | undefined;
  log?:
    | {
        info?: (msg: string) => void;
        warn?: (msg: string) => void;
        error?: (msg: string) => void;
        debug?: (msg: string) => void;
      }
    | undefined;
};

/**
 * Live handle around a started Matrix client. `start()` resolves once the
 * initial sync completes; `stop()` tears the client down.
 */
/**
 * Sliding-sync `required_state` for a plugin bot.
 *
 * Membership is LAZY in sliding sync: the `[["*","*"]]` wildcard does NOT expand
 * to `m.room.member` (or, on the Tuwunel fork, `m.room.encryption`) — the server
 * only returns membership when asked with the explicit `$LAZY` sentinel. Without
 * it the SDK's `Room.currentState` never learns the room's members or that it is
 * encrypted, so `getEncryptionTargetMembers()` resolves to `[]` and the agent
 * Megolm-encrypts every reply for nobody → permanent UTD on the user's device.
 *
 * So we enumerate exactly the state we depend on, matching the working Hermes
 * plugin's builder (chat4000-hermes-plugin `sliding_sync.build_sync_request`)
 * against the same homeserver. `$LAZY` is sufficient: the agent only replies
 * after the user sends, so the user is always in the lazy membership snapshot.
 */
const REQUIRED_STATE: string[][] = [
  ["m.room.encryption", ""],
  ["m.room.member", "$LAZY"],
  ["chat4000.room_kind", ""],
  ["m.room.name", ""],
  ["m.space.child", "*"],
];
const SLIDING_TIMELINE_LIMIT = 30;
/** How long to wait for a room key before surfacing a message as undecryptable. */
const UTD_SURFACE_MS = 30_000;

/**
 * History horizon: how far BEFORE the client's construction instant a timeline
 * event may be and still be processed.
 *
 * The bug this replaces: the old gate dropped every event with
 * `getTs() < startedAtTs` (the construction instant). The user's very first
 * message is sent DURING the pair → startup window, so its origin-server ts
 * predates `startedAtTs` and was silently dropped; only the resend (clearly
 * after startup) was delivered. Encrypted events make this worse — an
 * `m.room.encrypted` event keeps its ORIGINAL send ts even when the room key
 * (hence a successful decrypt) only arrives after startup, so a strictly
 * "newer than startup" gate can discard a message that only becomes readable
 * later.
 *
 * We cannot simply remove the gate: sliding sync's `timeline_limit`
 * (SLIDING_TIMELINE_LIMIT = 30) re-emits up to 30 historical timeline events
 * per room through `RoomEvent.Timeline` on every (re)sync, and the old ts gate
 * was the ONLY thing stopping that backlog from being reprocessed on every
 * (re)start. So we keep a horizon — but a GENEROUS one that comfortably covers
 * a realistic pair → first-message window — and pair it with an in-process
 * delivered-id de-dup so an event straddling the horizon (or re-emitted within
 * it) is processed EXACTLY ONCE, never dropped purely for being slightly older
 * than construction.
 *
 * 10 minutes: far longer than any plausible pair → first-message gap (seconds
 * to a couple of minutes observed), short enough that a fresh start never
 * replays genuinely old room backlog. The de-dup set makes the window safe.
 */
const HISTORY_HORIZON_MS = 10 * 60 * 1000;

/**
 * Decide whether a timeline event should be processed now, applying (1) a
 * delivered-id de-dup so each event is processed at most once, and (2) a
 * history horizon so a (re)sync's replayed backlog is not reprocessed.
 *
 * Pure and side-effect free EXCEPT that, when it returns `true`, it records the
 * event id in `delivered` so a later re-emit of the same event (same id) is
 * skipped. Extracted from the timeline handler so the gating logic is unit
 * testable without constructing a full MatrixClientHandle.
 *
 * @param eventId  `event.getId()` — may be undefined for malformed events.
 * @param ts       `event.getTs()` — the origin-server timestamp.
 * @param horizonStart  the oldest ts still eligible (`startedAtTs - HORIZON`).
 * @param delivered  in-memory set of event ids already admitted for processing.
 */
export function shouldProcessTimelineEvent(
  eventId: string | undefined,
  ts: number,
  horizonStart: number,
  delivered: Set<string>,
): boolean {
  // Without an id we cannot de-dup; an event with no id is not a real,
  // first-class message we deliver to the agent, so skip it.
  if (!eventId) return false;
  // Already admitted once (e.g. a (re)sync re-emitted the same event) — never
  // process the same id twice.
  if (delivered.has(eventId)) return false;
  // Older than the horizon: replayed backlog from a (re)sync, not a message we
  // owe the agent. Drop it WITHOUT marking it delivered (the set is reserved
  // for things we actually admit, keeping it bounded to live traffic).
  if (ts < horizonStart) return false;
  delivered.add(eventId);
  return true;
}

export class MatrixClientHandle {
  readonly client: MatrixClient;

  private readonly transport: GatewayTransport;

  private readonly slidingSync: SlidingSync;

  private readonly cryptoSnapshotPath: string;

  private readonly cryptoDatabasePrefix: string;

  private persistTimer: ReturnType<typeof setInterval> | undefined;

  private pluginRooms: PluginRooms | undefined;

  private started = false;

  private readonly opts: MatrixClientHandleOptions;

  private readonly startedAtTs = Date.now();

  /**
   * Event ids already admitted into processing this process lifetime. Backs the
   * de-dup half of the timeline gate (see `shouldProcessTimelineEvent`): paired
   * with the history horizon it lets a message straddling startup be delivered
   * exactly once, while a (re)sync's replayed timeline does not reprocess it.
   *
   * In-memory ON PURPOSE: across a process restart it is empty. Reprocessing is
   * then bounded by (a) the durable sliding-sync cursor (`sync-pos.txt`), which
   * resumes sync from where we left off, and (b) HISTORY_HORIZON_MS, which drops
   * any replayed timeline event older than 10 minutes. The narrow window this
   * leaves — an event inside the last `timeline_limit` AND newer than the
   * horizon AND not yet acked at the previous shutdown — could be re-delivered
   * once after a restart; that is the deliberate, bounded tradeoff for never
   * dropping a real pre-startup message, and it is no worse than the prior
   * behavior for any event newer than the old `startedAtTs` cutoff.
   */
  private readonly deliveredEventIds = new Set<string>();

  private constructor(
    client: MatrixClient,
    transport: GatewayTransport,
    slidingSync: SlidingSync,
    cryptoSnapshotPath: string,
    cryptoDatabasePrefix: string,
    opts: MatrixClientHandleOptions,
  ) {
    this.client = client;
    this.transport = transport;
    this.slidingSync = slidingSync;
    this.cryptoSnapshotPath = cryptoSnapshotPath;
    this.cryptoDatabasePrefix = cryptoDatabasePrefix;
    this.opts = opts;
  }

  static async create(opts: MatrixClientHandleOptions): Promise<MatrixClientHandle> {
    const { credentials } = opts;
    const stateDir = ensureDir(resolveChat4000AccountStateDir(opts.accountId));
    const cryptoSnapshotPath = path.join(stateDir, "crypto-idb-snapshot.json");
    // Per-account IndexedDB name so multiple accounts in one process don't share
    // a crypto store (and so the snapshot can be filtered to just this account).
    const cryptoDatabasePrefix = `chat4000-${opts.accountId}`;

    // C2: restore the persisted crypto store BEFORE the SDK opens IndexedDB, so
    // the bot keeps its device identity/keys across restarts. Fail-open: a bad
    // snapshot is ignored and the bot starts fresh (re-keys).
    await restoreIdbFromDisk(cryptoSnapshotPath, (l) => opts.log?.debug?.(l));

    // The plugin reaches the homeserver ONLY through the WS gateway (PROTOCOL D).
    // Connect the pipe first; everything below tunnels over it.
    const transport = new GatewayTransport({
      gatewayUrl: credentials.gatewayUrl,
      accessToken: credentials.accessToken,
      clientIdentity: {
        appId: readPackageName(),
        clientVersion: readPackageVersion(),
        platform: pluginPlatform(),
        releaseChannel: opts.releaseChannel?.trim() || "dev",
      },
      // PROTOCOL D.2: durably persist the sync cursor and flush the crypto store
      // before acking a batch that carried room keys, so the gateway never lets
      // the homeserver delete to-device keys we haven't saved.
      posFilePath: path.join(stateDir, "sync-pos.txt"),
      flushBeforeAck: () =>
        persistIdbToDisk({
          snapshotPath: cryptoSnapshotPath,
          databasePrefix: cryptoDatabasePrefix,
          log: (l) => opts.log?.debug?.(l),
        }),
      log: opts.log,
    });
    await transport.connect();

    const baseUrl = gatewayToBaseUrl(credentials.gatewayUrl);
    const client = createClient({
      baseUrl,
      accessToken: credentials.accessToken,
      userId: credentials.userId,
      deviceId: credentials.deviceId,
      // Every C-S call (incl. all crypto key/to-device traffic) rides this pipe.
      fetchFn: transport.fetch,
    });

    // Redirect the SDK's sliding-sync network seam to the gateway's sync frames.
    // (`SlidingSync` calls `client.slidingSync(req, proxyBaseUrl, signal)` — see
    // matrix-js-sdk sliding-sync.ts — so this IS the request seam.)
    client.slidingSync = transport.slidingSyncRequest;

    // E2E is mandatory. initRustCrypto throwing here propagates and prevents the
    // channel from starting (no cleartext fallback). Crypto's own HTTP rides the
    // same fetchFn, so it works over the gateway with no extra wiring.
    await client.initRustCrypto({ cryptoDatabasePrefix });

    // C3: best-effort cross-signing bootstrap so the bot presents a stable,
    // self-trusted device identity (persisted via C2). Non-fatal: a fresh bot
    // still relays Megolm messages without it, and a homeserver may gate the
    // key upload behind UIA the bot can't satisfy — then we log and continue.
    try {
      const crypto = client.getCrypto();
      if (crypto && !(await crypto.isCrossSigningReady())) {
        await crypto.bootstrapCrossSigning({ setupNewCrossSigning: true });
        opts.log?.info?.("chat4000: cross-signing identity bootstrapped");
        // Snapshot immediately so the new signing keys survive a crash before
        // the periodic persist runs.
        await persistIdbToDisk({
          snapshotPath: cryptoSnapshotPath,
          databasePrefix: cryptoDatabasePrefix,
          log: (l) => opts.log?.debug?.(l),
        });
      }
    } catch (err) {
      opts.log?.warn?.(`chat4000: cross-signing bootstrap skipped: ${String(err)}`);
    }

    const lists = new Map<string, MSC3575List>([
      [
        "chat4000",
        { ranges: [[0, 99]], required_state: REQUIRED_STATE, timeline_limit: SLIDING_TIMELINE_LIMIT },
      ],
    ]);
    const roomSubscription: MSC3575RoomSubscription = {
      required_state: REQUIRED_STATE,
      timeline_limit: SLIDING_TIMELINE_LIMIT,
    };
    const slidingSync = new SlidingSync(baseUrl, lists, roomSubscription, client, 30_000);

    return new MatrixClientHandle(
      client,
      transport,
      slidingSync,
      cryptoSnapshotPath,
      cryptoDatabasePrefix,
      opts,
    );
  }

  /** Ensure the plugin's space + control room exist (PROTOCOL E). Idempotent. */
  async ensureRooms(pluginName: string): Promise<PluginRooms> {
    this.pluginRooms = await ensurePluginRooms(this.client, {
      accountId: this.opts.accountId,
      pluginName,
    });
    return this.pluginRooms;
  }

  get spaceId(): string | undefined {
    return this.pluginRooms?.spaceId;
  }

  get controlRoomId(): string | undefined {
    return this.pluginRooms?.controlRoomId;
  }

  /** Snapshot the crypto store to disk (best-effort). */
  private persistCryptoStore(): Promise<void> {
    return persistIdbToDisk({
      snapshotPath: this.cryptoSnapshotPath,
      databasePrefix: this.cryptoDatabasePrefix,
      log: (l) => this.opts.log?.debug?.(l),
    });
  }

  /** Start sync; resolves on first successful sync (PREPARED/SYNCING). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.client.on(ClientEvent.Sync, (state: SyncState) => {
      switch (state) {
        case SyncState.Prepared:
        case SyncState.Syncing:
          this.opts.onConnectionState?.("connected");
          break;
        case SyncState.Reconnecting:
        case SyncState.Error:
          this.opts.onConnectionState?.("reconnecting");
          break;
        case SyncState.Stopped:
          this.opts.onConnectionState?.("disconnected");
          break;
        default:
          break;
      }
    });

    this.client.on(RoomEvent.Timeline, (event: MatrixEvent) => {
      this.handleTimelineEvent(event);
    });

    this.opts.onConnectionState?.("connecting");
    // Sliding sync drives room/event state from the gateway's `sync` frames;
    // `initialSyncLimit` does not apply (the list's timeline_limit governs it).
    try {
      await this.client.startClient({ slidingSync: this.slidingSync });
      await this.waitForInitialSync(INITIAL_SYNC_TIMEOUT_MS);
    } catch (err) {
      this.started = false;
      this.opts.onConnectionState?.("disconnected");
      this.client.stopClient();
      throw err;
    }

    // C2: periodically snapshot the crypto store so a restart keeps our keys.
    this.persistTimer = setInterval(() => {
      this.persistCryptoStore().catch((err: unknown) => report(err, "matrix.persistCryptoStore"));
    }, IDB_PERSIST_INTERVAL_MS);
    this.persistTimer.unref?.();

    if (this.opts.abortSignal) {
      this.opts.abortSignal.addEventListener(
        "abort",
        () => {
          this.stop().catch((err: unknown) => report(err, "matrix.stop"));
        },
        { once: true },
      );
    }
  }

  private waitForInitialSync(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        this.client.off(ClientEvent.Sync, onSync);
        this.opts.abortSignal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onAbort = (): void => {
        settle(() => reject(new Error("Matrix initial sync aborted")));
      };
      const onSync = (state: SyncState): void => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          settle(resolve);
          return;
        }
        if (state === SyncState.Error || state === SyncState.Stopped) {
          settle(() => reject(new Error(`Matrix initial sync failed: ${state}`)));
        }
      };
      const timer = setTimeout(() => {
        settle(() => reject(new Error(`Matrix initial sync timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      timer.unref?.();
      if (this.opts.abortSignal?.aborted) {
        onAbort();
        return;
      }
      this.opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
      this.client.on(ClientEvent.Sync, onSync);
    });
  }

  private handleTimelineEvent(event: MatrixEvent): void {
    // Ignore our own echoes.
    if (event.getSender() === this.opts.credentials.userId) return;
    // Gate on a generous history horizon + a delivered-id de-dup instead of a
    // hard "newer than startup" cutoff. The old cutoff silently dropped the
    // user's first message when it was sent during the pair → startup window
    // (its origin-server ts predated construction), and dropped any encrypted
    // message that only became readable after a late key arrival (the wire ts
    // stays the original send time). The horizon still prevents a (re)sync's
    // replayed `timeline_limit` backlog from being reprocessed; the de-dup set
    // guarantees exactly-once even for an event straddling the horizon.
    if (
      !shouldProcessTimelineEvent(
        event.getId(),
        event.getTs(),
        this.startedAtTs - HISTORY_HORIZON_MS,
        this.deliveredEventIds,
      )
    )
      return;

    const deliver = (): void => {
      const command = decodeCommandEvent(event);
      if (command) {
        // PROTOCOL E (normative): a chat4000.command is honored ONLY in the
        // plugin's control room. A command in a session room — or any other
        // room the plugin shares — is ignored entirely (no action, no reply),
        // so sharing a room with the bot does not let anyone drive it.
        if (this.isControlRoom(command.roomId)) this.opts.onCommand?.(command);
        return;
      }
      const decoded = decodeInboundEvent(event);
      if (decoded) this.opts.onMessage?.(decoded);
    };

    // Encrypted events arrive as ciphertext (`m.room.encrypted`) and decrypt
    // ASYNCHRONOUSLY — often only AFTER the room key shows up in a later
    // to-device message, at which point matrix-js-sdk re-decrypts and re-emits
    // `Decrypted`. getType() stays `m.room.encrypted` until a decrypt succeeds.
    // Wait for a SUCCESSFUL decryption in every not-yet-clear case (being
    // decrypted, failed/UTD, or not started) — the previous check only waited
    // while a decrypt was mid-flight, so a message whose key arrived a beat
    // later was delivered as ciphertext, dropped by decode, and lost forever.
    if (event.isEncrypted() && !event.getClearContent()) {
      // Surface a message that stays undecryptable past the window so an
      // "Unable to Decrypt" is never invisible (mirrors hermes' UTD log). The
      // Decrypted listener below stays armed, so a key that lands even later
      // still recovers the message — we report better than hermes (it skips),
      // and now shout as loudly as hermes does.
      const utdTimer = setTimeout(() => {
        if (!event.getClearContent()) this.reportUndecryptable(event);
      }, UTD_SURFACE_MS);
      utdTimer.unref?.();
      const onDecrypted = (): void => {
        // A failed attempt (key not here yet) keeps the listener armed for the
        // retry matrix-js-sdk runs when the room key finally arrives.
        if (event.isDecryptionFailure()) return;
        event.off(MatrixEventEvent.Decrypted, onDecrypted);
        clearTimeout(utdTimer);
        deliver();
      };
      event.on(MatrixEventEvent.Decrypted, onDecrypted);
      return;
    }
    deliver();
  }

  /**
   * Surface an "Unable to Decrypt": the room key never arrived within the
   * window, so the message can't be processed. Logged locally with the Megolm
   * session id + sender (to correlate against the sender's key-share), and
   * reported once to the sink (rate-limited there by error fingerprint).
   */
  private reportUndecryptable(event: MatrixEvent): void {
    const content = event.getWireContent() as Record<string, unknown>;
    const sessionId = typeof content.session_id === "string" ? content.session_id : "unknown";
    const detail = `room=${event.getRoomId() ?? "?"} megolm_session_id=${sessionId} sender=${event.getSender() ?? "?"}`;
    this.opts.log?.warn?.(
      `chat4000: UTD — message still undecryptable after ${UTD_SURFACE_MS}ms (${detail})`,
    );
    report(new Error("matrix UTD: message undecryptable (room key missing)"), `matrix.utd ${detail}`);
  }

  /**
   * Whether `roomId` is the plugin's control room, per its `chat4000.room_kind`
   * state (state_key ""). Authoritative identification is the state event, not
   * the room name (PROTOCOL E). A room with no tag is treated as a session room.
   */
  private isControlRoom(roomId: string): boolean {
    const room = this.client.getRoom(roomId);
    const stateEvent = room?.currentState.getStateEvents(ROOM_KIND_STATE_EVENT, "");
    if (!stateEvent) return false;
    return readRoomKind(stateEvent.getContent()) === "control";
  }

  /** Best-effort: post a plain notice into the control room, if one exists. */
  async postNoticeToControlRoom(text: string): Promise<void> {
    try {
      const roomId = this.findControlRoomId();
      if (!roomId) return;
      await sendText(this.client, roomId, text);
    } catch (err) {
      this.opts.log?.debug?.(`control-room notice failed: ${String(err)}`);
    }
  }

  private findControlRoomId(): string | undefined {
    for (const room of this.client.getRooms()) {
      const stateEvent = room.currentState.getStateEvents(ROOM_KIND_STATE_EVENT, "");
      if (stateEvent && readRoomKind(stateEvent.getContent()) === "control") {
        return room.roomId;
      }
    }
    return undefined;
  }

  /** Mark a room read up to the given event (PROTOCOL: m.read.private receipt). */
  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    try {
      const room = this.client.getRoom(roomId);
      const event = room?.findEventById(eventId);
      if (!event) return;
      await this.client.sendReadReceipt(event);
    } catch (err) {
      this.opts.log?.debug?.(`read receipt failed: ${String(err)}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = undefined;
    }
    // Final crypto snapshot so the latest keys/sessions survive this shutdown.
    await this.persistCryptoStore();
    try {
      this.client.stopClient();
    } catch (err) {
      // Shutdown is best-effort, but an unexpected stop failure still goes to the sink.
      report(err, "matrix.stopClient");
    }
    this.transport.dispose();
    this.opts.onConnectionState?.("disconnected");
  }
}
