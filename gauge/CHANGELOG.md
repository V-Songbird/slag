# Changelog

## Unreleased

- First cut. One audit command (`/gauge:audit`) that measures the project's real per-session context cost and produces a prioritized fix list.
- A session-start check that stays silent while things are healthy and speaks one line when the budget is blown or a skill is broken.
- A guard that blocks writes which would silently stop a skill from triggering.
