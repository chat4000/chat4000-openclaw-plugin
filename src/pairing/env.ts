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
