import process, { stdout as output } from "node:process";
import { rmSync } from "node:fs";
import { resolveChat4000Account } from "./accounts.js";
import { dumpChat4000Trace } from "./error-log.js";
import { deleteMatrixCredentials } from "./matrix/credentials.js";
import type { MatrixCredentials } from "./matrix/types.js";
import { configureIdentity, selfRedeemIdentity } from "./pairing/bot-identity.js";
import { setupPluginRooms } from "./matrix/rooms.js";
import { endpointsForEnv, resolveEnv, type Chat4000Env } from "./pairing/env.js";
import { getOrCreatePluginId } from "./pairing/instance.js";
import {
  addOutstandingCode,
  recordRedeemedDevices,
  removeOutstandingCode,
} from "./pairing/outstanding-codes.js";
import {
  isTransientRegistrarError,
  PAIR_CODE_TTL_MAX_SECONDS,
  redeemIndexOf,
  RegistrarClient,
  RegistrarError,
  type EnsureUserResult,
  type PairStatusResult,
} from "./pairing/registrar.js";
import { checkPluginVersion, formatVersionNotice } from "./pairing/version-check.js";
import { renderQr, startHumanPairing } from "./pairing/qr.js";
import { resolveChat4000AccountStateDir } from "./paths.js";
import {
  clearChat4000SessionBinding,
  findOpenClawSessionCandidate,
  getChat4000SessionBinding,
  listOpenClawSessionCandidates,
  setChat4000SessionBinding,
} from "./session-binding.js";
import { detectV1State } from "./migration/detect.js";
import { runChat4000Migration } from "./migration/migrate.js";
import { applyUpdate } from "./update/apply.js";
import { checkUpdatePreflight, formatPreflight } from "./update/preflight.js";
import {
  captureChat4000TestException,
  getTelemetryStatus,
  setTelemetryEnabled,
} from "./telemetry.js";
import { flushAnalytics, registerPairedClientId, track } from "./analytics.js";
import { buildWizardEnvSummary, runWizard } from "./wizard.js";

/**
 * Minimal structural view of the Commander `Command` the host passes in. Only
 * the chainable methods this CLI uses are declared; each returns a `CliCommand`
 * so the builder chains stay fully typed (no `any` at the call sites).
 */
type CliCommand = {
  command: (name: string, opts?: { hidden?: boolean }) => CliCommand;
  description: (text: string) => CliCommand;
  option: (flags: string, description?: string, defaultValue?: string) => CliCommand;
  action: <A extends unknown[]>(handler: (...args: A) => void | Promise<void>) => CliCommand;
};

type PluginApiLike = {
  config?: Record<string, unknown>;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  runtime?: {
    config?: {
      loadConfig?: () => Record<string, unknown>;
      writeConfigFile?: (nextConfig: Record<string, unknown>) => Promise<void>;
    };
  };
  registerCli?: (
    registrar: (ctx: {
      program: CliCommand;
      config: Record<string, unknown>;
      workspaceDir?: string;
    }) => void,
    opts?: {
      commands?: string[];
      descriptors?: Array<{ name: string; description: string; hasSubcommands: boolean }>;
    },
  ) => void;
};

type SetupCommandOptions = {
  account?: string;
  env?: string;
  stage?: boolean;
  registrarUrl?: string;
  serviceToken?: string;
  gatewayUrl?: string;
  userId?: string;
  accessToken?: string;
  deviceId?: string;
  selfRedeem?: boolean;
  pairingLogLevel?: "info" | "debug";
  runtimeLogLevel?: "info" | "debug";
  noPair?: boolean;
  pair?: boolean;
};

type PairCommandOptions = {
  account?: string;
  env?: string | undefined;
  stage?: boolean | undefined;
  registrarUrl?: string;
  serviceToken?: string;
  ttl?: string;
  reusable?: boolean | undefined;
};

type WizardCommandOptions = {
  account?: string;
  env?: string;
  stage?: boolean;
  registrarUrl?: string;
  serviceToken?: string;
  gatewayUrl?: string;
  ttl?: string;
  pairingLogLevel?: "info" | "debug";
  runtimeLogLevel?: "info" | "debug";
};

type MigrateCommandOptions = {
  account?: string;
  env?: string;
  stage?: boolean;
  registrarUrl?: string;
  serviceToken?: string;
  gatewayUrl?: string;
};

type SessionBindingOptions = {
  account?: string;
  room?: string;
  sessionKey?: string;
};

type UpdateCommandOptions = {
  check?: boolean;
  apply?: boolean;
  restart?: boolean;
  version?: string;
  force?: boolean;
  json?: boolean;
};

export function registerChat4000Cli(api: PluginApiLike): void {
  api.registerCli?.(
    ({ program }) => {
      const chat4000 = program
        .command("chat4000")
        .description("Manage chat4000 (Matrix) setup, pairing, and migration")
        .option("--no-telemetry", "Disable anonymous error reporting for this run");

      chat4000
        .command("setup")
        .description("Configure this agent's Matrix identity and (optionally) pair a device")
        .option("--account <id>", "Account id", "default")
        .option("--env <name>", "Backend environment: prod | stage")
        .option("--stage", "Shortcut for --env stage")
        .option("--registrar-url <url>", "Registrar base URL (overrides env preset)")
        .option("--service-token <token>", "Registrar SERVICE_TOKEN")
        .option("--gateway-url <url>", "WS gateway URL (overrides env preset)")
        .option("--user-id <id>", "Matrix bot user id, e.g. @plugin_x:chat4000.com")
        .option("--access-token <token>", "Matrix bot access token")
        .option("--device-id <id>", "Matrix bot device id")
        .option("--self-redeem", "Self-onboard a bot identity via a kind=plugin registrar code")
        .option("--pairing-log-level <level>", "Pairing log level (info|debug)")
        .option("--runtime-log-level <level>", "Runtime log level (info|debug)")
        .option("--no-pair", "Configure identity without starting device pairing")
        .action(async (opts: SetupCommandOptions) => {
          await runSetup(api, opts).catch(handleCliError);
        });

      chat4000
        .command("pair")
        .description("Pair a chat4000 iOS/macOS device (prints a code + QR to redeem)")
        .option("--account <id>", "Account id", "default")
        .option("--env <name>", "Backend environment: prod | stage")
        .option("--stage", "Shortcut for --env stage")
        .option("--registrar-url <url>", "Registrar base URL (overrides env preset)")
        .option("--service-token <token>", "Registrar SERVICE_TOKEN")
        .option(
          "--ttl <seconds>",
          "Pairing code lifetime in seconds (up to 63072000 = 2 years)",
          "300",
        )
        .option(
          "--reusable",
          "Code can be redeemed many times until expiry, each redeem adding a device",
        )
        .action(async (opts: PairCommandOptions) => {
          await runPair(api, opts).catch(handleCliError);
        });

      chat4000
        .command("wizard")
        .description("Guided install: mint identity, (re)start the gateway, and pair a device")
        .option("--account <id>", "Account id", "default")
        .option("--env <name>", "Backend environment: prod | stage")
        .option("--stage", "Shortcut for --env stage")
        .option("--registrar-url <url>", "Registrar base URL (overrides env preset)")
        .option("--service-token <token>", "Registrar SERVICE_TOKEN")
        .option("--gateway-url <url>", "WS gateway URL (overrides env preset)")
        .option("--ttl <seconds>", "Pairing code lifetime in seconds", "300")
        .option("--pairing-log-level <level>", "Pairing log level (info|debug)")
        .option("--runtime-log-level <level>", "Runtime log level (info|debug)")
        .action(async (opts: WizardCommandOptions) => {
          await runWizardCommand(api, opts).catch(handleCliError);
        });

      chat4000
        .command("status")
        .description("Show current chat4000 channel status")
        .option("--account <id>", "Account id", "default")
        .action((opts: { account?: string }) => {
          const cfg = loadConfig(api);
          const account = resolveChat4000Account({
            cfg,
            accountId: opts.account,
          });
          const v1 = detectV1State(account.accountId);
          output.write(
            [
              `account: ${account.accountId}`,
              `gateway: ${account.gatewayUrl || "(missing)"}`,
              `user id: ${account.userId || "(missing)"}`,
              `device id: ${account.deviceId || "(missing)"}`,
              `plugin id: ${account.pluginId ?? "(unset)"}`,
              `credential source: ${account.credentialSource}`,
              `registrar: ${account.provisioning.url ?? "(unset)"}`,
              `configured: ${account.configured ? "yes" : "no"}`,
              ...(v1.present
                ? ['⚠ legacy v1 state detected — run "openclaw chat4000 migrate"']
                : []),
            ].join("\n") + "\n",
          );
        });

      chat4000
        .command("migrate")
        .description("Upgrade a v1 (relay) install to v2 (Matrix). Snapshots v1 state first.")
        .option("--account <id>", "Account id", "default")
        .option("--env <name>", "Backend environment: prod | stage")
        .option("--stage", "Shortcut for --env stage")
        .option("--registrar-url <url>", "Registrar base URL (overrides env preset)")
        .option("--service-token <token>", "Registrar SERVICE_TOKEN")
        .option("--gateway-url <url>", "WS gateway URL (overrides env preset)")
        .action(async (opts: MigrateCommandOptions) => {
          await runMigrate(api, opts).catch(handleCliError);
        });

      chat4000
        .command("update")
        .description("Check for or apply a plugin self-update")
        .option("--check", "Only run the read-only preflight (no changes made)")
        .option("--apply", "Apply the update (install the latest version)")
        .option("--restart", "Restart the gateway after applying so the new code loads")
        .option("--version <v>", "Install this exact version instead of the latest")
        .option("--force", "Apply even if the preflight reports a blocker")
        .option("--json", "Emit the result as JSON")
        .action(async (opts: UpdateCommandOptions) => {
          await runUpdate(opts).catch(handleCliError);
        });

      chat4000
        .command("reset")
        .description(
          "Wipe local Matrix credentials + crypto/sync state for an account. Re-run setup after.",
        )
        .option("--account <id>", "Account id", "default")
        .action((opts: { account?: string }) => {
          runReset(opts.account);
        });

      const sessions = chat4000
        .command("sessions")
        .description("Inspect and bind chat4000 rooms to existing OpenClaw sessions");

      sessions
        .command("list")
        .description("List recent OpenClaw sessions that chat4000 can join")
        .option("--account <id>", "Account id", "default")
        .option("--limit <n>", "Max sessions to show", "20")
        .action((opts: { account?: string; limit?: string }) => {
          runSessionAction(() => runListSessions(api, opts));
        });

      sessions
        .command("bind")
        .description("Bind a chat4000 room to an existing OpenClaw session key")
        .option("--account <id>", "Account id", "default")
        .option("--room <roomId>", "Matrix room id (e.g. !abc:chat4000.com)")
        .option("--session-key <value>", "Existing OpenClaw session key to join")
        .action((opts: SessionBindingOptions) => {
          runSessionAction(() => runBindSession(api, opts));
        });

      sessions
        .command("current")
        .description("Show the chat4000 session binding for a room")
        .option("--account <id>", "Account id", "default")
        .option("--room <roomId>", "Matrix room id")
        .action((opts: SessionBindingOptions) => {
          runSessionAction(() => runShowBinding(api, opts));
        });

      sessions
        .command("clear")
        .description("Clear the chat4000 session binding for a room")
        .option("--account <id>", "Account id", "default")
        .option("--room <roomId>", "Matrix room id")
        .action((opts: SessionBindingOptions) => {
          runSessionAction(() => runClearBinding(api, opts));
        });

      const telemetry = chat4000
        .command("telemetry")
        .description("Manage anonymous error reporting");

      telemetry
        .command("status")
        .description("Show telemetry status")
        .action(() => {
          const status = getTelemetryStatus();
          output.write(`Telemetry: ${status.enabled ? "enabled" : "disabled"}\n`);
          if (status.enabled) {
            output.write("  Disable: openclaw chat4000 telemetry disable\n");
            output.write("  Or set CHAT4000_TELEMETRY_DISABLED=1\n");
          } else {
            output.write(`  Source: ${status.reason}\n`);
            output.write("  Enable: openclaw chat4000 telemetry enable\n");
          }
        });

      telemetry
        .command("disable")
        .description("Disable telemetry persistently")
        .action(() => {
          setTelemetryEnabled(false);
          output.write("Telemetry disabled. No data will be sent to chat4000.\n");
        });

      telemetry
        .command("enable")
        .description("Enable telemetry persistently")
        .action(() => {
          setTelemetryEnabled(true);
          output.write("Telemetry enabled. Anonymous error reports will be sent.\n");
          output.write("Privacy policy: https://chat4000.com/privacy\n");
        });

      telemetry
        .command("test-exception", { hidden: true })
        .description("Send a test exception to Sentry")
        .action(async () => {
          const sent = await captureChat4000TestException();
          output.write(
            sent ? "Telemetry test exception sent.\n" : "Telemetry test exception not sent.\n",
          );
        });
    },
    {
      commands: ["chat4000"],
      descriptors: [
        {
          name: "chat4000",
          description: "Manage chat4000 (Matrix) setup, pairing, and migration",
          hasSubcommands: true,
        },
      ],
    },
  );
}

// ─── Endpoint resolution (env preset + overrides) ────────────────────────────

type EndpointOpts = {
  env?: string | undefined;
  stage?: boolean | undefined;
  registrarUrl?: string | undefined;
  serviceToken?: string | undefined;
  gatewayUrl?: string | undefined;
};

function resolveSelectedEnv(opts: EndpointOpts): Chat4000Env {
  return resolveEnv(opts.stage ? "stage" : opts.env);
}

function resolveRegistrar(
  account: ReturnType<typeof resolveChat4000Account>,
  opts: EndpointOpts,
): { client: RegistrarClient; url: string } {
  const env = resolveSelectedEnv(opts);
  const preset = endpointsForEnv(env);
  const url = opts.registrarUrl?.trim() || account.provisioning.url || preset.registrar;
  const serviceToken = opts.serviceToken?.trim() || account.provisioning.serviceToken;
  if (!serviceToken) {
    throw new Error(
      "Missing registrar SERVICE_TOKEN. Pass --service-token, set " +
        "channels.chat4000.provisioning.serviceToken, or CHAT4000_SERVICE_TOKEN.",
    );
  }
  return { client: new RegistrarClient({ baseUrl: url, serviceToken }), url };
}

function resolveGatewayUrl(
  account: ReturnType<typeof resolveChat4000Account>,
  opts: EndpointOpts,
): string {
  const env = resolveSelectedEnv(opts);
  return opts.gatewayUrl?.trim() || account.gatewayUrl || endpointsForEnv(env).gateway;
}

/**
 * PROTOCOL C.5: before a privileged /pair/* call, check the version policy.
 * `force_upgrade` aborts the command; `recommend_upgrade` warns and continues.
 * A failed/unreachable check never blocks (fail-open) — it's advisory.
 */
async function enforceVersionBeforePrivileged(
  registrar: RegistrarClient,
  releaseChannel: string | undefined,
): Promise<void> {
  let verdict;
  try {
    verdict = await checkPluginVersion({ registrar, releaseChannel });
  } catch {
    return; // advisory only — don't block onboarding on a check failure
  }
  const notice = formatVersionNotice(verdict);
  if (verdict.action === "force_upgrade") {
    throw new Error(notice ?? "this plugin version must be upgraded before pairing");
  }
  if (notice) output.write(`⚠ ${notice}\n`);
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function runSetup(api: PluginApiLike, opts: SetupCommandOptions): Promise<void> {
  const cfg = loadConfig(api);
  const account = resolveChat4000Account({
    cfg,
    accountId: opts.account,
  });
  const env = resolveSelectedEnv(opts);
  const gatewayUrl = resolveGatewayUrl(account, opts);

  // PROTOCOL C.6: setup is bot self-onboard (step 1) → /user/ensure (step 2) →
  // rooms + invites over a short-lived bot session (step 3). Steps 2+3 run on
  // BOTH identity paths, so the registrar client is resolved up front; the C.5
  // version policy is checked once, right before the first privileged call.
  const { client: registrarClient } = resolveRegistrar(account, opts);
  let versionChecked = false;
  const checkVersionOnce = async (): Promise<void> => {
    if (versionChecked) return;
    versionChecked = true;
    await enforceVersionBeforePrivileged(registrarClient, account.config.releaseChannel);
  };

  // Bot identity: either operator-supplied direct credentials, or self-onboard
  // via a kind=plugin registrar code (PROTOCOL C) — C.6 step 1.
  const directUserId = opts.userId?.trim() || account.userId;
  const directToken = opts.accessToken?.trim() || account.accessToken;
  const directDeviceId = opts.deviceId?.trim() || account.deviceId;

  let credentials: MatrixCredentials;
  let credentialsPath: string;

  if (directUserId && directToken && directDeviceId) {
    const result = configureIdentity({
      accountId: account.accountId,
      credentials: {
        gatewayUrl,
        userId: directUserId,
        accessToken: directToken,
        deviceId: directDeviceId,
        pluginId: account.pluginId ?? getOrCreatePluginId(account.accountId),
      },
    });
    credentials = result.credentials;
    credentialsPath = result.credentialsPath;
    output.write(`✓ Configured Matrix identity: ${credentials.userId}\n`);
  } else if (opts.selfRedeem) {
    await checkVersionOnce();
    output.write(`Self-onboarding a Matrix bot identity via the registrar (${env})...\n`);
    const result = await selfRedeemIdentity({
      accountId: account.accountId,
      registrar: registrarClient,
      gatewayUrl,
    });
    credentials = result.credentials;
    credentialsPath = result.credentialsPath;
    output.write(`✓ Matrix identity ready: ${credentials.userId}\n`);
  } else {
    throw new Error(
      "Provide either --self-redeem (with --service-token / --env), or direct bot " +
        "credentials: --user-id --access-token --device-id (and --gateway-url or --env). " +
        "Env vars CHAT4000_USER_ID / CHAT4000_ACCESS_TOKEN / CHAT4000_DEVICE_ID also work.",
    );
  }
  output.write(`  Credentials: ${credentialsPath}\n`);

  // PROTOCOL C.6 step 2: create (or get) the plugin's ONE user. Idempotent per
  // plugin_id — re-running setup returns the same user, never a second one.
  await checkVersionOnce();
  const pluginId = credentials.pluginId ?? getOrCreatePluginId(account.accountId);
  let ensured: EnsureUserResult;
  try {
    ensured = await registrarClient.ensureUser({ pluginId });
  } catch (err) {
    if (err instanceof RegistrarError && err.status === 400) {
      throw new Error(
        `registrar rejected plugin_id ${pluginId}: ${err.message}. The registrar only ` +
          "knows plugin ids it issued at a kind=plugin redeem — re-run " +
          '"openclaw chat4000 setup --self-redeem" to mint a registrar-issued identity.',
      );
    }
    throw err;
  }
  output.write(`✓ Plugin user ${ensured.created ? "created" : "ready"}: ${ensured.userId}\n`);

  // PROTOCOL C.6 step 3: short-lived bot session creates the space + control
  // room and invites the user to both — BEFORE any device pairs. No key
  // pre-sharing, ever (single-crypto-owner rule). Idempotent on re-run.
  const rooms = await setupPluginRooms({
    credentials,
    accountId: account.accountId,
    pluginName: "chat4000",
    userId: ensured.userId,
  });
  output.write(
    `✓ Space + control room ready (${rooms.spaceId}, ${rooms.controlRoomId}); ` +
      `invited ${ensured.userId} to both.\n`,
  );

  await writeChannelConfig(api, {
    accountId: account.accountId,
    env,
    pairingLogLevel: normalizeLogLevel(opts.pairingLogLevel ?? account.pairingLogLevel),
    runtimeLogLevel: normalizeLogLevel(opts.runtimeLogLevel ?? account.runtimeLogLevel),
    gatewayUrl: credentials.gatewayUrl,
    userId: credentials.userId,
    deviceId: credentials.deviceId,
    registrarUrl:
      opts.registrarUrl?.trim() || account.provisioning.url || endpointsForEnv(env).registrar,
  });
  output.write("✓ Saved chat4000 channel config.\n");

  if (opts.noPair === true || opts.pair === false) {
    output.write('Skipped device pairing.\nNext step: "openclaw chat4000 pair"\n');
    return;
  }
  await runPair(api, { account: account.accountId, env: opts.env, stage: opts.stage });
}

/** Normal /pair/status poll cadence. */
const PAIR_STATUS_POLL_INTERVAL_MS = 2_000;
/** Exponential-backoff cap for transient /pair/status failures. */
const PAIR_STATUS_MAX_BACKOFF_MS = 30_000;
/**
 * PROTOCOL C.4: the CLI watcher is only the immediate-feedback path while the
 * install session is open — the gateway-resident listener owns the code's whole
 * lifetime. So the CLI never watches longer than this, however long the TTL.
 */
const CLI_WATCH_MAX_SECONDS = 900;

async function runPair(api: PluginApiLike, opts: PairCommandOptions): Promise<void> {
  const cfg = loadConfig(api);
  const account = resolveChat4000Account({
    cfg,
    accountId: opts.account,
  });
  if (!account.configured) {
    throw new Error('No Matrix identity yet. Run "openclaw chat4000 setup" first.');
  }
  const { client } = resolveRegistrar(account, opts);
  await enforceVersionBeforePrivileged(client, account.config.releaseChannel);
  const pluginId = account.pluginId ?? getOrCreatePluginId(account.accountId);
  // PROTOCOL C.1: ttl_seconds may go up to 2 years (63 072 000 s).
  const ttlSeconds = Math.max(
    1,
    Math.min(PAIR_CODE_TTL_MAX_SECONDS, Number.parseInt(opts.ttl ?? "300", 10) || 300),
  );
  const reusable = opts.reusable === true;

  let pairing;
  try {
    pairing = await startHumanPairing({
      registrar: client,
      pluginId,
      ttlSeconds,
      reusable,
    });
  } catch (err) {
    if (err instanceof RegistrarError && err.status === 400) {
      // C.1: registration requires the plugin's user to exist (bound at
      // registration) — /user/ensure runs at setup.
      throw new Error(
        `registrar rejected the pairing registration: ${err.message}. ` +
          'Run "openclaw chat4000 setup" first so the plugin\'s user exists (PROTOCOL C.6).',
      );
    }
    throw err;
  }
  // C.4 completion listening: the code is part of the plugin's persistent
  // state from the moment it exists — the gateway-resident listener polls it
  // for its whole lifetime, even after this CLI exits.
  addOutstandingCode(account.accountId, {
    code: pairing.code,
    reusable,
    expiresAt: pairing.expiresAt,
    registeredAt: Date.now(),
    deviceIds: [],
  });
  output.write(`Pairing code: ${pairing.code}\n`);
  await renderQr(pairing.qrUri, (line) => output.write(`${line}\n`));
  output.write(`Redeem in the chat4000 app within ${ttlSeconds}s.\n`);
  if (reusable) {
    output.write("Code is reusable: each redeem adds another device until it expires.\n");
  }

  // Poll /pair/status for install-time feedback. Transient registrar failures
  // (429 rate limits, 502/503/504, network errors) must NOT kill pairing —
  // observed live 2026-06-12: a 429 M_LIMIT_EXCEEDED from /pair/status killed
  // the Hermes twin of this flow mid-pairing. They retry with exponential
  // backoff (2s doubling to a 30s cap) inside the same overall deadline; other
  // 4xx (bad token, unknown code, …) are permanent and fail fast.
  const watchSeconds = Math.min(ttlSeconds, CLI_WATCH_MAX_SECONDS);
  const deadline = Date.now() + watchSeconds * 1000;
  let pollDelayMs = PAIR_STATUS_POLL_INTERVAL_MS;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollDelayMs, deadline - Date.now()));
    let status: PairStatusResult;
    try {
      status = await client.getPairingStatus(pairing.code);
    } catch (error) {
      if (isTransientRegistrarError(error)) {
        pollDelayMs = Math.min(pollDelayMs * 2, PAIR_STATUS_MAX_BACKOFF_MS);
        continue;
      }
      throw error; // permanent registrar error — surfaced via handleCliError
    }
    pollDelayMs = PAIR_STATUS_POLL_INTERVAL_MS; // a successful poll resets the backoff
    // C.3: a watcher waiting for "someone paired" checks `redeems` non-empty,
    // not `status` — a reusable code stays `pending` however many redeems it
    // has. Old-registrar fallback: `completed` with no redeems[] still counts.
    let redeems = status.redeems;
    if (redeems.length === 0 && status.status === "completed") {
      redeems = [{ deviceId: `legacy:${pairing.code}`, clientId: status.clientId, redeemedAt: 0 }];
    }
    // Check-and-set against the shared store so the resident listener and this
    // watcher never double-count a redeem (whoever records it, reports it).
    const fresh = recordRedeemedDevices(account.accountId, pairing.code, redeems);
    for (const redeem of fresh) {
      // PL4 / FLW2-4: the registrar hands us the redeeming phone's client_id —
      // emit the machine↔phone join event and register the super property
      // (latest pairing wins). Absent on old registrars / telemetry-off phones.
      const pairedClientId = redeem.clientId?.trim();
      if (pairedClientId) registerPairedClientId(pairedClientId);
      // PL4 canonical props: {paired_client_id?, reusable, redeem_index?} —
      // optional ones omitted when unknown, never fabricated.
      const redeemIndex = redeemIndexOf(status, redeem.deviceId);
      track("pairing_completed", {
        reusable,
        ...(redeemIndex !== undefined ? { redeem_index: redeemIndex } : {}),
        ...(pairedClientId ? { paired_client_id: pairedClientId } : {}),
      });
    }
    if (fresh.length > 0) await flushAnalytics();
    if (redeems.length > 0) {
      // PROTOCOL C.3: nothing to do membership-wise — the user's invites to the
      // space + control room pre-exist from setup (C.6) and the new device
      // inherits them; room keying happens on the plugin's next send.
      output.write(`✓ Device paired${status.userId ? ` (${status.userId})` : ""}.\n`);
      if (status.status === "completed") {
        removeOutstandingCode(account.accountId, pairing.code);
      } else if (reusable) {
        output.write(
          "Code stays redeemable until expiry; the gateway keeps listening for more devices.\n",
        );
      }
      return;
    }
    if (status.status === "expired") {
      removeOutstandingCode(account.accountId, pairing.code);
      output.write('Pairing code expired. Re-run "openclaw chat4000 pair".\n');
      return;
    }
  }
  output.write(
    "Pairing window elapsed. The gateway keeps listening for this code until it " +
      'expires; re-run "openclaw chat4000 pair" for a fresh code.\n',
  );
}

async function runWizardCommand(api: PluginApiLike, opts: WizardCommandOptions): Promise<void> {
  // Resolve the account up front so the banner can report whether an identity is
  // already configured (and so the same accountId threads through every step).
  const cfg = loadConfig(api);
  const account = resolveChat4000Account({ cfg, accountId: opts.account });

  // Build option objects that include only DEFINED keys — `exactOptionalPropertyTypes`
  // rejects passing an explicit `undefined` for an optional field.
  const setupOpts: SetupCommandOptions = {
    account: account.accountId,
    selfRedeem: true,
    noPair: true,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.stage !== undefined ? { stage: opts.stage } : {}),
    ...(opts.registrarUrl !== undefined ? { registrarUrl: opts.registrarUrl } : {}),
    ...(opts.serviceToken !== undefined ? { serviceToken: opts.serviceToken } : {}),
    ...(opts.gatewayUrl !== undefined ? { gatewayUrl: opts.gatewayUrl } : {}),
    ...(opts.pairingLogLevel !== undefined ? { pairingLogLevel: opts.pairingLogLevel } : {}),
    ...(opts.runtimeLogLevel !== undefined ? { runtimeLogLevel: opts.runtimeLogLevel } : {}),
  };
  const pairOpts: PairCommandOptions = {
    account: account.accountId,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.stage !== undefined ? { stage: opts.stage } : {}),
    ...(opts.registrarUrl !== undefined ? { registrarUrl: opts.registrarUrl } : {}),
    ...(opts.serviceToken !== undefined ? { serviceToken: opts.serviceToken } : {}),
    ...(opts.ttl !== undefined ? { ttl: opts.ttl } : {}),
  };

  await runWizard({
    envSummary: () =>
      buildWizardEnvSummary({
        envFlag: opts.stage ? "stage" : opts.env,
        configured: account.configured,
      }),
    // Step 1: mint identity + enable the plugin, WITHOUT pairing — this repo's
    // equivalent of the Hermes wizard's `prepare`. Reuses runSetup.
    prepare: () => runSetup(api, setupOpts),
    // Step 3: the human pairing handshake. Reuses runPair.
    pair: () => runPair(api, pairOpts),
  });
}

async function runMigrate(api: PluginApiLike, opts: MigrateCommandOptions): Promise<void> {
  const cfg = loadConfig(api);
  const account = resolveChat4000Account({
    cfg,
    accountId: opts.account,
  });
  const env = resolveSelectedEnv(opts);
  const registrarUrl =
    opts.registrarUrl?.trim() || account.provisioning.url || endpointsForEnv(env).registrar;
  const gatewayUrl = resolveGatewayUrl(account, opts);
  // Prefer credentials already resolvable (env/config/file); else self-onboard
  // via the registrar if a SERVICE_TOKEN is available.
  const existingCredentials: MatrixCredentials | null = account.configured
    ? {
        gatewayUrl: account.gatewayUrl,
        userId: account.userId,
        accessToken: account.accessToken,
        deviceId: account.deviceId,
        pluginId: account.pluginId,
      }
    : null;
  const serviceToken = opts.serviceToken?.trim() || account.provisioning.serviceToken;
  const registrar = serviceToken
    ? new RegistrarClient({ baseUrl: registrarUrl, serviceToken })
    : null;
  await runChat4000Migration({
    accountId: account.accountId,
    existingCredentials,
    registrar,
    gatewayUrl,
    write: (line) => output.write(`${line}\n`),
    persistConfig: async (creds) => {
      await writeChannelConfig(api, {
        accountId: account.accountId,
        env,
        pairingLogLevel: account.pairingLogLevel,
        runtimeLogLevel: account.runtimeLogLevel,
        gatewayUrl: creds.gatewayUrl,
        userId: creds.userId,
        deviceId: creds.deviceId,
        registrarUrl,
      });
    },
  });
}

async function runUpdate(opts: UpdateCommandOptions): Promise<void> {
  // Default (no --apply) is the read-only preflight.
  if (!opts.apply) {
    const preflight = await checkUpdatePreflight();
    if (opts.json) {
      output.write(`${JSON.stringify(preflight, null, 2)}\n`);
      return;
    }
    output.write(`${formatPreflight(preflight)}\n`);
    output.write('\nApply it with: "openclaw chat4000 update --apply --restart"\n');
    return;
  }

  const result = await applyUpdate({
    targetVersion: opts.version?.trim() || undefined,
    force: opts.force === true,
    restart: opts.restart === true,
    trigger: "command", // PL2
    log: (line) => output.write(`${line}\n`),
  });

  if (opts.json) {
    output.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  output.write(
    [
      "",
      result.ok ? "✓ update applied" : "✗ update not applied",
      `  from: ${result.fromVersion}`,
      `  to:   ${result.toVersion ?? "(unknown)"}`,
      `  ${result.reason ?? ""}`,
      ...(result.ok && !result.restartScheduled
        ? ["  Restart the gateway to load it (or re-run with --restart)."]
        : []),
    ].join("\n") + "\n",
  );
}

function runReset(accountArg?: string): void {
  const accountId = (accountArg ?? "default").trim() || "default";
  const removed: string[] = [];
  if (deleteMatrixCredentials(accountId)) {
    removed.push("credentials");
  }
  const stateDir = resolveChat4000AccountStateDir(accountId);
  try {
    rmSync(stateDir, { recursive: true, force: true });
    removed.push(stateDir);
  } catch {
    // ignore
  }
  if (removed.length === 0) {
    output.write(`No local chat4000 state for account "${accountId}".\n`);
    return;
  }
  output.write(`Reset chat4000 account "${accountId}". Removed: ${removed.join(", ")}\n`);
  output.write('Re-provision with: "openclaw chat4000 setup"\n');
}

function runListSessions(api: PluginApiLike, opts: { account?: string; limit?: string }): void {
  const cfg = loadConfig(api);
  const limit = Math.max(1, Number.parseInt(opts.limit ?? "20", 10) || 20);
  const sessions = listOpenClawSessionCandidates(cfg).slice(0, limit);
  if (sessions.length === 0) {
    output.write("No OpenClaw sessions found.\n");
    return;
  }
  for (const [index, session] of sessions.entries()) {
    output.write(
      [
        `[${index + 1}] ${session.sessionKey}`,
        `  channel: ${session.lastChannel ?? "unknown"} | label: ${session.label}`,
        ...(session.lastPreview ? [`  preview: ${session.lastPreview}`] : []),
      ].join("\n") + "\n",
    );
  }
  output.write(
    'Bind one with: openclaw chat4000 sessions bind --room "!room:hs" --session-key "<session-key>"\n',
  );
}

function runBindSession(api: PluginApiLike, opts: SessionBindingOptions): void {
  const room = opts.room?.trim();
  const sessionKey = opts.sessionKey?.trim();
  if (!room) throw new Error("missing --room <roomId>");
  if (!sessionKey) throw new Error("missing --session-key <value>");
  const cfg = loadConfig(api);
  const account = resolveChat4000Account({
    cfg,
    accountId: opts.account,
  });
  const candidate = findOpenClawSessionCandidate(sessionKey, cfg);
  if (!candidate) throw new Error(`session not found: ${sessionKey}`);
  const binding = setChat4000SessionBinding({
    accountId: account.accountId,
    groupId: room,
    target: candidate,
  });
  output.write(
    `Bound chat4000 room ${room} to ${binding.targetSessionKey} (agent ${binding.agentId}).\n`,
  );
}

function runShowBinding(api: PluginApiLike, opts: SessionBindingOptions): void {
  const room = opts.room?.trim();
  if (!room) throw new Error("missing --room <roomId>");
  const cfg = loadConfig(api);
  const account = resolveChat4000Account({
    cfg,
    accountId: opts.account,
  });
  const binding = getChat4000SessionBinding({ accountId: account.accountId, groupId: room });
  if (!binding) {
    output.write("No binding for that room. chat4000 will use the default route.\n");
    return;
  }
  output.write(
    [
      `room: ${room}`,
      `target session: ${binding.targetSessionKey}`,
      `agent: ${binding.agentId}`,
      `label: ${binding.label}`,
    ].join("\n") + "\n",
  );
}

function runClearBinding(api: PluginApiLike, opts: SessionBindingOptions): void {
  const room = opts.room?.trim();
  if (!room) throw new Error("missing --room <roomId>");
  const cfg = loadConfig(api);
  const account = resolveChat4000Account({
    cfg,
    accountId: opts.account,
  });
  const cleared = clearChat4000SessionBinding({ accountId: account.accountId, groupId: room });
  output.write(
    cleared ? "Cleared chat4000 room binding.\n" : "No binding was set for that room.\n",
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadConfig(api: PluginApiLike): Record<string, unknown> {
  return api.runtime?.config?.loadConfig?.() ?? api.config ?? {};
}

function normalizeLogLevel(value: string | undefined): "info" | "debug" {
  return value?.trim().toLowerCase() === "debug" ? "debug" : "info";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeChannelConfig(api: PluginApiLike, params: ChannelConfigParams): Promise<void> {
  const current = loadConfig(api);
  const next = patchChannelConfig(current, params);
  if (api.runtime?.config?.writeConfigFile) {
    await api.runtime.config.writeConfigFile(next);
    return;
  }
  throw new Error("chat4000 setup cannot persist config in this runtime");
}

type ChannelConfigParams = {
  accountId: string;
  env: Chat4000Env;
  pairingLogLevel: "info" | "debug";
  runtimeLogLevel: "info" | "debug";
  gatewayUrl: string;
  userId: string;
  deviceId: string;
  registrarUrl?: string;
};

export function patchChannelConfig(
  cfg: Record<string, unknown>,
  params: ChannelConfigParams,
): Record<string, unknown> {
  const channels = { ...((cfg.channels as Record<string, unknown> | undefined) ?? {}) };
  const currentChannel = { ...((channels.chat4000 as Record<string, unknown> | undefined) ?? {}) };
  const plugins = { ...((cfg.plugins as Record<string, unknown> | undefined) ?? {}) };
  const entries = {
    ...((plugins.entries as Record<string, Record<string, unknown>> | undefined) ?? {}),
  };
  entries.chat4000 = { ...(entries.chat4000 ?? {}), enabled: true };
  plugins.entries = entries;
  const currentAllow = Array.isArray(plugins.allow)
    ? plugins.allow.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : undefined;
  if (currentAllow) {
    plugins.allow = currentAllow.includes("chat4000")
      ? currentAllow
      : [...currentAllow, "chat4000"];
  }

  // Note: accessToken stays in the 0600 credentials file, NOT in config.
  const fields: Record<string, unknown> = {
    enabled: true,
    env: params.env,
    pairingLogLevel: params.pairingLogLevel,
    runtimeLogLevel: params.runtimeLogLevel,
    gatewayUrl: params.gatewayUrl,
    userId: params.userId,
    deviceId: params.deviceId,
  };
  const provisioning: Record<string, unknown> = {
    ...((currentChannel.provisioning as Record<string, unknown> | undefined) ?? {}),
  };
  if (params.registrarUrl) provisioning.url = params.registrarUrl;

  if (params.accountId === "default") {
    Object.assign(currentChannel, fields, { provisioning });
  } else {
    const accounts = {
      ...((currentChannel.accounts as Record<string, Record<string, unknown>> | undefined) ?? {}),
    };
    accounts[params.accountId] = { ...(accounts[params.accountId] ?? {}), ...fields, provisioning };
    currentChannel.accounts = accounts;
    if (!currentChannel.defaultAccount) currentChannel.defaultAccount = params.accountId;
  }

  channels.chat4000 = currentChannel;
  return { ...cfg, channels, plugins };
}

/** Run a synchronous CLI action, routing any thrown error to the CLI sink. */
function runSessionAction(action: () => void): void {
  try {
    action();
  } catch (error) {
    handleCliError(error);
  }
}

function handleCliError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const logPath = dumpChat4000Trace("cli", error);
  output.write(`chat4000 error: ${message}\nTrace log: ${logPath}\n`);
  // Observed live 2026-06-12: `setup --self-redeem` printed "chat4000 error:
  // Invalid service token" / "Missing registrar SERVICE_TOKEN" / "No Matrix
  // identity yet" yet still exited 0, so the installer treated the failed setup
  // as success. Mark the process failed; setting exitCode (instead of calling
  // process.exit()) lets pending writes and the host's teardown finish.
  process.exitCode = 1;
}
