/**
 * Human-device pairing (PROTOCOL §3).
 *
 * The plugin picks a pairing `code`, registers it with the registrar
 * (`/pair/register`, bearer SERVICE_TOKEN), and prints it (text + QR). The
 * chat4000 app redeems the code at the registrar (`/pair/redeem`) and is logged
 * in. The plugin polls `/pair/status` until `completed`, then (§3.3) invites the
 * returned `user_id` to a room so messages can flow.
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

/** Register a fresh pairing code keyed to this plugin. */
export async function startHumanPairing(params: {
  registrar: RegistrarClient;
  pluginId: string;
  ttlSeconds?: number;
  userId?: string;
}): Promise<StartHumanPairingResult> {
  const code = generatePairingCode();
  const result = await params.registrar.registerPairing({
    code,
    pluginId: params.pluginId,
    userId: params.userId,
    ttlSeconds: params.ttlSeconds,
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
