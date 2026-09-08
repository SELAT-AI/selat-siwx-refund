import type { RefundOp } from "./policy";

/** A refund message referenced a non-eip155 namespace. Never a bad signature — a policy rejection. */
export class UnsupportedRefundNamespaceError extends Error {
  readonly code = "UNSUPPORTED_REFUND_NAMESPACE";
  constructor(readonly namespace: string) {
    super(
      `Refund claims accept eip155 chains only; got namespace "${namespace}". ` +
        "This is SELAT deployment policy, not a signature failure."
    );
    this.name = "UnsupportedRefundNamespaceError";
  }
}

/** A refund message referenced an eip155 chain outside SELAT's inbound-payment set, or a non-canonical chain reference. */
export class UnsupportedRefundChainError extends Error {
  readonly code = "UNSUPPORTED_REFUND_CHAIN";
  constructor(readonly chainRef: number | string) {
    super(
      `Chain eip155:${chainRef} is not an allowlisted, canonically-formatted SELAT refund chain. ` +
        "This is SELAT deployment policy, not a signature failure."
    );
    this.name = "UnsupportedRefundChainError";
  }
}

export type RefundValidationCode =
  | "BAD_QUOTE_ID"
  | "BAD_ADDRESS"
  | "DOMAIN_MISMATCH"
  | "URI_MISMATCH"
  | "ADDRESS_MISMATCH"
  | "CHAIN_MISMATCH"
  | "BAD_VERSION"
  | "MISSING_NONCE"
  | "NONCE_TOO_SHORT"
  | "ISSUED_IN_FUTURE"
  | "ISSUED_TOO_OLD"
  | "MISSING_EXPIRATION"
  | "EXPIRED"
  | "EXPIRY_TOO_FAR"
  | "NOT_YET_VALID"
  | "REQUEST_ID_MISMATCH"
  | "RESOURCE_MISMATCH"
  | "STATEMENT_MISMATCH"
  | "CONTROL_CHARACTERS";

export interface RefundValidationFailure {
  code: RefundValidationCode;
  detail: string;
}

/** Thrown by assertValidRefundMessage; carries every failed check, not just the first. */
export class RefundValidationError extends Error {
  readonly code = "REFUND_VALIDATION_FAILED";
  constructor(
    readonly failures: readonly RefundValidationFailure[],
    readonly op: RefundOp,
    readonly quoteId: string
  ) {
    super(
      `Refund ${op} message for ${quoteId} failed validation: ` +
        failures.map((f) => f.code).join(", ")
    );
    this.name = "RefundValidationError";
  }
}
