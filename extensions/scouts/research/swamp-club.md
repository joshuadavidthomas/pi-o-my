# Swamp Club — Research Overview

**Site:** https://swamp-club.com/ (also `swamp.club` → 301) · **Repo:** https://github.com/swamp-club/swamp (originally `github.com/systeminit/swamp`, 301-transferred) · **License:** AGPLv3 + "Swamp Extension and Definition Exception" · **Company:** Elder Swamp Club, Inc. · **Tagline:** *"Deterministic Automation for AI Agents."*

> **Bottom line up front:** Swamp Club is **not a sandbox/VM product**. It is an open-source **agent-operated automation/orchestration framework** — the layer *above* a sandbox. Its one fleet-relevant subsystem is **Remote Execution** (a durable orchestrator + disposable dial-home workers), which is architecturally close to self-hosted GitHub Actions runners and could run its workers *inside* sprite VMs. It is far more valuable to us as **prior art + idea source** than as a sandbox provider (it provisions no machines itself).

---

## 1. What it is / who / when / problem / pricing

**What.** Swamp is a CLI (`swamp`, written in TypeScript on Deno) that lets an AI coding agent **build and then execute repeatable, reviewable workflows**. The pitch is the anti-black-box one: LLMs are stochastic, but the *work* an agent does (inventory VMs, rotate keys, remediate a CVE across a fleet) should be deterministic, typed, evidence-producing, and reviewable before it touches prod. Every execution writes immutable, versioned artifacts into a `.swamp/` directory ("the swamp") inside a git repo. Source: [/manual/explanation/how-swamp-works], [README].

**Who.** Five founders (see [/about-us]): **Adam Jacob** (Chef founder, System Initiative), **Mahir Lupinacci** (System Initiative), **Paul Stack** (Pulumi/DevOps veteran), **Nick Stinemates** (`@keeb`), and **John Watson** (`@swamp_lord`). The legal entity is **Elder Swamp Club, Inc.** The repo was transferred out of the `systeminit` GitHub org into `swamp-club`, strongly implying it grew out of the System Initiative team, but the site does *not* state a formal SI→Swamp rename/spinout.

**When.** GitHub repo created **2026-01-28**; first Show-HN mention **2026-05-04**; a wave of third-party blog coverage June–July 2026. So it is **~6 months old and very young**, shipping multiple CalVer releases per day (e.g. `v20260706.…` on today's date). Current star count ~474, 35 forks, 2 open issues.

**Problem it claims to solve.** Agents today produce "a collection of prompts, shell scripts, and crossed fingers" (M. Ellens, ravegraph). Capabilities are lost in chat history; one-off scripts rot; credentials get scattered; logs are ephemeral. Swamp makes the agent **encode the workflow once** (typed models + DAG + vault refs) so it runs deterministically and leaves queryable evidence every time after.

**Pricing** ([/pricing]). Open core, AGPLv3 source:
- **Free $0** — full product, forever, if solo or uncompensated.
- **Team $9** / **Business $15** per user/month (annual). **Agents and CI runners never count as seats.** Portable seats.
- **Enterprise** (custom) — on-prem Swamp Club, AGPL exemption, managed private extensions, SLA, professional services.
- Licensed under a Red-Hat/VS-Code-style model: open source, trademark-protected commercial distribution, **no upstream code contributions accepted** ([OSS-FAQ.md]).

---

## 2. Core capabilities / primitives

There is **no VM, container, or "environment" primitive** in the sandbox sense. The primitives are ([how-swamp-works], [README]):

- **Models** — typed interactions with an external system (a shell command, an AWS EC2 VPC, a GitHub repo…). A *model type* is reusable TypeScript logic with **Zod** input/output schemas + `execute` functions; a *model definition* is a **YAML config** that instantiates it. Crucially the agent *writes YAML (data), not code* — logic is compiled, config is authored. This is the Puppet "resource abstraction layer" idea reborn for agents.
- **Workflows** — multi-step **DAGs**: `jobs` → `steps`; steps within a job run in **parallel**, jobs run in **dependency order**; steps can `depends_on` with triggers `succeeded`/`failed`/`completed`; workflows **nest** (a step can invoke another workflow); steps can **suspend** for `manual_approval`; triggers via `cron` or **webhook**. ([/manual/reference/workflows])
- **Data layer** — every method run produces **immutable, versioned** artifacts (resources/logs/files) in `.swamp/data/`, queryable with **CEL** expressions (`attributes.status == "failed"`, `tags.workflow == "deploy"`) and projectable with `--select`. Lifetimes: `ephemeral` / `job` / `workflow` / `duration` / `infinite`, with GC. This is the durable "memory" that is **not** LLM-summarized. ([data-lifetimes], [the-data-layer])
- **Vaults** — encrypted secret storage referenced **by expression** at runtime (never frozen into YAML, never persisted in data). Swappable providers: local encryption, AWS Secrets Manager, Azure KV, 1Password (vault providers can be packaged by extensions). Sensitive output fields are auto-redirected to the vault. ([/manual/reference/vaults])
- **Extensions** — bundle model types / vault providers / datastores / reports; **CalVer**-versioned; published to a registry. **1,051 extensions** in the registry today, mostly auto-generated `@swamp/aws/*`, `@swamp/gcp/*` infra models plus community ones (Stripe, etc.). Trust model: only the first-party `swamp` collective is trusted by default; collective *membership* ≠ consent to auto-install. ([extensions], [extension-trust])
- **Skills** — **plain markdown** (YAML frontmatter) that teaches the agent how to use Swamp, with **progressive disclosure** (metadata → body → references). Now consolidated into a single gateway `swamp` skill. Shipped for Claude Code, Codex, OpenCode, Copilot, Kiro, Cursor; custom tools supported via a 3-fact definition (instructions path, frontmatter, skills dir). This is **directly analogous to pi skills.** ([ai-agent-integration])
- **Reports** — structured markdown + JSON analysis emitted after every run (e.g. `@swamp/method-summary`, `@swamp/workflow-summary`).
- **CLI** — `swamp repo init`, `model method run`, `workflow run`, `data query`, `worker …`, `serve …`, `vault …`, `extension pull`, `update` (self-updating), shell completions. Designed to be **both human- and agent-readable**: text by default, `--json` on demand, built-in schema discovery (`model type search/describe`), error messages with retry context.
- **Observability** — OpenTelemetry span export, an **audit timeline** (records every command, attributable to a specific agent), a **run tracker** (SQLite, 30s heartbeats, stale-reap, 7-day retention, deliberately local not shared), and webhook + cron triggers.

---

## 3. "Environments / sandboxes" — creation, management, persistence, sharing

This is where Swamp diverges hardest from the requester's mental model. **Swamp does not create or manage compute sandboxes.** It assumes a machine (yours, a CI runner, or a worker you enroll) and runs on it. There is no `swamp vm create`, no snapshot of a filesystem, no environment-as-a-resource.

What it *does* persist, manage, and share:

- **Persistence = the `.swamp/` data layer.** Immutable, versioned, CEL-queryable artifacts; "the swamp" is git-committable. Renames use forward references so refactoring doesn't break old runs. This is Swamp's closest thing to a "snapshot" — but it snapshots **evidence/state**, not a machine image.
- **Definition & workflow persistence** = YAML files in git (`models/`, `workflows/`, symlinked human-friendly views). Reviewable, diffable, version-controlled alongside the code they automate.
- **Worker lifecycle (Remote Execution)** = the only fleet-shaped subsystem, see §6. Workers are **stateless and disposable**; the orchestrator is durable.
- **Sharing & distribution** = the **extension registry + collectives** (CalVer, semver-ish pulls, scorecards/grades A–F), **private collectives/extensions** for paying teams, and **Giga-Swamp** for federating multiple repos/namespaces into one queryable catalog (`pull-foreign-catalog`, `merge-repos`, `query-across-namespaces`). ([giga-swamp])
- **Limits:** no published per-VM/concurrency limits because there are no VMs. Ephemeral data has a 512 MB in-memory budget (`SWAMP_EPHEMERAL_BUDGET`). Worker placement `queueTimeout` defaults to 10 min (server flag) / 60 s (step). ([workflow-placement], [data-lifetimes])

---

## 4. Concrete examples & use cases

**From the homepage "Real Usage":**
- *"Inventory every Proxmox VM and flag anything without monitoring"* (Infra)
- *"Remediate my Jellyfin library — find unidentified media and fix metadata"* (Media — there's a real `@keeb/mms` extension for this)
- *"Rotate all API keys, update the vault, and notify Discord"* (Security)

**Flagship use case — CVE-as-fleet-remediation** ([/cve/dirtyfrag], [/cve/mini-shai-hulud]). Swamp Club publishes original security research and ships it as one-command scanners/remediators:
- **Dirty Frag** (kernel LPE via `splice()` page-cache corruption, CVSS 9.1–9.6): `swamp extension pull @swamp/cve/dirtyfrag` then `scanFleet --hosts=… --sshKey=…` runs in parallel across a fleet and emits a per-host patch report; `mitigate` blocklists `esp4/esp6/rxrpc`, flushes cache, with `dryRun=true` default.
- **Mini Shai-Hulud** (314-package npm supply-chain attack, May 2026): notably the payload **explicitly targets AI agents** — injects `.claude/settings.json` `SessionStart` hooks and `.vscode/tasks.json` tasks, plus steals 80+ env vars (incl. Vault tokens, K8s SA, GitHub PATs). Swamp ships a lockfile-checker extension. *This CVE is directly relevant to agent-fleet security.*

**Community / what people build** (mostly via the curated [/feed] + leaderboard, ~199 active users, top streaks 30–65 days: `magistr`, `webframp`, `thomas`, `mgreten`, `alvagante`/example42, `stack72`, `bixu`, `dave_burt`):
- SRE incident-response workflows: alert → metrics → logs → diagnosis → remediation, with typed CEL chaining between "what's wrong" and "how to fix it" (Paul Stack, stack72.dev).
- Drift detection as composition; infra-as-truth (webframp.com, engineeringforteams Substack).
- "Capture debt" — versioned evidence of technical decisions (matgreten.dev).
- Quarto/Jupyter templated AI authoring with validated parameter slots (`@vcjdeboer/session-write`).
- `@goodcraft/stripe`, `@swamp/gcp/composer`, `@swamp/aws/opensearchserverless`, etc.

**Third-party framing** (authentic, not just marketing):
- *"Swamp Is Interesting Because It Doesn't Trust AI"* (M. Ellens, ravegraph) — the deterministic-beneath-stochastic thesis; "every time Claude writes a shitty bash script, I think: this should be in Swamp." Notes Patrick Debois's caveat that large orgs need "more batteries," and Adam Jacob's reply that workflows emerge at the edges (like Chef, like DevOps).
- *"Deterministic beneath Stochastic"* (J. Holsten, proddingais.substack) — the engineering argument for a bright line between validated and LLM steps.
- *"First Steps in the Swamp"* (Alessandro/example42) — a practical tutorial; observes the model-type/definition split "smells exactly like the [Puppet] resource abstraction layer."

**Traction signals:** Homepage claims "9,904,499 automation events from agents in the wild" (unverifiable). HN had a single Show-post (2026-05-04, **2 points, 0 comments**) — very low broad-reach traction; awareness is currently niche/infra-community. Reddit JSON and Google/Bing/DDG returned blocked/empty results in this research, so the feed + leaderboard + blogs are the main community signal.

---

## 5. Landscape comparison

**Swamp sits at a different layer than every comparator in the task.** sprites.dev / exe.dev / **Fly Machines / E2B / Modal / Cloudflare sandboxes** all provide **a box that runs code** (a VM/container compute substrate). Swamp provides **the orchestration + evidence layer that decides *what* to run and captures typed results.** They are complementary and composable: a Swamp worker can run *inside* a sprite/Fly/E2B sandbox.

| Layer | Provides | Swamp? |
|---|---|---|
| sprites.dev / exe.dev | durable sandbox VMs for agents | ❌ (consumer of these) |
| Fly Machines / E2B / Modal / CF | ephemeral sandboxed compute | ❌ (consumer) |
| **Temporal / Airflow / Prefect** | durable workflow DAG engine | ✅ closest analog — but Swamp is agent-authored YAML, not code |
| **Chef / Puppet / Terraform** | declarative infra-as-code (the founders' pedigree) | ✅ Swamp is "the RAL, for agents" |
| **GitHub Actions (self-hosted runners)** | orchestrator + dial-home workers | ✅ Swamp's Remote Execution is this model |
| **pi / Claude Code skills** | markdown skills that teach an agent | ✅ Swamp ships its own skills, same format |

Swamp's real differentiator vs. workflow engines: **the agent authors the workflow as data (YAML), the type system validates it, and every run leaves versioned evidence** — closing the "prose prototype" gap where an LLM re-reads its own chat output and hopes it remembers.

---

## 6. Integration potential for an agent-fleet (our use case)

Could Swamp create/manage sandboxes for a fleet of pi coding agents? **Partially, and only at the orchestration layer — not as a sandbox provisioner.** Mapping its **Remote Execution** subsystem ([/manual/explanation/remote-execution], [reference/remote-execution/*]) onto our design:

- **Orchestrator** = `swamp serve` (durable: persists runs, owns datastores + vault, is the security boundary). **Workers** = `swamp worker connect wss://…` — **stateless compute that dials home** over WebSocket (works behind NAT/firewall; the worker only needs to reach the orchestrator).
- **Auth = enrollment tokens** (one-time secrets stored in a vault) with an explicit state machine `unused → enrolled → expired/revoked`. **Fleet tokens** (`--max-enrollments N`) let many machines share one token; each binds to a distinct machine-id (in `--cache-dir`) and gets auto-named `<token>-<suffix>` + a `fleet=<name>` label for placement.
- **Placement** = step-level `target` (specific worker name/UUID) or `labels` (superset selector, e.g. `{region: us-east, gpu: "true"}`); unmatched steps queue until `queueTimeout`. Local and remote steps coexist in one job and behave identically to downstream CEL/data-chaining.
- **Capability proxying** = workers hold **no credentials, no definitions, no datastore**; every `queryData()`/vault resolution is proxied back through the orchestrator over the encrypted data plane. Secrets are resolved **per-step**, held in memory only for the dispatch, never persisted on the worker. ⇒ **workers are disposable and autoscale-friendly; a compromised worker reveals only its in-flight step's secrets.**
- **Trust direction is inward (CI-runner model):** connecting a worker to an orchestrator grants that orchestrator **code execution on the worker**. "Only connect workers to orchestrators you control." (reference/remote-execution/security)

**Fit assessment for pi's fleet:** This is a credible, well-specified orchestrator-worker model that maps cleanly onto "durable orchestrator + disposable sprite VMs." A Swamp worker could be the process we run *inside* each sprite VM, giving us typed workflows + CEL evidence + vault proxying for free. **Caveats:** (a) Swamp provisions **no machines** — we still need sprites.dev/exe.dev/Fly to make the boxes; (b) adopting Swamp means adopting **its** type/model/data/vault model wholesale (it's a framework, not a library); (c) it's ~6 months old, AGPL, no upstream patches accepted; (d) its sweet spot is **infra/SRE/security automation**, not arbitrary coding-agent task execution. For our "durable observable workers" goal, Swamp is best treated as a **candidate orchestration layer + an excellent idea mine**, not a drop-in sandbox manager.

---

## 7. Idea mining — worth stealing even if we never adopt it

1. **Deterministic-beneath-stochastic as a design principle.** A bright line: the LLM *authors* typed definitions (stochastic); the runtime *executes and validates* them (deterministic). Lets you reason about error bars per-component. Steal the framing.
2. **Type (TS+Zod) vs. definition (YAML) split.** The agent writes *data*, never *code*; the type owns execution + schema validation at create- and run-time. This is the Chef RAL ported to the agent era and is the core reason an agent can safely produce durable automation.
3. **The data layer as the substrate / agent memory.** Immutable, versioned, CEL-queryable, git-committable, with lifetimes (ephemeral/job/workflow/duration/infinite) + GC + forward-reference renames. "Memory that isn't LLM-summarized." Strong candidate for our observability/evidence store.
4. **Capability proxying + per-step secret resolution.** Stateless workers, orchestrator-as-security-boundary, secrets never persisted, autoscale-friendly disposability. A clean security architecture for an agent fleet.
5. **Enrollment-token state machine + fleet tokens + reverse-trust warning.** Explicit `unused/enrolled/expired/revoked`; multi-machine fleet tokens with auto-naming + label injection; honest documentation that the trust arrow points *inward* (CI-runner semantics). Steal the state machine and the honest docs.
6. **Run tracker: SQLite + 30s heartbeats + stale-reap + 7-day retention + deliberately-local.** Explicitly *not* shared across machines (PIDs are machine-local); distinct from both audit log and datastore. A clean separation of "what's in-flight now" vs "what happened" vs "durable evidence."
7. **Hard-refusal misconfiguration guards + deny-wins authz + config-as-source-of-truth admin materialization.** `swamp serve` **hard-fails** if off-loopback without TLS+auth (refuses to bind); deny always wins; `--admins` grants are reconciled from config on every boot (recovery + bootstrap). Steal the "make the unsafe config not start" reflex.
8. **Skills as plain markdown with progressive disclosure** (metadata→body→references), tool-agnostic, agent-loaded on demand. Directly applicable to pi skills. Plus: CLI designed to be **jointly** human/agent readable (text default, `--json` opt-in, schema discovery, retry-friendly errors).
9. **Extension registry with CalVer + scorecard/grades + narrow collective trust.** First-party trusted by default; membership ≠ consent; private collectives for paid. A mature model for a shared capability marketplace.
10. **CVE-as-GTM.** Publishing a 0-day *and* the one-command fleet remediation as an extension is a brilliant distribution hack for a security/infra tool — and the mini-shai-hulud writeup (payloads that target `.claude/settings.json` hooks) is a concrete threat model for *our* agent fleet.
11. **Webhook + cron + manual-approval suspension** as first-class triggers — turn a pull-based system reactive (event-driven) and human-gated.
12. **AGPLv3 + class/extension exception + Red-Hat trademark model, no upstream code contributions.** A specific, defensible open-core posture worth understanding if we ever open-source fleet infra.

---

## Sources

**Official (swamp-club.com)**
- Root: https://swamp-club.com/ · Pricing: https://swamp-club.com/pricing · About: https://swamp-club.com/about-us · Manual: https://swamp-club.com/manual · Feed: https://swamp-club.com/feed · Extensions: https://swamp-club.com/extensions · Leaderboard: https://swamp-club.com/leaderboard · Lab (issues): https://swamp-club.com/lab
- Explanation: /manual/explanation/{how-swamp-works, models-types-and-methods, the-data-layer, the-workflow-execution-model, extension-trust, ai-agent-integration, remote-execution, swamp-serve, datastore-architecture, data-lifetimes, api-key-scoping, understanding-workflow-suspension, giga-swamp, the-audit-system}
- Reference: /manual/reference/{workflows, model-definitions, data, vaults, remote-execution, remote-execution/security, remote-execution/workflow-placement, remote-execution/enrollment-tokens, swamp-serve/rest-api, api-key-authentication, extensions}
- Tutorials: /manual/tutorials/{hello-world, remote-execution, working-with-data, storing-secrets, publish-an-extension}
- CVEs: /cve/dirtyfrag · /cve/mini-shai-hulud · Install: https://swamp-club.com/install.sh

**Code**
- GitHub repo: https://github.com/swamp-club/swamp (transferred from `github.com/systeminit/swamp`, HTTP 301) · README: https://raw.githubusercontent.com/swamp-club/swamp/main/README.md · OSS-FAQ: …/OSS-FAQ.md · License: AGPLv3 + COPYING-EXCEPTION · Built with Deno (TypeScript) · ~474 stars · created 2026-01-28

**Third-party / community**
- HN (Show): https://news.ycombinator.com/item?id=48005802 (2026-05-04, 2 pts, 0 comments)
- M. Ellens, "Swamp Is Interesting Because It Doesn't Trust AI," ravegraph.beehiiv.com (2026-06-12)
- P. Stack, "SREs Don't Need Replacing, They Need Pairing," stack72.dev (2026-06-11)
- Alessandro (alvagante), "First Steps in the Swamp," example42.com (2026-06-11)
- J. Holsten, "Deterministic beneath Stochastic," proddingais.substack.com (2026-07-04)
- More in feed: webframp.com, magistr.me, matgreten.dev, goodcraft.io, infrastructure-as-code.com

---

## Confidence & gaps

- **High confidence:** primitives, CLI surface, pricing, licensing model, founders, remote-execution architecture and trust model — all from official docs and the repo.
- **Medium:** launch timing (repo Jan 2026; first HN May 2026; "GA" date not stated). Founders' System Initiative lineage is implied by names + the `systeminit→swamp-club` repo transfer, but the site does not explicitly describe a corporate relationship; the entity is "Elder Swamp Club, Inc."
- **Low / not verified:** the "9.9M automation events" homepage counter; true adoption beyond the ~199 leaderboard users and ~1,051 extensions (many are auto-generated `@swamp/aws,gcp/*` with 0 pulls).
- **Gaps from tooling:** Reddit JSON search returned 403; Google/Bing/DuckDuckGo HTML search returned empty/challenge pages under curl, so independent forum/thread signal is thin — most community color here comes from Swamp's own curated feed and a handful of blog posts. GitHub code-search for "swamp-club" imports was not attempted (requires auth).
- **Not attempted:** installing the binary to exercise the CLI hands-on; reading every reference page (datastore-configuration, vault references, serve flags, notifications) in full — covered enough to characterize the system.
