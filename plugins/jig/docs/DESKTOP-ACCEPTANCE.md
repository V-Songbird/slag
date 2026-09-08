# Windows desktop acceptance

Measured on 2026-09-06 with Jig 2.15.1-codex.1 and the Windows Codex desktop
runtime 0.153.4. This exercise used a new desktop task and a disposable Git
repository. It did not configure a real project.

## Installation and trust

Jig was added to the existing personal marketplace with the plugin scaffold
helper and installed through the desktop-bundled Codex plugin command. The
existing Foreman entry was preserved. The supported app-server APIs confirmed
three enabled skills (jig:jig, jig:review, jig:inventory) and four enabled hooks.

The exact hook definitions were reviewed, their current hashes persisted with
version-checked config/batchWrite, and hooks/list read again to confirm trust.
Only Jig's four trust entries changed; unrelated user configuration was compared
and preserved. No hook trust bypass was used for this installation. See the
sanitized [installation evidence](validation/desktop-installation.json).

Installation and trust used the supported runtime APIs. No desktop window or
plugin-management UI was operated. The separate task below exercised the actual
desktop execution path after installation.

## Native desktop workflow

The user explicitly requested the separate **Jig desktop acceptance** task. Its
fresh skill catalog contained all three Jig skills, and it loaded the installed
jig:jig and jig:review instructions. The repository contained only a small owner
fixture, with two deliberately narrow checks: a forbidden shell marker and a
forbidden introduced JavaScript call.

Owner choices were supplied as predeclared test decisions. The task stopped at
the plan boundary. The parent inspected the exact artifacts and approved five
named ID/path pairs: both check modules, the driver, the observing guard config,
and the permission proposal. Two optional artifacts were declined. The parent
then explicitly authorized arming the two guards and reversing the installation.
This tested the approval workflow; it was not a fresh human interview or a test
of human identity authentication.

| Actual desktop operation | Observed result |
| --- | --- |
| Forbidden shell command, observe mode | Allowed; native ledger records would-deny |
| Forbidden Add File patch, observe mode | Allowed; native ledger records would-deny |
| Allowed shell and Add File patch near misses, observe mode | Allowed |
| Forbidden shell command, armed mode | PreToolUse denied; target file absent |
| Forbidden Add File patch, armed mode | PreToolUse denied; target file absent |
| Allowed shell and Add File patch near misses, armed mode | Allowed; expected file contents present |
| Review | One observed catch and one denied catch per guard; no drift or false-positive marks |
| Reversal | All five approved artifacts and both arm actions reversed; audit records retained |

The calls went through the desktop task's actual exec_command and apply_patch
tools. Its ledger recorded host=codex, the task's session id, and canonical
Bash/apply_patch tool names. No manual hook-runner call supplied this native
acceptance evidence. The allowed fixture output files were explicitly cleaned
up after Jig reversal. All original project files matched their baseline bytes;
the complete 18-file Git snapshot had no additions, removals or changed bytes.
Every original plan destination was absent, and all 14 journal entries were
reverted with no open transactions. The sanitized
[desktop task evidence](validation/windows-desktop-task.json) preserves the tool
results, ledger summary, approved pairs and restoration checks.

## Findings corrected in this branch

The test found two product defects. The generated activation guidance claimed CI
coverage even with --no-ci; the optional activation document and hook shim were
declined in this test. All three activation templates, their post-apply guidance,
and the missing-Node hook message now describe configured coverage accurately.
Session-only checks are explicitly excluded from commit and CI coverage.

The review also dropped apply_patch from a guard's evaluatedOn list despite
native ledger evidence. The reporting code now includes native patch evaluations
and continues to exclude judgments, unusable checks and other guards' activity.
The desktop record preserves the original reporting defect; the regression
suite verifies the correction. It does not relabel the old run as a test of
subsequently changed bytes. The saved native result includes SHA-256 hashes of
the measured installed manifest, hook/runtime files, template index and skills.

The corrected package was reinstalled as 2.15.1-codex.1+codex.20260906111528.
The [update check](validation/desktop-update.json) confirms three loaded skills
and four trusted hooks; no new trust write was needed because their definitions
were unchanged. The installed-plugin probe below then passed against the updated
source. Start a new Codex task to pick up the refreshed skill paths.

## Complementary probes and limits

The [installed-plugin host probe](validation/windows-installed-trust-0.153.4.json)
passed eight assertions using the current Codex home and persisted hook trust,
without a trust bypass. It selected the GPT-5.5 standard Responses protocol and
used a local fixed-response server, with no model inference. That transport does
not emulate the configured GPT-6 code-mode protocol. The separate desktop task
above supplies evidence from the actual desktop tool path.

The offline owner-workflow probe passed on
[Windows](validation/owner-workflow-windows.json) and
[Linux](validation/owner-workflow-linux.json). It additionally tests unnamed and
mismatched approval refusals, disarm and false-positive decisions remaining
pending until named approval, re-arming, and exact reversal. Those direct runner
calls are synthetic and do not establish native hook delivery.

This fixture did not install tools, activate Git hooks or configure CI. These
results do not certify every detector or tool dialect, update/delete/move patches in the desktop task,
a fresh human interview,
OS sandbox isolation, or desktop UI click-through behavior. macOS execution,
native Linux desktop acceptance and the remote CI matrix remain unmeasured.
See [Codex compatibility](CODEX-COMPATIBILITY.md) for the broader regression
results and platform limits.
