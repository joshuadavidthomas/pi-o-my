# Dynamic agents & workflows for scouts

Status: draft (2026-07-06). Research and mechanics validated by four spikes; no implementation yet.

## Motivation

Scouts today are a fixed catalog: six predefined tools (`finder`, `librarian`, `oracle`, `specialist`, `reviewer`, `worker`) with static schemas. Fable-class models are trained to *compose* agents and *write orchestration* — Claude Code exposes this through exactly two surfaces: the `Agent` tool (ephemeral spawn: `subagent_type` + `prompt` + `name` + background/resume semantics) and dynamic workflows (model-written JS calling `agent()`/`pipeline()`, up to 16 concurrent / 1,000 agents per run, intermediate results held in script variables instead of the orchestrator's context). Running fable-5 in pi without either surface leaves trained capability on the table.

Notably, even Claude Code does **not** let the model define persistent new agent *types* at runtime. The dynamism that matters is (a) per-call agent composition and (b) model-written orchestration scripts. That's what this design adds — plus a leg no other pi extension has: durable, observable, *remote* workers via herdr.

## Landscape (compressed)

Four patterns across harnesses:

1. **Predefined selection** — pick from a catalog (Claude Code `.claude/agents/*.md`; scouts today).
2. **Ephemeral dynamic spawn** — compose prompt + tools + model per call (Claude Code `Agent` tool; HazAT/pi-interactive-subagents `systemPrompt` param).
3. **Model-written orchestration** — the model writes a script that spawns agents; results stay out of its context (Claude Code dynamic workflows; Cloudflare Code Mode over Worker Loader isolates).
4. **Peer teams** — durable sibling sessions with coordination primitives (Claude Code Agent Teams; tmustier/pi-agent-teams; **herdr** as agent-agnostic substrate).

Existing pi ecosystem (re-audited 2026-07-06 — it moved fast since the first pass):

- **Pattern (a) — markdown/frontmatter agent definitions enumerated into a generic tool — is now table stakes**: first-party `pi-mono` subagent example, tintinweb/pi-subagents (`.pi/agents/<name>.md` + `subagent_type`), nicobailon/pi-subagents, melihmucuk/pi-crew, kky42/pi-flow, ruizrica/agent-pi all do it.
- **Pattern 3 (model-written orchestration) is no longer unique** — at least four engines: Michaelliv/pi-dynamic-workflows (sandboxed JS with `agent`/`parallel`/`pipeline`; prototype, no persistence), timbrinded/pi-workflow-engine (inline + saved TS workflows, **in-process `AgentSession` children**, worktree isolation, resumable journals), samfoy/pi-workflows (persistent runs, per-agent memory/worktrees, HITL interrupts, OTel), kky42/pi-flow (trusted saved JS workflows, multi-backend pi/Codex/Claude Code children).
- **Per-agent custom tools exist too**: nicobailon's `subagentOnlyExtensions:` frontmatter loads extension files only into that agent's child sessions; tintinweb scopes per-agent `extensions:` / `tools: ext:<x>/<y>`.
- Borrowable specifics: frontmatter-referenced child-only extensions (nicobailon), resumable workflow journals (timbrinded), compact `<final_answer>` output contracts (KristjanPikhof/pi-agents-team).

What remains genuinely absent from the ecosystem: herdr-backed durable/observable/remote fleets, explicit lock/workspace mutation invariants, and jj-native workspace isolation that captures dirty `@`. That — plus integration with scouts' tuned presets and the existing suspend/resume runs engine — is scouts' differentiation now, not workflow scripting per se.

## What the spikes validated

**Spike 1 — herdr one-shots (inside herdr).** Split panes + `pi -p --no-session` works but is the worst of both worlds for quick tasks: subprocess startup, shell-init noise in transcripts, and `wait output` matches *scrollback* (a reused sentinel from a failed run matched instantly). One-shot children need file-based results and per-run nonces. Verdict: don't use herdr for cheap fan-out.

**Spike 2 — outside-in orchestration.** The herdr CLI works from *outside* herdr (resolves the daemon socket; `HERDR_ENV` is etiquette, not enforcement). The `herdr agent` command set is the real API:

- `agent start <name> --cwd --env KEY=V --workspace/--split -- <argv>` — named spawn, env injection
- `agent wait <target> --status idle|working|blocked` — real lifecycle status (requires `herdr integration install pi` on the box; the integration is "lifecycle authority", vs screen-manifest guessing)
- `agent get` exposes the child's **session JSONL path** → parse final assistant message; never screen-scrape results
- `agent read/send/focus/attach --takeover`, `worktree create --branch --base`, `notification show`
- Full loop validated: spawn → working → idle (12.5s) → structured result → close. Interactive TUI children, humanly watchable/steerable throughout.

**Spike 3 — remote fleet (sprites.dev).** Same loop, transport swapped to `sprite exec`. Validated: provisioning via installer + `npm i -g` + creds over stdin; headless server start via `setsid herdr --session fleet remote-client-bridge` (there is no `herdr server start`; `--remote` is viewer-attach only and rejects CLI subcommands); golden-image checkpoint in 0.67s. Provisioning gotchas that must be encoded in the backend:

- launch workers with `pi --approve` (trust prompt otherwise blocks headless children, reported as `idle`)
- worker auth must be **API keys, not OAuth** (stale OAuth failed refresh remotely; refresh tokens rotate and can collide across machines)
- `--env PATH=...` at `agent start`; provider config is read at pi startup (config changes ⇒ restart worker)
- pane ids compact; address by agent name, re-resolve pane ids via `agent get` right before use; unique agent names per run

**Spike 4 — detached research workers (real workload).** Two research agents (Amp/Orb and Swamp Club prior-art, see `research/`) ran detached on the sprite for ~30 min each and both delivered. New validations beyond spike 3:

- **Mid-run steering works**: `agent send <name> "<note>"` writes literal text; a follow-up `pane send-keys <pane> enter` submits it. Pi queues it as a steering message and delivers at the next turn boundary — a stuck worker course-corrected from a single note. This is the mechanism behind `fleet.send`.
- **Startup race observed live**: `agent get` reported `idle` with no `agent_session` path for ~15s after spawn while the pane visibly showed `Working...`. Never trust early `idle`; this is why the confirm-start step below is bounded and explicit.
- **`working` ≠ healthy**: a worker pegged a CPU core for 7+ minutes (twice) on a pathological `grep -E '.{0,4000}'` over huge single-line files while lifecycle status read `working` the whole time. Lifecycle status can't detect a stalled tool call; the session JSONL's mtime going stale while status is `working` is a cheap stall heuristic the widget/backend should surface (kill-the-pid + steer recovered it live).

**TUI constraints.** Pi extensions have no mouse events and OSC 8 is stripped per line. Fleet UX must be keyboard-driven: widgets (`ctx.ui.setWidget`), shortcuts (`pi.registerShortcut`), overlays (`ctx.ui.custom({overlay:true})` + `SelectList`). Runtime tool registration (`pi.registerTool` after startup, immediate refresh) is available if ever needed.

## Design overview

The catalog lands at **two tools** (decided 2026-07-06, superseding an interim six-tool shape): the tuned presets demote from tools to shipped markdown *definitions*, selectable through `agent`.

| Surface | Fate | Job |
|---|---|---|
| `agent` | **new tool** | any single in-process child: tuned preset (via `subagent_type`), inline persona, or mutating implementation |
| `workflow` | **new tool** | all orchestration: scripted fan-out *and* durable herdr fleet (`fleet.*` script API) |
| `finder` / `oracle` / `librarian` / reviewer lenses | **demoted** to first-party definitions shipped with the extension | tuned presets (where / how / external / judge) |
| `specialist` | **removed**, absorbed by `agent` (`skills` param) | — |
| `worker` | **removed**, absorbed by `agent` (`mutation` param) | — |

Dispatch is one question: *one child?* → `agent` (naming a definition when a preset fits); *many children, durable workers, or anything with coordination?* → `workflow`. Mutation semantics live in one place (`agent`'s `mutation` param), orchestration in one place (`workflow`'s script). The insight that collapsed the catalog: **the dispatcher is always a fable-class model, never a human** — a per-preset top-level tool name was an affordance with no consumer, while `subagent_type` over an enumerated definition list is exactly the shape Claude Code trains.

Two structural pieces make the demotion safe:

- **Tool pool.** The extension owns a static pool of non-mutating tools: base `read` + `bash`, plus the extended set that made librarian special (`github_search`, `web_search`, `web_fetch`, …). Definitions and call sites *select* from the pool by name; they cannot add to it. `mutation` remains the call-site switch that grants `edit`/`write` and chooses isolation, but a definition with an explicit tool allowlist must include both `Edit` and `Write` or the mutating call is rejected.
- **Pure-markdown definitions.** A definition is YAML frontmatter + body-as-system-prompt. Parsing markdown runs no code, so user definition files are safe by construction — no dynamic imports, no code-bearing definition dirs, no child-only extension loading. Cost, honestly: the pool is the union of everything any scout needs and grows only by editing the extension; users can't bring novel tools via definitions — the same constraint Claude Code ships, which hasn't hurt it. (MCP servers remain pi's answer for exotic user tools.)

The seam already exists: `executeScout(config, params, ...)` is generic over any runtime-built `ScoutConfig` (execute.ts); specialist and reviewer already build configs dynamically from files. Unknown config names already fall back to specialist model targets (models.ts). The work is the model-facing surface, not session machinery.

Guiding principle (repo convention): **model-facing affordances over enforcement** — constraints live in schema params (`mutation`, `mutation.isolation`, `worktree`), not prose rules, even where enforcement is soft.

A fleet **widget** (keyboard-driven herdr observability UX) ships alongside, but it's UI, not a tool.

### Definition format (portability-first)

Surveyed 2026-07-06 across Claude Code, the Claude Agent SDK, opencode, GitHub Copilot / VS Code, Gemini CLI, Roo/Cline, Cursor, the AGENTS.md standard, and seven pi ecosystem extensions (full survey: research/agent-definition-formats.md). The convergent core — YAML frontmatter with `name`/`description`/`tools`/`model`, markdown body as system prompt — is shared by Claude Code, the first-party pi-mono subagent example, Gemini CLI, opencode, and the community registries. Scouts adopts that core verbatim:

```yaml
---
name: librarian                                    # optional — filename is the fallback
description: external research — GitHub, docs, web # required (the routing hint fable dispatches on)
tools: read, github_search, web_search, web_fetch  # CSV or YAML list; pool names only
model: gemini-3-flash                              # optional; omit or `inherit` = default resolution
skills: [pdf-processing]                           # optional; preloaded, same semantics as call-site skills
---
You are an external research scout...
```

Portability rules (each mirrors a documented behavior elsewhere):

- **Field names are Claude Code's.** `name`, `description`, `tools`, `model`, `skills` with CC semantics; `name` optional with filename fallback (opencode/tintinweb/kky42 convention, subsumes CC's required name).
- **`tools` accepts a CSV scalar or a YAML list** — CC docs write CSV, its SDK/JSON and most other harnesses use arrays; accept both (tintinweb and pi-crew already do).
- **Tool names normalize** case-insensitively with an alias map for CC spellings (`Read`→`read`, `WebFetch`→`web_fetch`, `WebSearch`→`web_search`). Names not in the pool are ignored with a load-time warning — Copilot's documented behavior for unknown tools.
- **Unknown frontmatter fields are ignored** (first-party SKILL.md precedent). A Claude Code agent file carrying `permissionMode`, `color`, `maxTurns`, `memory` drops in and loads.
- **Locations:** shipped definitions inside the extension; user definitions at `~/.pi/agent/agents/*.md` (global) and `.pi/agents/*.md` (project) — the pi ecosystem convention (first-party example, tintinweb, pi-crew, agent-pi).

Conscious divergences (documented, not accidental):

- **Omitted `tools` = base pool (`read`+`bash`), not inherit-everything.** CC inherits all tools when the field is absent; scouts' read-only-by-default posture wins here.
- **`Edit`/`Write` in a `tools` list authorize, but do not activate, mutation.** The call site must still provide `mutation` and its required isolation. An explicit definition allowlist without both names cannot be expanded into a writer by the caller. CC's `isolation: worktree` frontmatter remains ignored because isolation belongs to `mutation.isolation` at the call site.
- **No `temperature`/`top_p`/`thinking` frontmatter** — poorly portable (only opencode and Gemini CLI standardize temperature; thinking spellings diverge across pi extensions) and call-site `effort` already owns that knob.

The iteration ladder stays cheap: inline `role` (no file) → markdown definition when the persona sticks → novel tool = an ordinary edit to the extension.

## Invariants

Stated up front; each surface below references them.

- **I1 — the shared checkout has one mutator.** The mutating-context lock guards exactly one resource: the user's live checkout. At most one context holds it at a time — a top-level shared-isolation mutating `agent`, or a workflow with shared-isolation mutating children (the workflow is the holder). Acquisition is **fail-fast**: a structured `LockBusy` error, no queueing, no blocking, no deadlock states. Workspace-isolated mutation (I7) takes no lock — its isolation is structural, not scheduled.
- **I2 — workflow accounts for every in-process child.** A workflow returns only after every spawned in-process child is terminal (completed / errored / aborted) and appears in the result accounting. No in-process child outlives its workflow. Fleet workers are the deliberate exception: durable, registry-tracked (I4), and allowed to outlive the script that spawned them.
- **I3 — fleet identity is pinned at spawn.** `collect` reads only the session JSONL path recorded for that specific spawn generation — never a re-derived pane id, never pane text, never a name that might match a stale worker.
- **I4 — fleet workers survive orchestrator crash discoverably.** Every durable worker has a registry entry written before the spawn returns; startup reconciles registry against `herdr agent list`.
- **I5 — active fleet workers are unique per target.** Spawn is rejected if an active registry entry on the same target shares the worker name, branch, or worktree path. Overlapping *file scopes* are explicitly not checked — merge conflicts are an expected terminal outcome surfaced to the orchestrator, not a prevented state.
- **I6 — every wait is bounded.** All wait operations have timeouts and defined terminal error states; nothing blocks forever on a dead or stuck worker.
- **I7 — workspace mutation is VCS-captured.** A workspace child edits only its own jj workspace / git worktree, forked from current state; its work product is a change-id/commit recorded in its result. Workspaces with unintegrated changes are never auto-deleted — a timed-out or aborted workspace child loses no work.

## Phase 1 — `agent` tool (replaces the preset catalog)

The one in-process child tool, matching the Claude Code `Agent` tool's shape (which is *not* read-only — subagents there get full tool access). It subsumes `specialist` (skills are just a persona *source*, not a different tool), `worker` (bounded mutation is just the `mutation` param — keeping both would leave two tools whose mutating modes differ only in bookkeeping), and the four tuned presets (which become shipped definitions selected by `subagent_type`).

```ts
agent({
  name: string,          // display + run-id prefix; also trained affordance from Claude Code
  task: string,          // user prompt for the child
  subagent_type?: string,// definition to run (shipped preset or user file); available names + descriptions
                         // enumerated in this schema's description (trained CC shape)
  role?: string,         // inline persona; layered LAST so per-call intent overrides skill/definition text
  skills?: string[],     // installed skills, eagerly injected in array order (absorbs specialist)
  tools?: string[],      // pooled non-mutating extras for inline experiments; unioned with the definition's list
  effort?: "quick"|"standard"|"thorough",    // maps to thinking level
  model?: string,        // optional target override, tried before defaults
  mutation?: {           // absent = read-only child (tools from pool selection, base read+bash). Presence grants edit/write (absorbs worker)
    isolation: "shared" | "workspace",  // required, no default — every mutating call explicitly picks:
                                        // shared = live checkout under the lock (I1); workspace = own jj workspace/git worktree, lock-free (I7)
    allowedPaths?: string[],            // intended edit scope (worker precedent)
    verificationCommands?: string[],    // run after mutation (worker precedent)
  },
  resume?: string,       // resume a suspended run; other params ignored (worker precedent)
})
```

The shape is deliberate — make illegal states unrepresentable rather than forbidden in prose:

- **Mutation is one optional object**, not a `readOnly` flag plus dependent params. `readOnly: true` with edit tools, `isolation` on a read-only agent, orphaned `allowedPaths` — none of these are expressible. The dependent params live inside the thing they depend on.
- **`tools` bounds mutation; `mutation` activates it.** Call-site `tools` draws only from the non-mutating pool. A definition's explicit `tools` list must include both `Edit` and `Write` before `mutation` can activate writing; call-site parameters cannot widen a read-only definition. Definitions that omit `tools` inherit the call-site capability choice. (Bash was never truly read-only anyway; the pool doesn't pretend otherwise.)
- **`subagent_type` supplies defaults; the call site wins.** A definition contributes its body (layered first), its tool selection, and its model; call-site `skills` then `role` layer after the body (recency dominates instruction conflicts), and call-site `model`/`effort`/`tools` override or extend.
- **`mutation.isolation` is required**, no default: the lock-vs-fork decision is the most consequential one a mutating call makes, so the schema forces it to be made consciously every time.
- **`skills` is a list**: skills are composable expertise units, injected in array order. `role` layers after them so the caller's per-call intent wins conflicts with static skill text (recency dominates instruction conflicts; the focusing instruction must sit below the material it filters).

Implementation notes:

- Build a `ScoutConfig` at runtime: `name: "agent:"+name`, `buildSystemPrompt` layers the definition body (if `subagent_type`), then skill bodies (in `skills` order), then `role`, then a scout-shaped frame (final-message-only contract, timeout note); mutating runs get the worker-style implementation framing. Tool set = pool selection (definition ∪ call-site `tools`, base `read`+`bash` when neither selects) + `edit`/`write` iff `mutation` is present and the selected definition's explicit allowlist includes both mutating tools.
- Definition loader: parse frontmatter per the format above at startup and on definitions-dir change; enumerate `name: description` pairs into `agent`'s schema description at registration. Shipped preset definitions port the current finder/oracle/librarian/reviewer prompts verbatim.
- `mutation: { isolation: "shared" }` acquires the mutating-context lock, fail-fast per I1: if another shared mutating `agent` or a shared-mutating workflow holds it, the call returns `LockBusy` immediately. Read-only and workspace-isolated agents run in parallel freely.
- Suspend/resume comes unchanged from the runs engine (registry max 5, 30 min TTL, wrap-up steering) — it served `worker`, now it serves top-level `agent` runs. Workflow children stay out of it (see Phase 2).
- Model resolution: `model` param → `configuredModel`; otherwise specialist fallback targets (already the behavior for unknown names). User config (`scouts.jsonc`) gains an `agent` key.
- Timeout: a timed-out shared mutating agent suspends (resumable, worker behavior today); partial edits in the live tree are reported. A timed-out workspace agent loses nothing regardless: its work sits in the workspace commit (I7).
- Rendering: reuse existing scout render path; run-id prefix derivation for unknown tool names already exists.
- Removal is clean deletion: all six preset registrations go away — `specialist`/`worker` absorbed by params, `finder`/`oracle`/`librarian`/`reviewer` re-shipped as definitions. No aliases, no shims.

Non-goals: *model-created* persistent agent types at runtime (Claude Code doesn't allow this either — the model composes inline via `role`/`skills`/`tools`; humans write definition files); nested `agent` calls inside scouts (depth 1).

### Workspace isolation mechanics (shared by `agent`, workflow children)

Why a lock exists at all: the *shared live checkout* is one resource — the tree the user watches in their editor, with uncommitted state — and bash side effects aren't VCS-scoped. The lock serializes that resource only. Everything else can be structurally isolated:

- **jj-colocated repo (the primary case here):** `jj workspace add --name agent-<name> <dir>`. Because the working copy is itself a commit, a workspace forked from `@` **sees the user's uncommitted state** — the strongest objection to worktree isolation doesn't apply. Conflicts at integration are first-class jj conflicts, not blockers.
- **Plain git:** `git worktree add` from `HEAD`. Uncommitted changes are *not* captured; the child's result flags that it worked from the last commit so the orchestrator isn't surprised.
- Workspace dirs live under a scratch root (`~/.cache/pi/scouts/workspaces/<run-id>/<child>/`), unique per run — no collision states by construction.
- **Result contract:** `{ changeId | commit, diffstat, workspacePath }`. Integration is the orchestrator's job with ordinary jj/git commands (`jj squash`/`rebase`, `git merge`); after integration, `jj workspace forget` / `git worktree remove`. V1 ships no auto-merge (open question below).
- **Limits, stated honestly:** bash side effects (installs, dev servers, writes outside the workspace) are not isolated — that part stays guidance. Per-workspace env (node_modules, build caches) is not provisioned in V1; children needing heavy builds should use shared isolation or fleet.

## Phase 2 — `workflow` tool

The fable-5 unlock: the model submits an orchestration script; only the script's return value enters the main context.

```ts
workflow({
  name: string,
  script: string,        // JS module body, see API below
  budget?: { maxAgents?: number, maxConcurrent?: number, wallClockMs?: number },
})
```

Script API V1 — exactly three injected globals, nothing else:

```js
// spawn one agent; spec is exactly the Phase 1 agent() schema
const out = await agent({ name, task, subagent_type?, role?, skills?, tools?, effort?, model?, mutation? });

// bounded map over items
const results = await pipeline(items, (item) => agent({ ... }), { concurrency: 4 });

console.log(...)  // captured to the run log, not the main context
return value;     // the ONLY thing that reaches the orchestrator's context
```

Phase 3 adds a fourth global — the `fleet` namespace — **additively**: V1 scripts keep working unchanged. Deliberately absent for good: any `backend` param on `agent()` (routing is explicit — `agent()` is in-process, `fleet.*` is durable) and `setTimeout` (no demonstrated orchestration need; `pipeline` concurrency + agent timeouts cover pacing).

There is no separate fleet tool: **`workflow` is the single orchestration surface.** A one-off durable spawn or a post-hoc steer/collect of yesterday's worker is just a three-line script (see Phase 3) — mild ceremony for rare direct use, in exchange for one fewer dispatch decision and verbs-as-functions instead of a shallow action-enum tool.

Execution model:

- Run the script in the extension host via `node:vm` with a frozen global surface — no `require`, no `process`, no fs.
- **This is a discipline boundary, not a security boundary.** The same model can already run arbitrary bash directly; the point of denying fs/shell in the script is to force work down into agents (Claude Code makes the same choice) and keep intermediate data out of the orchestrator context, not to sandbox a hostile author. Document this explicitly; if isolation requirements ever change, the Cloudflare-style answer is a subprocess executor behind the same API.
- **Mutation semantics** (I1/I7), two modes per child:
  - `mutation: { isolation: "workspace" }` — the recommended fan-out mode, and the injected API doc says so. No lock, full parallelism, structural isolation; each child returns a change-id/commit and the script returns whatever the orchestrator needs to integrate. Parallel mutation is *enforced*-isolated in-process, no herdr required.
  - `mutation: { isolation: "shared" }` — Claude Code parity (its fleets mutate one tree with disjoint-scope guidance only). The *workflow* is the lock holder, not each child: the first shared mutating child acquires the mutating-context lock fail-fast (held elsewhere ⇒ that child resolves to a `LockBusy` error value, pipeline error idiom); once held, released only when the workflow returns. Shared mutating children run in parallel under disjoint-scope guidance; conflicting edits are an expected error outcome in results, not a prevented state.
  - Fleet remains the answer when the task needs durability, human observability, or remote execution — not merely parallel mutation.
- Limits (defaults, overridable by `budget` within hard caps): 4 concurrent (hard cap 8 in-process — each agent is a live `AgentSession`), 100 agents total, 15 min wall clock.
- **Budget breach / abort transition** (I2): `Running → BudgetBreached → AbortingChildren → ChildrenQuiesced → ReturnPartial`. On breach, outstanding children are aborted and the workflow does **not** return until every child has reached a terminal state. The result enumerates all children: `completed` (with value), `errored`, or `aborted`. Aborted *shared* mutating children may leave partial edits in the live tree, flagged per child; aborted *workspace* children lose nothing — their partial work sits in workspace commits (I7), paths included in the accounting. Children never enter the suspended-run registry, so abort is plain session teardown — no suspended orphans, no registry pressure — and any held lock is released at return. The same transition applies to user-initiated abort of the workflow tool call.
- Result contract: script return value serialized (JSON, size-capped ~50KB, overflow to a temp file with path in the result); console log + per-agent summaries saved to the run log dir like existing scout summaries.
- Failure of one agent inside `pipeline` resolves to an error value for that item (Claude Code's `agents.filter(Boolean)` idiom), not a workflow abort.
- Extension-host crash mid-workflow: children are in-process sessions, so they die with the host; nothing durable leaks. The run-log dir retains console output + per-agent summaries written so far.

Open design question (defer to implementation): whether `agent()` in scripts supports a `schema` param for structured output (Claude Code does). V1 can prompt-and-parse; a real contract can come later.

## Phase 3 — `fleet.*` workflow API + herdr backend

Durable, observable, steerable workers, exposed as a namespace inside workflow scripts — not as tools. With workspaces covering parallel in-process mutation, fleet's quadrant is what in-process children structurally *cannot* be: durable (survives the orchestrator session), humanly observable and steerable mid-run (attach, peek, send, takeover), and remote (offload whole fleets to another box or sandbox).

### Backend mechanics (all validated)

- **Spawn:** `herdr --session <fleet-session> agent start <name> --cwd <dir> --env PATH=... [--env ...] -- pi --approve "<task>"` — interactive TUI pi, not `-p` (interactive children get lifecycle status, resumability, and human takeover).
- **Placement — tab per worker, never default-split.** Bare `agent start` splits the *current tab*, stacking ever-smaller panes (hit live 2026-07-06: the human had to clean up the pane pile by hand). The backend always places explicitly:
  - Default worker: one shared fleet workspace per target session; `herdr tab create --workspace <ws> --label <worker> --no-focus` → `agent start --tab <id>`. Full-size pane per worker, human tabs between them, labels carry worker names in the UI.
  - Worktree-isolated worker: `herdr workspace create --cwd <worktree> --label <worker> --no-focus` → `agent start --workspace <id>` — herdr workspaces are cwd-scoped, so isolation and placement align.
  - `--split` only if a script explicitly asks for side-by-side; never the default.
- **Coordinate:** `agent wait <name> --status working` then `--status idle`; `blocked` means the child needs input → `notification show` + surface in fleet widget.
- **Collect:** `agent get <name>` → `agent_session.value` (session JSONL path, requires pi integration installed) → final assistant message. Read the file via the transport; never parse pane text for results.
- **Isolate:** `herdr worktree create --branch <name> --base <ref>` per mutating worker — the same structural-isolation idea as in-process workspaces (I7), applied on the fleet target.
- **Server:** dedicated named session (default `fleet`) so the fleet never collides with the human's own herdr use; headless start via `setsid herdr --session fleet remote-client-bridge`.

### Transport abstraction

```ts
interface FleetTransport {
  exec(argv: string[], opts?: { stdin?: string }): Promise<{ stdout, stderr, code }>;
  readFile(path: string): Promise<string>;   // worker session JSONL
  label: string;                              // "local" | "ssh:host" | "sprite:name"
}
```

Three implementations: `local` (direct `herdr` CLI; also covers `HERDR_SOCKET_PATH` against a forwarded socket), `ssh` (`ssh <host> herdr ...`; `readFile` = `ssh cat`), `sprite` (`sprite -s <name> exec ...`; stdin piping validated). The transport is invisible to the model — it sees only the target alias. Targets declared in `scouts.jsonc`:

```jsonc
{
  "fleet": {
    "session": "fleet",
    "targets": {
      "local":  { "transport": "local" },
      "spike":  { "transport": "sprite", "sprite": "herdr-spike", "cwd": "/home/sprite/pi-o-my" }
    }
  }
}
```

### Sandbox provider seam (target lifecycle)

`FleetTransport` abstracts *talking to* a target; a second seam abstracts target *lifecycle*, so sandboxes are swappable the same way transports are — sprites is implementation #1, not the design:

```ts
interface SandboxProvider {
  provision(spec): Promise<TargetHandle>;   // create fresh, or restore from checkpoint
  checkpoint(target): Promise<CheckpointId>;
  restore(checkpoint): Promise<TargetHandle>;
  destroy(target): Promise<void>;
  transport(target): FleetTransport;         // hands back the transport seam
}
```

- **V1 implementation: sprite CLI** (`sprite create/checkpoint/restore/exec` — the exact calls the spike validated; checkpoint took 0.67s). A static config target (ssh box, local) is the degenerate case: no-op lifecycle, transport only.
- **Lifecycle hooks, stolen from Amp Orbs** (see research/amp-orb.md): a repo-committed contract instead of provisioning code in the extension —
  - `.agents/setup` — run once on a fresh sandbox from repo root (install deps, provision toolchain); the provider **checkpoints immediately after setup succeeds** and reuses that image for subsequent workers (Amp reuses for 24h; ours can pin until the setup file's hash changes).
  - `.agents/resume` — run on every wake/restore, bounded (Amp blocks ≤10s then backgrounds); fast idempotent repair (restart daemons, refresh tunnels).
  - Both are the repo's files, not scouts config — the same contract Amp ships, so repos get provisioning portability across harnesses for free.
- Fresh-worker-per-run = `restore(goldenCheckpoint)` → spawn → collect → `destroy` (or park for reuse). Sleep/wake economics (Amp: paused = free) are provider concerns behind the seam, not fleet logic.

Beyond the hooks, provisioning stays **out of code** in v1: the golden-image checklist (herdr + pi integration + pi + API-key auth + repo) lives in this doc, applied manually once per provider account; `provision()` from a checkpoint is the only automated path. A from-scratch `fleet provision` helper can come later once the shape stabilizes.

### Script API (`fleet` namespace, injected in Phase 3)

The common path is one deep call that hides spawn/wait/collect sequencing; lifecycle verbs exist as functions for scripts that need finer control — verbs-as-functions in code, not a shallow action-enum tool.

```js
// deep path: spawn + wait + collect, bounded (I6)
const result = await fleet.run({ task, name?, target?, worktree?, timeoutMs? });

// fine-grained control
const h = await fleet.spawn({ task, name?, target?, worktree? });  // registry entry written before this returns (I4)
await fleet.wait(h, { timeoutMs? });     // bounded; structured terminal errors
const r = await fleet.collect(h);        // reads the pinned session JSONL (I3)
await fleet.send(h, "steering message");
await fleet.stop(h);
const live = await fleet.list();         // registry view, includes orphans
```

Handles are durable strings backed by the registry, so post-hoc interaction with a worker spawned yesterday is a short script:

```js
return await fleet.collect("fleet:refactor-auth:7f3a");
```

The model-facing API exposes **intent** (task, isolation, target alias), not transport (no `cwd`, no `transport`, no sprite names — those live in the target's config entry). Target aliases are user-named and stable; renaming infrastructure means editing `scouts.jsonc`, not retraining prompts.

An unawaited spawn outlives its workflow by design — fleet workers are durable and registry-tracked (I4), unlike in-process children (I2). The workflow's return value should include the handle; the human watches the widget meanwhile. (Push-on-completion is an open question — v1 is poll/collect, matching how the spikes ran.)

### Spawn/wait/collect state machine

The spike hit the exact race this exists to prevent: `agent wait --status idle` matched **before the child started working** (trust prompt, stale state). The wait must be causally tied to the spawned generation (I3).

1. **Spawn**: create the worker's tab (or workspace, if worktree-isolated) per the placement policy, then `agent start --tab/--workspace` with nonce-suffixed name. Write the registry entry (I4) *before* returning: `{ handle, requestedName, herdrName, target, cwd, worktree, workspaceId, tabId, parent, status: "starting", spawnedAt }`.
2. **Confirm start**: wait for `working` on the herdr name, bounded by a startup timeout (default 60s). Terminal errors here: `StartupTimeout`, `WorkerBlocked` (trust/auth prompt — surfaced, not silently `idle`), `WorkerExited`, `TransportFailed`.
3. **Pin identity**: once working, `agent get` → `agent_session.value`; record the session JSONL path in the registry entry. If the path never materializes: `SessionPathUnavailable`.
4. **Wait terminal**: wait for `idle | blocked | exited`, bounded by `timeoutMs`.
5. **Collect**: read the *recorded* JSONL path via the transport; parse final assistant message. Failures: `CollectParseFailed`, `TransportFailed`. Never re-derive pane ids (they compact) and never read pane text for results.
6. **Terminal registry states**: `completed | failed | stopped | orphaned`. `stop` transitions through `stopping` and confirms via status; a stop that can't be confirmed marks the entry `orphaned`, not deleted. Teardown after collection is targeted — `tab close <tabId>` / `workspace close <workspaceId>` from the registry entry, never pane hunting; pane ids compact, tab/workspace ids from the registry don't lie.

### Registry & crash recovery

A durable registry (JSON file in the scouts run-log dir, one entry per spawn) is the source of truth for I4/I5:

- Written at spawn (before the tool returns), updated at each state transition above.
- On extension startup: reconcile against `herdr agent list` per configured target. Live workers with entries → resume tracking (widget + `fleet.*` calls work immediately). Registry entries with no live worker → mark `orphaned`, keep for collection (the JSONL path is recorded, so results of workers that finished during a crash remain collectable). Live workers with no entry → listed in the widget as unmanaged, never auto-stopped.
- Spawn-time collision check (I5): reject if an active entry on the same target shares name, branch, or worktree path.

### Fleet widget (separate concern, same extension)

- `ctx.ui.setWidget("fleet", ...)`: one line per active fleet agent — `name status target` with status glyphs; poll `herdr agent list` per target at ~2s while any fleet agent is live (socket `events.subscribe` is a later optimization; CLI has no events verb).
- `pi.registerShortcut("ctrl+g")`: overlay `SelectList` of agents → actions: **peek** (`agent read --format ansi` in overlay), **steer** (input dialog → `agent send` + Enter), **focus** (jumps the human's attached herdr viewer), **stop**.
- Human viewing: local target = attach `herdr --session fleet`; ssh target = `herdr --remote <host> --session fleet`; sprite target = `sprite console` → `herdr --session fleet`.

## Safety & constraints

- Read-only is the default everywhere; mutation is opt-in via schema (the `mutation` object with its required `isolation`, fleet `worktree`) — affordances the calling model reaches for deliberately. A definition's explicit tool allowlist is authoritative: without both `Edit` and `Write`, a caller cannot upgrade it into a mutating agent.
- The lock serializes exactly one resource — the shared live checkout (I1). Structural isolation is lock-free: in-process workspaces (I7) and fleet worktrees (I5). Parallel *shared* mutation inside a workflow is guided (disjoint scopes), not enforced — the trust model Claude Code ships — while the workspace and fleet tiers are enforced.
- Workspace/worktree isolation bounds *where* children write, not *what conflicts*: overlapping file scopes across workspaces/worktrees are unchecked, and merge conflicts surface at integration as expected outcomes (I5/I7; first-class conflicts under jj). Tool descriptions state the disjoint-scope guidance (fan out only across disjoint files/dirs — same guidance the herdr community skill gives).
- Bash side effects (installs, servers, non-repo writes) are never isolated by any tier except remote fleet targets — stated in the tool descriptions rather than pretended away.
- Secrets: fleet transports never place credentials in argv (stdin piping only); worker auth is API-key by policy.
- Budgets: workflow caps above; fleet spawn cap per run (default 8) since each worker is a full pi session with real cost. All waits bounded (I6).
- Suspended-run limits, timeouts, and wrap-up steering are inherited unchanged by top-level `agent` runs (they were `worker`'s); workflow children deliberately stay out of the suspended-run registry.

## Open questions

1. Structured output contracts for `agent()`/`fleet.collect` (JSON schema param) — v1 prompts for format, no validation.
2. Completion push for unawaited fleet workers (pi has no background-task notification channel; widget polling covers the human, `fleet.list`/`fleet.wait` in a later script covers the model).
3. Upstream herdr asks: a real `herdr server start` (replace the `remote-client-bridge` trick); a CLI `events subscribe` verb.
4. Fable-5 via API key for remote workers: fixing the `cloudflare-ai-gateway` provider env (`CLOUDFLARE_GATEWAY_ID`) is the cheapest path; alternative is a dedicated Anthropic API key.
5. Nested workflows / agents spawning agents — deferred; Claude Code allows depth 5, scouts stays at depth 1 until there's a demonstrated need.
6. Integration helper — auto-squash a workspace change into `@` when conflict-free (jj makes this cheap), vs V1's orchestrator-manual integration.
7. Per-workspace env provisioning (node_modules, build caches; symlink vs install) — V1 leaves workspaces unprovisioned. If `.agents/setup`-style hooks (fleet seam) prove out, the same repo contract could provision in-process workspaces too.
8. Definition/pool leftovers from the preset demotion (decided 2026-07-06 — two-tool catalog, tool pool, pure-markdown definitions; see Design overview): exact pool membership (which librarian internals generalize — one `github_search` vs finer-grained GitHub verbs); whether to also scan `.claude/agents/` so Claude Code definitions drop in with zero copying (the format is compatible by construction — the open bit is whether those files' inherit-everything `tools` expectations surprise under the base-pool default); whether reviewer's lenses ship as one definition per lens or one reviewer definition with a lens argument convention.
9. Swamp Club (swamp-club.com) as a `SandboxProvider` backend — its Remote Execution model (durable orchestrator, stateless dial-home workers, per-step secret proxying, enrollment-token state machine) is credible fleet-infra prior art (see research/swamp-club.md). Not adopted now: it provisions no machines itself, it's a whole framework (YAML models + data layer + vault + `swamp serve`) for what v1 does with five CLI verbs, and it's ~6 months old under AGPL. Revisit if fleet provisioning grows multi-provider lifecycle complexity (scheduled image re-bakes, credential rotation, prove-what-ran-where) — that's exactly its home turf. Independent of adoption, steal: capability proxying (workers hold no credentials), the enrollment-token state machine, and the run-tracker / audit-log / evidence-store separation.

## Implementation order

1. **`agent` tool + definitions** — runtime `ScoutConfig`; absorb specialist (`skills` injection) and worker (lock, resume, `mutation.verificationCommands`); tool pool + definition loader (format above) + shipped preset definitions (finder/oracle/librarian/reviewer prompts ported verbatim); workspace mechanics (`jj workspace add/forget` off `@`, `git worktree` fallback); delete all six existing registrations. Workflow's `agent()` is the same code path.
2. **`workflow` tool** — vm harness, injected API (`agent`/`pipeline`/`console`), budgets, abort/quiesce accounting, result contract.
3. **Fleet backend + `fleet.*` namespace** — registry + local transport first (registry lands *before* any remote transport); then sprite/ssh.
4. **Fleet widget** — polling widget + overlay; last because it's pure UX over a working backend.

Transition-shaped tests to write alongside: lock contention → fail-fast `LockBusy` between two shared mutating agents and between a shared-mutating workflow and a top-level agent, lock-holder workflow spawning further shared children without re-acquisition, and workspace children taking no lock at all; workspace capture → jj child sees dirty `@`, git-fallback child flags HEAD-only, timed-out/aborted workspace child leaves a recoverable commit (I7); workflow budget breach → all in-process children accounted (partial-edit flags for shared, workspace paths for isolated) while unawaited fleet spawns persist by design; fleet wait-before-working race (trust prompt reports `idle`); `fleet.wait` on dead/blocked worker → terminal error, not hang; crash + restart → registry reconcile; spawn collision rejection.

Each step is independently shippable and testable (`agent` via direct calls; `workflow` via fixture scripts; fleet against the existing `herdr-spike` sprite checkpoint).
