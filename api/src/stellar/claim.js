/**
 * The claim, built here and signed by whoever is collecting the money.
 *
 * We do not mint on anybody's behalf. What CCTPGate sells is an account that
 * works: it exists, it holds a USDC trustline, and it has enough XLM left over
 * to pay for its own transactions. The forwarder call that mints the USDC is
 * permissionless, costs about 0.0075 XLM, and belongs to the recipient. This
 * module builds it, simulates it so the resource footprint is filled in, and
 * hands back an unsigned envelope. Nothing here signs and nothing here submits.
 *
 * Why the server builds it at all: a Soroban invocation has to be simulated
 * before it can be submitted, the browser cannot do that without an RPC of its
 * own, and simulating after signing spends a signature on a transaction that
 * may not even be valid. So the shape is: server builds and simulates, user
 * signs, user submits.
 *
 * The failure that matters is the friendly one. `mint_and_forward` ends in a
 * token transfer that fails when the recipient has no USDC trustline, and that
 * failure does **not** consume the CCTP message. Being late is free, and a
 * claim refused today is a claim that still works tomorrow.
 */

import { Contract, TransactionBuilder, nativeToScVal, rpc } from '@stellar/stellar-sdk';

/**
 * @param source        The account that will sign and pay: normally the
 *                      recipient, but the call is permissionless, so anyone
 *                      willing to pay the fee may claim on their behalf.
 * @param message       Raw hex, no `0x`.
 * @param attestation   Raw hex, no `0x`.
 * @returns `{ xdr, source }` — unsigned, simulated, ready for a wallet.
 */
export async function buildClaim({
  rpcUrl,
  networkPassphrase,
  forwarderId,
  source,
  message,
  attestation,
  baseFee = '1000000',
  timeoutSeconds = 300,
  serverImpl = null,
}) {
  if (!source) throw new Error('buildClaim needs the account that will sign it');
  if (!message || !attestation) {
    throw new Error('buildClaim needs both the message and its attestation');
  }

  const server = serverImpl ?? new rpc.Server(rpcUrl);
  const contract = new Contract(forwarderId);

  const args = [
    nativeToScVal(Buffer.from(message, 'hex'), { type: 'bytes' }),
    nativeToScVal(Buffer.from(attestation, 'hex'), { type: 'bytes' }),
  ];

  const account = await server.getAccount(source);
  const built = new TransactionBuilder(account, { fee: baseFee, networkPassphrase })
    .addOperation(contract.call('mint_and_forward', ...args))
    .setTimeout(timeoutSeconds)
    .build();

  // Throws when the call cannot succeed as things stand, which is where a
  // missing trustline surfaces: before a signature is asked for, rather than
  // after one is spent.
  const prepared = await server.prepareTransaction(built);
  return { xdr: prepared.toXDR(), source };
}
