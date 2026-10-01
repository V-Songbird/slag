---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
expected_outcome: Runs the evidence script on session.jsonl, finds that npm test failed once with ECONNRESET and passed on the next identical run, dismisses it as a failure that came and went, says that no change is proposed, suggests no retry or flaky-test rule for AGENTS.md, and leaves AGENTS.md as it was.
---

/anneal:session-review session.jsonl
