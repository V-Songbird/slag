---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
expected_outcome: Mounts collet with npm test as the accept command, fills in the project line, opens the first task with src/price.js in its scope, runs the checks against their fixtures, and stops without changing src/, creating a CLAUDE.md or committing.
---

Set up the collet task harness in this repository. Nobody can answer questions while you work, so here are the answers:

- The project: a small price-formatting library. Node 22, ES modules, no dependencies.
- The first task: show prices with a dollar sign. `formatPrice` in `src/price.js` puts `$` in front of the amount, and the tests change to match.
- The command that proves a task worked: `npm test`.
- Nothing here needs asking first.
- No language checks for now.
- No conventions to record.
