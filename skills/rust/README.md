# rust

Consolidated Rust skill for idiomatic Rust judgment across ownership, errors, traits, type design, async, atomics, unsafe, macros, testing, performance, serde, interop, and project structure.

## Source Inventory

| Source | Trust | Contribution | Constraints |
|---|---|---|---|
| Former `thinking-in-rust` skill | High | Core mental model and idiomatic defaults | Migrated into `idiomatic.md` and router foundations |
| Former `rust-ownership` skill | High | Borrowing, lifetimes, smart pointers, function signatures | Migrated into `ownership.md` plus references |
| Former `rust-error-handling` skill | High | Library vs application errors, thiserror/anyhow, combinators | Migrated into `error-handling.md` plus references |
| Former `rust-traits` skill | High | Dispatch choices, object safety, standard traits, trait patterns | Migrated into `traits.md` plus references |
| Former `rust-type-design` skill | High | Newtype, typestate, builder, phantom, sealed traits | Migrated into `type-design.md` plus references |
| Former `rust-async` skill | High | Tokio, channels, blocking, cancellation, production async patterns | Migrated into `async.md` plus references |
| Former `rust-atomics` skill | High | Atomic-vs-lock decisions, memory ordering, CAS and UB boundaries | Migrated into `atomics.md` plus references |
| Former `rust-unsafe` skill | High | Unsafe containment, UB validity, safety comments, Miri | Migrated into `unsafe.md` plus references |
| Former `rust-macros` skill | High | macro_rules, proc macros, hygiene, testing/debugging | Migrated into `macros.md` plus references |
| Former `rust-testing` skill | High | Test organization and tool selection | Migrated into `testing.md` plus references |
| Former `rust-performance` skill | High | Profiling-first optimization and allocation/data structure patterns | Migrated into `performance.md` plus references |
| Former `rust-serde` skill | High | Serde schema design, attributes, adapters, custom impls | Migrated into `serde.md` plus references |
| Former `rust-interop` skill | High | FFI/host-runtime boundaries for C, C++, Python, Node, Wasm, UniFFI | Migrated into `interop.md` plus references |
| Former `rust-project-structure` skill | High | Workspaces, public API surface, feature unification | Migrated into `project-structure.md` plus references |
| Top-level `README.md` Rust attribution list | Medium | External source and license inventory | Broad list; topic files preserve detailed guidance |

## Synthesis Decisions

- Decision: replace 14 always-visible Rust skills with one `rust` router skill.
  - Supported by: `SKILL_CONSOLIDATION_PLAN.md`, existing Svelte/SvelteKit/jj router pattern.
  - Rejected alternative: keep `thinking-in-rust` as the entry point and retain separate Rust sub-skills.
  - Reason: the old shape had high description tax and many overlapping activation triggers.
- Decision: keep former skill bodies as root-level topic files.
  - Supported by: the consolidation plan's router architecture.
  - Reason: the router can teach common rules while preserving deep-dive detail one hop away.
- Decision: flatten all reference files into `references/`.
  - Supported by: there were no filename collisions across Rust reference files after including `thinking-in-rust`.
  - Reason: every reference remains directly linkable from `SKILL.md`.
- Decision: use `idiomatic.md` for the former `thinking-in-rust` skill.
  - Reason: `rust` is now the entry point; `idiomatic.md` better names the topic role.

## Coverage and Gaps

Covered:

- Idiomatic Rust review and mental-model shifts.
- Ownership, lifetimes, errors, traits, type design, async, atomics, unsafe, macros, testing, performance, serde, interop, and project structure.
- Direct links from `SKILL.md` to all topic and reference files.

Gaps:

- Activation behavior has structure validation only; it has not been evaluated across held-out Rust prompts.
- Topic files are migrated bodies, not fully rewritten to remove old phrasing that may refer to standalone skills.

## Change Log

- 2026-05-15: Consolidated 14 Rust-related skills into one router-based `rust` skill.
