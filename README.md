# slag

Slag is a marketplace of experimental agent plugins. Slag is the byproduct that comes off the good metal, and this repository is where plugin ideas live before they are worth anyone's trust.

Two plugins are installable from here. Both work on their own and stay out of the other's way.

> **Nothing here is a product.** These plugins get rewritten, renamed and deleted without notice or a migration path. There is no support, no stability promise and no release schedule. You are welcome to install any of them. If one breaks your session, that is the deal you took.

## Requirements

- Node 22 or later, for both plugins and the test suite.
- Claude Code, Codex or Antigravity.

## Install

```text
/plugin marketplace add V-Songbird/slag
/plugin install <plugin-name>@slag
```

The first command registers this collection once. The second installs one plugin, and takes effect next session. To confirm it loaded, start a new session and type `/anneal:improve-agent-navigation audit` or `/collet:collet`.

The marketplace itself has no settings. Each plugin's README says whether that plugin has any. Uninstall with `/plugin uninstall <plugin-name>@slag`.

On Codex, add this repository as a marketplace and install from `Slag`.

Antigravity has no marketplace to add. Clone this repository, then either run `agy plugin install <path-to-clone>/<plugin-name>` or copy the plugin directory to `.agents/plugins/<plugin-name>/` in a workspace, or to `~/.gemini/config/plugins/<plugin-name>/` for every workspace.

## The plugins

### [anneal](./anneal) — improve navigation, documentation and session instructions

`improve-agent-navigation` audits a repository's layout and migrates approved steps, running the project's checks before and after each change. `learn-from-session` turns one session's detours into instruction changes you approve. `reconcile-project-docs` checks documentation and non-code development files against the project, then applies authorized corrections or reports findings in audit mode.

```text
/plugin install anneal@slag
```

Read the [anneal README](./anneal/README.md).

### [collet](./collet) — hold a session inside the task it was given

A session will finish work it never did. collet gives it one open task, the exact files it may touch, and a command that decides when it is over. A write outside the list is refused as it happens. Closing runs the accept command and checks that nothing landed outside the list first. A project that already plans its work in a roadmap it does not own is left alone: the mount writes nothing there.

```text
/plugin install collet@slag
```

Read the [collet README](./collet/README.md).

### Which one first?

| You want to… | Install |
| --- | --- |
| Make a repository easier for an agent to find its way around | **anneal** |
| Reconcile documentation or learn from one session's detours | **anneal** |
| Stop a session drifting past its task, or calling work done | **collet** |

They compose: anneal gets the layout into shape, and collet keeps a session from wandering out of it.

## Development

```bash
npm run check
```

That runs every suite with `node --test --test-reporter=spec`. There is no CI.

Plugins live in-tree as plain directories, with one history and no submodules.
[AGENTS.md](AGENTS.md) is the map: the layout, the three manifests each plugin ships, and the
conventions a change has to respect.

## Support

- Bugs and questions: the [issue tracker](https://github.com/V-Songbird/slag/issues) for this repository. It is the only channel.
- Security reports: the same issue tracker. There is no `SECURITY.md` and no private address, so anything you file is public.
- What changed: each plugin's own `CHANGELOG.md` — [anneal](./anneal/CHANGELOG.md), [collet](./collet/CHANGELOG.md).
- This repository accepts no outside contributions and carries no `CONTRIBUTING.md`.

## License

MIT — see [LICENSE](./LICENSE).
