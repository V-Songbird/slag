# The documentation contract

## What this contract is

One versioned source of the documentation policy: where maintained documentation lives, what each record carries, how long it lives and how a repository keeps its private records out of its public surface. A project adopts it by rule and pointer, never by copying it: the project-local rule names the profile and repeats the five invariants, a pointer in each map file reaches the rule, and this file holds everything else. A newer plugin brings a newer contract to every project that adopted it.

Every mode of repo-docs reads the Invariants below first and treats the project's own applicable instructions as its documentation policy. Where the two differ, the project's instructions win inside that project; the difference is a finding to report, not a reason to edit either.

## Invariants

- Maintained documentation lives under `docs/`: task notes (`type: task_summary`) in `docs/tasks/`, decision records (`type: adr`) in `docs/decisions/`, product knowledge in `docs/knowledge/`, API documentation in `docs/apis/`, private research under `docs/knowledge/private/` and `docs/apis/private/`, and non-document private material under `.private/`.
- Every maintained Markdown record carries YAML frontmatter with `type`, `summary` and `related_files` (`[]` if none), and a task note `status: active | blocked | completed`; README, AGENTS.md, CLAUDE.md and SKILL.md are exempt.
- One living document per topic, with a stable kebab-case name and no date, id or version in it except `<id>-<slug>` for a task note, updated in the same change as the code or contract it describes.
- A task note only for work expected to outlive the session (several sessions, delegation or a likely compaction); on completion its durable findings are folded into the topic documents its work changed and the note is deleted.
- Public text never depends on or links to a private record, an ignore rule never untracks a file, and no rule ever ignores all of `docs/`, `docs/knowledge/` or `docs/apis/`.

## Document kinds

| Type | Folder | Purpose | Reader | Lifecycle | Size cap |
| --- | --- | --- | --- | --- | --- |
| `task_summary` | `docs/tasks/` | The snapshot of one task that outlives a session: objective, completion criteria, constraints, checklist and status, changed files, checks, blockers, approval source and next action | Agents; the owner reads their summaries | Created when the work starts, updated at each material change, folded into its topic documents and deleted on completion | 20,000 characters |
| `adr` | `docs/decisions/` | One consequential decision, its reasons and its `Rejected Alternatives` | People and agents | Written when the decision is taken; a later decision marks it superseded instead of rewriting it | 50,000 characters when named for history |
| `knowledge` | `docs/knowledge/` | Public product knowledge: current behavior, contracts, setup and limitations | People first, agents too; under `docs/knowledge/private/`, agents | Living; updated in the same change as what it describes | 50,000 characters under `docs/knowledge/private/` or when named for history |
| `knowledge` or `api_spec` | `docs/apis/` | Public API documentation, and under `docs/apis/private/` the research behind an integration | People, agents too; under `docs/apis/private/`, agents | Living; updated with the API it describes | 50,000 characters under `docs/apis/private/` or when named for history |
| none | `.private/` | Non-document working material: raw outputs, transcripts, bulky artifacts a record links | Agents and scripts | Local only, never tracked | None |

Write each record for its reader. A record read mainly by people follows [the writing reference](writing.md); a record read by agents, decision records included, favors exactness and brevity over explanation.

The caps are the ones `docs-check.js` enforces as `task-note-large` and `history-doc-large`. A `README.md`, `AGENTS.md`, `CLAUDE.md` or `SKILL.md` is a map or an interface, not a record, and carries no frontmatter.

## Lifecycle

**When to record.** Start or resume a task note when the work is expected to outlive the session: several sessions, delegation to other agents or a likely compaction. Record substantive research, consequential decisions, implementation progress and meaningful failures in the topic document or decision record they belong to, in the same change as the code or contract they describe. A status question, an acknowledgment or an answer that changes nothing creates no record.

**Find and resume.** Before starting substantive work, search the existing records by their `summary:` line first, then by related paths and distinctive terms, including the private directories that ignore rules hide from a default search. Read the matching record and the evidence the current question needs; for a long document, read the headings first. Say when a conclusion comes from a record rather than from a check performed now.

**Keep records useful.** Keep the task snapshot compact: objective, completion criteria, constraints, checklist and status, changed files, checks, blockers, open assumptions, approval source and next action. Keep the dated account of consequential steps, with the searches, experiments, findings, failed attempts and changes of direction, in the private topic document the work belongs to and link it from the task note, so each history has one home. Preserve unique evidence before merging, shortening or removing a record, especially one Git does not track: ignored private files have no Git backup, committing a note does not back up its untracked attachments, and no backup gap justifies publishing private material.

**The boundary.** A new file inherits its destination's visibility: a knowledge or API document outside the private subdirectories is public product documentation, so check the content before choosing where it goes. The product and its public checks never depend on private material: required definitions live in public source modules, regression fixtures are self-contained, and separating private material never weakens a check. The same boundary covers code comments, screenshots, commit messages, PR descriptions, CI logs, downloadable artifacts and deployed pages: each states the problem, the final behavior and the verification, never the private exploration or instructions behind them.

**Decision records** keep their reasons and the alternatives considered under a `Rejected Alternatives` heading. A changed decision gets a new record or a `superseded` note; the old one stays as history.

**Trim** through the maintenance proposals of [the workflow guide](../../../docs/knowledge/workflows.md#maintenance-proposals): `drift` for a document whose related files changed after it, `fold-completed` for a completed task note, `condense` for an oversized record, `merge-per-entry` for per-task documents that belong in one topic, `fold-store` for an orphaned knowledge store. Each proposal waits for the owner's approval; deleting, merging and condensing records are never ordinary fixes.

## Profiles

| Profile | What it means | How `docs-check.js` reads it |
| --- | --- | --- |
| `solo-public` | The four private documentation directories and `.private/` are ignored and untracked; the repository is public or may become so. The shipped template [templates/gitignore](../../../templates/gitignore) supplies the rules | `ignored` |
| `private-repo` | Every documentation directory is versioned, so cloud and isolated sessions can read the private records. `.private/` must stay ignored: adopt writes no ignore rule for this profile, so its probe reports a trackable `.private/` for the owner to fix. Versioning private records is the owner's explicit opt-in, and it approves no commit or push | `versioned` |
| `team` | Versioned like `private-repo`, with the same `.private/` probe. Decisions that bind more than one person go in `docs/decisions/`; task notes are named for the task, never for a person; the rule file is the team's and changes through ordinary review | `versioned` |

`docs-check.js` tells `ignored` from `versioned` by the ignore rules alone and cannot tell `private-repo` from `team`: the project-local rule names the profile.

## Adopt

`adopt` writes the contract into a project. It shows every file before writing it and writes only after approval. When it proposes the profile, it tells the owner who reads each record kind, from the Reader column of [Document kinds](#document-kinds).

1. Confirm the project root, and that it is a Git working tree: without Git, adopt writes no ignore rules and says so. Capture `git status --short --ignored`. Read the map files present (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`), the existing `.gitignore` and `.claude/rules/`.
2. Choose the profile with the owner. A path is covered only when `git -c core.excludesFile= check-ignore --no-index -v <path>` names a `.gitignore` in the working tree as its source and the pattern does not start with `!`: `core.excludesFile` and `.git/info/exclude` stay on this machine, so a clone does not carry them. A `.git/info/exclude` rule on a parent directory, such as `docs/`, masks a committed rule beneath it, and the path reads as not covered. Propose `solo-public` when the private directories are already covered (probe `docs/tasks/probe.md` and its siblings) or the repository is public; otherwise ask. Never guess silently.
3. Show the exact files to write and wait for approval, even in a cleanup.
4. On approval, write in this order:
   - The project-local rule `.claude/rules/documentation.md`, from `<plugin root>/templates/docs-rule.md` with `<profile>` replaced by the chosen profile name. If the file exists, show a diff and replace it only with approval.
   - One pointer line in each map file present, in its `Start here` section when it has one and otherwise as the first line after the title, reading `Documentation rules: .claude/rules/documentation.md (anneal repo-docs contract, profile <profile>)`, so Codex and Antigravity, which do not load `.claude/rules/`, still reach it. Skip a map file that already imports another map file receiving the pointer, such as a `CLAUDE.md` holding only `@AGENTS.md`, so the line is loaded once. When no map file exists, propose creating `AGENTS.md` on [the map file skeleton](../../repo-layout/references/map-file.md) as a separate approval.
   - For `solo-public` only, `.gitignore`: copy `<plugin root>/templates/gitignore` when none exists; otherwise append only the private-directory rules whose probes are not covered, as step 2 defines it, probing each private directory at the root (`docs/tasks/probe.md`) and in a nested package root (`pkg/docs/tasks/probe.md`). A root probe not covered gets the root rule (`docs/tasks/`). A nested probe not covered gets the template's nested rule (`**/docs/tasks/`), with two exceptions, because an appended rule that matches a negated path's directory overrides the negation: when the file negates a path under the root directory, such as `!docs/tasks/README.md`, append `*/**/docs/tasks/` instead, which spares the root; when it negates a path under a nested one, such as `!packages/a/docs/tasks/README.md`, append no nested rule for that directory and report the gap for the owner to resolve, since every blanket form reaches that package too. Preserve the file's order, negations and comments.
   - Last, as its own approval, offer the record index: `docs/index.md`, written from the output of `node "<plugin root>/scripts/docs-check.js" --root "<project root>" --index` with the host's file-writing tool rather than a shell redirect, and one `Start here` line in the map file that receives the documentation pointer, reading `Record index: docs/index.md (one summary line per maintained record; search it before guessing a docs path)`. It comes after the `.gitignore` step because `--index` leaves out private records only once the ignore rules cover them; under `solo-public` the index then holds public records only, so it is a public product file the owner commits. The line sits beside the existing trigger pointers and replaces none of them; when `Start here` already holds the five pointers [the map file contract](../../repo-layout/references/map-file.md) allows, ask the owner which one the index line replaces.
5. Never run `git rm`, `git rm --cached` or anything else that untracks a file: a private file already tracked is a finding the owner resolves. Never add a rule for `docs/`, `docs/knowledge/` or `docs/apis/`. Never change global Git configuration or another project.
6. Run `node "<plugin root>/scripts/docs-check.js" --root "<project root>"` before and after. Run `git -c core.excludesFile= check-ignore --no-index -v` on `.private/probe`, `docs/tasks/probe.md`, `pkg/docs/tasks/probe.md` and `docs/knowledge/private/probe.md`: the first covered, as step 2 defines it, under every profile, the other three under `solo-public`. Run a plain `git check-ignore --no-index -v`, which reads every source, on `docs/knowledge/probe.md` and `docs/README.md`: neither is ignored. A trackable `.private/` under `private-repo` or `team` is a finding the owner resolves, not a rule adopt writes. Read the diff of every instruction file written and revert a line no approval holds. Report what was written, what each check printed and what the owner still owes.
7. Commit nothing. The map pointer and the rule are standing-instruction changes the owner commits.

## What the scripts check

- `docs-check.js` reports where a project's documentation breaks this contract, without changing anything; its findings and the profile it reads are in [the documentation check](../../../docs/knowledge/workflows.md#the-documentation-check). With `--index` it prints [the record index](../../../docs/knowledge/workflows.md#the-record-index) instead.
- `docs-maintenance.js` proposes the trims the Lifecycle section names and changes nothing; its proposals are in [maintenance proposals](../../../docs/knowledge/workflows.md#maintenance-proposals).
