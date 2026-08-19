# Working in this VelarScript project

This project is written in VelarScript (`.vel` sources). VelarScript's
parents are JavaScript and Python: write on those priors and the compiler
teaches the rest. Run `velar skill` for the full language brief — it ships
with the toolchain and prints agent-ready markdown to stdout.

## Gates

Run these before considering any change done:

- `velar check` — type-checks the whole project; do exactly what each
  diagnostic says (it names the one current spelling).
- `velar test` — runs the project's tests.
- `velar format` — settles layout (`velar format --check` verifies).

`npm run validate` runs this project's full gate set from package.json.

## The essentials

- Interpolation is `f"{value}"` — `${...}` inside a string is literal
  text (the one silent trap).
- Comments are `//`. Functions are `def`. Record shapes and aliases are
  `type`.
- `.size` not `.length`; `.append(value)` not `.push(value)`.
- Conditions accept only `bool`; test presence with `value != null`.
- One statement per line; no `++`; named arguments are `name=value`.
- `match` dispatches finite states; `case _:` is the fallback.
- `await task()` or detached `async task()` — a dropped Promise is a
  compile error.
- `range` needs `import {range} from "velar/collections"`.
- Multi-line text is a layout string: a quote followed by a newline opens
  it; a quote at the opening line's indentation closes it.
- `print(value)` inspects any value; f-strings and `str()` accept only
  strings, numbers, bools, enums, and `null` — `stringify` from
  `velar/json` builds data text.

`velar skill` covers the rest: the declaration reference, the idiom
cookbook, and the complete pitfall table.

## When VelarScript is missing something

In order: `extern module` declares a checked boundary to any npm package
(first choice); `import js unsafe` admits a raw value as `any` — validate
it with `Type.parse` at the edge; `import css unsafe "./file.css"
before|after look` and `unsafe:html` cover styling and markup. If the
compiler itself seems wrong, reduce to a minimal repro and report it; the
emitted `velar build` JavaScript is always a readable, source-mapped exit
that runs without the toolchain. `velar skill` includes the full
escape-hatch decision tree.
