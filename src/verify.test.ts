import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, pad, type Address, type Hex } from "viem";
import { createRefundMessage } from "./message";
import { verifyRefundClaim } from "./verify";
import { circleMscaReplaySafeDigest } from "./circle";
import { UnsupportedRefundNamespaceError } from "./errors";
import type { EvmReadClient } from "./types";

const QUOTE = "selatx2ce759a5-e812-48d1-bbf0-f738ad0d42e4";

function expectedFor(account: string, chainId = 8453) {
  return {
    domain: "router.selat.ai",
    quoteId: QUOTE,
    op: "claim" as const,
    chainId,
    account,
  };
}

function refundMessageFor(account: string, chainId = 8453) {
  return createRefundMessage({
    account,
    chainId,
    quoteId: QUOTE,
    op: "claim",
    nonce: "server-nonce-123456",
    expirationTime: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
}

describe("verifyRefundClaim — EOA path", () => {
  it("verifies a signature from the account itself", async () => {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const { message, text } = refundMessageFor(account.address);
    const signature = await account.signMessage({ message: text });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(account.address),
    });
    expect(result.isValid).toBe(true);
    expect(result.method).toBe("eoa");
    expect(result.accountAddress).toBe(getAddress(account.address));
  });

  it("rejects a signature over tampered text", async () => {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const { message, text } = refundMessageFor(account.address);
    const signature = await account.signMessage({ message: text + " tampered" });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(account.address),
    });
    expect(result.isValid).toBe(false);
  });

  it("refuses to verify before validation passes (expired message, valid signature)", async () => {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const { message, text } = refundMessageFor(account.address);
    const expired = { ...message, expirationTime: "2000-01-01T00:00:00.000Z" };
    const signature = await account.signMessage({ message: text });

    const result = await verifyRefundClaim({
      message: expired,
      signature,
      expected: expectedFor(account.address),
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe("validation-failed");
  });

  it("throws the typed namespace error for a solana message", async () => {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const { message } = refundMessageFor(account.address);

    await expect(
      verifyRefundClaim({
        message: { ...message, chainId: "solana:mainnet" },
        signature: "0x00",
        expected: expectedFor(account.address),
      })
    ).rejects.toThrow(UnsupportedRefundNamespaceError);
  });

  it("survives a non-65-byte signature and reports a structured failure", async () => {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const { message } = refundMessageFor(account.address);
    const longSignature = ("0x" + "ab".repeat(100)) as Hex;

    const result = await verifyRefundClaim({
      message,
      signature: longSignature,
      expected: expectedFor(account.address),
    });
    expect(result.isValid).toBe(false);
    // Must NOT throw — siwx-lib 0.1.2 aborts here, making 1271 unreachable.
  });
});

describe("verifyRefundClaim — on-chain EIP-1271 path", () => {
  it("accepts when the wallet has code and isValidSignature agrees", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const sca = "0x1111111111111111111111111111111111111111";
    const { message, text } = refundMessageFor(sca);
    const signature = await owner.signMessage({ message: text });

    const chainClient: EvmReadClient = {
      async getCode() {
        return "0x60806040" as Hex;
      },
      async getStorageAt() {
        return undefined;
      },
      async readContract() {
        throw new Error("not used");
      },
      async verifyMessage(args) {
        return args.address === getAddress(sca) && args.message === text;
      },
    };

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca),
      clients: { 8453: chainClient },
    });
    expect(result.isValid).toBe(true);
    expect(result.method).toBe("eip1271");
    expect(result.accountType).toBe("contract");
  });
});

describe("verifyRefundClaim — deployless Circle-SCA path", () => {
  const IMPL = getAddress("0xd206ac7f000000000000000000000000000000aa");

  function mockClients(args: {
    owner: Address;
    sca: Address;
    implementation?: Address;
    deployedOn?: number;
  }) {
    const deployedOn = args.deployedOn ?? 8453;
    const implementation = args.implementation ?? IMPL;
    const deployedClient: EvmReadClient = {
      async getCode() {
        return "0x60806040" as Hex;
      },
      async getStorageAt({ slot }) {
        return pad(implementation, { size: 32 }) as Hex;
      },
      async readContract({ functionName }) {
        if (functionName === "getNativeOwner") return args.owner;
        throw new Error(`unexpected call ${functionName}`);
      },
    };
    const emptyClient: EvmReadClient = {
      async getCode() {
        return "0x" as Hex;
      },
      async getStorageAt() {
        return undefined;
      },
      async readContract() {
        throw new Error("no code");
      },
    };
    return { [deployedOn]: deployedClient, 137: emptyClient };
  }

  it("verifies an undeployed-on-verification-chain wallet via digest reconstruction", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const sca = getAddress("0x2222222222222222222222222222222222222222");
    // Verification chain = Polygon (no code there); code lives on Base.
    const { message, text } = refundMessageFor(sca, 137);
    const digest = circleMscaReplaySafeDigest({ chainId: 137, wallet: sca, text });
    const signature = await owner.sign({ hash: digest });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca, 137),
      clients: mockClients({ owner: owner.address, sca }),
      knownImplementations: new Set([IMPL]),
    });
    expect(result.isValid).toBe(true);
    expect(result.method).toBe("deployless-circle-sca");
    expect(result.signerAddress).toBe(getAddress(owner.address));
  });

  it("accepts the probed Circle implementation under the default allowlist", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const sca = getAddress("0x2222222222222222222222222222222222222222");
    const { message, text } = refundMessageFor(sca, 137);
    const digest = circleMscaReplaySafeDigest({ chainId: 137, wallet: sca, text });
    const signature = await owner.sign({ hash: digest });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca, 137),
      clients: mockClients({
        owner: owner.address,
        sca,
        // Circle_SingleOwnerMSCA v1.0.0, probed on Base 2026-09-08.
        implementation: getAddress("0xD206aC7fEf53d83ED4563E770b28Dba90D0D9eC8"),
      }),
      // default allowlist — no knownImplementations override
    });
    expect(result.isValid).toBe(true);
    expect(result.method).toBe("deployless-circle-sca");
  });

  it("rejects a signature bound to a different chain (chain-bound digests)", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const sca = getAddress("0x2222222222222222222222222222222222222222");
    const { message, text } = refundMessageFor(sca, 137);
    // Owner signs the BASE digest, but the challenge said Polygon.
    const wrongChainDigest = circleMscaReplaySafeDigest({ chainId: 8453, wallet: sca, text });
    const signature = await owner.sign({ hash: wrongChainDigest });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca, 137),
      clients: mockClients({ owner: owner.address, sca }),
      knownImplementations: new Set([IMPL]),
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe("owner-mismatch");
  });

  it("fails closed on an unknown implementation", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const sca = getAddress("0x2222222222222222222222222222222222222222");
    const { message, text } = refundMessageFor(sca, 137);
    const digest = circleMscaReplaySafeDigest({ chainId: 137, wallet: sca, text });
    const signature = await owner.sign({ hash: digest });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca, 137),
      clients: mockClients({
        owner: owner.address,
        sca,
        implementation: getAddress("0x9999999999999999999999999999999999999999"),
      }),
      knownImplementations: new Set([IMPL]),
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe("unknown-implementation");
  });

  it("fails closed under the default allowlist for an implementation not probed on-chain", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const sca = getAddress("0x2222222222222222222222222222222222222222");
    const { message, text } = refundMessageFor(sca, 137);
    const digest = circleMscaReplaySafeDigest({ chainId: 137, wallet: sca, text });
    const signature = await owner.sign({ hash: digest });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca, 137),
      clients: mockClients({ owner: owner.address, sca }),
      // no knownImplementations → KNOWN_CIRCLE_MSCA_IMPLEMENTATIONS; the mock
      // impl (0x…00aa) is not the probed Circle address, so it must fail closed.
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe("unknown-implementation");
  });

  it("rejects a non-owner signature", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());
    const sca = getAddress("0x2222222222222222222222222222222222222222");
    const { message, text } = refundMessageFor(sca, 137);
    const digest = circleMscaReplaySafeDigest({ chainId: 137, wallet: sca, text });
    const signature = await stranger.sign({ hash: digest });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca, 137),
      clients: mockClients({ owner: owner.address, sca }),
      knownImplementations: new Set([IMPL]),
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe("owner-mismatch");
  });

  it("reports no-deployed-chain-found when the wallet has code nowhere", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const sca = getAddress("0x2222222222222222222222222222222222222222");
    const { message, text } = refundMessageFor(sca, 137);
    const digest = circleMscaReplaySafeDigest({ chainId: 137, wallet: sca, text });
    const signature = await owner.sign({ hash: digest });

    const emptyClient: EvmReadClient = {
      async getCode() {
        return "0x" as Hex;
      },
      async getStorageAt() {
        return undefined;
      },
      async readContract() {
        throw new Error("no code");
      },
    };

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca, 137),
      clients: { 137: emptyClient, 8453: emptyClient },
      knownImplementations: new Set([IMPL]),
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe("no-deployed-chain-found");
  });
});
