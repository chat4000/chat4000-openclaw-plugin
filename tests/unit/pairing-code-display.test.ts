import { describe, expect, it } from "vitest";
import { buildQrUri, formatPairingCodeForDisplay } from "../../src/pairing/qr.js";

describe("formatPairingCodeForDisplay", () => {
  it("dashes a standard 6-digit code as NNN-NNN", () => {
    expect(formatPairingCodeForDisplay("547973")).toBe("547-973");
    expect(formatPairingCodeForDisplay("000000")).toBe("000-000");
  });

  it("shows non-6-digit or non-numeric codes verbatim (guard)", () => {
    expect(formatPairingCodeForDisplay("12345")).toBe("12345"); // too short
    expect(formatPairingCodeForDisplay("1234567")).toBe("1234567"); // too long
    expect(formatPairingCodeForDisplay("12a456")).toBe("12a456"); // non-digit
    expect(formatPairingCodeForDisplay("")).toBe("");
  });

  it("never alters the code carried in the QR/link payload (stays dash-less)", () => {
    // The dash is display-only: the raw code is what goes into the universal link.
    expect(buildQrUri({ code: "547973" })).toContain("code=547973");
    expect(buildQrUri({ code: "547973" })).not.toContain("547-973");
  });
});
