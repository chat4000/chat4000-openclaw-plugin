import { beforeEach, describe, expect, it } from "vitest";
import {
  agentTurnInFlight,
  beginAgentTurn,
  endAgentTurn,
  resetAgentTurnTracker,
} from "../../src/turn-tracker.js";

describe("agent-turn tracker (PROTOCOL C.5 not-on-message-path gate)", () => {
  beforeEach(() => resetAgentTurnTracker());

  it("reports no turn in flight initially", () => {
    expect(agentTurnInFlight()).toBe(false);
  });

  it("is in flight between begin and end", () => {
    beginAgentTurn();
    expect(agentTurnInFlight()).toBe(true);
    endAgentTurn();
    expect(agentTurnInFlight()).toBe(false);
  });

  it("stays in flight until ALL concurrent turns end (counter, not boolean)", () => {
    beginAgentTurn();
    beginAgentTurn();
    expect(agentTurnInFlight()).toBe(true);
    endAgentTurn();
    expect(agentTurnInFlight()).toBe(true); // one still running
    endAgentTurn();
    expect(agentTurnInFlight()).toBe(false);
  });

  it("never goes negative on an unmatched end", () => {
    endAgentTurn();
    expect(agentTurnInFlight()).toBe(false);
    beginAgentTurn();
    expect(agentTurnInFlight()).toBe(true);
  });
});
