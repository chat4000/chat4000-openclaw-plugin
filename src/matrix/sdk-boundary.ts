/**
 * The single, isolated seam where chat4000's dynamically-shaped Matrix content
 * meets matrix-js-sdk's strict generated event-content unions.
 *
 * The SDK types `sendEvent` / `sendStateEvent` as `content: TimelineEvents[K]` /
 * `StateEvents[K]` — closed unions keyed off the *known* event types. chat4000
 * legitimately sends custom msgtypes (`chat4000.tool`, `chat4000.command_result`,
 * `chat4000.status`, `m.space.child/parent`, `chat4000.room_kind`) and
 * `m.replace` edits with arbitrary `m.new_content`, none of which the generated
 * union can express. Rather than scatter `as any` across the send layer, every
 * such call funnels through these three wrappers, where the one unavoidable
 * widening lives behind a described `@ts-expect-error`. The runtime payload is a
 * plain JSON object the homeserver accepts; only the compile-time union is too
 * narrow.
 */
import { type EventType, type MatrixClient } from "matrix-js-sdk";

/** Content we hand to the SDK: a plain JSON object (always with `body`/`msgtype`). */
export type MatrixSendContent = Record<string, unknown>;

/** Send a timeline event with chat4000's custom/dynamic content. */
export async function sendTimelineEvent(
  client: MatrixClient,
  roomId: string,
  eventType: EventType,
  content: MatrixSendContent,
  txnId: string,
): Promise<string> {
  // SDK-union limitation: `sendEvent<K>` types `content` as `TimelineEvents[K]`,
  // which cannot express chat4000's custom msgtypes / `m.new_content` edits.
  // @ts-expect-error -- content union is narrower than the wire format; see module doc.
  const res = await client.sendEvent(roomId, eventType, content, txnId);
  return res.event_id;
}

/** Send a state event with a custom type / dynamic content. */
export async function sendCustomStateEvent(
  client: MatrixClient,
  roomId: string,
  type: string,
  content: MatrixSendContent,
  stateKey: string,
): Promise<string> {
  // SDK-union limitation: `sendStateEvent<K extends keyof StateEvents>` only
  // accepts known state-event types; chat4000 uses custom ones (room_kind,
  // m.space.child/parent, chat4000.status). The runtime call is a plain C-S PUT.
  // @ts-expect-error -- custom state-event type is outside the SDK's StateEvents union; see module doc.
  const res = await client.sendStateEvent(roomId, type, content, stateKey);
  return res.event_id;
}

/**
 * Upload binary content. The SDK types `file: FileType` (= XMLHttpRequestBodyInit)
 * which omits `Uint8Array`, but Node's fetch transport accepts a `Buffer`/
 * `Uint8Array` at runtime. The cast is isolated here.
 */
export async function uploadBinary(
  client: MatrixClient,
  bytes: Uint8Array,
  opts: { type: string; name: string },
): Promise<string> {
  // FileType (XMLHttpRequestBodyInit) omits Uint8Array, but a Node Buffer is an
  // ArrayBufferView and so satisfies it at both compile and run time.
  const upload = await client.uploadContent(Buffer.from(bytes), opts);
  return upload.content_uri;
}
