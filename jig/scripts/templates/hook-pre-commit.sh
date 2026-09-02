#!/bin/sh
# jig:owned — generated from jig's pre-commit shim template. Git does not read
# this file until it is told to: ask /jig:jig to wire the commit lane and it
# proposes that as an approved, reversible change, or set core.hooksPath at
# .jig/hooks yourself. jig writes no file inside .git/.
#
# If node is not on PATH in the hook's environment (fnm/nvm/volta), the check
# is skipped rather than blocking the commit — the CI workflow is the floor
# that runs regardless. That trade is deliberate and disclosed in
# .jig/activation.md.
#
# Every outcome leaves a row in .jig/lane.log, skips included: a lane that goes
# quiet and a lane that never ran are the same silence otherwise. The log is
# machine-local and git-ignored, and failing to write it never fails a commit.
lane_log() {
  printf '%s pre-commit %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>.jig/lane.log 2>/dev/null || true
}
if ! command -v node >/dev/null 2>&1; then
  echo "jig: node is not on PATH here, so the commit-time checks were skipped. CI still runs them." >&2
  lane_log "skipped node-not-on-path"
  exit 0
fi
lane_log "ran"
# `--staged`, because a commit carries the index and not the working tree. The
# pathless walk this used to run reads the files on disk, which at commit time
# is a different project: a violation staged and then edited back out lands in
# HEAD unchecked, and a violation left in the file but never staged blocks a
# commit that does not contain it. CI and a manual run keep the walk.
#
# `--ledger commit` because a catch at commit time used to leave no record
# anywhere: review read the session lane alone, and a class that had only ever
# fired here looked like one that had never fired. The rows carry the class, the
# file and the line and never the source, and a row that will not append is a
# disclosed miss rather than a failed commit.
node .jig/checks/run.mjs --staged --ledger commit || exit 1
# The opt-in half. `.jig/verify.json` names the linter, type checker and test
# runner the owner ticked; only an entry that names the `commit` lane runs here,
# and nothing names it unless the owner asked for it when the plan was made — a
# full type-check on every commit is a cost they choose. No file, no second node
# start: a commit that opted into nothing pays nothing.
if [ -f .jig/verify.json ]; then
  node .jig/checks/run.mjs --verify --lane commit || exit 1
fi
