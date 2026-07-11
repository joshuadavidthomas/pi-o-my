# Claude Agent SDK Native Reseeding

**Source roadmap item:** N/A
**Source improvement plan:** N/A
**Planned at:** 2026-07-10, jj working copy `ced94441` / change `nlylqxpu`
**Status:** Blocked by production-shaped Fable refusal
**Current gate:** Do not implement native reseeding without a new supported SDK seam or Anthropic guidance for imported multi-block assistant/tool turns.

## Purpose

Preserve Pi's compaction quality while rebuilding post-compaction Claude Code context with native transcript roles instead of flattening prior assistant/tool output into a synthetic user message that Fable 5 rejects.

## What Better Means

Pi remains authoritative for compaction and visible session history; Claude receives a fresh, resumable, native-role transcript after compaction; normal Claude continuity is unaffected; format drift and seed failures are explicit and tested through the real SDK seam.

## Artifact Index

| Artifact | Status | Purpose | Notes |
|---|---|---|---|
| [001-design-discussion](001-design-discussion.md) | Accepted 2026-07-10 | Choose the native reseed architecture and safety boundaries | Pi-owned durable `SessionStore`; staged real-SDK probes |
| [002-structure-outline](002-structure-outline.md) | Accepted 2026-07-10 | Sequence the probes, adapter, store, lifecycle state, and cutover | Seven phases; production gated on real text and tool-history probes |
| [003-plan](003-plan.md) | Blocked 2026-07-10 | Executor-safe implementation and verification | Minimal probes pass; realistic assistant narration + tool use still triggers the original refusal |

## Current Shape

- Pi's exported `compact()` remains the summarization pipeline.
- Pi compaction currently clears Claude continuity.
- The next Claude query receives rebuilt Pi context flattened into one non-querying user message.
- The proposed replacement pre-seeds a fresh native Claude transcript through `SessionStore` and resumes it before sending the current prompt.

## Accepted Decisions

- Preserve Pi compaction rather than switching to Claude Code auto-compaction.
- Use native Claude transcript pre-seeding rather than further wording-only changes to the flattened handoff.
- Use the SDK `SessionStore` seam with a private Pi-owned durable transcript store.
- Do not automatically fall back to the flattened handoff or lossy summary-only context.
- Require native completed tool-use/result support before production use.
- Initially apply reseeding only after Pi compaction, not every stale or soft-reset path.

## Probe Result

- Native assistant-text history passes on `claude-fable-5`.
- A minimal completed native tool-use/result turn passes and does not replay.
- A realistic assistant turn with narration followed by tool use still triggers Fable's anti-distillation refusal, regardless of whether blocks share or use distinct fabricated API message IDs.
- Production code was abandoned rather than dropping narration or restoring the flattened fallback.

## Implementation Routing

Blocked. Keep the authenticated probe as evidence. Reopen only if the SDK gains a supported transcript-import API or Anthropic documents a valid representation for imported model-authored multi-block turns.

## Rejected or Deferred

| Item | Reason | Revisit if |
|---|---|---|
| Claude Code owns compaction | Pi/Claude context divergence and weaker cross-provider semantics | Native reseeding proves infeasible |
| Direct writes to `~/.claude/projects` | Pollutes user sessions and couples ownership to Claude internals | SDK removes `SessionStore` materialization |
| Summary-only fallback | Silently loses Pi's kept-recent context | User explicitly accepts a lossy emergency mode |
| All stale recovery paths in v1 | Unnecessarily broad initial blast radius | Pi-compaction reseeding is stable |
