# Part — AI-Assisted Development: Review & Team Policy

---

## 2. Code Review of `webhook_handler.js`

*(Reviewed using the `/engineering:code-review` skill — security, performance, correctness, and maintainability lens.)*

## Code Review: webhook_handler.js (AI-generated payment webhook handler)

### Summary
The handler correctly implements the core hard parts of a webhook endpoint — signature verification, idempotency, atomic DB writes, and a status state machine — which is genuinely difficult to get right and often skipped. However, it ships with real runtime bugs and a few gaps that mean it is **not mergeable as-is**, despite the design being sound.

### Critical Issues

| # | File | Line | Issue | Severity |
|---|------|------|-------|----------|
| 1 | webhook_handler.js | throughout | `db` and `logger` are used but never imported/required anywhere in the file. As written, this throws a `ReferenceError` on the very first request. | 🔴 Critical |
| 2 | webhook_handler.js | top of file | `WEBHOOK_SECRET` is read from `process.env` with no startup validation. If it's missing/misconfigured, `verifySignature` silently returns `false` for every request, and the failure only surfaces at runtime as a wall of `401`s — not at boot, where it should be caught immediately. | 🔴 Critical |
| 3 | webhook_handler.js | signature check | The signature check has no timestamp/freshness component. A captured, validly-signed payload can be replayed at any point in the future. Idempotency prevents it from being *reapplied*, but the endpoint will still do a full DB round trip processing it every time — this should be rejected outright as stale. | 🟠 Suggestion (Security) |

### Suggestions

| # | File | Line | Suggestion | Category |
|---|------|------|------------|----------|
| 1 | webhook_handler.js | "unknown transaction" branch | No `processed_webhook_events` record is written when the transaction isn't found, so the provider's retries of the same unmatched event repeat the full DB query indefinitely. Also, this case (a webhook for a transaction we have no record of) is exactly the kind of anomaly that should trigger an alert, not just an info-level log — it likely indicates a real data problem. | Correctness / Observability |
| 2 | webhook_handler.js | whole handler | No metrics are emitted (applied / deduped / rejected / failed counts). In production this is the primary signal for whether webhook processing is healthy — logs alone aren't enough for alerting or dashboards. | Maintainability |
| 3 | webhook_handler.js | whole file | No accompanying test file. Given the number of branches (invalid signature, invalid JSON, missing fields, dedup hit, unknown transaction, disallowed transition, happy path, DB failure), this needs unit tests before it can be trusted, especially since it's exactly the kind of code where a subtle bug fails silently in production. | Maintainability |
| 4 | webhook_handler.js | route registration comment | The correctness of signature verification depends entirely on the route being mounted with a raw-body parser (`express.raw`) rather than the app's default JSON body parser. That's documented only in a comment — it should be enforced/tested, since a future refactor of `app.js` could silently break signature verification without this file changing at all. | Correctness |

### What Looks Good
- Signature verification happens **before** the payload is parsed or trusted, using a timing-safe comparison — this is a detail that's frequently gotten wrong even by experienced engineers.
- Idempotency is handled at the *event* level (`event_id`) rather than assuming the caller won't retry, and it's implemented via a real DB record inside the same transaction as the status update — not a fragile in-memory cache.
- The explicit `ALLOWED_TRANSITIONS` state machine is exactly the right instinct: it prevents an out-of-order or duplicate event from ever moving a payment request backwards, which is one of the most common real-world sources of payment-status bugs.
- The handler responds `200` fast on the success and no-op paths, and only returns `500` (triggering a provider retry) on genuine internal failures — showing real awareness of provider retry semantics.
- Errors are logged with context but never expose internals in the HTTP response.

### Verdict
**Request Changes.** The architecture and security instincts are correct and are the hard part to get right — but issues #1 and #2 mean the code as submitted cannot run at all, which is a strong signal that whoever submitted this PR did not actually run it before opening it. That gap, more than the bugs themselves, is what needs to be addressed before this is approved (see the PR-handling discussion below).

---

## 3. Handling a PR That's Mostly AI-Written and the Author Can't Explain

### How I'd Handle This Specific PR
I wouldn't reject the PR purely because AI was involved — plenty of good code is AI-assisted now, and the review above shows this particular output has real value in it. The problem isn't the tool; it's that the author can't explain their own submission, which means **no one on the team currently understands the change well enough to safely own it, debug it at 2am, or maintain it**. I would not approve it in that state, regardless of how clean it looks.

### The Conversation I'd Have
- Keep it non-punitive and specific: "I want to merge this, but I need you to be able to walk me through it first — not because I don't trust the code, but because if this breaks in production, I need to know you (not just the AI) can fix it."
- Walk the PR line by line together, having them explain the reasoning — not just what each line does, but *why* this approach (e.g., "why is idempotency checked before the transaction row lookup?"). This distinguishes "doesn't understand it at all" from "can explain it but used AI to move faster," which are very different situations.
- If gaps surface, treat it as a learning moment, not a discipline issue: pair on rewriting the parts they can't explain, using AI as an assist rather than a source of unreviewed answers.
- Directly probe the two failed imports and the missing env-var validation found in review: "Did you run this locally before opening the PR?" This is really the core issue — not that AI was used, but that basic verification (run it, test it) was skipped.

### Team Policy Going Forward
- **AI-assisted code is fine; unreviewed AI code is not.** The standard for every PR is the same regardless of authorship: the submitting engineer must be able to explain any line if asked, and must have actually run/tested it locally before opening the PR.
- **No "vibe-approved" merges.** A PR description should note where AI was used significantly (e.g., "webhook handler scaffolded with AI assistance, reviewed and modified by me") — not as a confession, but so reviewers know where to focus extra scrutiny, the same way we'd flag "ported from a Stack Overflow answer" or "adapted from another service."
- **Tests are non-negotiable, especially for AI-generated code.** AI-written code tends to look confident and complete while hiding missing imports, unhandled edge cases, or subtly wrong logic (as seen in this very review) — tests are the actual proof the code works, not how polished it reads.
- **The reviewer's bar doesn't change.** Reviewers should not give AI-authored PRs an easier pass because the code "looks clean" — if anything, apply slightly more scrutiny, since AI output can be syntactically confident and still wrong in ways a rushed human reviewer might not catch.
- **Escalate patterns, not incidents.** A single instance like this is a coaching conversation. If it recurs — repeated PRs the author can't explain — that becomes a performance conversation about engineering practice, not an AI-usage policy violation.