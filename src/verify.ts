import type { SIWxMessage } from "@selat-ai/siwx-lib";
import {
  type Address,
  type Hex,
  getAddress,
  recoverMessageAddress,
} from "viem";
import { formatRefundMessage } from "./message";
import {
  validateRefundMessage,
  type ExpectedRefundContext,
} from "./validate";
import {
  KNOWN_CIRCLE_MSCA_IMPLEMENTATIONS,
  readImplementation,
  verifyDeploylessCircleSca,
} from "./circle";
import type { ClientMap, RefundVerification } from "./types";

export interface VerifyRefundClaimArgs {
  message: SIWxMessage;
  signature: Hex;
  expected: ExpectedRefundContext;
  /**
   * Read clients by eip155 chain id. The message's own chain is used for the
   * on-chain EIP-1271 attempt; the rest are probed by the deployless path.
   */
  clients?: ClientMap;
  /** Contract-implementation allowlist; defaults to KNOWN_CIRCLE_MSCA_IMPLEMENTATIONS. */
  knownImplementations?: ReadonlySet<Address>;
  /**
   * When true (the default), a contract-account success — on-chain EIP-1271
   * included — requires the wallet's ERC-1967 implementation to be in the
   * allowlist. This keeps an arbitrary contract that answers yes to
   * isValidSignature from authenticating; set false only for a deliberately
   * wallet-agnostic deployment that accepts any EIP-1271 implementation.
   */
  requireKnownImplementation?: boolean;
  probeOrder?: readonly number[];
}

/**
 * Full server-side verification pipeline:
 *
 *   1. field validation (domain, uri, statement, nonce, time window, quoteId
 *      binding, control characters) — siwx-lib checks none of this;
 *   2. signature path gated by the challenge-determined account type:
 *      "eoa"      → ecrecover of the EIP-191 text must equal message.address;
 *      "contract" → on-chain EIP-1271 (viem verifyMessage, ERC-6492-capable)
 *                   where the wallet has code, else the deployless
 *                   Circle-SCA reconstruction — with the implementation
 *                   allowlist enforced on both contract paths by default.
 *
 * Callers must ALSO enforce, outside this function: single-use nonce
 * consumption, rate limiting, quote lookup before any RPC work, and
 * per-quoteId idempotency.
 */
export async function verifyRefundClaim(
  args: VerifyRefundClaimArgs
): Promise<RefundVerification> {
  let accountAddress: Address;
  try {
    accountAddress = getAddress(args.message.address);
  } catch {
    return {
      isValid: false,
      accountAddress: args.message.address as Address,
      chainId: args.expected.chainId,
      reason: "validation-failed",
      validationFailures: [
        { code: "BAD_ADDRESS", detail: `unparseable address "${args.message.address}"` },
      ],
    };
  }

  const validation = validateRefundMessage(args.message, args.expected);
  const chainId = validation.chainId as number;

  if (!validation.valid) {
    return {
      isValid: false,
      accountAddress,
      chainId,
      reason: "validation-failed",
      validationFailures: validation.failures,
    };
  }

  const text = formatRefundMessage(args.message);
  const clients = args.clients ?? {};
  const allowlist = args.knownImplementations ?? KNOWN_CIRCLE_MSCA_IMPLEMENTATIONS;
  const requireKnownImplementation = args.requireKnownImplementation !== false;

  // EOA recovery runs regardless of account type: it is the EOA path's
  // check, and audit metadata for the contract paths. A non-65-byte
  // signature throws — swallow and continue (siwx-lib 0.1.2 instead aborts
  // here, which is why its EIP-1271 branch is unreachable for packed
  // signatures).
  let recovered: Address | undefined;
  try {
    recovered = getAddress(
      await recoverMessageAddress({ message: text, signature: args.signature })
    );
  } catch {
    recovered = undefined;
  }

  if (args.expected.accountType === "eoa") {
    if (recovered === accountAddress) {
      return {
        isValid: true,
        accountAddress,
        chainId,
        method: "eoa",
        accountType: "eoa",
        signedText: text,
      };
    }
    return {
      isValid: false,
      accountAddress,
      chainId,
      signerAddress: recovered,
      signedText: text,
      reason: "signature-invalid",
    };
  }

  // accountType === "contract": an EOA self-match would mean the account is
  // not the contract the challenge probe said it was — reject rather than
  // let an EOA key impersonate a smart-account payer.
  if (recovered === accountAddress) {
    return {
      isValid: false,
      accountAddress,
      chainId,
      signerAddress: recovered,
      signedText: text,
      reason: "account-type-mismatch",
    };
  }

  const chainClient = clients[chainId];

  // On-chain EIP-1271 on the verification chain, when the wallet has code there.
  if (chainClient) {
    let hasCode = false;
    try {
      const code = await chainClient.getCode({ address: accountAddress });
      hasCode = !!code && code !== "0x";
    } catch {
      hasCode = false;
    }
    if (hasCode && chainClient.verifyMessage) {
      let implementationOk = !requireKnownImplementation;
      let implementation: Address | undefined;
      if (requireKnownImplementation) {
        implementation = await readImplementation(chainClient, accountAddress);
        implementationOk = implementation !== undefined && allowlist.has(implementation);
      }
      if (!implementationOk) {
        return {
          isValid: false,
          accountAddress,
          chainId,
          signerAddress: recovered,
          signedText: text,
          reason: "unknown-implementation",
        };
      }
      try {
        const ok = await chainClient.verifyMessage({
          address: accountAddress,
          message: text,
          signature: args.signature,
        });
        if (ok) {
          return {
            isValid: true,
            accountAddress,
            chainId,
            method: "eip1271",
            accountType: "contract",
            signerAddress: recovered,
            signedText: text,
          };
        }
      } catch {
        // Fall through to the deployless path.
      }
    }
  }

  // Deployless Circle-SCA path (wallet not deployed on the verification chain).
  const deployless = await verifyDeploylessCircleSca({
    wallet: accountAddress,
    text,
    signature: args.signature,
    verificationChainId: chainId,
    clients,
    probeOrder: args.probeOrder,
    knownImplementations: allowlist,
  });

  if (deployless.isValid) {
    return {
      isValid: true,
      accountAddress,
      chainId,
      method: "deployless-circle-sca",
      accountType: "contract",
      signerAddress: deployless.recoveredOwner,
      signedText: text,
    };
  }

  return {
    isValid: false,
    accountAddress,
    chainId,
    signerAddress: deployless.recoveredOwner ?? recovered,
    signedText: text,
    reason:
      deployless.reason === "no-deployed-chain-found" && !args.clients
        ? "no-client-for-chain"
        : deployless.reason ?? "signature-invalid",
  };
}
