<!-- jig:begin — jig owns what sits between these markers -->

jig guards this repository. Before calling any work done, run:

    node .jig/checks/run.mjs

It exits non-zero on: assay-codex-surface-host-names, assay-profile-evidence-tier, blanket-lint-suppression, debug-artifact-left-behind, focused-test, hardcoded-secret, skipped-test, softened-assertion.
Never delete or focus a test to make a suite pass — fix it, or skip it
visibly and say so. The coverage matrix is at .jig/plan.md.

<!-- jig:end -->
