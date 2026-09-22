---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Bash, Edit, Write]
expected_outcome: Names returningCustomerDiscount in lib/fare-rules/src/returning-customer.js, which the booking service's quote imports, in one ANSWER line, and not a discount function of lib/fares-v1 or lib/promotions.
---

Before anything else, read `AGENTS.md`.

Which function computes the discount that the booking service gives a returning customer? Don't change any files. End your reply with one line in exactly this form:

ANSWER: <path from the repository root> <function name>
