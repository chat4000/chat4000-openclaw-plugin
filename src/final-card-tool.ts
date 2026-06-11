/**
 * `final_card` tool — the native rich final-answer surface for chat4000 sessions
 * (PROTOCOL E HTML card). Ported from the hermes plugin's `html_card_tool.py`.
 *
 * The agent calls `final_card({html})` to deliver a complete, self-contained
 * HTML card as the turn's final answer; the channel then suppresses the normal
 * streamed text answer for that turn (see {@link ./matrix/card-finalize.ts}).
 *
 * The long description below IS the prompt that makes the model pick this tool
 * and produce on-brand cards — kept verbatim with the hermes copy so both agents
 * render identically.
 *
 * Resolution: openclaw calls the registered factory per conversation with a tool
 * context whose `deliveryContext` carries the active route. For a chat4000 turn
 * that is `{channel:"chat4000", to:<roomId>, accountId}` — the openclaw analog of
 * hermes reading `HERMES_SESSION_CHAT_ID`. The factory returns the tool only for
 * chat4000 turns, with the room captured; non-chat4000 turns never see it.
 */
import { Type, type TObject } from "typebox";
import { getHandle } from "./channel-runtime.js";
import { markCardFinalized } from "./matrix/card-finalize.js";
import { sendHtmlCard } from "./matrix/send.js";
import { report } from "./telemetry.js";

const FINAL_CARD_TOOL_NAME = "final_card";

// ─── Minimal structural views of the (loosely-shimmed) openclaw SDK surface ──

type DeliveryContext = { channel?: string; to?: string; accountId?: string };
type ToolContext = {
  deliveryContext?: DeliveryContext;
  messageChannel?: string;
  agentAccountId?: string;
};
type ToolTextResult = { content: Array<{ type: "text"; text: string }>; details: unknown };
type AgentToolLike = {
  name: string;
  label: string;
  description: string;
  parameters: TObject;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<ToolTextResult>;
};
type ToolFactory = (ctx: ToolContext) => AgentToolLike | null;
type PluginToolApi = { registerTool?: (tool: ToolFactory, opts?: { name?: string }) => void };

// ─── Prompt (verbatim with hermes html_card_tool.py) ─────────────────────────

const CORE_RULE =
  "Call final_card to deliver a complete, self-contained HTML card as the final " +
  "answer for the current turn in a chat4000 session. This is the native rich " +
  "final surface for chat4000. The card replaces the text answer: call this tool " +
  "once per turn, with finished HTML (never partial or streamed), and do not also " +
  "send a text final answer.";

const WHEN_TO_USE = `Use final_card when the final answer is structured, glanceable data rather than
plain prose — weather, knowledge panels, status, lists, agendas, etc.

All answers shouldn't be like this. Use it in good taste, to delight the user
surprisingly. Do it unless the user has explicitly said they prefer plain text
or don't like cards. For conversational replies, explanations or essays, or code
the user will copy, answer as normal text instead.`;

const RENDER_CONTEXT = `RENDER CONTEXT — the card renders as a bubble in the chat4000 iOS/macOS chat
timeline, inside a sandboxed WebView: CSS and JS run, but there is NO NETWORK
ACCESS. No external fonts, no remote images, no CDN libraries — inline everything;
use emoji, inline SVG, or pure CSS for graphics. The chat behind the card is
near-black (#0F0F0F): leave html/body transparent and draw your own surface (the
TEMPLATE below provides it). Design for phone width: max-width ~420px, 12-13px
mono body text, generous padding.`;

const STYLE_GUIDE = `STYLE GUIDE — dark, minimal, terminal/monospace; a developer tool, not a consumer
app. Surfaces: card #141414, raised inner panels #1A1A1A, 1px borders
rgba(255,255,255,0.08) (0.14 for emphasis). Text: #FFFFFF titles, #E0E0E0 body,
#9CA3AF labels, #666666 muted/timestamps. Accents sparingly, on a monochrome base:
PINK #EC4899 is the brand hero (bright #F472B6 for highlights); BLUE #53BDEB is
secondary (links, info, "up/ok"). Typography: monospace everywhere —
ui-monospace,"SF Mono",Menlo,monospace; weights 400 body / 500 labels / 600-700
titles. Shape: radius 8px chips, 12-14px cards; pills are full capsules; padding
16-24px card, 12-16px inner. Buttons: primary = white bg + black text; accent =
pink bg + white text; secondary = transparent + 1px subtle border + #9CA3AF text.
DO: thin borders, tight grids, emoji or inline-SVG icons, gradients only built
from pink/blue on dark. DON'T: light/white backgrounds, serif or rounded fonts,
green/orange/red accents, rainbow gradients, remote assets, heavy shadows.`;

const CARD_TEMPLATE = `TEMPLATE — start every card with this exact style block + root; put the content
inside .c4k and reuse its CSS variables and helper classes:
<style>
.c4k{--raised:#1A1A1A;--border:rgba(255,255,255,.08);--border-hi:rgba(255,255,255,.14);
--text:#FFF;--body:#E0E0E0;--label:#9CA3AF;--muted:#666;--pink:#EC4899;
--pink-hi:#F472B6;--blue:#53BDEB;background:#141414;border:1px solid var(--border);
border-radius:14px;padding:20px;max-width:420px;color:var(--body);
font:13px/1.5 ui-monospace,"SF Mono",Menlo,monospace}
.c4k .k{color:var(--label);font-size:11px;font-weight:500;text-transform:uppercase;
letter-spacing:.08em}
.c4k .row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.c4k .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;
font-weight:500;background:rgba(255,255,255,.04);border:1px solid var(--border);
color:var(--label)}
.c4k .pill.pink{background:rgba(236,72,153,.12);border-color:rgba(236,72,153,.35);
color:var(--pink-hi)}
.c4k .pill.blue{background:rgba(83,189,235,.10);border-color:rgba(83,189,235,.30);
color:var(--blue)}
.c4k hr{border:none;border-top:1px solid var(--border);margin:14px 0}
</style>
<div class="c4k">…content…</div>`;

const EXAMPLES = `EXAMPLES — five canonical card bodies (prepend the TEMPLATE style block to each):

weather:
<div class="c4k"><div class="row"><div><div class="k">Tel Aviv · now</div>
<div style="font-size:42px;font-weight:700;color:var(--text);margin-top:4px">27°<span
 style="color:var(--muted);font-size:18px">C</span></div>
<div style="color:var(--label)">☀️ Clear · feels like 29°</div></div>
<div style="text-align:right;color:var(--label);font-size:12px"><div>H <span
 style="color:var(--body)">31°</span> · L <span style="color:var(--body)">22°</span></div>
<div>💨 14 km/h</div><div>💧 48%</div></div></div><hr>
<div style="display:grid;grid-template-columns:repeat(5,1fr);text-align:center;gap:4px">
<div><div class="k">15:00</div><div style="font-size:18px;margin:4px 0">☀️</div>
<div style="color:var(--text)">28°</div></div>
<div><div class="k">16:00</div><div style="font-size:18px;margin:4px 0">🌤</div>
<div style="color:var(--text)">28°</div></div>
<div><div class="k">17:00</div><div style="font-size:18px;margin:4px 0">🌤</div>
<div style="color:var(--text)">26°</div></div>
<div><div class="k">18:00</div><div style="font-size:18px;margin:4px 0">🌥</div>
<div style="color:var(--text)">25°</div></div>
<div><div class="k">19:00</div><div style="font-size:18px;margin:4px 0">🌙</div>
<div style="color:var(--blue)">23°</div></div></div></div>

knowledge panel / entity:
<div class="c4k"><div style="display:flex;gap:14px;align-items:center;margin-bottom:12px">
<div style="width:52px;height:52px;border-radius:12px;
background:linear-gradient(135deg,#EC4899,#53BDEB);display:flex;align-items:center;
justify-content:center;font-size:24px">🧮</div>
<div><div style="color:var(--text);font-weight:700;font-size:15px">Ada Lovelace</div>
<div style="color:var(--label);font-size:11px">Mathematician · 1815–1852</div></div></div>
<div style="color:var(--body);font-size:12px;line-height:1.7;margin-bottom:12px">English
 mathematician known for her work on Babbage's Analytical Engine — widely regarded as
 the <span style="color:var(--pink-hi)">first computer programmer</span>.</div>
<div style="display:flex;flex-direction:column;gap:6px;font-size:12px">
<div class="row"><span class="k">born</span><span style="color:var(--body)">Dec 10,
 1815 · London</span></div>
<div class="row"><span class="k">known for</span><span style="color:var(--body)">Note G
 — first algorithm</span></div>
<div class="row"><span class="k">parent</span><span
 style="color:var(--blue)">Lord Byron</span></div></div></div>

flight status:
<div class="c4k"><div class="row" style="margin-bottom:14px"><span class="pill blue">LY
 073 · on time</span><span style="color:var(--muted);font-size:11px">Boeing 787-9</span>
</div><div class="row" style="align-items:flex-end">
<div><div style="font-size:28px;font-weight:700;color:var(--text)">TLV</div>
<div class="k">Tel Aviv</div><div style="color:var(--blue);margin-top:4px">22:40</div></div>
<svg viewBox="0 0 120 24" style="flex:1;height:24px;margin:0 8px 18px">
<line x1="4" y1="12" x2="116" y2="12" stroke="rgba(255,255,255,.14)" stroke-dasharray="3 4"/>
<circle cx="4" cy="12" r="2.5" fill="#EC4899"/><circle cx="116" cy="12" r="2.5" fill="#53BDEB"/>
<text x="54" y="9" font-size="10">✈️</text></svg>
<div style="text-align:right"><div style="font-size:28px;font-weight:700;color:var(--text)">JFK
</div><div class="k">New York</div><div style="color:var(--blue);margin-top:4px">04:05<span
 style="color:var(--muted)">+1</span></div></div></div><hr>
<div style="display:grid;grid-template-columns:repeat(4,1fr);text-align:center">
<div><div class="k">gate</div><div style="color:var(--text);font-weight:600">C8</div></div>
<div><div class="k">seat</div><div style="color:var(--pink-hi);font-weight:600">14A</div></div>
<div><div class="k">board</div><div style="color:var(--text);font-weight:600">21:55</div></div>
<div><div class="k">durat.</div><div style="color:var(--text);font-weight:600">12:25</div></div>
</div></div>

calendar / day agenda (current event gets the pink left border):
<div class="c4k"><div class="row" style="margin-bottom:14px">
<div style="color:var(--text);font-weight:600">Wed, Jun 10</div>
<span class="pill">3 events</span></div>
<div style="display:flex;flex-direction:column;gap:12px">
<div style="display:flex;gap:14px"><div style="color:var(--blue);min-width:52px">09:30</div>
<div style="border-left:2px solid var(--pink);padding-left:12px">
<div style="color:var(--text)">Standup — backend</div>
<div style="color:var(--muted);font-size:11px">15 min · Meet</div></div></div>
<div style="display:flex;gap:14px"><div style="color:var(--blue);min-width:52px">14:00</div>
<div style="border-left:2px solid var(--border-hi);padding-left:12px">
<div style="color:var(--text)">Focus block — media wiring</div>
<div style="color:var(--muted);font-size:11px">2 h · no meetings</div></div></div>
<div style="display:flex;gap:14px"><div style="color:var(--blue);min-width:52px">19:30</div>
<div style="border-left:2px solid var(--border-hi);padding-left:12px">
<div style="color:var(--text)">🏋️ Gym</div>
<div style="color:var(--muted);font-size:11px">1 h</div></div></div></div></div>

to-do list:
<div class="c4k"><div class="row" style="margin-bottom:12px">
<div style="color:var(--text);font-weight:600">Today</div>
<span class="pill pink">2 / 4 done</span></div>
<div style="display:flex;flex-direction:column;gap:9px">
<div class="row" style="justify-content:flex-start"><span style="color:var(--pink)">▣</span>
<span style="color:var(--muted);text-decoration:line-through">Reply to the RFC thread</span></div>
<div class="row" style="justify-content:flex-start"><span style="color:var(--pink)">▣</span>
<span style="color:var(--muted);text-decoration:line-through">Rotate the stage token</span></div>
<div class="row" style="justify-content:flex-start"><span style="color:var(--label)">▢</span>
<span style="color:var(--body)">Ship v1.1.1 to stable</span></div>
<div class="row" style="justify-content:flex-start"><span style="color:var(--label)">▢</span>
<span style="color:var(--body)">Book dentist 🦷</span></div></div><hr>
<div style="color:var(--muted);font-size:11px">next due: <span
 style="color:var(--blue)">today 18:00</span> · ship v1.1.1</div></div>`;

const HTML_CARD_TOOL_DESCRIPTION = [
  CORE_RULE,
  WHEN_TO_USE,
  RENDER_CONTEXT,
  STYLE_GUIDE,
  CARD_TEMPLATE,
  EXAMPLES,
].join("\n\n");

const FINAL_CARD_PARAMS: TObject = Type.Object(
  {
    html: Type.String({
      description:
        "Complete, self-contained card HTML: the TEMPLATE style block followed by " +
        "one .c4k root. Inline everything; no external resources.",
    }),
  },
  { additionalProperties: false },
);

function jsonResult(payload: Record<string, unknown>): ToolTextResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
}

function readHtml(params: unknown): string | undefined {
  if (params && typeof params === "object" && "html" in params) {
    const value = (params as { html?: unknown }).html;
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/**
 * Register the `final_card` tool on the full plugin API (the `registerFull` hook
 * of the bundled channel entry). The factory is invoked per conversation; it
 * exposes the tool only on chat4000 turns, with the target room captured from
 * the delivery route.
 */
export function registerFinalCardTool(api: unknown): void {
  const toolApi = api as PluginToolApi;
  if (typeof toolApi.registerTool !== "function") return;

  toolApi.registerTool(
    (ctx: ToolContext): AgentToolLike | null => {
      // chat4000 sessions only — the card surface is the iOS/macOS app's.
      const channel = ctx.deliveryContext?.channel ?? ctx.messageChannel;
      if (channel !== "chat4000") return null;
      const roomId = ctx.deliveryContext?.to;
      if (!roomId) return null;
      const accountId = ctx.deliveryContext?.accountId ?? ctx.agentAccountId ?? "default";

      return {
        name: FINAL_CARD_TOOL_NAME,
        label: "final_card",
        description: HTML_CARD_TOOL_DESCRIPTION,
        parameters: FINAL_CARD_PARAMS,
        execute: async (_toolCallId, params): Promise<ToolTextResult> => {
          const html = readHtml(params);
          if (!html) {
            return jsonResult({ ok: false, sent: false, error: "html must be a non-empty string" });
          }
          const handle = getHandle(accountId);
          if (!handle) {
            return jsonResult({ ok: false, sent: false, error: "chat4000 client unavailable" });
          }
          try {
            const eventId = await sendHtmlCard(handle.client, roomId, html);
            // Suppress the streamed text final answer — the card is the answer.
            markCardFinalized(roomId);
            return jsonResult({ ok: true, sent: true, event_id: eventId });
          } catch (err) {
            report(err, "final_card.send");
            return jsonResult({ ok: false, sent: false, error: "html card was not sent" });
          }
        },
      };
    },
    { name: FINAL_CARD_TOOL_NAME },
  );
}
