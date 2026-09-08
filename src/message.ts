import { SIWx, type SIWxMessage } from "@selat-ai/siwx-lib";
import { getAddress } from "viem";
import {
  DEFAULT_REFUND_DOMAIN,
  REFUND_STATEMENTS,
  type RefundOp,
  defaultRefundUri,
  isAllowedRefundChain,
  isValidQuoteId,
  refundResource,
} from "./policy";
import {
  UnsupportedRefundChainError,
  UnsupportedRefundNamespaceError,
} from "./errors";

export interface CreateRefundMessageOptions {
  /** The paying account — a Circle Agent Wallet SCA in the primary path. */
  account: string;
  /**
   * Verification chain, numeric eip155 id. Comes from the server challenge:
   * a chain where the SCA has code (or the deployless context). NOT the
   * funding, Gateway-balance, or purchase-settlement chain by default.
   */
  chainId: number;
  /** Disputed transaction id (`selatx…`). The primary object of the authorization. */
  quoteId: string;
  op: RefundOp;
  /** Server-issued single-use nonce from the refund challenge. */
  nonce: string;
  /** ISO-8601. Keep short (minutes); required. */
  expirationTime: string;
  domain?: string;
  uri?: string;
  issuedAt?: string;
  notBefore?: string;
  statement?: string;
}

export interface RefundMessage {
  message: SIWxMessage;
  /** EIP-191 text to hand to the wallet (e.g. `circle wallet sign message <text>`). */
  text: string;
}

/** Parse `eip155:<n>` strictly; typed errors for anything else. */
export function parseEip155ChainId(chainId: string): number {
  const [namespace, reference] = chainId.split(":");
  if (namespace !== "eip155") {
    throw new UnsupportedRefundNamespaceError(namespace ?? "");
  }
  const numeric = Number(reference);
  if (!Number.isInteger(numeric) || !isAllowedRefundChain(numeric)) {
    throw new UnsupportedRefundChainError(numeric);
  }
  return numeric;
}

/**
 * Build the refund SIWx message with the claim bound into the signed
 * payload: requestId = quoteId, resource = selat:refund:<op>:<quoteId>
 * (scoping doc §A2). Throws typed errors for policy violations.
 */
export function createRefundMessage(options: CreateRefundMessageOptions): RefundMessage {
  if (!isValidQuoteId(options.quoteId)) {
    throw new Error(`Invalid quoteId "${options.quoteId}" (expected selatx…)`);
  }
  if (!isAllowedRefundChain(options.chainId)) {
    throw new UnsupportedRefundChainError(options.chainId);
  }
  if (!options.nonce || options.nonce.length < 8) {
    throw new Error("A server-issued nonce of at least 8 characters is required");
  }
  if (!options.expirationTime) {
    throw new Error("expirationTime is required for refund messages");
  }

  const domain = options.domain ?? DEFAULT_REFUND_DOMAIN;
  const account = getAddress(options.account);

  const message = SIWx.createMessage({
    domain,
    address: account,
    chainId: `eip155:${options.chainId}`,
    uri: options.uri ?? defaultRefundUri(domain, options.op),
    statement: options.statement ?? REFUND_STATEMENTS[options.op],
    nonce: options.nonce,
    issuedAt: options.issuedAt,
    expirationTime: options.expirationTime,
    notBefore: options.notBefore,
    requestId: options.quoteId,
    resources: [refundResource(options.op, options.quoteId)],
  });

  return { message, text: SIWx.formatMessage(message) };
}

/** Format an existing message through the same adapter the verifier uses. */
export function formatRefundMessage(message: SIWxMessage): string {
  parseEip155ChainId(message.chainId);
  return SIWx.formatMessage(message);
}
