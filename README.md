# Slag

Slag contains experimental plugins for coding agents that inspect repositories, reconcile documentation, and constrain implementation tasks.

Use [anneal](anneal/README.md) for repository and documentation reviews.
Use [collet](collet/README.md) for an already planned task with a writable scope and an acceptance command.
These experiments have no support or stability promise.

## Requirements

- Node 22 or later.
- Claude Code, Codex or Antigravity to load a plugin.
- Git for collet and anneal migrations; anneal's read-only audit can also inspect a directory without Git.

## Install and try

In Claude Code, install anneal from this marketplace:

```text
/plugin marketplace add V-Songbird/slag
/plugin install anneal@slag
```

Start a new session in the repository you want to inspect, then request:

```text
/anneal:repo-layout audit
```

The skill reports navigation findings with counts and example paths.
It changes nothing in the project on its own and saves its findings only after you say yes to its offer.
If Node is unavailable, the scan cannot run; check that the host can run `node --version`.

For Codex and Antigravity installation, invocation and hook activation, follow the
[anneal instructions](anneal/README.md#install) or [collet instructions](collet/README.md#install).
The plugin guides distinguish subprocess tests from live host validation.

## Choose a workflow

| Need | Plugin guide |
| --- | --- |
| Audit repository navigation or plan an approved migration | [Anneal workflows](anneal/docs/knowledge/workflows.md) |
| Reconcile documentation or explicitly review a session | [Anneal skills](anneal/README.md#what-you-can-do) |
| Mount a task harness or add a targeted check | [Collet workflow](collet/docs/knowledge/harness-workflow.md) |

Slag has no application configuration. Anneal has no settings;
collet's mounted project uses [its harness configuration](collet/docs/knowledge/harness-workflow.md#configuration).

## Deprecated ideas

These plugins are retired and are not included in the current marketplace.

| Plugin | Idea |
| --- | --- |
| assay | Audit and improve agent instructions. |
| jig | Turn recurring mistakes into verified repository checks. |
| brink | Warn before context limits and suggest focused compaction. |
| jetbrains-router | Route reads, searches and edits through JetBrains IDEs. |
| scribe | Clarify ambiguous requests before implementation. |
| verity | Ground Claude Code answers in current official documentation. |

## Development

From the root of a Git clone, with Node 22 or later and Git available:

```shell
npm run check
```

The command runs all repository and plugin tests and exits non-zero on failure.
No dependency installation is needed. Read [repository scope and checks](docs/knowledge/repository-scope.md)
and [host contracts](docs/knowledge/host-plugin-formats.md) before changing a plugin.

## Support and changes

The [issue tracker](https://github.com/V-Songbird/slag/issues) is the only listed channel for bugs and usage questions.
There is no dedicated security-reporting policy in this repository; avoid posting sensitive details publicly.
Release changes are recorded in the [anneal changelog](anneal/docs/knowledge/changelog.md)
and [collet changelog](collet/docs/knowledge/changelog.md).

## License

MIT. See [LICENSE](LICENSE).
