---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write]
expected_outcome: Names memberDiscount in packages/price-engine/src/member-discounts.js, which the storefront checkout imports, in one ANSWER line, and not a loyalty function of packages/pricing or packages/quotes.
---

Before anything else, read `AGENTS.md`.

Which function computes the loyalty discount that the storefront checkout gives a member? Don't change any files. End your reply with one line in exactly this form:

ANSWER: <path from the repository root> <function name>
