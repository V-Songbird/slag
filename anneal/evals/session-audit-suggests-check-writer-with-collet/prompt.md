---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
expected_outcome: Runs the evidence script on session.jsonl, finds the suite failing twice on a relative import of ./round without its .js extension, first from src/cart.js and then from src/orders.js, finds the .collet/ directory at the repository root, recommends collet's check-writer skill in the report as the way to write a check for that mistake without invoking it, writes no check, runs no collet file, and leaves AGENTS.md as it was.
---

/anneal:session-review session.jsonl
