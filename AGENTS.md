# Working in this VelarScript project

## 项目全局规则

1. 不考虑兼容。以当前设计为唯一标准，重构时直接重建格式、协议和存储。
2. 原始数据与运行时数据分层存放；`data/` 只放人工定义，生成结果统一进入 `generated/`。

This project is written in VelarScript (`.vel` sources). VelarScript's
parents are JavaScript and Python. Read `velar skill core` and the relevant
`velar skill web` or `velar skill node` brief before editing. These commands
print the installed toolchain's local references.

Run `velar skill core topics` to discover the version-matched reference.
Read `contract` for the Core standard, `types` for records and readonly,
`collections` before replacing loops, `control` for match and error flow,
and `validation` for unknown values and Runtime Type checks. The topic
syntax is `velar skill core <topic>`; `api` lists existing Core helpers.

Inspect the compiler-owned project graph before changing module boundaries:
`velar graph apps/web` or `velar graph packages/world/generation` shows
imports, declarations, and calls for that workspace.

## Gates

Run the relevant workspace commands before considering a change done:

- `velar check` — type-checks the whole project; do exactly what each
  diagnostic says (it names the one current spelling).
- `velar test` — runs the project's tests.
- `velar format` — settles layout (`velar format --check` verifies).

From the repository root, `npm run validate` runs the quick gate.
`npm run validate:full` runs the full static and browser gates. Use the
workspace's package.json to select narrower checks while implementing.

Run validation through the npm scripts so the shared machine-local task slot,
low process priority and cancellation cleanup apply. Keep the default one-job
workspace and Node test concurrency. During iteration use `test:file`,
`test:native` or `test:workspaces -- <workspace-name>` for the affected scope.
Run full generation corpora and browser/GPU captures only when needed, one
task at a time; do not overlap them with another validation or benchmark.

## The essentials

- Interpolation is `f"{value}"` — `${...}` inside a string is literal
  text (the one silent trap).
- Comments are `//`. Functions are `def`. Record shapes and aliases are
  `type`.
- `.size` not `.length`; `.append(value)` not `.push(value)`.
- Conditions accept `bool` or `bool?`; only `true` enters the branch.
  Test other values for presence with `value != null`.
- One statement per line; no `++`; named arguments are `name=value`.
- Every `match` must cover its input type completely. A guard does not
  establish coverage; use `case _: pass` for an intentional no-op remainder.
- `readonly` protects one layer. `readonly type State` protects its field
  slots; nested values retain their declared types. Use `readonly List<T>`
  to protect list slots while T retains its declared permissions. For a mutable
  record type T, `readonly List<readonly T>` protects both layers; a declared
  readonly type already provides the inner protection.
- Return named records for business results with multiple fields; `Pair<A, B>`
  expresses a generic pair, and `List<T>` expresses a homogeneous sequence.
- `await task()` or `detach task()` — a dropped Promise is a
  compile error.
- `range(...)` is a Core prelude function and needs no import.
- Multi-line text is a layout string: a quote followed by a newline opens
  it; a quote at the opening line's indentation closes it.
- `print(value)` inspects any value; f-strings and `str()` accept only
  strings, numbers, bools, enums, and `null` — `Json.stringify(value)`
  builds data text.

`velar skill core topics` is the entry to the declaration reference,
collection contracts, Runtime Type validation, and standard API vocabulary.

## When VelarScript is missing something

In order: `extern module` declares a checked boundary to any npm package
(first choice); `import js unsafe` admits a restricted `unknown` value —
validate it with `Type.parse` at the edge before using it; `import css unsafe "./file.css"
before|after look` and `unsafe:html` cover styling and markup. If the
compiler itself seems wrong, reduce to a minimal repro and report it; the
emitted `velar build` JavaScript is always a readable, source-mapped exit
that runs without the toolchain. `velar skill core modules` documents these
boundaries and their checked alternatives.
