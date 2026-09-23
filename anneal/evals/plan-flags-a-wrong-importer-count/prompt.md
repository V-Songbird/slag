---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash]
expected_outcome: Audits the repository and runs its checks, takes the layout survey from the prompt, finds that two files import src/utils.js although the survey's row says one, shows the plan with that row flagged and the two importers named, applies nothing, and changes no file.
---

/anneal:repo-layout Plan only: apply nothing, and stop after showing me the plan. The layout survey already ran, so use its proposal below instead of running it again.

### Keep as is
None proposed.

### Proposed renames
| From | To | Importers | Reason |
| --- | --- | --- | --- |
| `src/utils.js` | `src/money.js` | 1 | Generic name; the file formats prices |

### Proposed moves
None proposed.

### Leave for the owner
None proposed.

### Risks
None proposed.
