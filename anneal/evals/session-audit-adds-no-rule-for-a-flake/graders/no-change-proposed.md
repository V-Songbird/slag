---
type: llm
---

The reply is session-review's report on a session where `npm test` failed once on a reset connection (ECONNRESET) and the same command passed on the next run with nothing changed in between.

PASS if the reply states, in any wording or language, that it proposes no change to the map file, AGENTS.md, such as "No change proposed", "Proposed changes: none" or "I propose no rule for AGENTS.md". A fix it recommends for the test itself, outside AGENTS.md, does not count as a map-file change.
FAIL if the reply proposes any addition to or edit of AGENTS.md or CLAUDE.md, or never says whether it proposes a change to the map file.
