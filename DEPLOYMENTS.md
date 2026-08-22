# Deployments

What is on chain, and the transactions that put it there. Testnet only; nothing
here is on mainnet and none of these addresses hold anything of value.

## Avalanche Fuji, the source chain

| What | Address |
|---|---|
| CCTPGate source contract | [`0x40966f7959834845d9dc82bdf04755ca3034af0f`](https://testnet.snowtrace.io/address/0x40966f7959834845d9dc82bdf04755ca3034af0f) |
| Deploy transaction | [`0xc8518d33…3992d481`](https://testnet.snowtrace.io/tx/0xc8518d33d2c5930b91ddc611957af8d85033fecf0b92af934967eeed3992d481) |
| USDC | `0x5425890298aed601595a70AB815c96711a31Bc65` |
| CCTP v2 TokenMessenger | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| CCTP v2 MessageTransmitter | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| CCTP domain | `1` |

Fees, both readable from the contract rather than taken on trust:

| Fee | Value | When |
|---|---|---|
| Bridge fee | 50 bps | Every transfer, both directions |
| Account sponsorship | 3 USDC | Only when the destination account cannot hold USDC yet |

## Stellar testnet, the destination

| What | Address |
|---|---|
| Reverse contract, targeting Avalanche | [`CDTM6T3QGHPJRDTYPNRUH6BELHBWVIX74NFVMSJMYZSHDV7ZABT6MOGJ`](https://stellar.expert/explorer/testnet/contract/CDTM6T3QGHPJRDTYPNRUH6BELHBWVIX74NFVMSJMYZSHDV7ZABT6MOGJ) |
| USDC issuer | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| Circle CctpForwarder | `CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ` |
| CCTP domain | `27` |

The reverse contract reports `destination_domain: 1`, which is Avalanche. It was
read back off the deployed contract, not assumed from the source.

## Transfers that actually ran

Each row is a whole path rather than a step: a burn on one chain and a mint on
the other, both public and both checkable without asking us anything.

### Avalanche to Stellar, into an account that could already receive

| Leg | Transaction |
|---|---|
| Burn, 10 USDC | [`0xa5b8397a…7a86cf1b`](https://testnet.snowtrace.io/tx/0xa5b8397a3fcc1cc907b9229882b88e317b52c5b8108b844423c0de7d7a86cf1b) |
| Mint, 9.95 USDC | [`698820c4…f13fd411e`](https://stellar.expert/explorer/testnet/tx/698820c4f61a6a9cf9e8d98ed0205d0d419497dba1a2619e609c003f13fd411e) |

Ten sent, five basis points taken, the rest delivered. Burn to mint took three
seconds.

### Avalanche to Stellar, into an account that did not exist

| Leg | Transaction |
|---|---|
| Burn, 10 USDC with sponsorship | [`0x959d45a9…5f4c64b9`](https://testnet.snowtrace.io/tx/0x959d45a99165a820cc9f6cb48f19bee461a5c68f4071348606907c305f4c64b9) |
| Mint, 6.95 USDC, signed by the recipient | [`d3d95705…3c4b3c76`](https://stellar.expert/explorer/testnet/tx/d3d957058e9c798e4643107026bdb9b20498957ca0e4606e6ad283483c4b3c76) |

The destination was a keypair with no account behind it. It ended the transfer
with a funded account, a USDC trustline, 3 XLM of its own to spend, and 6.95
USDC that it minted itself. Three USDC for the sponsorship, five basis points
for the bridge.

### Stellar to Avalanche

| Leg | Transaction |
|---|---|
| Burn, 5 USDC | [`5f36ec7b…c3aebe248`](https://stellar.expert/explorer/testnet/tx/5f36ec7b058a352186cae7c4bd6da1bf4df43be4ec51d736e945fd7c3aebe248) |
| Mint, 4.975 USDC | [`0x242e3194…535acf09`](https://testnet.snowtrace.io/tx/0x242e31945d7b9e1310068b4fc79bd02dfa24c639e5d23b7fe061cb11535acf09) |

## What was refused, and why that is the point

Each of these was rejected on the source side, before any money moved:

| Attempt | Result |
|---|---|
| Address with one character changed | Refused, checksum mismatch |
| Lowercase address | Refused, character outside the alphabet |
| Contract address (`C…`) as the recipient | Refused, wrong version byte |
| 0.5 USDC, below the floor | Refused, amount too small |
| Sponsorship priced above what the caller agreed to | Refused, the quote you saw is the quote you pay |
