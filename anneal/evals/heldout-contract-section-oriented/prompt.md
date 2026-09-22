---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write]
expected_outcome: Sets the manifest default batch to 25 and the maximum to 60, as the POST /v3/manifests entry of reference/carrier-api.md states, and leaves the other limits as they were.
---

Before anything else, read `AGENTS.md`.

The carrier rejects some of our manifest uploads with `413 batch_too_large`. Make the manifest batch sizes in `integrations/carrier/src/limits.js` match the carrier's API contract. Change nothing else.
