# rust

Rust guidance for code review, API design, and implementation work. The skill focuses on thinking in Rust: modeling domains with types, making ownership explicit, using structured errors, choosing the right dispatch shape, keeping boundaries typed, and treating unsafe/concurrency/performance work as proof-driven rather than vibe-driven.

## What This Covers

- Idiomatic Rust review and mental-model shifts.
- Ownership, borrowing, lifetimes, smart pointers, and clone discipline.
- Structured error handling with library/application boundaries.
- Traits, dispatch choices, newtypes, typestate, builders, and other type-design patterns.
- Async/Tokio, atomics, unsafe Rust, soundness, and Miri-oriented checks.
- Macros, testing, benchmarking, profiling, serde, FFI/interop, Cargo features, workspaces, and public API surfaces.

## File Layout

- `SKILL.md` — runtime guidance: core defaults, common mistakes, quick reference, review checklist, and links to major topic files.
- `ownership.md`, `error-handling.md`, `traits.md`, `type-design.md`, etc. — focused topic guides for deeper decisions.
- `references/` — narrow supporting notes linked from the main skill or topic files.

## Activation Examples

Should trigger:

- "Can you review this Rust API for idiomatic design?"
- "Fix this E0499 borrow checker error in my iterator code."
- "Should this be an enum or `dyn Trait`?"
- "Help me choose `thiserror` vs `anyhow` for this crate."
- "This Tokio code holds a mutex across `.await`; how should I structure it?"
- "My serde DTO is leaking into the domain model."
- "Cargo enabled a feature through another dependency."

Should not trigger:

- "Format this README."
- "Review this TypeScript async code."
- "Explain what Rust is at a high level."
- "Create a Todoist task for learning Rust."

Good holdout prompts:

- "Can this `Rc<RefCell<_>>` graph become arena indices instead?"
- "This FFI callback can panic across the boundary; is that sound?"
- "The benchmark got faster after deleting newtypes; should we keep that change?"
