# 🤖 chat4000 OpenClaw Plugin

> Connect your chat4000 iPhone or Mac app to your OpenClaw agent — over Matrix.

<p align="center">
  <a href="https://www.npmjs.com/package/@chat4000/openclaw-plugin"><img alt="npm" src="https://img.shields.io/npm/v/@chat4000/openclaw-plugin?label=npm"></a>
  <a href="https://github.com/chat4000/chat4000-openclaw-plugin"><img alt="openclaw" src="https://img.shields.io/badge/openclaw-%E2%89%A52026.5.27-orange"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-GPL--3.0-blue"></a>
  <a href="https://chat4000.com"><img alt="homepage" src="https://img.shields.io/badge/web-chat4000.com-9b59ff"></a>
</p>

An OpenClaw channel plugin that routes messages between your OpenClaw agent and the
chat4000 iOS/macOS app over a **Matrix homeserver** (Tuwunel). The agent runs as a Matrix
bot participant in your end-to-end encrypted rooms. Pairing goes through the chat4000
**Registrar** (protocol §3).

> **chat4000 v2 is a ground-up move to Matrix.** It is **not** compatible with the v1
> custom relay. Upgrading from a v1 install? See [Migrating from v1](#-migrating-from-v1).

---

## 🚀 Install

```sh
openclaw plugins install @chat4000/openclaw-plugin
openclaw gateway restart

# Self-onboard a bot identity via the registrar (needs a SERVICE_TOKEN):
openclaw chat4000 setup --self-redeem \
  --registrar-url https://registrar.chat4000.com \
  --service-token <SERVICE_TOKEN>
```

`setup --self-redeem` registers a `kind=plugin` code and redeems it (protocol §3): the
registrar mints the plugin's `@plugin_…` account + device + `plugin_id`. It then writes the
config and prints a pairing code + QR for your device. After setup the plugin auto-connects
whenever the gateway starts.

**Or supply an existing bot login directly** (no registrar needed):

```sh
openclaw chat4000 setup \
  --homeserver https://matrix.chat4000.com \
  --user-id @plugin_xxx:chat4000.com --access-token <token> --device-id <device>
```

(`CHAT4000_HOMESERVER` / `CHAT4000_USER_ID` / `CHAT4000_ACCESS_TOKEN` / `CHAT4000_DEVICE_ID`
env vars work too.) Device pairing always needs a registrar `SERVICE_TOKEN`.

### Optional X/Twitter workflows

chat4000 is the encrypted channel. If the same OpenClaw agent also needs to
search tweets, post tweets or replies, export followers, look up users, upload
or download media, send DMs, monitor tweets, deliver webhooks, or run giveaway
draws, install [TweetClaw](https://github.com/Xquik-dev/tweetclaw) beside this
plugin:

```sh
openclaw plugins install @xquik/tweetclaw
openclaw gateway restart
```

That lets prompts sent from chat4000 call TweetClaw's structured Xquik tools
while chat4000 continues to handle the paired iOS/macOS channel.

**From source:**
```sh
git clone https://github.com/chat4000/chat4000-openclaw-plugin
cd chat4000-openclaw-plugin
npm install && npm run build
openclaw plugins install $(pwd)
```

---

## 🧪 Stage vs production

The plugin ships with both backend presets (protocol §0). Select with `--env` (or the
`--stage` shortcut, or `CHAT4000_ENV`):

| Env | Homeserver | Registrar | Gateway |
|---|---|---|---|
| `prod` (default) | `https://matrix.chat4000.com` | `https://registrar.chat4000.com` | `wss://gateway.chat4000.com/ws` |
| `stage` | `https://matrix.stgcht4.duckdns.org` | `https://registrar.stgcht4.duckdns.org` | `wss://gateway.stgcht4.duckdns.org/ws` |

```sh
# Stage (TLS via Duck DNS wildcard — never put real user data there):
openclaw chat4000 setup --stage --self-redeem --service-token <STAGE_SERVICE_TOKEN>
openclaw chat4000 pair  --stage --service-token <STAGE_SERVICE_TOKEN>
```

`--registrar-url` / `--homeserver` override individual endpoints if you self-host.

---

## ⚡ Commands

```sh
openclaw chat4000 setup       # configure Matrix identity + pair a device
openclaw chat4000 pair        # pair another device (prints code + QR)
openclaw chat4000 status      # homeserver / user id / registrar / connection
openclaw chat4000 migrate     # upgrade a v1 (relay) install to v2 (Matrix)
openclaw chat4000 update             # preflight: can the plugin self-update?
openclaw chat4000 update --apply --restart   # install latest + restart gateway
openclaw chat4000 reset       # wipe local Matrix credentials + crypto state
openclaw chat4000 sessions list                       # OpenClaw sessions to bind
openclaw chat4000 sessions bind --room <!room:hs> --session-key <key>
openclaw chat4000 sessions current --room <!room:hs>
openclaw chat4000 sessions clear  --room <!room:hs>
openclaw chat4000 telemetry status
openclaw chat4000 --help
```

Registrar URL + token come from `--registrar-url`/`--service-token`, config
(`channels.chat4000.provisioning.{url,serviceToken}`), or env
(`CHAT4000_REGISTRAR_URL`, `CHAT4000_SERVICE_TOKEN`). Identity can also come straight from
env (`CHAT4000_HOMESERVER`, `CHAT4000_USER_ID`, `CHAT4000_ACCESS_TOKEN`, `CHAT4000_DEVICE_ID`).

---

## 🧩 How it works (protocol §3–§5)

```text
  chat4000 iOS / macOS app
        │  Matrix C-S (E2E encrypted), via the WS Gateway
        ▼
  Tuwunel homeserver ─────────── Registrar (accounts + pairing codes)
        ▲
        │  Matrix C-S (bot login, direct)
  chat4000 OpenClaw plugin  ──  this package  ──  your OpenClaw agent
```

- The plugin authenticates to the homeserver as a **bot account** and talks the Matrix
  client-server API directly (the WS Gateway is for end-user devices).
- Inbound room messages are decrypted and dispatched to your agent.
- Replies stream back as a **single message that refines itself** via `m.replace` edits,
  the final edit carrying the full text (protocol §5).
- Pairing: the plugin picks a code → `POST /pair/register` (bearer `SERVICE_TOKEN`) → prints
  the code + QR → polls `GET /pair/status` until the device redeems via `POST /pair/redeem`.

---

## 🔁 Self-update

The plugin can update itself (protocol §5):

```sh
openclaw chat4000 update                       # read-only preflight (no changes)
openclaw chat4000 update --apply               # install latest (restart manually)
openclaw chat4000 update --apply --restart     # install + restart the gateway
openclaw chat4000 update --apply --version 2.1.0   # pin an exact version
```

The preflight checks: newer version published, install dir writable, gateway
restart method (docker / supervised / foreground), npm reachable. `--apply`
proceeds only when the preflight is green (use `--force` to override).

**Remote (client-triggered) update.** A paired device can send a
`chat4000.command` of `plugin.update_check` (read-only) or `plugin.update` into
the control room. The gate is **control-room membership**: the plugin only acts
on commands that arrive in its own control room (a room tagged
`chat4000.room_kind: control`), and the plugin controls who it invites there. Any
member of the control room may trigger an update.

> Restarting the gateway from inside it uses a detached helper; on locked-down
> installs (read-only plugin dir, no restart permission) the preflight reports it
> as blocked rather than half-applying.

---

## 🔒 Security model

- **End-to-end encrypted.** Olm/Megolm via matrix-js-sdk + Rust crypto; the homeserver and
  every other service handle ciphertext only. The channel refuses to start if crypto can't
  initialize.
- **The bot's Matrix access token is the durable secret** — stored at
  `~/.openclaw/plugins/chat4000/credentials/<account>.json` with `0600` perms (never written
  into the OpenClaw config file).
- **Pairing** uses one-time registrar codes, not a shared password.

---

## 📁 Local data

| Path | What |
|---|---|
| `~/.openclaw/plugins/chat4000/credentials/<account>.json` | Matrix session (userId, accessToken, deviceId), `0600` |
| `~/.openclaw/plugins/chat4000/instance/<account>.json` | Stable `plugin_id` (UUID), `0600` |
| `~/.openclaw/plugins/chat4000/state/<account>/` | matrix-js-sdk sync store + Rust crypto store |
| `~/.openclaw/plugins/chat4000/session-bindings.json` | Matrix room ↔ OpenClaw session links |
| `~/.openclaw/plugins/chat4000/logs/runtime.log` | Connection & message events |
| `~/Backups/openclaw-migrations/` | Pre-migration snapshots of v1 state |
| `~/.config/chat4000/` | Telemetry config (`install-id`, `telemetry-enabled`) |

---

## 🆕 Migrating from v1

v1 (custom relay) and v2 (Matrix) do not interoperate. To upgrade in place:

```sh
openclaw plugins install --force @chat4000/openclaw-plugin@latest
openclaw chat4000 migrate --registrar-url https://registrar.chat4000.com --service-token <token>
openclaw gateway restart
openclaw chat4000 pair
```

`migrate` snapshots your v1 state to `~/Backups/openclaw-migrations/` **before** changing
anything, bootstraps a fresh Matrix identity via the registrar, and writes the v2 config.

> **v1 message history cannot be carried over.** v1 encrypted everything under a single
> group key; v2 uses Matrix's Megolm. Old history stays in the snapshot but won't appear in
> the app. New messages flow normally after you pair a device.

---

## 🛠 Build & test

```sh
npm install
npm run build      # tsc type-check (the package ships .ts sources)
npm test           # unit tests
```

---

## 📜 License

chat4000-openclaw-plugin is licensed under the **GNU General Public License v3.0** (GPL-3.0).
See [LICENSE](./LICENSE). Copyright © 2026 NeonNode Limited.

**Commercial licensing:** contact <contact@chat4000.com>.
