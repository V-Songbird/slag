# Changelog

All notable changes to brink are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [0.2.0-alpha] — 2026-07-23

### Fixed

- The nudge never appeared in clients that don't render hook system messages — the desktop app among them. It now also travels back through Claude, which repeats it to you, so it lands wherever you work. On a client that shows both, you'll see it twice.

## [0.1.0-alpha] — 2026-07-22

### Added

- First cut. Watches the running context size and, once it crosses the threshold, surfaces a one-time suggestion to run `/compact` with a ready-made instruction — tailored to the task and the files you're actually working in.
- Stays quiet until the window drops well below the line again, so a long session gets at most one nudge per fill-up.
- One setting to move the threshold, one to turn it off.
