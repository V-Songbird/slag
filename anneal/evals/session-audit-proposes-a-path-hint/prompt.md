---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
expected_outcome: Runs the evidence script on session.jsonl, finds two reads of defaults.js at paths that do not exist before a search found packages/core/config/defaults.js, proposes a path hint for packages/core/config/ in the Where things live section of AGENTS.md, proposes no move or rename of the file, and leaves AGENTS.md as it was.
---

/anneal:session-review session.jsonl
