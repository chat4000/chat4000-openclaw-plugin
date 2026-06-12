/**
 * Outbound Matrix sends: final agent messages and in-place edits.
 *
 * Streaming (PROTOCOL §5) is modeled as ONE message that updates itself via
 * `m.replace` edits, with the final edit carrying the full text. Text is
 * rendered to HTML via markdown-it.
 *
 * matrix-js-sdk's `sendEvent` content type is a strict generated union that's
 * awkward for dynamically-shaped content, so we build plain objects (always
 * with `body` + `msgtype`) and cast at the call boundary.
 */
import MarkdownIt from "markdown-it";
import { EventType, type MatrixClient, MsgType, RelationType } from "matrix-js-sdk";
import { markPush } from "./push-registry.js";
import { sendTimelineEvent } from "./sdk-boundary.js";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

type MatrixContent = Record<string, unknown>;

function renderTextContent(text: string): MatrixContent {
  const formatted = md.render(text).trim();
  const isPlain = formatted === `<p>${text}</p>` || formatted.length === 0;
  if (isPlain) {
    return { msgtype: MsgType.Text, body: text };
  }
  return {
    msgtype: MsgType.Text,
    body: text,
    format: "org.matrix.custom.html",
    formatted_body: formatted,
  };
}

/**
 * Send a brand-new text message. Returns the event id.
 *
 * `push` is the `chat4000.push` eligibility (PROTOCOL E): `true` for a completed,
 * user-meaningful result; `false` for a non-final message (the gateway transport
 * injects this cleartext flag into the wire event, keyed by `txnId`).
 */
export async function sendText(
  client: MatrixClient,
  roomId: string,
  text: string,
  push = true,
): Promise<string> {
  const txnId = client.makeTxnId();
  markPush(txnId, push);
  return sendTimelineEvent(client, roomId, EventType.RoomMessage, renderTextContent(text), txnId);
}

/**
 * Edit an existing message in place (`m.replace`). Returns the edit event id.
 * This is the streaming primitive: the draft stream calls this repeatedly with
 * the accumulated text; the final call carries the full reply. Live edits are
 * `push:false`; only the final edit is `push:true` (PROTOCOL E).
 */
export async function editText(
  client: MatrixClient,
  roomId: string,
  targetEventId: string,
  text: string,
  push = false,
): Promise<string> {
  const newContent = renderTextContent(text);
  const content: MatrixContent = {
    ...newContent,
    // Fallback body for clients that don't render edits (prefixed " *").
    body: `* ${text}`,
    "m.new_content": newContent,
    "m.relates_to": {
      rel_type: RelationType.Replace,
      event_id: targetEventId,
    },
  };
  const txnId = client.makeTxnId();
  markPush(txnId, push);
  return sendTimelineEvent(client, roomId, EventType.RoomMessage, content, txnId);
}

/**
 * Send a `chat4000.command_result` reply into the control room (PROTOCOL §5).
 * Carries `command` + `ok` and any extra result fields.
 */
export async function sendCommandResult(
  client: MatrixClient,
  roomId: string,
  result: {
    command: string;
    ok: boolean;
    error?: string | undefined;
    data?: Record<string, unknown> | undefined;
  },
): Promise<string> {
  const content: MatrixContent = {
    msgtype: "chat4000.command_result",
    body: `command ${result.command}: ${result.ok ? "ok" : `error: ${result.error ?? "failed"}`}`,
    command: result.command,
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    ...(result.data ?? {}),
  };
  // A command result answers a device action — never wake the user for it.
  const txnId = client.makeTxnId();
  markPush(txnId, false);
  return sendTimelineEvent(client, roomId, EventType.RoomMessage, content, txnId);
}

// ── Turn anchoring, tool calls (PROTOCOL E) ──────────────────────────────────

/**
 * Encrypted field that ties a turn event to its anchor message (PROTOCOL E).
 * Deliberately NOT `m.relates_to` — the crypto SDK lifts that to cleartext, which
 * would leak the turn structure; this plain content field stays inside the ciphertext.
 */
const TURN_ID_FIELD = "chat4000.turn_id";
const TOOL_MSGTYPE = "chat4000.tool";
/** Custom timeline event type for the live-activity label (protocol e3d9358). */
const STATUS_EVENT_TYPE = "chat4000.status";

export type ToolPayload = {
  tool_id: string;
  name: string;
  icon?: string;
  args: string;
  status: "running" | "done" | "failed";
  result: string;
  duration_ms: number;
};

/**
 * Post the turn anchor — the answer message a turn streams into. Starts as a
 * thin placeholder (`chat4000.push:false`); the draft stream edits it to the
 * full answer and the final edit flips push to true (PROTOCOL E).
 */
export async function sendTurnAnchor(client: MatrixClient, roomId: string): Promise<string> {
  return sendText(client, roomId, "…", false);
}

/** Send a tool-start event related to the turn anchor (PROTOCOL E). push:false. */
export async function sendToolStart(
  client: MatrixClient,
  roomId: string,
  turnId: string,
  tool: ToolPayload,
): Promise<string> {
  const content: MatrixContent = {
    msgtype: TOOL_MSGTYPE,
    body: `[tool ${tool.name}: ${tool.status}]`,
    [TOOL_MSGTYPE]: tool,
    // Encrypted link to the turn anchor (NOT m.relates_to — see TURN_ID_FIELD).
    [TURN_ID_FIELD]: turnId,
  };
  const txnId = client.makeTxnId();
  markPush(txnId, false);
  return sendTimelineEvent(client, roomId, EventType.RoomMessage, content, txnId);
}

/** Edit a tool event to its terminal state (`m.replace`). push:false. */
export async function editToolEnd(
  client: MatrixClient,
  roomId: string,
  toolEventId: string,
  tool: ToolPayload,
): Promise<void> {
  const newContent: MatrixContent = {
    msgtype: TOOL_MSGTYPE,
    body: `[tool ${tool.name}: ${tool.status}]`,
    [TOOL_MSGTYPE]: tool,
  };
  const content: MatrixContent = {
    ...newContent,
    "m.new_content": newContent,
    "m.relates_to": { rel_type: RelationType.Replace, event_id: toolEventId },
  };
  const txnId = client.makeTxnId();
  markPush(txnId, false);
  await sendTimelineEvent(client, roomId, EventType.RoomMessage, content, txnId);
}

export type AgentStatusState = "thinking" | "working" | "typing" | "idle";

/**
 * Publish the coarse live-activity label as a `chat4000.status` event sent into
 * the timeline (PROTOCOL E, protocol e3d9358). It is an ordinary E2EE-encrypted
 * timeline event — the homeserver never sees the `state` word.
 *
 * It references the **question** (the user's prompt `event_id`), not the answer
 * anchor: the question always exists before the turn starts, so even the first
 * `thinking` has a stable target. `m.relates_to` is left in cleartext on purpose
 * (the SDK hoists it) so the client can group status under the question's turn —
 * the server sees only *that* a status references the question.
 *
 * Each call is a FRESH event — never an edit/overwrite. The caller sends on every
 * state transition and re-sends every 4s as a keep-alive (shorter than the
 * client's 10s TTL), and always sends `idle` at turn end. Never wakes the user.
 */
export async function sendAgentStatus(
  client: MatrixClient,
  roomId: string,
  state: AgentStatusState,
  questionEventId: string,
): Promise<void> {
  const content: MatrixContent = {
    state,
    "m.relates_to": { rel_type: RelationType.Reference, event_id: questionEventId },
  };
  const txnId = client.makeTxnId();
  markPush(txnId, false);
  await sendTimelineEvent(client, roomId, STATUS_EVENT_TYPE, content, txnId);
}

/**
 * Send a device-pairing status update into the control room (PROTOCOL E device
 * pairing). Mirrors the command-result shape; never wakes the user.
 */
export async function sendPairStatus(
  client: MatrixClient,
  roomId: string,
  params: { pairId: string; state: string; error?: string | undefined },
): Promise<string> {
  const content: MatrixContent = {
    msgtype: "chat4000.pair_status",
    body: `pair ${params.pairId}: ${params.state}`,
    pair_id: params.pairId,
    state: params.state,
    ...(params.error ? { error: params.error } : {}),
  };
  const txnId = client.makeTxnId();
  markPush(txnId, false);
  return sendTimelineEvent(client, roomId, EventType.RoomMessage, content, txnId);
}

/** Custom timeline event type for the HTML-card final answer (PROTOCOL E). */
const HTML_CARD_EVENT_TYPE = "chat4000.html_card";

/**
 * Send a complete HTML card as the turn's final answer (PROTOCOL E, the
 * `final_card` tool). The decrypted event is exactly
 * `{type:"chat4000.html_card", content:{html}}` — no msgtype/body/edit. It
 * pushes, because the card is the sole final-answer surface for that turn.
 */
export async function sendHtmlCard(
  client: MatrixClient,
  roomId: string,
  html: string,
): Promise<string> {
  const txnId = client.makeTxnId();
  markPush(txnId, true);
  return sendTimelineEvent(client, roomId, HTML_CARD_EVENT_TYPE, { html }, txnId);
}
