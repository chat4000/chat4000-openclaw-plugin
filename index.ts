import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerChat4000Cli } from "./src/cli.js";
import { initializeChat4000Telemetry } from "./src/telemetry.js";

initializeChat4000Telemetry();

// Public surface (v2 — Matrix).
export { RegistrarClient, RegistrarError, generatePairingCode } from "./src/pairing/registrar.js";
export { configureIdentity, selfRedeemIdentity } from "./src/pairing/bot-identity.js";
export { createPairedRoom } from "./src/matrix/rooms.js";
export { checkUpdatePreflight, formatPreflight } from "./src/update/preflight.js";
export { applyUpdate, rollbackTo } from "./src/update/apply.js";
export { handleControlCommand, SUPPORTED_COMMANDS } from "./src/commands.js";
export { startHumanPairing, buildQrUri } from "./src/pairing/qr.js";
export { ENV_ENDPOINTS, resolveEnv, endpointsForEnv } from "./src/pairing/env.js";
export {
  loadMatrixCredentials,
  saveMatrixCredentials,
  deleteMatrixCredentials,
} from "./src/matrix/credentials.js";
export { resolveChat4000CredentialsPath, resolveChat4000AccountStateDir } from "./src/paths.js";

export default defineBundledChannelEntry({
  id: "chat4000",
  name: "chat4000",
  description: "chat4000 channel plugin (Matrix)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "chat4000Plugin",
  },
  registerCliMetadata: registerChat4000Cli,
});
