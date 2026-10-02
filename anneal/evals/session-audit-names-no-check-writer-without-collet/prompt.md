---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
expected_outcome: Runs the evidence script on session.jsonl, finds the suite failing twice on a relative import of ./round without its .js extension, first from src/cart.js and then from src/orders.js, finds no .collet/ directory at the repository root, reports the mistake as one a check could catch in the project's own linter or tests without naming check-writer or collet, runs no collet file, and leaves AGENTS.md as it was.
---

/anneal:session-review session.jsonl
