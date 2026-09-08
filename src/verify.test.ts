import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, pad, type Address, type Hex } from "viem";
import { createRefundMessage } from "./message";
import { verifyRefundClaim } from "./verify";
import { circleMscaReplaySafeDigest, verifyPayerLinkage } from "./circle";
import { UnsupportedRefundNamespaceError } from "./errors";
import type { EvmReadClient, RefundAccountType } from "./types";

const QUOTE = "selatx2ce759a5-e812-48d1-bbf0-f738ad0d42e4";
const IMPL = getAddress("0xD206aC7fEf53d83ED4563E770b28Dba90D0D9eC8");
const UNKNOWN_IMPL = getAddress("0x9999999999999999999999999999999999999999");

function expectedFor(account: string, accountType: RefundAccountType, chainId = 8453) {
  return {
    domain: "router.selat.ai",
    quoteId: QUOTE,
    op: "claim" as const,
    chainId,
    account,
    uri: "https://router.selat.ai/wrench/refund/claim",
    accountType,
  };
}

function refundMessageFor(account: string, chainId = 8453) {
  return createRefundMessage({
    account,
    chainId,
    quoteId: QUOTE,
    op: "claim",
    nonce: "server-nonce-123456",
    expirationTime: new Date(Date.now() + 4 * 60_000).toISOString(),
  });
}

function contractClient(args: {
  implementation?: Address;
  owner?: Address;
  verify?: (message: string) => boolean;
}): EvmReadClient {
  return {
    async getCode() {
      return "0x60806040" as Hex;
    },
    async getStorageAt() {
      return pad(args.implementation ?? IMPL, { size: 32 }) as Hex;
    },
    async readContract({ functionName }) {
      if (functionName === "getNativeOwner" && args.owner) return args.owner;
      throw new Error(`unexpected call ${functionName}`);
    },
    async verifyMessage({ message }) {
      return args.verify ? args.verify(message) : false;
    },
  };
}

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

describe("verifyRefundClaim — EOA path", () => {
  it("verifies a signature from the account itself", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { message, text } = refundMessageFor(account.address);
    const signature = await account.signMessage({ message: text });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(account.address, "eoa"),
    });
    expect(result.isValid).toBe(true);
    expect(result.method).toBe("eoa");
    expect(result.accountAddress).toBe(getAddress(account.address));
    expect(result.signedText).toBe(text);
  });

  it("rejects a signature over tampered text", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { message, text } = refundMessageFor(account.address);
    const signature = await account.signMessage({ message: text + " tampered" });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(account.address, "eoa"),
    });
    expect(result.isValid).toBe(false);
  });

  it("refuses to verify before validation passes (expired message, valid signature)", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { message, text } = refundMessageFor(account.address);
    const expired = { ...message, expirationTime: "2000-01-01T00:00:00.000Z" };
    const signature = await account.signMessage({ message: text });

    const result = await verifyRefundClaim({
      message: expired,
      signature,
      expected: expectedFor(account.address, "eoa"),
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe("validation-failed");
  });

  it("returns validation-failed for an unparseable address instead of throwing", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { message } = refundMessageFor(account.address);

    const result = await verifyRefundClaim({
      message: { ...message, address: "0xnot-an-address" },
      signature: "0x00",
      expected: expectedFor(account.address, "eoa"),
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe("validation-failed");
    expect(result.validationFailures?.[0]?.code).toBe("BAD_ADDRESS");
  });

  it("throws the typed namespace error for a solana message", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { message } = refundMessageFor(account.address);

    await expect(
      verifyRefundClaim({
        message: { ...message, chainId: "solana:mainnet" },
        signature: "0x00",
        expected: expectedFor(account.address, "eoa"),
      })
    ).rejects.toThrow(UnsupportedRefundNamespaceError);
  });

  it("survives a non-65-byte signature and reports a structured failure", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { message } = refundMessageFor(account.address);
    const longSignature = ("0x" + "ab".repeat(100)) as Hex;

    const result = await verifyRefundClaim({
      message,
      signature: longSignature,
      expected: expectedFor(account.address, "eoa"),
    });
    expect(result.isValid).toBe(false);
  });

  it("rejects an EOA self-match when the challenge said the account is a contract", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const { message, text } = refundMessageFor(account.address);
    const signature = await account.signMessage({ message: text });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(account.address, "contract"),
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe("account-type-mismatch");
  });
});

describe("verifyRefundClaim — on-chain EIP-1271 path", () => {
  it("accepts when the wallet has code, a known implementation, and isValidSignature agrees", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const sca = "0x1111111111111111111111111111111111111111";
    const { message, text } = refundMessageFor(sca);
    const signature = await owner.signMessage({ message: text });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca, "contract"),
      clients: { 8453: contractClient({ verify: (m) => m === text }) },
    });
    expect(result.isValid).toBe(true);
    expect(result.method).toBe("eip1271");
    expect(result.accountType).toBe("contract");
  });

  it("fails closed on an unknown implementation even when isValidSignature would agree", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const sca = "0x1111111111111111111111111111111111111111";
    const { message, text } = refundMessageFor(sca);
    const signature = await owner.signMessage({ message: text });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca, "contract"),
      clients: { 8453: contractClient({ implementation: UNKNOWN_IMPL, verify: () => true }) },
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe("unknown-implementation");
  });

  it("accepts an unknown implementation only under the explicit wallet-agnostic override", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const sca = "0x1111111111111111111111111111111111111111";
    const { message, text } = refundMessageFor(sca);
    const signature = await owner.signMessage({ message: text });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca, "contract"),
      clients: { 8453: contractClient({ implementation: UNKNOWN_IMPL, verify: (m) => m === text }) },
      requireKnownImplementation: false,
    });
    expect(result.isValid).toBe(true);
    expect(result.method).toBe("eip1271");
  });
});

describe("verifyRefundClaim — deployless Circle-SCA path", () => {
  function mockClients(args: { owner: Address; implementation?: Address; deployedOn?: number }) {
    return {
      [args.deployedOn ?? 8453]: contractClient({
        implementation: args.implementation,
        owner: args.owner,
      }),
      137: emptyClient,
    };
  }

  it("verifies an undeployed-on-verification-chain wallet via digest reconstruction", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const sca = getAddress("0x2222222222222222222222222222222222222222");
    const { message, text } = refundMessageFor(sca, 137);
    const digest = circleMscaReplaySafeDigest({ chainId: 137, wallet: sca, text });
    const signature = await owner.sign({ hash: digest });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca, "contract", 137),
      clients: mockClients({ owner: owner.address }),
    });
    expect(result.isValid).toBe(true);
    expect(result.method).toBe("deployless-circle-sca");
    expect(result.signerAddress).toBe(getAddress(owner.address));
  });

  it("rejects a signature bound to a different chain (chain-bound digests)", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const sca = getAddress("0x2222222222222222222222222222222222222222");
    const { message, text } = refundMessageFor(sca, 137);
    const wrongChainDigest = circleMscaReplaySafeDigest({ chainId: 8453, wallet: sca, text });
    const signature = await owner.sign({ hash: wrongChainDigest });

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca, "contract", 137),
      clients: mockClients({ owner: owner.address }),
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
      expected: expectedFor(sca, "contract", 137),
      clients: mockClients({ owner: owner.address, implementation: UNKNOWN_IMPL }),
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
      expected: expectedFor(sca, "contract", 137),
      clients: mockClients({ owner: owner.address }),
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

    const result = await verifyRefundClaim({
      message,
      signature,
      expected: expectedFor(sca, "contract", 137),
      clients: { 137: emptyClient, 8453: emptyClient },
    });
    expect(result.isValid).toBe(false);
    expect(result.reason).toBe("no-deployed-chain-found");
  });
});

describe("verifyPayerLinkage", () => {
  const OWNER = getAddress("0xEb53A7376Fae2c85FFAAAe5485f56ca11BD126a9");
  const SCA = getAddress("0x2222222222222222222222222222222222222222");

  it("links an SCA to its recorded owner via getNativeOwner", async () => {
    const result = await verifyPayerLinkage({
      account: SCA,
      expectedOwner: OWNER,
      clients: { 8453: contractClient({ owner: OWNER }) },
    });
    expect(result.linked).toBe(true);
    expect(result.owner).toBe(OWNER);
    expect(result.deployedChainId).toBe(8453);
  });

  it("rejects when the owner does not match the recorded address", async () => {
    const result = await verifyPayerLinkage({
      account: SCA,
      expectedOwner: getAddress("0x0000000000000000000000000000000000000001"),
      clients: { 8453: contractClient({ owner: OWNER }) },
    });
    expect(result.linked).toBe(false);
    expect(result.reason).toBe("owner-mismatch");
  });

  it("fails closed for an unknown implementation (a contract could return any owner)", async () => {
    const result = await verifyPayerLinkage({
      account: SCA,
      expectedOwner: OWNER,
      clients: { 8453: contractClient({ owner: OWNER, implementation: UNKNOWN_IMPL }) },
    });
    expect(result.linked).toBe(false);
    expect(result.reason).toBe("unknown-implementation");
  });

  it("fails closed for a never-deployed account", async () => {
    const result = await verifyPayerLinkage({
      account: SCA,
      expectedOwner: OWNER,
      clients: { 8453: emptyClient, 137: emptyClient },
    });
    expect(result.linked).toBe(false);
    expect(result.reason).toBe("no-deployed-chain-found");
  });
});
