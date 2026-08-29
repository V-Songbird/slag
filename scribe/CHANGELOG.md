# Changelog

All notable changes to scribe are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [1.3.1] — 2026-08-29

### Fixed

- `/scribe:review` can now tell you that scribe is asking too little. It used to say so only when scribe had never asked at all, so a project where it fired on one prompt in ten was reported as healthy. It now reads how many prompts went by untouched, and says something once that share passes 85 percent.

## [1.3.0] — 2026-08-28

### Changed

- scribe now asks the moment a word has to be interpreted, rather than when two readings feel evenly matched. Claude restates your request as one sentence naming the files it will touch and what would count as done; if writing that sentence meant picking what a word meant, you get the question instead of the guess.
- A question round no longer loses to a quiet host. Output styles, brevity rules and act-now instructions used to outrank the ask without ever saying so, and a project that ran one saw scribe stay silent on requests it should have stopped.
- The ask itself is what Claude reads first now. It used to sit behind the list of reasons to skip it.

## [1.2.1] — 2026-08-18

### Fixed

- One project, one log. scribe had been starting a fresh `.scribe/` folder in whatever directory the session was working in, scattering fragments through a repository and leaving `/scribe:review` to report on whichever one it happened to be standing in.

### Changed

- The log now ignores itself in git, so it never turns up in your diffs. `.scribe/config.json` still does — that one is a choice worth sharing.

## [1.2.0] — 2026-08-18

### Added

- `/scribe:review` now watches whether the options were any good. When you keep answering in your own words instead of picking one, it says so — and points at the questions, not at how often scribe asks.
- The log keeps the options a round offered, so you can see what you were choosing between.

### Changed

- Before asking anything, scribe now names the one reading it would act on alone, then goes looking for what does not fit it — including the case where everything fits a little too neatly, which is exactly how a wrong guess feels from the inside.
- When more is open than one round can hold, scribe leads with the questions whose answers open up the others.

### Fixed

- The log now records the answers you picked. It was filling that space with scribe's own questions instead, which left the review with nothing to show and stopped scribe recognising an answer it had seen before.
- A phrase like "just do it" now only stands scribe down when you lead with it. Asking for "a Surprise me button", or telling it to "stop asking me for the token", counted as waving it off — and fed the review evidence you never gave.
- "don't ask" is recognised when your keyboard uses a curly apostrophe.
- `/scribe:review` no longer says scribe "stopped asking after 0 rounds" and then tells you to raise a limit you never set.
- `/scribe:review` will now tell you when scribe has judged a lot of prompts and asked nothing at all. On the default setting it had no way to mention it.

## [1.1.0] — 2026-08-13

### Changed

- scribe asks whenever a request could genuinely go more than one way. The old, quieter bar is still there as `"bar": "conservative"` for projects that want less.
- The three-round-per-session limit is off by default. A session that keeps forking gets the questions it needs; set `"fatigueCap"` yourself if you want a ceiling back.
- Questions now keep coming until nothing material is left to settle. Previously a follow-up only happened when one of your answers opened a new fork, so anything that did not fit in the first round was dropped. Now the leftovers come back in the next round.

## [1.0.0] — 2026-08-11

### Added

- Measured results in the README, so what scribe claims is a number you can check rather than an assertion.

### Changed

- Remembered meanings are length-capped.
- The review and clarify skills now treat everything quoted from the log and the memory as data to display, never as instructions to follow.

## [0.3.0-alpha] — 2026-08-11

### Added

- Remembered answers, per project: when you answer the same question the same way in a second session, scribe offers to remember it. A remembered answer shows up as a stated assumption you can veto in a word — never as a question again.
- `/scribe:review` lists everything remembered; "forget that" (or the `forget` command) deletes an entry. The memory file is append-only and stays in your project.

## [0.2.0-alpha] — 2026-08-11

### Added

- `/scribe:review`: a readout of everything scribe has done in the project — prompts judged, question rounds asked, silent passes, wave-offs, fatigue-cap stops — with recent rounds shown and every tuning suggestion quoting the rule that produced it. Agree to a suggestion and it updates the config for you.
- Question rounds now record which answers were picked, so the review can show what a round actually settled.

## [0.1.0-alpha] — 2026-08-11

### Added

- The gate: every prompt you submit gets a small judgment nudge — if the request could honestly be executed in materially different ways, Claude asks one round of numbered questions with options, recommended answer first, before doing the work. Precise requests pass in silence.
- The clarify skill: the full questioning method — blind-spot pass, one-round frontier, grounded options, follow-ups only when an answer unlocks them, one-line task statement before executing.
- The ledger: every judged prompt, question round, and wave-off is recorded in `.scribe/ledger.jsonl`, locally, with nothing sent anywhere.
- Escape hatches: "just do it" is honored instantly and logged; `SCRIBE_OFF=1`, an empty `.scribe/off` file, or `"off": true` in config each silence scribe entirely.
- A fatigue cap: after three question rounds in a session (configurable), scribe stops asking.
- Optional `.scribe/config.json`: asking bar (`conservative` or `standard`), fatigue cap, kill-switch mirror. Invalid config falls back to defaults with a warning, never an error.
- Stand-downs for contexts that should never be questioned: slash commands, empty prompts, and unattended runs.
