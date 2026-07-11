---
type: plan
repo: pi-o-my
branch: working-copy
sha: ced94441
status: implemented
source_structure_outline: .agents/plans/features/claude-agent-sdk-native-reseed/002-structure-outline.md
---

# Implementation Plan: Resume Native Claude History After Pi Compaction

> **Executor instructions:** Follow this plan with no hidden session context. Run every verification gate before proceeding. The real-SDK probes are hard gates, not optional confidence checks. If a STOP condition occurs, write a handback describing current state, desired outcome, evidence, and remaining questions; do not improvise a fallback context shape.

## Planning Sources

- **Design discussion:** `.agents/plans/features/claude-agent-sdk-native-reseed/001-design-discussion.md`
- **Structure outline:** `.agents/plans/features/claude-agent-sdk-native-reseed/002-structure-outline.md`
- **Research:** reconnaissance summarized in the design discussion; installed SDK declarations at `node_modules/.bun/@anthropic-ai+claude-agent-sdk@0.2.141+27912429049419a2/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

## Status

- **Status:** Implemented with Claude compact-state emulation on 2026-07-10
- **Effort:** L
- **Risk:** HIGH — relies on a pinned but private Claude JSONL entry format
- **Planned at:** jj revision `ced94441`, 2026-07-10
- **Execution result:** Ordinary native-role replay failed for realistic narration plus tool use. A follow-up probe reproduced Claude's own `compact_boundary` + `isCompactSummary` shape; the production encoder now places Pi's summary and retained recent details inside that envelope. It passes on `claude-fable-5` and resumes twice without tool replay.
- **Preserved artifact:** Authenticated probe commit `nlylqxpu` (`test: prove native Claude transcript resume`).

## Why This Matters

Pi's compaction summary and kept-recent selection are the desired source of truth. The Claude Agent SDK provider currently rebuilds that context as one synthetic user message after compaction, so prior assistant and tool output appears to Anthropic as user-supplied model output. Fable 5 rejects the request under the anti-duplication policy. This implementation preserves Pi compaction while translating the rebuilt context into Claude's native compacted-session shape and resuming it through the SDK's `SessionStore` seam.

## Standards Concern

This is a provider/runtime boundary. Follow `coding-standards/references/boundaries.md`: Pi-native messages become a small internal seed representation, then Claude-native opaque entries in one adapter. Follow `references/state.md`: post-compaction reseeding is an explicit lifecycle state, not another interpretation of nullable continuity fields. Follow `references/verification.md`: only a real SDK resume proves the private transcript format works.

## What Better Means

- Pi's `compact()` implementation, summary, cut point, kept-recent messages, split-turn behavior, and tree history stay unchanged.
- The current user prompt is sent exactly once and is not embedded in the seed.
- Retained assistant output and completed tool details are preserved inside Claude's native compact-summary entry.
- Completed historical tools are context only and are never replayed.
- A successful reseed becomes ordinary resumable Claude continuity.
- Query closure and Pi process restart can resume through a durable Pi-owned store.
- Unsupported conversion, corrupt storage, or SDK format drift fails explicitly without flattening or dropping context.

## Current-State Evidence

- `extensions/custom-provider-claude-agent-sdk/compaction.ts:56-91` — already delegates to Pi's exported `compact()` and must remain the compaction path.
- `extensions/custom-provider-claude-agent-sdk/index.ts:48-52` — `session_compact` currently performs a generic structural reset.
- `extensions/custom-provider-claude-agent-sdk/session.ts:14-18` — continuity is three nullable fields and cannot represent pending reseed distinctly.
- `extensions/custom-provider-claude-agent-sdk/session.ts:401-424` — reset closes the query and persists all-null continuity.
- `extensions/custom-provider-claude-agent-sdk/session.ts:449-501` — turn preparation classifies live/resumable/cold and selects a prose handoff for cold state.
- `extensions/custom-provider-claude-agent-sdk/handoff.ts:60-121` — roles are flattened; assistant text is currently headed `Response:` and tool protocol identity is lost.
- `extensions/custom-provider-claude-agent-sdk/sdk/query.ts:376-439` — the handoff is enqueued as a non-querying SDK user message before the actual prompt.
- `extensions/custom-provider-claude-agent-sdk/sdk/query.ts:289-312` — trailing-tool-result recovery bypasses normal turn planning and creates a flattened continuation handoff.
- `extensions/custom-provider-claude-agent-sdk/sdk/query.ts:504-542` — query startup already has a single seam where `resume`, queue, MCP servers, and live-query ownership are assembled.
- Installed `sdk.d.ts:1340-1376,1560-1574,3782-3890` — `SessionStore.load()` materializes opaque entries for resume; `resume` may be used with `sessionStore`; conflicting `sessionId` is forbidden unless forking; concrete entries are private.

## Commands You Will Need

| Purpose | Command | Expected on success |
|---|---|---|
| Working-copy status | `jj st` | Shows only understood changes; never discard unrelated scout-definition changes |
| Drift check | `jj diff --from ced94441 -- extensions/custom-provider-claude-agent-sdk package.json bun.lock README.md` | Empty or only reviewed changes made while executing this plan |
| Provider tests | `bun test extensions/custom-provider-claude-agent-sdk` | All provider tests pass; authenticated integration tests report skipped unless opted in |
| Query tests | `bun test extensions/custom-provider-claude-agent-sdk/sdk/query.test.ts` | All query routing tests pass |
| Typecheck | `bun run typecheck` | Exit 0 |
| Authenticated gate | `PI_CLAUDE_AGENT_SDK_RUN_INTEGRATION=1 bun test extensions/custom-provider-claude-agent-sdk/sdk/session-store.integration.test.ts` | Native text and completed-tool transcript scenarios pass against SDK 0.2.141 |

## Scope

### In Scope

- `extensions/custom-provider-claude-agent-sdk/compaction.ts` — only if comments/types need to expose unchanged compaction ownership
- `extensions/custom-provider-claude-agent-sdk/index.ts`
- `extensions/custom-provider-claude-agent-sdk/session.ts`
- `extensions/custom-provider-claude-agent-sdk/session.test.ts` (new)
- `extensions/custom-provider-claude-agent-sdk/handoff.ts`
- `extensions/custom-provider-claude-agent-sdk/sdk/query.ts`
- `extensions/custom-provider-claude-agent-sdk/sdk/query.test.ts`
- `extensions/custom-provider-claude-agent-sdk/sdk/session-store.integration.test.ts` (new)
- `extensions/custom-provider-claude-agent-sdk/sdk/debug.ts` if metadata-only events are needed
- `extensions/custom-provider-claude-agent-sdk/tools/names.ts` only for an exported native MCP-name mapper
- `extensions/custom-provider-claude-agent-sdk/transcript/` (new)
- `extensions/custom-provider-claude-agent-sdk/session-store.ts` (new)
- `extensions/custom-provider-claude-agent-sdk/session-store.test.ts` (new)
- `extensions/custom-provider-claude-agent-sdk/package.json` or root `package.json` only if a script is needed
- `README.md` for public provider behavior and upgrade gate
- This feature bundle for execution status updates

### Out of Scope

- `extensions/scouts/**` — unrelated working-copy changes belong to another effort.
- Pi core or installed package files — dependency sources are evidence, not edit targets.
- `~/.claude/projects/**` — never create or mutate generated seed sessions there.
- Claude-owned auto-compaction.
- Stale-context and soft-threshold reseeding in the initial production cutover.
- Claude compact-boundary metadata, thinking blocks, or thinking signatures.
- Multi-version transcript compatibility.
- Automatic age-based transcript deletion in v1. A Pi session may be resumed long after an arbitrary TTL; without a proven global reference index, age is not proof of orphanhood.

## Resolved Implementation Details

### Storage Root

Resolve the root through Pi's configured agent directory, using the exported `getAgentDir()` rather than hardcoding `~/.pi/agent`:

```text
<getAgentDir()>/state/claude-agent-sdk/sessions/<pi-session-id>/<claude-session-id>.jsonl
```

The store module owns path validation and must reject IDs that are not valid UUID/session identifiers before path construction.

### Retention

Do not perform automatic age-based cleanup in v1. Preserve a transcript while any persisted Pi branch may reference it. Delete only:

- temporary test stores;
- a newly created seed that fails before its reseed/session association is persisted;
- a store explicitly deleted through an extension-owned, targeted lifecycle operation with proven ownership.

Document orphan cleanup as deferred until the extension can enumerate references across Pi session branches safely. This is more conservative than a TTL and avoids breaking old resumable sessions.

### Integration-Test Convention

Use exactly `PI_CLAUDE_AGENT_SDK_RUN_INTEGRATION=1`. Without that value, the real-SDK suite must skip before creating a query or touching credentials. The test uses existing Claude OAuth, never prints credentials, and uses a temporary cwd/config/store.

## Implementation Routing

Land as three changes, each green and reviewable:

1. **Probe:** Real SDK text and tool-history resume tests. No production behavior changes.
2. **Foundation:** Transcript adapter, durable store, and explicit lifecycle state with unit tests. Existing production handoff remains until all foundation tests pass.
3. **Cutover:** Query reseed startup, split-turn integration, lifecycle regressions, and deletion of obsolete post-compaction flattening.

Use `jj commit` after each completed change if executing sequentially. Do not fold unrelated working-copy changes into these commits.

## Phase 1 — Prove the SDK Resume Seam

### Overview

Prove both required private transcript shapes through the actual pinned SDK before production modules depend on them.

### Changes Required

#### 1.1 Add an opt-in real-SDK harness

**File:** `extensions/custom-provider-claude-agent-sdk/sdk/session-store.integration.test.ts`

Use `InMemorySessionStore`, a temporary cwd, valid UUIDs, and the installed executable resolution pattern from `sdk/query.ts:31-52`. Skip the entire suite unless `PI_CLAUDE_AGENT_SDK_RUN_INTEGRATION === "1"`.

The harness must:

- append an ordinary linear transcript under the project key expected for the temporary cwd;
- call `query()` with `resume` and `sessionStore`, never conflicting `sessionId`;
- set `tools: []`, `allowedTools: []`, and non-mutating permissions;
- consume through a final result and capture assistant text;
- close the query;
- resume the same store/session again and prove continued access;
- keep transcript content harmless and deterministic enough for a semantic assertion.

Do not use Claude compact-boundary entries. Use only observed native user and assistant envelopes. Isolate raw entry construction inside this test until the probe passes.

#### 1.2 Prove text-role history

Seed a fact only in assistant-role history. Ask the resumed model to return that fact in a constrained short answer. Assert the fact appears. Assert the store receives subsequent mirrored entries and supports a second resume.

#### 1.3 Prove completed tool history

Add a second scenario with:

```text
user request
assistant tool_use(id = X)
user tool_result(tool_use_id = X)
assistant acknowledgement
```

Use an inert historical tool name. Register no corresponding live tool. Ask for a fact only in the result and assert no live tool-use event occurs.

### Success Criteria

#### Automated Verification

- [ ] `bun test extensions/custom-provider-claude-agent-sdk/sdk/session-store.integration.test.ts` without env — skipped, no query created.
- [ ] `PI_CLAUDE_AGENT_SDK_RUN_INTEGRATION=1 bun test extensions/custom-provider-claude-agent-sdk/sdk/session-store.integration.test.ts` — both scenarios pass.
- [ ] `bun run typecheck` — exit 0.

#### STOP Conditions

- Minimal text history is rejected, ignored, or cannot be resumed twice.
- Completed tool history is replayed, rejected, or silently removed.
- The SDK writes generated sessions into the user's normal Claude project directory despite the store/temp setup.
- Passing requires fabricating compact-boundary metadata or thinking signatures.

If any occurs, stop after the probe commit (or leave it uncommitted if useless) and write a handback. Do not proceed to foundation work.

## Phase 2 — Build the Boundary, Store, and Lifecycle Foundation

### Overview

Create the production types and state transitions without switching production queries away from the characterized handoff yet.

### Changes Required

#### 2.1 Extract Pi context selection from prose formatting

**File:** `extensions/custom-provider-claude-agent-sdk/handoff.ts`

Separate the valuable boundary logic—build visible Pi context through the entry before the current user prompt—from text rendering. Give it a role-neutral name and return `AgentMessage[]`/the existing Pi context type. Keep current handoff behavior temporarily so this phase remains behavior-preserving.

Provide a second entry point for the trailing-tool-result route that accepts all already-built context messages.

#### 2.2 Define an internal transcript seed

**Files:**

- `extensions/custom-provider-claude-agent-sdk/transcript/types.ts`
- `extensions/custom-provider-claude-agent-sdk/transcript/from-pi.ts`
- `extensions/custom-provider-claude-agent-sdk/transcript/from-pi.test.ts`

Model user content, assistant text/tool use, and grouped tool results without Claude JSONL metadata. Return a discriminated result:

```ts
type SeedBuildResult =
  | { kind: "ready"; seed: ClaudeTranscriptSeed }
  | { kind: "unsupported" | "invalid-tool-history"; message: string; messageIndex?: number };
```

Requirements:

- preserve Pi compaction/branch summary wrapper text unchanged;
- exclude thinking rather than copying or synthesizing it;
- preserve images only when the observed SDK transcript form accepts them;
- preserve tool IDs, names, arguments, result text/images, and error status;
- group sibling results in valid native user turns;
- reject dangling/missing/duplicate/mismatched tool relationships;
- never silently skip an unsupported role/block.

Use dependency-native Pi types at this boundary. Do not introduce Claude JSONL fields here.

#### 2.3 Encode the pinned Claude transcript shape

**Files:**

- `extensions/custom-provider-claude-agent-sdk/transcript/to-claude.ts`
- `extensions/custom-provider-claude-agent-sdk/transcript/to-claude.test.ts`

Own all private fields in this module. Annotate the observed contract as SDK 0.2.141 / Claude Code 2.1.141. Inject UUID and clock capabilities for deterministic tests. Produce:

- valid session and entry UUIDs;
- one linear `parentUuid` chain;
- consistent `sessionId`, cwd, timestamp, entrypoint, and version;
- native assistant API envelopes with text/tool-use content and zeroed usage placeholders;
- user entries with native tool-result blocks and matching source assistant UUID where required by the observed shape;
- no thinking and no compaction metadata.

Map Pi tools to their SDK MCP names using `tools/names.ts`; keep mapping policy outside query control flow.

#### 2.4 Implement the durable store

**Files:**

- `extensions/custom-provider-claude-agent-sdk/session-store.ts`
- `extensions/custom-provider-claude-agent-sdk/session-store.test.ts`

Implement only the `SessionStore` methods used by explicit resume: `append`, `load`, and targeted `delete`. Store under the resolved root documented above.

Requirements:

- append serialization per transcript;
- UUID deduplication while preserving non-UUID entries;
- atomic replacement/durable write strategy using normal Node filesystem APIs in the module (project instructions against shell editing do not prohibit production filesystem code);
- process-restart load through a fresh store instance;
- path traversal rejection;
- metadata-only errors and debug events;
- no optional listing/subagent/summary methods.

#### 2.5 Add explicit reseed lifecycle state

**Files:**

- `extensions/custom-provider-claude-agent-sdk/session.ts`
- `extensions/custom-provider-claude-agent-sdk/session.test.ts`
- `extensions/custom-provider-claude-agent-sdk/index.ts`

Replace `TurnHandoffPlan` with a startup variant that distinguishes continue, ordinary cold, and pending reseed. Persist branch-local reseed intent in the existing custom continuity entry rather than adding an unrelated second source of truth.

Required transitions:

- Pi `session_compact` → pending reseed;
- reload before next prompt → pending reseed survives;
- failed build/store/query startup → pending reseed survives;
- successful SDK session capture → store association and captured continuity;
- `turn_end` → ordinary synced continuity;
- new/fork → cold, not reseed;
- tree hydration → branch-local state;
- switching away/back with valid SDK continuity → resume, not reseed.

Limit production creation of reseed markers to Pi compaction. Keep stale/soft-reset behavior unchanged in this phase.

### Success Criteria

#### Automated Verification

- [ ] `bun test extensions/custom-provider-claude-agent-sdk/transcript` — all conversion/encoding cases pass.
- [ ] `bun test extensions/custom-provider-claude-agent-sdk/session-store.test.ts` — store behavior passes.
- [ ] `bun test extensions/custom-provider-claude-agent-sdk/session.test.ts` — lifecycle transitions pass.
- [ ] `bun test extensions/custom-provider-claude-agent-sdk/sdk/query.test.ts` — characterized production query behavior still passes.
- [ ] `bun run typecheck` — exit 0.
- [ ] Authenticated integration test rerun using the production encoder entries — passes.

#### Evals / Regression Checks

- [ ] Every Pi input message is represented or returns a classified failure.
- [ ] Private Claude JSONL vocabulary is confined to `transcript/to-claude.ts`, `session-store.ts`, and tests.
- [ ] A fresh store instance loads the exact deep-equal entries written by the previous instance.
- [ ] Reload and tree tests prove branch-local reseed intent.

## Phase 3 — Cut Over Post-Compaction Startup

### Overview

Use the proven foundation for post-compaction startup, verify lifecycle recovery, then remove the obsolete flattened representation from those paths.

### Changes Required

#### 3.1 Add explicit query startup sources

**File:** `extensions/custom-provider-claude-agent-sdk/sdk/query.ts`

Make `ensureLiveQuery()` accept a startup source rather than deriving all behavior from nullable SDK continuity:

```ts
type QueryStartup =
  | { kind: "new" }
  | { kind: "resume"; sessionId: string; sessionStore?: SessionStore }
  | { kind: "reseed"; sessionId: string; sessionStore: SessionStore };
```

For reseed:

1. obtain Pi context through the prior entry boundary;
2. build and encode the seed;
3. persist it before query creation;
4. call `query()` with `resume` and `sessionStore` only;
5. enqueue the current prompt as the first and only message for that run;
6. preserve reseed state until SDK session capture succeeds.

A store-backed seeded session must continue passing its store on later resume after query closure. Store association is session state, not a one-call local variable.

#### 3.2 Convert trailing-tool-result recovery

**File:** `extensions/custom-provider-claude-agent-sdk/sdk/query.ts`

Replace `buildContextMessagesContinuationHandoff()` in the fresh trailing-tool-result path. Seed all provided context, then send the existing continuation instruction only as the querying prompt. Ensure historical tools are complete and cannot be confused with pending live bridge calls.

#### 3.3 Replace query tests

**File:** `extensions/custom-provider-claude-agent-sdk/sdk/query.test.ts`

Update the query mock to capture options and inspect the supplied store. Assert:

- `resume` equals the seed session ID;
- `sessionStore` is present;
- `sessionId` is absent;
- loaded entries have native roles and tool pairing;
- no `shouldQuery:false` handoff is emitted;
- the first queue input is the actual prompt or necessary split-turn continuation prompt;
- subsequent close/reopen resumes the same store without reseeding.

Do not pin private helper choreography beyond the externally relevant query options, loaded transcript, and queue messages.

#### 3.4 Verify lifecycle recovery

Add behavior coverage for:

- first turn after compaction;
- second ordinary turn;
- query close/reopen and print mode;
- process restart using a new store/session-manager instance;
- model switch away/back;
- tree navigation among valid continuity, pending reseed, and cold branches;
- repeated Pi compactions;
- malformed/missing store entry and SDK load failure;
- compaction split turn ending in tool results.

#### 3.5 Remove obsolete post-compaction flattening

**Files:** `handoff.ts`, `sdk/query.ts`, tests

Delete the post-compaction and trailing-tool-result prose builders and their `<session_state>`, `User:`, and `Response:` rendering once no production caller remains. If an ordinary non-compaction cold-start path still uses prose handoff, keep only that proven obligation under a name that does not imply it handles compaction. Do not support both native and flattened post-compaction contracts.

#### 3.6 Document the behavior and upgrade gate

**File:** `README.md`

Document:

- Pi remains the compaction owner;
- post-compaction Claude continuity uses a private Pi-owned `SessionStore` transcript;
- SDK/CLI pins must not be upgraded without the authenticated seeded-resume gate;
- the exact opt-in command;
- where state is stored and that automatic orphan cleanup is deferred.

### Success Criteria

#### Automated Verification

- [ ] `bun test extensions/custom-provider-claude-agent-sdk` — all unit tests pass and integration suite skips normally.
- [ ] `bun run typecheck` — exit 0.
- [ ] `PI_CLAUDE_AGENT_SDK_RUN_INTEGRATION=1 bun test extensions/custom-provider-claude-agent-sdk/sdk/session-store.integration.test.ts` — text, tool history, production encoder/store, close, and resume pass.

#### Evals / Regression Checks

- [ ] Recreate the reported compacted Fable session shape and submit a benign delegation prompt; no anti-duplication refusal occurs.
- [ ] Search confirms no post-compaction caller emits `<session_state>` or `Response:` prose.
- [ ] Pi summary text is byte-for-byte unchanged in the seeded user-context entry.
- [ ] Retained recent assistant/tool state remains present after compaction.
- [ ] A missing or corrupt store produces an explicit retryable error and never a flattened or summary-only fallback.
- [ ] No generated seed appears under `~/.claude/projects`.

## Autonomy Boundary

- **Routine execution may include:** file/module naming within the accepted boundaries; deterministic UUID/clock test helpers; metadata-only debug event names; filesystem implementation details that satisfy the store contract.
- **Design review required:** any need to fabricate Claude compaction metadata; any unsupported Pi message that cannot be represented without omission; any change that routes stale/soft-reset paths through reseeding; any need to expose private transcript types outside the adapter.
- **Human approval required:** fallback that loses context or returns to flattened assistant output; writing generated sessions to `~/.claude/projects`; enabling authenticated tests by default; automatic deletion of persisted transcript state.

## Drift Checks

Before each routed change:

- [ ] Run `jj diff --from ced94441 -- extensions/custom-provider-claude-agent-sdk package.json bun.lock README.md`.
- [ ] Re-open the installed SDK declarations around `Options.sessionStore`, `Options.resume`, and `SessionStoreEntry`; confirm version remains 0.2.141.
- [ ] Confirm `compaction.ts` still calls Pi's exported `compact()`.
- [ ] Confirm the real transcript examples still match the encoder assumptions if Claude Code was upgraded locally.
- [ ] Run `jj st` and exclude unrelated scout changes from commits.

## STOP Conditions

Stop and write a handback if:

- Either real-SDK probe fails its semantic claim.
- The installed SDK or bundled CLI version differs from 0.2.141 before the encoder is implemented.
- Resume requires Claude private compact-boundary metadata or thinking signatures.
- Any Pi rebuilt-context message would be silently omitted.
- Tool history cannot be represented as completed native pairs without replay.
- A durable store cannot survive query closure and process restart through the SDK's materialization path.
- Fable still emits the same anti-duplication refusal with native roles.
- Production integration requires touching `extensions/scouts/**`, Pi core, or `~/.claude/projects/**`.
- Tests require making private transcript internals part of a broad production API.

## Rejected Approaches

- **Claude Code owns compaction:** rejected because Pi and Claude context would diverge across models, tree navigation, and resume.
- **Further handoff wording changes:** rejected by the failed neutral-framing experiment.
- **Summary-only fallback:** rejected because Pi intentionally retains recent unsummarized context.
- **Automatic flattened fallback:** rejected because it restores the observed policy failure and creates dual contracts.
- **Direct `~/.claude/projects` writes:** rejected because generated Pi projections would pollute user-owned Claude sessions.
- **Fabricated Claude compaction entries:** rejected because their private relinking metadata is unnecessary for an ordinary linear seed.
- **In-memory production store:** rejected because process restart and closed-query resume are required.
- **TTL cleanup in v1:** rejected because age alone does not prove a Pi branch no longer references the transcript.

## Test Plan

### Unit

- Pi context boundary excludes current prompt.
- Compaction and branch summaries preserve Pi wrapper text.
- User/assistant role conversion, images, multiple assistant blocks.
- One/multiple completed tool pairs, error results, sibling grouping.
- Dangling, mismatched, duplicated, and unsupported blocks fail explicitly.
- Encoder parent chain, UUID/session consistency, MCP names, no thinking/compaction metadata.
- Store append/load/restart/dedup/concurrency/path rejection/delete.
- Lifecycle state across compact/reload/retry/capture/sync/new/fork/tree/model switch.
- Query options and queue behavior for reseed and trailing-tool-result recovery.

### Real SDK

- Text assistant history materializes and influences response.
- Completed tool history materializes, influences response, and does not replay.
- Production encoder/store path works.
- Query close and second resume work.
- Test remains skipped without explicit opt-in.

### Final Commands

- [ ] `bun test extensions/custom-provider-claude-agent-sdk`
- [ ] `bun run typecheck`
- [ ] `PI_CLAUDE_AGENT_SDK_RUN_INTEGRATION=1 bun test extensions/custom-provider-claude-agent-sdk/sdk/session-store.integration.test.ts`

## Done Criteria

- [ ] All three routed changes are independently green and reviewable.
- [ ] Real SDK text and tool-history gates pass.
- [ ] Pi compaction code and summary behavior are unchanged.
- [ ] Post-compaction startup uses native seeded history and current prompt exactly once.
- [ ] Durable resume works after close and restart.
- [ ] Unsupported or corrupt state fails explicitly and remains retryable.
- [ ] Obsolete post-compaction flattening is removed.
- [ ] README documents storage, opt-in gate, and pinned-format maintenance obligation.
- [ ] No unrelated scout changes are included in implementation commits.

## Execution Result

The first probe established a narrower boundary than the original design assumed:

- Fable accepts seeded native user → assistant text history.
- Fable accepts a minimal seeded completed tool turn.
- Fable rejects ordinary imported assistant narration followed by tool use, regardless of combined/split entries or shared/distinct fabricated API message IDs.

A follow-up probe inspected Claude's real post-`/compact` transcript shape and found the missing semantic marker: a `compact_boundary` system entry followed by an `isCompactSummary` user entry. Encoding Pi's summary and exact retained recent text/tool details inside that compact-summary entry passes the realistic Fable probe. The production encoder passes a second resume as well, and an unsynchronized first turn is retried with a fresh seed to avoid duplicate prompt submission.

## Executor Notes

The private Claude entry format is the volatile edge; keep it small and version-annotated. The internal seed model and Pi lifecycle should not know JSONL fields. Do not optimize transcript size in this effort: first preserve Pi's exact rebuilt context and prove correctness. If transcript size later becomes a concern, treat it as a measured follow-up rather than dropping context during this migration.
