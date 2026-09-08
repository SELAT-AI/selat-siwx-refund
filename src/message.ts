import { SIWx, type SIWxMessage } from "@selat-ai/siwx-lib";
import { getAddress } from "viem";
import {
  DEFAULT_REFUND_DOMAIN,
  REFUND_STATEMENTS,
  type RefundOp,
  defaultRefundUri,
  hasControlCharacters,
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
}

export interface RefundMessage {
  message: SIWxMessage;
  /** EIP-191 text to hand to the wallet (e.g. `circle wallet sign message <text>`). */
  text: string;
}

const CANONICAL_EIP155 = /^eip155:([1-9][0-9]*)$/;

/**
 * Parse `eip155:<n>` strictly and canonically; typed errors for anything else.
 * Only base-10 digits with no leading zeros are accepted — "eip155:8453.0",
 * "eip155: 8453", "eip155:0x2105", and extra segments all fail, so a message
 * can never validate under a chain reference the verifier reads differently.
 */
export function parseEip155ChainId(chainId: string): number {
  const namespace = chainId.split(":")[0];
  if (namespace !== "eip155") {
    throw new UnsupportedRefundNamespaceError(namespace ?? "");
  }
  const match = CANONICAL_EIP155.exec(chainId);
  if (!match) {
    throw new UnsupportedRefundChainError(chainId.slice("eip155:".length));
  }
  const numeric = Number(match[1]);
  if (!Number.isSafeInteger(numeric) || !isAllowedRefundChain(numeric)) {
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
  const uri = options.uri ?? defaultRefundUri(domain, options.op);

  // Everything below lands verbatim in the signed prompt; CR/LF in any field
  // could forge extra SIWx lines in what the wallet displays and signs.
  // The statement is not an input at all — it is pinned per operation.
  for (const [name, value] of Object.entries({
    domain,
    uri,
    nonce: options.nonce,
    issuedAt: options.issuedAt ?? "",
    expirationTime: options.expirationTime,
    notBefore: options.notBefore ?? "",
  })) {
    if (hasControlCharacters(value)) {
      throw new Error(`Refund message field "${name}" must not contain CR/LF`);
    }
  }

  const message = SIWx.createMessage({
    domain,
    address: account,
    chainId: `eip155:${options.chainId}`,
    uri,
    statement: REFUND_STATEMENTS[options.op],
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
