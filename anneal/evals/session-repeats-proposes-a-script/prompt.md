---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
expected_outcome: Runs the repeated-step script on the sessions folder, finds git status --short --ignored in all three sessions, proposes that command, or a short script that runs it after npm test, with a Commands line in AGENTS.md for the owner to approve, and leaves AGENTS.md as it was.
---

/anneal:session-repeats sessions/

I approve no change in this run.
