# Think in Rust

You already know Rust syntax. This skill changes your **defaults** — what you reach for first when modeling a domain, handling errors, or designing an API.

The core failure mode: writing Rust that compiles but thinks like Python, Java, or TypeScript. Bare `String` for domain types. `bool` for states. Trait objects for closed sets. `Error(String)` for everything. `_ =>` in every match. Index-based loops. Sentinel values. Getters and setters on every field. These compile. They are wrong.

Most of these habits come from languages without sum types, ownership, or zero-cost newtypes. Recognizing *where* a pattern comes from helps you see *why* it's wrong in Rust.

This skill is the **general-purpose entry point** for Rust code review. It establishes thinking-in-Rust defaults and recognizes patterns imported from other languages. For specialized problems, it delegates to [error-handling.md](error-handling.md) (thiserror vs anyhow, error boundaries), [traits.md](traits.md) (trait design, object safety, dispatch), [ownership.md](ownership.md) (borrow checker errors, lifetime design), [type-design.md](type-design.md) (typestate, phantom types, advanced builders), and [project-structure.md](project-structure.md) (workspace/crate organization, module layout).

Treat these as strong defaults, not rigid laws: when unsure, choose the approach that moves invariants into types and lets the compiler enforce them.

## How Rust Thinks

### Model the domain in types

**1. Every string with domain meaning is a newtype.** Bare `String` erases domain knowledge. The compiler can't distinguish an email from a username from a URL. Wrap it, validate at construction, keep the field private. See [references/newtypes-and-domain-types.md](references/newtypes-and-domain-types.md). *Authority: Rust API Guidelines [C-NEWTYPE]. std: `PathBuf`, `NonZero<u32>`.*

**2. Every boolean parameter is a lie — use an enum.** `true`/`false` carry no meaning at the call site and can't extend to a third state. Replace with a two-variant enum. Applies to struct fields too — correlated booleans are a state machine in disguise. See [references/bool-to-enum.md](references/bool-to-enum.md). *Authority: Rust API Guidelines [C-CUSTOM-TYPE]. clippy: `fn_params_excessive_bools`.*

**3. Every "I don't know" is explicit.** `Option<bool>` has three states but none of them are named. `vec![]` conflates "checked, found nothing" with "haven't checked." Make each state a named variant. See [references/option-bool-to-enum.md](references/option-bool-to-enum.md).

**4. Every match is exhaustive — no wildcard `_ =>` arms.** Wildcards silence the compiler when you add variants. List every variant of enums you control. The only acceptable `_ =>` is for `#[non_exhaustive]` foreign types and primitives. See [references/exhaustive-matching.md](references/exhaustive-matching.md). *Authority: clippy: `wildcard_enum_match_arm`, `match_wildcard_for_single_variants`.*

**5. Every error variant is a domain fact — no `Error(String)`.** String errors throw away structure. Callers can't match, test, or recover. Define a typed error enum for libraries; use `anyhow` for application binaries. See [error-handling.md](error-handling.md) for the full strategy. *Authority: Effective Rust Item 4. std: `io::ErrorKind`.*

**6. Parse, don't validate.** Validation checks data and throws away the proof. Parsing checks data and encodes the result in the type. After parsing, the type guarantees validity — no re-checking downstream. Parse at system boundaries, use domain types internally. See [references/parse-dont-validate.md](references/parse-dont-validate.md). *Authority: Alexis King. std: `NonZero<T>`, `IpAddr`, `SocketAddr`.*

**7. Enums are the primary modeling tool.** Rust enums are sum types. They represent closed sets: HTTP methods, AST nodes, config variants, state machines. A struct with a "kind" field plus `Option` fields is always an enum waiting to be written. See [references/enums-as-modeling-tool.md](references/enums-as-modeling-tool.md). *Authority: std: `IpAddr`, `Cow`, `Option`, `Result`.*

**8. Enums for closed sets, trait objects for open sets.** If you know all variants at compile time, use an enum (zero-cost, exhaustive matching, per-variant data). Use `dyn Trait` or generics only when the set is genuinely open (plugins, user-defined types). Default to `impl Trait`/generics over `Box<dyn Trait>` for function parameters. See [traits.md](traits.md) for the full decision framework.

**9. Borrow by default — own when intentional.** Functions should borrow unless they need ownership. Prefer `&str` over `&String`, `&[T]` over `&Vec<T>`, `&Path` over `&PathBuf`. Take ownership when storing, transforming-and-returning, or moving to another thread. See [references/borrow-by-default.md](references/borrow-by-default.md). *Authority: Effective Rust Items 14-15. Rust API Guidelines [C-CALLER-CONTROL].*

### Express intent in APIs and control flow

**10. Iterators over index loops.** `for i in 0..v.len()` bypasses iterator optimizations, risks off-by-one errors, and obscures intent. Use `.iter()`, `.enumerate()`, `.windows()`, `.zip()`. Iterators enable bounds-check elimination, vectorization, and fusion. See [references/iterators-over-indexing.md](references/iterators-over-indexing.md).

**11. `Option` over sentinel values.** `-1`, `""`, `u32::MAX` as "no value" markers are invisible to the type system. Use `Option<T>`. The compiler forces callers to handle absence. `Option<NonZeroU32>` even has the same size as `u32`. See [references/option-over-sentinels.md](references/option-over-sentinels.md).

**12. One struct per entity, not parallel collections.** Multiple `HashMap`s sharing keys means nothing guarantees they stay in sync. Group related data into a struct, store in a single `HashMap<Key, Entity>`. See [references/struct-collections.md](references/struct-collections.md).

**13. Transform over mutate.** For configuration and construction, prefer consuming `self` with method chaining over `&mut self` setters. Reserve `&mut self` for live objects being operated on. See [references/transform-over-mutate.md](references/transform-over-mutate.md).

**14. Restructure ownership before `Rc<RefCell<T>>`.** `Rc<RefCell>` trades compile-time borrow checking for runtime panics. First try: split borrows, pass `&mut` through parameters, use arena/index patterns for graphs. See [references/ownership-before-refcell.md](references/ownership-before-refcell.md). See also [ownership.md](ownership.md) for borrow checker strategies.

**15. Modules are namespaces, not `impl` blocks.** A unit struct with only associated functions is a Java class in disguise. Use modules for namespacing free functions. Use extension traits when you need method syntax on existing types. See [references/impl-namespace.md](references/impl-namespace.md).

**16. Right-size your pattern matching.** `matches!()` for boolean checks. `if let` for one variant. `let ... else` for one variant with early return. `match` for two or more variants. Full exhaustive `match` when adding a variant should break the build. See [references/pattern-matching-tools.md](references/pattern-matching-tools.md).

**17. Public fields over trivial getters.** If any value of the field's type is valid, make it `pub`. Don't write `get_x()`/`set_x()` that just forward to a field. When you do need accessors, use Rust naming: `name()` not `get_name()`. See [references/getter-setter.md](references/getter-setter.md). *Authority: Rust API Guidelines [C-GETTER].*

**18. Visibility is a design tool, not an afterthought.** When everything is `pub` or everything lives in one file, you haven't designed an API surface. Use modules to group by domain, `pub use` to curate what's exported, and `pub(crate)` / private to enforce boundaries. See [references/visibility-and-modules.md](references/visibility-and-modules.md). See also [project-structure.md](project-structure.md) for crate/workspace organization.

## Common Mistakes (Agent Failure Modes)

- **Public newtype fields (`pub struct Email(pub String)`)** → Make the field private; force construction through `parse`/`new` so invariants can't be bypassed.
- **Boolean flags leaking into APIs** → Replace with enums, even when there are only two states today.
- **"Kind" field + `Option` payload fields** → Replace with an enum carrying per-variant data; delete the `Option` fields.
- **Wildcard matches on your own enums** → List every variant; adding a variant should break the build.
- **Validation that returns `Result<(), E>`** → Parse once at the boundary into a domain type; pass the domain type forward.
- **`Error(String)` / `anyhow::Error` in a library** → Define a structured error enum; reserve `anyhow` for application boundaries.
- **Taking ownership by default** → Borrow (`&str`, `&[T]`, `&Path`) unless you store/return/transfer ownership.
- **`.clone()` as first resort** → Restructure to separate read/write phases, split borrows, or use indices.
- **Everything `pub`** → Treat `pub` as a semver commitment in libraries; use `pub(crate)` for internal sharing.
- **Defaulting to `dyn Trait`** → A habit from interface-oriented languages. In Rust, enums and generics are usually better.

## Quick Reference

| Code Smell | Rust default move | Reference |
|---|---|---|
| Bare `String` for domain values | Newtype with private field | [newtypes-and-domain-types](references/newtypes-and-domain-types.md) |
| `bool` parameter or state field | Two-variant enum | [bool-to-enum](references/bool-to-enum.md) |
| `Option<bool>` / nested `Option` | Named enum variants | [option-bool-to-enum](references/option-bool-to-enum.md) |
| `_ =>` on your own enum | List every variant | [exhaustive-matching](references/exhaustive-matching.md) |
| `Error(String)` in a library | Typed error enum (thiserror) | See [error-handling.md](error-handling.md) |
| Validate then forget | Parse into a domain type | [parse-dont-validate](references/parse-dont-validate.md) |
| "Kind" field + `Option` payloads | Enum with per-variant data | [enums-as-modeling-tool](references/enums-as-modeling-tool.md) |
| `Box<dyn Trait>` for closed set | Enum (or generics) | See [traits.md](traits.md) |
| `fn(Vec<T>)` that only reads | `fn(&[T])` — borrow | [borrow-by-default](references/borrow-by-default.md) |
| `for i in 0..v.len()` | `.iter()` / `.enumerate()` | [iterators-over-indexing](references/iterators-over-indexing.md) |
| `-1` / `""` / `MAX` for "no value" | `Option<T>` | [option-over-sentinels](references/option-over-sentinels.md) |
| Parallel `HashMap`s with shared keys | Single `HashMap<K, Struct>` | [struct-collections](references/struct-collections.md) |
| `&mut self` setters for builders | Consuming `self` chains | [transform-over-mutate](references/transform-over-mutate.md) |
| `Rc<RefCell<T>>` as first resort | Split borrows / arenas | [ownership-before-refcell](references/ownership-before-refcell.md) |
| Unit struct as function namespace | Module with free functions | [impl-namespace](references/impl-namespace.md) |
| `match x { Some(v) => ..., _ => {} }` | `if let Some(v) = x` | [pattern-matching-tools](references/pattern-matching-tools.md) |
| `get_x()` / `set_x()` on every field | `pub` fields or `x()` | [getter-setter](references/getter-setter.md) |
| Everything `pub` / one giant file | Modules + visibility controls | [visibility-and-modules](references/visibility-and-modules.md) |

## Cross-References

- [type-design.md](type-design.md) — Newtype construction, typestate, phantom types, builder patterns
- [error-handling.md](error-handling.md) — Full error strategy (library vs app, thiserror vs anyhow, `?` chains)
- [ownership.md](ownership.md) — Borrow checker errors, smart pointers, lifetime design
- [traits.md](traits.md) — Trait design, static vs dynamic dispatch, object safety
- [project-structure.md](project-structure.md) — Module layout, visibility, workspace design, API surfaces

## Review Checklist

1. **Bare `String` in a struct or signature?** → Newtype it.
2. **`bool` parameter or struct field?** → Two-variant enum.
3. **`Option<bool>` or nested `Option`?** → Named enum variants.
4. **`_ =>` on an enum you control?** → List every variant.
5. **`Error(String)` or `anyhow!` in a library?** → Typed error enum.
6. **Validation returning `Result<(), E>`?** → Parse into a domain type.
7. **"Kind" field + `Option` fields?** → Enum with per-variant data.
8. **`dyn Trait` for an enumerable set?** → Enum.
9. **Takes `Vec<T>`/`String` by value but only reads?** → Borrow `&[T]`/`&str`.
10. **`for i in 0..len`?** → Iterator chain.
11. **Magic number/string for "absent"?** → `Option<T>`.
12. **Parallel collections with shared keys?** → Single collection of structs.
13. **`&mut self` builder setters?** → Consuming `self` method chains.
14. **`Rc<RefCell>` or `.clone()` to silence borrow checker?** → Restructure ownership.
15. **Unit struct with only associated functions?** → Module.
16. **`match` with one meaningful arm?** → `if let` / `let else` / `matches!`.
17. **Trivial `get_x()`/`set_x()` with no invariants?** → `pub` field.
18. **Everything `pub`, or everything in one file?** → Modules + visibility. See [project-structure.md](project-structure.md).
