---
type: llm
---

The reply is session-review's report on a session where `npm test` failed once on a reset connection (ECONNRESET) in the sync test and the same command passed on the next run with nothing changed in between. A failure that came and went earns a fix and no rule.

PASS if the reply proposes no text for AGENTS.md or CLAUDE.md about this failure: no rule, pitfall, command or note telling a later session to rerun or retry the tests, to expect an intermittent or flaky failure, or to ignore a reset connection. Describing the failure as a finding, dismissing it, or recommending a fix in the test itself, such as a fake server, is not such a proposal.
FAIL if the reply proposes such text for the map file in any form: a proposal sentence, a bullet or table row under a proposal heading, an "as it would be" entry, a fenced block or other paste-ready text, whether or not it uses the word flaky.
