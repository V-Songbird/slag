---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write]
expected_outcome: Adds PT to the eu region in services/booking/src/fees.js and leaves every other region and fee as they were.
---

Before anything else, read `AGENTS.md`.

Bookings from Portugal pay the non-EU service fee, but Portugal is in the EU. Add it to the EU region in `services/booking/src/fees.js`. Change nothing else.
