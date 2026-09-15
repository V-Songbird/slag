# Conversation and reporting

Use the user's language for explanations and visible labels. Keep command names,
guard and change ids, paths, engine output that must be quoted, and approval
tokens exact. These are presentation rules for the existing workflows; they do
not change selection, admission, modes, consent, execution, or storage.

## Answer the request

`$jig` can route a request to the sibling inventory or review skill. Read the
target skill from this same plugin and continue in the current conversation;
the owner need not invoke a second skill or repeat their answers. Direct
`$inventory` and `$review` invocations keep working. Resolve the runner from
the loaded SKILL.md as described in [codex-runtime.md](codex-runtime.md).

Route by the requested action, not a word mentioned in a question. Asking what
"turn off" means does not request turning anything off. A status, help, or
inventory request authorizes only reading: no scan records, migration, repair,
verification run, or mode change as a side effect. For an ambiguous report or
change request, answer the read-only part and clarify the specific action.
Follow an explicitly requested mutation through its existing workflow and
consent rules; routing itself supplies no additional authorization.

## Summary first

For an ordinary inventory or activity report, inspect the whole returned result
before composing a short answer. Lead with any broken configuration or disabled
session checks, then answer:

1. **What Jig checks / what it detected.** Use check titles and plain purposes.
   Checks that run only at commit or in CI still count as installed checks; do
   not derive the whole inventory from session guards alone. For activity,
   retain fired/evaluated and denied/wouldDeny distinctions, per-guard shell
   evidence, and separate catches in other lanes.
2. **Where it runs.** Report session, commit, and CI separately. Distinguish
   configured, execution witnessed, and unverified. `armed` alone proves no
   host enforcement; a workflow invoking the driver proves no hosted CI run.
3. **What needs attention.** Name the affected ids or paths and the next useful
   action. If there is none in the available evidence, say that with its scope;
   missing evidence is not a clean bill of health.

Keep each point short when the evidence allows it. Do not impose a length limit
that drops problems. In particular, keep broken or unprovable checks, effective
mode reductions, `.jig/off`, unavailable or unwired lanes, drift, missing or
unknown verification evidence, and pending approvals visible. Include the
engine's exact reason or repair command wherever the workflow requires it.
An empty local ledger does not establish no historical activity. A selected
check discarded during setup remains an explicit coverage gap.

The detailed sections in the calling skill define how to interpret each field
and what to show when detailing that field; they are not a demand to dump every
healthy row into an ordinary summary. Mention the available detail once, in a
sentence such as "You can ask for the checks, files, or full report." Do not
create a report file merely to shorten the conversation.

An explicit request for all/everything/full detail gets the complete report.
An explicit section, named guard, file, or count gets that information directly,
with the limitations relevant to it. Never make someone ask twice for detail
they already requested. Report-only requests end with the answer, without a
mandatory action menu. Suggest at most one next action when the findings warrant
it; a suggestion does not execute it.

## Plain labels, exact meaning

| Engine term | User-facing meaning |
| --- | --- |
| guard | A check on a supported action during the session |
| check | A detector for a particular mistake |
| `armed` | Set to block supported calls, when trusted hooks are active |
| `observe` | Records matches without blocking |
| lane | During the session / at commit / in CI |
| fixture proof | Detected a planted mistake and spared its valid example |
| drift | A file changed after Jig wrote it |
| `assumed` | Suggested from repository history or the catalogue, not answered by you |
| `verify-unknown` | The command's result is unconfirmed |

For Spanish, prefer "comprobación", "registra sin bloquear", "archivo modificado"
and "resultado sin confirmar". Include the technical identifier when it helps
inspect evidence or select an action. Never shorten configured blocking to
"protected" when runtime enforcement is unverified.

## Setup in three visible stages

Use these labels for progress; retain the execution order in the setup skill:

- **Understand your needs:** scan, relevant history, unresolved preferences,
  and the tool proposal. Reuse repository facts and answers already given.
- **Review the changes:** author and prove the selected checks, then show the
  coverage matrix and concrete plan. Group rows by purpose for readability;
  each change keeps its exact id, path, consequence, commands and config bytes.
- **Apply and check:** apply only approved changes in dependency order,
  demonstrate detectors, report runtime evidence, and explain undo.

Label tool and mistake selection as **Preferences for the proposal**. Explain
once that choosing a tool asks Jig to include it in the plan. Label the later
id/path table **Approve these changes**. Reuse explicit authorization for the
same named id, path and consequence; never reinterpret a preference as consent.
Do not hide approval information behind optional detail or replace named
approvals with a blanket yes. `--quick` is explicit, never a silent default, and
still labels assumptions and requires the same approvals.

The closing summary names what was applied, what was not applied, what was
proven, what remains unverified, and how to undo it. Keep required probe output,
discards and outstanding proposals visible without repeating the whole plan.
