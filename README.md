# @selat-ai/siwx-refund

SELAT's refund-claim policy wrapper over [`@selat-ai/siwx-lib`](https://github.com/SELAT-AI/selat-siwx-lib).

`siwx-lib` stays a generic, chain-agnostic SIWx library (EVM, Solana, Bitcoin). Everything SELAT-specific about refund authentication lives here instead: which chains and namespaces SELAT accepts, how a claim is bound into the signed message, which fields must validate before a signature is worth checking, and how a Circle Agent Wallet (smart-contract account) is verified — including when it has no code on the verification chain.

Consumers: `selat-pay` (client side — build and sign the claim) and the SELAT refund server (server side — validate and verify).

## Why a wrapper

- **Namespace gate.** Refund claims accept `eip155:*` only. Solana/Bitcoin messages get a typed `UnsupportedRefundNamespaceError` — a policy rejection, never a silent `false`. The state of the other adapters in `siwx-lib` cannot affect this flow.
- **Field validation.** `siwx-lib`'s `verifySignature` checks the signature and nothing else — an expired message verifies `true`. `validateRefundMessage` checks domain, URI, chain, address, version, nonce shape, issuedAt window, expiry, notBefore, `requestId`, and the `selat:refund:<op>:<quoteId>` resource before any cryptography runs.
- **Claim binding.** `createRefundMessage` puts the disputed `quoteId` inside the signed payload (`requestId` + resource), with distinct resources for `claim` vs `status`, so a captured login signature cannot be replayed as a refund authorization.
- **Circle SCA verification, including deployless.** Circle Agent Wallets deploy per chain only on first outbound use, and their `SingleOwnerMSCA` signatures are chain-bound. When the wallet has no code on the verification chain, `verifyRefundClaim` reconstructs the replay-safe EIP-712 digest off-chain, recovers the owner, and compares it to `getNativeOwner()` read from a chain where the wallet is deployed — failing closed on unknown implementations.

## Usage

Client (selat-pay), after fetching the server challenge:

```ts
import { createRefundMessage, circleChainCode } from "@selat-ai/siwx-refund";

const { message, text } = createRefundMessage({
  account: challenge.account,        // the paying SCA
  chainId: challenge.chainId,        // verification chain from the challenge
  quoteId,                           // selatx…
  op: "claim",
  nonce: challenge.nonce,            // server-issued, single-use
  expirationTime: challenge.expiresAt,
});

// Sign `text` with the wallet. For Circle, the chain code MUST match the
// challenge chain — Circle signatures are chain-bound:
//   circle wallet sign message <text> --address <account> --chain ${circleChainCode(challenge.chainId)}
```

Server:

```ts
import { verifyRefundClaim } from "@selat-ai/siwx-refund";

const result = await verifyRefundClaim({
  message,
  signature,
  expected: {
    domain: process.env.REFUND_PUBLIC_DOMAIN!, // configured — never from request headers
    quoteId,
    op: "claim",
    chainId: challenge.chainId,                // required
    account: transaction.clientAddress,        // required — the recorded payer
    uri: challenge.uri,                        // required — exact match, no prefixes
    accountType: challenge.accountType,        // required — "contract" | "eoa", from the challenge's code probe
  },
  clients,                                     // viem PublicClients by chain id
});

if (result.isValid) {
  // result.accountAddress (== message.address) is the authenticated identity.
  // result.signerAddress is audit metadata only — never compare it to the payer.
}
```

The pipeline: field validation (domain/URI/statement compared exactly, CR/LF rejected everywhere, expiry capped to the issuedAt window, resources must equal exactly the one refund resource) → then the signature path **gated by `accountType`**: `"eoa"` accepts only an ecrecover self-match; `"contract"` accepts only on-chain EIP-1271 (viem `verifyMessage`, ERC-6492-capable) or the deployless Circle-SCA reconstruction — so an EOA key can never stand in for a smart-account payer, or vice versa. Non-65-byte signatures do not abort the pipeline.

Both contract paths enforce the implementation allowlist by default (`requireKnownImplementation: false` is the explicit wallet-agnostic override): an arbitrary contract that answers yes to `isValidSignature` does not authenticate. The statement is pinned per operation and not overridable — `createRefundMessage` has no statement input.

`verifyPayerLinkage({account, expectedOwner, clients})` is the bridge for rows captured before the router recorded the paying account: it proves `getNativeOwner(account) == expectedOwner` on a chain where the account is deployed, failing closed on undeployed accounts and unknown implementations. Use it in the challenge endpoint (validate an asserted payer account against the recorded address) and at claim time for legacy rows.

Callers still own, outside this library: single-use nonce consumption, rate limiting, quote lookup ordering (resolve the quote and check the payer address **before** any RPC-bearing verification), and per-`quoteId` idempotency.

## Before production

1. `KNOWN_CIRCLE_MSCA_IMPLEMENTATIONS` currently trusts Circle's `SingleOwnerMSCA` v1.0.0 implementation (`0xD206aC7fEf53d83ED4563E770b28Dba90D0D9eC8`, probed on Base 2026-09-08). If Circle ships a new account version, probe a wallet using it (`node scripts/probe-implementation.mjs <deployed-wallet> <rpcUrl>`) and extend the set — unknown implementations fail closed by design.
2. `CIRCLE_CHAIN_CODES` was verified against `circle blockchain list` on 2026-09-08. Arc mainnet has no Circle CLI code yet (only `ARC-TESTNET`), so `circleChainCode(5042)` returns `undefined` — add the mainnet code Circle publishes after the 2026-09-16 launch.
3. Arc (5042) is out of the chain allowlist entirely as of 0.2.0 — re-add it to `SELAT_REFUND_CHAIN_IDS` + `VERIFICATION_PROBE_ORDER` + `CIRCLE_CHAIN_CODES` together, once Circle publishes the mainnet chain code and an Arc RPC is configured.
4. ~~Run the Circle signing confirmation probes~~ — run 2026-09-08:
   - **Deployed chain (Base): fully confirmed.** Circle returns a bare 65-byte signature (no ERC-6492 wrap); on-chain `isValidSignature` accepts it; viem `verifyMessage` (this library's eip1271 path) accepts it; and `circleMscaReplaySafeDigest` reconstruction recovers exactly `getNativeOwner()`.
   - **Undeployed chain: the Circle CLI refuses to sign** ("This wallet isn't deployed on-chain yet"). Consequence: refund challenges must issue a `chainId` where the SCA is deployed (`findDeployedChain` resolves this), where plain EIP-1271 suffices. The deployless verifier stays as defense-in-depth — deployed-chain RPC outage, other wallet vendors, non-CLI signing paths — not as the primary mechanism.

## Development

```
npm install
npm test
npm run typecheck
npm run build
```

Tests are network-free; RPC clients are injected as minimal structural mocks.
