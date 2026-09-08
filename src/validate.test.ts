import { describe, expect, it } from "vitest";
import { createRefundMessage } from "./message";
import { assertValidRefundMessage, validateRefundMessage } from "./validate";
import { RefundValidationError } from "./errors";

const QUOTE = "selatx2ce759a5-e812-48d1-bbf0-f738ad0d42e4";
const ACCOUNT = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";

function goodMessage(overrides: Record<string, unknown> = {}) {
  const { message } = createRefundMessage({
    account: ACCOUNT,
    chainId: 8453,
    quoteId: QUOTE,
    op: "claim",
    nonce: "server-nonce-123456",
    expirationTime: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  return { ...message, ...overrides };
}

const EXPECTED = {
  domain: "router.selat.ai",
  quoteId: QUOTE,
  op: "claim" as const,
  chainId: 8453,
  account: ACCOUNT,
};

describe("validateRefundMessage", () => {
  it("passes a well-formed, freshly-issued claim", () => {
    const result = validateRefundMessage(goodMessage(), EXPECTED);
    expect(result.failures).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.chainId).toBe(8453);
  });

  it("rejects a foreign domain (a proof signed for another site)", () => {
    const result = validateRefundMessage(goodMessage({ domain: "evil.example" }), EXPECTED);
    expect(result.valid).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain("DOMAIN_MISMATCH");
  });

  it("rejects a uri outside the expected origin", () => {
    const result = validateRefundMessage(
      goodMessage({ uri: "https://evil.example/wrench/refund/claim" }),
      EXPECTED
    );
    expect(result.failures.map((f) => f.code)).toContain("URI_MISMATCH");
  });

  it("rejects an expired message (siwx-lib itself verifies these as true)", () => {
    const result = validateRefundMessage(
      goodMessage({ expirationTime: "2000-01-01T00:00:00.000Z" }),
      EXPECTED
    );
    expect(result.failures.map((f) => f.code)).toContain("EXPIRED");
  });

  it("rejects a missing expiry", () => {
    const result = validateRefundMessage(goodMessage({ expirationTime: undefined }), EXPECTED);
    expect(result.failures.map((f) => f.code)).toContain("MISSING_EXPIRATION");
  });

  it("rejects a stale issuedAt outside the replay window", () => {
    const result = validateRefundMessage(
      goodMessage({ issuedAt: new Date(Date.now() - 10 * 60_000).toISOString() }),
      EXPECTED
    );
    expect(result.failures.map((f) => f.code)).toContain("ISSUED_TOO_OLD");
  });

  it("rejects an issuedAt from the future beyond clock skew", () => {
    const result = validateRefundMessage(
      goodMessage({ issuedAt: new Date(Date.now() + 5 * 60_000).toISOString() }),
      EXPECTED
    );
    expect(result.failures.map((f) => f.code)).toContain("ISSUED_IN_FUTURE");
  });

  it("rejects a requestId that does not match the claimed quoteId", () => {
    const result = validateRefundMessage(goodMessage(), {
      ...EXPECTED,
      quoteId: "selatx99999999-0000-0000-0000-000000000000",
    });
    const codes = result.failures.map((f) => f.code);
    expect(codes).toContain("REQUEST_ID_MISMATCH");
    expect(codes).toContain("RESOURCE_MISMATCH");
  });

  it("rejects a claim proof presented for a status operation", () => {
    const result = validateRefundMessage(goodMessage(), { ...EXPECTED, op: "status" });
    expect(result.failures.map((f) => f.code)).toContain("RESOURCE_MISMATCH");
  });

  it("rejects an address that is not the recorded payer", () => {
    const result = validateRefundMessage(goodMessage(), {
      ...EXPECTED,
      account: "0x0000000000000000000000000000000000000001",
    });
    expect(result.failures.map((f) => f.code)).toContain("ADDRESS_MISMATCH");
  });

  it("rejects a chain other than the challenge chain", () => {
    const result = validateRefundMessage(goodMessage(), { ...EXPECTED, chainId: 137 });
    expect(result.failures.map((f) => f.code)).toContain("CHAIN_MISMATCH");
  });

  it("rejects a short nonce", () => {
    const result = validateRefundMessage(goodMessage({ nonce: "abc" }), EXPECTED);
    expect(result.failures.map((f) => f.code)).toContain("NONCE_TOO_SHORT");
  });

  it("assertValidRefundMessage throws with every failure listed", () => {
    try {
      assertValidRefundMessage(
        goodMessage({ domain: "evil.example", expirationTime: "2000-01-01T00:00:00.000Z" }),
        EXPECTED
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RefundValidationError);
      const codes = (error as RefundValidationError).failures.map((f) => f.code);
      expect(codes).toContain("DOMAIN_MISMATCH");
      expect(codes).toContain("EXPIRED");
    }
  });
});
