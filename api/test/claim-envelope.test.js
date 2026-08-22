import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Account,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk';

import { parseEnvelope, assertOnlyClaims, SuspiciousSetup } from '../../web/envelope.js';

/**
 * The claim guard, against envelopes the real SDK built.
 *
 * The claim is prepared by the watcher and signed by the user, which makes it
 * the same shape of risk as the burn going out: a service that has been
 * tampered with, or a tunnel somebody else now answers, hands back a
 * transaction and the page passes it to a wallet. Freighter draws a Soroban
 * invocation as a contract id and a row of encoded arguments, so "read it
 * before you sign" is advice nobody can act on.
 *
 * Every case below is a transaction somebody could actually be handed while
 * believing they were collecting their own money.
 */

const user = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5));
const attacker = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11));
const FORWARDER = 'CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ';
const OTHER_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');

const passphrase = Networks.TESTNET;
const expected = { user: user.publicKey(), forwarderId: FORWARDER };

const bytes = (n, fill) => nativeToScVal(Buffer.alloc(n, fill), { type: 'bytes' });

function claim({
  source = user.publicKey(),
  contractId = FORWARDER,
  fn = 'mint_and_forward',
  fee = '1000000',
  args = [bytes(64, 1), bytes(65, 2)],
  extraOps = [],
} = {}) {
  const builder = new TransactionBuilder(new Account(source, '123456789'), {
    fee,
    networkPassphrase: passphrase,
  }).addOperation(new Contract(contractId).call(fn, ...args));

  for (const op of extraOps) builder.addOperation(op);
  return parseEnvelope(builder.setTimeout(120).build().toXDR());
}

test('the claim it is supposed to be passes', () => {
  assert.doesNotThrow(() => assertOnlyClaims(claim(), expected));
});

test('a claim drawn on somebody else is refused', () => {
  assert.throws(
    () => assertOnlyClaims(claim({ source: attacker.publicKey() }), expected),
    SuspiciousSetup,
  );
});

/// The one that matters most: a payment dressed up as a claim. The user
/// pressed a button called Claim and would have signed away their balance.
test('a payment smuggled in beside the claim is refused', () => {
  const theft = Operation.payment({
    destination: attacker.publicKey(),
    asset: USDC,
    amount: '1000',
  });

  assert.throws(() => assertOnlyClaims(claim({ extraOps: [theft] }), expected), SuspiciousSetup);
});

/// Worse than theft of a balance, because it outlives the transaction: an
/// extra signer is a standing key on the account.
test('an added signer beside the claim is refused', () => {
  const takeover = Operation.setOptions({
    signer: { ed25519PublicKey: attacker.publicKey(), weight: 1 },
  });

  assert.throws(() => assertOnlyClaims(claim({ extraOps: [takeover] }), expected), SuspiciousSetup);
});

test('a call to a contract that is not the forwarder is refused', () => {
  assert.throws(
    () => assertOnlyClaims(claim({ contractId: OTHER_CONTRACT }), expected),
    SuspiciousSetup,
  );
});

test('the forwarder called by a different name is refused', () => {
  assert.throws(() => assertOnlyClaims(claim({ fn: 'transfer' }), expected), SuspiciousSetup);
});

/// The fee is the ceiling on what a signature can cost, and a Soroban fee
/// covers the resource fee too. An enormous one is a way to take the XLM the
/// sponsorship left for the user's own transactions.
test('a claim carrying an enormous fee is refused', () => {
  assert.throws(() => assertOnlyClaims(claim({ fee: '90000000' }), expected), SuspiciousSetup);
});

test('a claim with the wrong number of arguments is refused', () => {
  assert.throws(
    () => assertOnlyClaims(claim({ args: [bytes(64, 1)] }), expected),
    SuspiciousSetup,
  );
});

/// A refusal has to name what it refused. "Invalid transaction" tells somebody
/// nothing about whether they are being robbed or the service is broken.
test('the refusal says what it saw', () => {
  try {
    assertOnlyClaims(claim({ fn: 'transfer' }), expected);
    assert.fail('should have refused');
  } catch (error) {
    assert.match(error.message, /transfer/);
    assert.match(error.message, /Nothing has been signed/);
  }
});
