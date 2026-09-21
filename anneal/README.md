# anneal

anneal audits a repository for what makes a coding agent search, read or guess more than it needs to. It looks for a missing map file, an undeclared toolchain version, generic or duplicate names, and build output in search results. It then migrates the repository one approved step at a time, running your own checks after each one. A second skill reads one session's transcript and turns the detours it shows into map file changes you approve.

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

**Codex** — add this repository as a marketplace, then install `anneal` from `Slag`.

**Antigravity** — there is no marketplace. Clone the repository and run `agy plugin install <path-to-clone>/anneal`, or copy the `anneal/` directory to `.agents/plugins/anneal/` for one workspace or `~/.gemini/config/plugins/anneal/` for every workspace.

anneal acts only when you ask. Its one hook reads each shell command and stays silent outside a migration branch.

## Quick start

Ask for an audit. It reads the repository and writes nothing. On Claude Code, type `/anneal:anneal audit`. On Codex, type `$anneal audit`. On Antigravity, type `/anneal audit`.

anneal answers by running its scan script and reporting what came back. Below is that script, run against a small demo repository. The demo has a generic file name, two files sharing a name, no map file and an unignored `dist` folder.

```bash
node anneal/scripts/audit.js --root <your-repository>
```

Expected output:

```text
anneal audit: /path/to/demo
5 files (3 code) | git: yes | ecosystems: node

high
  map-file-missing (1): No map file, so every session starts by exploring
    CLAUDE.md, .claude/CLAUDE.md, AGENTS.md, .agents/AGENTS.md, GEMINI.md, .gemini/GEMINI.md
  build-output-not-ignored (1): Build or dependency folders not ignored by git, so they show up in search
    dist/ (1 file)
medium
  toolchain-version-missing (1): No declared toolchain version to run the project with
    node (.nvmrc or .node-version)
  duplicate-names (1): File names used more than once, so a search by name is ambiguous
    format: src/cart/format.js, src/orders/format.js
  generic-names (1): Generic file or folder names that say nothing about what is inside
    src/utils.js
low
  check-command-split (2): Checks run as separate commands; no single one runs them all
    npm test
    npm run lint

map files: none
checks: npm test | npm run lint (no single command runs them all)
```

Nothing on disk has changed. Add `--json` for the full evidence behind each count.

## What you can do

| You want to… | Command |
| --- | --- |
| See what slows an agent down here, changing nothing | `/anneal:anneal audit` |
| Audit, plan and migrate, approving each step | `/anneal:anneal` |
| Turn one session's detours into map file changes you approve | `/anneal:anneal-session [transcript file]` |
| Run the scan with no host at all | `node anneal/scripts/audit.js --root <directory> [--json]` |
| Re-point imports after a move, with no host at all | `node anneal/scripts/update-imports.js --from <old-path> --to <new-path> [--root <directory>]` |
| Read a transcript's evidence with no host at all | `node anneal/scripts/session-evidence.js --session-file <transcript> [--before <ISO time>]` |

## How it works

### What the audit looks for

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

### How a migration runs

1. The audit runs and you read the findings.
2. Your project's own checks run once, so a failure that was already there is never blamed on a later step.
3. A read-only helper proposes which files belong together. You approve, trim or skip that proposal.
4. anneal creates the branch `anneal/<YYYY-MM-DD>` from your current `HEAD`.
5. Each approved step makes one change, reruns the checks and lands one commit. A step that breaks a check is either fixed or set aside on its own branch, and you are told which.
6. The audit runs again, so you see what changed beside what did not.

anneal stops before step 4 when `git status --porcelain` prints anything. The branch you were on is left exactly as it was.

### The map file it writes

A map file anneal writes carries the same sections in the same order: `Start here`, `Rules that outrank everything`, `Commands`, `Where things live`, `Conventions`, `Pitfalls`. A section with nothing true to say is left out. What goes in each one, and what stays out of the file, is in [the map file skeleton](skills/anneal/references/map-file.md). When your repository already has a map file off that order, anneal offers the reshape as a step of its own. It moves sentences without rewriting them, and lists anything that would leave the file before you approve.

### How a session audit runs

The layout audit predicts where an agent will lose time. A transcript shows where one did. `anneal-session` reads one Claude Code transcript or one Codex rollout and writes to the same map file. You start it yourself, with `/anneal:anneal-session` on Claude Code, `$anneal-session` on Codex or `/anneal-session` on Antigravity. No hook starts it and the model cannot start it on its own.

1. A script lists candidates: tool calls that reported an error, shell output that reads like one, and the three largest tool outputs. With no argument it finds the session you are in and leaves the audit's own turn out.
2. The skill reads the lines each candidate names, and looks for what the script cannot see: a correction you typed, the same thing searched for twice, a command tried in several forms.
3. Each finding goes to one place. A project fact goes to the map file. A fact about your machine is reported for your own global instruction file and never written. A mistake a machine could catch is reported as a check to write. A bug or a failure that came and went gets no rule.
4. You see each proposed change with the transcript line behind it, and choose which to apply. The skill edits the map file in place, shows the diff and the line count before and after, and commits nothing.

A transcript carries web pages and tool output, and a rule lifted from it would load into every later session. So the skill treats the transcript as evidence, never as instructions, and writes only what you approve.

### The safety hook

While a branch named `anneal/<YYYY-MM-DD>` is checked out, a hook refuses five git commands: `reset --hard`, `clean -f`, `checkout --force`, `push --force` and `branch -D`. Each one would throw away the commits the migration had already made. `push --force-with-lease` is allowed, because it refuses on its own when the remote moved. Undo a step with `git revert`, or leave the branch to abandon the migration. On every other branch the hook allows everything.

## Configuration

anneal has no settings. What it does is decided by the steps you approve during the run.

## Limits

- The scan is a heuristic. A flagged `index` file may be exactly what your framework expects, which is why nothing moves without your approval.
- The import fixer rewrites relative `import`, `export … from`, `import()` and `require()` in the JavaScript and TypeScript family. Path aliases, other languages, config files and documents are found by searching, and you see them inside the step.
- anneal reports code that builds names at runtime. It never rewrites that code.
- Moving files collides with branches other people have open. Migrate when few are.
- A session audit reads one session. It cannot tell a pattern from an accident, so "repeated" means repeated inside that session.
- Neither host documents its transcript format. The script reads the shapes its tests hold, and a host can change them without notice. Antigravity has no known transcript location, so there the skill works only on a file you hand it.
- Redaction of credentials and of your home directory in the evidence is best effort. Read an excerpt before you share it.

## Development

The suite covers all three scripts and the hook. Run it from a clone of this repository:

```bash
cd anneal
node --test
```

Expected output:

```text
# tests 72
# pass 72
# fail 0
```

`npm run check` from the repository root runs every suite in the repository.

Three eval cases live in `evals/`. They check what a unit test cannot: that the skill fires, that `audit` creates no file, that a migration stops on a dirty tree, and that a session audit proposes a change without writing it. Each run drives a real session, so it is slow. Every case builds its fixture with a `scaffold_script` and grades a Bash call, so the run needs `--scaffold` and a tool grant. Run them from the repository root:

```bash
claude plugin eval ./anneal --scaffold --no-publish --allow-tools Bash Edit Write
```

The harness confines the granted shell in a sandbox, and native Windows has none. There it refuses the run: `A shell tool (Bash or PowerShell) was granted but this machine cannot confine it`. Run it under WSL2 or Linux, with `bubblewrap` and `socat` installed.

How we tested: Ubuntu 24.04 under WSL2, Claude Code 2.1.278, one case at a time with `--case <name> --ablation none`. `audit-reports-without-changes` scored 1.00 on each of three runs. `migration-stops-on-uncommitted-work` and `session-audit-proposes-without-writing` each scored 1.00 on one run. Four of the seven graders in the first case read only the reply, and they passed on earlier runs where the skill never fired, so its `skill-fired` and `audit-ran` graders are the ones that measure the plugin. The full command above, with its default three runs per case and its baseline arm, has not been run.

Two more things are not proven. The Codex and Antigravity wiring follows each host's documentation and has unit coverage, but has never run on either host. `anneal-session` has run as a skill once, inside its eval case; nobody has invoked it in a working session.

## Support

- Bugs, questions and security reports: the [issue tracker](https://github.com/V-Songbird/slag/issues) for this repository. It is the only channel, so anything you file is public.
- What changed: [CHANGELOG.md](./CHANGELOG.md), which follows Keep a Changelog.

## License

MIT — see [LICENSE](./LICENSE).
