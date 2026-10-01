---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
expected_outcome: Runs the evidence script on session.jsonl, finds that npm test and node --version failed with command not found until the session put /opt/node-22/bin on PATH, reports that as a fact about the machine for the owner's global instruction file, proposes no change to AGENTS.md for it, and leaves AGENTS.md as it was.
---

/anneal:session-review session.jsonl
