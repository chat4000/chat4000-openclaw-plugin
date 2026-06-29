/**
 * The plugin's space + control room + session rooms (PROTOCOL E).
 *
 * A plugin is one `m.space`; under it sit exactly one **control** room (where the
 * device issues `session.*` / `plugin.*` commands) and N **session** rooms (one
 * conversation each). Every room the plugin creates carries a `chat4000.room_kind`
 * state event so the app can classify it; the control room also carries an
 * `m.room.name`. Rooms are linked to the space with `m.space.child` / `m.space.parent`.
 *
 * Creation is a one-time `setup` act: the resolved {spaceId, controlRoomId} are
 * persisted per account; setup verifies membership via `GET /joined_rooms` before
 * reuse, and the gateway boot only LOADS the persisted workspace (never creates),
 * so a restart can never spawn a duplicate.
 */
import { type ICreateRoomOpts, type MatrixClient, Preset, Visibility } from "matrix-js-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChat4000AccountStateDir } from "../paths.js";
import { ROOM_KIND_STATE_EVENT } from "./inbound.js";
import { sendCustomStateEvent } from "./sdk-boundary.js";
import { isOnboarded, markOnboarded } from "./onboarded-store.js";

const ROOM_ENCRYPTION = "m.room.encryption";
const SPACE_CHILD = "m.space.child";
const SPACE_PARENT = "m.space.parent";
const ROOM_NAME = "m.room.name";

export type PluginRooms = {
  spaceId: string;
  controlRoomId: string;
};

function roomsFile(accountId: string): string {
  return path.join(resolveChat4000AccountStateDir(accountId), "rooms.json");
}

/** Read the persisted {spaceId, controlRoomId} for an account (may be partial). */
export function readPluginRooms(accountId: string): Partial<PluginRooms> {
  const file = roomsFile(accountId);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Partial<PluginRooms>;
  } catch {
    return {};
  }
}

function saveRooms(accountId: string, rooms: PluginRooms): void {
  const file = roomsFile(accountId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(rooms, null, 2)}\n`, "utf8");
}

function serverNameOf(userId: string): string {
  return userId.split(":")[1] ?? "";
}

/**
 * Send a state event with a custom type. matrix-js-sdk's `sendStateEvent` union
 * only allows known event types; ours (m.space.child/parent, room_kind) are
 * custom, so the unavoidable widening lives in the shared SDK boundary helper.
 */
async function sendState(
  client: MatrixClient,
  roomId: string,
  type: string,
  content: Record<string, unknown>,
  stateKey: string,
): Promise<void> {
  await sendCustomStateEvent(client, roomId, type, content, stateKey);
}

type IsJoinedFn = (roomId: string | undefined) => boolean;

function encryptionState(): NonNullable<ICreateRoomOpts["initial_state"]>[number] {
  return { type: ROOM_ENCRYPTION, state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } };
}

function roomKindState(
  kind: "control" | "session",
): NonNullable<ICreateRoomOpts["initial_state"]>[number] {
  return { type: ROOM_KIND_STATE_EVENT, state_key: "", content: { kind } };
}

/** Link a child room under the space (both directions). */
async function linkChild(
  client: MatrixClient,
  spaceId: string,
  childRoomId: string,
): Promise<void> {
  const via = [serverNameOf(client.getUserId() ?? "")].filter(Boolean);
  await sendState(client, spaceId, SPACE_CHILD, { via }, childRoomId);
  await sendState(client, childRoomId, SPACE_PARENT, { via, canonical: true }, spaceId);
}

/**
 * Shared create-what's-missing core for {@link ensurePluginRooms} (gateway,
 * synced state) and {@link ensurePluginRoomsViaApi} (setup, /joined_rooms).
 * PROTOCOL C.6 step 3: both the space and the control room get
 * `m.room.encryption` at creation; only the control room is marked
 * `chat4000.room_kind: control`, and it carries a human-readable name (E).
 */
async function ensureRoomsWith(
  client: MatrixClient,
  params: { accountId: string; pluginName: string },
  joined: IsJoinedFn,
): Promise<PluginRooms> {
  const stored = readPluginRooms(params.accountId);

  let spaceId = joined(stored.spaceId) ? stored.spaceId : undefined;
  if (!spaceId) {
    const res = await client.createRoom({
      name: params.pluginName,
      preset: Preset.PrivateChat,
      visibility: Visibility.Private,
      creation_content: { type: "m.space" },
      initial_state: [encryptionState()],
    });
    spaceId = res.room_id;
  }

  let controlRoomId = joined(stored.controlRoomId) ? stored.controlRoomId : undefined;
  if (!controlRoomId) {
    const res = await client.createRoom({
      name: "Commands",
      preset: Preset.TrustedPrivateChat,
      visibility: Visibility.Private,
      initial_state: [encryptionState(), roomKindState("control")],
    });
    controlRoomId = res.room_id;
    await linkChild(client, spaceId, controlRoomId);
  }

  const rooms: PluginRooms = { spaceId, controlRoomId };
  saveRooms(params.accountId, rooms);
  return rooms;
}

/**
 * Gateway-boot resolver (PROTOCOL E): LOAD the persisted workspace and verify
 * membership authoritatively via `GET /joined_rooms`. It NEVER creates rooms.
 *
 * Creation is a one-time `setup` act ({@link ensurePluginRoomsViaApi}). The old
 * boot path created "what's missing" using the in-memory synced state
 * (`getRoom`), which is empty for a beat right after a cold boot — so a routine
 * gateway restart (e.g. the installer's post-pairing reload) could read
 * "not joined to my own workspace" and mint a DUPLICATE space+control,
 * overwriting rooms.json and orphaning the paired conversation. Boot now only
 * resolves an existing workspace and never forks one:
 *   - no persisted workspace  → throw (run `setup`)
 *   - persisted but not joined → throw (re-run `setup`; never silently duplicate)
 */
export async function ensurePluginRooms(
  client: MatrixClient,
  params: { accountId: string; pluginName: string },
): Promise<PluginRooms> {
  // F1: boot loads, never creates.
  const stored = readPluginRooms(params.accountId);
  if (!stored.spaceId || !stored.controlRoomId) {
    throw new Error(
      `chat4000: no persisted workspace for account "${params.accountId}" ` +
        "(rooms.json missing or partial). Run `openclaw chat4000 setup` first — " +
        "the gateway must not create a workspace on boot.",
    );
  }
  // F2: authoritative membership from the server (GET /joined_rooms), NOT the
  // synced state, which is unpopulated for a beat after a cold boot — the source
  // of the duplicate-workspace race.
  const { joined_rooms } = await client.getJoinedRooms();
  const joinedSet = new Set(joined_rooms);
  if (!joinedSet.has(stored.spaceId) || !joinedSet.has(stored.controlRoomId)) {
    throw new Error(
      "chat4000: bot is not joined to its persisted workspace " +
        `(space=${stored.spaceId}, control=${stored.controlRoomId}). Refusing to ` +
        "mint a duplicate — re-run `openclaw chat4000 setup` if the workspace was lost.",
    );
  }
  return { spaceId: stored.spaceId, controlRoomId: stored.controlRoomId };
}

/**
 * Setup-time variant of {@link ensurePluginRooms} for a short-lived,
 * NON-SYNCING bot session (PROTOCOL C.6 step 3): membership of the persisted
 * room ids is verified with one `GET /joined_rooms` call instead of synced
 * state, so re-running setup reuses the existing rooms and never spawns
 * duplicates.
 */
export async function ensurePluginRoomsViaApi(
  client: MatrixClient,
  params: { accountId: string; pluginName: string },
): Promise<PluginRooms> {
  const { joined_rooms } = await client.getJoinedRooms();
  const joinedSet = new Set(joined_rooms);
  return ensureRoomsWith(client, params, (roomId) => Boolean(roomId && joinedSet.has(roomId)));
}

/**
 * Create a new encrypted session room under the space, optionally inviting a
 * user. Returns the new room id (PROTOCOL E `session.new`).
 */
export async function createSessionRoom(
  client: MatrixClient,
  params: { spaceId: string; title?: string | undefined; inviteUserId?: string | undefined },
): Promise<string> {
  const res = await client.createRoom({
    name: params.title || "chat4000 session",
    preset: Preset.TrustedPrivateChat,
    visibility: Visibility.Private,
    ...(params.inviteUserId ? { invite: [params.inviteUserId] } : {}),
    initial_state: [encryptionState(), roomKindState("session")],
  });
  await linkChild(client, params.spaceId, res.room_id);
  return res.room_id;
}

/**
 * Auto-create ONE initial session room for a paired user + invite them, so their
 * first chat works without pressing "New Session" (PROTOCOL E; mirrors hermes
 * `_ensure_initial_session`). Durable dedupe via the onboarded store: a restart
 * that re-invites known users never mints a second initial room. Returns the new
 * room id, or null when the user already has one (or has no id).
 */
export async function ensureInitialSession(
  client: MatrixClient,
  params: { spaceId: string; accountId: string; userId: string },
): Promise<string | null> {
  const userId = params.userId.trim();
  if (!userId || isOnboarded(params.accountId, userId)) return null;
  const roomId = await createSessionRoom(client, {
    spaceId: params.spaceId,
    title: "chat4000",
    inviteUserId: userId,
  });
  markOnboarded(params.accountId, userId, roomId);
  return roomId;
}

/** Rename a session room (`session.rename`). */
export async function renameRoom(
  client: MatrixClient,
  roomId: string,
  title: string,
): Promise<void> {
  await sendState(client, roomId, ROOM_NAME, { name: title }, "");
}

/**
 * Delete a session room (`session.delete`): unlink it from the space, then leave
 * and forget it so it disappears from the plugin entirely. Unlike
 * {@link archiveRoom} (which only drops the space link), this also removes the
 * bot from the room.
 */
export async function deleteSessionRoom(
  client: MatrixClient,
  spaceId: string,
  roomId: string,
): Promise<void> {
  // Unlink first so the app stops listing it even if leave/forget fail.
  await sendState(client, spaceId, SPACE_CHILD, {}, roomId);
  await client.leave(roomId);
  await client.forget(roomId);
}

/**
 * Archive a session room (`session.archive`): drop it from the space so the app
 * stops listing it under the plugin. The room itself is left intact (history is
 * not destroyed).
 */
export async function archiveRoom(
  client: MatrixClient,
  spaceId: string,
  roomId: string,
): Promise<void> {
  // Empty m.space.child content removes the child link.
  await sendState(client, spaceId, SPACE_CHILD, {}, roomId);
}
