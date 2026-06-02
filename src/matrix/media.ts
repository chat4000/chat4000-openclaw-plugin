/**
 * Native Matrix media (PROTOCOL D.3 + E).
 *
 * Binary media rides the HTTP media passthrough on the gateway host (the gateway
 * transport routes `/_matrix/media/*` + `/_matrix/client/v1/media/*` to real
 * HTTP, never the WS). For E2EE rooms the blob is encrypted client-side and only
 * the `mxc://` + decryption key travel inside the (encrypted) event.
 *
 * Encryption uses the official `matrix-encrypt-attachment` lib (the same one
 * Element uses) — we do not roll our own cipher. The cleartext AES key/IV/hashes
 * live in the event's `file` object, which is itself inside `m.room.encrypted`,
 * so the homeserver never sees them.
 */
import {
  decryptAttachment,
  encryptAttachment,
  type IEncryptedFile,
} from "matrix-encrypt-attachment";
import { EventType, type MatrixClient } from "matrix-js-sdk";
import { markPush } from "./push-registry.js";
import { sendTimelineEvent, uploadBinary } from "./sdk-boundary.js";

type EncryptedFileRef = IEncryptedFile & { url?: string };

export type InboundMediaBuffer = {
  buffer: Buffer;
  contentType: string;
  filename: string;
};

/**
 * Download (and decrypt if encrypted) an m.image/m.audio event's media into a
 * Buffer for the OpenClaw media store. Returns null when there's no media ref.
 */
export async function downloadInboundMediaBuffer(
  client: MatrixClient,
  content: Record<string, unknown>,
): Promise<InboundMediaBuffer | null> {
  const file = content.file as EncryptedFileRef | undefined;
  const plainUrl = typeof content.url === "string" ? content.url : undefined;
  const mxc = file?.url ?? plainUrl;
  if (!mxc) return null;

  const httpUrl = client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true);
  if (!httpUrl) return null;

  const res = await globalThis.fetch(httpUrl, {
    headers: { Authorization: `Bearer ${client.getAccessToken() ?? ""}` },
  });
  if (!res.ok) throw new Error(`media download failed: ${res.status}`);
  const cipher = await res.arrayBuffer();
  const plain = file ? await decryptAttachment(cipher, file) : cipher;

  const info = content.info as { mimetype?: string } | undefined;
  const contentType = info?.mimetype ?? (content.msgtype === "m.audio" ? "audio/ogg" : "image/png");
  const filename = typeof content.body === "string" ? content.body : "attachment";
  return { buffer: Buffer.from(plain), contentType, filename };
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/**
 * Encrypt (for E2EE rooms) + upload media and send it as a native
 * m.image / m.audio message. Marked push-eligible (a complete result).
 * Returns the event id.
 */
export async function sendMediaMessage(
  client: MatrixClient,
  roomId: string,
  params: { bytes: Uint8Array; mimeType: string; filename: string; encrypted: boolean },
): Promise<string> {
  const isAudio = params.mimeType.startsWith("audio/");
  const msgtype = isAudio ? "m.audio" : "m.image";
  const baseInfo = { mimetype: params.mimeType, size: params.bytes.byteLength };

  let content: Record<string, unknown>;
  if (params.encrypted) {
    const enc = await encryptAttachment(toArrayBuffer(params.bytes));
    const contentUri = await uploadBinary(client, new Uint8Array(enc.data), {
      type: "application/octet-stream",
      name: params.filename,
    });
    const file: EncryptedFileRef = { url: contentUri, ...enc.info };
    content = { msgtype, body: params.filename, file, info: baseInfo };
  } else {
    const contentUri = await uploadBinary(client, params.bytes, {
      type: params.mimeType,
      name: params.filename,
    });
    content = { msgtype, body: params.filename, url: contentUri, info: baseInfo };
  }

  const txnId = client.makeTxnId();
  markPush(txnId, true);
  return sendTimelineEvent(client, roomId, EventType.RoomMessage, content, txnId);
}

/** Whether E2EE is enabled in a room (default to encrypted on any doubt). */
export async function roomIsEncrypted(client: MatrixClient, roomId: string): Promise<boolean> {
  try {
    const crypto = client.getCrypto();
    if (!crypto) return false;
    return await crypto.isEncryptionEnabledInRoom(roomId);
  } catch {
    return true;
  }
}
