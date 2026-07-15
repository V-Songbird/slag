---
name: verity-freshness-check
description: >-
  Developer tool for the verity plugin. Checks whether verity's bundled doc
  index (lastmod-snapshot.json) is current by fetching the live Claude Code
  docs sitemap and diffing lastmod timestamps. Reports pages added, removed,
  or updated since the snapshot was last taken, then offers to update the
  snapshot. Trigger when working on the verity plugin and you want to know if
  the index has drifted ("are the verity docs stale?", "check verity
  freshness", "update verity snapshot", "refresh the doc index"), before
  cutting a new verity release, or after a Claude Code update.
allowed-tools: Bash, Read, Write
---

# verity-freshness-check

Developer maintenance tool: compare verity's doc index against the live Claude Code docs sitemap and report any drift.

## Step 1 — run the diff script

```bash
python ".claude/skills/verity-freshness-check/scripts/freshness_check.py" "verity/references/lastmod-snapshot.json"
```

The script fetches `https://code.claude.com/docs/sitemap.xml`, extracts all English-locale slugs and their `lastmod` timestamps, and compares them against the snapshot. It prints a JSON object with these keys: `added`, `removed`, `updated`, `unchanged_count`, `live_slug_count`, `snapshot_slug_count`.

**If the script fails** (Python unavailable, network error), fall back manually:
1. `WebFetch https://code.claude.com/docs/sitemap.xml` — extract `en/` slugs and lastmod values from the response
2. `Read verity/references/lastmod-snapshot.json` — load the snapshot
3. Compute the diff yourself

## Step 2 — present the report

```
## Verity freshness check — {today's date}

Snapshot date: {_meta.snapshot_date}
Live slugs: {live_slug_count}  |  Snapshot slugs: {snapshot_slug_count}

### New pages ({count})
- en/new-slug (lastmod: 2026-07-01T...)

### Removed pages ({count})
- en/old-slug (was: 2026-05-01T...)

### Updated pages ({count})
- en/hooks: 2026-06-26T... → 2026-07-02T...

### Unchanged: {unchanged_count} pages
```

If all three diff sections are empty: "Index is current — no changes detected since {snapshot_date}."

## Step 3 — offer to update

Ask:

> Update `verity/references/lastmod-snapshot.json` with these changes? (yes / no)

If yes:
1. `Read verity/references/lastmod-snapshot.json`
2. Apply the diff to the `slugs` object: add new slugs, delete removed ones, update changed timestamps
3. Set `_meta.snapshot_date` to today (YYYY-MM-DD) and `_meta.slug_count` to the new total
4. `Write` the file back
5. Confirm: "Updated. Snapshot now covers {new_count} slugs as of {today}."

If no, leave the file unchanged.
