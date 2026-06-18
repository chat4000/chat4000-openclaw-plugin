// Sentry DSN for the dedicated self-hosted chat4000-plugin project
// (sentry.chat4000.com, project id 4). Committed in plaintext on purpose: the
// installer clones this PUBLIC repo straight from GitHub, so the DSN must be
// present in source for telemetry to work at all. A Sentry DSN is a public,
// write-only ingestion key (same as scripts/installer.py), not a secret.
export const SENTRY_DSN = "https://7124e4659771caddd5a6d28a87fa9e02@sentry.chat4000.com/4";
