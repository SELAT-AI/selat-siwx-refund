import type { SIWxMessage } from "@selat-ai/siwx-lib";
import { getAddress } from "viem";
import {
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_MAX_ISSUED_AGE_MS,
  type RefundOp,
  isValidQuoteId,
  refundResource,
} from "./policy";
import {
  RefundValidationError,
  type RefundValidationFailure,
} from "./errors";
import { parseEip155ChainId } from "./message";

export interface ExpectedRefundContext {
  /** SELAT's own domain, from configuration — NEVER derived from request headers (scoping doc §C4). */
  domain: string;
  quoteId: string;
  op: RefundOp;
  /** Verification chain the challenge was issued for. */
  chainId?: number;
  /** The recorded payer account; when given, the message address must match. */
  account?: string;
  /** Exact URI check; defaults to prefix check against https://<domain>/. */
  uri?: string;
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

  if (message.domain.toLowerCase() !== expected.domain.toLowerCase()) {
    failures.push({
      code: "DOMAIN_MISMATCH",
      detail: `message "${message.domain}" != expected "${expected.domain}"`,
    });
  }

  if (expected.uri) {
    if (message.uri !== expected.uri) {
      failures.push({
        code: "URI_MISMATCH",
        detail: `message "${message.uri}" != expected "${expected.uri}"`,
      });
    }
  } else if (!message.uri.toLowerCase().startsWith(`https://${expected.domain.toLowerCase()}/`)) {
    failures.push({
      code: "URI_MISMATCH",
      detail: `message uri "${message.uri}" is not under https://${expected.domain}/`,
    });
  }

  if (expected.account) {
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
  }

  if (expected.chainId !== undefined && chainId !== expected.chainId) {
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

  const wantedResource = refundResource(expected.op, expected.quoteId);
  if (!message.resources || !message.resources.includes(wantedResource)) {
    failures.push({
      code: "RESOURCE_MISMATCH",
      detail: `resources ${JSON.stringify(message.resources ?? [])} missing "${wantedResource}"`,
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
