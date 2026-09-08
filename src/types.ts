import type { Hex, Address } from "viem";

/**
 * Minimal structural interface for an EVM read client. viem's PublicClient
 * satisfies it; tests inject plain objects. Keeping this structural means the
 * wrapper never constructs transports itself — callers own RPC configuration.
 */
export interface EvmReadClient {
  getCode(args: { address: Address }): Promise<Hex | undefined>;
  getStorageAt(args: { address: Address; slot: Hex }): Promise<Hex | undefined | null>;
  readContract(args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  /** viem PublicClient.verifyMessage — handles EIP-1271 and ERC-6492. Optional for mocks. */
  verifyMessage?(args: {
    address: Address;
    message: string;
    signature: Hex;
  }): Promise<boolean>;
}

/** eip155 chain id (numeric) → read client. */
export type ClientMap = Partial<Record<number, EvmReadClient>>;

export type RefundVerifyMethod = "eoa" | "eip1271" | "deployless-circle-sca";

export type RefundAccountType = "eoa" | "contract";

/**
 * Structured verification result (scoping doc §A5). `accountAddress` — the
 * SIWx message address — is the authenticated identity on success.
 * `signerAddress` is audit metadata only (owner key recovered along the way);
 * it must never be compared against the recorded payer.
 */
export interface RefundVerification {
  isValid: boolean;
  accountAddress: Address;
  chainId: number;
  method?: RefundVerifyMethod;
  accountType?: RefundAccountType;
  signerAddress?: Address;
  /**
   * The exact formatted text the signature was checked against. Store this
   * alongside the claim so the verified bytes survive any future change to
   * the underlying formatter.
   */
  signedText?: string;
  /** Machine-readable reason on failure. */
  reason?:
    | "validation-failed"
    | "signature-invalid"
    | "account-type-mismatch"
    | "no-client-for-chain"
    | "no-deployed-chain-found"
    | "unknown-implementation"
    | "owner-mismatch"
    | "rpc-error";
  /** Populated when reason === "validation-failed". */
  validationFailures?: readonly { code: string; detail: string }[];
}
