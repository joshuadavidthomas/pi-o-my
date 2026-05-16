---
name: rust
description: >
  Mental-model reset for Rust. Use when writing or reviewing Rust code, fixing
  compiler errors, designing APIs, modeling domain types, handling ownership,
  lifetimes, errors, traits, async/Tokio, atomics, unsafe, macros, tests,
  performance, serde, FFI/interop, project structure, Cargo features, or asking
  whether Rust code is idiomatic. Handles .rs files, Cargo.toml, Cargo.lock,
  rustc diagnostics, cargo check failures, and clippy findings. Triggers on
  borrow checker errors, E0382,
  E0499, E0502, E0505, E0507, E0597, E0106, E0716, thiserror vs anyhow,
  Result/Option combinators, newtype, typestate, builder, enum vs trait,
  dyn Trait, Send/Sync, Pin, Miri, proptest, insta, criterion, wasm-bindgen,
  PyO3, napi-rs, cxx, UniFFI, serde attributes, and feature unification.
---

# Think in Rust

Rust is not C with nicer syntax, Java with ownership, or TypeScript with lifetimes. The core failure mode is code that compiles but keeps another language's model: primitive strings for domain concepts, booleans for states, runtime validation that throws away proof, trait objects for closed sets, clones to quiet the compiler, and unsafe to escape design pressure.

Use this skill when Rust judgment matters. Treat the rules below as strong defaults, not laws. Start with the mental model first; when a topic gets deep, use the quick reference and cross-references below to load the focused file.

Rust's strength is that ownership, alternatives, and failure can be made explicit in the program shape. Write code that gives the compiler useful facts: domain types instead of primitives, enums instead of flag bundles, narrow visibility instead of accidental API, and signatures that say who owns what.

## How Rust Thinks

### Model the domain in types

1. **Name domain values.** `UserId(String)` says more and permits less than `String`. Use newtypes for IDs, validated text, units, and security boundaries. See [references/newtypes-and-domain-types.md](references/newtypes-and-domain-types.md).
2. **Use enums for alternatives.** A `kind` field plus optional payloads is usually an enum waiting to happen. See [references/enums-as-modeling-tool.md](references/enums-as-modeling-tool.md).
3. **Avoid `bool` for domain state.** `is_active: bool` is fine for a predicate; `Mode::ReadOnly | Mode::ReadWrite` is better for behavior. See [references/bool-to-enum.md](references/bool-to-enum.md).
4. **Avoid `Option<bool>`.** Three states deserve three names. See [references/option-bool-to-enum.md](references/option-bool-to-enum.md).
5. **Use `Option` instead of sentinels.** Empty string, `0`, and `-1` are not absence. See [references/option-over-sentinels.md](references/option-over-sentinels.md).
6. **Parse, don't validate.** Convert untrusted input once into a type that proves the invariant. See [references/parse-dont-validate.md](references/parse-dont-validate.md).
7. **Prefer exhaustive matches.** Avoid `_ =>` on enums you own; let new variants break the right code. See [references/exhaustive-matching.md](references/exhaustive-matching.md).
8. **Keep related data together.** Parallel vectors/maps are often one collection of structs. See [references/struct-collections.md](references/struct-collections.md).

### Express ownership and API intent

9. **Borrow by default.** Accept `&str`, `&[T]`, and `&Path` unless you need to store, mutate, or transfer ownership. See [references/borrow-by-default.md](references/borrow-by-default.md).
10. **Function signatures are design.** A signature should reveal who owns, who borrows, and how long values remain valid. See [references/function-signatures.md](references/function-signatures.md).
11. **Do not clone defensively.** Clone when duplication is part of the design, not to silence E0382. See [ownership.md](ownership.md).
12. **Use interior mutability last.** Try ownership restructuring before `Rc<RefCell<T>>` or `Arc<Mutex<T>>`. See [references/ownership-before-refcell.md](references/ownership-before-refcell.md).
13. **Transform values instead of mutating everything.** Prefer iterator adapters and constructors when they make dataflow clearer. See [references/transform-over-mutate.md](references/transform-over-mutate.md).
14. **Iterate over collections, not indexes.** Index loops invite bounds bugs and hide intent. See [references/iterators-over-indexing.md](references/iterators-over-indexing.md).
15. **Visibility is part of design.** Default to private or `pub(crate)`; expose a curated facade. See [references/visibility-and-modules.md](references/visibility-and-modules.md).
16. **Do not use `impl` blocks as namespaces.** If there is no `self`, ask whether it is a free function, module function, trait method, or constructor. See [references/impl-namespace.md](references/impl-namespace.md).
17. **Trivial getters/setters are not APIs.** Expose behavior or return borrowed views that preserve invariants. See [references/getter-setter.md](references/getter-setter.md).
18. **Pattern matching is a design tool.** Match on typed states and variants, not decoded strings and flags. See [references/pattern-matching-tools.md](references/pattern-matching-tools.md).

→ Deep dives: [idiomatic.md](idiomatic.md), [type-design.md](type-design.md), [ownership.md](ownership.md)

### Choose the simplest mechanism that preserves invariants

**19. Borrow checker errors are design feedback.** A move, overlapping borrow, temporary lifetime, or `'static` complaint is pointing at ownership shape. Redesign before adding clones, `Rc<RefCell<_>>`, `Arc<Mutex<_>>`, or `unsafe`. See [ownership.md](ownership.md).

**20. Libraries and applications handle errors differently.** Libraries return structured errors, usually with `thiserror`. Applications use `anyhow` and add `.context()` at boundaries. Panic only for bugs and violated internal invariants. See [error-handling.md](error-handling.md).

**21. Pick dispatch by openness.** Closed set → enum. Open set with concrete type known at the call site → generics or `impl Trait`. True type erasure → `dyn Trait`. See [traits.md](traits.md).

**22. Async is for waiting.** Never block the runtime. Use async I/O, `spawn_blocking` for short blocking calls, and Rayon or dedicated threads for CPU-bound work. Bound channels and concurrency. See [async.md](async.md).

**23. Atomics and unsafe need proofs.** Use atomics for simple flags/counters with a clear ordering argument. Use unsafe only behind the smallest safe API, with `# Safety` docs, `// SAFETY:` comments, and Miri when validity or aliasing matters. See [atomics.md](atomics.md) and [unsafe.md](unsafe.md).

**24. Boundaries translate; internals model.** Serde, FFI, CLI, HTTP, and database edges should convert DTOs into internal domain types. Stay single-crate until a crate boundary has a name; keep Cargo features additive. See [serde.md](serde.md), [interop.md](interop.md), and [project-structure.md](project-structure.md).

## Common Mistakes (Agent Failure Modes)

- **Bare `String`, `u64`, or `bool` with domain meaning** → Use a newtype or enum with named variants.
- **`kind` plus optional fields** → Use enum variants with payloads.
- **`_ =>` on an enum you control** → Match exhaustively so new variants break the right code.
- **`Error(String)` or a crate-wide error blob** → Define structured errors for one unit of fallibility.
- **`anyhow::Error` in a public library API** → Use a library error type; reserve `anyhow` for binaries/apps.
- **Bare `?` loses context in app code** → Add `.context()` at abstraction boundaries.
- **`clone()` or `'static` added to appease the compiler** → Revisit ownership and lifetimes.
- **`&String`, `&Vec<T>`, or `&PathBuf` in APIs** → Accept `&str`, `&[T]`, or `&Path`.
- **`Rc<RefCell<T>>` or `Arc<Mutex<T>>` as first resort** → Restructure ownership or use message passing.
- **`dyn Trait` for a closed set** → Use an enum.
- **`std::fs`, `thread::sleep`, or CPU loops in `async fn`** → Use async APIs, `spawn_blocking`, or Rayon/thread pool.
- **Holding a lock guard across `.await`** → Narrow the lock scope or redesign shared state.
- **`Ordering::Relaxed` for publication** → Pair Release/Acquire or use `SeqCst` until proved otherwise.
- **`unsafe impl Send/Sync` without invariant comments** → Document and test the invariant.
- **`mem::transmute` for bytes or flags** → Use parsing, `from_*`, `bytemuck` with proof, or explicit conversion.
- **Proc macro for simple repetition** → Use a function, trait, derive, or `macro_rules!`.
- **`serde_json::Value` as the internal model** → Use DTOs at the boundary and domain types inside.
- **`#[serde(untagged)]` to make parsing work** → Prefer explicit tags; use untagged only deliberately.
- **Benchmarking debug builds** → Measure `--release` with Criterion/profiler.
- **Feature flags for internal workspace architecture** → Use crate boundaries/modules; features are for additive public capability.

## Quick Reference

| Code smell | Rust default move | Reference |
|---|---|---|
| Rust code feels translated from another language | Move invariants into types and make control flow explicit | [idiomatic.md](idiomatic.md) |
| Borrow checker error, defensive clone, or lifetime fight | Redesign ownership before adding escape hatches | [ownership.md](ownership.md) |
| Error type or `thiserror` vs `anyhow` unclear | Pick library/app/boundary strategy first | [error-handling.md](error-handling.md) |
| `Box<dyn Trait>` for flexibility | Closed set → enum; open known type → generic; erasure → `dyn` | [traits.md](traits.md) |
| Primitive represents validated/domain data | Newtype, parser, typestate, or builder | [type-design.md](type-design.md) |
| Blocking work or unbounded fan-out in async code | Async waits; CPU blocks elsewhere; bound everything | [async.md](async.md) |
| Atomic ordering chosen by vibe | Use atomics only with a small proof; otherwise locks/channels | [atomics.md](atomics.md) |
| Unsafe added to bypass compiler friction | Isolate unsafe and document the invariant | [unsafe.md](unsafe.md) |
| Macro added before simpler tools fail | Prefer functions/traits first; macros earn their complexity | [macros.md](macros.md) |
| Test suite needs generators, snapshots, mocks, benches, or fuzzing | Start with behavior tests; add tools for named gaps | [testing.md](testing.md) |
| Performance change without measurement | Measure release builds before optimizing | [performance.md](performance.md) |
| Wire format leaking into domain model | Treat serialization as boundary translation | [serde.md](serde.md) |
| FFI/host-runtime boundary | Keep the ABI small, typed, and panic-safe | [interop.md](interop.md) |
| Crate/workspace/API shape unclear | Stay single-crate until the boundary has a name | [project-structure.md](project-structure.md) |

## Cross-References

- **[idiomatic.md](idiomatic.md)** — General Rust review: newtypes, enums, exhaustive matching, parse-don't-validate, ownership restructuring, visibility.
- **[ownership.md](ownership.md)** — Borrow checker errors, lifetimes, function signatures, smart pointers, `Cow`, clone discipline.
- **[error-handling.md](error-handling.md)** — `thiserror` vs `anyhow`, structured errors, context, combinators, panic boundaries.
- **[traits.md](traits.md)** and **[type-design.md](type-design.md)** — Dispatch choices, trait design, newtypes, typestate, builders, phantom types.
- **[async.md](async.md)**, **[atomics.md](atomics.md)**, and **[unsafe.md](unsafe.md)** — Concurrency, memory ordering, soundness, Miri, `Send`/`Sync` invariants.
- **[macros.md](macros.md)**, **[testing.md](testing.md)**, and **[performance.md](performance.md)** — Generated code, validation strategy, profiling-first optimization.
- **[serde.md](serde.md)**, **[interop.md](interop.md)**, and **[project-structure.md](project-structure.md)** — Boundaries, DTOs, FFI, workspaces, features, public API surface.

## Review Checklist

1. **Domain primitive?** → Newtype, enum, or parser-backed type.
2. **Boolean or `Option<bool>` state?** → Named enum variants.
3. **Wildcard match on owned enum?** → Exhaustive match.
4. **Validation repeated downstream?** → Parse once at the boundary.
5. **Borrow checker appeased with `clone()`, `'static`, `Rc<RefCell<_>>`, or unsafe?** → Rework ownership first.
6. **Public signature takes owned data but only reads?** → Borrow `&str`, `&[T]`, or `&Path`.
7. **Library returns stringly or `anyhow` errors?** → Structured public error type.
8. **Polymorphism unclear?** → Enum, then generics, then `dyn` only for true erasure.
9. **Async code blocks, holds locks across `.await`, or fans out unboundedly?** → Move blocking work and bound concurrency.
10. **Unsafe or atomics present?** → Check the written invariant/proof and run Miri when relevant.
11. **Serde/FFI/API boundary leaks into internals?** → Translate DTOs into domain types.
12. **Performance concern?** → Measure `--release` before cleverness.
13. **Everything is `pub` or feature-gated internally?** → Curate the facade; keep features additive.

## Reference Index

**Topic files:** [idiomatic.md](idiomatic.md), [ownership.md](ownership.md), [error-handling.md](error-handling.md), [traits.md](traits.md), [type-design.md](type-design.md), [async.md](async.md), [atomics.md](atomics.md), [unsafe.md](unsafe.md), [macros.md](macros.md), [testing.md](testing.md), [performance.md](performance.md), [serde.md](serde.md), [interop.md](interop.md), [project-structure.md](project-structure.md)

**Idiomatic Rust:** [bool-to-enum.md](references/bool-to-enum.md), [borrow-by-default.md](references/borrow-by-default.md), [enums-as-modeling-tool.md](references/enums-as-modeling-tool.md), [exhaustive-matching.md](references/exhaustive-matching.md), [getter-setter.md](references/getter-setter.md), [impl-namespace.md](references/impl-namespace.md), [iterators-over-indexing.md](references/iterators-over-indexing.md), [newtypes-and-domain-types.md](references/newtypes-and-domain-types.md), [option-bool-to-enum.md](references/option-bool-to-enum.md), [option-over-sentinels.md](references/option-over-sentinels.md), [ownership-before-refcell.md](references/ownership-before-refcell.md), [parse-dont-validate.md](references/parse-dont-validate.md), [pattern-matching-tools.md](references/pattern-matching-tools.md), [struct-collections.md](references/struct-collections.md), [transform-over-mutate.md](references/transform-over-mutate.md), [visibility-and-modules.md](references/visibility-and-modules.md)

**Ownership:** [function-signatures.md](references/function-signatures.md), [lifetime-patterns.md](references/lifetime-patterns.md), [smart-pointers.md](references/smart-pointers.md)

**Errors:** [anyhow-patterns.md](references/anyhow-patterns.md), [combinators.md](references/combinators.md), [designing-error-types.md](references/designing-error-types.md), [thiserror-patterns.md](references/thiserror-patterns.md)

**Traits and type design:** [builder-patterns.md](references/builder-patterns.md), [dispatch-patterns.md](references/dispatch-patterns.md), [extension-traits.md](references/extension-traits.md), [newtype-patterns.md](references/newtype-patterns.md), [standard-traits.md](references/standard-traits.md), [trait-patterns.md](references/trait-patterns.md), [typestate-patterns.md](references/typestate-patterns.md)

**Async, atomics, and unsafe:** [blocking-and-bridging.md](references/blocking-and-bridging.md), [channels-and-select.md](references/channels-and-select.md), [ordering-cheatsheet.md](references/ordering-cheatsheet.md), [ownership-handoff-deadlocks.md](references/ownership-handoff-deadlocks.md), [patterns-from-rust-atomics-and-locks.md](references/patterns-from-rust-atomics-and-locks.md), [production-patterns.md](references/production-patterns.md), [ub-boundaries.md](references/ub-boundaries.md), [miri-and-unsafe-testing.md](references/miri-and-unsafe-testing.md), [safety-comments-and-unsafe-contracts.md](references/safety-comments-and-unsafe-contracts.md), [ub-and-validity.md](references/ub-and-validity.md)

**Macros, tests, and performance:** [macro_rules-patterns.md](references/macro_rules-patterns.md), [proc-macro-patterns.md](references/proc-macro-patterns.md), [testing-and-debugging-macros.md](references/testing-and-debugging-macros.md), [benchmarking-and-fuzzing.md](references/benchmarking-and-fuzzing.md), [property-testing.md](references/property-testing.md), [snapshot-testing.md](references/snapshot-testing.md), [allocation-and-data-structures.md](references/allocation-and-data-structures.md), [profiling-and-benchmarking.md](references/profiling-and-benchmarking.md)

**Serde, interop, and project structure:** [adapters-and-custom-impls.md](references/adapters-and-custom-impls.md), [attributes-cheatsheet.md](references/attributes-cheatsheet.md), [c-ffi.md](references/c-ffi.md), [cxx.md](references/cxx.md), [napi-rs.md](references/napi-rs.md), [pyo3.md](references/pyo3.md), [uniffi.md](references/uniffi.md), [wasm-bindgen.md](references/wasm-bindgen.md), [features-and-unification.md](references/features-and-unification.md), [public-api-surface.md](references/public-api-surface.md), [workspaces-and-layout.md](references/workspaces-and-layout.md)
