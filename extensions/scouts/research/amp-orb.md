# Research findings: Amp and its "Orb" product

Researched 2026-07-06 via curl against ampcode.com. Orb is an **Amp** product; Amp
spun out of Sourcegraph into "Amp Frontier Corporation" (Nov 2025) and lives at
ampcode.com. The Sourcegraph blog (sourcegraph.com/blog) has **zero** mentions of
"orb" — Orb is purely an ampcode.com property. Every claim below cites a URL;
`[N]` maps to the Sources list. Direct quotes are in "quotes".

---

## 1. What exactly is Orb? (shape, launch, positioning, pricing)

**Shape.** Orb is *not* a standalone product — it is a feature of Amp: "Orbs are
machines in which an agent can run without supervision" [6]. The unit of work in
Amp is a **thread** (a durable conversation); an orb is simply *where a thread
executes*. "Each Amp thread started from ampcode.com in an orb gets its own orb …
starts with a fresh clone of your repository" [6]. One orb = one thread = one fresh
repo clone.

**Launch.** Public GA announcement **30 June 2026**: "Agents in Orbs — You can now
launch Amp agents remotely in orbs" [3]. Followed by an architecture note **2 July
2026** ("Putting an Agent in an Orb" [4]) and a sizing update **3 July 2026**
("More Orb Sizes" [5]). At launch there was a single size (16 cores / 32 GB /
\$1.66/hr); the tiered lineup shipped three days later [5].

**Positioning.** Philosophical, not technical: "we hold the models back if we
require them to do it all on a single machine … once you let them loose in orbs,
you realize how constrained they've been. Time to find out how far they can go" [3].
The pitch is *unsupervised, long-running, parallel* agents — "why not launch a
group of agents to investigate eight different bugs independently" [3].

**Pricing.** Billed by the minute; **a paused orb costs nothing**; auto-paused when
inactive and "paused immediately when their thread is archived" [6]. Per-project size
[5][6]:

| Flavor | CPU | RAM | Disk | \$/hr |
|---|---|---|---|---|
| a0.tiny | 1 | 2 GB | 40 GB | 0.10 |
| a0.small | 2 | 4 GB | 40 GB | 0.21 |
| a0.medium | 8 | 16 GB | 40 GB | 0.83 |
| a0.large (default) | 16 | 32 GB | 40 GB | 1.66 |

Enterprise workspaces pay **+50%** [6]. Storage was doubled 20→40 GB on 3 July [5].

---

## 2. Architecture: cloud sandboxes, isolation, provisioning

**Cloud sandbox machines.** Every orb "runs Debian 12" [4][6] and comes pre-loaded:
authenticated `gh` and `amp`, Git/SSH, **PostgreSQL 17 and Redis**, tmux, ffmpeg,
ImageMagick, ripgrep, ast-grep, Bun/Node/npm/pnpm/Yarn, Python, and an
`agent-browser` [4][6]. More via `apt`/`apt-get` or `pnpm` [6].

**Isolation model.** One orb per thread, each a "fresh clone" [6] — i.e. an
independent ephemeral machine per task, **not** git worktrees on a shared host.
Amp's own setup tunes for ephemerality/speed (Postgres `fsync=off`,
`synchronous_commit=off`, `autovacuum=off`) [4]. The `a0.*` flavor naming reads
like a cloud-VM SKU, but **the manual never names the underlying provider or says
container vs microVM vs full VM** — it consistently says "remote machines" [6].
(See Confidence & gaps.)

**Repo provisioning via lifecycle hooks** (committed to the repo) [6]:
- `.agents/setup` — shell script run from repo root **once on a fresh orb**, before
  the agent starts (install deps, seed DB, write toolchain shims). Amp's own is a
  428-line bash script [4]. After it runs, Amp **snapshots the sandbox and reuses
  it for up to 24h** for new orbs [4].
- `.agents/resume` — run on **every wake-up** of a resumed orb; Amp blocks at most
  **10 seconds** then lets it continue in-background; "fast, idempotent reconnect
  or repair steps such as restarting tunnels" [6].

**Sleep/wake.** "Orbs go to sleep when you or the agents no longer need them. They
wake up as soon as there's work to do again" [4]. Free while asleep [6].

**Projects.** A *project* links a repository to orb settings (size, secrets, env
vars) and "related threads"; threads started from a project get a fresh orb clone
and run the setup files [6].

---

## 3. Fleet UX: observing/steering many parallel remote agents

**Foundation.** On **4 June 2026** Amp relaunched as "a distributed system with
durable execution for the agent loop and a plugin API" and shipped a new UI/sidebar
"built for watching and driving all of your Amp agents, on web, mobile, and CLI" [7].
Entry points: `amp app` (desktop), ampcode.com (web/mobile), and `Opt+S`/`Alt+S` in
the CLI to show a sidebar of threads [7].

**Local and remote agents in one UI.** Orbs are presented **in the very same TUI**
as local agents — "right next to those local agents, with the very same controls" [3].
Fleet primitives that pre-date orbs: **Agents Panel** (9 Jan 2026 — "viewing and
managing multiple agent threads" [2]), **Thread Map** (Dec 11 2025), **Thread
Labels** (Dec 11 2025), **Find Threads** by keyword/files touched (Dec 8 2025) [2].

**Launching parallel agents.** Three ways: web ("Create New Thread → select
project" [6]); CLI `amp -ox "prompt"` (execute-mode thread in an orb [3][6]); or
spawn from inside the TUI (`project: select` / `project: create`) [6].

**Attach / local↔remote.**
- `amp sync <thread-id>` mirrors an orb thread's changes into your local checkout
  *while the agent keeps working remotely* [3][6].
- A **terminal** can be opened in the orb; it "is running in a tmux session, so your
  agent can see what you see in the terminal" [6].
- Review diffs and browse files **on the orb** without syncing first [3][6].

**Steering & notifications.** Queue messages while busy; `Enter Enter` steers after
the current step, `Esc Esc` interrupts immediately (manual, "Using Amp" →
Queueing) [1]. Remote Control (predates orbs, Oct 2025 [2]) lets you continue a CLI
thread from web/mobile with optional **passkey** auth enforceable per workspace [1].
Archiving a thread pauses its orb [6]. **Explicit "notify on completion/blocked" is
not documented** — observation is via the activity feed/sidebar/mobile web (gap).

---

## 4. Relation to the CLI/editor product; shared/movable sessions

Same product, same thread. Orb is purely the *execution site*; a thread is durable
and location-independent: start in the CLI, continue on web/mobile; start in an orb,
sync down with `amp sync` [1][3][6]. The whole arc — Remote Control (Oct 2025 [2])
→ "Agents, Everywhere" (4 Jun 2026 [7]) → Orbs (30 Jun 2026 [3]) — is a steady
decoupling of *thread* from *your machine*.

**Editor integration** is via the CLI bridge: `amp --jetbrains`, the Amp Neovim
plugin, and "VS Code and VS Code-based editors (Cursor, Windsurf, etc.)" and Zed
[1]. (The dedicated editor extension was killed Feb 2026 — "The Coding Agent Is
Dead" [2] — so the CLI is now the only client surface, with IDEs attaching to it.)

**Can a local session move to an orb?** Not as *live process migration*. The
documented mechanisms are context-level: **Handoff** (Oct 23 2025 / Jan 13 2026)
moves accumulated context into a fresh thread without compaction [2], and
**Fork**/reference let threads branch. So you can hand a local thread's context
into a new orb-backed thread and `amp sync` results back — but there is no
"promote this running local process into a remote orb" button (gap).

---

## 5. Amp's subagent architecture (current lineup)

**Opinionated, fixed-named subagents** — *not* a generic "Task" tool that spawns
anonymous sub-agents (the Claude Code pattern). Current built-ins [1][2]:

- **Oracle** — a "second opinion" model exposed as a **tool** (`oracle`) the main
  agent can call autonomously or on request; "currently uses GPT-5.5, with
  reasoning level high"; for complex reasoning/analysis/review, "slightly slower,
  slightly more expensive" [1]. Lineage: o3 (Jun 2025) → GPT-5 (Oct 2025) → GPT-5.4
  (Mar 2026, "deep mode now has one too") → GPT-5.5 [2].
- **Librarian** — subagent that searches **public + private GitHub** code; built
  for "in-depth explanations"; only the default branch [1]. Made "~3x faster and
  43% cheaper" 18 Jun 2026 [2]; the *search* subagent ran Gemini 3 Flash (Dec 2025) [2].
- **Painter** — image gen/edit **tool** (GPT Image 2) [1].
- **Code Review** (`amp review`) + **Checks** — `.agents/checks/*.md` define
  per-area review criteria; "Amp spawns a separate subagent for each check" [1].
  "Composable and extensible" since "Liberating Code Review" (Jan 2026) [2].

**Subagent semantics** [1]: each has its own context window; they "work in
isolation — they can't communicate with each other, you can't guide them
mid-task, they start fresh without your conversation's accumulated context, and
the main agent only receives their final summary." Spawned automatically (mostly
**smart** mode) or by request ("Use 3 subagents to convert these CSS files to
Tailwind") [1].

**New: user-defined agents.** "Custom Agents" (19 Jun 2026) [2] via the
experimental plugin API: `amp.experimental.createAgent(...)` +
`registerAgentMode(...)` for **custom agent modes**, or expose a subagent via
`registerTool` with `parentThreadID` to keep it linked to the calling thread [1].
Built-in agents are also reachable via `amp.getBuiltinAgent('smart'|'deep'|'rush')`
[1]. So Amp is *opening* the subagent layer while shipping strong defaults.

**No generic dynamic "Task" tool by that name** is documented; the pattern is
fixed-named subagents (Oracle/Librarian) + on-demand generic subagents +
plugin-defined ones.

---

## 6. Model-written orchestration / workflows

Mostly **human-authored scaffolding that the model executes**, not model-written
persistent workflows:

- **AGENTS.md** — Amp's own repo has **41** AGENTS.md files read on-demand; the
  root one ties together build/test commands, infra, git/jujutsu usage, dev tooling
  [4]. The system prompt also tells the agent it's inside an orb and how to get
  more tools [4].
- **Skills** (SKILL.md + bundled scripts/MCP) — e.g. a `dev-server` skill whose
  `ensure-dev-server.sh` makes the dev server idempotently healthy and writes ports
  to `.amp/dev-ports.json` [4]. A built-in `building-skills` skill lets **the agent
  author new skills** [1] — the clearest model-written-workflow hook.
- **Checks** (§5), **Plugins** with event hooks/tools [1], and **Custom Agents**
  (plugins that "create agents, run them once, and keep talking to their threads" [2]).
- **Durable execution** of the agent loop itself (4 Jun 2026 [7]) is the
  orchestration substrate — but it's a server-side runtime, not user-authored DAGs.

The stated design ethos is the opposite of dynamic planning: "don't make them
guess … paved path … the environment doesn't just tolerate an agent; it assumes
one, and tells it where the light switches are" [4].

---

## 7. Lessons for the pi + herdr + sprites design

**Worth copying**
- **Thread-as-location-independent-unit.** A durable thread that runs locally, in a
  sprite VM, or is driven from web/mobile maps directly onto pi threads + herdr.
  Build the abstraction so *where it executes* is an attribute, not a product line.
- **Per-thread sandbox + lifecycle hooks.** The `.agents/setup` (once) /
  `.agents/resume` (wake, ≤10s blocking) contract is a clean, repo-committed
  provisioning spec — pi skills should adopt an equivalent for sprites.dev/exe.dev.
- **Snapshot-after-setup reuse (24h).** Amortizes heavy provisioning across many
  short tasks; worth implementing as a warm-sprite pool.
- **Sleep/wake + per-minute billing + free-when-paused.** Clean fleet economics and
  a natural "archive = stop paying" UX.
- **Pre-baked "agent-ready" base image** (Debian + gh + pg + redis + rg + bun/node
  + browser). Ship one canonical sprite image so setup scripts stay tiny.
- **Make the dev env legible to agents** [4]: a ports JSON, magic-login/dev
  endpoints, forwarded browser logs in one greppable file, AGENTS.md everywhere.
  "Don't make them guess" is the single most transferable lesson.
- **One UI for local + remote, side by side.** herdr (local multiplexer) and
  sprites (remote) should appear in the *same* pi surface with identical controls.
- **`amp sync`-style remote→local mirror** for hands-on attach without losing the
  remote run.
- **Opinionated default subagents** (oracle/librarian-style) plus an extension
  point — exactly pi's skills/extensions model. (Amp explicitly credits pi: "Amp's
  plugin API is inspired by pi's extension API, created by … Mario Zechner" [1];
  the Amp homepage says "Inspired by Pi" [8].)

**Worth differing on / avoiding**
- **Isolated, fire-and-forget subagents.** Amp subagents can't talk to each other
  or be steered mid-run [1]. For a herdr *fleet* we likely want richer
  coordination/handoff/steering between peers — a deliberate divergence.
- **One orb per thread, no shared warm sandbox.** Consider shared/pooled warm
  sprites for many small tasks rather than cold-cloning per thread.
- **No live local→remote migration** is documented — a gap pi could fill
  ("suspend-to-remote" / "resume-on-sprite").
- **Notifications on completion/blocked** are weak/undocumented in Amp — easy win
  for a fleet product.
- **Undisclosed infra.** Amp hides the provider; pi *owns* sprites/exe, giving more
  leverage (custom images, GPUs, networking) but more to build and secure.

---

## Sources

- [1] Amp Owner's Manual — https://ampcode.com/manual  (sections: Orbs, Tools &
  Subagents, Subagents, Oracle, Librarian, Painter, Code Review/Checks, Thread
  Sharing, Remote Control, Non-Interactive, Plugins, Define a Custom Agent Mode /
  Subagent, "Amp's plugin API is inspired by pi's extension API"). Dedicated Orbs
  page: https://ampcode.com/manual/orbs
- [2] Amp Chronicle (news/changelog) — https://ampcode.com/news  (dates &
  headlines cited inline: Oracle 27 Jun 2025, Librarian 20 Oct 2025, Agents Panel
  9 Jan 2026, Checks/Review 18 Dec 2025 & 29 Jan 2026, Custom Agents 19 Jun 2026,
  Faster Librarian 18 Jun 2026, etc.)
- [3] "Agents in Orbs" (30 Jun 2026) — https://ampcode.com/news/agents-in-orbs
- [4] "Putting an Agent in an Orb" (Thorsten Ball, 2 Jul 2026) —
  https://ampcode.com/notes/putting-an-agent-in-an-orb
- [5] "More Orb Sizes" (3 Jul 2026) — https://ampcode.com/news/more-orb-sizes
- [6] Amp Owner's Manual → Orbs — https://ampcode.com/manual/orbs  (specs, sizes,
  pricing, lifecycle hooks, project model, base image contents)
- [7] "Agents, Everywhere" (4 Jun 2026) — https://ampcode.com/news/agents-everywhere
- [8] Amp homepage — https://ampcode.com/  ("Inspired by Pi"; "Agents in Orbs — Run
  agents remotely")
- [9] ampcode.com/llms.txt — https://ampcode.com/llms.txt  (points to /manual, /manual/sdk)
- [10] Sourcegraph blog — https://sourcegraph.com/blog  (no "orb" mentions;
  confirms Amp/Orb is a separate ampcode.com property, not a Sourcegraph blog topic)

## Confidence & gaps

- **High confidence:** Orb definition, launch date (30 Jun 2026), pricing/tiers,
  per-thread sandbox model, lifecycle hooks (`.agents/setup` + `.agents/resume`),
  base image contents, sleep/wake/billing, fleet UX (sidebar/web/mobile/CLI,
  `amp sync`, `amp -ox`), subagent lineup (Oracle/Librarian/Painter/Code Review +
  Checks) and their fixed/opinionated nature, Custom Agents plugin API, "inspired
  by pi" attribution. All from primary ampcode.com sources [1]-[8].
- **Medium:** Underlying infra provider and container-vs-microVM-vs-VM choice. The
  manual says "remote machines" and "Debian 12" and uses `a0.*` VM-like flavor
  names but **never names the provider or isolation primitive** [6]. Inferred to be
  cloud VMs, not confirmed.
- **Low / unverified:** Explicit "notify on completion/blocked" semantics (not
  documented; inferred from activity feed + mobile web). Whether a *running* local
  session can be live-migrated into an orb (no docs found; only context-level
  Handoff/Fork + `amp sync`). Any model-authored *persistent* workflow system
  beyond the `building-skills` skill and plugin-defined Custom Agents. Exact
  enterprise pricing beyond "+50%". Whether orbs can share a warm sandbox across
  threads (docs imply one-orb-per-thread, fresh clone).
- **Not attempted deeply:** podcast episodes ("Raising an Agent"), the TypeScript/
  Python SDK internals, or the full Plugin API reference — out of scope for these
  research questions. The https://ampcode.com/orb vanity URL returns a sign-in page
  to an unauthenticated curl; product detail lives under /manual/orbs [6] and
  /news/agents-in-orbs [3] instead.
