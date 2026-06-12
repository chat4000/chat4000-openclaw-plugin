/**
 * Environment presets for the chat4000 backend (PROTOCOL section 0 + README).
 *
 *   prod  — domain chat4000.com (TLS), host 87.99.156.216
 *   stage — domain stgcht4.duckdns.org (Duck DNS wildcard + LE wildcard cert,
 *           TLS), host 178.105.217.63 — no real user data
 *
 * Selecting an env fixes the registrar (pairing) + gateway (the single socket
 * the plugin's Matrix client tunnels through) URLs. There is deliberately **no
 * homeserver URL**: the homeserver has no public hostname (PROTOCOL section 0);
 * everything goes through the gateway.
 */

export type Chat4000Env = "prod" | "stage";

export type EnvEndpoints = {
  registrar: string;
  gateway: string;
};

// Static shared service token. It gates pairing-code registration, status
// polling, and plugin-version lookup (never content) — basic-auth-grade by
// design: it ships in the client, so treat it as public. Same default the
// Hermes plugin bakes in (registrar_config.py). Override with
// CHAT4000_SERVICE_TOKEN, --service-token, or provisioning.serviceToken.
export const DEFAULT_SERVICE_TOKEN = "chat4000_svc_72ee3b80a16f826a173c65450cadd107d5f6912d4d96135a";

export const ENV_ENDPOINTS: Record<Chat4000Env, EnvEndpoints> = {
  prod: {
    registrar: "https://registrar.chat4000.com",
    gateway: "wss://gateway.chat4000.com/ws",
  },
  stage: {
    registrar: "https://registrar.stgcht4.duckdns.org",
    gateway: "wss://gateway.stgcht4.duckdns.org/ws",
  },
};

function normalizeEnv(value: string | undefined): Chat4000Env | undefined {
  const v = value?.trim().toLowerCase();
  if (v === "stage" || v === "staging") return "stage";
  if (v === "prod" || v === "production") return "prod";
  return undefined;
}

/** Resolve env from an explicit flag, else CHAT4000_ENV, else prod. */
export function resolveEnv(flag?: string): Chat4000Env {
  return normalizeEnv(flag) ?? normalizeEnv(process.env.CHAT4000_ENV) ?? "prod";
}

export function endpointsForEnv(env: Chat4000Env): EnvEndpoints {
  return ENV_ENDPOINTS[env];
}
