/**
 * Has this message already been spent?
 *
 * The interface reports its own claims, and for a while the watcher believed
 * them. That was a hole with a small blast radius and a real one: anybody who
 * could reach the service could mark somebody else's transfer as collected,
 * and the owner would open the page to find their claim gone. The money was
 * never at risk, the CCTP message is spent by the chain and not by our
 * record, but a bridge whose screen lies about where your money is has failed
 * at the only job the screen has.
 *
 * So a report is no longer taken on trust. It is checked against the thing
 * that actually decides: CCTP refuses a message it has already minted, and
 * that refusal is the proof. A simulation costs one call and moves nothing.
 */

import { classifyFailure } from './deliver.js';

/**
 * Simulates the Stellar claim and reads the answer.
 *
 * @param buildClaim The same builder the /claim endpoint uses. It prepares,
 *        which is to say it simulates, and a message already minted makes that
 *        preparation fail with the contract's own used-nonce error.
 * @returns true when the chain says the message is spent.
 */
export async function stellarMessageConsumed({ buildClaim, source, message, attestation }) {
  try {
    await buildClaim({ source, message, attestation });
    // It prepared, so the message is still waiting. Whoever said otherwise was
    // wrong, or lying.
    return false;
  } catch (error) {
    return classifyFailure(error).done === true;
  }
}

/**
 * Asks the EVM transmitter the same question, with `eth_call`, which executes
 * nothing.
 *
 * A used nonce reverts. Anything else that reverts is not proof of a claim, so
 * only the used-nonce answer counts, and everything else is read as "still
 * waiting" rather than as permission to close the record.
 */
export async function evmMessageConsumed({
  rpcUrl,
  transmitter,
  calldata,
  from,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ from, to: transmitter, data: calldata }, 'latest'],
    }),
  });

  const answer = await response.json().catch(() => ({}));
  const message = String(answer?.error?.message ?? '').toLowerCase();
  return message.includes('nonce already used');
}
