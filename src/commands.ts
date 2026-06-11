/**
 * Control-room command handler (PROTOCOL E).
 *
 * The device sends `{ msgtype: "chat4000.command", command, ... }` into the
 * per-plugin control room; the plugin replies `chat4000.command_result`. This
 * module owns the chat4000-specific commands the plugin understands. Unknown
 * commands are answered with `ok:false, error:"unknown command"`, per section I
 * (ignore what you don't understand).
 *
 * Authorization is **control-room membership** — the gate is "is this event in
 * the plugin's control room?", enforced before this handler runs (the Matrix
 * client only forwards commands from a room tagged `chat4000.room_kind: control`,
 * and the plugin owns who it invites there). Any member of the control room may
 * run any command, including `plugin.update` (PROTOCOL E + operator decision).
 */
import { applyUpdate } from "./update/apply.js";
import { checkUpdatePreflight } from "./update/preflight.js";

export type ControlCommand = {
  command: string;
  /** Raw command content (other fields like room_id, title, version, etc). */
  args: Record<string, unknown>;
  senderId: string;
};

export type CommandResult = {
  command: string;
  ok: boolean;
  error?: string | undefined;
  /** Arbitrary result payload merged into the reply. */
  data?: Record<string, unknown> | undefined;
};

export type CommandContext = {
  log?: (line: string) => void;
};

/**
 * Handle a single control command. Returns the result to send back as a
 * `chat4000.command_result`. Never throws — failures become `ok:false`.
 */
export async function handleControlCommand(
  cmd: ControlCommand,
  ctx: CommandContext,
): Promise<CommandResult> {
  try {
    switch (cmd.command) {
      case "plugin.update_check": {
        const pf = await checkUpdatePreflight();
        return {
          command: cmd.command,
          ok: true,
          data: {
            current_version: pf.currentVersion,
            latest_version: pf.latestVersion,
            updatable: pf.updatable,
            newer_available: pf.newerAvailable,
            restart_method: pf.restartMethod,
            blockers: pf.probes
              .filter((p) => p.status === "blocked")
              .map((p) => `${p.name}: ${p.detail}`),
          },
        };
      }

      case "plugin.update": {
        const targetVersion =
          typeof cmd.args.version === "string" && cmd.args.version.trim()
            ? cmd.args.version.trim()
            : undefined;
        const restart = cmd.args.restart !== false; // default true for remote update
        const result = await applyUpdate({
          targetVersion,
          restart,
          force: cmd.args.force === true,
          trigger: "command", // PL2
          log: ctx.log,
        });
        return {
          command: cmd.command,
          ok: result.ok,
          error: result.ok ? undefined : result.reason,
          data: {
            from_version: result.fromVersion,
            to_version: result.toVersion,
            installed: result.installed,
            restart_scheduled: result.restartScheduled,
            restart_method: result.restartMethod,
            note: result.reason,
          },
        };
      }

      default:
        return { command: cmd.command, ok: false, error: "unknown command" };
    }
  } catch (err) {
    return { command: cmd.command, ok: false, error: String(err) };
  }
}

/** Commands this plugin understands (for capability/discovery). */
export const SUPPORTED_COMMANDS = ["plugin.update_check", "plugin.update"] as const;
