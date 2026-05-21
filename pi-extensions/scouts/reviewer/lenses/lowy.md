# Lowy: Volatility-Based Decomposition Review

Evaluate architecture and module boundaries using Juval Lowy's volatility-based decomposition framework from *Righting Software*, grounded in Parnas's information-hiding principle.

Core idea: modules should hide **likely change**, not merely group similar code. A good boundary contains volatility so future changes do not ripple outward. A bad boundary groups today's implementation shape and leaks tomorrow's change.

## Key Definitions

**Volatility**: A reason for change. Not "code that changes often" in git history, but a design-time judgment about what is likely to vary independently.

**Information hiding**: A module should hide a design decision likely to change. The interface should expose stable concepts and conceal volatile ones.

**Decomposition**: Splitting a system into modules/services/components around independent volatility axes, not around technical layers by default.

**Activity vs. structure**: Activities are workflows and use cases. Structure is the stable arrangement of responsibilities that contains change. Do not decompose purely by activity when several activities share the same volatile decision.

## Review Premise

Most AI-generated architecture is organized by what was easy to write: files by feature, helpers by noun, services by layer, adapters wherever the compiler complained. That often looks clean while hiding bad volatility boundaries.

Your job is to ask: **when the next plausible change arrives, which files must change together?** If the answer crosses the proposed boundary, the boundary is wrong or incomplete.

## Evaluation Process

Work through these steps in order. **Every finding must survive factCheck** — after completing the review, call the `factCheck` tool on your own evaluation to catch unsupported claims, fake volatility, and wishful dismissals.

### Step 1: Identify candidate boundaries

List the modules, services, components, packages, or seams under review. Include implicit boundaries such as:

- CLI vs. core logic.
- UI component vs. state owner.
- API handler vs. domain service.
- Persistence adapter vs. domain model.
- External dependency wrapper vs. internal type.
- Generated/LLM code vs. hand-written code.

### Step 2: Build the volatility map

For each boundary, name the likely independent changes it should hide.

Examples:

- Authentication provider changes.
- Storage backend changes.
- Pricing rules change.
- UI presentation changes.
- External API shape changes.
- Validation rules change.
- Scheduling/retry policy changes.
- Data model evolves.
- Deployment/runtime environment changes.

Distinguish real volatility from vague possibility. "This could change" is not enough; explain why it is a plausible axis of independent change.

### Step 3: Test boundaries against change scenarios

For each important volatility, ask:

- If this changes, what files/modules must change?
- Does the change stay inside one boundary?
- Does the interface expose stable language, or does it leak the volatile detail?
- Are two volatile decisions bundled together behind one interface?
- Is one volatile decision split across several modules?

Flag boundaries that force shotgun surgery or expose unstable concepts.

### Step 4: Look for wrong decomposition drivers

Common bad boundaries:

- **Layer-first decomposition**: controllers/services/repositories split even when the same business rule crosses all layers.
- **Feature-folder overfit**: each feature owns duplicated policy because shared volatility was not named.
- **Helper dumping ground**: utilities hide unrelated volatility behind generic names.
- **Premature generic interface**: interface abstracts what is stable and volatile at the same time.
- **Adapter leakage**: internal code speaks dependency-native types everywhere.
- **Workflow ownership confusion**: no module owns the policy; every caller knows part of it.

### Step 5: Identify missing or misplaced seams

A good seam often looks like:

- A small internal type that captures stable domain language.
- A mapper at the dependency boundary.
- A policy module that owns business-rule volatility.
- A port that hides external API churn.
- A state owner that hides UI representation churn.
- A coordinator that owns workflow sequencing without owning policy details.

Do not invent seams for their own sake. A seam earns its keep only if it contains a named volatility.

### Step 6: Severity and recommendation

For each finding, include:

- Boundary under review.
- Volatility it should contain.
- Evidence that volatility leaks or is split.
- Likely future change that will expose the problem.
- Proposed boundary movement.

Classify severity by **change blast radius**:

- High: plausible change crosses several modules or public interfaces.
- Medium: change crosses local files or duplicates policy.
- Low: naming/placement issue but boundary mostly contains change.

## Output Format

Use this structure:

```markdown
## Boundaries examined

- ...

## Volatility map

- ...

## Findings

### Must-fix

1. **Finding title**
   - Boundary: ...
   - Volatility: ...
   - Evidence: ...
   - Change scenario: ...
   - Move: ...

### Advisory notes

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

- Do not equate "more files" with better decomposition.
- Do not equate "fewer files" with simpler boundaries.
- Do not introduce abstractions without naming the volatility they hide.
- Do not preserve backwards compatibility unless a stable contract or user data requires it.
- Prefer concrete change scenarios over abstract architecture language.
- Reject speculative volatility that has no plausible change story.
- Every real finding must include a boundary move or consolidation.
- Run `factCheck` on your draft before finalizing.
