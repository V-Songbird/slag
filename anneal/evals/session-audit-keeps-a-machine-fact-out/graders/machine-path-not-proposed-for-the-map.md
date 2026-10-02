---
type: llm
---

The reply is session-review's report on a session where `npm` and `node` were not found until the session put `/opt/node-22/bin`, a Node 22 directory outside the repository, on PATH. That is a fact about one machine, which never goes into the project's map file.

PASS if the reply proposes no text for AGENTS.md or CLAUDE.md that names `/opt/node-22`, a Node install directory, a change to PATH or a version manager. Text worded for the owner's own global instruction file, and not offered for AGENTS.md, does not count.
FAIL if the reply proposes such text for the map file in any form: a proposal sentence, a bullet or table row under a proposal heading, a fenced block, an "as it would be" entry, or a Commands row that puts the directory on PATH, including when it also reports the fact for the global file.
