import { describe, expect, it } from "vitest";
import { scrubEvent, scrubSecrets } from "../../src/telemetry.js";
import type { ErrorEvent } from "@sentry/node";

describe("telemetry", () => {
  it("redacts common secret patterns", () => {
    const text = [
      "sk-abcdefghijklmnopqrstuvwxyz123456",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "AKIA1234567890ABCDEF",
      "Bearer abc.def-ghi",
      "password=secret",
      "token: secret",
    ].join(" ");

    const scrubbed = scrubSecrets(text);

    expect(scrubbed).toContain("[REDACTED_API_KEY]");
    expect(scrubbed).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(scrubbed).toContain("[REDACTED_AWS_KEY]");
    expect(scrubbed).toContain("Bearer [REDACTED]");
    expect(scrubbed).toContain("password=[REDACTED]");
    expect(scrubbed).toContain("token=[REDACTED]");
  });

  it("scrubs user paths and sensitive extras from sentry events", () => {
    const event: ErrorEvent = {
      exception: {
        values: [
          {
            type: "Error",
            value: "failed with token=secret",
            stacktrace: {
              frames: [
                {
                  filename: "/Users/alice/project/src/index.ts",
                },
                {
                  filename: "/home/bob/project/src/index.ts",
                },
              ],
            },
          },
        ],
      },
      extra: {
        argv: ["node", "secret"],
        env: { OPENAI_API_KEY: "sk-test" },
      },
      contexts: {
        runtime: {
          name: "node",
          env: { SECRET: "value" },
        },
        os: {
          name: "darwin",
          kernel_version: "private",
        },
      },
    };

    const scrubbed = scrubEvent(event);
    const frames = scrubbed.exception?.values?.[0]?.stacktrace?.frames ?? [];

    expect(frames[0]?.filename).toBe("/Users/<user>/project/src/index.ts");
    expect(frames[1]?.filename).toBe("/home/<user>/project/src/index.ts");
    expect(scrubbed.exception?.values?.[0]?.value).toBe("failed with token=[REDACTED]");
    expect(scrubbed.extra?.argv).toBeUndefined();
    expect(scrubbed.extra?.env).toBeUndefined();
    expect((scrubbed.contexts?.runtime as Record<string, unknown>).env).toBeUndefined();
    expect((scrubbed.contexts?.os as Record<string, unknown>).kernel_version).toBeUndefined();
  });
});
