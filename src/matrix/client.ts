/**
 * Matrix client lifecycle for one chat4000 account.
 *
 * Wraps matrix-js-sdk: builds the client from persisted credentials, brings up
 * Rust E2E crypto (PROTOCOL: all session content is end-to-end encrypted — if
 * crypto can't initialize, the channel does not start), runs the sync loop, and
 * surfaces decrypted room messages + connection state to the channel layer.
 *
 * The plugin uses the Matrix client-server API directly against the homeserver;
 * the WS Gateway (PROTOCOL §4) is for end-user devices, not required here.
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
  type RoomMember,
  RoomEvent,
  type RoomState,
  RoomStateEvent,
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
  /** chat4000.command control events (PROTOCOL §5). */
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
/** Sliding-sync shape for a plugin bot: all state + a modest timeline tail. */
const ALL_STATE: string[][] = [["*", "*"]];
const SLIDING_TIMELINE_LIMIT = 30;
/** How long to wait for a room key before surfacing a message as undecryptable. */
const UTD_SURFACE_MS = 30_000;

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
    // (`client.slidingSync` takes a proxyBaseUrl precisely so it can be pointed
    // elsewhere; we replace the transport, not the sync logic.)
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
        { ranges: [[0, 99]], required_state: ALL_STATE, timeline_limit: SLIDING_TIMELINE_LIMIT },
      ],
    ]);
    const roomSubscription: MSC3575RoomSubscription = {
      required_state: ALL_STATE,
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

    // TEMP DIAGNOSTIC (UTD root-cause): prove whether m.room.member state for a
    // room ever arrives via sync at all. If this NEVER fires for the chatting
    // user in a session room, the gateway is dropping member events from the
    // sliding-sync frames (suspect F1); if it fires but the encryptor still sees
    // [] at send time, membership reaches the SDK but is masked/cleared. Remove
    // once root-caused.
    this.client.on(
      RoomStateEvent.Members,
      (_event: MatrixEvent, _state: RoomState, member: RoomMember) => {
        console.warn(
          `chat4000.diag.member-arrival room=${member.roomId} user=${member.userId} ` +
            `membership=${String(member.membership)}`,
        );
      },
    );

    this.opts.onConnectionState?.("connecting");
    // Sliding sync drives room/event state from the gateway's `sync` frames;
    // `initialSyncLimit` does not apply (the list's timeline_limit governs it).
    await this.client.startClient({ slidingSync: this.slidingSync });
    await this.waitForInitialSync();

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

  private waitForInitialSync(): Promise<void> {
    return new Promise<void>((resolve) => {
      const onSync = (state: SyncState): void => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) {
          this.client.off(ClientEvent.Sync, onSync);
          resolve();
        }
      };
      this.client.on(ClientEvent.Sync, onSync);
    });
  }

  private handleTimelineEvent(event: MatrixEvent): void {
    // Ignore our own echoes.
    if (event.getSender() === this.opts.credentials.userId) return;
    // Only act on live messages, not paginated history.
    if (event.getTs() < this.startedAtTs) return;

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
