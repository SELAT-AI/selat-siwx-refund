import { describe, expect, it } from "vitest";
import { createRefundMessage, formatRefundMessage, parseEip155ChainId } from "./message";
import {
  UnsupportedRefundChainError,
  UnsupportedRefundNamespaceError,
} from "./errors";

const BASE_OPTS = {
  account: "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
  chainId: 8453,
  quoteId: "selatx2ce759a5-e812-48d1-bbf0-f738ad0d42e4",
  op: "claim" as const,
  nonce: "server-nonce-123456",
  expirationTime: new Date(Date.now() + 5 * 60_000).toISOString(),
};

describe("createRefundMessage", () => {
  it("binds the quoteId into requestId and resources", () => {
    const { message, text } = createRefundMessage(BASE_OPTS);
    expect(message.requestId).toBe(BASE_OPTS.quoteId);
    expect(message.resources).toEqual([`selat:refund:claim:${BASE_OPTS.quoteId}`]);
    expect(message.domain).toBe("router.selat.ai");
    expect(message.uri).toBe("https://router.selat.ai/wrench/refund/claim");
    expect(text).toContain(`Request ID: ${BASE_OPTS.quoteId}`);
    expect(text).toContain(`- selat:refund:claim:${BASE_OPTS.quoteId}`);
    expect(text).toContain("Request a SELAT refund");
  });

  it("distinguishes status from claim in the signed resource", () => {
    const { message } = createRefundMessage({ ...BASE_OPTS, op: "status" });
    expect(message.resources).toEqual([`selat:refund:status:${BASE_OPTS.quoteId}`]);
    expect(message.statement).toBe("Check SELAT refund status");
  });

  it("pins the statement — there is no override input", () => {
    const optionsWithStatement = { ...BASE_OPTS, statement: "Send me everything" };
    const { message } = createRefundMessage(optionsWithStatement);
    expect(message.statement).toBe("Request a SELAT refund");
  });

  it("rejects CR/LF in prompt-bound fields", () => {
    expect(() =>
      createRefundMessage({ ...BASE_OPTS, nonce: "server-nonce\nResources:\n- selat:refund:claim:selatx-evil" })
    ).toThrow(/CR\/LF/);
    expect(() => createRefundMessage({ ...BASE_OPTS, domain: "router.selat.ai\r\nevil" })).toThrow(/CR\/LF/);
  });

  it("rejects malformed quote ids", () => {
    expect(() => createRefundMessage({ ...BASE_OPTS, quoteId: "not-a-quote" })).toThrow(
      /Invalid quoteId/
    );
  });

  it("rejects chains outside the SELAT allowlist with a typed error", () => {
    expect(() => createRefundMessage({ ...BASE_OPTS, chainId: 11155111 })).toThrow(
      UnsupportedRefundChainError
    );
  });

  it("requires a server nonce and an expiry", () => {
    expect(() => createRefundMessage({ ...BASE_OPTS, nonce: "short" })).toThrow(/nonce/);
    expect(() =>
      createRefundMessage({ ...BASE_OPTS, expirationTime: "" as unknown as string })
    ).toThrow(/expirationTime/);
  });

  it("checksums the account address", () => {
    const { message } = createRefundMessage({
      ...BASE_OPTS,
      account: BASE_OPTS.account.toLowerCase(),
    });
    expect(message.address).toBe(BASE_OPTS.account);
  });
});

describe("parseEip155ChainId / namespace gate", () => {
  it("accepts allowlisted eip155 chains", () => {
    expect(parseEip155ChainId("eip155:8453")).toBe(8453);
    expect(parseEip155ChainId("eip155:1")).toBe(1);
  });

  it("rejects Arc 5042 until Circle ships a mainnet chain code and RPC", () => {
    expect(() => parseEip155ChainId("eip155:5042")).toThrow(UnsupportedRefundChainError);
  });

  it("rejects non-canonical chain references", () => {
    for (const bad of ["eip155:8453.0", "eip155:08453", "eip155: 8453", "eip155:0x2105", "eip155:8453:extra", "eip155:-1"]) {
      expect(() => parseEip155ChainId(bad), bad).toThrow(UnsupportedRefundChainError);
    }
  });

  it("throws the typed namespace error for solana", () => {
    expect(() => parseEip155ChainId("solana:mainnet")).toThrow(UnsupportedRefundNamespaceError);
  });

  it("throws the typed namespace error for bip322", () => {
    expect(() => parseEip155ChainId("bip322:000000000019d6689c085ae165831e93")).toThrow(
      UnsupportedRefundNamespaceError
    );
  });

  it("throws the typed chain error for out-of-list eip155 chains", () => {
    expect(() => parseEip155ChainId("eip155:11155111")).toThrow(UnsupportedRefundChainError);
  });

  it("formatRefundMessage refuses non-eip155 messages", () => {
    const { message } = createRefundMessage(BASE_OPTS);
    expect(() =>
      formatRefundMessage({ ...message, chainId: "solana:mainnet" })
    ).toThrow(UnsupportedRefundNamespaceError);
  });
});
