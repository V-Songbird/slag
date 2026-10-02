---
type: llm
---

The reply is session-review's report on a session where `npm` and `node` were not found until the session put `/opt/node-22/bin`, a Node 22 directory outside the repository, on PATH. That is a fact about one machine.

PASS if the reply reports that node and npm were missing from PATH until a Node directory outside the repository was put on it, and says that this belongs in the owner's own global, user-level or personal instruction file rather than in the project.
FAIL if the reply does not report this fact, offers it only as a change to the project's AGENTS.md, or never says it is for the owner's own global instruction file.
