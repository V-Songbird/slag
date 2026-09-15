# Changelog

All notable changes to anneal are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); alpha releases may introduce breaking changes in minor versions.

## [0.1.0-alpha] — 2026-09-15

### Added

- First cut. `/anneal:anneal audit` reports what makes an AI agent search, read or guess more than it needs to in your repository — no map file, no declared toolchain version, duplicate or generic file names, oversized files, build output in search results, names built at runtime — and changes nothing.
- `/anneal:anneal` goes further: it runs your project's checks first, proposes a layout for you to approve, and migrates one step at a time on its own branch, committing a step only when the checks still match.
