# Skill Consolidation Plan

Consolidating domain-specific skill groups (Rust, Salsa, jj, Svelte5, SvelteKit) from many separate skills into single router-based skills per domain.

## Motivation

Each skill's `name` and `description` are always loaded into the agent's context, regardless of whether the skill is used. With 40+ skills across these 5 domains, that's ~12,700 chars (~3,200 tokens) of always-on description tax. More importantly, the agent must pattern-match across many similar descriptions (e.g., 14 Rust skills) to pick the right one, which risks misactivation.

Consolidation reduces this to 5 descriptions, improves activation accuracy (any Rust question loads the Rust skill, then the router directs), and simplifies maintenance.

## Architecture

### The Router Pattern

Each consolidated skill has a **SKILL.md that teaches AND routes**:

1. **Intro** (1-2 sentences)
2. **Topics table** (routing — immediately visible, not buried at bottom)
3. **Teaching sections** — each core concept with code examples, enough to answer common questions directly without following any links. Each section ends with `→ Deep dives: [topic.md](topic.md)` for the full treatment.
4. **Common Mistakes** table
5. **Reference Index** — flat links to all deep-dive files

### The Depth Rule

The Anthropic/pi guidance says: *"Keep references one level deep from SKILL.md. All reference files should link directly from SKILL.md."*

The key insight: **depth is about link-following hops, not directory nesting.** If SKILL.md links directly to both topic files AND reference files, everything is 1 hop — even if references live in subdirectories.

```
SKILL.md ──→ async.md                          ✅ 1 hop
SKILL.md ──→ references/async-channels.md      ✅ 1 hop (linked from reference index)
async.md ──→ references/async-channels.md      ✅ also reachable (natural reading flow)
```

Topic files also link to their own references, providing a natural reading flow — but this is never the only path to those references.

### SKILL.md Design Principles

- **Teach, don't just route.** The router should have enough substance (code examples, key rules, common mistakes) to answer most questions without loading topic files. Think salsa-overview (201 lines of real content) not a table of contents.
- **Route early.** The Topics table goes near the top, right after the intro. Don't bury routing at the bottom.
- **Every file linked from SKILL.md.** Both topic files and all reference files appear in the reference index. This ensures the agent knows about everything and can access it directly.
- **Target ~100-200 lines** for the router SKILL.md. Well under the 500-line limit, but substantial enough to be useful standalone.

### File Structure

```
domain/
├── SKILL.md                    # Router: teaches + routes (~100-200 lines)
├── topic-a.md                  # Deep dive (former sub-skill SKILL.md body)
├── topic-b.md
└── references/
    ├── topic-a/                # Subdirs where naming conflicts exist
    │   ├── patterns.md
    │   └── common-mistakes.md
    └── flat-reference.md       # Flat where no conflicts
```

Use subdirectories within references/ when filename collisions exist (e.g., multiple `common-mistakes.md`). Use flat references when names are unique. Directory depth doesn't matter — only link-following depth matters.

## Completed: Svelte5

**Before:** 2 skills (`svelte5-runes`, `svelte5-class-state`), 365 description chars, 188 SKILL.md lines total

**After:** 1 skill (`svelte5`), 449 description chars, 125-line router SKILL.md

### Structure

```
svelte5/
├── SKILL.md                              # 125 lines — teaches runes + class state + routes
├── runes.md                              # Deep dive: rune patterns, migration, component API
├── class-state.md                        # Deep dive: class patterns, context API, SSR safety
└── references/
    ├── runes/                            # Subdirs solve common-mistakes.md collision
    │   ├── reactivity-patterns.md
    │   ├── migration-gotchas.md
    │   ├── component-api.md
    │   ├── snippets-vs-slots.md
    │   └── common-mistakes.md
    └── class-state/
        ├── class-patterns.md
        ├── context-vs-scoped.md
        ├── common-mistakes.md
        └── ssr-safety.md
```

### SKILL.md Content

The router teaches:
- Runes quick reference with code example (which rune to use, key behaviors)
- Class-based state pattern with full interface → class → factory example
- Context API with Symbol keys and set/get pattern
- Common mistakes table (7 entries)
- Topics table at top, reference index at bottom

## Completed: SvelteKit

**Before:** 5 skills (`sveltekit-structure`, `sveltekit-data-flow`, `sveltekit-auth`, `sveltekit-forms-validation`, `sveltekit-remote-functions`), 1,100 description chars, 784 SKILL.md lines total

**After:** 1 skill (`sveltekit`), 561 description chars, 178-line router SKILL.md

### Structure

```
sveltekit/
├── SKILL.md                              # 178 lines — teaches all 5 topics + routes
├── structure.md                          # Deep dive: routing, layouts, error boundaries, SSR
├── data-flow.md                          # Deep dive: load functions, form actions, serialization
├── auth.md                               # Deep dive: authentication patterns, hooks, protection
├── forms-validation.md                   # Deep dive: extractFormData, FormErrors, valibot/zod
├── remote-functions.md                   # Deep dive: command(), query(), form()
└── references/                           # Flat — no naming collisions
    ├── file-naming.md
    ├── layout-patterns.md
    ├── error-handling.md
    ├── ssr-hydration.md
    ├── load-functions.md
    ├── form-actions.md
    ├── serialization.md
    ├── error-redirect-handling.md
    ├── better-auth.md
    ├── cloudflare.md
    └── remote-functions-reference.md     # Renamed from remote-functions.md to avoid topic collision
```

### SKILL.md Content

The router teaches:
- Structure & routing with directory layout example and layout code
- Data loading with load/actions code example and key rules
- Authentication with layout protection pattern, API route warning, hooks warning
- Form validation overview (schema → extractFormData → fail → FormErrors)
- Remote functions with command() example
- Common mistakes table (6 entries)
- Topics table at top, reference index at bottom

## Completed: jj

**Before:** 6 skills, 3,427 description chars, 1,768 SKILL.md lines total

**After:** 1 skill (`jj`), 599 description chars, 187-line router SKILL.md

### Structure

```
jj/
├── SKILL.md                              # 187 lines — mental model, agent rules, daily workflow + routes
├── git.md                                # Deep dive: colocated repos, concept mapping, when to use raw git
├── config.md                             # Deep dive: configuration, aliases, diff/merge tools
├── history.md                            # Deep dive: squash, absorb, rebase, split, conflicts
├── revsets.md                            # Deep dive: revsets, filesets, templates
├── sharing.md                            # Deep dive: bookmarks, remotes, push/pull, PRs
├── workspaces.md                         # Deep dive: parallel agents, isolated working copies
└── references/                           # Flat — one rename (config.md → config-reference.md)
    ├── bookmarks.md
    ├── command-gotchas.md
    ├── config-reference.md               # Renamed to avoid topic collision
    ├── conflicts.md
    ├── divergence.md
    ├── filesets.md
    ├── git-compatibility.md
    ├── git-experts.md
    ├── git-to-jj.md
    ├── github.md
    ├── parallel-agents.md
    ├── revsets.md
    └── templates.md
```

### SKILL.md Content

The router teaches:
- Mental model (5 concepts: working copy is a commit, change IDs, mutable history, bookmarks, conflicts)
- Agent rules (non-negotiable table + config block)
- Core workflow (daily loop, curating history, non-linear work, pushing)
- Essential commands table
- Recovery (undo, op log, op restore, evolog)
- Detecting a jj repo
- Common mistakes table (7 entries merged from all skills)
- Topics table at top (6 topics including git interop), reference index at bottom linking all 13 reference files

## Completed: Rust

**Before:** 14 skills (`rust-*` plus `thinking-in-rust`), 4,123 description chars, 3,823 SKILL.md lines total, no overview/router

**After:** 1 skill (`rust`), 14 topic files, 59 flat reference files, router SKILL.md that teaches core defaults and routes by symptom

### Structure

```
rust/
├── SKILL.md                              # Router: Rust defaults, decision spines, common mistakes
├── README.md                             # Source inventory, synthesis decisions, gaps
├── async.md                              # Topic files from former SKILL.md bodies
├── atomics.md
├── error-handling.md
├── idiomatic.md                          # Former thinking-in-rust
├── interop.md
├── macros.md
├── ownership.md
├── performance.md
├── project-structure.md
├── serde.md
├── testing.md
├── traits.md
├── type-design.md
├── unsafe.md
└── references/                           # Flat — no filename collisions
    ├── blocking-and-bridging.md
    ├── channels-and-select.md
    ├── ordering-cheatsheet.md
    ├── newtypes-and-domain-types.md
    ├── parse-dont-validate.md
    └── ... (54 more)
```

### SKILL.md Content

The router teaches:
- Core Rust defaults: domain types, enums, exhaustive matching, borrowing, ownership, visibility, pattern matching
- Topics table near the top for all 14 areas
- Decision spines for ownership, errors, polymorphism, async/concurrency, macros/unsafe, and data/project boundaries
- Common agent failure modes table (20 entries)
- Review checklist (12 items)
- Reference index linking every topic and reference file directly

Validation: `/home/josh/.agents/skills/skill-authoring/scripts/validate.sh skills/rust` passes.

## Remaining: Salsa

**Current:** 13 skills, 4,169 description chars, 2,021 SKILL.md lines total, has `salsa-overview` as partial router

| Skill | SKILL.md Lines | Reference Files | Reference Lines |
|-------|---------------|-----------------|-----------------|
| salsa-overview | 201 | 1 | 81 |
| salsa-struct-selection | 292 | 7 | 1,324 |
| salsa-database-architecture | 249 | 8 | 1,794 |
| salsa-incremental-testing | 247 | 5 | 620 |
| salsa-cancellation | 228 | 3 | 654 |
| salsa-query-pipeline | 143 | 9 | 2,053 |
| salsa-lsp-integration | 149 | 7 | 2,042 |
| salsa-memory-management | 133 | 5 | 622 |
| salsa-accumulators | 79 | 8 | 1,279 |
| salsa-advanced-plumbing | 78 | 0 | 0 |
| salsa-cycle-handling | 76 | 2 | 256 |
| salsa-durability | 75 | 4 | 400 |
| salsa-production-patterns | 71 | 1 | 116 |

### Plan

Consolidate into single `salsa` skill. `salsa-overview` already has excellent teaching content (mental model, core concepts, code examples, vocabulary, real-world scale) — absorb it as the router SKILL.md.

**Naming collision challenge:** Massive duplication in reference filenames — `ty-patterns.md` appears 9 times, `rust-analyzer-patterns.md` 9 times, etc. Must use topic-scoped subdirectories within references/.

Estimated router SKILL.md: ~200 lines (salsa-overview content is already 201 lines and well-structured).

### Proposed Structure

```
salsa/
├── SKILL.md                              # ~200 lines — mental model, core concepts, routing
├── struct-selection.md                   # 12 topic files
├── query-pipeline.md
├── database-architecture.md
├── cycle-handling.md
├── cancellation.md
├── durability.md
├── incremental-testing.md
├── memory-management.md
├── lsp-integration.md
├── accumulators.md
├── production-patterns.md
├── advanced-plumbing.md
└── references/
    ├── overview/
    │   └── minimal-example.md
    ├── struct-selection/                 # Topic-scoped subdirs solve naming collisions
    │   ├── ty-patterns.md
    │   ├── rust-analyzer-patterns.md
    │   ├── cairo-patterns.md
    │   ├── baml-patterns.md
    │   ├── djls-patterns.md
    │   ├── fe-patterns.md
    │   └── real-world-strategies.md
    ├── cancellation/
    │   ├── ty-patterns.md               # Same filename, different subdir
    │   ├── rust-analyzer-patterns.md
    │   └── salsa-framework.md
    └── ... (10 more topic subdirs)
```

## Summary

| Domain | Before | After | Description Savings |
|--------|--------|-------|-------------------|
| **Svelte5** | 2 skills, 365 chars | ✅ 1 skill, 449 chars | -1 entry |
| **SvelteKit** | 5 skills, 1,100 chars | ✅ 1 skill, 561 chars | -4 entries |
| **jj** | 6 skills, 3,427 chars | ✅ 1 skill, 599 chars | -5 entries |
| **Rust** | 14 skills, 4,123 chars | ✅ 1 skill | -13 entries |
| **Salsa** | 13 skills, 4,169 chars | → 1 skill, ~500 chars | -12 entries |
| **Total** | **40 skills, ~13,200 chars** | **5 skills, ~2,500 chars** | **-35 entries, ~10,700 chars saved** |

Estimated always-on context savings: ~2,700 tokens per conversation.

## Lessons Learned

1. **Work in the project repo, not ~/.agents/skills/.** The install script symlinks from the project to ~/.agents/skills/. Editing or deleting symlink targets modifies the source. Always work in the project directory.

2. **Router SKILL.md must teach, not just route.** The first version was a 43-line table of contents. Useless — the agent always had to follow a link. The salsa-overview model (201 lines of real teaching content with inline routing hints) is the right pattern.

3. **Put routing near the top.** The Topics table should be in the first 15 lines, not buried after all the teaching content. The agent may skim or partial-read — routing must be discoverable early.

4. **Inline `→ Deep dives:` hints after each section** provide natural routing without interrupting the teaching flow. These complement the Topics table at top and Reference Index at bottom.

5. **Subdirectories solve naming collisions** without adding link depth. Salsa's `ty-patterns.md` appearing 9 times across skills is handled by `references/cancellation/ty-patterns.md`, `references/struct-selection/ty-patterns.md`, etc. SKILL.md links to each directly.

6. **Flat references when possible.** Rust has zero filename collisions across 59 reference files — flat references/ is simpler and fine.
