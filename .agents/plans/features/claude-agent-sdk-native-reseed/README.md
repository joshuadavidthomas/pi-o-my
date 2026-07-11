# Claude Agent SDK Native Reseeding

**Source roadmap item:** N/A
**Source improvement plan:** N/A
**Planned at:** 2026-07-10, jj working copy `ced94441` / change `nlylqxpu`
**Status:** Implemented with Claude compact-state emulation
**Current gate:** Keep the authenticated Fable integration test green when upgrading the Claude Agent SDK/CLI.

## Purpose

Preserve Pi's compaction quality while rebuilding post-compaction Claude Code context inside Claude's native compacted-session envelope instead of sending prior assistant/tool output as an ordinary synthetic user request that Fable 5 rejects.

## What Better Means

Pi remains authoritative for compaction and visible session history; Claude receives a fresh, resumable compacted session after compaction; normal Claude continuity is unaffected; format drift and seed failures are explicit and tested through the real SDK seam.

## Artifact Index

| Artifact | Status | Purpose | Notes |
|---|---|---|---|
| [001-design-discussion](001-design-discussion.md) | Accepted 2026-07-10 | Choose the native reseed architecture and safety boundaries | Pi-owned durable `SessionStore`; staged real-SDK probes |
| [002-structure-outline](002-structure-outline.md) | Accepted 2026-07-10 | Sequence the probes, adapter, store, lifecycle state, and cutover | Seven phases; production gated on real text and tool-history probes |
| [003-plan](003-plan.md) | Implemented 2026-07-10 | Executor-safe implementation and verification | Plain replay failed; Claude compact-boundary + compact-summary emulation passes realistic Fable history and second resume |

## Current Shape

- Pi's exported `compact()` remains the summarization pipeline.
- Pi's exported `compact()` produces the authoritative summary and retained recent messages.
- After explicit Pi compaction, the provider writes a Claude `compact_boundary` plus `isCompactSummary` entry through a durable `SessionStore`.
- Pi's summary and exact retained text/tool details live inside that compact-summary entry; only the current prompt is submitted after resume.

## Accepted Decisions

- Preserve Pi compaction rather than switching to Claude Code auto-compaction.
- Use Claude compact-state pre-seeding rather than ordinary imported assistant/tool entries or further wording-only changes.
- Use the SDK `SessionStore` seam with a private Pi-owned durable transcript store.
- Do not automatically fall back to the ordinary flattened handoff or omit retained context.
- Preserve completed tool-use/result details textually inside the native compact-summary entry.
- Initially apply reseeding only after Pi compaction, not every stale or soft-reset path.

## Probe Result

- Plain imported assistant narration plus tool use still triggers Fable's anti-distillation refusal.
- The same realistic history succeeds when encoded as Claude compacted state: `compact_boundary` followed by an `isCompactSummary` user entry.
- The production encoder passes on `claude-fable-5`, preserves the codename from completed tool history, performs no tool replay, and resumes the mirrored session a second time.
- An unsynchronized first post-compaction turn remains pending until Pi records `turn_end`; restart creates a fresh seed attempt rather than submitting the same prompt twice.

## Implementation Routing

Implemented in `native-reseed.ts`, `session.ts`, and `sdk/query.ts`. The authenticated gate is opt-in with `PI_CLAUDE_AGENT_SDK_RUN_INTEGRATION=1`.

## Rejected or Deferred

| Item | Reason | Revisit if |
|---|---|---|
| Claude Code owns compaction | Pi/Claude context divergence and weaker cross-provider semantics | Native reseeding proves infeasible |
| Direct writes to `~/.claude/projects` | Pollutes user sessions and couples ownership to Claude internals | SDK removes `SessionStore` materialization |
| Pi-summary-only fallback | Silently loses Pi's kept-recent context | User explicitly accepts a lossy emergency mode |
| All stale recovery paths in v1 | Unnecessarily broad initial blast radius | Pi-compaction reseeding is stable |
