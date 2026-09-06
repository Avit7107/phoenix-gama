/**
 * ============================================================
 * TESTS FOR webhook_part_5.js
 * ============================================================
 *
 * Written to close the gap identified in the Part 5 review:
 * "No accompanying test file. Given the number of branches
 *  (invalid signature, invalid JSON, missing fields, dedup hit,
 *  unknown transaction, disallowed transition, happy path, DB
 *  failure), this needs unit tests before it can be trusted."
 *
 * The handler under test is left exactly as the AI produced it.
 * These tests are written against that file as-is, which means
 * some of them assert BROKEN behaviour on purpose. Those are
 * marked `DEFECT:` and each names the review item it pins down.
 * They are characterization tests: they lock in what the code
 * currently does so the fix is visible as a test change, rather
 * than silently passing before and after.
 *
 * Run with:
 *   npm i -D jest supertest express
 *   npx jest webhook_part_5.test.js
 * ============================================================
 */

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const SECRET = 'test_webhook_secret';
const MODULE = './webhook_part_5.js';

// ------------------------------------------------------------
// Fixtures & helpers
// ------------------------------------------------------------

const PAYMENT_REQUEST = {
  id: 'pr_00000000-0000-0000-0000-000000000001',
  provider_transaction_id: 'tx_abc123',
  status: 'PENDING',
};

function sign(rawBody, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function eventBody(overrides = {}) {
  return JSON.stringify({
    event_id: 'evt_001',
    provider_transaction_id: PAYMENT_REQUEST.provider_transaction_id,
    status: 'PAID',
    ...overrides,
  });
}

const squash = (sql) => String(sql).replace(/\s+/g, ' ').trim();

/**
 * Minimal pg-shaped double. Dispatches on the SQL text and records
 * every statement so tests can assert on transaction boundaries and
 * on writes that should NOT have happened.
 */
function makeDb({ existingEvent = false, paymentRequest = null, throwOn = null } = {}) {
  const statements = [];

  const client = {
    query: jest.fn(async (sql, params) => {
      const text = squash(sql);
      statements.push({ text, params });

      if (throwOn && text.includes(throwOn)) {
        throw new Error('simulated database failure');
      }
      if (text.includes('FROM processed_webhook_events')) {
        return { rows: existingEvent ? [{ exists: 1 }] : [] };
      }
      if (text.includes('FROM payment_requests')) {
        return { rows: paymentRequest ? [paymentRequest] : [] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };

  return {
    connect: jest.fn(async () => client),
    client,
    statements,
    ran: (fragment) => statements.some((s) => s.text.includes(fragment)),
  };
}

/**
 * The module reads WEBHOOK_SECRET at import time, so the env has to be
 * set before require() and the registry reset between cases. That this
 * is necessary at all is itself the point of the CRITICAL #2 test below.
 */
function loadRouter({ secret = SECRET } = {}) {
  jest.resetModules();
  if (secret === undefined) delete process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET;
  else process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET = secret;
  return require(MODULE);
}

function makeApp(router, { parser = express.raw({ type: 'application/json' }) } = {}) {
  const app = express();
  app.use(parser);
  app.use(router);
  return app;
}

function post(app, body, signature) {
  const req = request(app)
    .post('/webhooks/payments')
    .set('Content-Type', 'application/json');
  if (signature !== null) req.set('X-Signature', signature);
  return req.send(body);
}

/**
 * Asserts the handler never produces a response — the failure mode when
 * something throws outside the try/catch, or when the catch block itself
 * throws. Express 4 does not catch a rejected async handler, so the socket
 * is simply left open until the client gives up.
 */
async function expectNoResponse(pending) {
  await expect(pending.timeout(400)).rejects.toMatchObject({
    code: expect.stringMatching(/ECONNABORTED|ETIMEDOUT/),
  });
}

beforeEach(() => {
  // `db` and `logger` are undeclared globals in the handler (CRITICAL #1).
  // Supplying them here is the only way to exercise any path past the
  // signature check — which is precisely the defect, restated as a fixture.
  global.logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  global.db = makeDb({ paymentRequest: { ...PAYMENT_REQUEST } });
});

afterEach(() => {
  delete global.db;
  delete global.logger;
  jest.clearAllMocks();
});

// ------------------------------------------------------------
// 1. Signature verification
// ------------------------------------------------------------

describe('signature verification', () => {
  it('accepts a correctly signed payload', async () => {
    const app = makeApp(loadRouter());
    const body = eventBody();

    const res = await post(app, body, sign(body));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, applied: true });
  });

  it('rejects a missing signature header with 401', async () => {
    const app = makeApp(loadRouter());
    const body = eventBody();

    const res = await post(app, body, null);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid signature' });
  });

  it('rejects an incorrect signature with 401', async () => {
    const app = makeApp(loadRouter());
    const body = eventBody();

    const res = await post(app, body, sign(body, 'wrong_secret'));

    expect(res.status).toBe(401);
  });

  it('rejects a payload modified after signing (tamper detection)', async () => {
    const app = makeApp(loadRouter());
    const signed = eventBody({ status: 'FAILED' });
    const tampered = eventBody({ status: 'PAID' });

    const res = await post(app, tampered, sign(signed));

    expect(res.status).toBe(401);
  });

  it('rejects a truncated signature without throwing from timingSafeEqual', async () => {
    // timingSafeEqual throws on unequal buffer lengths; the explicit length
    // guard means a short signature is a clean 401, not a 500.
    const app = makeApp(loadRouter());
    const body = eventBody();

    const res = await post(app, body, 'abc');

    expect(res.status).toBe(401);
  });

  it('verifies the signature BEFORE any database work', async () => {
    const app = makeApp(loadRouter());
    const body = eventBody();

    await post(app, body, 'not-a-valid-signature');

    // The most important ordering property in the file: an unauthenticated
    // caller must not be able to make us open a connection or take a row lock.
    expect(global.db.connect).not.toHaveBeenCalled();
  });

  it('DEFECT (CRITICAL #2): a missing secret fails silently as 401 instead of at boot', async () => {
    const app = makeApp(loadRouter({ secret: undefined }));
    const body = eventBody();

    const res = await post(app, body, sign(body));

    // Correctly signed by the provider, yet rejected — because
    // `verifySignature` returns false when WEBHOOK_SECRET is falsy.
    // A misconfigured deploy therefore drops every webhook and surfaces
    // as a wall of 401s at runtime rather than a refusal to start.
    expect(res.status).toBe(401);
    // Desired behaviour: validate the env at startup and crash there,
    // so this test becomes `expect(loadRouter({secret: undefined})).toThrow()`.
  });

  it('DEFECT (SUGGESTION, security): a captured payload replays indefinitely', async () => {
    const app = makeApp(loadRouter());
    const body = eventBody();
    const signature = sign(body);

    const first = await post(app, body, signature);
    expect(first.status).toBe(200);

    // Same bytes, same signature, replayed an arbitrary time later.
    global.db = makeDb({ existingEvent: true, paymentRequest: { ...PAYMENT_REQUEST } });
    const replay = await post(app, body, signature);

    // Idempotency stops it being re-APPLIED, which is the important half.
    expect(replay.status).toBe(200);
    expect(replay.body.deduped).toBe(true);
    // But it still costs a connection, a transaction and a query every time.
    expect(global.db.connect).toHaveBeenCalled();
    // A signed timestamp with a freshness window would reject this at the
    // signature check, before any of that.
  });
});

// ------------------------------------------------------------
// 2. Payload validation
// ------------------------------------------------------------

describe('payload validation', () => {
  it('rejects malformed JSON with 400', async () => {
    const app = makeApp(loadRouter());
    const body = '{ not valid json';

    const res = await post(app, body, sign(body));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid payload' });
    expect(global.db.connect).not.toHaveBeenCalled();
  });

  it.each([
    ['event_id', { event_id: undefined }],
    ['provider_transaction_id', { provider_transaction_id: undefined }],
    ['status', { status: undefined }],
  ])('rejects a payload missing %s with 400', async (_field, overrides) => {
    const app = makeApp(loadRouter());
    const body = eventBody(overrides);

    const res = await post(app, body, sign(body));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
    expect(global.db.connect).not.toHaveBeenCalled();
  });

  it('DEFECT: an unrecognised status string is not validated against the enum', async () => {
    // `status` is only checked for presence, then fed to the transition
    // lookup. A typo or a provider-side rename lands in the "not allowed"
    // branch and is silently swallowed as applied:false — indistinguishable
    // from a legitimate out-of-order event, and never alerted on.
    const app = makeApp(loadRouter());
    const body = eventBody({ status: 'PIAD' });

    const res = await post(app, body, sign(body));

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
  });
});

// ------------------------------------------------------------
// 3. Idempotency
// ------------------------------------------------------------

describe('idempotency', () => {
  it('short-circuits a previously processed event without reapplying it', async () => {
    global.db = makeDb({ existingEvent: true, paymentRequest: { ...PAYMENT_REQUEST } });
    const app = makeApp(loadRouter());
    const body = eventBody();

    const res = await post(app, body, sign(body));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, deduped: true });
    expect(global.db.ran('UPDATE payment_requests')).toBe(false);
    expect(global.db.ran('INSERT INTO status_history')).toBe(false);
    expect(global.db.ran('INSERT INTO audit_trail')).toBe(false);
  });

  it('rolls back rather than commits on the dedup path', async () => {
    global.db = makeDb({ existingEvent: true, paymentRequest: { ...PAYMENT_REQUEST } });
    const app = makeApp(loadRouter());
    const body = eventBody();

    await post(app, body, sign(body));

    expect(global.db.ran('ROLLBACK')).toBe(true);
    expect(global.db.ran('COMMIT')).toBe(false);
    expect(global.db.client.release).toHaveBeenCalled();
  });

  it('records the event id so a redelivery is deduped next time', async () => {
    const app = makeApp(loadRouter());
    const body = eventBody();

    await post(app, body, sign(body));

    expect(global.db.ran('INSERT INTO processed_webhook_events')).toBe(true);
  });
});

// ------------------------------------------------------------
// 4. Unknown transaction
// ------------------------------------------------------------

describe('unknown transaction', () => {
  it('returns 200 so the provider stops retrying an unmatchable event', async () => {
    global.db = makeDb({ paymentRequest: null });
    const app = makeApp(loadRouter());
    const body = eventBody();

    const res = await post(app, body, sign(body));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, matched: false });
  });

  it('DEFECT (SUGGESTION #1): the unmatched event is never recorded, so retries repeat the work', async () => {
    global.db = makeDb({ paymentRequest: null });
    const app = makeApp(loadRouter());
    const body = eventBody();

    await post(app, body, sign(body));

    // We answer 200 to stop retries, but write no processed_webhook_events
    // row — so every redelivery pays for a connection, a transaction and two
    // queries again, indefinitely.
    expect(global.db.ran('INSERT INTO processed_webhook_events')).toBe(false);
    expect(global.db.ran('ROLLBACK')).toBe(true);
    // This branch also means "the provider has a transaction we've never
    // heard of" — a genuine data anomaly that warrants an alert, not a warn log.
    expect(global.logger.warn).toHaveBeenCalledWith(
      'webhook_unknown_transaction',
      expect.objectContaining({ providerTxId: PAYMENT_REQUEST.provider_transaction_id })
    );
  });
});

// ------------------------------------------------------------
// 5. Status transition state machine
// ------------------------------------------------------------

describe('status transitions', () => {
  it.each([
    ['PENDING', 'AUTHORIZED'],
    ['PENDING', 'PAID'],
    ['PENDING', 'FAILED'],
    ['AUTHORIZED', 'PAID'],
    ['AUTHORIZED', 'CANCELLED'],
    ['PAID', 'REFUNDED'],
  ])('applies the legal transition %s -> %s', async (from, to) => {
    global.db = makeDb({ paymentRequest: { ...PAYMENT_REQUEST, status: from } });
    const app = makeApp(loadRouter());
    const body = eventBody({ status: to });

    const res = await post(app, body, sign(body));

    expect(res.body).toEqual({ received: true, applied: true });
    const update = global.db.statements.find((s) => s.text.includes('UPDATE payment_requests'));
    expect(update.params).toEqual([to, PAYMENT_REQUEST.id]);
  });

  it.each([
    ['PAID', 'PENDING', 'a late event must never move a request backwards'],
    ['PAID', 'AUTHORIZED', 'settlement cannot regress to an authorization hold'],
    ['CANCELLED', 'PAID', 'a cancelled request must not be resurrected by a stale event'],
    ['REFUNDED', 'PAID', 'a refund is terminal'],
  ])('ignores the illegal transition %s -> %s (%s)', async (from, to) => {
    global.db = makeDb({ paymentRequest: { ...PAYMENT_REQUEST, status: from } });
    const app = makeApp(loadRouter());
    const body = eventBody({ status: to });

    const res = await post(app, body, sign(body));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, applied: false });
    expect(global.db.ran('UPDATE payment_requests')).toBe(false);
  });

  it('still records an ignored event so the provider stops redelivering it', async () => {
    global.db = makeDb({ paymentRequest: { ...PAYMENT_REQUEST, status: 'PAID' } });
    const app = makeApp(loadRouter());
    const body = eventBody({ status: 'PENDING' });

    await post(app, body, sign(body));

    expect(global.db.ran('INSERT INTO processed_webhook_events')).toBe(true);
    expect(global.db.ran('COMMIT')).toBe(true);
  });

  it('DEFECT: an ignored transition leaves no trace in status_history or audit_trail', async () => {
    global.db = makeDb({ paymentRequest: { ...PAYMENT_REQUEST, status: 'CANCELLED' } });
    const app = makeApp(loadRouter());
    const body = eventBody({ status: 'PAID' });

    await post(app, body, sign(body));

    // A provider telling us a CANCELLED request was PAID is exactly the
    // disagreement an investigator needs to see later. It is currently
    // visible only in an info-level log line.
    expect(global.db.ran('INSERT INTO audit_trail')).toBe(false);
  });
});

// ------------------------------------------------------------
// 6. Transaction integrity
// ------------------------------------------------------------

describe('transaction integrity', () => {
  it('writes the status, history, audit and dedup rows inside one transaction', async () => {
    const app = makeApp(loadRouter());
    const body = eventBody();

    await post(app, body, sign(body));

    const texts = global.db.statements.map((s) => s.text);
    expect(texts[0]).toBe('BEGIN');
    expect(texts[texts.length - 1]).toBe('COMMIT');

    const between = texts.slice(1, -1).join(' | ');
    expect(between).toContain('UPDATE payment_requests');
    expect(between).toContain('INSERT INTO status_history');
    expect(between).toContain('INSERT INTO audit_trail');
    expect(between).toContain('INSERT INTO processed_webhook_events');
  });

  it('locks the payment request row before reading its status', async () => {
    const app = makeApp(loadRouter());
    const body = eventBody();

    await post(app, body, sign(body));

    // Without FOR UPDATE, two concurrent deliveries could both read PENDING
    // and both pass the transition check.
    expect(global.db.ran('FROM payment_requests WHERE provider_transaction_id = $1 FOR UPDATE')).toBe(true);
  });

  it('records the correct from/to pair in status_history', async () => {
    global.db = makeDb({ paymentRequest: { ...PAYMENT_REQUEST, status: 'AUTHORIZED' } });
    const app = makeApp(loadRouter());
    const body = eventBody({ status: 'PAID' });

    await post(app, body, sign(body));

    const history = global.db.statements.find((s) => s.text.includes('INSERT INTO status_history'));
    expect(history.params).toEqual([PAYMENT_REQUEST.id, 'AUTHORIZED', 'PAID']);
  });

  it('rolls back and returns 500 when a write fails mid-transaction', async () => {
    global.db = makeDb({
      paymentRequest: { ...PAYMENT_REQUEST },
      throwOn: 'INSERT INTO status_history',
    });
    const app = makeApp(loadRouter());
    const body = eventBody();

    const res = await post(app, body, sign(body));

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error' });
    expect(global.db.ran('ROLLBACK')).toBe(true);
    expect(global.db.ran('COMMIT')).toBe(false);
    expect(global.db.client.release).toHaveBeenCalled();
  });

  it('returns 500 rather than 200 on failure, so the provider retries', async () => {
    // The retry is only safe because the dedup row is written in the same
    // transaction as the status change — a rollback removes both together,
    // leaving the redelivery free to apply cleanly.
    global.db = makeDb({ paymentRequest: { ...PAYMENT_REQUEST }, throwOn: 'UPDATE payment_requests' });
    const app = makeApp(loadRouter());
    const body = eventBody();

    const res = await post(app, body, sign(body));

    expect(res.status).toBe(500);
    expect(global.db.ran('INSERT INTO processed_webhook_events')).toBe(false);
  });

  it('never leaks internal error detail to the provider', async () => {
    global.db = makeDb({ paymentRequest: { ...PAYMENT_REQUEST }, throwOn: 'UPDATE payment_requests' });
    const app = makeApp(loadRouter());
    const body = eventBody();

    const res = await post(app, body, sign(body));

    expect(JSON.stringify(res.body)).not.toContain('simulated database failure');
    expect(global.logger.error).toHaveBeenCalledWith(
      'webhook_processing_failed',
      expect.objectContaining({ error: 'simulated database failure' })
    );
  });
});

// ------------------------------------------------------------
// 7. Failure modes that produce no response at all
// ------------------------------------------------------------

describe('unhandled failure modes', () => {
  it('DEFECT (CRITICAL #1): with no `db` in scope the request hangs instead of erroring', async () => {
    delete global.db;
    const app = makeApp(loadRouter());
    const body = eventBody();

    // `await db.connect()` sits OUTSIDE the try block, so the ReferenceError
    // rejects the async handler. Express 4 does not catch that, no response is
    // written, and the socket stays open until the client times out. In
    // production this is every request, from the first one, on a route the
    // provider will keep retrying.
    await expectNoResponse(post(app, body, sign(body)));
  });

  it('DEFECT: a failing ROLLBACK escapes the catch block and swallows the response', async () => {
    const db = makeDb({ paymentRequest: { ...PAYMENT_REQUEST }, throwOn: 'UPDATE payment_requests' });
    const originalQuery = db.client.query;
    db.client.query = jest.fn(async (sql, params) => {
      // The realistic case: the connection dropped, which is both why the
      // write failed and why the rollback cannot succeed either.
      if (squash(sql) === 'ROLLBACK') throw new Error('connection terminated');
      return originalQuery(sql, params);
    });
    global.db = db;

    const app = makeApp(loadRouter());
    const body = eventBody();

    // `await client.query('ROLLBACK')` is the first statement in the catch,
    // so its rejection replaces the 500 that was about to be sent.
    await expectNoResponse(post(app, body, sign(body)));
  });

  it('DEFECT (SUGGESTION #4): a JSON body parser breaks verification without failing closed', async () => {
    // The file documents its raw-body requirement in a comment only. If a
    // later refactor of app.js applies express.json() to this route, req.body
    // becomes an object, crypto.update() throws a TypeError outside the try,
    // and the endpoint stops responding entirely — rather than returning a
    // clean 401 that would at least be visible in monitoring.
    const app = makeApp(loadRouter(), { parser: express.json() });
    const body = eventBody();

    await expectNoResponse(post(app, body, sign(body)));
  });
});

// ------------------------------------------------------------
// 8. Observability
// ------------------------------------------------------------

describe('observability', () => {
  it('logs the applied transition with enough context to trace it', async () => {
    const app = makeApp(loadRouter());
    const body = eventBody();

    await post(app, body, sign(body));

    expect(global.logger.info).toHaveBeenCalledWith('webhook_applied', {
      eventId: 'evt_001',
      providerTxId: PAYMENT_REQUEST.provider_transaction_id,
      from: 'PENDING',
      to: 'PAID',
    });
  });

  it('never logs the signature or the shared secret', async () => {
    const app = makeApp(loadRouter());
    const body = eventBody();
    const signature = sign(body);

    await post(app, body, signature);
    await post(app, body, 'bad-signature');

    const logged = JSON.stringify([
      global.logger.info.mock.calls,
      global.logger.warn.mock.calls,
      global.logger.error.mock.calls,
    ]);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(signature);
  });
});
