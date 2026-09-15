# Conversation and reporting

Presentation rules shared by `/jig:jig`, `/jig:inventory` and `/jig:review`.
They decide what is said first, what a label means and which stage the owner is
in — nothing else. Selection, admission, modes, consent, execution and storage
are exactly what the calling skill states.

Use the owner's own language for explanations and visible labels. Command
names, guard and change ids, paths and the approval token stay exact.

## Answer the request

`/jig:jig` takes a request in plain words and routes it. What jig checks, why a
file is there or whether anything runs is the inventory skill's; what jig
caught, a mistaken alert, drift or a guard's mode is the review skill's. A
sibling skill is a file under `${CLAUDE_PLUGIN_ROOT}/skills/`: read it and
follow it here, in this conversation. The owner never invokes a second skill and
never repeats an answer. `/jig:inventory` and `/jig:review` keep working as
direct entries.

Route by the action asked for, never by a word that appears in a question.
Asking what "turn off" means turns nothing off. A status, help or inventory
request authorizes reading and nothing else: no scan record, no migration, no
repair, no verification run and no mode change as a side effect. When a request
mixes a report with a change, answer the report and clarify the change before
anything is touched. A change the owner asks for goes through its own workflow
and its own consent step; routing adds no authorization of its own.

## Summary first

For an ordinary inventory or activity report, read the whole result before
composing a short answer. Lead with any broken configuration or a silenced
session lane, then answer three things:

1. **What jig checks, or what it caught.** Check titles and plain purposes. A
   check that runs only at commit time or in CI is still an installed check;
   never derive the inventory from the session guards alone. For activity, keep
   `fired` against `evaluated`, `denied` apart from `wouldDeny`, `evaluatedOn`
   beside a command guard's count, and `otherLanes` as its own line.
2. **Where it runs.** Session, commit and CI, each on its own, and each as one
   of three things: configured, witnessed running, or unverified. `armed` alone
   proves no enforcement, and a workflow that invokes the driver proves no
   hosted run.
3. **What needs attention.** Name the ids or paths and the one useful next
   step. When the evidence shows nothing, say so and say what the evidence
   covers — missing evidence is not a clean bill of health.

Short where the evidence allows it, and never a length cap that drops a
problem. These stay in every summary: a broken or unprovable check, a guard
running below its configured mode, `.jig/off`, a lane that is dead or unwired,
drift, a verify entry never seen green, a pending wave-off, a discarded check,
and every `why`, `problem` or `fix` the calling skill says to print verbatim.
An empty ledger says nothing about the history before it.

The calling skill's sections say what each field means and how to show it when
it is asked for; they are not an order to print every healthy row into an
ordinary answer. Say once what more there is — "ask for the guards, the checks,
the files, the lanes, or the full report" — and never write a report file to
shorten the conversation.

`full`, or a request for everything, gets the complete report. A named section,
guard, file or count gets exactly that, with the limitations that belong to it.
Nobody asks twice for detail they already asked for. A report-only request ends
with the report: no action menu. Suggest at most one next step when the
findings earn it, and a suggestion runs nothing.

## Plain labels, exact meaning

| Engine term | What to call it |
| --- | --- |
| guard | a check on what an AI session is about to do |
| check | a detector for one mistake |
| check driver, `run.mjs` | the check runner jig commits to the repository |
| `armed` | set to block — proof of enforcement only where the lane is live |
| `observe` | records a match and lets the call through |
| lane | when a check runs: while a session works, when you commit, on push |
| fixture pair, proof | caught its planted mistake and spared the look-alike |
| near miss | a look-alike that is not the mistake |
| admission | the test every check passes before it counts |
| `DET` / `PROB` / `GAP` | caught / caught some of the time / not caught |
| batch and item tiers | approved together / approved one at a time |
| provenance | whether the owner picked it, took history's ranking, or jig assumed it |
| `assumed` | chosen by jig from history or the catalogue, not answered by the owner |
| bundle | a set of checks jig recommends, picked by its name |
| drift | a file changed after jig wrote it |
| journal, pre-image | jig's copy of every file as it was, which undo puts back |
| ledger | jig's record of what each guard saw |
| `core.hooksPath`, wiring the commit lane | pointing git at jig's commit hook |
| `include-line`, weave | one marked line added to a hook the owner already has |
| edition, class | the checks for one language, and one mistake among them |
| `lastGreen: null` | nothing here has been seen to run that command green |

For Spanish, prefer "comprobación", "guarda", "registra sin bloquear", "archivo
modificado" and "resultado sin confirmar". Give the technical id beside the plain
word wherever the owner might act on it, and never call configured blocking
"protected" while enforcement is unverified.

Engine prose a calling skill says to give the owner — a disclosure, a `why`, a
refusal, a probe's notes — keeps every clause. "Verbatim" means nothing is
dropped, softened or merged: when the owner writes in another language, give it
in theirs, with every id, path, command, count and tool name exactly as the
engine wrote it. A command is never translated, and the engine's own English is
quoted whenever the owner asks for it.

## The plain register

Guided setup, and any owner who says they are new to this, gets the plain
register for the rest of the conversation. It changes the words, never the facts
and never the approvals:

- The plain word from the table above, never an engine term on its own. An id or
  a path appears where the owner acts on it — an approval, a file they asked
  about — and nowhere else.
- One idea per sentence. Say what happens to their project, not how jig is
  built.
- A mistake is shown, not only named: the `example` its bundle row carries, or a
  short line from the check's own violation sample, with what catches it and
  when.
- A choice leads with the recommended option and one sentence on why. The owner
  never has to know a flag.
- A limit is still said, in one plain sentence — "this one is checked on push,
  not while the AI edits". A limit is never dropped for being technical.

## Setup in three visible stages

Name the stage as it starts. The order of work in the setup skill does not
change:

- **Understand your needs** — the scan, the history, the preferences still
  open, the toolchain proposal. Facts already read and answers already given are
  reused, never asked again.
- **Review the changes** — author and prove the selected checks, then the plan's
  `## In short` summary, the coverage matrix and the concrete plan. Group the
  changes by their `group`; each keeps its title, id, path, consequence, command
  and config bytes.
- **Apply and check** — apply only what was approved, in dependency order;
  connect the commit hook when the owner asked for that; demonstrate the
  detectors; report the runtime evidence; say how to undo it.

Label the mistake and tool selections **Preferences for the proposal**, and say
once that ticking a tool asks jig to put it on the plan. Label the approval
questions and the id/path list **Approve these changes**. An explicit approval is
reused for the same id, path and consequence; a preference is never read as
consent. Approval details never move behind optional detail, and no blanket yes
replaces the named ones. `--quick` is asked for by flag, never assumed; it labels
every assumption and takes the same approvals.

The closing summary names what was applied, what was declined, what was proven,
what remains unverified, and how to undo it — with the probe output, the
discards and the outstanding proposals the setup skill requires, and without
re-reading the plan.
