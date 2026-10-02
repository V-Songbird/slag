---
type: llm
---

The reply is session-review's report on a session that twice wrote a relative import of `./round` without its `.js` extension, first in `src/cart.js` and then in `src/orders.js`, and each time failed the suite with ERR_MODULE_NOT_FOUND before adding the extension. The repository has no `.collet/` directory, so session-review must not name collet's check-writer skill.

PASS if the reply nowhere names the check-writer skill. Stating that the repository has no `.collet/` directory is not naming it, and neither is recommending a check in the project's own linter or tests, such as a lint rule or a test that every relative import ends in `.js`, proposing a map-file pitfall, or proposing nothing.
FAIL if the reply names the check-writer skill in any form, such as "check-writer", "/collet:check-writer" or "collet's check-writing skill", including to say that it is unavailable, not installed, or not recommended because `.collet/` is absent.
