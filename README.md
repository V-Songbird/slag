# slag

Slag is a marketplace of experimental agent plugins. Slag is the byproduct that comes off the good metal, and this repository is where plugin ideas live before they are worth anyone's trust.

Two plugins are installable from here. Both work on their own and stay out of the other's way.

> **Nothing here is a product.** These plugins get rewritten, renamed and deleted without notice or a migration path. There is no support, no stability promise and no release schedule. You are welcome to install any of them. If one breaks your session, that is the deal you took.

## Requirements

- Node, for the scripts both plugins run. anneal needs 18 or later; collet's own test suite needs 22.
- Claude Code or Codex. anneal also runs on Antigravity.

## Install

```text
/plugin marketplace add V-Songbird/slag
/plugin install <plugin-name>@slag
```

The first command registers this collection once. The second installs one plugin, and takes effect next session. Uninstall with `/plugin uninstall <plugin-name>@slag`.

On Codex, add this repository as a marketplace and install from `Slag · Codex`.

## The plugins

### [anneal](./anneal) — lay a repository out so an agent stops searching for it

Every session, an agent learns your project by searching it. A folder called `helpers`, a stack of files all named `index`, and a test command nobody wrote down turn that into a scavenger hunt. anneal scans for those snags without touching anything, proposes a layout you approve, and migrates one step at a time. Your project's own checks run before the first change and after every step, and each step is its own commit.

```text
/plugin install anneal@slag
```

Read the [anneal README](./anneal/README.md).

### [collet](./collet) — hold a session inside the task it was given

A session will finish work it never did. collet gives it one open task, the exact files it may touch, and a command that decides when it is over. A write outside the list is refused as it happens. Closing runs the accept command and checks that nothing landed outside the list first. On a project that already plans its work in a roadmap, collet writes no ledger of its own.

```text
/plugin install collet@slag
```

Read the [collet README](./collet/README.md).

### Which one first?

| You want to… | Install |
| --- | --- |
| Make a repository easier for an agent to find its way around | **anneal** |
| Stop a session drifting past its task, or calling work done | **collet** |

They compose: anneal gets the layout into shape, and collet keeps a session from wandering out of it.

## Repository layout

```text
slag/
├── .agents/plugins/marketplace.json   Codex marketplace index
├── .claude-plugin/marketplace.json    Claude Code marketplace index
├── AGENTS.md                          the map an agent reads first
├── CLAUDE.md                          a pointer to AGENTS.md
├── anneal/
├── collet/
└── docs/
    ├── collet-design.md            Why each mechanism in collet exists
    └── documentation-cleanup.md    What this repository still owes its own docs
```

Plugins live in-tree as plain directories, with one history and no submodules. Each ships its metadata three times, once per host: `.claude-plugin/plugin.json` for Claude Code, `.codex-plugin/plugin.json` for Codex, and `plugin.json` at the plugin root for Antigravity.

Both marketplace indexes own every plugin's version number. A `plugin.json` for Claude Code carries no `version` field.

## Development

```bash
npm run check
```

That runs `node --test`: 68 tests, all in collet. anneal ships no test suite in this repository.

There is no CI. Reproduce what anneal's own audit says about this repository:

```bash
node anneal/scripts/audit.js --root .
```

## Support

- Bugs and questions: the [issue tracker](https://github.com/V-Songbird/slag/issues) for this repository. It is the only channel.
- What changed: each plugin's own `CHANGELOG.md`, where it has one. collet has one; anneal does not yet.
- This repository accepts no outside contributions and carries no `CONTRIBUTING.md`.

## License

MIT — see [LICENSE](./LICENSE).
