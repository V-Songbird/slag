---
type: llm
---

The reply is session-repeats' report on three sessions that each ran `npm test` and then `git status --short --ignored`. The map file, AGENTS.md, has a Commands table that names `npm test` and nothing else, and package.json has no script for the listing.

PASS if the reply proposes, for the owner to approve, a line in the Commands section of AGENTS.md that names `git status --short --ignored`, or names a short script that runs it after `npm test`, and states the exact command or script text.
FAIL if the reply proposes no such line, proposes one only for `npm test`, puts it in another section or another file, or says it applied the change.
