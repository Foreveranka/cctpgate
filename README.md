# CCTPGate

Native USDC out of Avalanche, into the chains CCTP already reaches and no
bridge serves. Stellar and EDGE first, Arc when its mainnet CCTP opens.

Not a cheaper bridge. A front door: the money arrives on the far side in an
account that already works.

## The gap

Circle's CCTP moves native USDC across 28 mainnet networks by burning on the
source chain and minting on the destination. No wrapped tokens, no liquidity
pool, no third-party custody. Protocol coverage has outrun product coverage:
several networks where CCTP is fully deployed cannot be reached from Avalanche
through any bridge, including Circle's own interface.

Two of them hold real money.

- **Stellar** holds roughly $830M in stablecoins with a payments-first user
  base. Allbridge Core, the only alternative carrying USDC in from EVM chains,
  was pool-based and paused after a $1.65M exploit in July 2026.
- **EDGE** is the chain behind edgeX, a top-four perpetuals venue clearing
  around $850M a day, where native USDC is the margin and settlement asset.
  No bridge or aggregator covers it: not LI.FI, not Squid, not Across.

The Avalanche C-Chain sits at the centre with about $1.69B in stablecoins, and
standard attestation completes there in seconds, which makes it the fastest
source chain in the protocol.

## What this is

Three parts, and the smallest one is the only contract we deploy.

| Part | What it does |
|---|---|
| Avalanche contract | Takes the user's USDC, separates the service fee, burns the rest toward the destination. Holds no funds, takes no custody. |
| Watcher | Follows Circle's attestation and delivers on the far side: the forwarder call on Stellar, `receiveMessage` on EDGE. |
| Web interface | Connect a wallet, enter an amount and a destination, send. |

Delivery on the destination chains happens through permissionless calls to
Circle's existing contracts, so **nothing has to be deployed there.**

## The Stellar problem this solves

To receive USDC on Stellar an account must exist, hold an XLM reserve and have
a trustline. A first-time user hits all three walls at once and a plain bridge
leaves them there: the USDC lands and they can do nothing with it.

CCTPGate reads what the destination account is missing and makes it ready as
part of the transfer. The user arrives with spendable USDC and never has to
hold XLM. The account stays theirs: nothing here generates or custodies a key.

## Status

Testnet. The source chain is Avalanche Fuji, the destination is Stellar
testnet. Nothing is deployed on mainnet.

Roadmap:

| Milestone | Deliverable | Proof |
|---|---|---|
| M1 | End to end Fuji to Stellar testnet transfer, working interface | on-chain tx hashes |
| M2 | Avalanche to Stellar on mainnet, both ways, account preparation included | live product, first transfers |
| M3 | Avalanche to EDGE, both ways | live product, first transfers |
| M4 | Arc corridor when its CCTP mainnet opens, aggregator and wallet talks | third corridor live |

## Layout

```
src/          Solidity: the source-side contract and Stellar address decoding
script/       Deploy script, every argument read from the environment
api/          Watcher service: attestation tracking and far-side delivery
web/          The interface
test/         Foundry tests
```

## Running it

```bash
forge test                       # contracts
cd api && npm install && npm test # watcher
```

The deploy script refuses to guess. Every address is passed in explicitly,
because a script that falls back to a sensible-looking address is a script that
eventually sends fees somewhere nobody chose:

```bash
BRIDGE_OWNER=0x… BRIDGE_TREASURY=0x… \
BRIDGE_USDC=0x… BRIDGE_MESSENGER=0x… BRIDGE_FORWARDER=0x… \
forge script script/Deploy.s.sol --rpc-url fuji --account <keystore> --broadcast
```

Avalanche Fuji, verified on chain before being written down here:

| Piece | Address |
|---|---|
| USDC | `0x5425890298aed601595a70AB815c96711a31Bc65` |
| CCTP v2 TokenMessenger | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| CCTP v2 MessageTransmitter | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| CCTP domain | `1` |

## Links

- Product: https://cctpgate.vercel.app
- Documentation: https://cctpgatedoc.vercel.app

Not financial advice. Testnet only. USDC and CCTP are Circle's; Avalanche is
Ava Labs'.
