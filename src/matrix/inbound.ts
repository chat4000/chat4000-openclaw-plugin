/**
 * Decode a Matrix timeline event into a chat4000 inbound message or command.
 *
 * Final, non-edit `m.room.message` events of type text/image/audio become
 * inbound messages for the agent. Events with `msgtype: "chat4000.command"`
 * (PROTOCOL §5) become control commands handled by the plugin, not the agent.
 * Edits (m.replace), reactions, state events, and our own output are ignored.
 */
import { EventType, type MatrixEvent, MsgType, RelationType } from "matrix-js-sdk";
import type { MatrixInboundMessage } from "./types.js";

export type MatrixInboundCommand = {
  kind: "command";
  eventId: string;
  roomId: string;
  senderId: string;
  command: string;
  args: Record<string, unknown>;
  ts: number;
};

/** chat4000 control-command msgtype (PROTOCOL E). */
const COMMAND_MSGTYPE = "chat4000.command";
/** Room-kind state event type, state_key "" (PROTOCOL E). `kind`: control|session. */
export const ROOM_KIND_STATE_EVENT = "chat4000.room_kind";

// `MatrixEvent.getType()` returns a plain `string`, so compare against the event
// type's string value rather than the enum member (avoids enum-vs-string compares).
const ROOM_MESSAGE_TYPE: string = EventType.RoomMessage;

export function decodeCommandEvent(event: MatrixEvent): MatrixInboundCommand | null {
  if (event.getType() !== ROOM_MESSAGE_TYPE) return null;
  if (event.isRedacted()) return null;
  const content = event.getContent();
  if (content.msgtype !== COMMAND_MSGTYPE) return null;
  const command = typeof content.command === "string" ? content.command : "";
  const eventId = event.getId();
  const roomId = event.getRoomId();
  const senderId = event.getSender();
  if (!command || !eventId || !roomId || !senderId) return null;
  return {
    kind: "command",
    eventId,
    roomId,
    senderId,
    command,
    args: content,
    ts: event.getTs(),
  };
}

export function decodeInboundEvent(event: MatrixEvent): MatrixInboundMessage | null {
  if (event.getType() !== ROOM_MESSAGE_TYPE) return null;
  if (event.isRedacted()) return null;

  const content = event.getContent();

  // Commands are handled separately, never as agent prompts.
  if (content.msgtype === COMMAND_MSGTYPE) return null;

  // Skip edits — the original event already lives in the timeline; we only act
  // on first-class incoming messages.
  const relatesTo = content["m.relates_to"] as { rel_type?: string } | undefined;
  if (relatesTo?.rel_type === RelationType.Replace) return null;

  const eventId = event.getId();
  const roomId = event.getRoomId();
  const senderId = event.getSender();
  if (!eventId || !roomId || !senderId) return null;

  const base = {
    eventId,
    roomId,
    senderId,
    senderDisplayName: event.sender?.name,
    ts: event.getTs(),
  };

  const msgtype = content.msgtype;
  if (msgtype === MsgType.Text || msgtype === MsgType.Notice || msgtype === MsgType.Emote) {
    const text = typeof content.body === "string" ? content.body : "";
    if (!text) return null;
    return { ...base, body: { kind: "text", text } };
  }

  if (msgtype === MsgType.Image || msgtype === MsgType.Audio) {
    // Carry the raw content; the channel downloads + decrypts it over the HTTP
    // media path and offloads it to the OpenClaw media store (PROTOCOL D.3).
    const filename = typeof content.body === "string" ? content.body : "attachment";
    const label = msgtype === MsgType.Image ? "Image" : "Voice note";
    return {
      ...base,
      body: {
        kind: "media",
        mediaMsgType: msgtype === MsgType.Image ? "m.image" : "m.audio",
        rawContent: content,
        caption: `[${label}: ${filename}]`,
      },
    };
  }

  return null;
}
