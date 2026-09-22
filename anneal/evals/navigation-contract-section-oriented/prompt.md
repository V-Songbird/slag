---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write]
expected_outcome: Sets the shipments default page size to 20 and the maximum to 100, as the GET /v2/shipments entry of docs/partner-api.md states, and leaves the other limits as they were.
---

Before anything else, read `AGENTS.md`.

The partner API rejects some of our shipment listings with `422 limit_exceeded`. Make the shipment page sizes in `packages/partner-client/src/limits.js` match the partner's API contract. Change nothing else.
