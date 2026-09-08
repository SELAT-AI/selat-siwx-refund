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
  /** Passed through to the deployless verifier; fail closed by default. */
  knownImplementations?: ReadonlySet<Address>;
  probeOrder?: readonly number[];
}

/**
 * Full server-side verification pipeline (scoping doc §C3/§C5 order):
 *
 *   1. field validation (domain, uri, nonce, time window, quoteId binding) —
 *      siwx-lib checks none of this;
 *   2. EOA fast path: ecrecover of the EIP-191 text equals message.address;
 *   3. on-chain EIP-1271 (via viem verifyMessage, which also handles
 *      ERC-6492) when the message's chain has a client and the wallet has
 *      code there;
 *   4. deployless Circle-SCA path when it does not.
 *
 * Callers must ALSO enforce, outside this function: single-use nonce
 * consumption, message.address == recorded payer (pass expected.account),
 * and per-quoteId idempotency.
 */
export async function verifyRefundClaim(
  args: VerifyRefundClaimArgs
): Promise<RefundVerification> {
  const validation = validateRefundMessage(args.message, args.expected);
  const accountAddress = getAddress(args.message.address);
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

  // 2. EOA fast path. A non-65-byte signature makes recoverMessageAddress
  // throw — swallow and continue to the contract paths (siwx-lib 0.1.2
  // instead aborts here, which is why its EIP-1271 branch is unreachable for
  // packed signatures).
  let recovered: Address | undefined;
  try {
    recovered = getAddress(
      await recoverMessageAddress({ message: text, signature: args.signature })
    );
  } catch {
    recovered = undefined;
  }
  if (recovered === accountAddress) {
    return {
      isValid: true,
      accountAddress,
      chainId,
      method: "eoa",
      accountType: "eoa",
    };
  }

  const clients = args.clients ?? {};
  const chainClient = clients[chainId];

  // 3. On-chain EIP-1271 on the verification chain, when the wallet has code there.
  if (chainClient) {
    let hasCode = false;
    try {
      const code = await chainClient.getCode({ address: accountAddress });
      hasCode = !!code && code !== "0x";
    } catch {
      hasCode = false;
    }
    if (hasCode && chainClient.verifyMessage) {
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
          };
        }
      } catch {
        // Fall through to the deployless path.
      }
    }
  }

  // 4. Deployless Circle-SCA path (wallet not deployed on the verification chain).
  const deployless = await verifyDeploylessCircleSca({
    wallet: accountAddress,
    text,
    signature: args.signature,
    verificationChainId: chainId,
    clients,
    probeOrder: args.probeOrder,
    knownImplementations: args.knownImplementations,
  });

  if (deployless.isValid) {
    return {
      isValid: true,
      accountAddress,
      chainId,
      method: "deployless-circle-sca",
      accountType: "contract",
      signerAddress: deployless.recoveredOwner,
    };
  }

  return {
    isValid: false,
    accountAddress,
    chainId,
    signerAddress: deployless.recoveredOwner ?? recovered,
    reason:
      deployless.reason === "no-deployed-chain-found" && !args.clients
        ? "no-client-for-chain"
        : deployless.reason ?? "signature-invalid",
  };
}
