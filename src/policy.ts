/**
 * SELAT deployment policy.
 *
 * This is intentionally the ONLY place SELAT-specific policy lives.
 * @selat-ai/siwx-lib stays a generic multi-chain SIWx library; everything
 * here is "what SELAT accepts for refund claims", not "what SIWx supports".
 */

/** Chains SELAT accepts inbound payments on (Circle Gateway ∩ Circle Agent Wallet, mainnet). */
export const SELAT_REFUND_CHAIN_IDS: readonly number[] = [
  1, // Ethereum
  10, // OP Mainnet
  130, // Unichain
  137, // Polygon PoS
  5042, // Arc (mainnet RPC must be configured explicitly; re-verify after 2026-09-16 launch)
  8453, // Base
  42161, // Arbitrum One
  43114, // Avalanche C-Chain
];

const SELAT_REFUND_CHAIN_ID_SET = new Set<number>(SELAT_REFUND_CHAIN_IDS);

export function isAllowedRefundChain(chainId: number): boolean {
  return SELAT_REFUND_CHAIN_ID_SET.has(chainId);
}

/**
 * Order in which chains are probed for deployed SCA bytecode when resolving a
 * verification context. Base first: in the primary payer path (fund Gateway
 * from Base) it is the chain where a Circle Agent Wallet is most likely
 * deployed. See the scoping doc, §C1.
 */
export const VERIFICATION_PROBE_ORDER: readonly number[] = [
  8453, 1, 42161, 10, 137, 43114, 130, 5042,
];

/**
 * eip155 chain id → Circle CLI blockchain code, for `circle wallet sign
 * message --chain <code>`. The signature Circle produces is chain-bound
 * (replay-safe EIP-712 digest includes chainId), so the code passed here MUST
 * correspond to the verification chain issued in the refund challenge.
 *
 * All seven codes verified against `circle blockchain list` on 2026-09-08.
 * Arc mainnet (eip155:5042) is intentionally ABSENT: the Circle CLI exposes
 * only ARC-TESTNET (5042002) today, so there is no valid mainnet code to emit
 * — circleChainCode(5042) returns undefined and callers must treat that as
 * "cannot sign via Circle for this chain yet". Re-check after the Arc mainnet
 * launch (2026-09-16) and add the code Circle publishes (expected "ARC").
 */
export const CIRCLE_CHAIN_CODES: Record<number, string> = {
  1: "ETH",
  10: "OP",
  130: "UNI",
  137: "MATIC",
  8453: "BASE",
  42161: "ARB",
  43114: "AVAX",
};

export function circleChainCode(chainId: number): string | undefined {
  return CIRCLE_CHAIN_CODES[chainId];
}

/** Default SIWx domain for SELAT refund messages. */
export const DEFAULT_REFUND_DOMAIN = "router.selat.ai";

/** Refund operations distinguishable in the signed message. */
export type RefundOp = "claim" | "status";

export const REFUND_STATEMENTS: Record<RefundOp, string> = {
  claim: "Request a SELAT refund",
  status: "Check SELAT refund status",
};

export function refundResource(op: RefundOp, quoteId: string): string {
  return `selat:refund:${op}:${quoteId}`;
}

export function defaultRefundUri(domain: string, op: RefundOp): string {
  return `https://${domain}/wrench/refund/${op}`;
}

/** SELAT quote ids look like `selatx<uuid-ish>`. */
const QUOTE_ID_PATTERN = /^selatx[0-9a-zA-Z-]{8,128}$/;

export function isValidQuoteId(quoteId: string): boolean {
  return QUOTE_ID_PATTERN.test(quoteId);
}

/** How long after issuedAt a refund message is accepted (replay window). */
export const DEFAULT_MAX_ISSUED_AGE_MS = 5 * 60 * 1000;

/** Allowed clock skew when checking issuedAt / notBefore against "now". */
export const DEFAULT_CLOCK_SKEW_MS = 30 * 1000;
