/**
 * Setup-time room creation + invites (PROTOCOL C.6 step 3).
 *
 * Setup opens a SHORT-LIVED Matrix session as the bot, creates the workspace
 * space and the control room (both `m.room.encryption` at creation, the control
 * room marked `chat4000.room_kind: control`), and invites the plugin's one user
 * to both — all BEFORE any device pairs, so pairing completion never needs an
 * invite (a redeemed device inherits its user's memberships).
 *
 * Single-crypto-owner rule (C.6): this session NEVER initializes or touches
 * Olm/Megolm state — there is deliberately no `initRustCrypto` here. Creating
 * rooms, setting `m.room.encryption` (cleartext room *config*), and inviting
 * are plaintext C-S calls; room *keying* is done exclusively by the live plugin
 * in the gateway on its next send after a device joins.
 *
 * Like the live channel, this reaches the homeserver ONLY through the WS
 * gateway (PROTOCOL D) — there is no direct homeserver URL.
 */
import { createClient, type MatrixClient } from "matrix-js-sdk";
import { GatewayTransport, gatewayToBaseUrl } from "./gateway-transport.js";
import { ensurePluginRoomsViaApi, type PluginRooms } from "./space.js";
import type { MatrixCredentials } from "./types.js";

export type SetupPluginRoomsResult = PluginRooms;

/**
 * Matrix rejects an invite for a user who is already invited/joined with
 * `M_FORBIDDEN` ("... is already in the room" / "already invited"). Setup is
 * idempotent (C.6), so that answer means the invite already exists — success.
 */
function isAlreadyMemberError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already\s+(in the room|invited|joined|a member)/i.test(message);
}

/**
 * Core of {@link setupPluginRooms}, taking an already-connected client so unit
 * tests can drive it without a live gateway: ensure the space + control room
 * exist (idempotent, via /joined_rooms) and invite `userId` to both.
 */
export async function setupPluginRoomsWithClient(
  client: MatrixClient,
  params: { accountId: string; pluginName: string; userId: string },
): Promise<SetupPluginRoomsResult> {
  const rooms = await ensurePluginRoomsViaApi(client, {
    accountId: params.accountId,
    pluginName: params.pluginName,
  });
  for (const roomId of [rooms.spaceId, rooms.controlRoomId]) {
    try {
      await client.invite(roomId, params.userId);
    } catch (err) {
      if (!isAlreadyMemberError(err)) throw err;
    }
  }
  return rooms;
}

/**
 * PROTOCOL C.6 step 3: over a short-lived gateway session (no crypto — see
 * module doc), create the plugin's space + control room and invite the
 * plugin's one user to both. Idempotent on re-run.
 */
export async function setupPluginRooms(params: {
  credentials: MatrixCredentials;
  accountId: string;
  pluginName: string;
  userId: string;
}): Promise<SetupPluginRoomsResult> {
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
    return await setupPluginRoomsWithClient(client, {
      accountId: params.accountId,
      pluginName: params.pluginName,
      userId: params.userId,
    });
  } finally {
    transport.dispose();
  }
}
