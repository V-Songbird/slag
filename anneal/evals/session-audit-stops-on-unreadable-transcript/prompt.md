---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
expected_outcome: Runs the evidence script on session.jsonl, which refuses it because its fourth record is not valid JSON, reports that the transcript could not be read, and proposes no change from reading the file directly. AGENTS.md stays as it was and no file is created.
---

/anneal:session-review session.jsonl
