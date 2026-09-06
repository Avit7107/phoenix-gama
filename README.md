# Phoenix Gama — Development Manager Assessment

Written answers for the Phoenix Gama  technical assessment, covering a **Payment Request module**: requirements analysis, system design, backend and frontend code review, AI-assisted development policy, and leadership scenarios.

The running scenario throughout is a payment request that a merchant creates, a customer pays via a hosted link, and an employee can cancel — deliberately chosen because it touches authorization, clearing, and settlement, and because cancellation is where the interesting failure modes live.

---

## Contents

| # | Document | What it covers |
|---|---|---|
| 1 | [Requirements Analysis](Requirements_analysis_part_1.md) | Five questions to ask before development starts, three working assumptions with their risks, and Given/When/Then acceptance criteria for cancelling a payment request — including the failure paths. |
| 2 | [System Design](System_design_part_2.md) | High-level architecture (React / Node / PostgreSQL / Redis / PSP / webhooks), the `payment_request` entity with its sensitive-field policy, `status_history` and `audit_trail`, and how the system detects a charge whose callback never arrived. |
| 3 | [Code Review — Backend](Code_Review_BE_part_3.md) | Review of a vulnerable cancel endpoint (SQL injection, missing authorization, no idempotency), plus a reimplementation using two short transactions with the provider call in between. |
| 4 | [Code Review — Frontend](Code_Review_FE_part_4.md) | Review of a `PaymentRequests` component (infinite render loop, no error/loading states, race conditions), a production component architecture, and a polling vs. SSE vs. WebSockets decision. |
| 5 | [AI-Assisted Development](AI_Assisted_Development_part_5.md) | Review of an AI-generated webhook handler ([`webhook_part_5.js`](webhook_part_5.js)), how to handle a PR whose author can't explain it, and a team policy for AI-assisted code. |
| 6 | [Leadership Scenarios](Leadership_part_6.md) | A performance drop in a previously strong developer (spec-first / TDD improvement plan), two seniors deadlocked on architecture, and a two-week deadline against a four-week estimate. |
| 7 | [Communication](Communication_part_7.md) | A status update to a PM about stale payment statuses — known, unknown, action plan, time estimate. |

`webhook_part_5.js` is the artifact under review in Part 5, kept in the repo with its original prompt and the reviewer's annotations so the AI output and the critique of it can be read side by side.

---
Rather than answering each question in isolation, a few positions recur and are worth stating once:

- **The webhook is a latency optimization, not the source of truth.** The provider's status API is. A reconciliation worker polling for stuck transactions appears in Parts 1, 2, 3 and 5 — it is the single piece of infrastructure that makes every other async path safe, so it is treated as core rather than as hardening to add later.

- **A database transaction cannot span an external network call.** This shows up as a *stated assumption to be challenged* in Part 1 and as a concrete two-transaction implementation in Part 3: claim the intent and commit, call the provider outside any transaction, apply the outcome in a second short transaction. Holding a row lock across a third-party HTTP call doesn't buy atomicity — it just converts provider latency into connection-pool exhaustion.

- **Idempotency keys must be reserved before the side effect, not cached after it.** Caching the result after a successful commit leaves the race entirely open. Part 3 walks through the specific wrong response this produces, because it's the detail that distinguishes real idempotency from the appearance of it.

- **A timeout means *unknown*, never *failed*.** Neither optimistic success nor rollback is honest when a provider call times out. The request stays in an intermediate state and reconciliation resolves it. Marking a possibly-real charge as failed is worse than admitting the system doesn't yet know.

- **Status history and audit trail are two different tables with two different jobs.** One is the state machine's ledger (what moved, from what, to what, why); the other is the compliance ledger (who acted, from where, and what happened — including denied and failed attempts). Both are written in the same transaction as the change itself; the audit table is append-only, enforced by database grants rather than by convention.

- **Card data is tokenized at the edge.** A PSP-hosted field or client SDK means the PAN never enters the Node process, which is a PCI scope decision with commercial consequences, not only a technical one.

---

## A note on revisions

These documents were reviewed and revised after first drafting; several sections changed materially rather than cosmetically. The most substantive correction was in Part 3, where the original reimplementation placed the payment provider call inside the database transaction — directly contradicting the prose above it. That correction then propagated back into Part 1's assumptions and forward into Part 3's test list.

The revision history is in git, and the corrected reasoning is stated inline in each document rather than quietly patched, since in a payments system *why* a design was rejected is usually more useful than the design that replaced it.
