# Changelog

All notable changes to scribe are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [0.3.0-alpha] - 2026-08-11

The memory: never the same question twice.

### Added

- Remembered answers, per project: when you answer the same question the same way in a second session, scribe offers to remember it. A remembered answer shows up as a stated assumption you can veto in a word — never as a question again.
- `/scribe:review` lists everything remembered; "forget that" (or the `forget` command) deletes an entry. The memory file is append-only and stays in your project.

## [0.2.0-alpha] - 2026-08-11

The bar: tune scribe from what it actually did.

### Added

- `/scribe:review`: a readout of everything scribe has done in the project — prompts judged, question rounds asked, silent passes, wave-offs, fatigue-cap stops — with recent rounds shown and every tuning suggestion quoting the rule that produced it. Agree to a suggestion and it updates the config for you.
- Question rounds now record which answers were picked, so the review can show what a round actually settled.

## [0.1.0-alpha] - 2026-08-11

The first working cut: the ask.

### Added

- The gate: every prompt you submit gets a small judgment nudge — if the request could honestly be executed in materially different ways, Claude asks one round of numbered questions with options, recommended answer first, before doing the work. Precise requests pass in silence.
- The clarify skill: the full questioning method — blind-spot pass, one-round frontier, grounded options, follow-ups only when an answer unlocks them, one-line task statement before executing.
- The ledger: every judged prompt, question round, and wave-off is recorded in `.scribe/ledger.jsonl`, locally, with nothing sent anywhere.
- Escape hatches: "just do it" is honored instantly and logged; `SCRIBE_OFF=1`, an empty `.scribe/off` file, or `"off": true` in config each silence scribe entirely.
- A fatigue cap: after three question rounds in a session (configurable), scribe stops asking.
- Optional `.scribe/config.json`: asking bar (`conservative` or `standard`), fatigue cap, kill-switch mirror. Invalid config falls back to defaults with a warning, never an error.
- Stand-downs for contexts that should never be questioned: slash commands, empty prompts, and unattended runs.
