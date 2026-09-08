import { describe, expect, it } from "vitest";
import {
  CIRCLE_CHAIN_CODES,
  SELAT_REFUND_CHAIN_IDS,
  circleChainCode,
} from "./policy";

describe("CIRCLE_CHAIN_CODES", () => {
  it("matches `circle blockchain list` output (verified 2026-09-08)", () => {
    expect(CIRCLE_CHAIN_CODES).toEqual({
      1: "ETH",
      10: "OP",
      130: "UNI",
      137: "MATIC",
      8453: "BASE",
      42161: "ARB",
      43114: "AVAX",
    });
  });

  it("has no code for Arc mainnet until the Circle CLI ships one", () => {
    // Circle CLI exposes only ARC-TESTNET (5042002) as of 2026-09-08.
    // Re-check after Arc mainnet launch (2026-09-16).
    expect(circleChainCode(5042)).toBeUndefined();
  });

  it("covers every other allowlisted refund chain", () => {
    for (const chainId of SELAT_REFUND_CHAIN_IDS) {
      if (chainId === 5042) continue;
      expect(circleChainCode(chainId), `chain ${chainId}`).toBeTypeOf("string");
    }
  });
});
