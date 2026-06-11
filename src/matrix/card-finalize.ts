/**
 * Turn-scoped flag: did a `final_card` tool call deliver the answer for a room's
 * current turn? (PROTOCOL E HTML card.) When set, the channel suppresses the
 * normal streamed text final answer for that turn — the card IS the answer
 * (mirrors hermes `_html_card_finalized_for_question`).
 *
 * Cleared at the start of every turn so a stale flag never swallows the next
 * turn's text. Keyed by room id; concurrent turns in different rooms are
 * independent.
 */
const finalizedRooms = new Set<string>();

/** A `final_card` tool call sent the answer for this room's current turn. */
export function markCardFinalized(roomId: string): void {
  if (roomId) finalizedRooms.add(roomId);
}

/** Read-and-clear: true iff a card finalized this room's current turn. */
export function consumeCardFinalized(roomId: string): boolean {
  return finalizedRooms.delete(roomId);
}

/** Reset at turn start so a prior turn's card never suppresses fresh text. */
export function clearCardFinalized(roomId: string): void {
  finalizedRooms.delete(roomId);
}
