#!/usr/bin/env python3.12
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path.cwd()
GENERATED_DSN = ROOT / "src" / "telemetry-dsn.generated.ts"
LOCAL_DSN_COPY = Path.home() / ".config" / "chat4000" / "sentry-dsn"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build, validate, and publish the chat4000 OpenClaw plugin to npm.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Run all validation but do not publish.")
    parser.add_argument("--skip-tests", action="store_true", help="Skip npm test.")
    parser.add_argument(
        "--prepare-only",
        action="store_true",
        help="Resolve and write the Sentry DSN, then exit. No build/test/publish.",
    )
    parser.add_argument(
        "--from-file",
        action="store_true",
        help=f"Read DSN from {LOCAL_DSN_COPY} instead of fetching via Sentry CLI.",
    )
    parser.add_argument("--sentry-org", default=os.environ.get("SENTRY_ORG", "sentry"))
    parser.add_argument("--sentry-project", default=os.environ.get("SENTRY_PROJECT", "chat4000-plugin"))
    parser.add_argument(
        "--tag",
        default="latest",
        help="npm dist-tag to publish under (default: latest).",
    )
    args = parser.parse_args()

    if not args.prepare_only:
        run(["npm", "whoami"])

    # Prefer the cached local DSN copy (LOCAL_DSN_COPY) when it exists. The
    # self-hosted Sentry API fetch needs creds the publish host usually lacks
    # (a read-only / non-enumerating token 404s on the project's keys), so the
    # local copy a maintainer seeds once is the real source of truth. `--from-file`
    # forces the local copy; the API fetch is only a last resort.
    if args.from_file or LOCAL_DSN_COPY.exists():
        if not args.from_file:
            print(f"Using cached Sentry DSN from {LOCAL_DSN_COPY}.")
        dsn = read_local_dsn()
    else:
        dsn = fetch_sentry_dsn(args.sentry_org, args.sentry_project)

    if dsn:
        validate_sentry_dsn(dsn)
        write_generated_dsn(dsn)
        write_local_dsn_copy(dsn)
    else:
        write_generated_dsn("")
        print(f"Wrote empty Sentry DSN to {GENERATED_DSN}; {LOCAL_DSN_COPY} was not found.")

    if args.prepare_only:
        # Leave the real DSN in place: prepare-only exists to inject it for local
        # from-source runs (the caller asked for it).
        return

    try:
        run(["npm", "run", "build"])
        if not args.skip_tests:
            run(["npm", "test"])
        run(["npm", "pack", "--dry-run"])

        if args.dry_run:
            print("Dry run complete. No package was published.")
            return

        run(["npm", "publish", "--access", "public", "--tag", args.tag])
    finally:
        # Restore the committed empty-DSN default so the real DSN never lingers as
        # an uncommitted change in the tracked file. The DSN ships only in the
        # published tarball (packed above); it is never committed to git.
        write_generated_dsn("")
        print(f"Restored committed empty-DSN default in {GENERATED_DSN}.")


def read_local_dsn() -> str:
    try:
        return LOCAL_DSN_COPY.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def fetch_sentry_dsn(org: str, project: str) -> str:
    endpoint = f"projects/{org}/{project}/keys/"
    result = run(["sentry", "api", endpoint, "--json"], capture=True)

    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        die(f"Could not parse Sentry API response: {exc}")

    keys = parsed.get("data") if isinstance(parsed, dict) else parsed
    if not isinstance(keys, list):
        die(f"Unexpected Sentry API response for {org}/{project}.")

    for key in keys:
        if not isinstance(key, dict):
            continue
        dsn = key.get("dsn")
        if not isinstance(dsn, dict):
            continue
        for name in ("public", "cdn", "security"):
            value = dsn.get(name)
            if isinstance(value, str) and value:
                return value

    die(f"No public DSN found for Sentry project {org}/{project}.")


def validate_sentry_dsn(dsn: str) -> None:
    parsed = urlparse(dsn)
    if parsed.scheme != "https":
        die("Sentry DSN must use https.")
    if not parsed.username:
        die("Sentry DSN is missing the public key.")
    if not parsed.path.strip("/").isdigit():
        die("Sentry DSN is missing a numeric project id path.")


def write_generated_dsn(dsn: str) -> None:
    GENERATED_DSN.parent.mkdir(parents=True, exist_ok=True)
    GENERATED_DSN.write_text(
        "\n".join(
            [
                "// Sentry DSN. Overwritten with the real DSN by scripts/publish_npm.py at",
                "// publish; the committed empty default keeps from-source installs loading.",
                f"export const SENTRY_DSN = {json.dumps(dsn)};",
                "",
            ],
        ),
        encoding="utf-8",
    )
    GENERATED_DSN.chmod(0o600)
    if dsn:
        print(f"Wrote Sentry DSN to {GENERATED_DSN}")


def write_local_dsn_copy(dsn: str) -> None:
    try:
        LOCAL_DSN_COPY.parent.mkdir(parents=True, exist_ok=True)
        LOCAL_DSN_COPY.write_text(f"{dsn}\n", encoding="utf-8")
        LOCAL_DSN_COPY.chmod(0o600)
    except OSError:
        pass


def run(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    print("$ " + " ".join(command))
    result = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        check=False,
    )
    if result.returncode != 0:
        if capture:
            sys.stderr.write(result.stderr or result.stdout or "")
        die("Command failed: " + " ".join(command))
    return result


def die(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


if __name__ == "__main__":
    main()
