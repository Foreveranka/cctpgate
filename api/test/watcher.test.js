import test from 'node:test';
import assert from 'node:assert/strict';

import { step, sweep } from '../src/watcher/index.js';
import { Store } from '../src/watcher/store.js';
import { classifyFailure } from '../src/watcher/deliver.js';

const TX = '0xaf406107764bab3b9e7d12142a1b67eefd9a24898f549ff404ff059cc9b00ec8';
const RECIPIENT = 'GAFKBZTURNATMAL6KBLKBOPBRF2WZ4DKPMO6MIAUFIXVQU5EH7CHOZ5Z';

const PAID_ACTIVATION = { txHash: TX, stellarRecipient: RECIPIENT, activate: true };
const READY = { ready: true, message: 'deadbeef', attestation: 'c0ffee', fellBackToStandard: false };

/** A watcher whose every dependency answers as told, and counts being asked. */
function harness(overrides = {}) {
  const calls = { setups: 0, deliveries: 0 };
  const store = new Store();

  const deps = {
    store,
    verifyBurn: async () => PAID_ACTIVATION,
    submitSetup: async () => {
      calls.setups += 1;
      return { ok: true };
    },
    attest: async () => READY,
    deliver: async () => {
      calls.deliveries += 1;
      return { ok: true, hash: 'stellar-hash' };
    },
    ...overrides,
  };

  return { store, deps, calls };
}

test('a transfer with everything in place is provisioned and handed over', async () => {
  const { store, deps, calls } = harness();
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'claimable');
  assert.equal(calls.setups, 1);
  // The account was made usable. The mint is not ours to make and never runs.
  assert.equal(calls.deliveries, 0);
  assert.equal(store.get(TX).deliveredAt, null);
  assert.ok(store.get(TX).claimable.message, 'the message is kept for the claim');
});

/// The whole point of handing it over: the watcher stops working on it. A
/// transfer waiting on its recipient is not a job we are still failing to do.
test('a claimable transfer leaves the work queue', async () => {
  const { store, deps } = harness();
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  await step(transfer, deps);

  assert.equal(store.pending().length, 0, 'nothing left for the watcher');
  assert.equal(store.claimable().length, 1, 'and one thing left for the user');
});

/**
 * The step that was skipped by hand on 7 August. Nothing may be spent, and
 * nothing may be delivered, until the burn has been read off the chain.
 */
test('an unproven burn spends nothing', async () => {
  const { store, deps, calls } = harness({ verifyBurn: async () => null });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'wait');
  assert.equal(calls.setups, 0, 'no XLM moves for a burn nobody has seen');
  assert.equal(calls.deliveries, 0);
});

test('a burn that cannot be verified stops the transfer rather than the loop', async () => {
  const { store, deps } = harness({
    verifyBurn: async () => {
      throw new Error('burn reverted');
    },
  });
  store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const [result] = await sweep(deps);
  assert.equal(result.action, 'error');
  assert.match(result.reason, /reverted/);
});

/**
 * The three-XLM-per-tab attack, arriving as a retry loop. However many times
 * this runs, one burn buys one activation.
 */
test('running twenty times against one burn submits one setup', async () => {
  const { store, deps, calls } = harness();
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });
  // Never finishes, so the transfer stays pending and keeps being swept.
  deps.attest = async () => ({ ready: false });

  for (let i = 0; i < 20; i += 1) await step(store.get(TX) ?? transfer, deps);

  assert.equal(calls.setups, 1, 'the claim held');
});

test('a claim taken elsewhere is not taken again', async () => {
  const { store, deps, calls } = harness();
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });
  store.claimActivation(TX); // somebody else got there first

  const result = await step(transfer, deps);

  assert.equal(calls.setups, 0, 'it must not spend a second time');
  assert.equal(result.reason, 'already provisioned');
});

/**
 * A destination that can pay its own reserve owes nothing, so the trustline is
 * not gated behind a claim it never had to make.
 */
test('a trustline-only setup needs no claim', async () => {
  const { store, deps, calls } = harness({
    verifyBurn: async () => ({ txHash: TX, stellarRecipient: RECIPIENT, activate: false }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  await step(transfer, deps);

  assert.equal(calls.setups, 1);
  assert.equal(store.get(TX).activationClaimed, false, 'nothing of ours was spent');
});

test('provisioning happens before the attestation is even asked for', async () => {
  const order = [];
  const { store, deps } = harness({
    submitSetup: async () => {
      order.push('setup');
      return { ok: true };
    },
    attest: async () => {
      order.push('attest');
      return READY;
    },
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  await step(transfer, deps);

  assert.deepEqual(order, ['setup', 'attest'], 'fifteen seconds of margin is not slack');
});

test('a pending attestation is waited on, not delivered', async () => {
  const { store, deps, calls } = harness({
    attest: async () => ({ ready: false, delayReason: 'insufficient_fee' }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'wait');
  assert.match(result.reason, /insufficient_fee/, 'the reason belongs in the log');
  assert.equal(calls.deliveries, 0);
});

test('a losing setup is retried rather than written off', async () => {
  const { store, deps } = harness({
    submitSetup: async () => ({ ok: false, operationCodes: ['op_underfunded'] }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'retry-setup');
  assert.match(result.reason, /op_underfunded/);
  assert.equal(store.get(TX).provisioned, false);
});

/// Losing the race is not a failure: the address ended up usable either way.
test('a setup that was already done counts as provisioned', async () => {
  const { store, deps } = harness({
    submitSetup: async () => ({ ok: false, alreadyDone: true }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  await step(transfer, deps);
  assert.equal(store.get(TX).provisioned, true);
});

/// A claim that fails costs the recipient a fee and nothing else: the CCTP
/// message is not consumed by a failed forward, so it stays claimable. The
/// watcher records nothing about attempts it did not make.
test('a failed claim leaves the transfer claimable', async () => {
  const { store, deps } = harness();
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  await step(transfer, deps);
  // The user tried and the trustline was missing. Nothing here changes.
  assert.equal(store.get(TX).deliveredAt, null);
  assert.equal(store.claimable().length, 1);
});

/// Once the claim lands, the interface says so and the record closes. This is
/// the only way a transfer is ever marked delivered now.
test('a landed claim is recorded and the transfer closes', async () => {
  const { store, deps } = harness();
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  await step(transfer, deps);
  store.markDelivered(TX, 'stellar-hash');

  assert.equal(store.get(TX).deliveredAt.stellarTxHash, 'stellar-hash');
  assert.equal(store.pending().length, 0);
  assert.equal(store.claimable().length, 0);
});

test('a fallback to hard finality is handed over and said out loud', async () => {
  const { store, deps } = harness({
    attest: async () => ({ ...READY, fellBackToStandard: true }),
  });
  const transfer = store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const result = await step(transfer, deps);

  assert.equal(result.action, 'claimable');
  assert.match(result.reason, /slow road/);
});

test('a delivered transfer is left alone', async () => {
  const { store, deps, calls } = harness();
  store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });
  store.markDelivered(TX, 'stellar-hash');

  const result = await step(store.get(TX), deps);

  assert.equal(result.action, 'done');
  assert.equal(calls.deliveries, 0);
});

test('one broken transfer does not stop the others', async () => {
  const { store, deps } = harness({
    verifyBurn: async (txHash) => {
      if (txHash === '0xbad') throw new Error('rpc exploded');
      return PAID_ACTIVATION;
    },
  });
  store.remember({ txHash: '0xbad', recipient: RECIPIENT, setupXdr: 'XDR' });
  store.remember({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' });

  const results = await sweep(deps);

  assert.equal(results.length, 2);
  assert.equal(results.find((r) => r.txHash === '0xbad').action, 'error');
  assert.equal(results.find((r) => r.txHash === TX).action, 'claimable');
});

// --- what a refusal from Stellar means ------------------------------------

/**
 * The asymmetry that sets the default: a wrongly-retried delivery costs a
 * transaction fee, a wrongly-abandoned one costs the user everything they
 * sent. The message is not consumed by a failure, so being late is free.
 */
test('an unrecognised failure is retried, because giving up is the expensive mistake', () => {
  assert.equal(classifyFailure(new Error('something nobody has seen')).retryable, true);
});

test('a missing trustline is a wait, not a loss', () => {
  const verdict = classifyFailure(new Error('HostError: TrustlineMissing'));
  assert.equal(verdict.retryable, true);
  assert.match(verdict.reason, /trustline/i);
});

/**
 * The real refusal, taken verbatim from replaying an already-delivered
 * message against Circle's forwarder on testnet. The first version of
 * classifyFailure searched for the words "already used" and read this as
 * retryable, which would have had the watcher redeliver a finished transfer
 * until it gave up an hour later.
 *
 * 6908 is NonceAlreadyUsed, read from the MessageTransmitter's own error enum
 * on chain rather than inferred.
 */
test('a consumed nonce is finished, and it only says so in numbers', () => {
  const real =
    'HostError: Error(Contract, #6908)\n\nEvent log (newest first):\n   0: [Diagnostic Event] ' +
    'contract:CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ, topics:[error, Error(Contract, #6908)]';

  const verdict = classifyFailure(new Error(real));
  assert.equal(verdict.done, true);
  assert.equal(verdict.retryable, false);
});

test('a malformed message asks for a person instead of another attempt', () => {
  const verdict = classifyFailure(new Error('HostError: Error(Contract, #7303)'));
  assert.equal(verdict.retryable, false);
  assert.equal(verdict.needsHuman, true, 'retrying this forever tells nobody');
});

test('a pause is waited out', () => {
  const verdict = classifyFailure(new Error('HostError: Error(Contract, #1000)'));
  assert.equal(verdict.retryable, true);
  assert.match(verdict.reason, /paused/i);
});
