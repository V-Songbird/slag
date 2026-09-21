---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
expected_outcome: Runs the evidence script on session.jsonl, finds that npm test failed twice before npm run check worked, proposes replacing the command in AGENTS.md, and leaves AGENTS.md as it was because nobody approved the change.
---

/anneal:session-review session.jsonl
