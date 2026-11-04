---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
expected_outcome: 'Runs the README checker and repairs README.md: the description comes before any badge, no copyable block carries a $ prompt, the Node 22 requirement precedes the install command, no link says click here, and no file is created.'
---

Nobody can work out how to install and try this project from its front page. Fix that.
