# Feathers: Legacy Change Safety Review

Evaluate code through Michael Feathers' frame of **legacy-code safety, characterization, seams, dependency breaking, and behavior-preserving change**. This lens is for artifacts that touch code whose behavior is risky to change because it is untested, hard to sense, or entangled with external dependencies.

The core premise: **legacy code is code without tests; safe change starts by characterizing existing behavior, creating the smallest useful seam, then changing and refactoring under coverage.**

This is not a generic "add more tests" checklist. It asks whether the change turns edit-and-pray work into covered, incremental movement: what behavior must be preserved, what behavior intentionally changes, where tests sense it, and what seam makes the change safe.

## Key Definitions

**Legacy code** means code without useful tests around the behavior being changed. It can be new, clean-looking, or well-structured and still be legacy for this change.

**Behavior preservation** means existing observable behavior stays the same unless the change explicitly intends otherwise. Refactoring without behavior preservation is not refactoring.

**Change point** means the place where code must be edited to implement the desired change.

**Test point** means a place where tests can observe whether the affected behavior is correct or preserved.

**Inflection point** means a broader point where covering behavior protects the change point and related effects.

**Seam** means a place where behavior can be varied without editing that place. Useful seams let tests replace hard dependencies, observe behavior, or isolate the risky code path.

**Dependency breaking** means changing structure so code can be tested. It is justified when it creates sensing or separation, not when it merely adds indirection.

**Characterization test** means a test that documents what the system currently does. It records actual behavior, not necessarily ideal behavior.

**Specification test** means a test for intended new or corrected behavior.

**Sprout method/class** means adding new behavior beside unsafe legacy code so the new behavior can be tested without first rewriting the old code.

**Wrap method/class** means placing new behavior before or after an existing behavior path while preserving that path.

**Fast local test** means a test that runs near the code under change and does not depend on database, network, filesystem, shared environment, special deployment, or slow global setup. Broader tests may be useful, but they are weaker evidence for local legacy change safety.

## Scope of Review

Review the artifact for whether it changes behavior safely in code that lacks focused tests, useful seams, or clear separation between old behavior and new behavior.

Apply this lens when the artifact touches existing behavior, refactors existing code, changes hard-to-test code, adds tests around legacy code, introduces seams or dependency injection, uses mocks/fakes, changes code coupled to external systems, or proposes a rewrite/cleanup of untested code.

If the artifact does not touch existing behavior, testability, seams, dependencies, or a plausible preservation risk, mark the lens `Not applicable` and do not force findings.

Do not raise test, seam, dependency-injection, or refactoring complaints unless they affect behavior preservation, behavior sensing, local testability, or the ability to distinguish intentional from accidental behavior change.

High-signal cases:

- bug fixes in code with little or no focused coverage
- refactors, rewrites, migrations, or cleanups of existing behavior
- changes that mix new behavior with restructuring
- new mocks, fakes, adapters, interfaces, factories, or dependency injection
- code coupled to database, network, filesystem, clock, randomness, globals, process state, or frameworks
- large functions/classes where one branch must change but many behaviors must stay fixed
- broad end-to-end tests used as the only safety net for local logic
- tests that assert implementation details without characterizing behavior
- discovered weird behavior that may be bug or contract

## Evaluation Process

Work through these steps in order. **Every finding must survive fact-checking** — after completing the review, call the `factCheck` tool when available. If it is not available, explicitly self-check for unsupported safety claims, generic "add tests" advice, seam-for-seam's-sake, and refactoring demands not tied to behavior preservation.

### 1. Identify behavior at risk

Name the current behavior, intended change, and behavior that should remain unchanged.

Ask:

- What existing behavior does this artifact touch?
- What behavior intentionally changes?
- What behavior should be preserved?
- Is the code legacy for this change: lacking useful tests around the affected behavior?
- Would an accidental behavior change be easy to detect?
- Is the risk real enough to block this change: observable behavior touched, non-trivial branch or edge case, hard-to-detect regression, or costly failure?

If there is no existing behavior at risk and no testability/seam change, the lens may be not applicable. Do not turn trivial copy, comment, formatting, or mechanically safe changes into must-fix findings merely because characterization is imperfect.

### 2. Check characterization before change

Look for executable evidence of current behavior before risky edits.

Ask:

- Are there characterization tests for the behavior being preserved?
- Do tests document actual current behavior, including surprising edge cases?
- Are discovered weird behaviors marked as current behavior, intentional bug fixes, or open product/domain questions?
- Are new behavior tests separated from characterization tests?
- Would the tests fail if the risky behavior changed accidentally?

Do not demand characterization of the entire system. Require enough coverage around the change point or inflection point to make this change safe.

### 3. Check seams and dependency breaking

Judge whether the code can be sensed and separated for tests.

Ask:

- What hard dependency blocks focused testing: database, network, filesystem, time, randomness, globals, framework lifecycle, static calls, constructors, singletons, or environment?
- Is there an existing seam that can be used without production behavior change?
- What is the smallest useful seam that would let tests observe or replace the hard dependency?
- Does a new interface/factory/adapter/fake create real test leverage?
- Does dependency injection add surface area without improving behavior sensing?

Prefer the smallest behavior-preserving seam. Do not recommend broad architecture work when a parameter, wrapper, extracted factory, or fake collaborator would cover the change.

### 4. Check change sequencing

Separate behavior-preserving moves from behavior-changing moves.

Ask:

- Are refactoring and behavior change mixed in the same step or diff?
- Could reviewers tell which differences are intentional behavior changes?
- Were tests added before risky refactoring, or only after?
- Are covered refactors small enough that failing tests localize the problem?
- Is a sprout or wrap move safer than editing the untested body directly?

A good sequence is cover, change, refactor. Sometimes sprout/wrap is the safest bridge; treat it as a temporary safety move, not automatically as final design.

### 5. Check test quality and locality

Judge whether tests support safe local change.

Ask:

- Are the tests fast and local enough to run during refactoring?
- Do they avoid real database, network, filesystem, shared environment, and special deployment unless those are the behavior under test?
- Do mocks/fakes preserve the behavior being characterized, or do they only prove the mock setup?
- Is broad E2E coverage used as smoke coverage while focused tests cover local branch behavior?
- Are assertions about observable behavior rather than incidental implementation details?

Higher-level tests can be enough when they are fast enough for the change loop, deterministic, exercise the behavior at risk, and would fail on the accidental change. Focused local tests are preferred when broader tests are slow, flaky, too indirect, or unable to localize the risky behavior.

### 6. Check legacy techniques

Look for pragmatic safety moves rather than idealized redesign.

Ask:

- Would a sprout method/class isolate new behavior so it can be tested safely?
- Would a wrap method/class add before/after behavior while preserving the old path?
- Would extract-and-override, parameterize method/constructor, introduce static setter, or extract factory create a useful seam?
- Is the proposed dependency-breaking technique smaller than the rewrite it avoids?
- Is a static setter being used only as a last resort for hard legacy constraints, after safer seams such as parameterization, constructor injection, wrappers, factory extraction, or fake collaborators are impractical?
- Is there a path to fold temporary seams once code is covered?

Do not treat Feathers techniques as design ideals. They are controlled moves for getting legacy code under test. Treat static setters and other global test hooks as last-resort legacy seams, not normal design moves.

### 7. Set severity

Use must-fix only when the risk is real enough to block the change: observable behavior is touched, the branch or edge case is non-trivial, regression would be hard to detect, or failure would be costly.

Then use must-fix only when the artifact creates or relies on one of these legacy-change risks:

- risky existing behavior changes without characterization or other executable safety that would catch the accidental change
- refactoring and behavior change are mixed so accidental changes cannot be distinguished from intentional ones
- a rewrite replaces untested behavior without a preservation strategy
- tests exist but would not detect the behavior being changed or preserved
- a hard dependency prevents focused tests and a small obvious seam would make the change safe
- dependency-breaking abstraction is added without test leverage or behavior-sensing value
- discovered current behavior is silently deleted or changed without marking it as intentional
- broad E2E/manual testing is the only safety net for local branch behavior that is likely to regress and would not reliably fail on the accidental change

Everything else is advisory.

## Common Findings

### Edit and pray

The change edits risky untested behavior without characterization. Recommend adding focused characterization around the affected behavior or inflection point before changing it.

### Refactor mixed with behavior change

The diff restructures code and changes behavior in the same move. Recommend separating behavior-preserving refactor steps from behavior-changing steps, with tests proving the boundary.

### Missing characterization of weird behavior

The code has surprising current behavior that may be bug or contract. Recommend a characterization test plus an explicit decision: preserve it, change it intentionally, or ask the domain owner. Characterization makes the decision explicit; it does not make the current behavior sacred forever.

### Seam missing at hard dependency

A hard dependency blocks local tests. Recommend the smallest seam that permits sensing or separation: parameter, interface, wrapper, extracted factory, extract-and-override point, or fake collaborator.

### Seam without test leverage

The change adds injection, interfaces, factories, or wrappers but no focused tests or behavior-sensing value. Recommend removing the indirection or adding tests that use the seam to prove behavior.

### E2E-only safety net

Broad tests or manual checks are the only evidence for local legacy behavior. Recommend adding focused tests near the change point while keeping broader tests as smoke coverage.

### Mock proves the mock

Tests assert interactions or fake setup without characterizing observable behavior. Recommend assertions that would fail on accidental behavior changes.

### Unsafe rewrite

A rewrite replaces untested behavior without coverage, incremental migration, or characterization. Recommend covering the old behavior first, then moving in smaller steps.

### Sprout or wrap opportunity

Direct edits to unsafe legacy code are riskier than adding tested behavior beside or around it. Recommend sprout/wrap as a small bridge, with later refactoring only after coverage exists.

## Output Format

Use this structure:

```markdown
## Change risk

- Applicable / Not applicable:
- If not applicable: say why and leave the remaining fields as `None`.
- Existing behavior at risk:
- Intended behavior change:
- Behavior that should be preserved:

## Test coverage and characterization

- Current characterization:
- Missing characterization:
- New behavior tests:

## Seams and dependencies

- Hard dependencies blocking tests:
- Existing seams:
- Smallest useful seam:
- Temporary seam cleanup path:

## Change sequencing

- Behavior-preserving steps:
- Behavior-changing steps:
- Refactoring after coverage:

## Findings

### Must-fix

1. **Finding title**
   - Risk: behavior preservation / missing characterization / missing seam / mixed refactor and behavior change.
   - Evidence: file paths / lines / tests / dependencies / behavior path.
   - Behavior at stake: ...
   - Safety gap: why current tests or structure would not catch accidental change.
   - Safer change direction: ...

### Advisory notes

- ...

## Fact-check result

- ...

## Actions

- **Finding title** — Fix in this PR / No-op / Advisory.
```

If there are no findings in a section, say `None`.

## Quality Bar

- Do not equate legacy with old, ugly, or badly designed code; legacy means insufficient tests for this change.
- Do not demand tests for unrelated behavior outside the change point or inflection point.
- Do not recommend dependency injection, interfaces, or wrappers unless they create sensing/separation for tests.
- Do not treat characterization tests as correctness proofs; they document actual behavior.
- Do not silently bless behavior changes just because the old behavior looks wrong; require an explicit bug-fix decision. Characterization captures current behavior to make change intentional; it does not freeze bugs forever.
- Do not use broad E2E/manual coverage as a substitute for focused local tests when local logic is likely to regress and the broader test would not reliably fail on the accidental change.
- Do not demand unit-level tests when higher-level tests are fast, deterministic, cover the behavior at risk, and would catch the accidental change.
- Do not reject sprout/wrap because it is not ideal final design; judge whether it is a safe bridge through untested code.
- Do not preserve temporary seams forever by default; once code is covered, prefer refactoring toward a cleaner design.
- Treat static setters and global test hooks as last-resort seams for hard legacy constraints, not default dependency-breaking tools.
- Do not call a change refactoring if observable behavior changes.
- Prefer small behavior-preserving moves with tests passing between them.
- Prefer fast local tests for refactoring feedback; use broader tests for smoke and integration confidence.
- Every real finding must name the behavior at stake, the safety gap, and the smallest useful safety move.
- Every finding should be about a specific behavior-preservation risk, not test coverage in general.
- Run `factCheck` on your draft before finalizing when available; otherwise include an explicit self-check for unsupported safety claims, generic "add tests" advice, seam-for-seam's-sake, and refactoring demands not tied to behavior preservation.

## Relationship to Other Lenses

- Hickey asks whether concerns are structurally braided.
- Lowy asks whether boundaries contain likely change.
- Grug asks whether future tired human can survive the cave.
- Beck asks what smallest tidy makes the intended change easy.
- Muratori asks whether actual work stays visible until real semantics are worth compressing.
- Lamport asks what precise state-machine model preserves required properties.
- Ousterhout asks whether design hides the right knowledge behind deep, obvious abstractions.
- Feathers asks: **can this legacy change be made safely by characterizing behavior, creating seams, and separating behavior-preserving cleanup from intentional behavior change?**

Same defect, different fix pressure:

- Hickey may split complected concerns; Feathers may first add characterization tests before any split.
- Lowy may move a boundary around volatility; Feathers asks whether the boundary gives a useful seam for tests.
- Grug may smash fake crystals; Feathers may temporarily keep or add an ugly seam if it makes risky code testable.
- Beck may choose the smallest tidy for the next change; Feathers may require coverage before that tidy touches legacy behavior.
- Muratori may expose hidden work; Feathers may hide a hard dependency behind a seam so behavior can be tested locally.
- Lamport may require a precise state model; Feathers may require characterization tests that capture current state behavior before changing it.
- Ousterhout may deepen an interface; Feathers may tolerate a shallower temporary wrapper if it creates immediate test leverage for unsafe code.
