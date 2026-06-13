// ─── Plugin config (v2 — Matrix) ────────────────────────────────────────────

export type Chat4000ProvisioningConfig = {
  /** Registrar base URL, e.g. https://registrar.chat4000.com (PROTOCOL C). */
  url?: string | undefined;
  /** SERVICE_TOKEN bearer — gates ONLY `POST /plugins` (PROTOCOL C.1, C.4). */
  serviceToken?: string | undefined;
};

type Chat4000AccountConfig = {
  enabled?: boolean;
  pairingLogLevel?: "info" | "debug";
  runtimeLogLevel?: "info" | "debug";
  releaseChannel?: string;
  /** Backend environment preset: "prod" | "stage". */
  env?: string;
  /** WS gateway URL — normally written by `setup`, overridable by hand/env. */
  gatewayUrl?: string;
  userId?: string;
  accessToken?: string;
  deviceId?: string;
  provisioning?: Chat4000ProvisioningConfig;
  dmPolicy?: "open" | "pairing" | "disabled";
  allowFrom?: string[];
  textChunkLimit?: number;
  blockStreaming?: boolean;
  initialSyncLimit?: number;
};

export type Chat4000Config = Chat4000AccountConfig & {
  accounts?: Record<string, Chat4000AccountConfig>;
  defaultAccount?: string;
};

// ─── Resolved account ───────────────────────────────────────────────────────

export type ResolvedChat4000Account = {
  accountId: string;
  enabled: boolean;
  /** True once Matrix credentials (gatewayUrl/userId/accessToken/deviceId) exist. */
  configured: boolean;
  pairingLogLevel: "info" | "debug";
  runtimeLogLevel: "info" | "debug";
  /** WS gateway URL, resolved from credentials file → config → env. */
  gatewayUrl: string;
  /** The plugin's bot MXID — `@plugin_…`. This IS the plugin identity (section B). */
  userId: string;
  accessToken: string;
  deviceId: string;
  /** Where the credentials came from. */
  credentialSource: "state-file" | "config" | "env" | "missing";
  /** Resolved registrar settings (url + serviceToken), if configured. */
  provisioning: Chat4000ProvisioningConfig;
  config: Chat4000AccountConfig;
};
