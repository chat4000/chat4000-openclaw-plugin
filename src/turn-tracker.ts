/**
 * In-flight agent-turn tracker.
 *
 * PROTOCOL C.5 says a plugin's version check (and the install/restart it may
 * trigger) MUST stay off the message path. The resident version poller (C.5.2)
 * therefore must not restart the gateway out from under a live agent turn — a
 * restart mid-relay would drop the in-flight reply.
 *
 * The plugin has no other signal for "is a relay happening right now", so this
 * is that signal: a process-wide counter of agent turns currently being
 * dispatched (`dispatchToAgent` brackets each turn with begin/end in a
 * `try/finally`). The poller reads {@link agentTurnInFlight} before applying a
 * self-update and defers the restart to a later tick while it is true.
 *
 * Process-wide (not per-account) on purpose: there is one gateway process and a
 * self-update restart replaces that whole process, so any account's live turn
 * is a reason to defer.
 */

let inFlight = 0;

/** Mark one agent turn (a relay) as started. Pair with {@link endAgentTurn}. */
export function beginAgentTurn(): void {
  inFlight += 1;
}

/** Mark one agent turn as finished. Always call from a `finally`. */
export function endAgentTurn(): void {
  if (inFlight > 0) inFlight -= 1;
}

/** True while at least one agent turn / relay is being dispatched. */
export function agentTurnInFlight(): boolean {
  return inFlight > 0;
}

/** Test-only: reset the counter between cases. */
export function resetAgentTurnTracker(): void {
  inFlight = 0;
}
