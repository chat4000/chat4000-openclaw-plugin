import { loadMatrixCredentials } from "./matrix/credentials.js";
import type {
  Chat4000Config,
  Chat4000ProvisioningConfig,
  ResolvedChat4000Account,
} from "./types.js";

type ChannelConfigInput = { channels?: Record<string, unknown> } | undefined;

function getChannelConfig(cfg: ChannelConfigInput): Chat4000Config {
  return (cfg ?? {}).channels?.["chat4000"] ?? {};
}

export function listChat4000AccountIds(cfg: ChannelConfigInput): string[] {
  const channelConfig = getChannelConfig(cfg);
  const accountIds = Object.keys(channelConfig.accounts ?? {});
  return accountIds.length > 0 ? accountIds : [channelConfig.defaultAccount ?? "default"];
}

export function getDefaultChat4000AccountId(cfg: ChannelConfigInput): string {
  const channelConfig = getChannelConfig(cfg);
  const accountIds = Object.keys(channelConfig.accounts ?? {});
  if (channelConfig.defaultAccount && accountIds.includes(channelConfig.defaultAccount)) {
    return channelConfig.defaultAccount;
  }
  return accountIds[0] ?? channelConfig.defaultAccount ?? "default";
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

function resolveProvisioning(merged: Chat4000Config): Chat4000ProvisioningConfig {
  const fromConfig = merged.provisioning ?? {};
  const url =
    trimmed(process.env.CHAT4000_REGISTRAR_URL) ||
    trimmed(process.env.CHAT4000_PROVISIONING_URL) ||
    trimmed(fromConfig.url) ||
    "";
  const serviceToken =
    trimmed(process.env.CHAT4000_SERVICE_TOKEN) ||
    trimmed(process.env.CHAT4000_PROVISIONING_API_KEY) ||
    trimmed(fromConfig.serviceToken) ||
    "";
  return {
    url: url || undefined,
    serviceToken: serviceToken || undefined,
  };
}

/**
 * Resolve a chat4000 account from OpenClaw config.
 *
 * Matrix identity precedence: env vars → channel/account config → the persisted
 * credentials file written by `setup`/`pair`.
 */
export function resolveChat4000Account(params: {
  cfg?: { channels?: Record<string, unknown> } | undefined;
  accountId?: string | null | undefined;
}): ResolvedChat4000Account {
  const channelConfig = getChannelConfig(params.cfg);
  const accountId = params.accountId ?? getDefaultChat4000AccountId(params.cfg);
  const accountOverrides = channelConfig.accounts?.[accountId] ?? {};
  const merged: Chat4000Config = { ...channelConfig, ...accountOverrides };

  const envGatewayUrl =
    trimmed(process.env.CHAT4000_GATEWAY_URL) || trimmed(process.env.CHAT4000_HOMESERVER);
  const envUserId = trimmed(process.env.CHAT4000_USER_ID);
  const envAccessToken = trimmed(process.env.CHAT4000_ACCESS_TOKEN);
  const envDeviceId = trimmed(process.env.CHAT4000_DEVICE_ID);

  const stored = loadMatrixCredentials(accountId);

  let gatewayUrl = "";
  let userId = "";
  let accessToken = "";
  let deviceId = "";
  let pluginId: string | undefined;
  let credentialSource: ResolvedChat4000Account["credentialSource"] = "missing";

  if (envGatewayUrl && envUserId && envAccessToken) {
    gatewayUrl = envGatewayUrl;
    userId = envUserId;
    accessToken = envAccessToken;
    deviceId = envDeviceId;
    credentialSource = "env";
  } else if (trimmed(merged.gatewayUrl) && trimmed(merged.userId) && trimmed(merged.accessToken)) {
    gatewayUrl = trimmed(merged.gatewayUrl);
    userId = trimmed(merged.userId);
    accessToken = trimmed(merged.accessToken);
    deviceId = trimmed(merged.deviceId);
    credentialSource = "config";
  } else if (stored) {
    gatewayUrl = stored.gatewayUrl;
    userId = stored.userId;
    accessToken = stored.accessToken;
    deviceId = stored.deviceId;
    pluginId = stored.pluginId;
    credentialSource = "state-file";
  }

  const configured = Boolean(gatewayUrl && userId && accessToken && deviceId);

  return {
    accountId,
    enabled: merged.enabled !== false,
    configured,
    pairingLogLevel: merged.pairingLogLevel === "debug" ? "debug" : "info",
    runtimeLogLevel: merged.runtimeLogLevel === "debug" ? "debug" : "info",
    gatewayUrl,
    userId,
    accessToken,
    deviceId,
    pluginId,
    credentialSource,
    provisioning: resolveProvisioning(merged),
    config: merged,
  };
}

/**
 * Whether the channel is pre-configured via env vars alone (used by the setup
 * wizard to detect a hands-off configuration).
 */
export function hasConfiguredState(env?: Record<string, string>): boolean {
  const gw = (env?.CHAT4000_GATEWAY_URL ?? env?.CHAT4000_HOMESERVER)?.trim();
  const uid = env?.CHAT4000_USER_ID?.trim();
  const token = env?.CHAT4000_ACCESS_TOKEN?.trim();
  return Boolean(gw && uid && token);
}
