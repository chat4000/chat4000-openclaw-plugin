/**
 * Plugin Matrix identity bootstrap (PROTOCOL C, section B).
 *
 * The plugin's identity IS its bot MXID — there is no separate `plugin_id`
 * (section B). Two supported paths:
 *
 *   A. Direct (configureIdentity): the operator supplies an existing bot login
 *      — gatewayUrl + userId (`@plugin_…`) + accessToken + deviceId. We persist it.
 *
 *   B. Self-onboard (provisionBot): PROTOCOL C.6 step 1 / C.1 — call
 *      `POST /plugins` with the SERVICE_TOKEN. The registrar mints a fresh
 *      `@plugin_…` account + its one durable device and returns
 *      `{ bot_user_id, bot_access_token, device_id, gateway_url }`; the bot
 *      MXID it returns IS the identity, and the bot access token is what the
 *      plugin runs on and what authenticates `PUT /user` / `POST /codes`
 *      afterwards (C.2/C.3.1).
 */
import { saveMatrixCredentials } from "../matrix/credentials.js";
import type { MatrixCredentials } from "../matrix/types.js";
import type { RegistrarClient } from "./registrar.js";

export type ProvisionBotResult = {
  credentials: MatrixCredentials;
  credentialsPath: string;
};

/** Path A — persist operator-supplied Matrix bot credentials. */
export function configureIdentity(params: {
  accountId: string;
  credentials: MatrixCredentials;
}): ProvisionBotResult {
  const credentialsPath = saveMatrixCredentials(params.accountId, params.credentials);
  return { credentials: params.credentials, credentialsPath };
}

/** Path B — self-onboard a bot identity via `POST /plugins` (PROTOCOL C.1, C.6 step 1). */
export async function provisionBot(params: {
  accountId: string;
  registrar: RegistrarClient;
  /** Fallback gateway URL (env preset) if the registrar somehow omits one. */
  gatewayUrl?: string;
}): Promise<ProvisionBotResult> {
  const minted = await params.registrar.createPlugin();
  const gatewayUrl = minted.gatewayUrl || params.gatewayUrl;
  if (!gatewayUrl) {
    throw new Error("registrar POST /plugins returned no gateway_url and no fallback was provided");
  }
  const credentials: MatrixCredentials = {
    gatewayUrl,
    userId: minted.botUserId,
    accessToken: minted.botAccessToken,
    deviceId: minted.deviceId,
  };
  const credentialsPath = saveMatrixCredentials(params.accountId, credentials);
  return { credentials, credentialsPath };
}
