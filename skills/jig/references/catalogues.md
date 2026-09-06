# The error catalogues

The catalogue is now one edition per language ecosystem, and it lives at
[`jig/catalogues/`](../../../catalogues/). Read
[`catalogues/README.md`](../../../catalogues/README.md) for what the data means,
what it does not claim, and the closed vocabularies every edition uses.
[`catalogues/index.json`](../../../catalogues/index.json) is what a scan reads to
pick an edition without opening half a megabyte of class rows.

What matters at the operator surface is short:

- **The catalogue informs; it never gates.** It supplies shape, naming,
  severity and calibration in the language at hand. A mistake with no row in any
  edition is still guarded — the model writes the check and the fixture pair
  admits it.
- **Class ids are namespaced by edition**, so a polyglot repository can load
  several editions and a shared id is never ambiguous.
- **No class is measured.** Rows are `documented` (a tool's own reference
  confirms the rule id or flag) or `reasoned` (nothing but the argument behind
  it). Coverage is uneven between editions, and a shared id does not mean equal
  detection.
- **`verify` and `seed` blocks are declared, not executed.** An expected exit
  code is an assertion about a tool, not a measurement of it, until the
  witnessed close runs it here.

## The superseded single-file catalogue

`jig/scripts/legacy/catalogue-1.0.1.json` is the one-file Node-only catalogue
the editions replace, kept only as `migrate`'s input. **Verified on 2026-08-07.**
It gated what could be installed, which is the stance the editions abandon. Its
ids migrate by an explicit map:

| Old id | New id |
| --- | --- |
| `silent-catch` | `swallowed-exception` |
| `focused-or-skipped-test` | `skipped-test` |
| `pipe-to-shell` | carried forward as an authored check — no edition equivalent |
| `test-file-deletion` | carried forward as an authored check — no edition equivalent |

An installed guard keeps its ledger history under its new name; the migration is
one journaled transaction and reverts like any other.
