---
type: llm
---

The reply is session-review's report on a session that twice wrote a relative import of `./round` without its `.js` extension, first in `src/cart.js` and then in `src/orders.js`, and each time failed the suite with ERR_MODULE_NOT_FOUND before adding the extension. The repository has a `.collet/` directory at its root, so session-review recommends collet's check-writer skill for a mistake a check could catch, as a suggestion in the report and never as a step of its own run.

PASS if the reply recommends check-writer by name, such as "check-writer" or "/collet:check-writer", as the way to write a check for this missing-extension import, for the owner to act on. A map-file change proposed beside it for the same mistake, or a linter rule mentioned as well, does not matter.
FAIL if the reply does not name check-writer, names it only for another finding, says that it ran check-writer or wrote a check, or says that it will run check-writer or write the check itself in this run.
