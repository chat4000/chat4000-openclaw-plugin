import { describe, expect, it, vi } from "vitest";
import {
  RegistrarClient,
  RegistrarError,
  generatePairingCode,
  isTransientRegistrarError,
  type PairRedeem,
} from "../../src/pairing/registrar.js";

/** The request body in these tests is always a JSON string we set ourselves. */
function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") throw new Error("expected a string request body");
  return body;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function mockFetch(
  handler: (url: string, init: RequestInit) => { status: number; body: unknown },
): typeof fetch {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const { status, body } = handler(urlOf(input), init ?? {});
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
}

describe("RegistrarClient", () => {
  it("createPlugin POSTs /plugins with the SERVICE token and maps the bot identity (PROTOCOL C.1)", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com/",
      serviceToken: "svc-token",
      fetchImpl: mockFetch((url, init) => {
        captured = { url, init };
        return {
          status: 200,
          body: {
            bot_user_id: "@plugin_x:chat4000.com",
            bot_access_token: "bot-token",
            device_id: "BOTDEV",
            gateway_url: "wss://gateway.chat4000.com/ws",
          },
        };
      }),
    });

    const res = await client.createPlugin();
    expect(res).toEqual({
      botUserId: "@plugin_x:chat4000.com",
      botAccessToken: "bot-token",
      deviceId: "BOTDEV",
      gatewayUrl: "wss://gateway.chat4000.com/ws",
    });
    expect(captured?.url).toBe("https://registrar.chat4000.com/plugins");
    expect((captured?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer svc-token",
    );
    // Empty body (PROTOCOL C.1).
    expect(JSON.parse(bodyText(captured?.init.body))).toEqual({});
  });

  it("createPlugin without a service token throws before any fetch (C.4)", async () => {
    const fetchImpl = vi.fn();
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      botAccessToken: "bot-token",
      fetchImpl,
    });
    await expect(client.createPlugin()).rejects.toThrow(/SERVICE_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ensureUser PUTs /user with the BOT token and an empty body, maps the result (PROTOCOL C.2)", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      botAccessToken: "bot-token",
      fetchImpl: mockFetch((url, init) => {
        captured = { url, init };
        return { status: 200, body: { user_id: "@u_x:chat4000.com", created: true } };
      }),
    });

    const res = await client.ensureUser();
    expect(res).toEqual({ userId: "@u_x:chat4000.com", created: true });
    expect(captured?.init.method).toBe("PUT");
    expect(captured?.url).toBe("https://registrar.chat4000.com/user");
    // Bot token, NOT the service token (C.2/C.4).
    expect((captured?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer bot-token",
    );
    expect(JSON.parse(bodyText(captured?.init.body))).toEqual({});
  });

  it("ensureUser without a bot token throws before any fetch (C.4)", async () => {
    const fetchImpl = vi.fn();
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      serviceToken: "svc-token",
      fetchImpl,
    });
    await expect(client.ensureUser()).rejects.toThrow(/bot access token/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("mintCode POSTs /codes with the BOT token; no kind/user_id/plugin_id (PROTOCOL C.3.1)", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      botAccessToken: "bot-token",
      fetchImpl: mockFetch((url, init) => {
        captured = { url, init };
        return { status: 200, body: { ok: true, expires_at: 1700000000000 } };
      }),
    });

    const res = await client.mintCode({ code: "428913", ttlSeconds: 300 });
    expect(res).toEqual({ ok: true, expiresAt: 1700000000000 });
    expect(captured?.url).toBe("https://registrar.chat4000.com/codes");
    expect((captured?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer bot-token",
    );
    const body = JSON.parse(bodyText(captured?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ code: "428913", ttl_seconds: 300 });
    expect(body).not.toHaveProperty("kind");
    expect(body).not.toHaveProperty("user_id");
    expect(body).not.toHaveProperty("plugin_id");
  });

  it("mintCode passes reusable + a 2-year ttl through; omits reusable when absent (C.3.1)", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      botAccessToken: "bot-token",
      fetchImpl: mockFetch((url, init) => {
        captured = { url, init };
        return { status: 200, body: { ok: true, expires_at: 1750000000000 } };
      }),
    });

    await client.mintCode({ code: "428913", ttlSeconds: 63_072_000, reusable: true });
    expect(JSON.parse(bodyText(captured?.init.body))).toEqual({
      code: "428913",
      ttl_seconds: 63_072_000,
      reusable: true,
    });

    // Single-use semantics unchanged when the flag is absent (C.3.1).
    await client.mintCode({ code: "428913" });
    expect(JSON.parse(bodyText(captured?.init.body))).not.toHaveProperty("reusable");
  });

  it("redeemPairing is public, posts code in the PATH (no auth) and maps the response (C.3.2)", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      botAccessToken: "bot-token",
      fetchImpl: mockFetch((url, init) => {
        captured = { url, init };
        return {
          status: 200,
          body: {
            gateway_url: "wss://gateway.chat4000.com/ws",
            user_id: "@u_x:chat4000.com",
            device_id: "DEV1",
            access_token: "tok",
          },
        };
      }),
    });

    const res = await client.redeemPairing({ code: "428913", deviceName: "phone" });

    expect(res).toEqual({
      gatewayUrl: "wss://gateway.chat4000.com/ws",
      userId: "@u_x:chat4000.com",
      deviceId: "DEV1",
      accessToken: "tok",
    });
    // Code in the path; no Authorization header on the public redeem (C.3.2/C.4).
    expect(captured?.url).toBe("https://registrar.chat4000.com/codes/428913/redeem");
    expect((captured?.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(bodyText(captured?.init.body))).toEqual({ device_name: "phone" });
  });

  it("getPairingStatus GETs /codes/{code} with the BOT token + reports completion (C.3.3)", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      botAccessToken: "bot-token",
      fetchImpl: mockFetch((url, init) => {
        captured = { url, init };
        return { status: 200, body: { status: "completed", user_id: "@u_x:chat4000.com" } };
      }),
    });

    const res = await client.getPairingStatus("428913");
    expect(captured?.url).toBe("https://registrar.chat4000.com/codes/428913");
    expect((captured?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer bot-token",
    );
    expect(res).toEqual({
      status: "completed",
      userId: "@u_x:chat4000.com",
      clientId: undefined,
      redeems: [],
      redeemedCount: 0,
      expiresAt: undefined,
    });
  });

  it("getPairingStatus surfaces the redeeming phone's client_id when completed (FLW2)", async () => {
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      botAccessToken: "bot-token",
      fetchImpl: mockFetch(() => ({
        status: 200,
        body: { status: "completed", user_id: "@u_x:chat4000.com", client_id: "phone-uuid" },
      })),
    });

    const res = await client.getPairingStatus("428913");
    expect(res).toEqual({
      status: "completed",
      userId: "@u_x:chat4000.com",
      clientId: "phone-uuid",
      redeems: [],
      redeemedCount: 0,
      expiresAt: undefined,
    });
  });

  it("getPairingStatus maps redeems[] + redeemed_count + expires_at (PROTOCOL C.3.3)", async () => {
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      botAccessToken: "bot-token",
      fetchImpl: mockFetch(() => ({
        status: 200,
        body: {
          // Reusable codes stay `pending` however many redeems they have.
          status: "pending",
          user_id: "@u_x:chat4000.com",
          client_id: "phone-2",
          redeems: [
            { device_id: "DEV1", client_id: "phone-1", redeemed_at: 1700000001000 },
            { device_id: "DEV2", redeemed_at: 1700000002000 },
            "garbage", // tolerated: non-object entries are skipped
          ],
          redeemed_count: 25,
          expires_at: 1750000000000,
        },
      })),
    });

    const res = await client.getPairingStatus("428913");
    const expectedRedeems: PairRedeem[] = [
      { deviceId: "DEV1", clientId: "phone-1", redeemedAt: 1700000001000 },
      { deviceId: "DEV2", clientId: undefined, redeemedAt: 1700000002000 },
    ];
    expect(res).toEqual({
      status: "pending",
      userId: "@u_x:chat4000.com",
      clientId: "phone-2",
      redeems: expectedRedeems,
      redeemedCount: 25,
      expiresAt: 1750000000000,
    });
  });

  it("checkVersion sends X-Client-Id when a clientId is given, omits it otherwise (PL3)", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = mockFetch((_url, init) => {
      captured = init;
      return { status: 200, body: { action: "ok" } };
    });
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      fetchImpl,
    });

    await client.checkVersion({
      appId: "@chat4000/openclaw-plugin",
      clientVersion: "1.9.0",
      releaseChannel: "stage",
      clientId: "agent-install-id-123",
    });
    expect((captured?.headers as Record<string, string>)["X-Client-Id"]).toBe(
      "agent-install-id-123",
    );

    // Telemetry off → caller passes null → header omitted, and no posthog_id body.
    await client.checkVersion({
      appId: "@chat4000/openclaw-plugin",
      clientVersion: "1.9.0",
      releaseChannel: "stage",
      clientId: null,
    });
    expect((captured?.headers as Record<string, string>)["X-Client-Id"]).toBeUndefined();
    expect(JSON.parse(bodyText(captured?.body))).not.toHaveProperty("posthog_id");
  });

  it("surfaces {errcode,error} as RegistrarError with status flags", async () => {
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      botAccessToken: "bot-token",
      fetchImpl: mockFetch(() => ({
        status: 409,
        body: { errcode: "M_CODE_IN_USE", error: "code already in use" },
      })),
    });

    const err = await client.mintCode({ code: "428913" }).catch((e) => e);
    expect(err).toBeInstanceOf(RegistrarError);
    expect((err as RegistrarError).status).toBe(409);
    expect((err as RegistrarError).isConflict).toBe(true);
    expect((err as RegistrarError).errcode).toBe("M_CODE_IN_USE");
  });

  it("classifies 429/502/503/504 as transient and other 4xx as permanent", () => {
    // Live failure 2026-06-12: status polling answered 429 M_LIMIT_EXCEEDED and
    // pairing died — these must be retried by the status-polling paths.
    for (const status of [429, 502, 503, 504]) {
      const error = new RegistrarError("try later", status, "M_LIMIT_EXCEEDED");
      expect(error.isTransient).toBe(true);
      expect(isTransientRegistrarError(error)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 410]) {
      const error = new RegistrarError("permanent", status);
      expect(error.isTransient).toBe(false);
      expect(isTransientRegistrarError(error)).toBe(false);
    }
  });

  it("classifies connection-level failures (non-RegistrarError) as transient", () => {
    // What `fetch` throws on DNS failure / refused connection / timeout abort.
    expect(isTransientRegistrarError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientRegistrarError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("generatePairingCode returns exactly 6 digits (PROTOCOL C.3/C.4)", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[0-9]{6}$/);
    }
  });

  it("checkVersion POSTs /version (public) with app_id and maps the verdict (PROTOCOL C.5)", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      fetchImpl: mockFetch((url, init) => {
        captured = { url, init };
        return {
          status: 200,
          body: {
            action: "force_upgrade",
            min_version: "2.0.0",
            min_nag: null,
            recommended: "2.1.0",
            current_terms_version: 3,
            message: "please upgrade",
          },
        };
      }),
    });

    const res = await client.checkVersion({
      appId: "@chat4000/openclaw-plugin",
      clientVersion: "1.9.0",
      releaseChannel: "stage",
      platform: "macos",
    });

    expect(captured?.url).toBe("https://registrar.chat4000.com/version");
    // Public endpoint — no bearer token.
    expect((captured?.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(bodyText(captured?.init.body))).toMatchObject({
      app_id: "@chat4000/openclaw-plugin",
      client_version: "1.9.0",
      release_channel: "stage",
    });
    expect(res).toEqual({
      action: "force_upgrade",
      minVersion: "2.0.0",
      minNag: null,
      recommended: "2.1.0",
      currentTermsVersion: 3,
      message: "please upgrade",
    });
  });
});
