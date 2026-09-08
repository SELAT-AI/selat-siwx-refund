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
    chainId: challenge.chainId,
    account: transaction.clientAddress,        // recorded payer
  },
  clients,                                     // viem PublicClients by chain id
  knownImplementations,                        // Circle MSCA implementation allowlist
});

if (result.isValid) {
  // result.accountAddress (== message.address) is the authenticated identity.
  // result.signerAddress is audit metadata only — never compare it to the payer.
}
```

The pipeline: field validation → EOA ecrecover → on-chain EIP-1271 (via viem `verifyMessage`, which also handles ERC-6492) where the wallet has code → deployless Circle-SCA reconstruction. Non-65-byte signatures do not abort the pipeline.

Callers still own, outside this library: single-use nonce consumption, rate limiting, quote lookup ordering (resolve the quote and check the payer address **before** any RPC-bearing verification), and per-`quoteId` idempotency.

## Before production

1. Populate `KNOWN_CIRCLE_MSCA_IMPLEMENTATIONS` (it ships empty and the deployless path fails closed): run `node scripts/probe-implementation.mjs <deployed-wallet> <rpcUrl>` against a deployed Circle Agent Wallet and add the reported implementation address.
2. Confirm the Circle CLI chain codes in `CIRCLE_CHAIN_CODES` against `circle blockchain list`.
3. Configure an Arc mainnet RPC before enabling chain 5042.
4. Run the two Circle signing confirmation probes from the scoping doc (a deployed-chain signature verifying via on-chain 1271, and an undeployed-chain signature verifying via the deployless path).

## Development

```
npm install
npm test
npm run typecheck
npm run build
```

Tests are network-free; RPC clients are injected as minimal structural mocks.
