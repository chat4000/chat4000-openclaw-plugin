/**
 * Human-device pairing (PROTOCOL C.3).
 *
 * The plugin picks a pairing `code`, mints it at the registrar (`POST /codes`,
 * bearer the BOT access token), and prints it (text + QR). The chat4000 app
 * redeems the code at the registrar (`POST /codes/{code}/redeem`) and becomes a
 * device on the plugin's one derived user (C.3 binding — implied by the bot
 * token, never named). Nothing membership-wise happens at completion — the
 * user's invites pre-exist from setup (C.6).
 *
 * The QR encodes a UNIVERSAL https link (not a custom scheme) so any phone
 * camera app can scan it: it opens pair.chat4000.com, which deep-links into the
 * app (or shows install instructions when the app isn't there yet). The page —
 * not the link — owns backend routing, so the code is the only payload.
 */
import { RegistrarClient, generatePairingCode } from "./registrar.js";

/** Base of the universal pairing link any camera app can open. */
const PAIR_LINK_BASE = "https://pair.chat4000.com";

export type StartHumanPairingResult = {
  code: string;
  expiresAt: number;
  /** Universal https link the app/camera opens to redeem the code. */
  qrUri: string;
};

/** Mint a fresh pairing code on the plugin's one derived user (PROTOCOL C.3.1). */
export async function startHumanPairing(params: {
  registrar: RegistrarClient;
  ttlSeconds?: number;
  /** PROTOCOL C.3.1: redeemable many times until expiry (fleet enrollment). */
  reusable?: boolean;
  /**
   * Caller-chosen code (must be exactly 6 digits — validated at the CLI
   * boundary). Random when omitted. The registrar still enforces the format and
   * rejects a collision with `M_CODE_IN_USE`.
   */
  code?: string | undefined;
}): Promise<StartHumanPairingResult> {
  const code = params.code ?? generatePairingCode();
  const result = await params.registrar.mintCode({
    code,
    ttlSeconds: params.ttlSeconds,
    reusable: params.reusable,
  });
  return {
    code,
    expiresAt: result.expiresAt,
    qrUri: buildQrUri({ code }),
  };
}

/** The universal pairing link encoded in the QR: `https://pair.chat4000.com/?code=<code>`. */
export function buildQrUri(payload: { code: string }): string {
  const params = new URLSearchParams({ code: payload.code });
  return `${PAIR_LINK_BASE}/?${params.toString()}`;
}

/** Render an ASCII QR for the URI, if qrcode-terminal is available. */
export async function renderQr(uri: string, write: (line: string) => void): Promise<void> {
  write(`QR payload: ${uri}`);
  try {
    const moduleName = "qrcode-terminal";
    const qr = (await import(moduleName)) as {
      default?: { generate?: (v: string, o?: { small?: boolean }) => void };
      generate?: (v: string, o?: { small?: boolean }) => void;
    };
    const generate = qr.generate ?? qr.default?.generate;
    if (typeof generate === "function") {
      generate(uri, { small: true });
    }
  } catch {
    write("(Install optional dependency `qrcode-terminal` to render an ASCII QR here.)");
  }
}
