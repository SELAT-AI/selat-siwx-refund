import {
  type Address,
  type Hex,
  getAddress,
  hashMessage,
  hashTypedData,
  recoverAddress,
} from "viem";
import { VERIFICATION_PROBE_ORDER } from "./policy";
import type { ClientMap, EvmReadClient } from "./types";

/** ERC-1967 implementation slot. */
export const ERC1967_IMPLEMENTATION_SLOT: Hex =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/**
 * Circle SingleOwnerMSCA EIP-712 replay-safe envelope constants
 * (buidl-wallet-contracts: NAME = "Circle_SingleOwnerMSCA", VERSION = "1.0.0";
 * confirmed on-chain 2026-09-04 by reproducing getReplaySafeMessageHash on
 * Base and Optimism off-chain).
 */
export const CIRCLE_MSCA_712_NAME = "Circle_SingleOwnerMSCA";
export const CIRCLE_MSCA_712_VERSION = "1.0.0";

const CIRCLE_MSCA_712_TYPES = {
  CircleSingleOwnerMSCAMessage: [{ name: "hash", type: "bytes32" }],
} as const;

/**
 * Known SingleOwnerMSCA implementation addresses the deployless path trusts.
 *
 * Populated 2026-09-08 by reading the ERC-1967 slot of two deployed Circle
 * Agent Wallets on Base (scripts/probe-implementation.mjs) — both identical
 * 209-byte ERC-1967 proxies pointing at Circle's SingleOwnerMSCA. The digest
 * reconstruction is implementation-specific (a SingleOwnerPlugin variant adds
 * the plugin address to the domain; a Circle v2 account may change layout),
 * so an unknown implementation MUST fail closed rather than risk a
 * wrong-digest comparison. Extend only via the probe script.
 */
export const KNOWN_CIRCLE_MSCA_IMPLEMENTATIONS: ReadonlySet<Address> = new Set<Address>([
  // Circle_SingleOwnerMSCA v1.0.0 (Base mainnet, probed 2026-09-08)
  "0xD206aC7fEf53d83ED4563E770b28Dba90D0D9eC8",
]);

const GET_NATIVE_OWNER_ABI = [
  {
    type: "function",
    name: "getNativeOwner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/**
 * The replay-safe digest SingleOwnerMSCA.isValidSignature actually checks:
 * a chain- and wallet-bound EIP-712 wrap of the EIP-191 message hash. Pure
 * function of (chainId, wallet, text) — needs no code on chain, which is the
 * whole point (scoping doc §F3).
 */
export function circleMscaReplaySafeDigest(args: {
  chainId: number;
  wallet: Address;
  text: string;
}): Hex {
  return hashTypedData({
    domain: {
      name: CIRCLE_MSCA_712_NAME,
      version: CIRCLE_MSCA_712_VERSION,
      chainId: args.chainId,
      verifyingContract: args.wallet,
    },
    types: CIRCLE_MSCA_712_TYPES,
    primaryType: "CircleSingleOwnerMSCAMessage",
    message: { hash: hashMessage(args.text) },
  });
}

export interface DeployedChainInfo {
  chainId: number;
  client: EvmReadClient;
  implementation: Address;
}

function storageToAddress(word: Hex | null | undefined): Address | undefined {
  if (!word || word === "0x") return undefined;
  const hex = word.replace(/^0x/, "").padStart(64, "0");
  const addr = `0x${hex.slice(24)}`;
  if (addr === "0x0000000000000000000000000000000000000000") return undefined;
  try {
    return getAddress(addr);
  } catch {
    return undefined;
  }
}

/**
 * Find a chain where the wallet has code, returning its client and the
 * ERC-1967 implementation address. Used both by the challenge endpoint
 * (resolve the verification context, §C1) and by the deployless verifier
 * (locate a chain to read getNativeOwner from).
 */
export async function findDeployedChain(args: {
  wallet: Address;
  clients: ClientMap;
  probeOrder?: readonly number[];
}): Promise<DeployedChainInfo | undefined> {
  const order = args.probeOrder ?? VERIFICATION_PROBE_ORDER;
  for (const chainId of order) {
    const client = args.clients[chainId];
    if (!client) continue;
    let code: Hex | undefined;
    try {
      code = await client.getCode({ address: args.wallet });
    } catch {
      continue; // RPC failure on one chain must not abort the probe.
    }
    if (!code || code === "0x") continue;
    const slot = await client
      .getStorageAt({ address: args.wallet, slot: ERC1967_IMPLEMENTATION_SLOT })
      .catch(() => undefined);
    const implementation = storageToAddress(slot);
    if (implementation) {
      return { chainId, client, implementation };
    }
  }
  return undefined;
}

export interface DeploylessVerifyArgs {
  wallet: Address;
  /** The formatted SIWx text that was signed. */
  text: string;
  signature: Hex;
  /** Chain the challenge bound the signature to (Circle signs chain-bound). */
  verificationChainId: number;
  /** Clients for chains to probe for deployed code (owner lookup). */
  clients: ClientMap;
  probeOrder?: readonly number[];
  /** Implementation allowlist; defaults to KNOWN_CIRCLE_MSCA_IMPLEMENTATIONS. Fail closed. */
  knownImplementations?: ReadonlySet<Address>;
}

export interface DeploylessVerifyResult {
  isValid: boolean;
  /** Owner EOA recovered from the replay-safe digest (audit metadata). */
  recoveredOwner?: Address;
  /** Owner read from getNativeOwner() on the deployed chain. */
  nativeOwner?: Address;
  deployedChainId?: number;
  implementation?: Address;
  reason?: "no-deployed-chain-found" | "unknown-implementation" | "owner-mismatch" | "rpc-error";
}

/**
 * Deployless verification for Circle SingleOwnerMSCA wallets (scoping doc
 * §F3): reconstruct the chain-bound replay-safe digest for the verification
 * chain (where the wallet may have NO code), recover the owner EOA, and
 * compare against getNativeOwner() read from any chain where the wallet IS
 * deployed (owner is identical across chains — it is mixed into the CREATE2
 * salt). Fails closed when no deployed chain is reachable or the deployed
 * implementation is not in the allowlist.
 */
export async function verifyDeploylessCircleSca(
  args: DeploylessVerifyArgs
): Promise<DeploylessVerifyResult> {
  const wallet = getAddress(args.wallet);
  const digest = circleMscaReplaySafeDigest({
    chainId: args.verificationChainId,
    wallet,
    text: args.text,
  });

  let recoveredOwner: Address;
  try {
    recoveredOwner = getAddress(
      await recoverAddress({ hash: digest, signature: args.signature })
    );
  } catch {
    return { isValid: false, reason: "owner-mismatch" };
  }

  const deployed = await findDeployedChain({
    wallet,
    clients: args.clients,
    probeOrder: args.probeOrder,
  });
  if (!deployed) {
    return { isValid: false, recoveredOwner, reason: "no-deployed-chain-found" };
  }

  const allowlist = args.knownImplementations ?? KNOWN_CIRCLE_MSCA_IMPLEMENTATIONS;
  if (!allowlist.has(deployed.implementation)) {
    return {
      isValid: false,
      recoveredOwner,
      deployedChainId: deployed.chainId,
      implementation: deployed.implementation,
      reason: "unknown-implementation",
    };
  }

  let nativeOwner: Address;
  try {
    nativeOwner = getAddress(
      (await deployed.client.readContract({
        address: wallet,
        abi: GET_NATIVE_OWNER_ABI,
        functionName: "getNativeOwner",
      })) as string
    );
  } catch {
    return {
      isValid: false,
      recoveredOwner,
      deployedChainId: deployed.chainId,
      implementation: deployed.implementation,
      reason: "rpc-error",
    };
  }

  const isValid = nativeOwner === recoveredOwner;
  return {
    isValid,
    recoveredOwner,
    nativeOwner,
    deployedChainId: deployed.chainId,
    implementation: deployed.implementation,
    reason: isValid ? undefined : "owner-mismatch",
  };
}
