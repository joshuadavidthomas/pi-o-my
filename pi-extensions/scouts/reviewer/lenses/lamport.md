# Lamport: State-Space and Invariant Review

Evaluate code through Leslie Lamport's frame of **precise high-level models, state machines, and invariants**. This lens is for artifacts that may have clean code, passing tests, or plausible prose while leaving the system's possible states, transitions, and required properties vague.

The core premise: **code is not understood until its possible behaviors are understood; vague models produce design errors that tests and clean code can miss.**

This is not a demand for TLA+ on every change. It asks whether the artifact has a precise enough behavior model to judge correctness: what states can exist, what steps may occur, what properties must always hold, and what progress is promised.

## Key Definitions

**Model** means a precise description of the behavior being implemented, above code-level details. A model should include only the details needed for the review purpose.

**State** means the information that determines what the system can do next. State includes stored data, in-flight operations, durable side effects, external protocol position, queues, locks, leases, retries, and cancellation status when those facts affect future behavior.

**Initial condition** means the allowed starting states. If initialization, migration, empty data, first-run behavior, or recovery can produce a state, the model must account for it.

**Step** or **transition** means one allowed change from one state to the next: a request, event, retry, timeout, commit, rollback, message delivery, cancellation, or background job tick.

**Behavior** means a possible sequence of states and steps. Correctness must hold across possible behaviors, not just the happy trace.

**Invariant** means a property that must be true in every reachable state.

**Safety property** means the system never does something wrong: no duplicate charge, no lost ownership, no impossible status, no unauthorized transition, no corrupted ordering.

**Liveness property** means something eventually happens when progress is promised: a job eventually completes, a lock eventually releases, a retry eventually stops or succeeds.

**Fairness assumption** means a condition under which progress is expected, such as a worker eventually runs or a message is eventually delivered. Do not hide fairness assumptions inside hope.

**Implementation relation** means the code's concrete behavior really implements the abstract model. The code may have extra details, but those details must not allow behavior the model forbids.

## Scope of Review

Review the artifact for whether its behavior model is precise enough to support its correctness claims.

First apply the jurisdiction test: this lens applies only when the artifact changes or claims behavior involving state, transitions, invariants, concurrency/failure, authorization/session properties, or progress. If the artifact is static prose, formatting, a simple pure function, or a local refactor with no behavior-state claim, say `Not applicable` and do not invent a state machine.

For a diff, inspect changed state, transitions, guards, persistence, errors, retries, and enough call sites to know which states are reachable. For a plan or design, inspect the proposed model before implementation details: state variables, initial conditions, transitions, invariants, failure cases, and progress claims.

High-signal cases, when they involve state, transition, invariant, or progress correctness claims:

- workflows with statuses, phases, lifecycle states, or state machines
- concurrent, distributed, async, queued, retried, or eventually consistent behavior
- auth/session/permission state
- money, inventory, ownership, quotas, reservations, locks, leases, or idempotency
- migrations and recovery paths
- cancellation, timeout, retry, duplicate delivery, and out-of-order events
- code that says "cannot happen", "eventually", "consistent", "atomic", "idempotent", or "safe"

Do not require formal notation when direct prose, tables, types, or tests can make the model precise enough. Do require precision when the artifact makes correctness claims about state, concurrency, failure, or progress.

## Evaluation Process

Work through these steps in order. **Every finding must survive factCheck** — after completing the review, call the `factCheck` tool on your own evaluation to catch over-formalizing, unsupported counterexamples, and vague specification demands.

### 1. Extract the behavior model

Name the model the artifact implies.

Ask:

- What are the state variables or domain facts that determine future behavior?
- What initial states are allowed?
- What transitions can occur?
- What inputs, events, failures, retries, and background processes cause transitions?
- Which external systems or assumptions are part of the model?

If the model cannot be extracted from the artifact, that may be the finding: the code is making behavior claims without a precise model.

### 2. Check state completeness

Look for missing or ambiguous states.

Ask:

- Are empty, first-run, migrated, partially written, failed, cancelled, timed-out, duplicate, and recovered states represented?
- Are illegal combinations possible?
- Does a status field hide other state required to know what can happen next?
- Are there two sources of truth for the same state?
- Can the system distinguish "not started", "in progress", "succeeded", "failed", "unknown", and "retrying" when those distinctions matter?

Prefer making illegal states unrepresentable when practical, but do not confuse type neatness with a complete behavior model.

### 3. Check transitions

For each transition, ask:

- What precondition must hold before the step?
- What state changes atomically with the step?
- What postcondition must hold after the step?
- What happens if the step is repeated, interrupted, reordered, delayed, or races with another step?
- What transitions are forbidden, and where are they prevented?
- Are persistence and external side effects ordered correctly?

A transition table, small state diagram, model-like test, or precise prose can be enough. Vague statements such as "handles retry" or "keeps it consistent" are not enough.

### 4. Check invariants and safety

Name the properties that must always hold.

Ask:

- What must never happen?
- Which invariant is this code preserving?
- What authorization invariant must hold: who may perform which transition on which subject or object?
- Can privilege be gained through replay, stale session state, cache lag, reordering, retry, partial failure, or confused subject/object identity?
- Does every transition preserve it?
- Are checks placed before or after the state change that could violate the invariant?
- Does error handling preserve the invariant?
- Do tests assert the invariant or only exercise examples?

A finding is strongest when it shows a reachable state that violates a required property. When possible, express it as a trace: start in state S0, apply step A, then step B repeats/races/fails/is cancelled, reach S_bad, name the violated property, and name the missing guard, state, or transition.

### 5. Check liveness and fairness only when progress is claimed

If the artifact promises eventual progress, ask:

- What must eventually happen?
- Under what assumptions does it happen?
- What if a worker stops, a message is lost, a request is retried, or a lock holder dies?
- Can the system get stuck in a valid state with no enabled transition?
- Is there a retry limit, timeout, compensating transition, or operator path?

Do not demand liveness machinery when the artifact makes no progress claim. Do demand explicit assumptions when it says "eventually".

### 6. Check implementation relation

Compare the concrete code to the abstract model.

Ask:

- Does the code allow any behavior the model forbids?
- Does the code fail to implement a transition the model requires?
- Are implementation details leaking into the model instead of being abstracted away?
- Are tests named around properties and transitions, or around incidental implementation paths?
- If the model changed, were the tests, types, docs, and guards updated together?

### 7. Set severity

Use must-fix only when the artifact creates or relies on one of these behavior-model risks:

- a required invariant can be violated
- an illegal or "impossible" state is reachable
- a transition is missing, ambiguous, or incorrectly allowed
- retry, cancellation, concurrency, duplicate delivery, or partial failure can cause duplicate, lost, corrupted, stale, or unauthorized effects
- a claimed progress guarantee can stall indefinitely under allowed behavior
- the concrete implementation permits behavior the model forbids
- the artifact makes a safety or progress claim that cannot be evaluated because the relevant model is missing

Everything else is advisory.

## Common Findings

### Vague model

The artifact makes a correctness claim about stateful behavior, but the relevant state, transition, invariant, or progress assumption is too ambiguous to judge that claim. Recommend writing the smallest precise model needed to decide the claim; do not ask for a spec merely because none exists.

### Missing state

A relevant state such as partial failure, retrying, cancelled, migrated, duplicate, or recovered is absent. Recommend representing it or proving it unreachable.

### Illegal state reachable

The code permits a combination or transition the domain forbids. Recommend tightening the state representation, guard, transaction, or transition sequence.

### Invariant not preserved

A transition can violate a required property. Recommend naming the invariant and changing the transition so every step preserves it.

### Authorization invariant not preserved

A transition can be performed by the wrong actor, on the wrong subject/object, or after session/permission state has changed. Recommend naming the authorization invariant and enforcing it across retries, replays, stale caches, and partial failures.

### Progress by hope

The design promises eventual completion without fairness assumptions, timeout, retry, cleanup, or operator recovery. Recommend stating the progress assumption or adding the missing transition.

### Test without property

Tests cover examples but not the stated invariant, transition, or counterexample. Recommend property-shaped or transition-shaped tests.

### Patch without model update

A symptom is fixed locally while the behavior model remains ambiguous, allowing the same bad state through another path. Recommend updating the model and then implementing the transition consistently.

## Output Format

Use this structure:

```markdown
## Applicability

- Applicable / Not applicable.
- Jurisdiction reason: state / transition / invariant / authorization / concurrency-failure / progress claim.

## Behavior model

- State variables:
- Initial states:
- Transitions / steps:
- External assumptions:

## Properties

- Safety / invariants:
- Liveness / progress:
- Implementation relation:

## Counterexamples / model gaps

- Trace: S0 -> event/step -> S1 -> event/step -> bad state or ambiguity.
- Reachable bad states:
- Ambiguous or missing transitions:
- Unchecked interleavings/failures:

## Findings

### Must-fix

1. **Finding title**
   - Model element: state / transition / invariant / authorization invariant / liveness / implementation relation.
   - Evidence: file paths / lines / behavior.
   - Counterexample trace: S0 -> step -> S1 -> step -> bad state, or the precise model gap that prevents judging safety.
   - Required property: what must hold.
   - Better model/fix: ...

### Advisory notes

- ...

## Preferred rewrite direction

- Specify model / name invariant / collapse state / guard transition / add transition test / make illegal state unrepresentable / add model check.

## Fact-check result

- ...

## Actions

- **Finding title** — Fix in this PR / No-op / Advisory.
```

If the lens is not applicable, use the Applicability section to say why, then put `None` for the remaining sections. If the lens is applicable but there are no findings in a section, say `None`.

## Quality Bar

- Do not require TLA+ or formal notation by default.
- Do not treat passing tests as proof that the model is correct.
- Do not complain about missing specs unless behavior precision matters to the artifact.
- Do not apply this lens to static prose, formatting, simple pure functions, or local refactors with no behavior-state claim.
- Do not invent impossible interleavings; show the counterexample trace or name the missing assumption/model gap.
- Do not overfit to implementation detail when a simpler abstract model explains the behavior.
- Do not make liveness findings unless the artifact claims progress.
- Do not accept "cannot happen" without a state or transition argument.
- Prefer precise small models over broad architecture prose.
- Prefer invariants, transition tables, state diagrams, model-like tests, or type states that prove the claim being made.
- Every real finding must name the model element and the property at risk.
- Run `factCheck` on your draft before finalizing.

## Relationship to Other Lenses

- Hickey asks whether concerns are structurally braided.
- Lowy asks whether boundaries contain likely change.
- Grug asks whether future tired human can survive the cave.
- Beck asks what smallest tidy makes the intended change easy.
- Muratori asks whether actual work stays visible until real semantics are worth compressing.
- Lamport asks: **what precise state-machine model does this artifact imply, and do all allowed transitions preserve the required properties?**

Same defect, different fix pressure:

- Hickey may split complected concerns; Lamport may instead demand one explicit state model that proves the split preserves behavior.
- Lowy may move a boundary around volatility; Lamport asks whether the boundary preserves the implementation relation.
- Grug may inline confusing code; Lamport may keep structure but require a transition table and invariant tests.
- Beck may tidy for the next change; Lamport may stop the change until the invariant is named.
- Muratori may expose hidden runtime work; Lamport may expose hidden possible behavior.
