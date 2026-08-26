# Writing and running the fix transaction

Loaded from step 5 of the audit skill, and only when a fix was approved. Nothing
here is needed to read a report.

Mutation is one explicit transaction, and the engine owns every mechanical part
of it: the fingerprints, the exact patch, the staleness check, the journal and
the rollback state. You own the wording and the approval. Never hand-edit a file
this flow is going to write — an `Edit` behind the transaction's back leaves the
plan stale and the journal blind.

## The draft plan

**Assemble one `.assay-tmp/draft-plan.json`.** Each approved fix is one change:

```json
{
  "changes": [{
    "id": "rewrite-prettier",
    "kind": "rule-rewrite",
    "rationale": "The rule names no firing moment, so the duty gets skipped.",
    "addresses": "<the rule's `key` from the scan>",
    "patches": [{
      "path": "CLAUDE.md",
      "old": "- Run prettier before committing.",
      "new": "- Before committing, run `npx prettier --write .` over every staged file."
    }],
    "predicted": "resolves the trigger-distance finding on this rule",
    "limitations": ["wording only — compliance is not measured here"]
  }],
  "batches": { "fix-batch": ["rewrite-prettier"] }
}
```

- `id` — yours, stable and unique in the plan. It is what the user approves and
  what every later command names.
- `kind` — `rule-rewrite`, `stale-reference-repair`, `placement-promotion`, or
  `park`.
- `addresses` — the rule's `key` from the scan. Always set it on any change
  aimed at a specific rule: it is what lets `validate` find the rewritten rule
  and report where it landed and what it now carries. Without it, validation
  records only the corpus state.
- `patches[].old` — the **exact** current text, with enough surrounding context
  to appear exactly once. Match by text, never by line number. `"old": null`
  creates a file, and `plan` refuses if that file already exists.
- Never state a source hash yourself — `plan` fingerprints every affected file.
- `batches` — optional, and unused by these commands: every change is approved
  by id.

## What each kind carries

- **Weak rule** → `rule-rewrite` on its dominant weakness: one bullet under ~30
  words with a concrete trigger (WHEN), an explicit action (WHAT), and the
  specifics needed to comply. F1 → open with the directive and drop "try to" or
  "where possible" unless the rule truly is optional. F2 → pair the prohibition
  with its alternative, or name the escape hatch when nothing replaces the banned
  action. F3 → name the firing moment ("Before committing…"); distant duties like
  changelog sync need this most. F4 → move it to a `.claude/rules/<topic>.md`
  with `paths:` frontmatter, as two patches in one change, after confirming with
  `Glob` that the glob matches a real file. F5 → move it into the top quarter of
  its file, text unchanged. F7 → replace abstract adjectives with a path, an
  identifier in backticks, or a numeric threshold. Keep the author's intent
  exactly: you are re-phrasing, not re-deciding, and a changed meaning is the one
  thing no check catches. Never merge two rules. A file whose problem is its
  shape lands under **Restructure candidates** and is reshaped by hand — this
  pass never rewrites a whole file.
- **Weak skill or subagent description** → `rule-rewrite` whose `old` is the
  exact current frontmatter block. Read
  `${CLAUDE_PLUGIN_ROOT}/skills/craft-skill/references/recipe.md` first and edit
  only the frontmatter, never the body. A model-invocable one gets the recipe's
  three parts folded into `description` — a concrete base sentence naming real
  artifacts, a "Use when…" clause, a "Do NOT use when…" exclusion — with any
  `when_to_use` merged in and that field deleted. Rephrase in place and come out
  **no longer than you started**, under 1,536 characters: past the cap the tail
  truncates in the listing and the exclusion is the first thing lost. Keep the
  base sentence terse — enumerating a domain's whole surface measurably lowers
  firing, and shortening it is the highest-value edit here. Quoted phrasings are
  optional, and ones that miss the real ask narrow the router: rewrite or delete
  those rather than inventing more. A `disable-model-invocation` skill inverts —
  trim it to one short plain sentence and delete the trigger machinery, because
  nothing routes on it. A skill neither side can invoke is reported, never
  edited.
- **Dead reference** → `stale-reference-repair`, the kind behind the menu's
  `Repair [N] dead references`. "likely moved to `X`" repoints
  to `X`, keeping the sentence intact. Several matches means pick the one the
  rule meant, asking only when it is genuinely ambiguous. "No file by that name"
  means delete the reference or repoint it at the current source of truth. Only
  ever point at a file you have confirmed exists; never invent a path.
- **Promotion** → `placement-promotion` carrying `mechanism`
  (`{ "type": "skill", "name": "<name>" }`) and `provenance` — a non-empty list
  of `{ "claim": "<what the page documents>", "url": "<the page>" }` entries.
  Both are required, and `plan` rejects a provenance entry missing either
  field. Fetch
  the format live with `WebFetch`, once per primitive per run, from
  `https://code.claude.com/docs/en/hooks.md` (with `hooks-guide.md`),
  `https://code.claude.com/docs/en/skills.md`, or
  `https://code.claude.com/docs/en/sub-agents.md` — never a remembered format,
  and park the candidate instead if a fetch fails. A hook wires its event in
  `.claude/settings.json` with any check script as a second patch in the same
  change; skip it when that file already wires the same event and matcher, and
  keep it to one hook per change or the second goes stale. A skill becomes
  `.claude/skills/<name>/SKILL.md` with the rule text as its first section and a
  description written to the recipe. A subagent becomes
  `.claude/agents/<name>.md` with the rule text as its prompt. Choose the level
  before the primitive: a hook covers exactly its matcher and nothing outside a
  session reaches it, so where the report's ladder already shows a repository or
  remote gate, say plainly that the stronger home exists rather than letting a
  hook read as the same guarantee. **The source rule stays exactly where it is**
  — no kind deletes or deactivates prose. Anything that failed gets parked, not
  retried, and a failed promotion already applied is rolled back first.
- **Park** → `park` with `"patches": []` and nothing written. The promotion note
  goes in `rationale`, naming the mechanism — which hook event fits and what its
  check must verify, the trigger phrase a skill should own, what a subagent
  audits and must return — with the evidence names and the doc URL in
  `limitations`. Split a compound candidate at its conjunction and park each half
  under its own primitive. `apply` refuses a park by design and `clean` never
  deletes a plan artifact: the plan file **is** the park record.

## Running the transaction

1. `plan --from .assay-tmp/draft-plan.json`. Exit 1 means the draft was
   rejected — an anchor that is not in the file, an anchor that matches twice, a
   promotion with no provenance. Fix what the message names and rerun; never
   route around a rejection by editing the file yourself. It prints the plan id
   and every change id, and writes `.assay/plan-<id>.json`.
2. **Preview from the plan, not from your draft.** Read the plan artifact and
   show the user each change: its id, the target path, why that mechanism fits,
   and the exact `old` → `new` text. The plan is what will be applied, so it is
   what they get to see.

   **Flag anything the new text introduces.** If `new` names a path, an
   identifier, a flag or a number that is not in `old`, say so in one line under
   that preview — "this adds `scripts/check.js`, which the old wording did not
   name". A reader who did not write the rule cannot see that from a diff, and it
   is the one way a rewrite changes what the rule MEANS rather than how it reads.
3. **Collect approval per change, in a surface that has one.** With four or fewer
   changes, one `AskUserQuestion` (`multiSelect: true`) whose options are the
   change ids with a one-line summary each. With more, a numbered list followed by
   an explicit instruction — "reply with the numbers you want applied, or `all`" —
   and wait for the answer. Never treat silence, "looks good" on the preview, or
   an earlier yes to the menu as approval for a specific patch.

   Then `apply --change <id> --change <id>` with exactly the ids approved.
   There is no apply-everything default, and a change the user did not
   name is not applied even though the plan carries it. A stale file exits 1
   naming both fingerprints and writes nothing; re-plan rather than forcing it. A
   write whose result does not parse is restored and exits 1.
4. `validate --change <id>` per applied change. It re-parses what was written,
   re-runs the static analysis and records the corpus state that results, and for a promotion checks
   that the host actually discovers the new mechanism. It reports `configured`
   and nothing above: a file on disk is not evidence that anything ran. assay
   never runs the repository's own tests, lint, or a fresh session — those are
   external evidence, recorded with `--external "repo tests: pass"` when the user
   reports one. A failure exits 1 and prints the rollback path; nothing is undone
   automatically at this stage.
5. **Say what is now true.** The rule is still active — a promotion added the
   mechanism beside the prose, a rewrite rephrased it in place. Tell the user the
   duty may now be stated twice on purpose, and that `git diff` shows every
   change.

Every command above is `node "${CLAUDE_PLUGIN_ROOT}/scripts/assay.js" <command>`.
Every applied change stays reversible for as long as the journal exists, through
`rollback --change <id>`, including after an apply interrupted mid-write. Offer
it whenever a validation fails or the user dislikes the result.

`remeasure` — "what did the fixes actually do" — is step 7 of the audit skill and
runs whenever anything was applied. It is described there.
