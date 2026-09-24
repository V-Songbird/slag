#!/usr/bin/env bash
set -euo pipefail

# The repository and transcript of session-audit-proposes-without-writing.
bash "$(dirname "$0")/../session-audit-proposes-without-writing/session-fixture.sh"

# Cut the fourth record, the second call to npm test, to its first 60 characters,
# as a transcript cut off mid-write would be. The evidence script refuses the
# whole file; the records around the cut stay readable to anyone who opens it.
node -e 'const fs = require("fs"); const lines = fs.readFileSync("session.jsonl", "utf8").split("\n"); lines[3] = lines[3].slice(0, 60); fs.writeFileSync("session.jsonl", lines.join("\n"));'
