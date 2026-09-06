# Code Review — PaymentRequests Component

```jsx
function PaymentRequests(){
  const [requests,setRequests]=useState([]);
  useEffect(()=>{
    fetch('/api/payment-requests').then(r=>r.json()).then(setRequests);
  });
  return <>{requests.map(r=><div key={r.id}>{r.customerName}</div>)}</>;
}
```

---

## 1. Issues & Improvements

### Issue 1 — Missing Dependency Array: Infinite Render Loop
`useEffect` has no dependency array, so it runs after **every** render. Since it calls `setRequests`, each fetch completion triggers a re-render, which re-runs the effect, which fetches again — an infinite loop of network requests.

**Fix:** Add `[]` as the dependency array so the fetch runs once on mount (or key it to whatever should actually trigger a refetch, e.g., a filter or page number).

**One caveat worth stating before someone raises it:** under React 18 StrictMode the effect is deliberately double-invoked in development, so even with `[]` you'll see two fetches locally. That's not the bug returning — it's React surfacing whether the effect is safe to run twice. An effect that's properly cleaned up (see Issue 4) survives it; one that isn't, doesn't. It's a diagnostic, not a defect.

### Issue 2 — No Error Handling
There's no `.catch()`, no check on `r.ok`, and no handling of a non-2xx response or a network failure. A failed request silently leaves the UI showing an empty (or stale) list with no indication anything went wrong.

**Fix:** Check `response.ok`, throw/handle non-success statuses explicitly, and surface a visible error state to the user.

### Issue 3 — No Loading or Empty State
The component renders an empty fragment while data is loading and gives no visual distinction between "still loading" and "loaded, zero results." Users have no feedback that anything is happening.

**Fix:** Track a loading flag (or use a data-fetching library's built-in status) and render explicit loading/empty/error UI states.

### Issue 4 — No Request Cancellation on Unmount (Race Conditions)
If the component unmounts before the fetch resolves (e.g., the user navigates away), `setRequests` is still called on an unmounted component. If the effect ever re-runs with changing parameters, overlapping in-flight requests can also resolve out of order and overwrite newer data with a stale response.

**Fix:** Use an `AbortController`, cancel it in the effect's cleanup function, and ignore results from stale requests.

### Issue 5 — Data Fetching Logic Is Hard-Coded Into the Component
The `fetch` call, URL, and response parsing are inlined directly in the component. This makes the component hard to test (you can't easily mock the data layer), hard to reuse, and gives no place to add caching, retries, or shared error handling across the app.

**Fix:** Extract data fetching into a dedicated hook/service (or a data-fetching library — see below) so the component only consumes data, loading, and error state.

### Issue 6 — No Pagination or Limits
The endpoint is called with no query parameters for pagination, filtering, or sorting. As the number of payment requests grows, this will fetch an unbounded and ever-growing payload.

**Fix:** Add pagination (cursor or offset-based) and only fetch what's needed for the current view.

### Issue 7 — Rendering Assumes a Fixed, Unvalidated Shape
`r.customerName` and `r.id` are used without any validation of the actual response shape. If the API changes or returns malformed data, this fails at render time with an unhelpful error.

**Fix:** Validate/parse the response (e.g., with a schema library like `zod`) at the data-fetching boundary, and use TypeScript types for the payment request shape throughout the component tree.

### Issue 8 — The List Shows a Name and Nothing That Matters
A payment requests list that renders only `customerName` is missing the two columns the screen exists for: **amount** and **status**. Both carry correctness requirements the rest of the component doesn't:

- **Amount** arrives as `amount_minor` — an integer in agorot, deliberately, because floating-point rounding on money is a defect by construction. That integer must never be divided into a JS `number` for display math. Format at the boundary with `Intl.NumberFormat('he-IL', { style: 'currency', currency })` and treat the minor-unit conversion as a single shared utility, not something each component does inline.
- **Status** is the field most likely to be *stale*, and a stale status here is not cosmetic — it's an employee telling a customer their payment went through when it didn't. This is what motivates the real-time discussion in section 3.

**Fix:** Type the row as `{ id, customerName, amountMinor, currency, status, createdAt }`, format money through one shared helper, and render status as a distinct visual state rather than raw enum text.

---

## 2. Building This in Production

### Components
Split the flat `<div>` list into a clear component hierarchy: a `PaymentRequestsPage` (routing/layout), a `PaymentRequestsList` (renders loading/empty/error/data states), and a `PaymentRequestRow` (single-item presentation, memoized with `React.memo` since list rows re-render often). Keep presentation components "dumb" — they receive data and callbacks as props and contain no fetching logic themselves. This keeps each piece independently testable and reusable (e.g., the row component can be reused in a detail view).

### State Management
For this kind of server-derived list, avoid hand-rolled `useState`/`useEffect` fetching entirely in production — it's exactly the pattern that produces the bugs above. Use a data-fetching/cache library (**TanStack Query**, SWR, or RTK Query) to own the "is this data loading / stale / erroring" state, with the local `useState` limited to genuinely local UI concerns (selected row, open filters, sort order). This buys you caching, automatic refetch-on-focus, background refresh, and de-duplication of in-flight requests for free, instead of reimplementing them.

### Data Fetching
Wrap the endpoint call in a typed API client function (`getPaymentRequests(params)`) instead of an inline `fetch`. Feed that into `useQuery(['payment-requests', filters], () => getPaymentRequests(filters))` (or equivalent). Add pagination parameters, and pass an `AbortSignal` through to `fetch` so in-flight requests are cancelled automatically when the query key changes or the component unmounts — the library handles this natively.

### Error Handling
Distinguish between **retryable** errors (network blip, 5xx — the query library can retry with backoff automatically) and **non-retryable** ones (401 → redirect to login, 403 → show a permission message). Render a dedicated error boundary around the list so a rendering bug in one row doesn't crash the whole page, and log errors to your monitoring/observability tool (e.g., Sentry) with enough context to debug without exposing sensitive payment data in the error payload itself.

### Accessibility
Not optional here, and not only good practice: the customer-facing payment page falls under the Israeli accessibility standard (IS 5568, anchored to WCAG 2.0 AA), and it's the one surface where a compliance gap is externally visible. The internal admin list inherits most of the same work anyway:

- Render the list as a real `<table>` with `<th scope="col">` — a grid of `<div>`s gives a screen reader no way to associate a status cell with its customer.
- Announce async state changes via an `aria-live="polite"` region, otherwise a screen reader user gets silence during loading and silence again when rows appear.
- Status must not be conveyed by colour alone (a green vs. red dot) — pair it with text or an icon.
- Hebrew RTL: set `dir="rtl"` at the document level and use CSS logical properties (`margin-inline-start`) rather than left/right, so the layout doesn't need a mirrored stylesheet.
- Currency and dates through `Intl` with an explicit locale — RTL text with embedded Latin-script numerals is where bidirectional rendering usually breaks.

### Testing
- **Unit tests** for `PaymentRequestRow` and `PaymentRequestsList` with mocked data covering loading, empty, error, and populated states.
- **Integration tests** (e.g., React Testing Library + MSW to mock the network layer) verifying the component fetches on mount, renders the returned data, and handles a failed request gracefully.
- **Regression test for the infinite-loop bug specifically**: force several re-renders (e.g., a parent state change) and assert the fetch count does *not* grow with them. Note that "called exactly once on mount" is the wrong assertion — it fails under StrictMode's development double-invoke, so the test would be red for a correct component. Assert the invariant (renders don't cause fetches), not the count.
- **Cancellation test**: unmount mid-fetch, then resolve the in-flight promise, and assert the resolved data never reaches the DOM. Don't assert on the absence of a "setState on unmounted component" warning — React 18 removed it, so that assertion passes vacuously and tests nothing.
- **Out-of-order response test**: change the filter twice in quick succession, resolve the *first* request last, and assert the UI shows the second request's data. This is the race that actually corrupts what an employee sees, and `AbortController` alone doesn't cover every path to it.
- **Visual/E2E test** (e.g., Playwright/Cypress) covering the full flow against a real or staging API, including the loading skeleton and the eventual populated list.

---

## 3. Polling vs. SSE vs. WebSockets

**Recommendation: start with polling, move to SSE when the concurrency justifies it.**

The data need is genuinely **one-directional** — the server pushes status changes (`PENDING → PAID`, `CANCELLED`) down; client-initiated actions go through the existing REST endpoints, not the real-time channel. So WebSockets are the wrong tool here in any case, and the real decision is polling vs. SSE. That one turns on a number, not a principle:

**This is an internal admin screen.** A few dozen employees with it open, not a public storefront. At that scale a 10-second interval, or TanStack Query's refetch-on-focus and refetch-on-reconnect, is a handful of cheap indexed queries per minute — and it costs nothing to build, nothing to operate, and degrades to "slightly stale" rather than "silently disconnected." Reaching for SSE first is optimizing a cost we don't yet have. **Past roughly a few hundred concurrent viewers, that inverts** and the constant re-querying becomes real DB load; that's the point to switch.

### Why SSE over WebSockets, when we do switch

Plain HTTP, so it traverses corporate proxies and load balancers without special handling, and `EventSource` gives automatic reconnection with `Last-Event-ID` natively — a resumable stream you'd otherwise hand-build.

### Two things that make SSE more expensive than it first looks

Worth naming these up front, because both are usually discovered mid-implementation:

- **`EventSource` cannot send custom headers.** There is no `Authorization: Bearer` on an SSE connection. The options are cookie-based auth (which pulls in CSRF considerations) or a token in the query string — where it lands in access logs, proxy traces, and browser history. For a payments admin panel that's an access-control decision, not a footnote. A short-lived, single-use stream token exchanged over a normal authenticated `POST` is the usual way out.
- **It does not avoid a pub/sub layer.** Once there's more than one Node instance, a status change processed on instance A has to reach a client connected to instance B — that requires Redis pub/sub whether the transport is SSE or WebSockets. The genuine operational savings over WS are the reconnection logic and not needing sticky sessions; the fan-out cost is identical. (BullMQ already puts Redis in the stack, so this is incremental, not new infrastructure.)

Beyond that: each open connection holds a socket for the life of the session, which caps connections per instance and makes rolling deploys a visible event — every client reconnects at once.

### When WebSockets would be the better choice

If the product later needs true bidirectional interaction on this channel — live agent chat on a payment dispute, or collaborative editing — the added complexity is justified. And if another part of the app already runs WebSocket infrastructure, reuse it rather than operating two real-time mechanisms.

**Either way, keep the polling path.** On-focus refetch stays wired up even after SSE ships: it's the fallback for networks that block streaming connections, and the recovery path after a dropped stream. The pattern mirrors the backend — the push channel is a latency optimization, and a periodic reconciling fetch is what makes it safe to rely on.