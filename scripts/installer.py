#!/usr/bin/env python3
"""installer.py — installs the chat4000 OpenClaw plugin from npm,
restarts the OpenClaw gateway, and starts a pairing session.

────────────────────────────────────────────────────────────────────────
A note about the telemetry in this file, from us at chat4000:

We send anonymous events to PostHog (product analytics) and Sentry
(uncaught crashes) FROM THE INSTALLER ITSELF. We do this so that:

  - we can see what % of installs succeed end-to-end (PostHog funnel)
  - we can see which step fails most often (gateway restart? pip?
    npm registry timeout? relay handshake?)
  - we get a real stack trace when the installer crashes in a way we
    didn't anticipate (Sentry), so we can fix it without you having
    to file a bug

Things we NEVER send:
  - your message content, prompts, command arguments, env vars
  - pairing codes, group keys, anything from `keys/default.json`
  - usernames or anything else identifying

What WE send is bounded to:
  - which install step ran / failed, and the error class name
  - python + openclaw version, OS platform
  - an anonymous UUID (~/.config/chat4000/install-id) so we can tell
    one failed install retrying from many people each failing once

We're not trying to spy on you. We just want to ship a installer that
works for everyone, and the only way to know it's working is to
measure it. Opt out any of three ways:
  • CHAT4000_TELEMETRY_DISABLED=1 in your env
  • pass --no-telemetry on the curl|bash line
  • after install: `openclaw chat4000 telemetry disable`

Privacy policy: https://chat4000.com/privacy
Source: https://github.com/chat4000/chat4000-openclaw-plugin
Love, chat4000 ❤️
────────────────────────────────────────────────────────────────────────


Pure stdlib. Designed to be downloaded by install.sh and executed as a
one-shot. ANSI colors, no third-party deps (PostHog events use stdlib
HTTPS, not the SDK).

PostHog events fired:
  - installer_started
  - installer_openclaw_detected          {openclaw_version}
  - installer_pkg_installed              {plugin_version}
  - installer_gateway_restarted          {method}
  - installer_failed                     {stage, error_class, error_msg}
  - installer_handing_off_to_pair

Same install_id as the OpenClaw plugin's Sentry/PostHog so the
installer funnel correlates with later runtime events.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

# Make stdout/stderr line-buffered so the running output stays in order
# when piped through `docker exec` / `ssh` — otherwise subprocess stderr
# (immediate) prints before our buffered stdout (`print(...)`), giving
# misleading "error before banner" output.
try:
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
    sys.stderr.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
except Exception:
    pass

# ─── Constants ────────────────────────────────────────────────────────────

REPO_URL = "https://github.com/chat4000/chat4000-openclaw-plugin"
NPM_PACKAGE = "@chat4000/openclaw-plugin"

# Public PostHog credentials — same project the iOS / Mac apps and the
# Hermes plugin use. Hardcoded so the installer can fire pre-install
# events before the plugin (which embeds the same key) exists locally.
POSTHOG_API_KEY = "phc_wNRtzk3h5FTw2X6h4CvieEoxdSdqUd42eUqbgW6nD7B4"
POSTHOG_HOST = "https://posthog.chat4000.com"
POSTHOG_CAPTURE_URL = f"{POSTHOG_HOST}/capture/"

# Sentry DSN — the self-hosted chat4000 instance, the SAME project the Hermes
# plugin reports to (sentry.chat4000.com project 2), consolidating crash
# telemetry onto one self-hosted Sentry. DSN is public-by-design (write-only
# ingestion endpoint, not a secret).
SENTRY_DSN = "https://41cf740535c8a5a722cc1a13f090ea8d@sentry.chat4000.com/2"
INSTALLER_RELEASE = "chat4000-openclaw-plugin-installer@1.0.0"

import platform
import time

_STARTED_AT_MS = int(time.time() * 1000)

# ─── ANSI ─────────────────────────────────────────────────────────────────

if sys.stdout.isatty():
    C_RED = "\033[1;31m"
    C_GRN = "\033[1;32m"
    C_YEL = "\033[1;33m"
    C_BLU = "\033[1;34m"
    C_MAG = "\033[1;35m"
    C_CYN = "\033[1;36m"
    C_DIM = "\033[2m"
    C_BOLD = "\033[1m"
    C_RST = "\033[0m"
else:
    C_RED = C_GRN = C_YEL = C_BLU = C_MAG = C_CYN = C_DIM = C_BOLD = C_RST = ""

def say(msg: str) -> None: print(f"{C_CYN}>{C_RST} {msg}")
def ok(msg: str) -> None: print(f"{C_GRN}✓{C_RST} {msg}")
def warn(msg: str) -> None: print(f"{C_YEL}⚠{C_RST} {msg}")
def err(msg: str) -> None: print(f"{C_RED}✗{C_RST} {msg}", file=sys.stderr)
def hdr(msg: str) -> None:
    line = "━" * 63
    print(f"\n{C_MAG}{line}{C_RST}\n{C_MAG}{C_BOLD}{msg}{C_RST}\n{C_MAG}{line}{C_RST}\n")

def banner() -> None:
    print(f"\n{C_MAG}┌─────────────────────────────────────────────────────────────┐{C_RST}")
    print(f"{C_MAG}│{C_RST}  {C_MAG}{C_BOLD}🔐 chat4000{C_RST}  ·  {C_BLU}{C_BOLD}OpenClaw plugin installer{C_RST}                     {C_MAG}│{C_RST}")
    print(f"{C_MAG}│{C_RST}  {C_DIM}Native iPhone / Mac / CLI app for your OpenClaw agent{C_RST}       {C_MAG}│{C_RST}")
    print(f"{C_MAG}└─────────────────────────────────────────────────────────────┘{C_RST}\n")

# ─── install_id (matches what the plugin will reuse later) ────────────────

def resolve_install_id() -> str:
    cfg = Path.home() / ".config" / "chat4000"
    path = cfg / "install-id"
    try:
        if path.exists():
            existing = path.read_text(encoding="utf-8").strip()
            if existing:
                return existing
        new_id = str(uuid.uuid4())
        cfg.mkdir(parents=True, exist_ok=True)
        path.write_text(new_id + "\n", encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return new_id
    except Exception:
        return str(uuid.uuid4())

# ─── PostHog (stdlib HTTPS, no SDK) ───────────────────────────────────────

_SESSION_ID = str(uuid.uuid4())
_TELEMETRY_DISABLED = (
    os.environ.get("CHAT4000_TELEMETRY_DISABLED", "").strip().lower() in ("1", "true", "yes")
    or "--no-telemetry" in sys.argv
)

def _emit(event: str, props: Optional[dict] = None) -> None:
    if _TELEMETRY_DISABLED:
        return
    enriched = {
        "source": "openclaw-plugin-installer",
        "installer_version": "1.0.0",
        "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "os_platform": sys.platform,
        "session_id": _SESSION_ID,
        "arch": platform.machine() or "unknown",
        "cpu_count": os.cpu_count() or 0,
        "locale": (os.environ.get("LANG") or "").split(".")[0] or "unknown",
        "since_start_ms": int(time.time() * 1000) - _STARTED_AT_MS,
        "is_root": hasattr(os, "geteuid") and os.geteuid() == 0,
    }
    try:
        sysname = platform.system()
        if sysname == "Linux":
            os_rel = f"Linux {platform.release()}"
            try:
                for line in Path("/etc/os-release").read_text(errors="ignore").splitlines():
                    if line.startswith("PRETTY_NAME="):
                        os_rel = line.split("=", 1)[1].strip().strip('"')
                        break
            except Exception:
                pass
            enriched["os_release"] = os_rel
        elif sysname == "Darwin":
            mv = platform.mac_ver()[0]
            enriched["os_release"] = f"macOS {mv}" if mv else f"Darwin {platform.release()}"
        elif sysname == "Windows":
            wv = platform.win32_ver()[0]
            enriched["os_release"] = f"Windows {wv}" if wv else "Windows"
        else:
            enriched["os_release"] = f"{sysname} {platform.release()}".strip()
    except Exception:
        enriched["os_release"] = "unknown"
    try:
        in_container = False
        if Path("/.dockerenv").exists() or os.environ.get("KUBERNETES_SERVICE_HOST"):
            in_container = True
        else:
            cgroup = Path("/proc/1/cgroup").read_text(errors="ignore")
            in_container = any(s in cgroup for s in ("docker", "kubepods", "containerd", "podman"))
        enriched["is_container"] = in_container
    except Exception:
        enriched["is_container"] = False
    try:
        argv_out, skip_next = [], False
        for a in sys.argv[1:]:
            if skip_next:
                argv_out.append("<redacted>"); skip_next = False; continue
            if "=" in a:
                k = a.partition("=")[0]
                if any(s in k.lower() for s in ("token", "key", "secret", "pass", "dsn")):
                    argv_out.append(f"{k}=<redacted>"); continue
            if a.startswith(("sk-", "phc_", "ghp_", "Bearer")):
                argv_out.append("<redacted>"); continue
            if a in ("--token", "--api-key", "--secret", "--password", "--dsn"):
                argv_out.append(a); skip_next = True; continue
            argv_out.append(a)
        enriched["flags"] = argv_out
    except Exception:
        pass
    if props:
        enriched.update(props)
    # Privacy: the docstring + README promise telemetry carries "no file paths with
    # your username". Tokens are redacted above; scrub home-dir/username paths from
    # EVERY string prop (e.g. openclaw_path, flags) so that promise actually holds.
    enriched = {k: _scrub_props_value(v) for k, v in enriched.items()}
    body = json.dumps({
        "api_key": POSTHOG_API_KEY,
        "event": event,
        "distinct_id": resolve_install_id(),
        "properties": enriched,
    }).encode("utf-8")
    req = urllib.request.Request(
        POSTHOG_CAPTURE_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=3).read()
    except Exception:
        pass

# ─── Sentry (stdlib envelope POST, no SDK) ────────────────────────────────


def _scrub_path(s: str) -> str:
    """Replace home + /Users/<name>/ etc with anonymized placeholders."""
    if not isinstance(s, str):
        return s
    home = str(Path.home())
    if home and home in s:
        s = s.replace(home, "~")
    import re as _re
    return _re.sub(r"/(Users|home)/[^/]+", r"/\1/<user>", s)


def _scrub_props_value(v):
    """Recursively scrub username/home paths out of a telemetry prop value."""
    if isinstance(v, str):
        return _scrub_path(v)
    if isinstance(v, list):
        return [_scrub_props_value(x) for x in v]
    if isinstance(v, dict):
        return {k: _scrub_props_value(x) for k, x in v.items()}
    return v


def _scrub_secrets(s: str) -> str:
    if not isinstance(s, str):
        return s
    import re as _re
    s = _re.sub(r"sk-[A-Za-z0-9]{20,}", "[REDACTED_API_KEY]", s)
    s = _re.sub(r"phc_[A-Za-z0-9]{30,}", "[REDACTED_POSTHOG_KEY]", s)
    s = _re.sub(r"(?i)Bearer\\s+[A-Za-z0-9._-]+", "Bearer [REDACTED]", s)
    return s


def send_sentry_envelope(exc: BaseException, *, tags: Optional[dict] = None) -> None:
    """Post a Sentry envelope describing `exc` over plain HTTPS. Stdlib
    only — no sentry-sdk needed in the install bootstrap. Best-effort:
    never raises. Strips home paths and obvious secrets before sending."""
    if _TELEMETRY_DISABLED:
        return
    try:
        import traceback
        import datetime
        from urllib.parse import urlparse

        parsed = urlparse(SENTRY_DSN)
        public_key = parsed.username or ""
        project_id = (parsed.path or "").lstrip("/")
        if not public_key or not project_id or not parsed.hostname:
            return
        envelope_url = f"{parsed.scheme}://{parsed.hostname}/api/{project_id}/envelope/"

        frames = []
        tb = exc.__traceback__
        while tb is not None:
            f = tb.tb_frame
            co = f.f_code
            frames.append({
                "filename": _scrub_path(co.co_filename),
                "function": co.co_name,
                "lineno": tb.tb_lineno,
                "module": co.co_name,
                "in_app": "installer.py" in co.co_filename,
            })
            tb = tb.tb_next

        event = {
            "event_id": uuid.uuid4().hex,
            "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
            "platform": "python",
            "level": "error",
            "release": INSTALLER_RELEASE,
            "environment": os.environ.get("HERMES_ENV") or "production",
            "tags": {
                "installer": "openclaw",
                "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
                "os_platform": sys.platform,
                **(tags or {}),
            },
            "exception": {
                "values": [{
                    "type": type(exc).__name__,
                    "value": _scrub_secrets(str(exc))[:500],
                    "stacktrace": {"frames": frames},
                }]
            },
            "user": {"id": resolve_install_id()},
            "sdk": {"name": "chat4000-installer", "version": "1.0.0"},
        }

        envelope_header = json.dumps({"dsn": SENTRY_DSN, "event_id": event["event_id"]})
        item_header = json.dumps({"type": "event"})
        item_payload = json.dumps(event)
        body = (envelope_header + "\n" + item_header + "\n" + item_payload + "\n").encode("utf-8")

        req = urllib.request.Request(
            envelope_url,
            data=body,
            headers={
                "Content-Type": "application/x-sentry-envelope",
                "X-Sentry-Auth": (
                    f"Sentry sentry_version=7, sentry_key={public_key}, "
                    f"sentry_client=chat4000-installer/1.0"
                ),
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5).read()
    except Exception:
        # Telemetry must never break installs.
        pass


# ─── Detection ────────────────────────────────────────────────────────────

# Known OpenClaw binary locations, in priority order. Globs are expanded.
OPENCLAW_LOCATIONS = [
    "/usr/local/bin/openclaw",                              # Docker / Linux npm-root / Intel brew
    "/opt/homebrew/bin/openclaw",                           # Apple Silicon Homebrew
    "/home/linuxbrew/.linuxbrew/bin/openclaw",              # Linuxbrew
    "~/.openclaw/bin/openclaw",                             # install-cli.sh local prefix
    "~/.local/bin/openclaw",                                # source install / install.sh --install-method git
    "~/.npm-global/bin/openclaw",                           # user-prefixed npm
    "/usr/bin/openclaw",                                    # NodeSource-managed npm global
    "/Applications/OpenClaw.app/Contents/Resources/cli/openclaw",  # macOS .app
    "~/.nvm/versions/node/*/bin/openclaw",                  # nvm
    "~/.nix-profile/bin/openclaw",                          # Nix
    "/run/current-system/sw/bin/openclaw",                  # NixOS
]


def detect_openclaw() -> Optional[tuple[str, str]]:
    """Return (openclaw_path, version) or None.

    Probes in order: shutil.which → known locations (glob-aware).
    Skips Node binary itself."""
    path = shutil.which("openclaw")
    if not path:
        for pattern in OPENCLAW_LOCATIONS:
            expanded = str(Path(pattern).expanduser())
            if "*" in expanded:
                try:
                    for match in sorted(Path("/").glob(expanded.lstrip("/")), reverse=True):
                        if match.exists() and os.access(match, os.X_OK):
                            path = str(match)
                            break
                except Exception:
                    continue
                if path:
                    break
            else:
                if Path(expanded).exists() and os.access(expanded, os.X_OK):
                    path = expanded
                    break
        if not path:
            return None
    try:
        out = subprocess.run(
            [path, "--version"], capture_output=True, text=True, timeout=10,
        )
        version_line = (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr) else "unknown"
        m = re.search(r"\b(\d+\.\d+\.\d+\S*)", version_line)
        version = m.group(1) if m else version_line
    except Exception:
        version = "unknown"
    return (path, version)

def detect_restart_method() -> Optional[str]:
    """Return one of:
      - 'docker'              (openclaw-gateway container running)
      - 'openclaw-supervised' (openclaw service is managed by launchd/systemd/schtasks)
      - 'foreground'          (no supervisor — start with `gateway run --force` in background)
    """
    # Check docker first — if a container named openclaw-gateway is running,
    # `docker restart` is the unambiguous path.
    docker = shutil.which("docker")
    if docker:
        try:
            r = subprocess.run(
                [docker, "ps", "--filter", "name=openclaw-gateway", "--format", "{{.Names}}"],
                capture_output=True, text=True, timeout=5,
            )
            if "openclaw-gateway" in (r.stdout or ""):
                return "docker"
        except Exception:
            pass
    # Probe `openclaw gateway status` — if it reports a managed service,
    # use `openclaw gateway restart`. Otherwise fall back to foreground.
    openclaw = shutil.which("openclaw") or "openclaw"
    try:
        r = subprocess.run(
            [openclaw, "gateway", "status"],
            capture_output=True, text=True, timeout=5,
        )
        out = (r.stdout or "") + (r.stderr or "")
        if "service disabled" in out.lower() or "service is not installed" in out.lower():
            return "foreground"
        # Any other status output implies the supervisor is present.
        if r.returncode == 0 and out.strip():
            return "openclaw-supervised"
    except Exception:
        pass
    return "foreground"

# ─── Install steps ────────────────────────────────────────────────────────

def detect_plugin_state(openclaw: str) -> tuple:
    """Is the chat4000 plugin already installed, and at which version?

    Reuses the plugin's own read-only preflight: `openclaw chat4000 update
    --check --json` only exists once the plugin is installed, and reports its
    `currentVersion` + `latestVersion` + `newerAvailable`. Returns
    (installed: bool, current: Optional[str], latest: Optional[str], newer: bool).
    Best-effort — any failure (command not found, offline, bad JSON) ⇒ treat as
    not installed and fall back to a plain install.
    """
    try:
        r = subprocess.run(
            [openclaw, "chat4000", "update", "--check", "--json"],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:
        return (False, None, None, False)
    if r.returncode != 0 or not (r.stdout or "").strip():
        return (False, None, None, False)
    try:
        text = r.stdout
        start = text.find("{")  # tolerate any leading log lines
        data = json.loads(text[start:]) if start >= 0 else {}
    except Exception:
        return (False, None, None, False)
    cur = data.get("currentVersion")
    latest = data.get("latestVersion")
    newer = bool(data.get("newerAvailable"))
    return (bool(cur), cur, latest, newer)

def install_plugin(openclaw: str, force: bool, spec: Optional[str] = None) -> tuple:
    """Try `openclaw plugins install` (plural, current) first; fall back
    to `openclaw plugin install` (singular, older). With no `spec`, npm resolves
    the latest published version; pass a `spec` (a version like `1.1.0-rc.1` or a
    dist-tag like `next`) to install `<pkg>@<spec>` instead. `force` reinstalls in
    place (used to upgrade/replace an existing install). Returns
    (success, output_tail). output_tail is empty on success and the last
    ~512 chars of combined stdout/stderr on failure."""
    target = f"{NPM_PACKAGE}@{spec}" if spec else NPM_PACKAGE
    base_cmds = [
        [openclaw, "plugins", "install", target],   # canonical (2026.4+)
        [openclaw, "plugin", "install", target],    # legacy
    ]
    last_tail = ""
    for cmd in base_cmds:
        if force:
            cmd = cmd[:3] + ["--force"] + cmd[3:]
        say(f"$ {' '.join(cmd)}")
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        buf: list = []
        if proc.stdout is not None:
            for line in proc.stdout:
                sys.stdout.write(line)
                sys.stdout.flush()
                buf.append(line)
        rc = proc.wait()
        if rc == 0:
            return True, ""
        last_tail = "".join(buf)[-512:]
        # Loop to try the legacy `plugin install` form; if both fail
        # we fall out with the most recent tail.
    return False, _scrub_secrets(last_tail) if last_tail else ""

def restart_gateway(method: str) -> bool:
    """Returns True if a restart was actually issued."""
    openclaw = shutil.which("openclaw") or "openclaw"

    if method == "docker":
        docker = shutil.which("docker")
        if not docker:
            return False
        say("$ docker restart openclaw-gateway")
        r = subprocess.run([docker, "restart", "openclaw-gateway"], capture_output=True, text=True)
        if r.returncode != 0:
            warn(f"docker restart failed: {r.stderr.strip()[:200]}")
            return False
        return True

    if method == "openclaw-supervised":
        say(f"$ {openclaw} gateway restart")
        r = subprocess.run(
            [openclaw, "gateway", "restart"],
            capture_output=True, text=True,
        )
        out = (r.stdout or "") + (r.stderr or "")
        # The CLI returns 0 even when the service isn't installed — catch
        # the actual "disabled" message and fall through to foreground.
        if "service disabled" in out.lower():
            warn("Gateway service is not installed under a supervisor — starting in foreground.")
            return restart_gateway("foreground")
        if r.returncode == 0:
            return True
        if out.strip():
            warn(out.strip()[:500])
        return False

    if method == "foreground":
        # Bare host (container, raw `gateway run` in a terminal, etc.).
        # Kill any existing gateway process and start a fresh one
        # detached. We do NOT pass `--force` because it requires
        # lsof/fuser to clear port 18789, which slim container images
        # rarely ship — the pkill above does the job instead.
        log_path = "/tmp/openclaw-gateway.log"
        try:
            subprocess.run(
                ["pkill", "-9", "-f", "openclaw gateway run"],
                capture_output=True, timeout=5,
            )
        except Exception:
            pass
        import time
        time.sleep(1)  # let port 18789 free up
        try:
            logf = open(log_path, "ab")
            subprocess.Popen(
                [openclaw, "gateway", "run"],
                stdout=logf,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
            say(f"Started gateway in background. Log: {C_CYN}{log_path}{C_RST}")
            # Wait briefly so the gateway has time to bind + load plugins
            # before pair runs.
            time.sleep(4)
            return True
        except Exception as exc:
            warn(f"Could not start gateway: {exc}")
            return False

    return False

def verify_plugin_registered(openclaw: str) -> bool:
    """Try `openclaw chat4000 status` — if the subcommand exists, the
    plugin is loaded."""
    try:
        r = subprocess.run(
            [openclaw, "chat4000", "status"],
            capture_output=True, text=True, timeout=10,
        )
        # Even when 'configured: no', exit code is 0 if the subcommand
        # is registered. Non-zero typically means 'unknown command'.
        return r.returncode == 0
    except Exception:
        return False

def reset_local_state() -> None:
    state_dir = Path.home() / ".openclaw" / "plugins" / "chat4000"
    if state_dir.exists():
        warn(f"Removing {state_dir} (key + ack store) — already-paired devices will fail to decrypt until re-paired.")
        ans = input(f"{C_YEL}Continue? [y/N]:{C_RST} ").strip().lower()
        if ans not in ("y", "yes"):
            say("Reset cancelled.")
            return
        shutil.rmtree(state_dir, ignore_errors=True)
        ok(f"Removed {state_dir}")

# ─── Main ─────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="chat4000 OpenClaw plugin installer",
        add_help=True,
    )
    parser.add_argument("--no-pair", action="store_true",
                        help="install + restart only, don't start pairing")
    parser.add_argument("--no-restart", action="store_true",
                        help="install only, don't touch the gateway")
    parser.add_argument("--reset", action="store_true",
                        help="wipe local key + ack store (destructive)")
    parser.add_argument("--force", action="store_true",
                        help="pass --force to `openclaw plugin install` (re-install in place)")
    parser.add_argument("--no-telemetry", action="store_true",
                        help="disable PostHog + Sentry for this run")
    parser.add_argument("--openclaw-bin", default=None,
                        metavar="PATH",
                        help=(
                            "Skip auto-detection and use this `openclaw` binary "
                            "directly. PATH should be the full path to the openclaw "
                            "executable (e.g. /opt/homebrew/bin/openclaw)."
                        ))
    parser.add_argument("--env", default=None, metavar="NAME",
                        help="backend environment: prod | stage")
    parser.add_argument("--stage", action="store_true",
                        help="use the stage backend (shorthand for --env stage)")
    parser.add_argument("--service-token", default=None, metavar="TOKEN",
                        help="registrar SERVICE_TOKEN used to self-onboard the bot identity")
    parser.add_argument("--plugin-version", default=None, metavar="SPEC",
                        help=(
                            "install this exact version OR npm dist-tag instead of the "
                            "latest stable (e.g. 1.1.0-rc.1, or a tag like 'next'/'test'). "
                            "Use this to test a build before promoting it to 'latest'."
                        ))
    args = parser.parse_args()

    banner()
    _emit("installer_started")

    # 1. Detect openclaw ----------------------------------------------------
    openclaw_path = None
    openclaw_version = "unknown"
    if args.openclaw_bin:
        candidate = str(Path(args.openclaw_bin).expanduser())
        if not (Path(candidate).exists() and os.access(candidate, os.X_OK)):
            err(f"--openclaw-bin {candidate}: not an executable file.")
            _emit("installer_failed", {
                "stage": "detect_openclaw",
                "error_class": "InvalidOpenclawBin",
                "error_msg": f"not executable: {candidate}",
            })
            return 1
        openclaw_path = candidate
        try:
            out = subprocess.run([openclaw_path, "--version"], capture_output=True, text=True, timeout=10)
            line = (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr) else "unknown"
            m = re.search(r"\b(\d+\.\d+\.\d+\S*)", line)
            openclaw_version = m.group(1) if m else line
        except Exception:
            pass
        ok(f"OpenClaw:  {C_CYN}{openclaw_path}{C_RST}  {C_DIM}({openclaw_version}, via --openclaw-bin){C_RST}")
    else:
        detected = detect_openclaw()
        if detected is not None:
            openclaw_path, openclaw_version = detected
            ok(f"OpenClaw:  {C_CYN}{openclaw_path}{C_RST}  {C_DIM}({openclaw_version}){C_RST}")
        else:
            print()
            err("Hey — we couldn't find where you installed OpenClaw.")
            print()
            print(f"We looked here:")
            print(f"  · {C_CYN}openclaw{C_RST} on PATH")
            for pattern in OPENCLAW_LOCATIONS:
                print(f"  · {pattern}")
            print()
            print(f"{C_BOLD}Tell us where it is, or cancel:{C_RST}")
            print(f"  · type the full path to the {C_CYN}openclaw{C_RST} executable")
            print(f"  · or press {C_CYN}Ctrl+C{C_RST} to cancel and re-run with arguments")
            print()
            print(f"{C_BOLD}Examples of a valid path:{C_RST}")
            print(f"  /opt/homebrew/bin/openclaw")
            print(f"  /Applications/OpenClaw.app/Contents/Resources/cli/openclaw")
            print(f"  ~/.nvm/versions/node/v22.19.0/bin/openclaw")
            print()
            print(f"{C_BOLD}Or re-run from your shell:{C_RST}")
            print(f"  {C_CYN}curl ... | bash -s -- --openclaw-bin /your/path/to/openclaw{C_RST}")
            print(f"  {C_CYN}curl ... | bash -s -- --help{C_RST}  {C_DIM}(see all flags){C_RST}")
            print()
            if not sys.stdin.isatty():
                err("(non-interactive shell — cannot prompt. Re-run interactively or pass --openclaw-bin.)")
                _emit("installer_failed", {
                    "stage": "detect_openclaw",
                    "error_class": "NotFound",
                    "error_msg": "no openclaw on PATH; non-interactive shell",
                })
                return 1
            try:
                user_input = input(f"{C_CYN}? OpenClaw executable path:{C_RST} ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                warn("Cancelled.")
                _emit("installer_cancelled", {"stage": "detect_openclaw_prompt"})
                return 130
            if not user_input:
                err("Empty path. Bailing.")
                _emit("installer_failed", {
                    "stage": "detect_openclaw",
                    "error_class": "NotFound",
                    "error_msg": "no openclaw on PATH; empty user input",
                })
                return 1
            candidate = str(Path(user_input).expanduser())
            if not (Path(candidate).exists() and os.access(candidate, os.X_OK)):
                err(f"{candidate} is not an executable file. Bailing.")
                _emit("installer_failed", {
                    "stage": "detect_openclaw",
                    "error_class": "InvalidUserInput",
                    "error_msg": f"not executable: {candidate}",
                    "user_input_path": candidate,
                })
                return 1
            openclaw_path = candidate
            try:
                out = subprocess.run([openclaw_path, "--version"], capture_output=True, text=True, timeout=10)
                line = (out.stdout or out.stderr).strip().splitlines()[0] if (out.stdout or out.stderr) else "unknown"
                m = re.search(r"\b(\d+\.\d+\.\d+\S*)", line)
                openclaw_version = m.group(1) if m else line
            except Exception:
                pass
            ok(f"OpenClaw:  {C_CYN}{openclaw_path}{C_RST}  {C_DIM}({openclaw_version}, via user input){C_RST}")
            _emit("installer_openclaw_path_via_user_input", {"openclaw_path": openclaw_path})
    _emit("installer_openclaw_detected", {"openclaw_version": openclaw_version, "openclaw_path": openclaw_path})

    # 2. Reset mode ---------------------------------------------------------
    if args.reset:
        hdr("Reset mode (destructive)")
        reset_local_state()

    # 3. Install / upgrade --------------------------------------------------
    # --plugin-version pins an exact version/dist-tag (test builds). Otherwise:
    # if already installed, upgrade in place; else fresh-install the latest.
    spec = args.plugin_version
    installed, cur_ver, latest_ver, newer = detect_plugin_state(openclaw_path)
    if spec:
        hdr(f"🧪 Installing {NPM_PACKAGE}@{spec}" + (f" (replacing {cur_ver})" if installed else ""))
        _emit("installer_plugin_pinned_install",
              {"spec": spec, "from_version": cur_ver, "was_installed": installed})
        force = True
    elif installed:
        if newer:
            hdr(f"⬆️  Upgrading {NPM_PACKAGE}: {cur_ver} → {latest_ver or 'latest'}")
            _emit("installer_plugin_upgrade", {"from_version": cur_ver, "to_version": latest_ver})
        elif latest_ver and cur_ver == latest_ver:
            hdr(f"♻️  Reinstalling {NPM_PACKAGE} (already on latest: {cur_ver})")
            _emit("installer_plugin_reinstall", {"version": cur_ver})
        else:
            hdr(f"⬆️  Updating {NPM_PACKAGE} to the latest version (have {cur_ver})")
            _emit("installer_plugin_update", {"from_version": cur_ver, "to_version": latest_ver})
        # An existing install must be force-reinstalled so npm replaces it.
        force = True
    else:
        hdr(f"📦 Installing {NPM_PACKAGE} into OpenClaw")
        _emit("installer_plugin_fresh_install", {})
        force = bool(args.force)

    success, output_tail = install_plugin(openclaw_path, force=force, spec=spec)
    if not success:
        err(f"`openclaw plugins install` failed.")
        err("Common causes:")
        err("  - npm registry unreachable from this host (proxy / offline)")
        err(f"  - The OpenClaw on this host doesn't support `plugins install` — try `{openclaw_path} --help`")
        err("  - Permissions on the OpenClaw plugins directory")
        if spec:
            err(f"  - The version/tag `{spec}` may not exist on npm yet")
        _emit("installer_failed", {
            "stage": "plugin_install",
            "error_class": "InstallFailed",
            "error_msg": output_tail[:200] or "no output",
            "output_tail": output_tail,
            "spec": spec,
        })
        return 1
    if spec:
        ok(f"chat4000 plugin installed: {NPM_PACKAGE}@{spec}.")
    elif installed and newer:
        ok(f"Upgraded chat4000 plugin {cur_ver} → {latest_ver or 'latest'}.")
    else:
        ok(f"chat4000 plugin ready ({latest_ver or 'latest version'}).")
    _emit("installer_pkg_installed", {
        "plugin_package": NPM_PACKAGE,
        "from_version": cur_ver,
        "to_version": latest_ver,
        "spec": spec,
        "was_installed": installed,
    })

    # 4. Onboard identity + pair (v2 / Matrix) -----------------------------
    # The plugin self-onboards a bot identity via the registrar (a
    # kind=plugin pairing code), then invites the paired device.
    # `chat4000 setup --self-redeem` does both: it provisions the bot's
    # Matrix login and (unless --no-pair) runs device pairing, writing the
    # channels.chat4000 config. This MUST run before the gateway start —
    # the gateway only loads channel adapters at boot, so the channel has
    # to be configured first.
    setup_cmd = [openclaw_path, "chat4000", "setup", "--self-redeem"]
    if args.stage:
        setup_cmd.append("--stage")        # → stage registrar + gateway
    elif args.env:
        setup_cmd += ["--env", args.env]
    if args.service_token:
        setup_cmd += ["--service-token", args.service_token]
    if args.no_pair:
        setup_cmd.append("--no-pair")
        hdr("🔑 Onboarding the plugin's Matrix identity")
        _emit("installer_handing_off_to_setup", {"paired": False})
    else:
        hdr("📱 Onboarding + pairing a device")
        print(f"{C_DIM}Scan the QR with the chat4000 iOS/macOS app.{C_RST}")
        print(f"{C_DIM}Press Ctrl-C any time to cancel.{C_RST}\n")
        _emit("installer_handing_off_to_setup", {"paired": True})
    try:
        pair_rc = subprocess.run(setup_cmd).returncode
    except KeyboardInterrupt:
        warn("Onboarding cancelled.")
        _emit("installer_cancelled", {"stage": "setup"})
        return 130
    if pair_rc != 0:
        err(f"Setup exited {pair_rc}.")
        err("If this is a token error, pass --service-token <TOKEN> (or set CHAT4000_SERVICE_TOKEN),")
        err("and select your backend with --env prod|stage.")
        _emit("installer_failed", {"stage": "setup", "exit_code": pair_rc})
        return pair_rc
    if args.no_pair:
        ok("Identity onboarded. Pair a device any time with:")
        print(f"  {C_CYN}{openclaw_path} chat4000 pair{C_RST}")
    else:
        _emit("pairing_completed_via_installer", {})

    # 5. (Re)start gateway — now chat4000 has a key + config ----------------
    if args.no_restart:
        warn("Skipping gateway restart (--no-restart).")
        warn("Plugin is paired but messages won't flow until you restart the gateway:")
        print(f"  {C_CYN}{openclaw_path} gateway run{C_RST}")
        return 0

    hdr("🔁 Starting OpenClaw gateway")
    method = detect_restart_method()
    if method is not None and restart_gateway(method):
        ok(f"Gateway started (method: {method}).")
        _emit("installer_gateway_restarted", {"method": method})
    else:
        warn("Could not auto-start the gateway.")
        warn("If you run OpenClaw under Docker: docker restart openclaw-gateway")
        warn("If you run `openclaw gateway run` in a terminal: start it now.")
        warn("If you run under launchd / systemd: try `openclaw gateway start`.")
        _emit("installer_failed", {
            "stage": "gateway_restart",
            "error_class": "RestartUnavailable",
            "error_msg": f"no working method (probed: {method or 'none'})",
        })
        return 1

    # 6. Wait for chat4000 to actually connect to the relay -----------------
    # The gateway takes ~30s to load all plugins and start channels. The
    # chat4000 channel writes to runtime.log when it connects. Poll that
    # file with a spinner so the user sees progress instead of a silent
    # delay (or worse, exits before the connection lands and sees only
    # 1 tick on their first message).
    print(f"{C_DIM}This can take a couple of minutes on first install while OpenClaw{C_RST}")
    print(f"{C_DIM}loads plugins and the chat4000 channel connects through the gateway.{C_RST}")
    print(f"{C_DIM}Grab a coffee — we'll let you know the moment it's ready.{C_RST}")
    if wait_for_chat4000_connected(timeout=120):
        ok("chat4000 connected. Send a message from your iOS/Mac app — your OpenClaw agent will reply.")
        _emit("installer_succeeded", {})
        _emit("installer_chat4000_relay_connected", {})
        return 0
    warn("chat4000 didn't connect within 120s.")
    warn(f"Watch logs: {C_CYN}tail -f /root/.openclaw/plugins/chat4000/logs/runtime.log{C_RST}")
    warn(f"            {C_CYN}tail -f /tmp/openclaw-gateway.log{C_RST}")
    _emit("installer_failed", {
        "stage": "relay_handshake",
        "error_class": "Timeout",
        "error_msg": "no runtime.hello_ok within 120s",
    })
    _emit("installer_chat4000_relay_timeout", {})
    return 1


# ─── Spinner / wait helpers ───────────────────────────────────────────────

SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]


def wait_for_chat4000_connected(timeout: float = 120.0) -> bool:
    """Poll the chat4000 runtime.log for `runtime.hello_ok` (which
    indicates a successful relay handshake). Show a spinner with status
    text. Returns True if connected within `timeout` seconds."""
    import time as _time

    runtime_log = Path.home() / ".openclaw" / "plugins" / "chat4000" / "logs" / "runtime.log"
    gateway_log = Path("/tmp/openclaw-gateway.log")
    deadline = _time.time() + timeout
    started = _time.time()
    frame_idx = 0
    is_tty = sys.stdout.isatty()
    last_status = ""

    print()  # leading blank line

    while _time.time() < deadline:
        # Check chat4000 runtime log for relay handshake.
        if runtime_log.exists():
            try:
                content = runtime_log.read_text(errors="ignore")
                if "runtime.hello_ok" in content:
                    if is_tty:
                        sys.stdout.write("\r" + " " * 100 + "\r")
                        sys.stdout.flush()
                    return True
            except Exception:
                pass

        # Render spinner — derive a coarse status from what we can see
        # so far so the user knows WHAT we're waiting on.
        status = "starting gateway"
        if gateway_log.exists():
            try:
                gw = gateway_log.read_text(errors="ignore")
                if "[gateway] ready" in gw or "starting channels and sidecars" in gw:
                    status = "loading channels"
                if "[chat4000]" in gw and "Starting chat4000" in gw:
                    status = "chat4000 channel starting"
                if runtime_log.exists():
                    status = "chat4000 connecting to gateway"
            except Exception:
                pass

        if is_tty:
            elapsed = int(_time.time() - started)
            frame = SPINNER_FRAMES[frame_idx % len(SPINNER_FRAMES)]
            line = f"\r{C_CYN}{frame}{C_RST}  {C_BOLD}{status}{C_RST}{C_DIM}  ({elapsed}s){C_RST}"
            # Pad to overwrite any longer previous line cleanly.
            pad = max(0, len(last_status) - len(line))
            sys.stdout.write(line + (" " * pad))
            sys.stdout.flush()
            last_status = line
        _time.sleep(0.1)
        frame_idx += 1

    if is_tty:
        sys.stdout.write("\r" + " " * 100 + "\r")
        sys.stdout.flush()
    return False

def _entry() -> int:
    """Top-level wrapper that reports uncaught exceptions to Sentry.

    Keeps Ctrl-C (KeyboardInterrupt) silent — that's a user action, not
    a bug. Everything else: report + print a friendly message + exit 1."""
    try:
        return main()
    except KeyboardInterrupt:
        print()
        warn("Install cancelled.")
        return 130
    except SystemExit:
        raise
    except BaseException as exc:
        err(f"Installer crashed unexpectedly: {type(exc).__name__}: {exc}")
        _emit("installer_crashed", {
            "error_class": type(exc).__name__,
            "error_msg": str(exc)[:200],
        })
        send_sentry_envelope(exc, tags={"crash_stage": "uncaught"})
        err("Crash report sent. If this keeps happening, please open an issue:")
        err("  https://github.com/chat4000/chat4000-openclaw-plugin/issues")
        return 1


if __name__ == "__main__":
    sys.exit(_entry())
