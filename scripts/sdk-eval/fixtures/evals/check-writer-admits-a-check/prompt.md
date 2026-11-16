---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
expected_outcome: Writes .collet/checks/<name>.mjs with a check and a live function, a .violation and a .nearmiss fixture beside it, runs node .collet/checks/run.mjs until the new check is admitted, and changes nothing outside .collet/.
---

Agents keep leaving `console.log` calls in files under `src/`. Add a check to this project's collet harness that catches that, with the fixtures that prove it, and show me it is admitted.
