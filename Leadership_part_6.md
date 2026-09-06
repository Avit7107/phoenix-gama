# Part 6 — Leadership Scenarios

## 1. Managing a Performance Drop in a Previously Strong Developer (Using SDD and TDD)

**Investigate — Before Assuming It's a Motivation or Skill Problem**
Start by looking at the work itself, not the person, before drawing any conclusions. Pull the data: review recent PRs, cycle time, review-round counts, and whether estimates vs. actuals have drifted. A previously strong developer rarely "forgets how to code"—the decline usually has a specific trigger.

Look specifically for a Spec/TDD signal: check if their recent tickets had clear, testable acceptance criteria, or if they were handed ambiguous work. Check their test discipline: look at whether their commits still lead with tests (red-green-refactor) or if tests arrive late. A drop in TDD discipline is often one of the earliest signals of disengagement or overload. Rule out external factors first (workload spikes, team changes, personal issues) so you don't run a performance process against the wrong root cause.

**The Feedback Conversation**
Lead with observation, not judgment: "I've noticed cycle time on your last few tickets has grown and there's been more back-and-forth in review—I want to understand what's going on, not just flag it." Ask, don't declare, giving them room to name something you haven't seen.

If the investigation pointed to a spec/TDD gap, name it concretely: "The last two tickets didn't have clear acceptance criteria going in, and I noticed the tests started showing up after the implementation... I think that's part of what's driving the rework." The goal is to address the situation as a partner, reducing cognitive load by breaking down tasks significantly.

**Improvement Plan (Based on SDD, TDD, and a 3-PR Workflow)**
Make it concrete, time-boxed, and practice-based. The plan relies on short, well-defined phases for each feature, closed with a separate Pull Request that requires peer approval before moving to the next stage to prevent "rabbit holes."

* **PR 1: Specification (Spec-Driven Development):** No ticket starts without a written spec they can restate back. The developer writes *only* the contracts (API definitions, interfaces, function signatures). No business logic is written.
* *Condition to proceed:* A peer reviews the PR to ensure clear naming and business understanding before logic is written.


* **PR 2: Tests (Test-Driven Development):** TDD as the working method. The developer writes all tests in a failing (red) state to cover all edge cases defined in the specification.
* *Condition to proceed:* A peer verifies that test coverage makes sense and accurately reflects expected behavior.


* **PR 3: Implementation:** With strict boundaries and a safety net of tests, the developer focuses solely on writing the code required to make the tests pass (green).
* *Condition to proceed:* A peer performs a standard Code Review focusing on code quality and logic.



Set measurable checkpoints (e.g., "next 3 tickets shipped with tests written first") and hold regular short check-ins so course correction happens early.

**When to Escalate**
The plan has clear checkpoints, making escalation an objective step. This structured framework should run for a defined period (e.g., two to three weeks). If the developer shows engagement, we gradually relax the extreme breakdown of tasks. Escalate to HR/your manager when: there's no improvement after 2–3 cycles despite support; the root cause is outside your ability to address (e.g., medical); or immediately if there is a safety or policy concern.

---

## 2. Two Senior Developers Disagree on Architecture and Are Blocking the Project

* **Separate the disagreement from the delay:** A real architectural debate is healthy; blocking delivery indefinitely is not. Make it explicit: "I want the best decision, and I also need a decision by [date]."
* **Get both positions in writing:** Have each side briefly state their proposal, the concrete trade-offs, and what the other side's proposal costs. This forces rigor and provides a shared artifact instead of repeating verbal arguments.
* **Anchor the decision to project constraints:** Bring the conversation back to the criteria that actually matter for this project (time-to-ship, team skills, cost, operational complexity). Naming the actual constraints out loud usually resolves more of the disagreement than technical arguments do.
* **Time-box the debate:** Give it one focused session to reach consensus. State upfront: "If we don't have alignment by the end of this session, I'll decide based on [criteria] so we can move."
* **Preserve the relationship:** Acknowledge the losing side's argument explicitly in front of the team ("X's concern about Y is valid, and here's how we're mitigating it"). The goal is a decision the team executes with full effort.
* **Write the decision down:** Create a short ADR (architecture decision record) detailing the chosen approach, the rejected alternative, and the reasoning.

---

## 3. Response to Management: Two-Week Ask vs. Four-Week Team Estimate

**Subject:** Release timeline — two-week request vs. current estimate

Hi [Name],

Thanks for the context on the two-week target. I want to be upfront: the team's current estimate for the full scope is four weeks, based on [brief basis — e.g., complexity of the payment reconciliation work, current team capacity, testing/QA needs]. I'd rather flag that gap now than commit to a date we're not confident we can hit.

To close the gap, I see a few real options, and I'd like your input on which to prioritize:

1. **Reduce scope:** Ship a defined subset of the feature in two weeks, with the remainder in a fast-follow release. I can outline what's realistically in v1 vs. v2 by [date].
2. **Add resources:** Bring in additional engineering support, understanding this has ramp-up cost and won't fully compress four weeks into two, but could meaningfully close the gap.
3. **Accept the four-week timeline:** If the full scope is non-negotiable, four weeks reflects our honest estimate including proper testing, which protects us from a rushed release causing a production incident.

I can put together a scoped v1 proposal by [date] if option 1 is worth exploring — happy to walk through trade-offs on a quick call before your next planning conversation.

— [Name]