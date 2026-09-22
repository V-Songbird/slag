---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write]
expected_outcome: Adds NO to the nordic zone in apps/storefront/src/shipping.js and leaves every other zone and rate as they were.
---

Before anything else, read `AGENTS.md`.

Orders to Norway are charged the world shipping rate, but Norway belongs in the nordic zone. Add it to that zone in `apps/storefront/src/shipping.js`. Change nothing else.
