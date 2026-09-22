---
type: knowledge
summary: "Shared public README structure for Slag plugins; read before editing installation, usage or compatibility documentation."
related_files:
  - anneal/README.md
  - collet/README.md
---

# Plugin README structure

Both plugin READMEs use this H2 order:

1. Requirements
2. Install
3. Quick start
4. What you can do
5. Configuration
6. Limits
7. Development
8. Support
9. License

Introduce purpose and fit before the experimental notice. State the runtime requirement and
supported hosts before installation. Show the primary invocation for each host in Quick start,
with a concrete result or observable behavior from an actual run.

Install guidance must include required hook trust and how to confirm activation. Distinguish
CLI installation from workspace/IDE conventions when they differ. Put detailed mechanisms,
command references and reproducible benchmarks in the linked plugin workflow guide.

Describe current behavior, configuration and limits. Keep verification concise and scoped to
what it establishes. Runtime prompts, regression fixtures and necessary technical rationale are
product documentation; session narratives and investigation histories are not README content.

Development names the actual test command and verified outcome, while preserving meaningful
host limitations. Keep the plugin version in its host metadata rather than copying it into the
README. Preserve the common experimental notice, public support route and license statement.
