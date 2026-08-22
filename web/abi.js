/**
 * The two calls this page makes, encoded by hand.
 *
 * No dependency does this for us because none is worth the weight: an approve
 * and one function is the entire surface. What that buys instead is a place
 * where a mistake is invisible, a wrong selector is four bytes that look
 * fine and revert on chain, so this is checked against `cast calldata` in the
 * tests rather than against itself.
 */

/// keccak256("bridge(uint256,string,bool,uint256)")[0:4]
export const BRIDGE_SELECTOR = '0x70a8909d';
/// keccak256("approve(address,uint256)")[0:4]
export const APPROVE_SELECTOR = '0x095ea7b3';

const word = (value) => BigInt(value).toString(16).padStart(64, '0');

export function encodeApprove(spender, amount) {
  return APPROVE_SELECTOR + spender.slice(2).toLowerCase().padStart(64, '0') + word(amount);
}

/**
 * @dev The recipient is a `string`, so it travels out of line: four fixed
 * words, then an offset pointing past them to a length and the bytes. Getting
 * the offset wrong produces calldata that decodes to a different address,
 * which is the failure worth being careful about, the contract checks the
 * checksum of whatever it is handed, not of what was meant.
 */
export function encodeBridge(amount, recipient, activate, acceptedActivationFee) {
  const bytes = new TextEncoder().encode(recipient);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const padded = hex.padEnd(Math.ceil(bytes.length / 32) * 64, '0');

  return (
    BRIDGE_SELECTOR +
    word(amount) +
    word(128) + // the four fixed words come first
    word(activate ? 1 : 0) +
    word(acceptedActivationFee) +
    word(bytes.length) +
    padded
  );
}

/// keccak256("receiveMessage(bytes,bytes)")[0:4], checked with `cast sig`.
export const RECEIVE_SELECTOR = '0x57ecfd28';

/**
 * The claim on the EVM side, which the recipient signs themselves.
 *
 * Two dynamic arguments, so both travel out of line: two offset words, then
 * each length followed by its bytes padded to a word. The same care as
 * {encodeBridge} applies and for the same reason, a wrong offset is calldata
 * that decodes to something else entirely and reverts after it has been paid
 * for.
 */
export function encodeReceiveMessage(message, attestation) {
  const strip = (hex) => hex.replace(/^0x/, '');
  const pad = (hex) => hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');

  const m = strip(message);
  const a = strip(attestation);
  const mBytes = m.length / 2;
  const aBytes = a.length / 2;

  // Two head words, then the message: length word plus its padded body.
  const attestationOffset = 64 + 32 + Math.ceil(mBytes / 32) * 32;

  return (
    RECEIVE_SELECTOR +
    word(64) +
    word(attestationOffset) +
    word(mBytes) +
    pad(m) +
    word(aBytes) +
    pad(a)
  );
}
