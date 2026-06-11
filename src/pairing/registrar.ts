/**
 * HTTP client for the chat4000 Registrar (PROTOCOL §3).
 *
 *   POST /pair/register  (bearer SERVICE_TOKEN)  { code, plugin_id, user_id?, ttl_seconds? }
 *                                                -> { ok, expires_at }
 *   POST /pair/redeem    (public; code is secret) { code, device_name? }
 *                                                -> { gateway_url, user_id, device_id, access_token }
 *   GET  /pair/status?code=...  (bearer)         -> { status: pending|completed|expired, user_id? }
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

export type PairStatusResult = {
  status: PairStatus;
  userId?: string | undefined;
  /**
   * FLW2: the redeeming phone's analytics `client_id`, present on `completed`
   * when the phone sent one (absent on old registrars / telemetry-off phones).
   */
  clientId?: string | undefined;
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
   * Reserve a pairing code (PROTOCOL §3.1). `kind="user"` (default) requires a
   * `pluginId` (which plugin the user pairs with); `kind="plugin"` omits it (the
   * registrar issues a new plugin_id at redeem).
   */
  async registerPairing(params: {
    code: string;
    kind?: PairKind | undefined;
    pluginId?: string | undefined;
    userId?: string | undefined;
    ttlSeconds?: number | undefined;
  }): Promise<PairRegisterResult> {
    const body = (await this.request("POST", "/pair/register", {
      auth: true,
      body: {
        code: params.code,
        kind: params.kind,
        plugin_id: params.pluginId,
        user_id: params.userId,
        ttl_seconds: params.ttlSeconds,
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

  /** Poll pairing completion (plugin → registrar). */
  async getPairingStatus(code: string): Promise<PairStatusResult> {
    const body = (await this.request("GET", `/pair/status?code=${encodeURIComponent(code)}`, {
      auth: true,
    })) as Record<string, unknown>;
    return {
      status: String(body.status) as PairStatus,
      userId: typeof body.user_id === "string" ? body.user_id : undefined,
      clientId: typeof body.client_id === "string" ? body.client_id : undefined,
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

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

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
