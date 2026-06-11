import { defineConfig, defineWorkspace } from "vitest/config";

export default defineConfig({
  test: {
    // Hard test-isolation guarantee: no test ever emits real telemetry/analytics
    // to prod PostHog/Sentry. Tests that exercise the analytics gate mock
    // telemetry.js directly, so this only neutralizes incidental emitters (e.g.
    // a self-update path that transitively calls analytics.track).
    env: { CHAT4000_TELEMETRY_DISABLED: "1" },
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: "contract",
          include: ["tests/contract/**/*.test.ts"],
          testTimeout: 15_000,
        },
      },
    ],
  },
});
