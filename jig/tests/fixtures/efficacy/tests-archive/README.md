# Archived tests

Fixture: near-miss negative B for `test-file-deletion`. The efficacy run stages
this file for deletion.

The directory name starts with `tests` and is not `tests/`, which is the exact
edge the detector's `**/tests/**` glob has to get right. Deleting a note about
retired tests is not deleting a test.
