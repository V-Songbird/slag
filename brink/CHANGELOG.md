# Changelog

All notable changes to brink are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [0.4.0-alpha] — 2026-07-28

### Changed

- The suggested `/compact` instruction now also keeps the facts you already verified this session, so the next stretch doesn't re-check what's settled.
- A warning that lands mid-edit is no longer wasted. Claude judges whether the moment is right, says so in a line if it isn't, and brink holds the message and offers it again each turn until a clean break arrives.
- `BRINK_REPEAT` now sets how far the window may grow before a held warning turns urgent and reaches you directly regardless of timing — it no longer sets a silence gap.

## [0.3.0-alpha] — 2026-07-28

### Changed

- The first nudge now lands at ~200k tokens instead of ~150k, so it arrives closer to the edge.
- The suggested `/compact` instruction now asks for the keep-list in priority order and tells the summary to favour the most recent work over older history.

### Added

- Ignoring a nudge no longer silences it. brink speaks up again every 75k tokens of further growth, and `BRINK_REPEAT` moves that distance.

## [0.2.0-alpha] — 2026-07-23

### Fixed

- The nudge never appeared in clients that don't render hook system messages — the desktop app among them. It now also travels back through Claude, which repeats it to you, so it lands wherever you work. On a client that shows both, you'll see it twice.

## [0.1.0-alpha] — 2026-07-22

### Added

- First cut. Watches the running context size and, once it crosses the threshold, surfaces a one-time suggestion to run `/compact` with a ready-made instruction — tailored to the task and the files you're actually working in.
- Stays quiet until the window drops well below the line again, so a long session gets at most one nudge per fill-up.
- One setting to move the threshold, one to turn it off.
