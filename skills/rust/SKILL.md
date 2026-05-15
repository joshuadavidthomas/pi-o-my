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

Use this skill when Rust judgment matters. Treat the rules below as strong defaults, not laws. When a topic gets deep, load the linked topic file; when a narrow pattern matters, load the direct reference.

## Topics

| If you are working on... | Start here |
|---|---|
| Rust style, idioms, code review, or code translated from another language | [idiomatic.md](idiomatic.md) |
| Borrow checker errors, lifetimes, cloning, smart pointers, `Rc`, `Arc`, `Cow` | [ownership.md](ownership.md) |
| Error types, `thiserror`, `anyhow`, `?`, `bail!`, panics, context | [error-handling.md](error-handling.md) |
| Enum vs trait vs generic vs `dyn Trait`, object safety, orphan rules | [traits.md](traits.md) |
| Newtypes, typestate, builders, phantom types, parse-don't-validate | [type-design.md](type-design.md) |
| `async`/Tokio, channels, spawning, timeouts, cancellation, blocking work | [async.md](async.md) |
| `Atomic*`, `Ordering`, CAS loops, lock-free flags/counters | [atomics.md](atomics.md) |
| `unsafe`, raw pointers, `MaybeUninit`, `ManuallyDrop`, `repr(C)`, Miri | [unsafe.md](unsafe.md) |
| `macro_rules!`, proc macros, hygiene, `syn`, `quote`, `cargo expand` | [macros.md](macros.md) |
| Unit/integration/doc tests, proptest, insta, rstest, mockall, criterion, fuzzing | [testing.md](testing.md) |
| Profiling, allocations, collections, iterators, release builds, clippy perf | [performance.md](performance.md) |
| Serde derives, attributes, enum wire formats, adapters, DTO boundaries | [serde.md](serde.md) |
| FFI and host runtimes: C, C++, Python, Node, Wasm, Swift/Kotlin/Python bindings | [interop.md](interop.md) |
| Crate layout, workspaces, public API surface, Cargo features, `Cargo.toml` | [project-structure.md](project-structure.md) |

## Core Rust Defaults

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

## Decision Spines

### Ownership

Borrow when the caller owns and you only read. Take `&mut T` when you mutate in place. Take `T` when you store it, transform it into another owned value, send it to another task/thread, or need to prove nobody else can use it. Return borrowed values from accessors; return owned values from constructors, parsers, and transformations.

If the borrow checker fights you, first ask what it is proving: moved value, overlapping mutable borrow, reference outlives owner, temporary dropped too early, or shared state across tasks. Fix the ownership shape before adding clones, `'static`, `Rc<RefCell<_>>`, or `unsafe`.

→ Deep dives: [ownership.md](ownership.md), [references/lifetime-patterns.md](references/lifetime-patterns.md), [references/smart-pointers.md](references/smart-pointers.md)

### Errors

Libraries return structured, public errors, usually with `thiserror`. Applications use `anyhow` at the top level and add `.context()` at abstraction boundaries. At boundaries, translate: dependency error → domain error → user/API error. Panic only for bugs, violated internal invariants, or truly unreachable code.

→ Deep dives: [error-handling.md](error-handling.md), [references/designing-error-types.md](references/designing-error-types.md), [references/thiserror-patterns.md](references/thiserror-patterns.md), [references/anyhow-patterns.md](references/anyhow-patterns.md)

### Polymorphism

Use an enum for a closed set. Use generics or `impl Trait` when the caller chooses the type and monomorphization is fine. Use `dyn Trait` only when you need runtime heterogeneity, plugin-like extension, or type erasure. Associated types mean one answer per implementor; generic parameters mean many possible answers.

→ Deep dives: [traits.md](traits.md), [references/dispatch-patterns.md](references/dispatch-patterns.md), [references/trait-patterns.md](references/trait-patterns.md)

### Async and concurrency

Async is for waiting, not for CPU work. Never block the runtime; use async APIs for I/O, `spawn_blocking` for short blocking calls, Rayon or dedicated threads for CPU-bound work. Do not hold mutex guards across `.await`. Give external calls timeouts. Bound concurrency and channels.

For shared state, prefer message passing or a small wrapper around `Arc<Mutex<T>>` with non-async methods. Use atomics for simple flags/counters with a clear proof; otherwise use locks or channels.

→ Deep dives: [async.md](async.md), [atomics.md](atomics.md), [references/channels-and-select.md](references/channels-and-select.md), [references/ordering-cheatsheet.md](references/ordering-cheatsheet.md)

### Macros and unsafe

Do not write a macro until a function, trait, generic, or existing derive fails. Prefer `macro_rules!` for syntax repetition and proc macros for deriving or transforming Rust syntax. Test macro failures with `trybuild`.

Do not write unsafe to placate the borrow checker. Contain unsafe in the smallest private surface, provide a safe wrapper, document `# Safety` on unsafe APIs, add `// SAFETY:` comments for blocks, and run Miri when validity or aliasing is involved.

→ Deep dives: [macros.md](macros.md), [unsafe.md](unsafe.md), [references/testing-and-debugging-macros.md](references/testing-and-debugging-macros.md), [references/safety-comments-and-unsafe-contracts.md](references/safety-comments-and-unsafe-contracts.md)

### Data boundaries and project shape

Serde, FFI, CLI, HTTP, and database boundaries should translate into internal domain types. Use DTOs at the edge, validate/parse once, and keep rich invariants inside. Stay single-crate until you can name a real crate boundary; when you make a workspace, remember Cargo features are additive and unified across the graph.

→ Deep dives: [serde.md](serde.md), [interop.md](interop.md), [project-structure.md](project-structure.md), [references/features-and-unification.md](references/features-and-unification.md)

## Common Agent Failure Modes

| Smell | Better Rust move |
|---|---|
| Bare `String`, `u64`, or `bool` with domain meaning | Newtype or enum with named variants |
| `kind` plus optional fields | Enum variants with payloads |
| `_ =>` on an enum you control | Exhaustive match |
| `Error(String)` or crate-wide error blob | Structured error enum for one unit of fallibility |
| `anyhow::Error` in public library API | Library error type; `anyhow` in binaries/apps |
| Bare `?` loses context in app code | Add `.context()` at abstraction boundaries |
| `clone()` or `'static` added to appease the compiler | Revisit ownership and lifetimes |
| `&String`, `&Vec<T>`, `&PathBuf` in APIs | `&str`, `&[T]`, `&Path` |
| `Rc<RefCell<T>>` or `Arc<Mutex<T>>` as first resort | Restructure ownership or use message passing |
| `dyn Trait` for a closed set | Enum |
| `std::fs`, `thread::sleep`, or CPU loops in `async fn` | Async APIs, `spawn_blocking`, or Rayon/thread pool |
| Holding a lock guard across `.await` | Narrow lock scope or redesign shared state |
| `Ordering::Relaxed` for publication | Release/Acquire pair or `SeqCst` until proved otherwise |
| `unsafe impl Send/Sync` without invariant comments | Document and test the invariant |
| `mem::transmute` for bytes or flags | Parser, `from_*`, `bytemuck` with proof, or explicit conversion |
| Proc macro for simple repetition | Function, trait, derive, or `macro_rules!` |
| `serde_json::Value` as internal model | DTO at the boundary, domain types inside |
| `#[serde(untagged)]` to make parsing work | Prefer explicit tags; use untagged only deliberately |
| Benchmarking debug builds | Measure `--release` with Criterion/profiler |
| Feature flags for internal workspace architecture | Crate boundaries/modules; features only for additive public capability |

## Review Checklist

1. Are domain invariants represented by types, not comments or repeated validation?
2. Are public signatures using borrowed forms and ownership intentionally?
3. Do errors carry structured facts and preserve source chains where useful?
4. Is polymorphism the simplest correct kind: enum, generic, then `dyn`?
5. Does async code avoid blocking, unbounded concurrency, and locks across `.await`?
6. Are shared-state primitives chosen by semantics, not habit?
7. Is unsafe isolated, documented, and backed by tests/Miri where relevant?
8. Are serde/FFI/API boundaries translating into domain types?
9. Are tests behavior-focused, deterministic, and using extra crates only for named gaps?
10. Was performance measured in release mode before optimization?
11. Is the public API curated with minimal visibility and stable names?
12. Are Cargo features additive and checked with `cargo tree -e features` when surprising?

## Reference Index

**Topic files:** [idiomatic.md](idiomatic.md), [ownership.md](ownership.md), [error-handling.md](error-handling.md), [traits.md](traits.md), [type-design.md](type-design.md), [async.md](async.md), [atomics.md](atomics.md), [unsafe.md](unsafe.md), [macros.md](macros.md), [testing.md](testing.md), [performance.md](performance.md), [serde.md](serde.md), [interop.md](interop.md), [project-structure.md](project-structure.md)

**Idiomatic Rust:** [bool-to-enum.md](references/bool-to-enum.md), [borrow-by-default.md](references/borrow-by-default.md), [enums-as-modeling-tool.md](references/enums-as-modeling-tool.md), [exhaustive-matching.md](references/exhaustive-matching.md), [getter-setter.md](references/getter-setter.md), [impl-namespace.md](references/impl-namespace.md), [iterators-over-indexing.md](references/iterators-over-indexing.md), [newtypes-and-domain-types.md](references/newtypes-and-domain-types.md), [option-bool-to-enum.md](references/option-bool-to-enum.md), [option-over-sentinels.md](references/option-over-sentinels.md), [ownership-before-refcell.md](references/ownership-before-refcell.md), [parse-dont-validate.md](references/parse-dont-validate.md), [pattern-matching-tools.md](references/pattern-matching-tools.md), [struct-collections.md](references/struct-collections.md), [transform-over-mutate.md](references/transform-over-mutate.md), [visibility-and-modules.md](references/visibility-and-modules.md)

**Ownership:** [function-signatures.md](references/function-signatures.md), [lifetime-patterns.md](references/lifetime-patterns.md), [smart-pointers.md](references/smart-pointers.md)

**Errors:** [anyhow-patterns.md](references/anyhow-patterns.md), [combinators.md](references/combinators.md), [designing-error-types.md](references/designing-error-types.md), [thiserror-patterns.md](references/thiserror-patterns.md)

**Traits and type design:** [builder-patterns.md](references/builder-patterns.md), [dispatch-patterns.md](references/dispatch-patterns.md), [extension-traits.md](references/extension-traits.md), [newtype-patterns.md](references/newtype-patterns.md), [standard-traits.md](references/standard-traits.md), [trait-patterns.md](references/trait-patterns.md), [typestate-patterns.md](references/typestate-patterns.md)

**Async, atomics, and unsafe:** [blocking-and-bridging.md](references/blocking-and-bridging.md), [channels-and-select.md](references/channels-and-select.md), [ordering-cheatsheet.md](references/ordering-cheatsheet.md), [ownership-handoff-deadlocks.md](references/ownership-handoff-deadlocks.md), [patterns-from-rust-atomics-and-locks.md](references/patterns-from-rust-atomics-and-locks.md), [production-patterns.md](references/production-patterns.md), [ub-boundaries.md](references/ub-boundaries.md), [miri-and-unsafe-testing.md](references/miri-and-unsafe-testing.md), [safety-comments-and-unsafe-contracts.md](references/safety-comments-and-unsafe-contracts.md), [ub-and-validity.md](references/ub-and-validity.md)

**Macros, tests, and performance:** [macro_rules-patterns.md](references/macro_rules-patterns.md), [proc-macro-patterns.md](references/proc-macro-patterns.md), [testing-and-debugging-macros.md](references/testing-and-debugging-macros.md), [benchmarking-and-fuzzing.md](references/benchmarking-and-fuzzing.md), [property-testing.md](references/property-testing.md), [snapshot-testing.md](references/snapshot-testing.md), [allocation-and-data-structures.md](references/allocation-and-data-structures.md), [profiling-and-benchmarking.md](references/profiling-and-benchmarking.md)

**Serde, interop, and project structure:** [adapters-and-custom-impls.md](references/adapters-and-custom-impls.md), [attributes-cheatsheet.md](references/attributes-cheatsheet.md), [c-ffi.md](references/c-ffi.md), [cxx.md](references/cxx.md), [napi-rs.md](references/napi-rs.md), [pyo3.md](references/pyo3.md), [uniffi.md](references/uniffi.md), [wasm-bindgen.md](references/wasm-bindgen.md), [features-and-unification.md](references/features-and-unification.md), [public-api-surface.md](references/public-api-surface.md), [workspaces-and-layout.md](references/workspaces-and-layout.md)
