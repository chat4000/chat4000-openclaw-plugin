/**
 * chat4000 Channel Plugin for OpenClaw (v2 — Matrix).
 *
 * Routes messages between an OpenClaw agent and chat4000 iOS/macOS apps over a
 * Matrix homeserver (Tuwunel). The plugin runs as a Matrix bot participant:
 *
 *   - `gateway.startAccount` brings up a `MatrixClientHandle` (sync + E2E crypto)
 *     and dispatches inbound room messages to the agent.
 *   - Replies stream back as a single Matrix message that refines itself via
 *     `m.replace` edits (`MatrixDraftStream`), settling to a final edit.
 *   - `outbound` sends agent-initiated text into the bound room.
 *
 * The agent-dispatch pipeline (route → record → reply pipeline) is unchanged
 * from v1; only the transport sink moved from the custom relay to Matrix.
 */
import {
  getDefaultChat4000AccountId,
  hasConfiguredState,
  listChat4000AccountIds,
  resolveChat4000Account,
} from "./accounts.js";
import { getHandle, registerHandle, unregisterHandle } from "./channel-runtime.js";
import { MatrixClientHandle } from "./matrix/client.js";
import type { MatrixInboundCommand } from "./matrix/inbound.js";
import {
  editToolEnd,
  sendAgentStatus,
  sendCommandResult,
  sendText as matrixSendText,
  sendToolStart,
  sendTyping,
} from "./matrix/send.js";
import { MatrixDraftStream } from "./matrix/streaming.js";
import type { MatrixInboundMessage } from "./matrix/types.js";
import { type CommandResult, handleControlCommand } from "./commands.js";
import { downloadInboundMediaBuffer, roomIsEncrypted, sendMediaMessage } from "./matrix/media.js";
import { archiveRoom, createSessionRoom, renameRoom } from "./matrix/space.js";
import { readPackageVersion } from "./package-info.js";
import { RegistrarClient } from "./pairing/registrar.js";
import { checkPluginVersion, formatVersionNotice } from "./pairing/version-check.js";
import { RuntimeLogger } from "./runtime-logger.js";
import { applyUpdate } from "./update/apply.js";
import { reconcileUpdateMarker } from "./update/boot-guard.js";
import { getChat4000SessionBinding } from "./session-binding.js";
import { report } from "./telemetry.js";
import type { ResolvedChat4000Account } from "./types.js";

type ReplyPipelineRuntime = {
  createChannelReplyPipeline: (params: {
    cfg: unknown;
    agentId: string;
    channel?: string;
    accountId?: string;
    typing?: {
      start: () => Promise<void> | void;
      onStartError?: (err: unknown) => void;
    };
  }) => { typingCallbacks?: unknown };
};

let replyPipelinePromise: Promise<ReplyPipelineRuntime> | undefined;

async function loadReplyPipelineRuntime(): Promise<ReplyPipelineRuntime> {
  replyPipelinePromise ??= import("openclaw/plugin-sdk/channel-reply-pipeline").then((mod) => ({
    createChannelReplyPipeline: mod.createChannelReplyPipeline,
  }));
  return await replyPipelinePromise;
}

// ─── Channel plugin definition ──────────────────────────────────────────────

export const chat4000Plugin = {
  id: "chat4000" as const,

  meta: {
    id: "chat4000",
    label: "chat4000",
    selectionLabel: "chat4000 (iOS/macOS app)",
    docsPath: "/channels/chat4000",
    markdownCapable: true,
    capabilities: {
      chatTypes: ["direct" as const],
      media: true,
      reactions: true,
      edit: true,
      unsend: true,
      reply: true,
      effects: true,
      blockStreaming: false,
    },
    reload: {
      configPrefixes: ["channels.chat4000"],
    },
  },

  // ─── Config ─────────────────────────────────────────────────────────────

  config: {
    hasConfiguredState: ({ env }: { env?: Record<string, string> }): boolean =>
      hasConfiguredState(env),

    listAccountIds: (cfg?: { channels?: Record<string, unknown> }): string[] =>
      listChat4000AccountIds(cfg),

    defaultAccountId: (cfg?: { channels?: Record<string, unknown> }): string =>
      getDefaultChat4000AccountId(cfg),

    isConfigured: (account: ResolvedChat4000Account): boolean => account.configured,

    resolveAccount: (
      cfg?: { channels?: Record<string, unknown> },
      accountId?: string | null,
    ): ResolvedChat4000Account => resolveChat4000Account({ cfg, accountId }),

    inspectAccount: (
      cfg?: { channels?: Record<string, unknown> },
      accountId?: string | null,
    ): {
      accountId: string;
      enabled: boolean;
      configured: boolean;
      userId: string;
      gateway: string;
      credentialStatus: string;
    } => {
      const account = resolveChat4000Account({ cfg, accountId });
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        userId: account.userId || "(missing)",
        gateway: account.gatewayUrl || "(missing)",
        credentialStatus: account.configured
          ? `available (${account.credentialSource})`
          : "missing",
      };
    },

    describeAccount: (
      account: ResolvedChat4000Account,
    ): {
      name: string;
      configured: boolean;
      enabled: boolean;
      extra: { gateway: string; userId: string };
    } => ({
      name: account.userId ? `chat4000 (${account.userId})` : "chat4000",
      configured: account.configured,
      enabled: account.enabled,
      extra: { gateway: account.gatewayUrl, userId: account.userId },
    }),
  },

  // ─── Gateway (Matrix client lifecycle + agent dispatch) ─────────────────

  gateway: {
    startAccount: async (ctx: {
      cfg: { channels?: Record<string, unknown> };
      accountId: string;
      account: ResolvedChat4000Account;
      channelRuntime?: unknown;
      abortSignal: AbortSignal;
      setStatus: (next: unknown) => void;
      log?: {
        info?: (msg: string) => void;
        warn?: (msg: string) => void;
        error?: (msg: string) => void;
        debug?: (msg: string) => void;
      };
    }): Promise<void> => {
      if (!ctx.account.configured) {
        throw new Error(
          `chat4000 not configured for account "${ctx.account.accountId}". ` +
            `Run "openclaw chat4000 setup" to provision a Matrix identity and pair.`,
        );
      }

      ctx.log?.info?.(`[${ctx.account.accountId}] Starting chat4000 (Matrix) channel`);
      const runtimeLogger = new RuntimeLogger(ctx.account.runtimeLogLevel, {
        accountId: ctx.account.accountId,
        groupId: ctx.account.userId,
      });

      // C5: guard a just-applied self-update. If the new version keeps failing to
      // confirm healthy across boots, reinstall the previous one and restart.
      const bootGuard = reconcileUpdateMarker({
        currentVersion: readPackageVersion(),
        log: (l) => ctx.log?.warn?.(l),
      });
      if (bootGuard.action === "rollback" && bootGuard.rollbackToVersion) {
        ctx.log?.error?.(
          `[${ctx.account.accountId}] update failed its health check — rolling back to ${bootGuard.rollbackToVersion}`,
        );
        await applyUpdate({
          targetVersion: bootGuard.rollbackToVersion,
          force: true,
          restart: true,
          log: (l) => ctx.log?.info?.(l),
        });
        return; // a restart into the previous version is scheduled; abort this boot
      }

      const setConnected = (connected: boolean): void =>
        ctx.setStatus({
          accountId: ctx.account.accountId,
          name: `chat4000 (${ctx.account.userId})`,
          enabled: true,
          configured: true,
          extra: { connected, gateway: ctx.account.gatewayUrl },
        });

      // PROTOCOL C.5: version policy on boot. Advisory + fail-open; a force
      // verdict blocks message relay (but plugin.update commands still flow so
      // the owner can fix it from the control room).
      let versionBlock: string | null = null;
      if (ctx.account.provisioning.url) {
        try {
          const verdict = await checkPluginVersion({
            registrar: new RegistrarClient({
              baseUrl: ctx.account.provisioning.url,
              serviceToken: ctx.account.provisioning.serviceToken ?? "",
            }),
            releaseChannel: ctx.account.config.releaseChannel,
          });
          const notice = formatVersionNotice(verdict);
          if (notice) {
            if (verdict.action === "force_upgrade") ctx.log?.error?.(notice);
            else ctx.log?.warn?.(notice);
            runtimeLogger.info("runtime.version_policy", { action: verdict.action });
          }
          if (verdict.action === "force_upgrade") versionBlock = notice;
        } catch {
          // advisory only — never block boot on a check failure
        }
      }

      const handle = await MatrixClientHandle.create({
        accountId: ctx.account.accountId,
        credentials: {
          gatewayUrl: ctx.account.gatewayUrl,
          userId: ctx.account.userId,
          accessToken: ctx.account.accessToken,
          deviceId: ctx.account.deviceId,
          pluginId: ctx.account.pluginId,
        },
        releaseChannel: ctx.account.config.releaseChannel,
        initialSyncLimit: ctx.account.config.initialSyncLimit,
        abortSignal: ctx.abortSignal,
        log: ctx.log,
        onConnectionState: (state) => {
          if (state === "connected") {
            ctx.log?.info?.(`[${ctx.account.accountId}] Connected via ${ctx.account.gatewayUrl}`);
            runtimeLogger.info("runtime.hello_ok", { gateway: ctx.account.gatewayUrl });
            // A healthy sync confirms a just-applied update; clears the boot marker.
            bootGuard.confirmHealthy();
            setConnected(true);
          } else if (state === "reconnecting") {
            ctx.log?.info?.(`[${ctx.account.accountId}] Reconnecting...`);
            setConnected(false);
          } else if (state === "disconnected") {
            setConnected(false);
          } else if (typeof state === "object" && state.kind === "failed") {
            ctx.log?.error?.(`[${ctx.account.accountId}] Matrix failed: ${state.reason}`);
            setConnected(false);
          }
        },
        onMessage: (message) => {
          handleInbound({ message, handle, ctx, runtimeLogger, versionBlock }).catch(
            (err: unknown) => report(err, "channel.handleInbound"),
          );
        },
        onCommand: (command) => {
          handleCommand({ command, handle, ctx, runtimeLogger }).catch((err: unknown) =>
            report(err, "channel.handleCommand"),
          );
        },
      });

      registerHandle(ctx.account.accountId, handle);
      await handle.start();

      // PROTOCOL C.5: a force_upgrade is reported to the HOST/supervisor (logs +
      // refuse-to-relay), NOT via Matrix or a control room — a fresh plugin has
      // neither. The error was already logged in the boot check above; inbound
      // relay stays blocked (handleInbound) until the operator updates.

      // PROTOCOL E: ensure the plugin's space + single control room exist (skip
      // in degraded/no-relay mode). Idempotent across restarts.
      if (!versionBlock) {
        try {
          await handle.ensureRooms("chat4000");
          runtimeLogger.info("runtime.rooms_ready", {
            space: handle.spaceId,
            control: handle.controlRoomId,
          });
        } catch (err) {
          ctx.log?.warn?.(
            `[${ctx.account.accountId}] could not ensure plugin rooms: ${String(err)}`,
          );
        }
      }

      // Keep the channel alive for OpenClaw's lifecycle bookkeeping until abort.
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      await handle.stop();
      unregisterHandle(ctx.account.accountId);
    },
  },

  // ─── Outbound (agent → Matrix room) ─────────────────────────────────────

  outbound: {
    base: {
      deliveryMode: "direct" as const,
      textChunkLimit: 4096,
      sanitizeText: ({ text }: { text: string }): string => text,
    },
    attachedResults: {
      channel: "chat4000" as const,
      sendText: async (ctx: {
        cfg: { channels?: Record<string, unknown> };
        to: string;
        text: string;
        accountId?: string;
      }): Promise<{ messageId: string }> => {
        const account = resolveChat4000Account({ cfg: ctx.cfg, accountId: ctx.accountId });
        const handle = getHandle(account.accountId);
        if (!handle) {
          throw new Error(`No active Matrix connection for account "${account.accountId}"`);
        }
        const roomId = stripTargetPrefix(ctx.to);
        const messageId = await matrixSendText(handle.client, roomId, ctx.text);
        return { messageId };
      },
      sendMedia: async (ctx: {
        cfg: { channels?: Record<string, unknown> };
        to: string;
        text: string;
        mediaUrl?: string;
        accountId?: string;
      }): Promise<{ messageId: string }> => {
        const account = resolveChat4000Account({ cfg: ctx.cfg, accountId: ctx.accountId });
        const handle = getHandle(account.accountId);
        if (!handle) {
          throw new Error(`No active Matrix connection for account "${account.accountId}"`);
        }
        const roomId = stripTargetPrefix(ctx.to);
        if (!ctx.mediaUrl) {
          const messageId = await matrixSendText(handle.client, roomId, ctx.text);
          return { messageId };
        }
        // PROTOCOL D.3: fetch the bytes, encrypt (E2EE rooms), upload over the
        // HTTP media path, and send a native m.image/m.audio. Fall back to a link
        // if the upload fails so the message still goes out.
        try {
          const res = await globalThis.fetch(ctx.mediaUrl);
          if (!res.ok) throw new Error(`fetch media ${res.status}`);
          const mimeType =
            res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
          const bytes = new Uint8Array(await res.arrayBuffer());
          const filename = ctx.mediaUrl.split("/").pop()?.split("?")[0] || "attachment";
          if (ctx.text?.trim()) await matrixSendText(handle.client, roomId, ctx.text);
          const encrypted = await roomIsEncrypted(handle.client, roomId);
          const messageId = await sendMediaMessage(handle.client, roomId, {
            bytes,
            mimeType,
            filename,
            encrypted,
          });
          return { messageId };
        } catch {
          const messageId = await matrixSendText(
            handle.client,
            roomId,
            `${ctx.text}\n\nAttachment: ${ctx.mediaUrl}`,
          );
          return { messageId };
        }
      },
    },
  },
};

function stripTargetPrefix(to: string): string {
  // Accept "chat4000:!room:hs", "room:!room:hs", or a bare room id.
  return to.replace(/^chat4000:/i, "").replace(/^room:/i, "");
}

// ─── Inbound dispatch ───────────────────────────────────────────────────────

type InboundCtx = {
  cfg: { channels?: Record<string, unknown> };
  accountId: string;
  account: ResolvedChat4000Account;
  channelRuntime?: unknown;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
};

async function handleCommand(params: {
  command: MatrixInboundCommand;
  handle: MatrixClientHandle;
  ctx: InboundCtx;
  runtimeLogger: RuntimeLogger;
}): Promise<void> {
  const { command, handle, runtimeLogger } = params;
  runtimeLogger.info("runtime.command_recv", {
    msg_id: command.eventId,
    command: command.command,
    sender: command.senderId,
  });
  const result = command.command.startsWith("session.")
    ? await handleSessionCommand(command, handle)
    : await handleControlCommand(
        { command: command.command, args: command.args, senderId: command.senderId },
        {
          log: (line) => runtimeLogger.info("runtime.command_log", { detail: line }),
        },
      );
  try {
    await sendCommandResult(handle.client, command.roomId, result);
  } catch (err) {
    runtimeLogger.info("runtime.command_reply_error", {
      msg_id: command.eventId,
      error: String(err),
    });
  }
  runtimeLogger.info("runtime.command_done", {
    msg_id: command.eventId,
    command: command.command,
    ok: result.ok,
  });
}

/**
 * PROTOCOL E session commands (session.new/rename/archive). Only the plugin
 * creates sessions; the device asks via the control room. Runs against the live
 * client (which holds the space id), so it lives here rather than in commands.ts.
 */
async function handleSessionCommand(
  command: MatrixInboundCommand,
  handle: MatrixClientHandle,
): Promise<CommandResult> {
  const spaceId = handle.spaceId;
  if (!spaceId) {
    return { command: command.command, ok: false, error: "plugin space not ready yet" };
  }
  try {
    switch (command.command) {
      case "session.new": {
        const title = typeof command.args.title === "string" ? command.args.title : undefined;
        const roomId = await createSessionRoom(handle.client, {
          spaceId,
          title,
          inviteUserId: command.senderId,
        });
        return { command: command.command, ok: true, data: { room_id: roomId } };
      }
      case "session.rename": {
        const roomId = typeof command.args.room_id === "string" ? command.args.room_id : "";
        const title = typeof command.args.title === "string" ? command.args.title : "";
        if (!roomId || !title) {
          return {
            command: command.command,
            ok: false,
            error: "session.rename needs room_id and title",
          };
        }
        await renameRoom(handle.client, roomId, title);
        return { command: command.command, ok: true, data: { room_id: roomId } };
      }
      case "session.archive": {
        const roomId = typeof command.args.room_id === "string" ? command.args.room_id : "";
        if (!roomId) {
          return { command: command.command, ok: false, error: "session.archive needs room_id" };
        }
        await archiveRoom(handle.client, spaceId, roomId);
        return { command: command.command, ok: true, data: { room_id: roomId } };
      }
      default:
        return { command: command.command, ok: false, error: "unknown command" };
    }
  } catch (err) {
    return { command: command.command, ok: false, error: String(err) };
  }
}

async function handleInbound(params: {
  message: MatrixInboundMessage;
  handle: MatrixClientHandle;
  ctx: InboundCtx;
  runtimeLogger: RuntimeLogger;
  versionBlock?: string | null;
}): Promise<void> {
  const { message, handle, ctx, runtimeLogger, versionBlock } = params;

  // Flow-B ack: send a read receipt as soon as we accept the message (text or
  // media), before the agent runs, so the delivered/read indicator lights up.
  handle
    .sendReadReceipt(message.roomId, message.eventId)
    .catch((err: unknown) => report(err, "channel.sendReadReceipt"));

  // PROTOCOL C.5: a force_upgrade plugin must NOT relay messages. Reply once with
  // the upgrade notice and stop. Commands flow through onCommand, not here, so the
  // owner can still run plugin.update to fix it.
  if (versionBlock) {
    runtimeLogger.info("runtime.version_blocked", { msg_id: message.eventId });
    try {
      await matrixSendText(handle.client, message.roomId, versionBlock);
    } catch {
      // best-effort notice
    }
    return;
  }

  if (!ctx.channelRuntime) {
    runtimeLogger.info("runtime.ai_request_error", {
      msg_id: message.eventId,
      error: "channelRuntime missing",
    });
    return;
  }

  // Resolve the agent's text body + (for media) download/decrypt and offload the
  // blob to the OpenClaw media store (PROTOCOL D.3 inbound).
  let bodyText: string;
  let media: { path: string; contentType?: string } | undefined;
  if (message.body.kind === "text") {
    bodyText = message.body.text;
  } else if (message.body.kind === "media") {
    bodyText = message.body.caption;
    media = await saveInboundMedia(handle, message.body, runtimeLogger);
  } else {
    return;
  }

  await dispatchToAgent({ message, bodyText, media, handle, ctx, runtimeLogger });
}

/**
 * Download + decrypt inbound media and offload it to the OpenClaw media store,
 * returning the local path the agent runner ingests via `MediaUrl`. Best-effort:
 * on any failure the agent still gets the text caption.
 */
async function saveInboundMedia(
  handle: MatrixClientHandle,
  body: { rawContent: Record<string, unknown> },
  runtimeLogger: RuntimeLogger,
): Promise<{ path: string; contentType?: string } | undefined> {
  try {
    const dl = await downloadInboundMediaBuffer(handle.client, body.rawContent);
    if (!dl) return undefined;
    const store = (await import("openclaw/plugin-sdk/media-store")) as unknown as {
      saveMediaBuffer: (
        buffer: Buffer,
        contentType?: string,
        subdir?: string,
        maxBytes?: number,
        filename?: string,
      ) => Promise<{ path: string; contentType?: string }>;
    };
    // maxBytes omitted → the store applies its own default cap.
    const saved = await store.saveMediaBuffer(
      dl.buffer,
      dl.contentType,
      "inbound",
      undefined,
      dl.filename,
    );
    return { path: saved.path, contentType: saved.contentType ?? dl.contentType };
  } catch (err) {
    runtimeLogger.info("runtime.media_download_error", { error: String(err) });
    return undefined;
  }
}

async function dispatchToAgent(params: {
  message: MatrixInboundMessage;
  bodyText: string;
  media?: { path: string; contentType?: string | undefined } | undefined;
  handle: MatrixClientHandle;
  ctx: InboundCtx;
  runtimeLogger: RuntimeLogger;
}): Promise<void> {
  const { message, bodyText, media, handle, ctx, runtimeLogger } = params;
  const roomId = message.roomId;

  const senderAddress = `chat4000:${roomId}`;
  const recipientAddress = "chat4000:agent";
  const conversationLabel = message.senderDisplayName
    ? `chat4000 (${message.senderDisplayName})`
    : `chat4000 (${roomId.substring(0, 12)}...)`;

  const runtime = ctx.channelRuntime as {
    routing: {
      resolveAgentRoute: (params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "direct"; id: string };
      }) => { agentId: string; sessionKey: string; accountId?: string };
    };
    session: {
      resolveStorePath: (store: string | undefined, opts: { agentId: string }) => string;
      readSessionUpdatedAt?: (params: {
        storePath: string;
        sessionKey: string;
      }) => number | undefined;
      recordInboundSession: (params: {
        storePath: string;
        sessionKey: string;
        ctx: Record<string, unknown>;
        onRecordError: (err: unknown) => void;
      }) => Promise<void>;
    };
    reply: {
      resolveEnvelopeFormatOptions: (cfg: unknown) => unknown;
      formatAgentEnvelope: (params: {
        channel: string;
        from: string;
        body: string;
        timestamp?: number | undefined;
        previousTimestamp?: number | undefined;
        envelope: unknown;
      }) => string;
      finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
      dispatchReplyWithBufferedBlockDispatcher: (params: {
        ctx: Record<string, unknown>;
        cfg: unknown;
        dispatcherOptions: Record<string, unknown>;
        replyOptions?: Record<string, unknown>;
      }) => Promise<unknown>;
    };
  };

  const route = runtime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "chat4000",
    accountId: ctx.account.accountId,
    peer: { kind: "direct", id: roomId },
  });
  const boundSession = getChat4000SessionBinding({
    accountId: ctx.account.accountId,
    groupId: roomId,
  });
  const targetSessionKey = boundSession?.targetSessionKey ?? route.sessionKey;
  const targetAgentId = boundSession?.agentId ?? route.agentId;
  const storePath =
    boundSession?.storePath ??
    runtime.session.resolveStorePath((ctx.cfg as { session?: { store?: string } }).session?.store, {
      agentId: targetAgentId,
    });

  const previousTimestamp = runtime.session.readSessionUpdatedAt?.({
    storePath,
    sessionKey: targetSessionKey,
  });

  const rawBody = bodyText;
  const body = runtime.reply.formatAgentEnvelope({
    channel: "chat4000",
    from: conversationLabel,
    body: rawBody,
    timestamp: message.ts,
    previousTimestamp,
    envelope: runtime.reply.resolveEnvelopeFormatOptions(ctx.cfg),
  });

  const ctxPayload = runtime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: senderAddress,
    To: recipientAddress,
    SessionKey: targetSessionKey,
    AccountId: route.accountId ?? ctx.account.accountId,
    ChatType: "direct",
    ConversationLabel: conversationLabel,
    SenderId: message.senderId,
    Provider: "chat4000",
    Surface: "chat4000",
    MessageSid: message.eventId,
    MessageSidFull: message.eventId,
    Timestamp: message.ts,
    Chat4000RoomId: roomId,
    Chat4000SenderId: message.senderId,
    OriginatingChannel: "chat4000",
    OriginatingTo: senderAddress,
    CommandAuthorized: true,
    // PROTOCOL D.3 inbound: the agent ingests media via MediaUrl (a local path
    // from the OpenClaw media store).
    ...(media ? { MediaPath: media.path, MediaType: media.contentType, MediaUrl: media.path } : {}),
  });

  const { createChannelReplyPipeline } = await loadReplyPipelineRuntime();

  const draft = new MatrixDraftStream({
    client: handle.client,
    roomId,
    log: (m) => runtimeLogger.debug("runtime.draft_stream", { msg_id: message.eventId, detail: m }),
  });

  let lastTyping: boolean | undefined;
  const setTyping = (on: boolean): void => {
    if (lastTyping === on) return;
    lastTyping = on;
    // Fire-and-forget; typing is best-effort, but route any failure to the sink.
    sendTyping(handle.client, roomId, on).catch((err: unknown) => report(err, "channel.setTyping"));
  };

  // PROTOCOL E: coarse agent-status label as a cleartext state event (deduped).
  let lastStatus: AgentStatus | undefined;
  const setStatus = (state: AgentStatus): void => {
    if (lastStatus === state) return;
    lastStatus = state;
    // Fire-and-forget; status is best-effort, but route any failure to the sink.
    sendAgentStatus(handle.client, roomId, state).catch((err: unknown) =>
      report(err, "channel.setStatus"),
    );
  };

  // PROTOCOL E: surface each tool invocation as ONE chat4000.tool event related
  // to the turn anchor. OpenClaw emits a universal `kind:"tool"` item PLUS
  // `kind:"command"/"patch"` sub-items for the SAME toolCallId (itemId is
  // "<kind>:<toolCallId>"), and the result text rides on those sub-items — so we
  // key by toolCallId, emit one event, and merge the result on each `end`.
  // (Verified against openclaw src/agents/embedded-agent-subscribe.handlers.tools.ts.)
  const tools = new Map<
    string,
    {
      eventId: string;
      startTs: number;
      name: string;
      args: string;
      status: ToolStatus;
      result: string;
    }
  >();
  const onToolItem = async (item: ItemEventPayload): Promise<void> => {
    if (
      item.kind !== "tool" &&
      item.kind !== "command" &&
      item.kind !== "exec" &&
      item.kind !== "patch"
    ) {
      return;
    }
    const tcid = toolCallIdOf(item.itemId);
    if (!tcid) return;
    try {
      let rec = tools.get(tcid);
      if (!rec) {
        const turnId = await draft.ensureAnchor();
        const name = (item.name || item.title || "tool").slice(0, 64);
        const args = (item.meta ?? "").slice(0, 2048);
        const eventId = await sendToolStart(handle.client, roomId, turnId, {
          tool_id: tcid,
          name,
          args,
          status: "running",
          result: "",
          duration_ms: 0,
        });
        rec = { eventId, startTs: Date.now(), name, args, status: "running", result: "" };
        tools.set(tcid, rec);
        setStatus("working");
      }
      // Result text rides on the command/patch sub-items — capture it as it arrives.
      const result = item.summary ?? item.progressText;
      if (result) rec.result = result.slice(0, 4096);
      if (item.phase === "end") {
        const st = mapToolStatus(item.status);
        if (st !== "running") rec.status = st;
        await editToolEnd(handle.client, roomId, rec.eventId, {
          tool_id: tcid,
          name: rec.name,
          args: rec.args,
          status: rec.status,
          result: rec.result,
          duration_ms: Date.now() - rec.startTs,
        });
      }
    } catch (err) {
      runtimeLogger.info("runtime.tool_event_error", { error: String(err) });
    }
  };

  runtimeLogger.info("runtime.ai_request_start", { msg_id: message.eventId });

  const replyPipeline = createChannelReplyPipeline({
    cfg: ctx.cfg,
    agentId: targetAgentId,
    channel: "chat4000",
    accountId: route.accountId ?? ctx.account.accountId,
    typing: {
      start: () => setTyping(true),
      onStartError: (err) => {
        runtimeLogger.info("runtime.ai_request_error", {
          msg_id: message.eventId,
          error: String(err),
          phase: "typing_start",
        });
      },
    },
  });

  await runtime.session.recordInboundSession({
    storePath,
    sessionKey: targetSessionKey,
    ctx: ctxPayload,
    onRecordError: (error: unknown) => {
      runtimeLogger.info("runtime.ai_request_error", {
        msg_id: message.eventId,
        error: String(error),
        phase: "record",
      });
      throw error instanceof Error
        ? error
        : new Error(`chat4000 session record failed: ${String(error)}`);
    },
  });

  await runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: ctx.cfg,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: async (payload: { text?: string }, info: { kind: string }) => {
        if (info.kind !== "final") return;
        const text = payload.text ?? "";
        if (text.trim().length > 0) {
          await draft.finalize(text);
        }
        draft.reset();
        setStatus("idle");
        setTyping(false);
      },
      onError: (error: unknown, info: { kind: string }) => {
        runtimeLogger.info("runtime.ai_request_error", {
          msg_id: message.eventId,
          error: String(error),
          phase: info.kind,
        });
        setStatus("idle");
        setTyping(false);
      },
    },
    replyOptions: {
      onReasoningStream: (): void => {
        setStatus("thinking");
        setTyping(true);
      },
      onAssistantMessageStart: (): void => {
        setStatus("typing");
        setTyping(true);
      },
      onPartialReply: (payload: { text?: string }): void => {
        const text = payload.text ?? "";
        if (!text) return;
        setStatus("typing");
        setTyping(true);
        draft.update(text);
      },
      onToolStart: (): void => {
        setStatus("working");
        setTyping(true);
      },
      onItemEvent: onToolItem,
    },
  });

  await draft.dispose();
  setStatus("idle");
  setTyping(false);
  runtimeLogger.info("runtime.ai_request_success", { msg_id: message.eventId });
}

type AgentStatus = "thinking" | "working" | "typing" | "idle";
type ToolStatus = "running" | "done" | "failed";

type ItemEventPayload = {
  itemId?: string;
  kind?: string;
  title?: string;
  name?: string;
  phase?: string;
  status?: string;
  summary?: string;
  progressText?: string;
  meta?: string;
};

/** OpenClaw item ids are "<kind>:<toolCallId>"; recover the toolCallId. */
function toolCallIdOf(itemId?: string): string | undefined {
  if (!itemId) return undefined;
  const i = itemId.indexOf(":");
  return i >= 0 ? itemId.slice(i + 1) : itemId;
}

/**
 * Map an OpenClaw item status onto the chat4000.tool status set. OpenClaw uses
 * `running` / `completed` / `failed` (and `blocked` for gated commands, which we
 * leave as running so the authoritative tool-end status wins).
 */
function mapToolStatus(status?: string): ToolStatus {
  const v = (status ?? "").toLowerCase();
  if (/fail|error|denied|reject|cancel/.test(v)) return "failed";
  if (/done|complete|success|finish|resolved/.test(v)) return "done";
  return "running";
}
