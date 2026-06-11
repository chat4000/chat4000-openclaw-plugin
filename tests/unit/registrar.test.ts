import { describe, expect, it, vi } from "vitest";
import {
  RegistrarClient,
  RegistrarError,
  generatePairingCode,
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
  it("registerPairing posts code+plugin_id with bearer auth (PROTOCOL §3.1)", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com/",
      serviceToken: "svc-token",
      fetchImpl: mockFetch((url, init) => {
        captured = { url, init };
        return { status: 200, body: { ok: true, expires_at: 1700000000000 } };
      }),
    });

    const res = await client.registerPairing({
      code: "ABC-123",
      pluginId: "plugin-uuid",
      ttlSeconds: 300,
    });

    expect(res).toEqual({ ok: true, expiresAt: 1700000000000 });
    expect(captured?.url).toBe("https://registrar.chat4000.com/pair/register");
    expect((captured?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer svc-token",
    );
    expect(JSON.parse(bodyText(captured?.init.body))).toMatchObject({
      code: "ABC-123",
      plugin_id: "plugin-uuid",
      ttl_seconds: 300,
    });
  });

  it("redeemPairing is public (no auth) and maps the response (PROTOCOL §3.2)", async () => {
    let authHeader: string | undefined = "set";
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      serviceToken: "svc-token",
      fetchImpl: mockFetch((_url, init) => {
        authHeader = (init.headers as Record<string, string>).Authorization;
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

    const res = await client.redeemPairing({ code: "ABC-123" });

    expect(res).toEqual({
      gatewayUrl: "wss://gateway.chat4000.com/ws",
      userId: "@u_x:chat4000.com",
      deviceId: "DEV1",
      accessToken: "tok",
    });
    expect(authHeader).toBeUndefined();
  });

  it("getPairingStatus reports completion + user (PROTOCOL §3.3)", async () => {
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      serviceToken: "svc-token",
      fetchImpl: mockFetch((url) => {
        expect(url).toContain("/pair/status?code=ABC-123");
        return { status: 200, body: { status: "completed", user_id: "@u_x:chat4000.com" } };
      }),
    });

    const res = await client.getPairingStatus("ABC-123");
    expect(res).toEqual({ status: "completed", userId: "@u_x:chat4000.com", clientId: undefined });
  });

  it("getPairingStatus surfaces the redeeming phone's client_id when completed (FLW2)", async () => {
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      serviceToken: "svc-token",
      fetchImpl: mockFetch(() => ({
        status: 200,
        body: { status: "completed", user_id: "@u_x:chat4000.com", client_id: "phone-uuid" },
      })),
    });

    const res = await client.getPairingStatus("ABC-123");
    expect(res).toEqual({
      status: "completed",
      userId: "@u_x:chat4000.com",
      clientId: "phone-uuid",
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
      serviceToken: "svc-token",
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
      serviceToken: "svc-token",
      fetchImpl: mockFetch(() => ({
        status: 409,
        body: { errcode: "M_IN_USE", error: "code already in use" },
      })),
    });

    const err = await client.registerPairing({ code: "x", pluginId: "p" }).catch((e) => e);
    expect(err).toBeInstanceOf(RegistrarError);
    expect((err as RegistrarError).status).toBe(409);
    expect((err as RegistrarError).isConflict).toBe(true);
    expect((err as RegistrarError).errcode).toBe("M_IN_USE");
  });

  it("generatePairingCode returns exactly 6 digits (PROTOCOL C.1/C.2)", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generatePairingCode();
      expect(code).toMatch(/^[0-9]{6}$/);
    }
  });

  it("checkVersion POSTs /version (public) with app_id and maps the verdict (PROTOCOL C.5)", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = new RegistrarClient({
      baseUrl: "https://registrar.chat4000.com",
      serviceToken: "svc-token",
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
