# Payment Request Module — Requirements Analysis

*Fintech architecture and business logic perspective for a payment processing system*

---

## 1. Five Questions to Ask Before Development Begins

### Q1 — Business Logic & Transaction Lifecycle
**Question:** Should the cancel operation support both a pre-end-of-day authorization void and a post-clearing refund?

**Why it matters:** Cancelling before clearing doesn't actually move money — it just releases the authorization hold. Cancelling after clearing/settlement requires a full refund operation with the card processor, which is a more complex business flow.

### Q2 — Asynchronous Architecture & Data Consistency
**Question:** What SLA can we expect for payment-success webhooks from the payment processor, and how do we handle dependent transactions in the meantime?

**Why it matters:** In payment systems, webhooks can be lost or delayed. A reconciliation background job that actively polls the provider's API is essential to catch any payment status we may have missed — a miss that could hurt the merchant.

### Q3 — Reliability & Idempotency
**Question:** How do we prevent a double charge if a customer clicks the payment link twice, or a duplicate cancellation call to the provider's API?

**Why it matters:** Network requests can fail and be retried. Idempotency keys are required to guarantee that even if multiple identical requests are sent, the operation executes exactly once against the card processor. Two details worth settling up front: the key must be scoped to the request body (the same key with a different amount is a client bug — reject it with `409`, don't replay a different charge), and Redis is a cache in front of a **unique constraint in PostgreSQL**, not the system of record. Redis can evict a key; a duplicate charge is not recoverable.

### Q4 — Security & Regulatory Compliance
**Question:** How does the payment page transmit card details, and what data do we actually store in PostgreSQL?

**Why it matters:** To meet PCI-DSS requirements, raw card numbers must never be stored. The system must work exclusively with tokens representing the card. The scope question underneath it is commercial, not just technical: if the card is tokenized **at the edge** — a provider-hosted iframe or client SDK, so the PAN never enters our Node process — we stay in the lightest PCI scope. The moment card data touches our own backend, the compliance burden (and the audit cost) changes category.

### Q5 — Audit Trail & Authorization
**Question:** What permissions are required for an employee to cancel a transaction, and what data must be captured in the audit trail table?

**Why it matters:** In a payment processing system, statuses are never simply overwritten. We must always know who performed each status change (system or staff member), when, and retain a full status history for fraud investigation and auditing purposes. The audit table must be **append-only, enforced by database grants rather than by convention** — an audit log that the application is technically able to rewrite is not evidence. It should also capture *failed* and *denied* attempts, not only successful ones: an employee repeatedly trying to cancel transactions they aren't authorized to touch is exactly the signal the table exists to preserve.

---

## 2. Three Working Assumptions — Risks & Validation

### Assumption 1: Asynchronous communication with the payment provider (webhooks) will always work and update us in time.

- **Risk:** The network drops or the provider delays its response. The customer may actually be charged, but our system never receives the callback and continues showing an incorrect status ("awaiting payment") — creating a serious sync gap.
- **Validation:** Design a system capable of polling / running a background cron job that actively checks the provider's API for the real status of "stuck" transactions.

### Assumption 2: The call to cancel a transaction with the provider and the update to our own DB happen as a single atomic operation.

- **Risk:** The call to the payment provider succeeds and the transaction is cancelled, but a failure while saving to PostgreSQL leaves the transaction marked as "active" on our side (a data integrity gap).
- **Why the assumption is false by construction:** a database transaction **cannot** span an external network call. Holding a DB transaction open across an HTTP request to the provider doesn't buy atomicity — it just holds locks for the duration of someone else's latency, and a timeout still leaves the two systems disagreeing. There is no configuration that makes this atomic; there is only a choice about which way it fails.
- **Validation:** Pick one ordering and state it explicitly — I'd choose: **write the intent, commit, then call the provider.** The row moves to `CANCELLING` in a committed DB transaction, the provider call happens outside it with an idempotency key, and the result is applied in a second short transaction. If the process dies mid-flight, the row is sitting in `CANCELLING` and the same reconciliation worker that handles missing callbacks resolves it against the provider's status API. The alternative (call first, then write) fails in the worse direction: the money moves and we have no record that we tried.

### Assumption 3: Every payment request can be cancelled in the same way.

- **Risk:** Attempting to cancel a transaction already in "PAID" status that has been fully settled. A simple "Cancel" call to the card processor will fail once settlement has completed, requiring a refund mechanism instead.
- **Validation:** Add backend logic to check the transaction status (`if (paymentRequest.status === 'PAID')`) and return an error if cancellation isn't allowed in that state, or trigger the appropriate refund logic instead.

---

## 3. Acceptance Criteria — Cancel Payment Request (Given/When/Then)

**Given**
- An active payment request exists in the database (PostgreSQL) in a status that allows cancellation (e.g., prior to full clearing / authorization hold only).
- The employee has the required authorization to cancel payment requests.

**When**
- The employee selects the payment request and clicks the "Cancel" button.

**Then**
- The system sends a void request to the external payment provider, including an idempotency key to prevent duplicate processing.
- **And** upon confirmation from the payment provider, the system updates the request status to `CANCELLED` in PostgreSQL within an atomic database transaction.
- **And** the system writes a new record to the `audit_trail` table containing the employee's identity, the action performed, and the exact timestamp, for history and tracking purposes.
- **And** if a customer subsequently tries to access the payment link, they receive a message that the request has been cancelled.

**And — the failure paths** (acceptance criteria that only describe success aren't finished; in payments the negative paths are where the money is lost)

- **When** the provider call times out or returns an error → the request stays in `CANCELLING`, the employee sees "cancellation in progress" rather than a false success, and the reconciliation worker resolves the true state against the provider's status API. We never report a cancellation we haven't confirmed.
- **When** two employees click Cancel simultaneously → optimistic locking on the row `version` means the second one gets a `409`, and only one void request reaches the provider. Combined with the idempotency key, even a duplicate that does escape is a no-op at the provider.
- **When** the employee lacks authorization → the attempt is rejected **and still written to the audit trail** with `result = DENIED`. Denied attempts are audit evidence, not noise.
- **When** the request is already `PAID` and settled → cancellation is refused with an explicit error, and the UI offers the refund flow instead (see Assumption 3) rather than failing silently at the provider.