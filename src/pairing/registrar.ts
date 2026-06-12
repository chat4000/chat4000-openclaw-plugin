/**
 * HTTP client for the chat4000 Registrar (PROTOCOL C).
 *
 *   POST /user/ensure    (bearer SERVICE_TOKEN)  { plugin_id }
 *                                                -> { user_id, created }          (C.6.1)
 *   POST /pair/register  (bearer SERVICE_TOKEN)  { code, plugin_id, user_id?,
 *                                                  ttl_seconds?, reusable? }
 *                                                -> { ok, expires_at }            (C.1)
 *   POST /pair/redeem    (public; code is secret) { code, device_name? }
 *                                                -> { gateway_url, user_id, device_id, access_token }
 *   GET  /pair/status?code=...  (bearer)         -> { status, user_id?, client_id?,
 *                                                     redeems[], redeemed_count,
 *                                                     expires_at? }               (C.3)
 *
 * The plugin picks the pairing `code`. Errors are JSON `{errcode, error}` with the
 * documented HTTP status.
 */
import { randomInt } from "node:crypto";

export type PairRegisterResult = {
  ok: boolean;
  expiresAt: number;
};

export type PairKind = "user" | "plugin";

export type PairRedeemResult = {
  gatewayUrl: string;
  userId: string;
  deviceId: string;
  accessToken: string;
  /** Only present for a `kind=plugin` code — the id the registrar issued. */
  pluginId?: string | undefined;
};

type PairStatus = "pending" | "completed" | "expired";

/** One completed redeem of a code (PROTOCOL C.3 `redeems[]` entries). */
export type PairRedeem = {
  deviceId: string;
  /** Per-redeem analytics id; absent when that device's telemetry was off. */
  clientId?: string | undefined;
  /** Unix ms of the redeem. */
  redeemedAt: number;
};

export type PairStatusResult = {
  /**
   * PROTOCOL C.3: a single-use code settles `completed`; a reusable code stays
   * `pending` while live, however many redeems it has. A watcher waiting for
   * "someone paired" checks `redeems` non-empty, not `status`.
   */
  status: PairStatus;
  userId?: string | undefined;
  /**
   * FLW2: the MOST RECENT redeem's analytics `client_id`, present when that
   * phone sent one (absent on old registrars / telemetry-off phones).
   */
  clientId?: string | undefined;
  /**
   * One entry per completed redeem, oldest first (most recent 20 for a
   * long-lived reusable code). Empty while nothing has redeemed.
   */
  redeems: PairRedeem[];
  /** Total redeems of this code (may exceed `redeems.length` once truncated). */
  redeemedCount: number;
  /** Unix ms the code expires; present while `pending` (C.3). */
  expiresAt?: number | undefined;
};

/**
 * PL4 `redeem_index` derivation (registry-documented): `/pair/status` carries
 * no per-entry index, so derive it from the wire fields —
 * `redeemedCount − redeems.length + position + 1`, with `redeemedCount`
 * falling back to `redeems.length` when absent/0. The old-registrar completed
 * shape (no `redeems[]`) counts as the single first redeem → 1. Undefined when
 * the entry can't be located (never fabricate).
 */
export function redeemIndexOf(status: PairStatusResult, deviceId: string): number | undefined {
  if (status.redeems.length === 0) return status.status === "completed" ? 1 : undefined;
  const pos = status.redeems.findIndex((r) => r.deviceId === deviceId);
  if (pos === -1) return undefined;
  const count = status.redeemedCount > 0 ? status.redeemedCount : status.redeems.length;
  return count - status.redeems.length + pos + 1;
}

/** PROTOCOL C.6.1 `POST /user/ensure` result. */
export type EnsureUserResult = {
  /** The plugin's one user MXID (registrar-generated). */
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
 * True for errors the /pair/status polling path retries with backoff instead of
 * killing pairing (observed live 2026-06-12: a 429 M_LIMIT_EXCEEDED from
 * /pair/status killed the Hermes twin's pairing). Transient = HTTP 429 and
 * 502/503/504, plus anything that is NOT a structured {@link RegistrarError} —
 * those come from `fetch` itself (DNS failure, refused/reset connection, the
 * request-timeout abort), i.e. connection-level failures. Other 4xx keep
 * failing fast.
 */
export function isTransientRegistrarError(error: unknown): boolean {
  return error instanceof RegistrarError ? error.isTransient : true;
}

export type RegistrarClientOptions = {
  /** Registrar base URL, e.g. https://registrar.chat4000.com. */
  baseUrl: string;
  /** SERVICE_TOKEN bearer for /pair/register and /pair/status. */
  serviceToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class RegistrarClient {
  private readonly baseUrl: string;

  private readonly serviceToken: string;

  private readonly timeoutMs: number;

  private readonly fetchImpl: typeof fetch;

  constructor(opts: RegistrarClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.serviceToken = opts.serviceToken;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Create (or return) the plugin's one user (PROTOCOL C.6.1). Idempotent per
   * `pluginId` — a repeat returns the SAME user with `created: false`. Every
   * later `kind=user` registration binds codes to this user (C.1).
   */
  async ensureUser(params: { pluginId: string }): Promise<EnsureUserResult> {
    const body = (await this.request("POST", "/user/ensure", {
      auth: true,
      body: { plugin_id: params.pluginId },
    })) as Record<string, unknown>;
    return { userId: String(body.user_id), created: Boolean(body.created) };
  }

  /**
   * Reserve a pairing code (PROTOCOL C.1). `kind="user"` (default) requires a
   * `pluginId`; the registrar binds the code AT REGISTRATION to the user
   * `/user/ensure` created for that plugin (400 if setup never ran).
   * `kind="plugin"` omits it (the registrar issues a new plugin_id at redeem).
   * `reusable` codes (kind=user only) redeem repeatedly until expiry, each
   * redeem adding another device; `ttlSeconds` may go up to 2 years.
   */
  async registerPairing(params: {
    code: string;
    kind?: PairKind | undefined;
    pluginId?: string | undefined;
    userId?: string | undefined;
    ttlSeconds?: number | undefined;
    reusable?: boolean | undefined;
  }): Promise<PairRegisterResult> {
    const body = (await this.request("POST", "/pair/register", {
      auth: true,
      body: {
        code: params.code,
        kind: params.kind,
        plugin_id: params.pluginId,
        user_id: params.userId,
        ttl_seconds: params.ttlSeconds,
        ...(params.reusable !== undefined ? { reusable: params.reusable } : {}),
      },
    })) as Record<string, unknown>;
    return { ok: Boolean(body.ok), expiresAt: Number(body.expires_at) };
  }

  /** Redeem a pairing code (public). Used for plugin self-bootstrap too. */
  async redeemPairing(params: { code: string; deviceName?: string }): Promise<PairRedeemResult> {
    const body = (await this.request("POST", "/pair/redeem", {
      auth: false,
      body: { code: params.code, device_name: params.deviceName },
    })) as Record<string, unknown>;
    return {
      gatewayUrl: String(body.gateway_url),
      userId: String(body.user_id),
      deviceId: String(body.device_id),
      accessToken: String(body.access_token),
      pluginId: typeof body.plugin_id === "string" ? body.plugin_id : undefined,
    };
  }

  /**
   * Check the version policy for this caller (PROTOCOL C.5.1). PUBLIC endpoint —
   * version policy is not secret and one endpoint serves apps + plugins, so it
   * carries no service token. The registrar semver-compares and returns the verdict.
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
      auth: false,
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

  /** Poll pairing completion (plugin → registrar, PROTOCOL C.3). */
  async getPairingStatus(code: string): Promise<PairStatusResult> {
    const body = (await this.request("GET", `/pair/status?code=${encodeURIComponent(code)}`, {
      auth: true,
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
    opts: { auth: boolean; body?: unknown; clientId?: string | null | undefined },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth) headers.Authorization = `Bearer ${this.serviceToken}`;
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

/** Decode the untrusted `redeems` array off a /pair/status body (C.3). */
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

/** PROTOCOL C.1: `ttl_seconds` upper bound — 63 072 000 s = 2 years. */
export const PAIR_CODE_TTL_MAX_SECONDS = 63_072_000;

/**
 * Generate a pairing code: **exactly 6 uniformly-random digits** (PROTOCOL C.1/C.2).
 * The registrar rejects anything that isn't 6 digits. `randomInt` is CSPRNG-backed
 * and unbiased (rejection-sampled internally), so there is no modulo skew.
 */
export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < 6; i += 1) code += String(randomInt(10));
  return code;
}
