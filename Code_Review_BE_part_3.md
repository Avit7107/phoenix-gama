# Code Review — Cancel Payment Request Endpoint

```js
app.post('/api/payment-requests/:id/cancel', async (req,res)=>{
  const paymentRequest=await db.query(`SELECT * FROM payment_requests WHERE id='${req.params.id}'`);
  if(!paymentRequest){return res.status(404).send('Not found');}
  if(paymentRequest.status==='PAID'){return res.status(400).send('Already paid');}
  await paymentProvider.cancel(paymentRequest.provider_id);
  await db.query(`UPDATE payment_requests SET status='CANCELLED' WHERE id='${req.params.id}'`);
  res.send({success:true});
});
```

---

## 1. Five Critical Issues

### Issue 1 — SQL Injection
Both queries build SQL by directly interpolating `req.params.id` into the string (`WHERE id='${req.params.id}'`). Any user-controlled input reaching a query string like this is a classic SQL injection vector.

**Impact:** An attacker could read, modify, or delete arbitrary rows in the database — including other merchants' payment data — or even drop tables, depending on DB permissions. This is a critical, immediately exploitable vulnerability, not a theoretical one.

### Issue 2 — No Authentication or Authorization
There is no check confirming who is calling this endpoint, or whether they're allowed to cancel *this specific* payment request (e.g., whether it belongs to their merchant account).

**Impact:** Any caller who can guess or enumerate a payment request ID can cancel someone else's transaction — a direct authorization bypass (IDOR — Insecure Direct Object Reference) that could be used to sabotage a competitor's payment flow or disrupt a live sale.

### Issue 3 — No Idempotency Protection
The endpoint has no idempotency key and no check for whether a cancellation is already in progress. A double-click, a client retry, or a network timeout that causes the client to resend the request can trigger `paymentProvider.cancel()` multiple times concurrently for the same request.

**Impact:** Depending on how the provider's API behaves under duplicate calls, this can produce inconsistent state, duplicate provider-side cancellation errors that aren't handled gracefully, or a race where two concurrent requests both pass the `status === 'PAID'` check before either write completes.

### Issue 4 — Provider Call and DB Update Are Not Atomic, and There's No Error Handling
The call to `paymentProvider.cancel()` and the subsequent DB update are two independent steps with no transaction wrapping them and no try/catch around either. There's also no `async` error handler on the route, so a rejected promise (e.g., the provider call throwing) will trigger an unhandled promise rejection instead of a clean error response.

**Impact:** If the provider call succeeds but the DB update fails (network blip, DB down, process crash), the transaction is cancelled with the provider but still shows as active in our system — a serious data-integrity gap that can lead to confused customers, support tickets, and manual reconciliation. Meanwhile, any thrown error currently either crashes the process or hangs the request instead of returning a proper HTTP error.

### Issue 5 — Missing Input Validation and a Buggy Existence Check
`req.params.id` is used without validating that it's a well-formed identifier (e.g., a UUID). Separately, `db.query(...)` for a `SELECT` typically returns a result object (e.g., `{ rows: [...] }`) or an array of rows — not a single record. That object is **always truthy**, even when it contains zero rows, so `!paymentRequest` is always `false` and the 404 branch never fires at all.

**Impact:** Malformed IDs can cause unexpected DB errors surfaced directly to the client (info leakage) or unnecessary load. The broken existence check means requests for non-existent IDs will fall through to `paymentRequest.status`, throw a `TypeError` (`Cannot read property 'status' of undefined`), and crash the request instead of returning a clean 404 — and this is exactly the kind of bug that only shows up in production once someone hits a bad ID.

---

## 2. Reimplementation Approach

### Authorization
Add authentication middleware before this route so `req.user` is populated and verified. Never rely on possession of the ID as proof of authorization. There are two distinct checks here, and they deserve **different** responses:

- **Permission** — does this employee hold `payment_request:cancel` at all? Resolved in middleware, before any lookup, and answered with `403 Forbidden`. The caller already knows they're inside the tenant; telling them they lack a permission leaks nothing.
- **Tenancy** — does this request belong to their merchant? Enforced as `WHERE id = $1 AND merchant_id = $2` in the query itself, not as an `if` after the fetch, and answered with `404 Not Found` — the *same* response as a genuinely nonexistent ID. A `403` here would confirm the row exists and turn the endpoint into an enumeration oracle for a competitor's transaction IDs.

Pushing the tenant filter into the `WHERE` clause rather than checking it in application code also means the mistake can't be made once and then copy-pasted: a query that forgets it returns nothing rather than returning someone else's data.

### Validation
Validate `req.params.id` against the expected format (e.g., UUID regex or a schema validator like `zod`/`joi`) before it ever reaches a query, and reject malformed input with `400 Bad Request`. Validate any request body/idempotency header the same way. This closes off a whole class of injection and malformed-input bugs before they reach the database layer.

### Transactions — two short transactions, never one long one

The instinct is to wrap read → check → provider call → write in a single transaction. **That is the wrong shape, and it's worth being explicit about why**, because it's the most common way this endpoint gets built badly:

- A database transaction **cannot** span an external network call. Keeping the provider call inside `BEGIN…COMMIT` doesn't buy atomicity — a timeout still leaves the two systems disagreeing.
- It holds a `FOR UPDATE` row lock for the full duration of someone else's HTTP latency. When the provider degrades from 200ms to 20s, every connection in the pool is parked on a lock and the whole API stops serving, not just cancellations.

The correct shape is **two short transactions with the provider call in between**:

1. **Transaction 1 — claim the intent.** Lock the row, re-check the status, move it to an intermediate `CANCELLING` state, write `status_history` + `audit_trail`, commit. The lock is released in milliseconds.
2. **Outside any transaction — call the provider**, with an idempotency key, a timeout, and a retry policy.
3. **Transaction 2 — apply the outcome.** On success → `CANCELLED`. On a definitive provider rejection → back to the original status with the failure recorded.

The payoff is in the crash case: if the process dies at step 2, the row is sitting in `CANCELLING` and the reconciliation worker resolves it against the provider's status API — the same worker that handles missing webhooks. A row stuck mid-flight is recoverable state, not lost state.

### Separation of concerns
The handler should not contain any of this. The route does authentication, schema validation, and response mapping; a `cancelPaymentRequest` service owns the orchestration; a `StatusTransitionService` owns which transitions are legal; a `PspAdapter` interface owns the provider call so a second acquirer is a new implementation rather than a new branch. A 60-line route handler that talks to Redis, Postgres, and a third party is untestable in practice — you end up mocking the world to test a status check.

### Idempotency
Require an `Idempotency-Key` header, scope it to the merchant, and — critically — **reserve it with `SET NX` *before* the provider call, not after the commit**. Caching only the final result leaves the race wide open: two concurrent requests both miss the cache, and the second one, once it acquires the row lock, sees status `CANCELLED` and returns a `400` instead of the original success. Reserving up front means the loser of the race is identified immediately and either waits or replays the stored response. Redis is the fast path; a unique constraint on `(merchant_id, idempotency_key)` in Postgres is the durable backstop, since Redis can evict.

### Logging
Log a structured entry at each significant step: request received (with actor and payment_request_id, never full card data), provider call initiated, provider call result, DB update result, and any error with full context (but redacting sensitive fields). Every status change writes **both** a `status_history` row (the state machine's ledger: `from_status`, `to_status`, `actor_type`, `reason`) and an `audit_trail` row (the compliance ledger: who, from where, and the result — including `DENIED` and `FAILED` attempts), in the same transaction as the change itself.

### Error Handling
Use an async-error-catching wrapper so a rejected promise can never become an unhandled rejection, and map failure modes to distinct responses: `400` invalid input, `403` caller lacks the cancel permission, `404` not found *or* belonging to another merchant (deliberately indistinguishable — a `403` here confirms the ID exists and hands an attacker an enumeration oracle), `409` invalid state or concurrent modification, `502`/`504` provider unreachable or timed out. Two rules that are easy to get wrong:

- **Don't blanket-map everything to `502`.** A `502` tells the client the upstream failed and a retry is safe. If the commit actually succeeded and something *after* it threw, that retry is actively harmful.
- **The rollback itself can throw.** On a dropped connection `ROLLBACK` fails, the throw escapes the `catch`, no response is ever sent, and the request hangs until the client times out. Wrap it in its own try/catch — or use a `withTransaction` helper that owns begin/commit/rollback/release so no handler has to remember.

Never leak raw DB or provider error messages to the client; log the detail internally and return a generic, safe message externally.

### Reimplemented Sketch

**The route** — thin by design: validate, delegate, map the response.

```js
app.post(
  '/api/payment-requests/:id/cancel',
  authenticate,
  authorize('payment_request:cancel'),        // 403 lives here, before any lookup
  validate({ params: z.object({ id: z.string().uuid() }) }),
  requireHeader('Idempotency-Key'),
  asyncHandler(async (req, res) => {          // no unhandled rejections, ever
    const { status, body } = await cancelPaymentRequest({
      paymentRequestId: req.params.id,
      actor: { id: req.user.id, merchantId: req.user.merchantId, ip: req.ip },
      idempotencyKey: req.header('Idempotency-Key'),
    });
    return res.status(status).json(body);
  })
);
```

**The service** — owns the orchestration, and nothing else does.

```js
const CANCELLABLE = new Set(['PENDING', 'AUTHORIZED']);

async function cancelPaymentRequest({ paymentRequestId, actor, idempotencyKey }) {
  const key = `cancel:${actor.merchantId}:${idempotencyKey}`;

  // ── 0. Reserve the idempotency key BEFORE any side effect ──────────────
  // SET NX is the reservation. A concurrent duplicate loses the race here,
  // not later at the row lock — which is what makes retries safe.
  const won = await redis.set(key, JSON.stringify({ state: 'IN_PROGRESS' }), 'NX', 'EX', 86400);
  if (!won) {
    const prior = JSON.parse(await redis.get(key));
    return prior.state === 'IN_PROGRESS'
      ? { status: 409, body: { error: 'Cancellation already in progress' } }
      : prior.result;                          // replay the original response
  }

  let paymentRequest;
  try {
    // ── 1. TRANSACTION ONE — claim the intent, then get out ──────────────
    // Lock held for milliseconds. Nothing external happens inside here.
    const claim = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `SELECT * FROM payment_requests
          WHERE id = $1 AND merchant_id = $2
          FOR UPDATE`,
        [paymentRequestId, actor.merchantId]
      );
      const pr = rows[0];

      // Scoped by merchant_id in the WHERE clause: another merchant's request
      // is indistinguishable from a nonexistent one. A 403 here would confirm
      // the ID exists and hand an attacker an enumeration oracle.
      if (!pr) return { error: { status: 404, body: { error: 'Not found' } } };

      if (!CANCELLABLE.has(pr.status)) {
        await writeAudit(tx, { actor, action: 'CANCEL_ATTEMPTED', entityId: pr.id, result: 'DENIED' });
        return {
          error: {
            status: 409,
            body: {
              error: `Cannot cancel a request in status ${pr.status}`,
              ...(pr.status === 'PAID' && { hint: 'Settled requests require a refund, not a void.' }),
            },
          },
        };
      }

      // Writes payment_requests.status, status_history, and audit_trail
      // in this one transaction — the three are never allowed to diverge.
      await transitionTo(tx, pr, 'CANCELLING', { actor, reason: 'manual_cancel' });
      return { paymentRequest: pr };
    });

    if (claim.error) {
      await redis.set(key, JSON.stringify({ state: 'DONE', result: claim.error }), 'EX', 86400);
      return claim.error;
    }
    paymentRequest = claim.paymentRequest;

    // ── 2. Provider call — OUTSIDE any transaction, no locks held ────────
    await pspAdapter.void(paymentRequest.provider_transaction_id, {
      idempotencyKey,
      timeoutMs: 10_000,
    });

    // ── 3. TRANSACTION TWO — apply the confirmed outcome ─────────────────
    const result = await withTransaction(async (tx) => {
      await transitionTo(tx, paymentRequest, 'CANCELLED', { actor, reason: 'provider_confirmed' });
      return { status: 200, body: { success: true, status: 'CANCELLED' } };
    });

    await redis.set(key, JSON.stringify({ state: 'DONE', result }), 'EX', 86400);
    return result;

  } catch (err) {
    logger.error('cancel_payment_request_failed', {
      paymentRequestId, actorId: actor.id, error: err.message,
    });

    // The row stays in CANCELLING on purpose. We do NOT guess the outcome:
    // a timeout means "unknown", and the reconciliation worker — the same one
    // that handles missing webhooks — resolves it against the provider's
    // status API. Rolling back to PENDING here would be a lie if the void
    // actually succeeded.
    if (isDefinitiveRejection(err)) {
      await withTransaction((tx) =>
        transitionTo(tx, paymentRequest, paymentRequest.status, { actor, reason: 'provider_rejected' })
      );
    }

    // Release the key so a deliberate retry is possible; do not cache failures.
    await redis.del(key);

    const status = isProviderTimeout(err) ? 504 : isProviderError(err) ? 502 : 500;
    return { status, body: { error: 'Unable to process cancellation' } };
  }
}
```

> `withTransaction` owns `BEGIN` / `COMMIT` / `ROLLBACK` / `release`, with the rollback itself guarded — on a dropped connection a bare `await client.query('ROLLBACK')` in a `catch` block throws, escapes, and the request hangs with no response ever sent. Centralizing it means no handler has to remember.

---

## 3. Tests Required Before Production

1. **SQL injection attempt is safely rejected.** Send a malicious value as `:id` (e.g., `1'; DROP TABLE payment_requests;--`) and assert it returns a clean `400`/`404` with no DB error leaked and no side effect on the table.

2. **Cross-tenant cancellation is blocked, and indistinguishably so.** Authenticate as merchant A and attempt to cancel a payment request belonging to merchant B; assert the response is `404` — byte-identical to the response for a random nonexistent UUID — that the status is unchanged, and that no provider call was made. Asserting the two responses match is the point: a `403` here would confirm the row exists. Separately, assert that an employee *within* the correct merchant but lacking `payment_request:cancel` gets `403`, and that both attempts land in `audit_trail` with `result = DENIED`.

3. **Duplicate requests with the same idempotency key produce exactly one provider call.** Fire two concurrent requests with the same `Idempotency-Key`; assert `pspAdapter.void()` is invoked exactly once, and that the loser gets either `409 already in progress` or a byte-identical replay of the winner's response — **never** a `409 Cannot cancel a request in status CANCELLED`. That specific wrong answer is the signature of an idempotency key that's cached after the fact instead of reserved before it, so it's worth asserting on explicitly.

4. **A provider timeout leaves the request recoverable, not wrong.** Mock `pspAdapter.void()` to hang past the timeout; assert the row is left in `CANCELLING` (not rolled back to `PENDING`, and not advanced to `CANCELLED`), the response is `504`, and the reconciliation worker subsequently resolves it against a mocked provider status API. Rolling back on a timeout is the tempting behaviour and the wrong one — a timeout means *unknown*, and the void may well have succeeded.

5. **Already-settled or already-cancelled requests cannot be re-cancelled.** Attempt to cancel a request in `PAID` and in `CANCELLED`; assert both return `409` with no provider call and no status change — and that the `PAID` attempt still writes an `audit_trail` row with `result = DENIED`, since a rejected cancellation of a settled transaction is exactly the event an auditor wants to see.

6. **Every status change writes its history and audit rows atomically.** Force a failure in the `status_history` insert and assert the `payment_requests` update rolls back with it. A status that advanced without a corresponding history row is unfalsifiable after the fact — the test exists to prove the two can never diverge.

7. **The row lock is not held across the provider call.** Instrument `pspAdapter.void()` with a 2-second delay, then issue a plain `GET` for the same payment request while the cancel is in flight; assert it returns immediately rather than blocking. This is the regression test for the single most expensive version of this bug — a slow provider taking down the whole API through pool exhaustion, not just cancellations.