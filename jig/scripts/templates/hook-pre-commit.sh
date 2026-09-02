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
node .jig/checks/run.mjs || exit 1
