# Slag

Slag was the workshop where the anneal and collet plugins for coding agents were developed. It also held an SDK eval runner and its own collet harness. This repository is kept as a record and takes no new work.

## What happened

- 2026-11-14: the owner decided to move both plugins out of Slag.
- 2026-11-15: anneal and collet got their own repositories. Their history came across with `git subtree split`.
- 2026-11-16: the Foundry marketplace listed both plugins, and the first release there was 0.8.0-alpha. The same day, commit `327a47f` removed `anneal/`, `collet/`, Slag's two marketplace catalogs and its release skills.
- 2026-11-16: the commit that wrote this page removed everything else except this README, the license and `.gitignore`. The eval runner is no longer published here.

## Where everything is now

- Marketplace: [V-Songbird/foundry](https://github.com/V-Songbird/foundry)
- anneal: [V-Songbird/anneal](https://github.com/V-Songbird/anneal)
- collet: [V-Songbird/collet](https://github.com/V-Songbird/collet)

In Claude Code, install the plugins with:

```text
/plugin marketplace add V-Songbird/foundry
/plugin install anneal@foundry
/plugin install collet@foundry
```

For Codex and Antigravity, follow the install section of each plugin's README. Release notes are on each plugin's GitHub releases page.

If you added the `slag` marketplace, remove it and add `foundry` instead. Use Claude Code's plugin manager to remove a marketplace.

## The earlier tree

The full earlier tree is in this repository's Git history. The last commit that holds everything but the two plugin folders is `327a47f`. Its parent, `9ae0f3d`, still holds `anneal/` and `collet/`. Check one out to read the old files.

## License

MIT. See [LICENSE](LICENSE).
