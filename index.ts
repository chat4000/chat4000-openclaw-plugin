import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerChat4000Cli } from "./src/cli.js";
import { initializeChat4000Telemetry } from "./src/telemetry.js";
import { snapshotContainerRebuilt } from "./src/machine-ids.js";
import { registerFinalCardTool } from "./src/final-card-tool.js";

// IDN9 MUST be sampled before telemetry init mints the env-id file (its absence
// is the docker-rebuild signal). The gateway boot reads the snapshot and emits
// plugin_started / container_rebuilt (PL1/PL5) — see channel.ts.
snapshotContainerRebuilt();
initializeChat4000Telemetry();

// Public surface (v2 — Matrix).
export { RegistrarClient, RegistrarError, generatePairingCode } from "./src/pairing/registrar.js";
export { configureIdentity, provisionBot } from "./src/pairing/bot-identity.js";
export { setupPluginRooms } from "./src/matrix/rooms.js";
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
  // PROTOCOL E: register the `final_card` HTML-card tool on the full plugin API.
  registerFull: (api) => registerFinalCardTool(api),
});
