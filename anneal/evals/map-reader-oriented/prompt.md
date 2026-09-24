---
max_turns: 15
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep]
expected_outcome: Answers A1 with packages/price-engine, A2 with `node --test <file>`, A3 with docs/partner-api.md and its section 8, Endpoint reference, and A4 with 22, all from the map and the files it names.
---

Only the project notes are in this directory; the source code and tests are not. Answer four questions from the notes alone. When the notes do not say, answer `not in the notes` rather than guessing. Change no files.

1. Which package computes member discounts and tax?
2. Which command runs a single test file?
3. Which file and section hold the page size an endpoint accepts?
4. Which Node version does the project use?

End your reply with exactly these four lines, one answer each:

A1: <package path, or not in the notes>
A2: <command>
A3: <file and section, or not in the notes>
A4: <version>
