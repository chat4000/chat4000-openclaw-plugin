/**
 * chat4000 v1 → v2 migration.
 *
 * v2 is a different protocol (custom relay → Matrix). Migration snapshots the v1
 * state, then provisions a v2 Matrix bot identity: it prefers credentials that
 * are already configured (env/config/file), else self-onboards by minting a
 * fresh bot via `POST /plugins` (PROTOCOL C.1). Either way it warns that v1
 * group-key history cannot cross to Megolm.
 *
 * Safety model (ported from /tmp/openclaw/extensions/matrix migration):
 *   detect → (snapshot, abort on failure) → provision → write config → warn.
 * Idempotent: no v1 state ⇒ no-op.
 */
import type { MatrixCredentials } from "../matrix/types.js";
import { provisionBot } from "../pairing/bot-identity.js";
import type { RegistrarClient } from "../pairing/registrar.js";
import { detectV1State } from "./detect.js";
import { createV1MigrationSnapshot } from "./snapshot.js";

export type MigrationResult = {
  migrated: boolean;
  reason?: string;
  snapshotDir?: string;
  credentials?: MatrixCredentials;
};

export async function runChat4000Migration(params: {
  accountId: string;
  /** v2 credentials already resolved for this account, if any. */
  existingCredentials: MatrixCredentials | null;
  /** Registrar + gateway URL for self-onboarding when no creds exist. */
  registrar: RegistrarClient | null;
  gatewayUrl: string;
  write: (line: string) => void;
  persistConfig: (credentials: MatrixCredentials) => Promise<void>;
}): Promise<MigrationResult> {
  const { accountId, existingCredentials, registrar, gatewayUrl, write, persistConfig } = params;

  const detection = detectV1State(accountId);
  if (!detection.present) {
    write(`No legacy chat4000 v1 state for account "${accountId}". Nothing to migrate.`);
    return { migrated: false, reason: "no-v1-state" };
  }

  write(`Found legacy v1 state for "${accountId}":`);
  for (const p of detection.paths) write(`  - ${p}`);

  // Snapshot before any mutation. Abort if it fails.
  const snapshot = createV1MigrationSnapshot({ accountId, paths: detection.paths });
  if (!snapshot.ok) {
    write(`✗ Could not create a pre-migration snapshot: ${snapshot.error}`);
    write("  Aborting migration so no state is lost. Resolve the error and retry.");
    return { migrated: false, reason: "snapshot-failed" };
  }
  write(`✓ Snapshot created: ${snapshot.archiveDir}`);

  write("");
  write("⚠ IMPORTANT: v1 messages encrypted under the old group key cannot be");
  write("  carried into v2 — Matrix uses a different encryption scheme (Megolm).");
  write("  Old history stays in the snapshot above but will not appear in the app.");
  write("");

  // Provision a v2 identity: prefer existing creds, else self-onboard.
  let credentials = existingCredentials;
  if (!credentials) {
    if (!registrar) {
      write("No v2 Matrix identity and no registrar configured. Provide a SERVICE_TOKEN");
      write("(--service-token / CHAT4000_SERVICE_TOKEN) to self-onboard, or run:");
      write(
        "  openclaw chat4000 setup --user-id <@plugin_x:hs> --access-token <t> --device-id <d>",
      );
      return { migrated: false, reason: "no-identity", snapshotDir: snapshot.archiveDir };
    }
    write("Self-onboarding a Matrix bot identity via the registrar...");
    const result = await provisionBot({ accountId, registrar, gatewayUrl });
    credentials = result.credentials;
    write(`✓ Matrix identity ready: ${credentials.userId}`);
  } else {
    write(`Using existing v2 Matrix identity: ${credentials.userId}`);
  }

  await persistConfig(credentials);
  write("✓ Wrote v2 (Matrix) channel config.");
  write("Pair a device next:  openclaw chat4000 pair");

  return { migrated: true, snapshotDir: snapshot.archiveDir, credentials };
}
