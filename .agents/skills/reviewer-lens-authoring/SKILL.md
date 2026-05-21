---
name: reviewer-lens-authoring
description: Use when adding, editing, or reviewing reviewer scout lenses in this agentkit repo — creates review lenses, wires them into REVIEW_LENSES, updates /review help/tool docs/README, and validates reviewer behavior. Handles requests like "add a new lens", "write a reviewer lens", "make a reviewer lens", or "update reviewer personas".
---

# Reviewer Lens Authoring

Use this for `pi-extensions/scouts/reviewer` lenses. A lens is an adversarial review mindset, not a generic checklist. Each lens should overlap with the others on some problems while disagreeing on framing, evidence, and preferred fixes.

## Add or Update a Lens

1. Research the lens or person before writing.
   - Use external research for source material: books/talks/articles/transcripts, not vibes.
   - Capture the core claims, definitions, review questions, common misreadings, and what this lens would disagree with in existing lenses.
   - Keep citations or source notes in the working context; put provenance in a README only if substantial source synthesis must be preserved.
2. Summarize and synthesize the research before drafting.
   - Write the baseline in plain language: what the thinker/framework actually says.
   - Extract the core nugget: the one review question this lens exists to ask.
   - Name the lens's evidence standard: what counts as proof for or against a finding.
   - Name the lens's preferred fixes and the fixes it tends to reject.
   - Name the tensions with the existing lenses so the lens is not just another best-practices checklist.
3. Inspect the existing lens shape in `pi-extensions/scouts/reviewer/lenses/`.
4. Decide the lens identity and output contract.
   - Choose framework-style or persona-style.
   - Define the output sections that force this lens to reason in its own way.
   - State what kind of finding belongs in this lens and what belongs in another lens.
5. Draft the lens at `pi-extensions/scouts/reviewer/lenses/<lens>.md`.
6. Self-review the draft before wiring it in.
   - Check that it does not collapse into generic best practices.
   - Check that it has source-backed definitions and evidence rules.
   - Check that it overlaps with existing lenses only where the reasoning or fix differs.
7. Add the lens id to `REVIEW_LENSES` in `pi-extensions/scouts/reviewer/config.ts`.
8. Update user-facing/static prose:
   - `/review` help in `pi-extensions/scouts/reviewer/args.ts`
   - reviewer tool guidance in `pi-extensions/scouts/reviewer/tool.ts`
   - command description in `pi-extensions/scouts/reviewer/command.ts` only if it hard-codes lens names
   - `README.md` scouts section
9. Validate the lens behavior on a real or representative artifact.
   - Confirm the output is distinct, useful, evidence-backed, and shaped by the lens's core nugget.
   - Revise the lens before relying on code validation if the behavior is generic or mushy.
10. Add or update tests when behavior changes:
   - `pi-extensions/scouts/reviewer/args.test.ts` for flags/help-relevant parsing
   - `pi-extensions/scouts/reviewer/artifacts.test.ts` for artifact collection edge cases
   - focused tests near changed support code

## Research Synthesis Checklist

Before drafting, produce a short synthesis with:

- **Baseline summary:** what the source material says, without turning it into reviewer instructions yet.
- **Core nugget:** the one sharp review question this lens exists to ask.
- **Key definitions:** terms the lens needs to use precisely.
- **Evidence standard:** what proof the lens trusts most when judging code, plans, or diffs.
- **Preferred fixes:** the kinds of changes this lens naturally recommends.
- **Rejected false fixes:** changes that sound aligned but violate the source idea.
- **Tensions:** where this lens would disagree with the existing lenses.
- **Output implications:** sections that force the lens to reason in its own way.

Do not draft the lens until the core nugget is clear enough to explain in one sentence.

## Lens Body Shape

Use this structure for framework-style lenses:

```markdown
# Name: Review Frame

Evaluate code for **specific property** using [source/framework]. Explain why this lens exists and what it catches that tests or other lenses miss.

The core premise: **one sharp claim**.

## Key Definitions

**Term**: Definition with review implications.

## Scope of Review

What the reviewer should inspect, when to broaden/narrow scope, and how to avoid being trapped by the user's framing.

## Evaluation Process

Work through ordered steps. Require concrete evidence and `factCheck` before final output.

## Output Format

Provide exact markdown sections and action dispositions.

## Quality Bar

List do/don't rules that preserve the lens's distinct viewpoint.
```

Persona-style lenses may break this shape, but only when the voice improves reasoning rather than decoration.

## Make Lenses Adversarial

Before finalizing, write the lens's contrast with the lenses already in `pi-extensions/scouts/reviewer/lenses/`.

Good lenses can find the same defect but should justify it differently and often recommend a different smallest fix.

## Wiring Checklist

- [ ] `REVIEW_LENSES` includes the lens id.
- [ ] `lenses/<lens>.md` filename exactly matches the lens id.
- [ ] `/review --<lens>` works through derived lens flags.
- [ ] Tool schema enum updates through `REVIEW_LENSES`.
- [ ] Help text and README do not claim an old lens count.
- [ ] Multi-lens guidance says one reviewer tool call per lens.
- [ ] Tests cover any changed parser/artifact/tool behavior.

## Behavior Check

Before calling the lens done, run it against a real or representative diff, plan, design, or file. Look for:

- a finding shape that follows the lens's core nugget
- evidence, not just fluent opinion
- overlap with existing lenses only when the reasoning or fix differs
- output sections that force the intended analysis
- clear actions, including when the lens finds nothing

If the output could have come from any generic senior engineer, revise the lens.

## Validation

Run:

```bash
bun test pi-extensions/scouts/reviewer/args.test.ts pi-extensions/scouts/reviewer/artifacts.test.ts pi-extensions/scouts/reviewer/result.test.ts pi-extensions/scouts/tools/read-only-bash.test.ts
bun run typecheck
```

If a listed test file does not exist yet, either add it when relevant or run the closest existing focused tests and report the gap.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Writing `You are X` for a framework lens | Use `Evaluate code through X's frame...`; reserve persona voice for lenses where voice improves reasoning |
| Adding a lens markdown file but not `REVIEW_LENSES` | Add the id to `config.ts`; flags/schema derive from it |
| Updating code but not README/help/tool prose | Sweep static prose for old lens lists |
| Making the lens a generic best-practices checklist | Give it a distinct premise, definitions, output contract, process, and quality bar |
| Skipping source research | Research first; extract claims, definitions, questions, and tensions before drafting |
| Letting the lens agree with every other lens | Add explicit tensions, evidence standards, and different fix preferences |
| Recommending fixes without evidence | Require file/line/behavior evidence and a `factCheck` pass |
