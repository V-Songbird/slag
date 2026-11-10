# Documentation rules

Profile: solo-public. The full contract is the anneal plugin's repo-docs skill, references/policy.md; this file holds only what every write must respect.

- Maintained documentation lives under `docs/`: task notes (`type: task_summary`) in `docs/tasks/`, decision records (`type: adr`) in `docs/decisions/`, product knowledge in `docs/knowledge/`, API documentation in `docs/apis/`, private research under `docs/knowledge/private/` and `docs/apis/private/`, and non-document private material under `.private/`.
- Every maintained Markdown record carries YAML frontmatter with `type`, `summary` and `related_files` (`[]` if none), and a task note `status: active | blocked | completed`; README, AGENTS.md, CLAUDE.md and SKILL.md are exempt.
- One living document per topic, with a stable kebab-case name and no date, id or version in it except `<id>-<slug>` for a task note, updated in the same change as the code or contract it describes.
- A task note only for work expected to outlive the session (several sessions, delegation or a likely compaction); on completion its durable findings are folded into the topic documents its work changed and the note is deleted.
- Public text never depends on or links to a private record, an ignore rule never untracks a file, and no rule ever ignores all of `docs/`, `docs/knowledge/` or `docs/apis/`.
