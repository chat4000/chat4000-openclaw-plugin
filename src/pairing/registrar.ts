/**
 * HTTP client for the chat4000 Registrar (PROTOCOL C, v2 endpoints).
 *
 *   POST /plugins            (bearer SERVICE_TOKEN)   {} -> { bot_user_id,
 *                                                       bot_access_token,
 *                                                       device_id, gateway_url } (C.1)
 *   PUT  /user               (bearer BOT_TOKEN)       {} -> { user_id, created }  (C.2)
 *   POST /codes              (bearer BOT_TOKEN)        { code, ttl_seconds?,
 *                                                       reusable? } -> { ok,
 *                                                       expires_at }              (C.3.1)
 *   POST /codes/{code}/redeem (public; code is secret) { device_name? }
 *                              -> { gateway_url, user_id, device_id, access_token } (C.3.2)
 *   GET  /codes/{code}       (bearer BOT_TOKEN)       -> { status, user_id?,
 *                                                       client_id?, redeems[],
 *                                                       redeemed_count, expires_at? } (C.3.3)
 *   POST /version            (public)                 -> version policy verdict   (C.5.1)
 *   POST /plugin-version     (bearer SERVICE_TOKEN)   -> { current_version,
 *                                                       source }                  (C.5.2)
 *
 * Identity (PROTOCOL B): there is NO `plugin_id`. The bot MXID returned by
 * `POST /plugins` IS the plugin identity; the plugin's one user is DERIVED by
 * the registrar from the bot MXID at `PUT /user`. The auth split (C.4):
 *   - SERVICE_TOKEN gates `POST /plugins` (birthing a bot) and `POST /plugin-version`
 *     (the plugin-only install-source check, C.5.2).
 *   - the BOT access token gates `PUT /user`, `POST /codes`, `GET /codes/{code}`
 *     (whoami-verified to be `@plugin_.*` on every call).
 *   - `POST /codes/{code}/redeem` and `POST /version` are public.
 *
 * The plugin picks the pairing `code`. Errors are JSON `{errcode, error}` with
 * the documented HTTP status.
 */
import { randomInt } from "node:crypto";

/** PROTOCOL C.1 `POST /plugins` result — births a plugin bot identity. */
export type CreatePluginResult = {
  /** The new bot's MXID — `@plugin_<rand>:<server_name>`. This IS the identity. */
  botUserId: string;
  /** The bot's durable Matrix access token (proves `PUT /user`, `POST /codes`). */
  botAccessToken: string;
  /** The bot's one durable device id. */
  deviceId: string;
  /** The WS gateway URL the bot connects to. */
  gatewayUrl: string;
};

export type PairRegisterResult = {
  ok: boolean;
  expiresAt: number;
};

export type PairRedeemResult = {
  gatewayUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
};

type PairStatus = "pending" | "completed" | "expired";

/** One completed redeem of a code (PROTOCOL C.3.3 `redeems[]` entries). */
export type PairRedeem = {
  deviceId: string;
  /** Per-redeem analytics id; absent when that device's telemetry was off. */
  clientId?: string | undefined;
  /** Unix ms of the redeem. */
  redeemedAt: number;
};

export type PairStatusResult = {
  /**
   * PROTOCOL C.3.3: a single-use code settles `completed`; a reusable code
   * stays `pending` while live, however many redeems it has. A watcher waiting
   * for "someone paired" checks `redeems` non-empty, not `status`.
   */
  status: PairStatus;
  userId?: string | undefined;
  /**
   * FLW2: the MOST RECENT redeem's analytics `client_id`, present when that
   * phone sent one (absent on telemetry-off phones).
   */
  clientId?: string | undefined;
  /**
   * One entry per completed redeem, oldest first (most recent 20 for a
   * long-lived reusable code). Empty while nothing has redeemed.
   */
  redeems: PairRedeem[];
  /** Total redeems of this code (may exceed `redeems.length` once truncated). */
  redeemedCount: number;
  /** Unix ms the code expires; present while `pending` (C.3.3). */
  expiresAt?: number | undefined;
};

/**
 * PL4 `redeem_index` derivation (registry-documented): `GET /codes/{code}`
 * carries no per-entry index, so derive it from the wire fields —
 * `redeemedCount − redeems.length + position + 1`, with `redeemedCount`
 * falling back to `redeems.length` when absent/0. A `completed` status with an
 * empty `redeems[]` counts as the single first redeem → 1 (the callers'
 * synthesized-redeem fallback). Undefined when the entry can't be located
 * (never fabricate).
 */
export function redeemIndexOf(status: PairStatusResult, deviceId: string): number | undefined {
  if (status.redeems.length === 0) return status.status === "completed" ? 1 : undefined;
  const pos = status.redeems.findIndex((r) => r.deviceId === deviceId);
  if (pos === -1) return undefined;
  const count = status.redeemedCount > 0 ? status.redeemedCount : status.redeems.length;
  return count - status.redeems.length + pos + 1;
}

/** PROTOCOL C.2 `PUT /user` result. */
export type EnsureUserResult = {
  /** The plugin's one user MXID (registrar-derived from the bot MXID). */
  userId: string;
  /** True when this call created the account; false on an idempotent repeat. */
  created: boolean;
};

type VersionAction = "ok" | "recommend_upgrade" | "force_upgrade";

/** Version-policy verdict for this plugin (PROTOCOL C.5). */
export type VersionPolicyResult = {
  action: VersionAction;
  minVersion: string | null;
  minNag: string | null;
  recommended: string | null;
  currentTermsVersion: number;
  message: string | null;
};

/**
 * PROTOCOL C.5.2 `POST /plugin-version` result — the exact build this caller
 * should be running and the install source for it. Plugin-only (service-token
 * auth); carries no policy/nag/terms.
 */
export type PluginVersionResult = {
  /** The exact plugin version this caller should be running. */
  currentVersion: string;
  /** The repo / image ref that installs `currentVersion`. */
  source: string;
};

export class RegistrarError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errcode?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "RegistrarError";
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isGone(): boolean {
    return this.status === 410;
  }

  /**
   * Transient registrar failures worth retrying while polling: 429 rate limits
   * and 502/503/504 upstream hiccups. Every other HTTP error (401/403/404/409/
   * 410, …) is permanent and should keep failing fast.
   */
  get isTransient(): boolean {
    return this.status === 429 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

/**
 * True for errors the `GET /codes/{code}` polling path retries with backoff
 * instead of killing pairing (observed live 2026-06-12: a 429 M_LIMIT_EXCEEDED
 * from status polling killed the Hermes twin's pairing). Transient = HTTP 429
 * and 502/503/504, plus anything that is NOT a structured {@link RegistrarError}
 * — those come from `fetch` itself (DNS failure, refused/reset connection, the
 * request-timeout abort), i.e. connection-level failures. Other 4xx keep
 * failing fast.
 */
export function isTransientRegistrarError(error: unknown): boolean {
  return error instanceof RegistrarError ? error.isTransient : true;
}

export type RegistrarClientOptions = {
  /** Registrar base URL, e.g. https://registrar.chat4000.com. */
  baseUrl: string;
  /**
   * SERVICE_TOKEN bearer — gates ONLY `POST /plugins` (C.1, C.4). Optional: a
   * client that only mints codes / polls status needs only the bot token.
   */
  serviceToken?: string | undefined;
  /**
   * The plugin bot's own access token (from `POST /plugins`, = the plugin's
   * Matrix access token). Gates `PUT /user`, `POST /codes`, `GET /codes/{code}`
   * (C.2/C.3.1/C.3.3, C.4 "Proof of bot"). Optional: only `POST /plugins` and
   * the public endpoints work without it.
   */
  botAccessToken?: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type AuthKind = "service" | "bot" | "none";

export class RegistrarClient {
  private readonly baseUrl: string;

  private readonly serviceToken: string | undefined;

  private readonly botAccessToken: string | undefined;

  private readonly timeoutMs: number;

  private readonly fetchImpl: typeof fetch;

  constructor(opts: RegistrarClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.serviceToken = opts.serviceToken;
    this.botAccessToken = opts.botAccessToken;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * PROTOCOL C.1 `POST /plugins` — birth a plugin bot. Auth: the SERVICE_TOKEN.
   * Mints a fresh `@plugin_<rand>` account + its one durable device and returns
   * the bot MXID (the identity — there is no `plugin_id`), its durable access
   * token, device id, and gateway URL. NOT idempotent: every call mints a new
   * bot, so the plugin calls this exactly once at first self-onboard (C.6 step 1).
   */
  async createPlugin(): Promise<CreatePluginResult> {
    const body = (await this.request("POST", "/plugins", {
      auth: "service",
      body: {},
    })) as Record<string, unknown>;
    return {
      botUserId: String(body.bot_user_id),
      botAccessToken: String(body.bot_access_token),
      deviceId: String(body.device_id),
      gatewayUrl: String(body.gateway_url),
    };
  }

  /**
   * PROTOCOL C.2 `PUT /user` — create-or-return the plugin's one user. Auth:
   * the BOT access token (NOT the service token). The registrar DERIVES the
   * user localpart from the verified bot MXID, so this is idempotent and
   * wipe-proof: a repeat returns the SAME user with `created: false`. Body is
   * empty — the bot token alone selects the user (no `plugin_id`).
   */
  async ensureUser(): Promise<EnsureUserResult> {
    const body = (await this.request("PUT", "/user", {
      auth: "bot",
      body: {},
    })) as Record<string, unknown>;
    return { userId: String(body.user_id), created: Boolean(body.created) };
  }

  /**
   * PROTOCOL C.3.1 `POST /codes` — mint a pairing code. Auth: the BOT access
   * token. The code is bound to the bot's DERIVED user implicitly (no
   * `user_id`, no `kind`, no `plugin_id`); the registrar verifies that user
   * exists (else `409 M_NO_USER` — run `PUT /user`/setup first). `reusable`
   * codes redeem repeatedly until expiry, each redeem adding another device;
   * `ttlSeconds` may go up to 2 years (C.3.1).
   */
  async mintCode(params: {
    code: string;
    ttlSeconds?: number | undefined;
    reusable?: boolean | undefined;
  }): Promise<PairRegisterResult> {
    const body = (await this.request("POST", "/codes", {
      auth: "bot",
      body: {
        code: params.code,
        ...(params.ttlSeconds !== undefined ? { ttl_seconds: params.ttlSeconds } : {}),
        ...(params.reusable !== undefined ? { reusable: params.reusable } : {}),
      },
    })) as Record<string, unknown>;
    return { ok: Boolean(body.ok), expiresAt: Number(body.expires_at) };
  }

  /**
   * PROTOCOL C.3.2 `POST /codes/{code}/redeem` — redeem a code (public; the
   * code in the path is the secret). Mints a device on the code's bound user.
   */
  async redeemPairing(params: { code: string; deviceName?: string }): Promise<PairRedeemResult> {
    const body = (await this.request("POST", `/codes/${encodeURIComponent(params.code)}/redeem`, {
      auth: "none",
      body: params.deviceName !== undefined ? { device_name: params.deviceName } : {},
    })) as Record<string, unknown>;
    return {
      gatewayUrl: String(body.gateway_url),
      userId: String(body.user_id),
      deviceId: String(body.device_id),
      accessToken: String(body.access_token),
    };
  }

  /**
   * Check the version policy for this caller (PROTOCOL C.5.1). PUBLIC endpoint —
   * version policy is not secret and one endpoint serves apps + plugins, so it
   * carries no token. The registrar semver-compares and returns the verdict.
   */
  async checkVersion(params: {
    appId: string;
    clientVersion: string;
    releaseChannel: string;
    platform?: string;
    /**
     * PL3: the machine analytics id (agent_install_id) — rides ONLY as the
     * `X-Client-Id` header. Pass null/undefined when telemetry is off so the id
     * never rides. There is no `posthog_id` body field (never had one here).
     */
    clientId?: string | null | undefined;
  }): Promise<VersionPolicyResult> {
    const body = (await this.request("POST", "/version", {
      auth: "none",
      clientId: params.clientId,
      body: {
        app_id: params.appId,
        client_version: params.clientVersion,
        release_channel: params.releaseChannel,
        platform: params.platform,
      },
    })) as Record<string, unknown>;
    const action =
      body.action === "force_upgrade" || body.action === "recommend_upgrade" ? body.action : "ok";
    return {
      action,
      minVersion: typeof body.min_version === "string" ? body.min_version : null,
      minNag: typeof body.min_nag === "string" ? body.min_nag : null,
      recommended: typeof body.recommended === "string" ? body.recommended : null,
      currentTermsVersion:
        typeof body.current_terms_version === "number" ? body.current_terms_version : 0,
      message: typeof body.message === "string" ? body.message : null,
    };
  }

  /**
   * PROTOCOL C.5.2 `POST /plugin-version` — which exact build this caller should
   * be running, and the install source for it. SERVICE-TOKEN auth (plugin-only;
   * this endpoint returns no policy/nag/terms). The registrar answers one
   * question: `current_version` + `source`. The caller then either already IS
   * `current_version` (no-op) or installs `source` and restarts into it.
   */
  async checkPluginVersion(params: {
    appId: string;
    /**
     * The machine analytics id (= agent_install_id) — rides ONLY as the
     * `X-Client-Id` header (the canonical carrier; no `posthog_id` body field).
     * It is the gradual-rollout cohort key (C.5.2). Pass null/undefined when
     * telemetry is off so the id never rides and the caller can't enter a
     * partial rollout.
     */
    clientId?: string | null | undefined;
  }): Promise<PluginVersionResult> {
    const body = (await this.request("POST", "/plugin-version", {
      auth: "service",
      clientId: params.clientId,
      body: { app_id: params.appId },
    })) as Record<string, unknown>;
    return {
      currentVersion: String(body.current_version),
      source: String(body.source),
    };
  }

  /** Poll pairing completion (plugin → registrar, PROTOCOL C.3.3). Bot-token auth. */
  async getPairingStatus(code: string): Promise<PairStatusResult> {
    const body = (await this.request("GET", `/codes/${encodeURIComponent(code)}`, {
      auth: "bot",
    })) as Record<string, unknown>;
    return {
      status: String(body.status) as PairStatus,
      userId: typeof body.user_id === "string" ? body.user_id : undefined,
      clientId: typeof body.client_id === "string" ? body.client_id : undefined,
      redeems: parseRedeems(body.redeems),
      redeemedCount: typeof body.redeemed_count === "number" ? body.redeemed_count : 0,
      expiresAt: typeof body.expires_at === "number" ? body.expires_at : undefined,
    };
  }

  private async request(
    method: string,
    pathName: string,
    opts: { auth: AuthKind; body?: unknown; clientId?: string | null | undefined },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth === "service") {
      if (!this.serviceToken) {
        clearTimeout(timer);
        throw new Error(`registrar ${method} ${pathName} needs a SERVICE_TOKEN but none was set`);
      }
      headers.Authorization = `Bearer ${this.serviceToken}`;
    } else if (opts.auth === "bot") {
      if (!this.botAccessToken) {
        clearTimeout(timer);
        throw new Error(
          `registrar ${method} ${pathName} needs the bot access token but none was set`,
        );
      }
      headers.Authorization = `Bearer ${this.botAccessToken}`;
    }
    // PL3: the machine analytics id. Caller passes null when telemetry is off.
    if (opts.clientId) headers["X-Client-Id"] = opts.clientId.slice(0, 64);

    try {
      const res = await this.fetchImpl(`${this.baseUrl}${pathName}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed = text ? safeJsonParse(text) : undefined;
      if (!res.ok) {
        const p = parsed as { errcode?: string; error?: string } | undefined;
        throw new RegistrarError(
          p?.error ?? `registrar ${method} ${pathName} failed: ${res.status}`,
          res.status,
          p?.errcode,
          parsed,
        );
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Decode the untrusted `redeems` array off a `GET /codes/{code}` body (C.3.3). */
function parseRedeems(raw: unknown): PairRedeem[] {
  if (!Array.isArray(raw)) return [];
  const redeems: PairRedeem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.device_id !== "string") continue;
    redeems.push({
      deviceId: r.device_id,
      clientId: typeof r.client_id === "string" ? r.client_id : undefined,
      redeemedAt: typeof r.redeemed_at === "number" ? r.redeemed_at : 0,
    });
  }
  return redeems;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** PROTOCOL C.3.1: `ttl_seconds` upper bound — 63 072 000 s = 2 years. */
export const PAIR_CODE_TTL_MAX_SECONDS = 63_072_000;

/**
 * Generate a pairing code: **exactly 6 uniformly-random digits** (PROTOCOL
 * C.3/C.4). The registrar rejects anything that isn't 6 digits. `randomInt` is
 * CSPRNG-backed and unbiased (rejection-sampled internally), so there is no
 * modulo skew.
 */
export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < 6; i += 1) code += String(randomInt(10));
  return code;
}
