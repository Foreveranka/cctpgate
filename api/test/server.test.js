import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler, createRateLimiter, listen } from '../src/server.js';
import { Store } from '../src/watcher/store.js';
import { UnpaidBurn } from '../src/watcher/burn.js';

const TX = '0xaf406107764bab3b9e7d12142a1b67eefd9a24898f549ff404ff059cc9b00ec8';
const RECIPIENT = 'GAFKBZTURNATMAL6KBLKBOPBRF2WZ4DKPMO6MIAUFIXVQU5EH7CHOZ5Z';
const OTHER = 'GAB4UFSIFR7DQMAUPHFYBXWBWGSDQT3Q3MTQPGMNODG3W5ITNIWJPX2U';

function harness(verifyBurn) {
  const store = new Store();
  // Counted, so a test can say "nothing was looked up" and mean it.
  const calls = { verified: 0 };
  return {
    store,
    calls,
    handle: createHandler({
      store,
      verifyBurn: async (txHash, recipient) => {
        calls.verified += 1;
        if (verifyBurn) return verifyBurn(txHash, recipient);
        if (recipient !== RECIPIENT) {
          throw new UnpaidBurn(`burn ${txHash} paid for ${RECIPIENT}, not ${recipient}`);
        }
        return { txHash, stellarRecipient: RECIPIENT, activate: true };
      },
    }),
  };
}

const post = (body) => ({ method: 'POST', path: '/transfers', body });

test('takes the setup the browser is the only source of', async () => {
  const { store, handle } = harness();

  const result = await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));

  assert.equal(result.status, 200);
  assert.equal(result.body.hasSetup, true);
  assert.equal(store.get(TX).setupXdr, 'XDR');
});

test('a transfer needs both a burn and a recipient', async () => {
  const { handle } = harness();
  assert.equal((await handle(post({ txHash: TX }))).status, 400);
  assert.equal((await handle(post({ recipient: RECIPIENT }))).status, 400);
});

/**
 * The griefing vector this endpoint exists to not have. `remember` refuses one
 * burn against two addresses, so whoever files first wins, and anyone can
 * read a transaction hash off the chain. Verifying before recording means a
 * recipient the burn does not name is never written down at all.
 */
test('a burn cannot be filed against an address it did not pay', async () => {
  const { store, handle } = harness();

  const result = await handle(post({ txHash: TX, recipient: OTHER, setupXdr: 'XDR' }));

  assert.equal(result.status, 400);
  assert.equal(store.get(TX), null, 'nothing was written, so the real one is not locked out');

  const real = await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));
  assert.equal(real.status, 200, 'and it can still be filed correctly afterwards');
});

/**
 * The browser posts within a second of burning, and the receipt may not be
 * visible yet. That is a "come back", not a refusal, and recording it now
 * would mean recording something unverified.
 */
test('a burn the chain has not shown yet is answered with come back', async () => {
  const { store, handle } = harness(async () => null);

  const result = await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));

  assert.equal(result.status, 202);
  assert.equal(result.body.retry, true);
  assert.equal(store.get(TX), null);
});

test('posting the same transfer twice is not an error', async () => {
  const { handle } = harness();
  await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));

  const again = await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));
  assert.equal(again.status, 200);
});

/// The follower records the burn from the log; the browser brings the setup
/// afterwards. Both orders have to work.
test('a setup arriving after the log is filled in', async () => {
  const { store, handle } = harness();
  store.remember({ txHash: TX, recipient: RECIPIENT });

  const result = await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));

  assert.equal(result.body.hasSetup, true);
  assert.equal(store.get(TX).setupXdr, 'XDR');
});

// --- reading state back ---------------------------------------------------

test('an unknown transfer is a 404, not an empty answer', async () => {
  const { handle } = harness();
  assert.equal((await handle({ method: 'GET', path: `/transfers/${TX}` })).status, 404);
});

test('progress is readable without exposing the signed setup', async () => {
  const { store, handle } = harness();
  await handle(post({ txHash: TX, recipient: RECIPIENT, setupXdr: 'XDR' }));
  store.markDelivered(TX, 'stellar-hash');

  const result = await handle({ method: 'GET', path: `/transfers/${TX}` });

  assert.equal(result.status, 200);
  assert.equal(result.body.delivered, true);
  assert.equal(result.body.hasSetup, true);
  assert.equal(result.body.setupXdr, undefined, 'a signed transaction is not status');
});

test('health reports the queue', async () => {
  const { store, handle } = harness();
  store.remember({ txHash: TX, recipient: RECIPIENT });

  const result = await handle({ method: 'GET', path: '/health' });
  assert.equal(result.body.pending, 1);
});

test('an unknown route is refused', async () => {
  const { handle } = harness();
  assert.equal((await handle({ method: 'GET', path: '/whatever' })).status, 404);
});

// --- letting the page talk to it ------------------------------------------

/**
 * The page and the watcher are never the same origin. However this is
 * arranged, a static host and a service, or two ports on one laptop, the
 * browser asks permission first and refuses everything without it.
 */
test('a preflight is answered rather than looked up as a route', async () => {
  const answered = [];
  const fakeServer = {
    listen() {},
  };
  const created = (handler) => {
    fakeServer.handler = handler;
    return fakeServer;
  };

  const { handle } = harness();
  listen(handle, { port: 0, createServer: created });

  const res = {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    writeHead(status) {
      answered.push(status);
      return this;
    },
    end() {},
  };
  await fakeServer.handler({ method: 'OPTIONS', url: '/setup', [Symbol.asyncIterator]: async function* () {} }, res);

  assert.deepEqual(answered, [204], 'a 404 here refuses the request that follows');
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.match(res.headers['access-control-allow-headers'], /content-type/);
});

/**
 * The claim report, which used to be taken on trust.
 *
 * Anybody can reach this service, so a report that closed a record on its own
 * say-so let a stranger clear somebody else's claim off their screen. The
 * money was never reachable, CCTP is spent by the chain and not by our
 * bookkeeping, but a bridge whose screen lies about where your money is has
 * failed at the only job the screen has.
 */
test('a claim report is refused while the chain still has the message', async () => {
  const store = new Store();
  store.remember({ txHash: TX, recipient: RECIPIENT });
  store.markClaimable(TX, { message: 'de', attestation: 'ad' });

  const handle = createHandler({
    store,
    verifyBurn: async () => ({ txHash: TX, stellarRecipient: RECIPIENT, activate: false }),
    // The chain says it is still waiting, whatever the caller claims.
    messageConsumed: async () => false,
  });

  const answer = await handle({
    method: 'POST',
    path: '/claimed',
    body: { txHash: TX, stellarTxHash: 'made-up' },
  });

  assert.equal(answer.status, 409);
  assert.equal(store.get(TX).deliveredAt, null, 'the record stays open');
  assert.equal(store.claimable().length, 1, 'and the owner still sees their claim');
});

test('a claim report is recorded once the chain agrees it was spent', async () => {
  const store = new Store();
  store.remember({ txHash: TX, recipient: RECIPIENT });
  store.markClaimable(TX, { message: 'de', attestation: 'ad' });

  const handle = createHandler({
    store,
    verifyBurn: async () => ({ txHash: TX, stellarRecipient: RECIPIENT, activate: false }),
    messageConsumed: async () => true,
  });

  const answer = await handle({
    method: 'POST',
    path: '/claimed',
    body: { txHash: TX, stellarTxHash: 'abc123' },
  });

  assert.equal(answer.status, 200);
  assert.equal(store.get(TX).deliveredAt.stellarTxHash, 'abc123');
});

/// A watcher that cannot check must not guess. Refusing leaves the claim on
/// the screen, which is the harmless way to be wrong.
test('a watcher that cannot verify refuses rather than believing the report', async () => {
  const store = new Store();
  store.remember({ txHash: TX, recipient: RECIPIENT });
  store.markClaimable(TX, { message: 'de', attestation: 'ad' });

  const handle = createHandler({
    store,
    verifyBurn: async () => ({ txHash: TX, stellarRecipient: RECIPIENT, activate: false }),
  });

  const answer = await handle({ method: 'POST', path: '/claimed', body: { txHash: TX } });

  assert.equal(answer.status, 503);
  assert.equal(store.get(TX).deliveredAt, null);
});

// --- what a stranger can spend, which is the other kind of attack ---------

/**
 * None of these take money. They take the thing money buys: a service that
 * answers. Each was found by pointing the actual attack at the running
 * watcher rather than by imagining it.
 */

test('a body larger than the service accepts is refused before it is read', async () => {
  const fakeServer = { listen() {} };
  const { handle } = harness();
  listen(handle, { port: 0, createServer: (h) => ((fakeServer.handler = h), fakeServer) });

  const answered = [];
  const res = {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    writeHead(status) {
      answered.push(status);
      return this;
    },
    end() {},
  };

  let destroyed = false;
  await fakeServer.handler(
    {
      method: 'POST',
      url: '/transfers',
      headers: {},
      destroy() {
        destroyed = true;
      },
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(70 * 1024);
      },
    },
    res,
  );

  assert.deepEqual(answered, [413]);
  assert.equal(destroyed, true, 'and the connection is dropped rather than drained');
});

/// A five megabyte "hash" reached an RPC provider once and came back with
/// their error message, which means for a moment this was a way to spend
/// somebody else's quota.
test('something that is not a hash is refused before anything is asked of a chain', async () => {
  const { handle, calls } = harness();

  const answer = await handle({
    method: 'POST',
    path: '/transfers',
    body: { txHash: `0x${'a'.repeat(5000)}`, recipient: RECIPIENT },
  });

  assert.equal(answer.status, 400);
  assert.equal(calls.verified, 0, 'nothing was looked up on the strength of it');
});

test('a caller past the limit is refused, and the ones under it are not', () => {
  const allow = createRateLimiter({ limits: { '/setup': 3 }, windowMs: 60_000 });
  const now = 1_000_000;

  assert.equal(allow('1.2.3.4', '/setup', now), true);
  assert.equal(allow('1.2.3.4', '/setup', now), true);
  assert.equal(allow('1.2.3.4', '/setup', now), true);
  assert.equal(allow('1.2.3.4', '/setup', now), false, 'the fourth in a minute');

  // Somebody else is not paying for that.
  assert.equal(allow('5.6.7.8', '/setup', now), true);
  // Nor is the same caller a minute later.
  assert.equal(allow('1.2.3.4', '/setup', now + 60_000), true);
  // And a route with no limit is not one.
  assert.equal(allow('1.2.3.4', '/health', now), true);
});

/// The interface polls the claim list every eight seconds. A limit that stops
/// that is a bug, so this is the test that keeps the numbers honest.
test('the real interface stays well under its own limit', () => {
  const allow = createRateLimiter();
  const now = 2_000_000;
  // Eight a minute is what the page does; do ten times that.
  for (let i = 0; i < 80; i += 1) {
    assert.equal(allow('1.2.3.4', '/claimable', now), true, `poll ${i} was refused`);
  }
});

test('a page nobody allowed gets no permission to read the answer', async () => {
  const fakeServer = { listen() {} };
  const { handle } = harness();
  listen(handle, {
    port: 0,
    createServer: (h) => ((fakeServer.handler = h), fakeServer),
    allowedOrigins: ['https://cctpgate.vercel.app'],
  });

  const res = {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    writeHead() {
      return this;
    },
    end() {},
  };
  await fakeServer.handler(
    {
      method: 'OPTIONS',
      url: '/claimable',
      headers: { origin: 'https://evil.example' },
      async *[Symbol.asyncIterator]() {},
    },
    res,
  );

  assert.equal(res.headers['access-control-allow-origin'], undefined);
});
