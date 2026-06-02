/**
 * Shared types for the chat4000 v2 Matrix transport.
 */

/**
 * A persisted Matrix session for one plugin account.
 *
 * The connection point is the **WS gateway** (PROTOCOL D), not a homeserver —
 * the homeserver has no public hostname (PROTOCOL section 0) and redeem returns
 * a `gateway_url`. The plugin tunnels the whole client-server API over that
 * socket (see gateway-transport.ts), so there is no homeserver URL to store.
 */
export type MatrixCredentials = {
  /** WS gateway URL from redeem, e.g. wss://gateway.chat4000.com/ws. */
  gatewayUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  /** Plugin bot id from the provisioning service (stable across logins). */
  pluginId?: string | undefined;
};

/** Connection lifecycle surfaced to the channel layer. */
export type MatrixConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | { kind: "failed"; reason: string };

/** A decoded inbound room message handed to the agent dispatcher. */
export type MatrixInboundMessage = {
  /** Matrix event id — canonical dedup key (replaces the v1 inner msg_id). */
  eventId: string;
  roomId: string;
  /** Matrix user id of the sender. */
  senderId: string;
  senderDisplayName?: string | undefined;
  /** Origin server timestamp (ms). */
  ts: number;
  body:
    | { kind: "text"; text: string }
    | {
        kind: "media";
        mediaMsgType: "m.image" | "m.audio";
        /** Raw event content, for later download/decrypt via the media path. */
        rawContent: Record<string, unknown>;
        /** Human-readable caption used as the agent's text body. */
        caption: string;
      };
};
