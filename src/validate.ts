import type { SIWxMessage } from "@selat-ai/siwx-lib";
import { getAddress } from "viem";
import {
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_MAX_ISSUED_AGE_MS,
  REFUND_STATEMENTS,
  type RefundOp,
  hasControlCharacters,
  isValidQuoteId,
  refundResource,
} from "./policy";
import {
  RefundValidationError,
  type RefundValidationFailure,
} from "./errors";
import { parseEip155ChainId } from "./message";
import type { RefundAccountType } from "./types";

export interface ExpectedRefundContext {
  /** SELAT's own domain, from configuration — NEVER derived from request headers. Compared exactly. */
  domain: string;
  quoteId: string;
  op: RefundOp;
  /** Verification chain the challenge was issued for. Required — no unverified chain choice. */
  chainId: number;
  /** The recorded payer account. Required — a claim with no named payer is invalid before any RPC. */
  account: string;
  /** Exact URI the message must carry. Required — no prefix matching. */
  uri: string;
  /**
   * Account type as determined by the challenge's deployed-code probe:
   * "contract" when the payer wallet has code somewhere, "eoa" when it does
   * not. Verification enforces the matching signature path, so an EOA
   * self-match can never stand in for a smart account, and vice versa.
   */
  accountType: RefundAccountType;
  now?: Date;
  maxIssuedAgeMs?: number;
  clockSkewMs?: number;
}

export interface RefundValidationResult {
  valid: boolean;
  failures: readonly RefundValidationFailure[];
  /** Numeric chain id, when the chainId parsed and passed policy. */
  chainId?: number;
}

/**
 * Field validation siwx-lib does not perform (its verifySignature checks the
 * signature and nothing else — an expired message verifies true). Every check
 * here must pass before a signature is even worth looking at.
 *
 * Namespace/allowlist violations THROW typed errors (they are policy
 * rejections, not claim defects); everything else is collected into failures.
 */
export function validateRefundMessage(
  message: SIWxMessage,
  expected: ExpectedRefundContext
): RefundValidationResult {
  const failures: RefundValidationFailure[] = [];
  const now = (expected.now ?? new Date()).getTime();
  const skew = expected.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const maxAge = expected.maxIssuedAgeMs ?? DEFAULT_MAX_ISSUED_AGE_MS;

  // Throws UnsupportedRefundNamespaceError / UnsupportedRefundChainError.
  const chainId = parseEip155ChainId(message.chainId);

  if (!isValidQuoteId(expected.quoteId)) {
    failures.push({ code: "BAD_QUOTE_ID", detail: expected.quoteId });
  }

  // CR/LF anywhere in the signed fields can forge extra lines in the prompt
  // the wallet displayed. Reject before comparing anything else.
  const textFields: Array<[string, string | undefined]> = [
    ["domain", message.domain],
    ["address", message.address],
    ["statement", message.statement],
    ["uri", message.uri],
    ["version", message.version],
    ["nonce", message.nonce],
    ["issuedAt", message.issuedAt],
    ["expirationTime", message.expirationTime],
    ["notBefore", message.notBefore],
    ["requestId", message.requestId],
    ...(message.resources ?? []).map((resource, index): [string, string] => [`resources[${index}]`, resource]),
  ];
  for (const [name, value] of textFields) {
    if (typeof value === "string" && hasControlCharacters(value)) {
      failures.push({ code: "CONTROL_CHARACTERS", detail: `field "${name}" contains CR/LF` });
    }
  }

  // Exact string comparison — no case folding. The challenge told the client
  // the exact domain to sign; anything else is a different string signed.
  if (message.domain !== expected.domain) {
    failures.push({
      code: "DOMAIN_MISMATCH",
      detail: `message "${message.domain}" != expected "${expected.domain}"`,
    });
  }

  if (message.uri !== expected.uri) {
    failures.push({
      code: "URI_MISMATCH",
      detail: `message "${message.uri}" != expected "${expected.uri}"`,
    });
  }

  // The statement is pinned per operation and part of the signed semantics.
  if (message.statement !== REFUND_STATEMENTS[expected.op]) {
    failures.push({
      code: "STATEMENT_MISMATCH",
      detail: `message statement ${JSON.stringify(message.statement ?? null)} != required ${JSON.stringify(REFUND_STATEMENTS[expected.op])}`,
    });
  }

  let match = false;
  try {
    match = getAddress(message.address) === getAddress(expected.account);
  } catch {
    match = false;
  }
  if (!match) {
    failures.push({
      code: "ADDRESS_MISMATCH",
      detail: `message address ${message.address} != expected payer ${expected.account}`,
    });
  }

  if (chainId !== expected.chainId) {
    failures.push({
      code: "CHAIN_MISMATCH",
      detail: `message chain eip155:${chainId} != challenge chain eip155:${expected.chainId}`,
    });
  }

  if (message.version !== "1") {
    failures.push({ code: "BAD_VERSION", detail: message.version });
  }

  if (!message.nonce) {
    failures.push({ code: "MISSING_NONCE", detail: "nonce absent" });
  } else if (message.nonce.length < 8) {
    failures.push({ code: "NONCE_TOO_SHORT", detail: message.nonce });
  }

  const issuedAt = Date.parse(message.issuedAt);
  if (Number.isFinite(issuedAt)) {
    if (issuedAt > now + skew) {
      failures.push({ code: "ISSUED_IN_FUTURE", detail: message.issuedAt });
    }
    if (now - issuedAt > maxAge) {
      failures.push({
        code: "ISSUED_TOO_OLD",
        detail: `issuedAt ${message.issuedAt} older than ${maxAge}ms`,
      });
    }
  } else {
    failures.push({ code: "ISSUED_IN_FUTURE", detail: `unparseable issuedAt "${message.issuedAt}"` });
  }

  if (!message.expirationTime) {
    failures.push({ code: "MISSING_EXPIRATION", detail: "expirationTime absent" });
  } else {
    const exp = Date.parse(message.expirationTime);
    if (!Number.isFinite(exp) || exp <= now) {
      failures.push({ code: "EXPIRED", detail: message.expirationTime });
    } else if (Number.isFinite(issuedAt) && exp - issuedAt > maxAge + skew) {
      // A client-supplied expiry far past the challenge window would keep the
      // signature attackable long after the challenge died.
      failures.push({
        code: "EXPIRY_TOO_FAR",
        detail: `expirationTime ${message.expirationTime} exceeds issuedAt + ${maxAge}ms window`,
      });
    }
  }

  if (message.notBefore) {
    const nbf = Date.parse(message.notBefore);
    if (Number.isFinite(nbf) && nbf > now + skew) {
      failures.push({ code: "NOT_YET_VALID", detail: message.notBefore });
    }
  }

  if (message.requestId !== expected.quoteId) {
    failures.push({
      code: "REQUEST_ID_MISMATCH",
      detail: `requestId "${message.requestId ?? ""}" != quoteId "${expected.quoteId}"`,
    });
  }

  // Exactly the one refund resource — a message carrying extra resources is
  // asserting semantics this flow never issued.
  const wantedResource = refundResource(expected.op, expected.quoteId);
  const resources = message.resources ?? [];
  if (resources.length !== 1 || resources[0] !== wantedResource) {
    failures.push({
      code: "RESOURCE_MISMATCH",
      detail: `resources ${JSON.stringify(resources)} must equal ["${wantedResource}"]`,
    });
  }

  return { valid: failures.length === 0, failures, chainId };
}

/** Throwing variant, carrying every failed check. */
export function assertValidRefundMessage(
  message: SIWxMessage,
  expected: ExpectedRefundContext
): number {
  const result = validateRefundMessage(message, expected);
  if (!result.valid) {
    throw new RefundValidationError(result.failures, expected.op, expected.quoteId);
  }
  return result.chainId as number;
}
