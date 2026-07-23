# Changelog

## Unreleased

- First cut. Watches the running context size and, once it crosses the threshold, surfaces a one-time suggestion to run `/compact` with a ready-made instruction — tailored to the task and the files you're actually working in.
- Stays quiet until the window drops well below the line again, so a long session gets at most one nudge per fill-up.
- One setting to move the threshold, one to turn it off.
