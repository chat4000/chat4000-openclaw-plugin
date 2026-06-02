/**
 * MatrixDraftStream — renders a streaming agent reply as a single Matrix
 * message that refines itself via `m.replace` edits (PROTOCOL §5):
 * "one message that updates itself ... the final edit carries the full text."
 *
 *   update(text)  — accumulate; throttled create/edit while text grows.
 *   finalize(text)— flush the full text immediately as the final edit.
 *   reset()       — start a fresh message for the next block (after a tool call).
 *
 * Edits are throttled so we don't hammer the homeserver with one edit/token.
 */
import type { MatrixClient } from "matrix-js-sdk";
import { editText, sendText, sendTurnAnchor } from "./send.js";

const DEFAULT_THROTTLE_MS = 750;

export type MatrixDraftStreamOptions = {
  client: MatrixClient;
  roomId: string;
  throttleMs?: number;
  log?: (msg: string) => void;
};

export class MatrixDraftStream {
  private readonly client: MatrixClient;

  private readonly roomId: string;

  private readonly throttleMs: number;

  private readonly log?: ((msg: string) => void) | undefined;

  private eventId: string | undefined;

  private lastSentText = "";

  private pendingText = "";

  private timer: NodeJS.Timeout | undefined;

  private inFlight: Promise<void> = Promise.resolve();

  private disposed = false;

  constructor(opts: MatrixDraftStreamOptions) {
    this.client = opts.client;
    this.roomId = opts.roomId;
    this.throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.log = opts.log;
  }

  /** The turn anchor event id, once the message exists. */
  get anchorEventId(): string | undefined {
    return this.eventId;
  }

  /**
   * Eagerly create the turn anchor (the answer message) so turn events — tool
   * calls — can relate to it before any text streams (PROTOCOL E). Idempotent.
   */
  async ensureAnchor(): Promise<string> {
    if (this.disposed && this.eventId) return this.eventId;
    if (!this.eventId) {
      this.eventId = await sendTurnAnchor(this.client, this.roomId);
      this.lastSentText = "…";
    }
    return this.eventId;
  }

  /** Accumulate streamed text; schedules a throttled edit. */
  update(text: string): void {
    if (this.disposed || !text) return;
    this.pendingText = text;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushPending();
    }, this.throttleMs);
  }

  /** Flush the final text immediately (no throttle). Marks it push-eligible. */
  async finalize(text: string): Promise<string | undefined> {
    if (this.disposed) return this.eventId;
    this.clearTimer();
    const finalText = (text || this.pendingText || this.lastSentText).trimEnd();
    this.pendingText = finalText;
    await this.flushPending(true);
    return this.eventId;
  }

  /** Begin a fresh message for the next reply block. */
  reset(): void {
    this.clearTimer();
    this.eventId = undefined;
    this.lastSentText = "";
    this.pendingText = "";
  }

  /** Drain pending edits and stop scheduling. Idempotent. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearTimer();
    await this.inFlight;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private flushPending(final = false): Promise<void> {
    // Serialize sends so create-then-edit ordering is preserved.
    this.inFlight = this.inFlight.then(() => this.sendOrEdit(final));
    return this.inFlight;
  }

  /**
   * `final` carries the `chat4000.push` eligibility (PROTOCOL E): every streaming
   * write is `push:false`; only `finalize()` passes `true`. This holds for the
   * one-shot case too — if the very first write is the final one, the created
   * message is itself push-eligible.
   */
  private async sendOrEdit(final: boolean): Promise<void> {
    const text = this.pendingText.trimEnd();
    if (!text || text === this.lastSentText) return;
    try {
      if (!this.eventId) {
        this.eventId = await sendText(this.client, this.roomId, text, final);
      } else {
        await editText(this.client, this.roomId, this.eventId, text, final);
      }
      this.lastSentText = text;
    } catch (err) {
      this.log?.(`draft-stream send/edit failed: ${String(err)}`);
    }
  }
}
