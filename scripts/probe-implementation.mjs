#!/usr/bin/env node
// Read-only helper to populate KNOWN_CIRCLE_MSCA_IMPLEMENTATIONS:
// reads the ERC-1967 implementation slot and getNativeOwner() of a deployed
// Circle Agent Wallet. Makes eth_getCode / eth_getStorageAt / eth_call only.
//
//   node scripts/probe-implementation.mjs <walletAddress> <rpcUrl>
import { createPublicClient, http, getAddress } from "viem";

const [wallet, rpcUrl] = process.argv.slice(2);
if (!wallet || !rpcUrl) {
  console.error("usage: node scripts/probe-implementation.mjs <walletAddress> <rpcUrl>");
  process.exit(1);
}

const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const client = createPublicClient({ transport: http(rpcUrl) });

const code = await client.getCode({ address: getAddress(wallet) });
if (!code || code === "0x") {
  console.error(`no code at ${wallet} on this chain — probe a chain where the wallet is deployed`);
  process.exit(2);
}
console.log(`code: ${code.length / 2 - 1} bytes`);

const word = await client.getStorageAt({ address: getAddress(wallet), slot: SLOT });
const implementation = getAddress(`0x${word.slice(-40)}`);
console.log(`implementation (add to KNOWN_CIRCLE_MSCA_IMPLEMENTATIONS): ${implementation}`);

const owner = await client.readContract({
  address: getAddress(wallet),
  abi: [
    {
      type: "function",
      name: "getNativeOwner",
      stateMutability: "view",
      inputs: [],
      outputs: [{ name: "", type: "address" }],
    },
  ],
  functionName: "getNativeOwner",
});
console.log(`getNativeOwner: ${owner}`);
