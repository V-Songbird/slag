# anneal

anneal audits a repository for what makes a coding agent search, read or guess more than it needs to. It looks for a missing map file, an undeclared toolchain version, generic or duplicate names, and build output in search results. It then migrates the repository one approved step at a time, running your own checks after each one.

Use it on an existing project with a git history. It is not a scaffolder for a new project, and it is not worth installing for a single rename.

> **Experimental.** No support and no stability promise. It can change shape or disappear without a migration path.

## Requirements

- Node 18 or later.
- Claude Code, Codex or Antigravity.
- For a migration: a git repository with at least one commit, a clean working tree, and `git config user.email` set. The audit alone needs none of these.

## Install

**Claude Code**

```text
/plugin marketplace add V-Songbird/slag
/plugin install anneal@slag
```

Takes effect next session.

**Codex** — add this repository as a marketplace, then install `anneal` from `Slag · Codex`.

**Antigravity** — copy the `anneal/` directory to `~/.gemini/config/plugins/anneal/` for every project, or to `.agents/plugins/anneal/` for one workspace.

Nothing runs until you ask for it.

## Quick start

Ask for an audit. It reads the repository and writes nothing.

```text
/anneal:anneal audit
```

On Codex and Antigravity, type `$anneal audit` instead.

anneal answers by running its scan script and reporting what came back. Here is that script run against this repository:

```bash
node anneal/scripts/audit.js --root .
```

Expected output:

```text
anneal audit: D:\Projects\Songbird\Slag
59 files (19 code) | git: yes | ecosystems: none detected

high
  map-file-missing (1): No map file, so every session starts by exploring
    CLAUDE.md, .claude/CLAUDE.md, AGENTS.md, .agents/AGENTS.md, GEMINI.md, .gemini/GEMINI.md
  check-command-missing (1): No test or check command found
    no package script, make target or test runner config
medium
  generic-names (1): Generic file or folder names that say nothing about what is inside
    collet/tests/helpers.js

map files: none
checks: none found
```

Nothing on disk has changed. Add `--json` for the full evidence behind each count.

## What you can do

| You want to… | Ask for |
| --- | --- |
| See what slows an agent down here, changing nothing | `/anneal:anneal audit`, or `$anneal audit` |
| Audit, plan and migrate, approving each step | `/anneal:anneal`, or `$anneal` |

## What the audit looks for

Each rule removes steps an agent repeats every session. The reason behind each one is in [the target conventions](skills/anneal/references/conventions.md).

| Severity | Finding | What it means |
| --- | --- | --- |
| high | `map-file-missing` | No `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, so every session starts by exploring |
| high | `check-command-missing` | No test or check command found |
| high | `build-output-not-ignored` | Build or dependency folders that git does not ignore, so they fill search results |
| high | `not-a-git-repo` | Search cannot use `.gitignore` to skip generated files |
| medium | `map-file-long` | A map file over 200 lines, loaded into every session |
| medium | `toolchain-version-missing` | No `.nvmrc`, `.python-version` or equivalent |
| medium | `env-template-missing` | Environment files with no `.env.example` naming the variables |
| medium | `duplicate-names` | One file name used more than once, so a search by name is ambiguous |
| medium | `generic-names` | `utils`, `helpers`, `common` and the rest, which say nothing about the contents |
| medium | `large-files` | Code files over 800 lines, expensive to read whole |
| medium | `build-output-tracked` | Generated files committed to git |
| low | `index-files` | Three or more files named `index` |
| low | `deep-nesting` | Code six or more folders down |
| low | `runtime-names` | Names assembled at runtime, which search cannot follow |
| low | `default-exports` | Default exports, which can be imported under another name |
| low | `re-export-files` | Index files that only re-export, adding a hop to every lookup |
| low | `check-command-split` | Checks exist, but no single command runs them all |

## How a migration runs

1. The audit runs and you read the findings.
2. Your project's own checks run once, so a failure that was already there is never blamed on a later step.
3. A read-only helper proposes which files belong together. You approve, trim or skip that proposal.
4. anneal creates the branch `anneal/<YYYY-MM-DD>` from your current `HEAD`.
5. Each approved step makes one change, reruns the checks and lands one commit. A step that breaks a check is either fixed or set aside on its own branch, and you are told which.
6. The audit runs again, so you see what changed beside what did not.

anneal stops before step 4 when `git status --porcelain` prints anything. The branch you were on is left exactly as it was.

## Configuration

anneal has no settings. What it does is decided by the steps you approve during the run.

## Safety

While a branch named `anneal/<YYYY-MM-DD>` is checked out, a hook refuses four git commands: `reset --hard`, `clean -f`, `push --force` and `branch -D`. Each one would throw away the commits the migration had already made. Undo a step with `git revert`, or leave the branch to abandon the migration. On every other branch the hook allows everything.

## Limits

- The scan is a heuristic. A flagged `index` file may be exactly what your framework expects, which is why nothing moves without your approval.
- The import fixer rewrites relative `import`, `export … from`, `import()` and `require()` in the JavaScript and TypeScript family. Path aliases, other languages, config files and documents are found by searching, and you see them inside the step.
- anneal reports code that builds names at runtime. It never rewrites that code.
- Moving files collides with branches other people have open. Migrate when few are.

## Development

The two scripts run on their own, outside any host:

```bash
node anneal/scripts/audit.js --root <directory> [--json]
node anneal/scripts/update-imports.js --from <old-path> --to <new-path> [--root <directory>]
```

The suite covers all three of them:

```bash
node --test anneal/tests/*.test.js
```

Expected output:

```text
# tests 49
# pass 49
# fail 0
```

`npm run check` from the repository root runs anneal's 49 alongside collet's 68.

## Support

- Bugs and questions: the [issue tracker](https://github.com/V-Songbird/slag/issues) for this repository.
- anneal keeps no changelog yet. Its version lives in the marketplace entry, [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json).

## License

MIT — see [LICENSE](./LICENSE).
