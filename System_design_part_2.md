# Part 2 — System Design

*Payment Request module: high-level architecture, data model, and failure handling*

---

## 1. High-Level Architecture

In a payment system the money moves through a third party we don't control, so the architecture is built around one assumption: **our DB and the provider will drift, and the system must be able to re-converge on its own.**

```
                  ┌──────────────────────────┐
   Employee ────► │  React (Vite + TS)       │
   Customer ────► │  - Admin: payment reqs   │
                  │  - Public: payment page  │
                  └────────────┬─────────────┘
                               │ HTTPS / REST (JWT)
                               ▼
                  ┌──────────────────────────┐        ┌────────────────────┐
                  │  Node.js API (Express)   │◄──────►│      Redis         │
                  │  - Validation (Zod)      │        │  - Idempotency keys│
                  │  - AuthZ / RBAC          │        │  - Rate limiting   │
                  │  - Payment service       │        │  - Job queue       │
                  │  - Webhook receiver      │        │    (BullMQ)        │
                  └───┬──────────────┬───────┘        └────────────────────┘
                      │              │
                      │              │ create charge / void / status
                      │              ▼
                      │   ┌──────────────────────────┐
                      │   │  Payment Provider (PSP)  │
                      │   │  Tranzila / CG / Stripe  │
                      │   └────────────┬─────────────┘
                      │                │ Webhook (async, signed)
                      │                ▼
                      │   ┌──────────────────────────┐
                      │   │  POST /webhooks/psp      │
                      │   │  verify sig → enqueue    │
                      │   └────────────┬─────────────┘
                      ▼                ▼
       ┌──────────────────────────────────────────────┐
       │  PostgreSQL                                  │
       │  payment_requests / status_history /         │
       │  audit_trail / webhook_events                │
       └──────────────────────────────────────────────┘
                      ▲
                      │
       ┌──────────────┴───────────────┐
       │  Reconciliation Worker       │
       │  cron: poll PSP for stuck    │
       │  transactions (safety net)   │
       └──────────────────────────────┘
```

### Component responsibilities

| Component | Role |
|---|---|
| **React** | Two surfaces: internal admin (create / view / cancel requests) and a public payment page. Card data is entered into a **PSP-hosted iframe / SDK field** — never into our own React state. |
| **Node.js API** | Split deliberately, not one "payment service" blob: a `StatusTransitionService` owning the legal-transitions table, a `PspAdapter` interface with one implementation per provider (an aggregator is multi-acquirer by definition — see `provider_name`), and thin route handlers doing validation + RBAC only. Stateless → horizontally scalable behind a load balancer. |
| **PostgreSQL** | Source of truth for the *business* state. ACID transactions around every status change + its history row. |
| **Redis** | Idempotency key store (TTL 24h), rate limiting on the public payment page, and the BullMQ queue backing webhook processing + reconciliation retries. |
| **Payment Provider** | Source of truth for the *money*. Authorization, clearing, settlement. |
| **Webhook receiver** | Thin endpoint: verify HMAC signature → persist raw event → enqueue → return `200` fast. Zero business logic inline. Response codes are part of the contract: **`4xx` on a bad signature or unparseable body** (never retried — a forged event must not be replayed at us forever), **`5xx` only on a transient failure to persist/enqueue** (so the PSP *does* retry), **`200` the moment the event is durably stored** — before it is processed. |
| **Reconciliation worker** | Scheduled job that polls the PSP for any request stuck in a non-terminal state. This is what makes the webhook an *optimization* rather than a single point of failure. |

### Key flow — creating a charge

1. `POST /payment-requests` with an `Idempotency-Key` header → Redis `SET NX` on `hash(merchant_id + key + body)`, with the DB unique constraint as the durable fallback on a Redis miss. Same key + same body → the cached original response. Same key + different body → `409 Conflict`.
2. Row written as `PENDING` inside a DB transaction, together with its first `status_history` row.
3. Customer opens the payment link → PSP-hosted field tokenizes the card → our backend calls the PSP with the **token**, never the PAN.
4. Response is recorded optimistically; the **webhook** (or the reconciliation job) confirms the final state.

---

## 2. The `payment_request` Entity

### Core fields

| Field | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | Internal identifier. |
| `public_token` | UUID / random string | The value exposed in the customer-facing URL — never expose `id` (prevents enumeration / IDOR). |
| `merchant_id` | UUID (FK) | Tenant scope. Every query filters on this. |
| `amount_minor` | BIGINT | **Integer in agorot / cents.** Never a float — floating point rounding on money is a defect by construction. |
| `currency` | CHAR(3) | ISO-4217 (`ILS`, `USD`). |
| `status` | ENUM | `DRAFT / PENDING / AUTHORIZED / PAID / CANCELLED / REFUNDED / FAILED / EXPIRED / REQUIRES_MANUAL_REVIEW`. The last one is terminal *for automation only* — it means "the provider and we disagree, stop guessing, get a human." |
| `description` | TEXT | Shown to the customer. |
| `customer_name` / `customer_email` / `customer_phone` | TEXT | PII — see below. |
| `expires_at` | TIMESTAMPTZ | Payment links must expire. |
| `provider_name` | TEXT | Which PSP handled it (relevant for a multi-acquirer aggregator). |
| `provider_transaction_id` | TEXT | The PSP's reference — the join key for reconciliation. **Unique index.** |
| `idempotency_key` | TEXT | Stored as `hash(merchant_id + key + request_body)`, unique index. Scoping it to the body matters: the same key sent with a *different* amount is a client bug, and must return `409` rather than replaying the response of a different charge. The DB unique constraint is the durable backstop — Redis is a cache in front of it, and Redis can evict. |
| `card_token` | TEXT | PSP-issued token. |
| `card_last4` / `card_brand` / `card_exp_month` / `card_exp_year` | TEXT / INT | Enough to display "Visa ••••1234" without holding card data. |
| `installments` | INT | Israeli market: `tashlumim` is a first-class field, not an afterthought. |
| `created_by` / `cancelled_by` | UUID (FK users) | Accountability. |
| `created_at` / `updated_at` | TIMESTAMPTZ | |
| `version` | INT | Optimistic locking — blocks two concurrent cancels racing on the same row. |

### Sensitive fields — handling policy

- **Never stored, in any form:** full PAN, CVV, magnetic track data. Tokenized at the edge by the PSP's hosted field, so the raw card never enters our Node process → keeps us out of PCI-DSS **SAQ D** scope.
- **Stored encrypted at rest (`pgcrypto` / KMS-managed column encryption):** `customer_email`, `customer_phone`, national ID if ever collected.
- **Stored in the clear, deliberately:** `card_last4`, `card_brand`, `amount_minor` — non-sensitive by PCI definition, needed for support and display.
- **Secrets** (PSP API keys, webhook signing secrets) live in a secrets manager, never in `.env` committed to the repo, and are rotatable without a deploy.
- **Logging rule:** a redaction layer strips `card_token`, `Authorization`, and any `pan`-shaped string before anything reaches the log sink. Payment logs leak more card data than payment databases do.
- **Access:** RBAC on the API; PII columns exposed only to roles that need them, and every read of a full request is itself auditable.

### `status_history` — the state machine's ledger

Status is **never** overwritten in place without a corresponding history row, written in the *same* DB transaction.

| Field | Notes |
|---|---|
| `id` | PK |
| `payment_request_id` | FK |
| `from_status` / `to_status` | The transition itself |
| `reason` | e.g. `webhook_received`, `reconciliation_poll`, `manual_cancel`, `expired` |
| `actor_type` | `USER` / `SYSTEM` / `PROVIDER` |
| `actor_id` | User UUID, or null for system |
| `provider_raw_response` | JSONB — exactly what the PSP said, for disputes |
| `created_at` | TIMESTAMPTZ |

**Allowed transitions are enforced in code**, not just trusted:
`PENDING → AUTHORIZED → PAID`, `PENDING/AUTHORIZED → CANCELLED`, `PAID → REFUNDED`, `PENDING → EXPIRED/FAILED`. Anything else is rejected with a `409 Conflict`.

### `audit_trail` — the compliance ledger

Broader than status history: it records *every* meaningful action, including reads and failed attempts.

| Field | Notes |
|---|---|
| `id`, `created_at` | |
| `actor_id`, `actor_role` | Who |
| `action` | `PAYMENT_REQUEST_CREATED`, `CANCEL_ATTEMPTED`, `CANCEL_FAILED`, `PII_VIEWED`… |
| `entity_type` / `entity_id` | What |
| `before` / `after` | JSONB diff |
| `ip_address`, `user_agent`, `request_id` | Forensics + tracing correlation |
| `result` | `SUCCESS` / `DENIED` / `ERROR` |

**Append-only.** No `UPDATE`, no `DELETE` — enforced at the DB grant level, not by convention. Retention per regulatory requirement (7 years is the realistic Israeli baseline).

---

## 3. The Callback Never Arrived — Detection & Handling

This is the single most expensive failure mode in the module: the customer's card **was** charged, our DB still says `PENDING`. The merchant sees an unpaid request, the customer sees a debit, and support gets the call.

### Detection

- **Non-terminal state + age.** A reconciliation worker runs every 1–2 minutes and selects every request where `status IN ('PENDING','AUTHORIZED')` AND `updated_at < now() - interval '3 minutes'` AND `created_at > now() - interval '24 hours'`.
  - Note what the predicate deliberately does **not** include: `expires_at > now()`. A link charged 30 seconds before it expired, whose webhook was lost, is precisely the case this job exists to catch — filtering on link expiry would drop it. Expiry governs whether a customer may still *pay*; it has nothing to do with whether we owe them a reconciliation.
  - Indexing: a partial index on `(status, updated_at) WHERE status IN ('PENDING','AUTHORIZED')` — without it this is a sequential scan over the full table every 60 seconds, and it degrades as the table grows.
- **Provider status API is the authority.** For each such row, call the PSP's `GET /transactions/{id}` (or query by our `merchant_reference` when we never got a `provider_transaction_id` back).
- **Compare the amount, not just the status.** Converging on status alone hides a money discrepancy — a partial capture, an installment split, or a currency conversion can settle at a different figure than we requested. If the PSP reports `PAID` but `amount_minor` or `currency` differs from ours, the row goes to `REQUIRES_MANUAL_REVIEW`, never to `PAID`.
- **Escalating backoff.** Poll aggressively for the first ~15 minutes, then back off (1m → 5m → 15m → 1h) up to 24h. Prevents hammering the PSP over a genuinely abandoned link.
- **Alerting thresholds.** If the rate of reconciliation-resolved (vs. webhook-resolved) transactions crosses a threshold, page on-call — that pattern means the webhook endpoint itself is broken, not a one-off drop.
- **End-of-day settlement file — diffed in both directions.** Final safety net against the PSP's daily settlement report:
  - *In the report, not `PAID` here* → the missed-callback case above, caught even if the poller never resolved it.
  - *`PAID` here, not in the report* → the inverse and more dangerous case: a payment that was reversed, voided at the PSP, or charged back after we already told the merchant it was good. Automated polling never surfaces this, because our row already sits in a terminal state and the poller has stopped looking at it.

### Handling

- **Converge to the provider's truth** inside a single DB transaction: update `status`, write the `status_history` row with `reason = 'reconciliation_poll'` and `actor_type = 'SYSTEM'`, write the audit entry.
- **Then fire side effects** — receipt email, merchant notification — *after* commit, via the queue, so a failed email can never roll back a confirmed payment.
- **Distributed lock per request** (`Redis SET NX` on `lock:pr:{id}`) so a late webhook and the poller can't process the same transaction concurrently.
- **Idempotent state application**, not blind writes: applying `PAID` to a row already `PAID` is a no-op that returns success. This also makes duplicate webhook delivery a non-event.
- **Deduplicate by event id** — every webhook is persisted to `webhook_events` with a unique `provider_event_id` before processing; a replay hits the unique constraint and is discarded.
- **Ordering safety** — webhooks arrive out of order. Never regress a terminal status: a stale `AUTHORIZED` event landing after `PAID` is dropped, not applied.
- **When the PSP's status API is itself down**, the poller must not spin: a circuit breaker trips after N consecutive failures, jobs go to a dead-letter queue with their attempt count, and the breaker half-opens on a timer. Failing to reconcile is recoverable; hammering a degraded provider during an outage is not.
- **Unresolvable after 24h** → move to `REQUIRES_MANUAL_REVIEW`, exclude from automated retries, surface it in an ops dashboard. Never silently mark it `FAILED` — declaring a real charge "failed" is worse than admitting we don't know.
- **The customer-facing page** polls our own API (or holds an SSE connection) rather than trusting the PSP's redirect — the redirect can be lost to a closed tab, and closing a tab must not lose a payment.

### The rule underneath all of it

> The webhook is a **latency optimization**. The provider's status API is the **source of truth**. A system that is correct only when the webhook arrives is not correct.

---

## 4. How I'd Actually Deliver This

The design above is the target state. What I'd hold the team to is the sequencing — because the expensive mistake here is building the happy path in week one and treating reconciliation as a phase-two ticket.

### Sequencing

- **First:** the status model, `status_history`, and idempotency. These are schema decisions, and schema decisions are the ones you cannot cheaply reverse once real money has flowed through the table.
- **Alongside the happy path, not after it:** the reconciliation worker. If it ships late, the first lost webhook is discovered by a merchant, not by us — and by then it's a support escalation with a customer holding a bank statement.
- **Deliberately deferred:** multi-PSP adapters (build the interface, implement one), chargeback automation, the ops dashboard. All real, none of them blocking first revenue.

### What I'd insist on before it goes live

- A **runbook** for `REQUIRES_MANUAL_REVIEW`: who looks at the queue, how often, and what they're authorized to do about it. A state that nobody owns is just a slower way to lose the transaction.
- **Observability that answers one question:** what fraction of transactions were resolved by webhook vs. by reconciliation? That single ratio is the health metric for this whole module — a rising reconciliation share means the webhook path is silently degrading, well before anyone files a ticket.
- **A tested failure path.** Anyone can demo a successful charge. I want to see the demo where the webhook is dropped on purpose and the system heals itself.

### The trade-off

Polling every PSP costs money and API quota. The 1–2 minute interval is a starting position, not a principle — it should be tuned against real webhook reliability data once we have it, and I'd expect that number to change within the first month.
