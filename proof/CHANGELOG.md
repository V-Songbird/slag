# Changelog

All notable changes to proof are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [0.3.0-alpha] — 2026-07-22

### Added

- `proof watch` — a drift monitor. `watch save` records a behavior as a distribution (many runs → a pass rate with a confidence interval); `watch check` re-runs it cheaply and flags drift only when the fresh rate falls outside that interval, so run-to-run noise doesn't cry wolf. Every check reports the measured rate at which an unchanged behavior would trip by chance
- `watch calibrate` — re-checks an unchanged fingerprint repeatedly and reports how often it falsely flags, so the monitor's own false-alarm rate is a number you can see, not a hope
- A SessionStart nudge — silent unless a saved fingerprint predates your current Claude Code version or model, when it prints one line suggesting a re-check
- `watch check` exits non-zero when it finds drift, so it can gate a pipeline

## [0.2.0-alpha] — 2026-07-22

### Added

- A skill, so a session recognizes proof and drives `harvest` → `lint` → `run` correctly instead of the plugin sitting installed and unused

## [0.1.0-alpha] — 2026-07-22

### Added

- `proof run` — runs a config change with and without your edit, many times over on identical setups, and reports a lift, a confidence interval, and a four-way verdict (helped / hurt / no effect / not enough signal)
- Cost estimate with a confirmation prompt before any run — nothing is spent until you say yes, and a budget cap stops a run that would overrun
- `proof harvest` — mines a repo's own past fixes from git history into candidate tasks, so a measurement rests on real failures instead of invented ones
- `proof lint` — a blocking check that refuses a task set too flimsy to produce directional evidence
- Every non-positive verdict is diagnosed into a plain cause — tier saturation, below the detection floor, or genuinely inert — each with the next step to take, so a correct "no effect" isn't mistaken for a broken tool
- A representativeness note on every report, stating which tasks the verdict covers and that it is directional, not general
- Tier-aware defaults: rule-wording questions default to the model where a wording effect is detectable; the choice is made for you and explained
