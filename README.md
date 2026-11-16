# Slag

Slag is the workshop where the [anneal](https://github.com/V-Songbird/anneal) and
[collet](https://github.com/V-Songbird/collet) plugins for coding agents were developed.
Both now live in their own repositories and are listed in the
[Foundry](https://github.com/V-Songbird/foundry) marketplace. This repository holds no plugin.

## Install anneal and collet

In Claude Code:

```text
/plugin marketplace add V-Songbird/foundry
/plugin install anneal@foundry
/plugin install collet@foundry
```

If you installed either plugin from the `slag` marketplace, remove that marketplace and install
from `foundry` as above. For Codex and Antigravity, follow the install section of each plugin's
README: [anneal](https://github.com/V-Songbird/anneal#install) and
[collet](https://github.com/V-Songbird/collet#install).

To compare anneal and collet with razor, hush and foreman, read
[which plugin owns which job](docs/knowledge/plugin-roles.md).

## What stays here

- `scripts/sdk-eval/`: a runner that gives a plugin's eval cases to the Claude Agent SDK, so the
  sessions bill an API key instead of a Claude plan. It takes the plugin as a directory path, for
  example a clone of anneal or collet. Its header, `scripts/sdk-eval/run.mjs`, lists the options.
- `.collet/`: this repository's own collet harness, which scopes each change to a task and ends it
  with `npm run check`.
- `docs/knowledge/`: research records on [host plugin formats](docs/knowledge/host-plugin-formats.md),
  [plugin roles](docs/knowledge/plugin-roles.md) and
  [repository scope](docs/knowledge/repository-scope.md).
- `scripts/`: the repository's tests and `plugin-parity.js`, which compares an installed plugin copy
  with its tracked source.

## Retired ideas

These plugins were retired and are not offered anywhere.

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

The command runs the repository tests and exits non-zero on failure. No dependency installation is
needed. Read [repository scope and checks](docs/knowledge/repository-scope.md) before changing the
checks.

## Support and changes

The [issue tracker](https://github.com/V-Songbird/slag/issues) is the only listed channel for bugs
and usage questions about this repository; report a plugin's own problems in its repository. There is
no dedicated security-reporting policy here; avoid posting sensitive details publicly. Plugin release
changes are recorded in each plugin's own repository.

## License

MIT. See [LICENSE](LICENSE).
