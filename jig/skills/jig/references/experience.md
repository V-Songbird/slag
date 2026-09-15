# Conversation and reporting

Presentation rules shared by `/jig:jig`, `/jig:inventory` and `/jig:review`.
They decide what is said first, what a label means and which stage the owner is
in — nothing else. Selection, admission, modes, consent, execution and storage
are exactly what the calling skill states.

Use the owner's own language for explanations and visible labels. Command
names, guard and change ids, paths, engine output the skill says to quote, and
the approval token stay exact.

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
| guard | a check on what a session is about to do |
| check | a detector for one mistake |
| `armed` | set to block — proof of enforcement only where the lane is live |
| `observe` | records a match and lets the call through |
| lane | during a session, at commit, in CI |
| fixture pair, proof | caught its planted mistake and spared its near miss |
| drift | a file changed after jig wrote it |
| `assumed` | chosen from history or the catalogue, not answered by the owner |
| `lastGreen: null` | nothing here has been seen to run that command green |

Give the technical id beside the plain word wherever the owner might act on it,
and never call configured blocking "protected" while enforcement is unverified.

## Setup in three visible stages

Name the stage as it starts. The order of work in the setup skill does not
change:

- **Understand your needs** — the scan, the history, the preferences still
  open, the toolchain proposal. Facts already read and answers already given are
  reused, never asked again.
- **Review the changes** — author and prove the selected checks, then the
  coverage matrix and the concrete plan. Group rows by purpose for reading; each
  change keeps its id, path, consequence, command and config bytes.
- **Apply and check** — apply only what was approved, in dependency order;
  demonstrate the detectors; report the runtime evidence; say how to undo it.

Label the mistake and tool selections **Preferences for the proposal**, and say
once that ticking a tool asks jig to put it on the plan. Label the id/path table
**Approve these changes**. An explicit approval is reused for the same id, path
and consequence; a preference is never read as consent. Approval details never
move behind optional detail, and no blanket yes replaces the named ones.
`--quick` is asked for by flag, never assumed; it labels every assumption and
takes the same approvals.

The closing summary names what was applied, what was declined, what was proven,
what remains unverified, and how to undo it — with the probe output, the
discards and the outstanding proposals the setup skill requires, and without
re-reading the plan.
