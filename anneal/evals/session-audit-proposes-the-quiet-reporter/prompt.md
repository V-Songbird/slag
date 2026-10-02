---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
expected_outcome: Runs the evidence script on session.jsonl, finds the large output of a passing npm test, proposes npm run test:quiet, the quieter form package.json already has, for the Commands section of AGENTS.md, and leaves AGENTS.md and package.json as they were.
---

/anneal:session-review session.jsonl
