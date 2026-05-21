# Hickey: Structural Simplicity Evaluation

Evaluate code for **structural simplicity** using Rich Hickey's "Simple Made Easy" framework. This skill is designed for the world where AI generates code faster than humans can read it — where functional tests pass but accidental complexity accumulates silently.

The core premise: **tests tell you code works; they tell you nothing about whether it's simple.** Hickey: _"What's true of every bug found in the field? It passed the type checker... it passed all the tests."_ Complected code can be perfectly correct today. The damage shows up when you try to change it, reason about it, or extend it.

Source: [Full talk transcript](https://github.com/matthiasn/talk-transcripts/blob/master/Hickey_Rich/SimpleMadeEasy.md) (also in `transcript.md` relative to this skill)

## Key Definitions

**Simple** (sim-plex, "one fold/braid"): One concern, one role, one concept. Simplicity is _objective_ — count the interleaved concerns. Hickey: _"What matters for simplicity is that there is no interleaving, not that there's only one thing."_

**Easy** (adjacens, "nearby"): Familiar, at hand, within our skillset. Easy is _relative_. Hickey: _"If you want everything to be familiar, you will never learn anything new."_

**Complect** (com-plectere, "to braid together"): Interleave independent concerns so they cannot be reasoned about in isolation. Hickey: _"Every time I think I pull out a new part of the software I need to comprehend, and it's attached to another thing, I had to pull that other thing into my mind because I can't think about the one without the other."_

**Compose** (com-ponere, "to place together"): Combine independent things side by side, preserving isolation. Hickey: _"I'd rather have more things hanging nice, straight down, not twisted together, than just a couple of things tied in a knot."_

## Scope of Review

The trigger — "review this for X", "extract Y", "look at file Z", a `/do` diff with N touched files — is a *starting point*, not a frame. The structural questions in this skill (concept multiplication, fragmentation, complecting) are most legible at module boundaries; reviewing only the lines the user (or upstream issue) pointed at is how recurring patterns in the same file get missed.

**Default to whole-module scope.** When the trigger lives inside a single file or component, read the whole file — not just the cited region. When invoked on a multi-file diff, each touched file is in scope, and cross-file structural patterns (concept multiplication across modules, fragmentation that spans files) are in scope too. Adjacent files in the same directory are fair game when the trigger's pattern recurs there — concept multiplication often lives across siblings.

**Don't let the user's framing define the scope.** A trigger that says "extract `<ValueInputMode>`" implies a UI extraction; if the surrounding code shows the same fragmentation pattern recurring, name *that* — even when the implied fix is elsewhere (e.g., a discriminated data-model change rather than a sub-component split). The reviewer's job is to surface what the evidence on disk says, not to confirm the trigger's framing.

**Push back when the evidence contradicts the trigger.** If the prompt narrows the question to one symptom but the file shows the symptom is one instance of a broader structural issue, the broader finding is the headline, not a footnote. *"Issue #N described an extraction; the actual leverage is the data model"* is a valid first finding, not an out-of-scope tangent. Anchoring on the trigger's framing is itself a Layer 2 silence — a finding the review never let form.

## The Evaluation Process

Work through these layers in order. **Every finding must survive factCheck** — after completing all layers, call the `factCheck` tool on your own evaluation to catch wishful justifications and bogus dismissals.

### Layer 1: Identify the Concerns

Name the independent concerns the code addresses. Write them out explicitly. If you can't cleanly name distinct concerns, that is itself a finding.

### Layer 2: Fragmentation Check

Hickey's "don't complect" has a dual the rest of this skill doesn't cover: **don't fragment what belongs together**. When one domain concept is split across multiple fields, state locations, signals, modules, or call sites, and their coherence depends on an unenforced rule, you have the same structural bug as complecting — you just arrived at it from the opposite direction. The fix for complecting is separation. The fix for fragmentation is **reunification** at whatever layer the one thing naturally lives: one type, one signal, one module, one function, one file.

Look for:
- Same domain fact represented in multiple places.
- Parallel arrays/maps/signals that must stay in sync.
- A lifecycle split across unrelated modules.
- Two functions that must be changed together to preserve one behavior.
- "Derived" values stored separately and updated by convention.

For each fragmentation candidate, ask: "What is the one thing here? Where should it live?"

### Layer 3: Concept Multiplication

Identify places where the code introduces a new concept, type, module, service, helper, or state holder. For each, ask:

- What independent concern does this isolate?
- What invariant does it enforce?
- What change does it make easier without making current reasoning harder?
- Is this a real domain distinction or just a naming convenience?

Flag concepts that exist only to make the implementation feel organized, especially when they duplicate language already present elsewhere.

### Layer 4: Complecting Check

Look for interleaving of concerns:

- State + control flow.
- IO + business rules.
- Parsing + execution.
- Rendering + domain decisions.
- Validation + mutation.
- Time/lifecycle + data representation.
- Error handling + normal data path.

A finding should name the braided concerns and explain why they cannot be reasoned about independently.

### Layer 5: Ease Masquerading as Simplicity

Flag code that is easy because it is familiar, local, or framework-shaped, but not simple:

- Glue code that knows too much about both sides of an integration.
- Generic helpers that hide actual domain decisions.
- Framework conventions followed despite worse boundaries.
- Inline shortcuts that create hidden coupling.

### Layer 6: Evidence and Severity

For every finding, include:

- The file/module where the issue appears.
- The concerns being fragmented or braided.
- The specific invariant currently maintained by convention.
- The likely change that will expose the complexity.
- A small simplifying move.

Classify severity by **reasoning load**, not by lines of code:

- High: a future change requires understanding multiple concepts at once.
- Medium: local reasoning is possible but invariants are implicit.
- Low: mostly naming or placement friction.

## Output Format

Use this structure:

```markdown
## Concerns identified

- ...

## Fragmentation findings

### Must-fix findings

1. **Finding title**
   - Evidence: file paths / lines / behavior.
   - Invariant: what must stay in sync.
   - Problem: why this is structurally fragile.

### Advisory notes

- ...

## Concept multiplication

- ...

## Structural pattern matches

- ...

## Severity

- ...

## Simplifications

- ...

## Fact-check result

- ...

## Actions

- **Finding title** — Fix in this PR / No-op / Advisory.
```

If there are no findings in a section, say `None`.

## Quality Bar

- Do not review style unless it creates structural coupling.
- Do not count files or abstractions; count concerns and invariants.
- Do not reward indirection merely because it looks organized.
- Do not punish decomposition merely because there are more files.
- Prefer one precise structural finding over many vague smells.
- Do not invent findings. If the code is simple, say so.
- Every real finding must include a simplifying move.
- Run `factCheck` on your draft before finalizing.
