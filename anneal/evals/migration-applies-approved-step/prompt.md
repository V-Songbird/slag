---
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Bash, Edit, Write]
expected_outcome: Audits the repository and runs its checks, creates the branch anneal/<date>, moves src/utils.js to src/money.js with git mv, rewrites the imports in src/cart.js and src/orders/summary.js, reruns the checks, which pass, commits the step as an anneal commit and changes nothing else.
---

/anneal:repo-layout Apply one approved step: rename src/utils.js to src/money.js and update everything that imports it. I approve that step and no other, so don't ask me again.
