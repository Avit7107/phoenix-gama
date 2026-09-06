/**
 * ============================================================
 * AI-ASSISTED IMPLEMENTATION LOG
 * ============================================================
 *
 * PROMPT USED:
 * "Write a Node.js/Express webhook handler for a payment provider
 *  callback at POST /webhooks/payments. It must: verify the
 *  provider's HMAC signature before trusting the payload, be
 *  idempotent against duplicate/replayed deliveries, update the
 *  matching payment_request row's status inside a DB transaction,
 *  write an audit_trail row, and always return quickly (respond
 *  200 fast, do heavier work async) since providers retry on
 *  timeout. Include structured logging and safe error handling
 *  that never leaks internals in the response."
 *
 * GIST OF THE AI'S ANSWER:
 * - Verify the raw request body against the `X-Signature` header
 *   using HMAC-SHA256 with a shared secret, using a timing-safe
 *   comparison, before parsing/trusting any field in the payload.
 * - Use the provider's `event_id` as an idempotency key: check a
 *   `processed_webhook_events` table first; if already present,
 *   short-circuit and return 200 immediately without reprocessing.
 * - Wrap the status update + audit_trail insert + idempotency-key
 *   insert in a single DB transaction so partial writes can't occur.
 * - Only allow specific status transitions (a small state machine)
 *   so an out-of-order or duplicate event can never move a request
 *   backwards (e.g., CANCELLED -> PAID).
 * - Log structured events at each stage (received, verified,
 *   applied, skipped, failed) without ever logging card data or
 *   the raw signature secret.
 * - Respond 200 as soon as the DB transaction commits; anything
 *   provider-side that's slow (e.g., notifying downstream systems)
 *   is offloaded to a queue rather than done inline.
 *
 * NOTE: this file is the literal output described above. It is
 * reviewed critically in `code_review_and_ai_pr_policy.md` in this
 * same delivery — do not treat "AI wrote it" as "already approved."
 * ============================================================
 */

const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const WEBHOOK_SECRET = process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET;

// Allowed status transitions — prevents an out-of-order/duplicate
// event from moving a request backwards.
const ALLOWED_TRANSITIONS = {
  PENDING: ['AUTHORIZED', 'PAID', 'FAILED', 'EXPIRED'],
  AUTHORIZED: ['PAID', 'CANCELLED', 'FAILED'],
  PAID: ['REFUNDED'],
};

function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || !WEBHOOK_SECRET) return false;

  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Expects the app to be configured with a raw-body parser for this
 * route specifically, e.g.:
 *   app.use('/webhooks/payments', express.raw({ type: 'application/json' }));
 * so `req.body` here is a Buffer, not pre-parsed JSON — required for
 * signature verification to be correct.
 */
router.post('/webhooks/payments', async (req, res) => {
  const rawBody = req.body; // Buffer
  const signature = req.header('X-Signature');

  if (!verifySignature(rawBody, signature)) {
    logger.warn('webhook_signature_invalid', { ip: req.ip });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.warn('webhook_payload_invalid_json', { ip: req.ip });
    return res.status(400).json({ error: 'Invalid payload' });
  }

  const { event_id: eventId, provider_transaction_id: providerTxId, status: newStatus } = event;

  if (!eventId || !providerTxId || !newStatus) {
    logger.warn('webhook_payload_missing_fields', { eventId });
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Idempotency: has this exact provider event already been applied?
    const existing = await client.query(
      'SELECT 1 FROM processed_webhook_events WHERE event_id = $1',
      [eventId]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      logger.info('webhook_event_already_processed', { eventId });
      return res.status(200).json({ received: true, deduped: true });
    }

    const { rows } = await client.query(
      'SELECT * FROM payment_requests WHERE provider_transaction_id = $1 FOR UPDATE',
      [providerTxId]
    );
    const paymentRequest = rows[0];

    if (!paymentRequest) {
      await client.query('ROLLBACK');
      logger.warn('webhook_unknown_transaction', { providerTxId, eventId });
      // Still 200 — this is a provider/us data issue, not something
      // we want the provider to keep retrying forever.
      return res.status(200).json({ received: true, matched: false });
    }

    const allowedNext = ALLOWED_TRANSITIONS[paymentRequest.status] || [];
    if (!allowedNext.includes(newStatus)) {
      await client.query(
        'INSERT INTO processed_webhook_events (event_id, received_at) VALUES ($1, now())',
        [eventId]
      );
      await client.query('COMMIT');
      logger.info('webhook_transition_ignored', {
        eventId,
        providerTxId,
        from: paymentRequest.status,
        to: newStatus,
      });
      return res.status(200).json({ received: true, applied: false });
    }

    await client.query(
      'UPDATE payment_requests SET status = $1, updated_at = now() WHERE id = $2',
      [newStatus, paymentRequest.id]
    );

    await client.query(
      `INSERT INTO status_history (payment_request_id, from_status, to_status, changed_at, trigger)
       VALUES ($1, $2, $3, now(), 'WEBHOOK')`,
      [paymentRequest.id, paymentRequest.status, newStatus]
    );

    await client.query(
      `INSERT INTO audit_trail (payment_request_id, actor_type, actor_id, action, previous_value, new_value, timestamp)
       VALUES ($1, 'SYSTEM', 'webhook', 'STATUS_UPDATED', $2, $3, now())`,
      [paymentRequest.id, paymentRequest.status, newStatus]
    );

    await client.query(
      'INSERT INTO processed_webhook_events (event_id, received_at) VALUES ($1, now())',
      [eventId]
    );

    await client.query('COMMIT');

    logger.info('webhook_applied', {
      eventId,
      providerTxId,
      from: paymentRequest.status,
      to: newStatus,
    });

    return res.status(200).json({ received: true, applied: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('webhook_processing_failed', {
      eventId,
      error: err.message,
    });
    // 500 so the provider retries — safe because the handler is idempotent.
    return res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

module.exports = router;