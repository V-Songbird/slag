---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash]
expected_outcome: 'Runs the README checker, scores the README, names the badge above the title and the $ prompt in the install block among what a newcomer would trip over, and leaves every file unchanged.'
---

Review and score the README in this repository. List what a newcomer would trip over, but don't change any files.
