# Changelog

## Unreleased

### Added

- The per-session cap on armed blocks is now asked at enable time. `PLUMB_SESSION_CAP` still works and takes precedence.
- plumb now recognizes wrapper and script runners as checks — `./gradlew`, `mvnw`, shell and PowerShell scripts, and common ecosystem commands like `mix test` or `flutter test`.
- An **Extra check commands** setting names runners plumb should count as checks. An armed gate also learns a project's own scripts from repeatedly waved-off blocks — learning only ever makes it block less.

### Fixed

- The enable-time **Arm the completion gate** setting had no effect; arming worked only through `PLUMB_ARM=1`.
- An early failing run no longer counts against a turn once a re-run of the same command passed.
- A closing message that plainly states its own failures or blockers is no longer treated as an unproven success claim.

## 0.1.0-alpha

- First release. plumb watches the end of each turn: when Claude edits code and signs off as done without running a test, build, or the program, it can ask Claude to verify before finishing.
- Ships observe-only by default — it records candidates to a log and never interrupts a turn. Turn on **Arm the completion gate** (or `PLUMB_ARM=1`) to have it hold the line.
- Fires once per turn; `PLUMB_DISABLE=1` turns it off.
