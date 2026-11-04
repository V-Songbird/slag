---
type: llm
---

The reply is session-repeats' report on three sessions that each ran `npm test` and then `git status --short --ignored`. The map file, AGENTS.md, has a Commands table that already names both commands.

PASS if the reply proposes no new map-file line, script or command for `npm test`, for `git status --short --ignored` or for the two run together. Saying that the map file already names them, and that nothing needs to change, is not a proposal.
FAIL if the reply proposes, suggests or recommends adding or rewording a line for either command, writing a script that runs them, or adding a package.json script for them, in any wording.
