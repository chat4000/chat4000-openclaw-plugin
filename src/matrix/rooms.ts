/**
 * Room creation + invite for the pairing flow (PROTOCOL C.3).
 *
 * When a device redeems a pairing code, "the plugin invites user_id to its space
 * and session rooms." Minimal correct behavior: the plugin creates an encrypted
 * room and invites the freshly-paired user so messages can flow immediately.
 *
 * Like the live channel, this reaches the homeserver ONLY through the WS gateway
 * (PROTOCOL D) — there is no direct homeserver URL. createRoom + invite are
 * plaintext C-S calls, so a short-lived transport (no crypto init) is enough;
 * the room is flagged encrypted so the gateway's full client uses Megolm for the
 * actual messages.
 */
import { createClient, EventType, Preset, Visibility } from "matrix-js-sdk";
import { GatewayTransport, gatewayToBaseUrl } from "./gateway-transport.js";
import type { MatrixCredentials } from "./types.js";

export type CreatePairedRoomResult = {
  roomId: string;
};

/**
 * Create an encrypted direct room owned by the plugin and invite `inviteUserId`.
 * Returns the new room id.
 */
export async function createPairedRoom(params: {
  credentials: MatrixCredentials;
  inviteUserId: string;
  name?: string;
}): Promise<CreatePairedRoomResult> {
  const transport = new GatewayTransport({
    gatewayUrl: params.credentials.gatewayUrl,
    accessToken: params.credentials.accessToken,
  });
  await transport.connect();
  const client = createClient({
    baseUrl: gatewayToBaseUrl(params.credentials.gatewayUrl),
    accessToken: params.credentials.accessToken,
    userId: params.credentials.userId,
    deviceId: params.credentials.deviceId,
    fetchFn: transport.fetch,
  });

  try {
    const res = await client.createRoom({
      preset: Preset.TrustedPrivateChat,
      visibility: Visibility.Private,
      is_direct: true,
      invite: [params.inviteUserId],
      ...(params.name ? { name: params.name } : {}),
      initial_state: [
        {
          type: EventType.RoomEncryption,
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
      ],
    });
    return { roomId: res.room_id };
  } finally {
    transport.dispose();
  }
}

/**
 * Invite a user into a set of existing rooms over a short-lived gateway client
 * (no crypto — invites are plaintext C-S calls). Used by the pairing flow to add
 * the paired user to the plugin's control room + space (PROTOCOL E).
 */
export async function inviteUserToRooms(params: {
  credentials: MatrixCredentials;
  roomIds: string[];
  userId: string;
}): Promise<void> {
  const transport = new GatewayTransport({
    gatewayUrl: params.credentials.gatewayUrl,
    accessToken: params.credentials.accessToken,
  });
  await transport.connect();
  const client = createClient({
    baseUrl: gatewayToBaseUrl(params.credentials.gatewayUrl),
    accessToken: params.credentials.accessToken,
    userId: params.credentials.userId,
    deviceId: params.credentials.deviceId,
    fetchFn: transport.fetch,
  });
  try {
    for (const roomId of params.roomIds) {
      await client.invite(roomId, params.userId);
    }
  } finally {
    transport.dispose();
  }
}
