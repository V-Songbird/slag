# What Jig is and how it behaves

Jig came from the Slag marketplace as a harness installer. It connects an
owner's recurring mistakes to executable checks, verifies those checks against
examples, installs their approved dependencies and records how to undo them.
The Codex port preserves that workflow and the existing engine and catalogue
model. It does not add a task-wide scope enforcement feature.

## The installation sequence

1. `scan` reads manifests, runtimes, existing hooks, instruction files and
   governance documents. `forensics.js` ranks possible mistake classes using Git
   history and distinguishes real evidence from catalogue defaults. Their
   profile and planning records are derived working state under `.jig/`.
2. The interview asks for intent that the repository cannot establish: who the
   harness protects, the project's phase, mistakes, tools and blocking versus
   observing. Empty projects are supported by an explicit edition and approved
   starter files. Quick mode takes the engine's recorded selection and marks
   its provenance as assumed; it does not authorize installation.
3. Each authored check supplies source, detectors, inline violation and near-miss
   fixtures, and a reason/alternative/override. Every named pattern must catch
   the violation on its own. Near misses and cross-check samples reject overly
   broad patterns. Expected cross-sample hits are declared and disclosed.
4. `plan` admits the checks, reports discarded work and gaps, and produces a
   concrete review page. Consequential changes are item-tier approvals; reporting
   artifacts may use batch consent. An item approval binds the change id and
   exact path. A batch apply refuses while any item-tier change remains unapplied.
5. `apply` writes only approved plan changes through a journal. It records
   pre-images, installed artifacts, proof and consent provenance. Existing
   owner-edited files are refused rather than silently replaced. Tool commands,
   candidate manifest/lockfile changes and reconciliation steps are surfaced.
6. `selftest --live` invokes Jig's own runner with fixtures and witnesses ledger
   growth. Toolchain probes run only the named tools and distinguish a clean
   baseline, a planted violation, an unverified result and an unavailable tool.
   The Codex port separately reports host registration and tool-call evidence.

The implementation is in [scripts/jig.js](../scripts/jig.js), with the committed
check driver at [scripts/templates/run.mjs](../scripts/templates/run.mjs) and
session evaluation in [hooks/jig-lib.js](../hooks/jig-lib.js).

## What each check can see

| Detector or lane | Evidence it reads | Boundary |
| --- | --- | --- |
| Source patterns | Text at configured paths, using declared comment/string blanking | A regex does not establish program semantics |
| Co-change | Staged paths and an expected companion path set | Skipped without a suitable staged change set, including ordinary CI checkouts |
| Removal | Before/after counts in staged files or supported pre-tool patches | A tree-only run has no earlier text and reports a skip |
| Extracted names | Names captured from one set of files, looked up literally in another | Comments can satisfy the literal lookup; no session lever exists |
| Command guard | Supported Codex shell command text | The canonical `Bash` event does not identify the actual shell dialect |
| Patch guard | Reconstructed before/after for supported `apply_patch` operations | Unreadable, external or malformed files and mutations through other tools are gaps; another file's gap does not erase a known denial |
| End-of-turn verification | Observed verification evidence | Jig deliberately keeps its Stop hook advisory and does not request blocking or continuation |

Session guard proofs bind the module and fixtures. A stale proof, edited module,
recorded false positive or applicable zone can demote a guard to observing;
reports expose that state instead of treating it as blocking. Observe mode is
an owner choice, not a probation that automatically graduates to enforcement.

## Ongoing ownership

`inventory` reads what is installed and why. `review` reads what guards caught,
which tool names they evaluated, and whether commit and CI wiring still exists.
A repository-wide ledger is not scoped to one machine or one current session.
A missing local green record does not prove hosted CI failed: a runner writes
into its own disposable checkout.

A false-alarm report appends evidence, then proposes a separate change before it
quiets enforcement. Disarm and retire also plan before applying. Arming a named
guard rechecks its proof. Revert restores journaled pre-images and refuses drift;
it prints package reconciliation commands without running them automatically.

## Control boundaries preserved by the port

Named approval is an operator workflow backed by exact plan tokens. The engine
does not authenticate a human click or sandbox an agent that chooses to bypass
its command interface. `AGENTS.md` pointers help Codex load governance documents;
they cannot make arbitrary prose mechanically enforceable.

The four standing interview offers—hook bypass, force push to the default
branch, downloads piped into a shell, and disabling the harness—become authored,
fixture-proven checks only when selected and approved. Their patterns cover
specific tested forms, not every equivalent command. Changes outside a trusted,
supported tool hook can evade the session lane; the committed checks remain an
independent floor for the mistake classes they can inspect.

The original Jig contract keeps end-of-turn reporting advisory. Codex supports
Stop control responses, but this port does not introduce them. Host trust, native
payload adaptation and the remaining platform verification limits are recorded
in [Codex compatibility](CODEX-COMPATIBILITY.md). This distinction is necessary
to preserve Jig's evidence standard: detector proof is never presented as proof
of an untested host capability.
