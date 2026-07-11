---
type: structure-outline
repo: pi-o-my
branch: working-copy
sha: ced94441
status: accepted
source_design_discussion: .agents/plans/features/claude-agent-sdk-native-reseed/001-design-discussion.md
---

# Structure Outline: Native Claude Transcript Reseeding After Pi Compaction

## Review Status

- **Status:** Accepted 2026-07-10
- **Accepted structure:** Seven phases from real-SDK probes through adapter, durable store, lifecycle integration, cutover, and cleanup.
- **Next artifact:** Final plan

## Desired End State

- Pi's existing `compact()` pipeline remains unchanged and authoritative.
- A Pi compaction marks the active branch as requiring native Claude transcript reseeding.
- On the next Claude turn, the extension converts Pi's rebuilt context through the entry before the current prompt into a fresh native Claude transcript.
- The transcript preserves compaction summary, retained user/assistant roles, completed tool-use/result pairs, errors, ordering, and tool identity without synthesizing thinking or Claude compaction metadata.
- The transcript is persisted by a Pi-owned durable `SessionStore`, resumed by the SDK, and then extended by the current querying prompt.
- Successful startup transitions into ordinary Claude continuity; later query closure or Pi restart resumes from the durable store without reseeding again.
- Invalid or unsupported context fails explicitly and leaves the reseed transition retryable.
- The flattened post-compaction handoff is removed once native reseeding passes the real SDK gates.

## Implementation Overview

- [ ] Phase 1: Prove native text-role reseeding through the real pinned SDK
- [ ] Phase 2: Prove completed native tool history
- [ ] Phase 3: Add the transcript translation boundary
- [ ] Phase 4: Add the Pi-owned durable `SessionStore`
- [ ] Phase 5: Model and persist the post-compaction reseed transition
- [ ] Phase 6: Integrate native reseeding into query startup and cut over
- [ ] Phase 7: Verify lifecycle recovery and remove obsolete flattened paths

## Phase 1: Prove Native Text-Role Reseeding

Create a disposable, opt-in integration test before production architecture. It should construct the smallest observed Claude JSONL transcript—one user entry followed by one text-only assistant entry—append it to `InMemorySessionStore`, call `query()` with `resume` plus the store, and ask for a harmless fact available only in the seeded history.

The probe must also close the query and resume the same seeded session a second time through the same store. This proves materialization, native role acceptance, transcript mirroring, and reopen behavior. It must use the installed SDK and bundled Claude executable rather than mocks.

### File Changes

- `extensions/custom-provider-claude-agent-sdk/sdk/session-store.integration.test.ts` — add an environment-gated real-SDK probe using a temporary cwd and no production extension state.
- `extensions/custom-provider-claude-agent-sdk/package.json` or root `package.json` — add a clearly named opt-in test script only if the existing `bun test` invocation cannot safely exclude authenticated integration tests by default.

The transcript fixture should use valid UUIDs, one linear `parentUuid` chain, native user/assistant envelopes, the pinned Claude Code version, no thinking, and no compact-boundary metadata.

### Validation

#### Automated

- [ ] `bun test extensions/custom-provider-claude-agent-sdk/sdk/session-store.integration.test.ts` with the probe environment variable absent — proves the authenticated probe skips safely in normal test runs.
- [ ] Run the same test with its documented opt-in environment variable and valid Claude OAuth — proves first resume, response, mirror append, close, and second resume against SDK 0.2.141.
- [ ] `bun run typecheck` — proves the probe uses the installed SDK contract correctly.

#### Evals / Regression Checks

- [ ] The first querying prompt contains no quoted assistant response and no synthetic handoff.
- [ ] The response demonstrates access to seeded assistant-role history.
- [ ] No generated file is written into `~/.claude/projects`.

#### STOP Condition

Stop and write a handback if Claude Code rejects, ignores, rewrites, or cannot re-resume the minimal text transcript. Do not build the production adapter around an unproven private format.

## Phase 2: Prove Completed Native Tool History

Extend the integration probe with a completed historical tool turn:

1. an assistant entry containing one native `tool_use` block;
2. a following user entry containing a matching `tool_result` block;
3. a final assistant text entry confirming the result was incorporated.

The new prompt must continue from that history without attempting to execute the historical tool. Use an inert fictitious or test MCP tool name in the seed so accidental replay is observable and harmless.

### File Changes

- `extensions/custom-provider-claude-agent-sdk/sdk/session-store.integration.test.ts` — add the tool-pair scenario and assertions.

### Validation

#### Automated

- [ ] Opt-in integration test — proves matching tool IDs and native role structure are accepted and not replayed.
- [ ] `bun run typecheck`.

#### Evals / Regression Checks

- [ ] The historical `tool_use.id` exactly matches `tool_result.tool_use_id`.
- [ ] The query emits no live request for the historical tool.
- [ ] The model can use a harmless fact available only in the seeded tool result.

#### STOP Condition

Stop if completed historical tool turns trigger replay, invalid-message errors, or silent history removal. Production cutover requires truthful retained tool state.

## Phase 3: Add the Transcript Translation Boundary

Replace transcript-shaped logic in control flow with a focused adapter. The adapter accepts Pi-native messages and returns either a complete internal seed or a classified conversion failure. A separate encoder maps that seed to the pinned Claude JSONL shape.

The adapter must handle:

- Pi compaction summary and branch summary messages as user-context text using Pi's existing wrappers;
- ordinary text/image user content supported by the SDK transcript format;
- assistant text and tool-call blocks while omitting thinking blocks;
- completed Pi tool results grouped into native Claude user `tool_result` entries;
- multiple tool calls/results from one assistant turn;
- error results and image result content;
- MCP tool-name mapping through the existing names module;
- stable tool IDs and chronological order;
- deterministic UUID/time injection for tests;
- detection of dangling, missing, duplicated, or mismatched tool identities.

Unsupported content must return a classified error; it must never be silently omitted.

### File Changes

- `extensions/custom-provider-claude-agent-sdk/transcript/types.ts` — define the small internal `ClaudeTranscriptSeed`, entry variants, and conversion failure contract.
- `extensions/custom-provider-claude-agent-sdk/transcript/from-pi.ts` — translate Pi `AgentMessage[]` into the internal seed model.
- `extensions/custom-provider-claude-agent-sdk/transcript/to-claude.ts` — encode the internal seed as opaque SDK `SessionStoreEntry[]` for SDK/CLI 0.2.141.
- `extensions/custom-provider-claude-agent-sdk/transcript/from-pi.test.ts` — behavior tests for role, ordering, tool pairing, and failures.
- `extensions/custom-provider-claude-agent-sdk/transcript/to-claude.test.ts` — deterministic envelope and parent-chain tests.
- `extensions/custom-provider-claude-agent-sdk/handoff.ts` — expose or relocate the existing Pi context-boundary selection independently from prose formatting; do not yet remove production handoff calls in this phase.

### Validation

#### Automated

- [ ] `bun test extensions/custom-provider-claude-agent-sdk/transcript` — proves translation and encoding behavior.
- [ ] `bun test extensions/custom-provider-claude-agent-sdk/sdk/query.test.ts` — proves existing query behavior remains characterized before cutover.
- [ ] `bun run typecheck`.

#### Evals / Regression Checks

- [ ] Every input message is represented or produces a classified failure.
- [ ] Current user prompt exclusion is tested separately from split-turn/all-context conversion.
- [ ] No generated assistant entry contains thinking or a fabricated signature.
- [ ] No generated transcript contains Claude compact-boundary metadata.
- [ ] JSONL/provider fields appear only in `to-claude.ts` and its tests.

## Phase 4: Add the Pi-Owned Durable SessionStore

Implement the SDK `SessionStore` boundary as an extension-owned durable local store. It should append and load opaque entries without interpreting transcript semantics.

Required behavior:

- storage rooted under Pi's agent directory, not `~/.claude/projects`;
- path scoping by Pi session ID and Claude seed session ID;
- ordered append with per-session serialization;
- UUID deduplication for retry/idempotency;
- atomic durable writes;
- complete load for explicit resume;
- safe no-op or classified absence for unknown sessions;
- targeted deletion for extension-owned sessions;
- no optional `continue`, listing, summaries, or subagent support without an actual caller;
- no transcript content in routine logs or errors.

### File Changes

- `extensions/custom-provider-claude-agent-sdk/session-store.ts` — implement the durable SDK store and ownership/cleanup contract.
- `extensions/custom-provider-claude-agent-sdk/session-store.test.ts` — use a temporary directory to verify append order, deduplication, restart/load, concurrent append serialization, atomic-failure behavior, and targeted deletion.
- `extensions/custom-provider-claude-agent-sdk/sdk/debug.ts` — add safe metadata-only diagnostics if the current debug vocabulary cannot describe store operations without content.

### Validation

#### Automated

- [ ] `bun test extensions/custom-provider-claude-agent-sdk/session-store.test.ts`.
- [ ] `bun run typecheck`.

#### Evals / Regression Checks

- [ ] A new store instance can load data written by a previous instance.
- [ ] Duplicate UUID batches do not duplicate transcript entries.
- [ ] Concurrent appends preserve accepted call order within one process.
- [ ] Store failures identify operation/session metadata without transcript content.
- [ ] No files appear under `~/.claude/projects` during store unit tests.

## Phase 5: Model the Post-Compaction Reseed Transition

Make startup state explicit and branch-local. A Pi compaction should persist a reseed marker rather than an indistinguishable all-null continuity record. Valid live and resumable states must remain unchanged.

The lifecycle should distinguish at least:

```text
cold
reseed pending
SDK session captured but not Pi-synced
resumable
live
```

Transitions:

- `session_compact` → reseed pending for the active branch;
- next turn preparation → reseed startup plan;
- seed construction/resume failure → reseed remains pending;
- SDK session capture → captured continuity tied to the seed/store;
- Pi `turn_end` → normal synced/resumable continuity;
- new/fork → ordinary cold state, not reseed;
- tree navigation → reload branch-local state;
- model switch away/back with valid continuity → ordinary resume, not reseed.

### File Changes

- `extensions/custom-provider-claude-agent-sdk/session.ts` — replace nullable-state inference and `TurnHandoffPlan` with explicit continuity/startup variants and transitions.
- `extensions/custom-provider-claude-agent-sdk/index.ts` — make `session_compact` request reseeding rather than generic structural reset.
- `extensions/custom-provider-claude-agent-sdk/session.test.ts` — add direct transition and branch-rehydration tests.

### Validation

#### Automated

- [ ] `bun test extensions/custom-provider-claude-agent-sdk/session.test.ts`.
- [ ] Existing provider tests.
- [ ] `bun run typecheck`.

#### Evals / Regression Checks

- [ ] Live/resumable normal turns still skip rebuilding context.
- [ ] Reload between compaction and next prompt preserves reseed intent.
- [ ] Failed reseed remains retryable.
- [ ] New/fork never inherits a reseed marker accidentally.
- [ ] Tree-selected branches cannot reuse another branch's seed state.

## Phase 6: Integrate Native Reseeding and Cut Over

Wire the startup plan into query creation. For a reseed plan:

1. build Pi context through the entry immediately before the current prompt;
2. translate and encode it;
3. persist it under a fresh Claude session UUID;
4. call `query()` with `resume` and the durable store;
5. enqueue only the current querying prompt;
6. capture the resumed Claude session ID through the existing event stream;
7. transition to ordinary continuity after normal sync.

The trailing-tool-result recovery route must use the same seed mechanism with all context included and retain only its necessary synthetic continuation prompt. It must not enqueue a non-querying prose handoff.

### File Changes

- `extensions/custom-provider-claude-agent-sdk/sdk/query.ts` — add explicit new/resume/reseed startup options; pass `sessionStore` only when the session is owned by the store; remove post-compaction non-querying handoff enqueue.
- `extensions/custom-provider-claude-agent-sdk/session.ts` — own or resolve the durable store/session association across query closure.
- `extensions/custom-provider-claude-agent-sdk/sdk/query.test.ts` — replace flattened-handoff assertions with seeded-store assertions.
- `extensions/custom-provider-claude-agent-sdk/index.ts` — provide Pi agent-directory/store configuration if this cannot remain internal to the store module.

### Validation

#### Automated

- [ ] `bun test extensions/custom-provider-claude-agent-sdk/sdk/query.test.ts` — proves `resume + sessionStore`, no handoff message, current prompt exactly once, and tool-result continuation behavior.
- [ ] `bun test extensions/custom-provider-claude-agent-sdk`.
- [ ] `bun run typecheck`.
- [ ] Opt-in real-SDK integration test using the production encoder/store path.

#### Evals / Regression Checks

- [ ] Post-compaction query options contain `resume` and `sessionStore`, never conflicting `sessionId`.
- [ ] The first queue message is the actual current prompt with `shouldQuery: true`.
- [ ] Pi's compaction summary appears unchanged in the seeded transcript.
- [ ] Retained assistant text is native assistant content, not user-quoted `Response:` prose.
- [ ] The observed Fable delegation prompt succeeds without the anti-duplication refusal in a recreated compacted test session.

#### STOP Condition

Stop if the production-shaped integration probe behaves differently from the disposable probes or if Fable still produces the same policy refusal with native roles. Do not remove diagnostic scaffolding or broaden the rollout until the discrepancy is understood.

## Phase 7: Verify Lifecycle Recovery and Remove Obsolete Paths

Close the remaining lifecycle gaps and remove the old post-compaction representation once native reseeding is proven.

Cover:

- close/reopen and print-mode query lifecycle;
- Pi process restart with durable-store resume;
- model switch away and back;
- `/tree` branch selection with valid continuity, reseed marker, and cold history;
- repeated Pi compactions;
- compaction after a seeded session has resumed normally;
- split-turn/trailing-tool-result recovery;
- store absence/corruption and SDK format drift diagnostics.

Remove prose handoff builders used only by post-compaction and tool-result recovery. Retain a cold-start handoff only if a currently exercised non-compaction path still requires it; otherwise remove the obsolete shape completely rather than supporting both contracts.

### File Changes

- `extensions/custom-provider-claude-agent-sdk/handoff.ts` — delete obsolete prose conversion and leave only any independently required cold-start boundary helper.
- `extensions/custom-provider-claude-agent-sdk/sdk/query.ts` — remove fallback branches and temporary probe diagnostics.
- `extensions/custom-provider-claude-agent-sdk/session.ts` — finalize cleanup/retention ownership.
- `extensions/custom-provider-claude-agent-sdk/index.ts` — finalize shutdown/tree/model lifecycle wiring.
- Relevant tests under `extensions/custom-provider-claude-agent-sdk/` — add lifecycle regressions through public session/query seams.
- `README.md` — document native post-compaction continuation and the private-format upgrade gate if this provider behavior is public to users.

### Validation

#### Automated

- [ ] `bun test extensions/custom-provider-claude-agent-sdk`.
- [ ] `bun run typecheck`.
- [ ] Opt-in seeded-resume integration gate against pinned SDK/CLI.

#### Evals / Regression Checks

- [ ] Search confirms no post-compaction code emits `<session_state>`, `Response:`, or the old continuation handoff.
- [ ] A second ordinary turn after seeded startup resumes without reseeding.
- [ ] Restart and branch navigation select only matching Pi-owned store sessions.
- [ ] Missing/corrupt store data fails explicitly and does not silently switch context shapes.
- [ ] SDK/CLI version assumptions are centralized and documented.

## Open Questions

- The exact Pi-owned storage root should be selected from the runtime's configured agent directory during planning; do not hardcode `~/.pi/agent` because rebranded/custom agent directories exist.
- Cleanup retention needs a concrete policy in the final plan: immediate deletion on unreachable branch/session cleanup versus bounded age-based cleanup. Recommendation: preserve while the Pi session references the seed, then use conservative age-based cleanup for orphaned files.
- The real-SDK test needs a stable opt-in convention that cannot run authenticated traffic during ordinary `bun test`. The final plan should name the exact environment variable and command.

## Acceptance

Accepted 2026-07-10. The final plan should resolve the configured-agent-directory storage root, conservative orphan cleanup policy, and authenticated integration-test convention without reopening the accepted architecture.
