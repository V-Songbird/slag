"""
Verity freshness check — compare live sitemap against lastmod-snapshot.json.

Usage:
    python freshness_check.py <path-to-lastmod-snapshot.json>

Output: JSON with keys: added, removed, updated, unchanged_count,
        live_slug_count, snapshot_slug_count
"""

import json
import sys
import urllib.request
import xml.etree.ElementTree as ET


def run(snapshot_path: str) -> dict:
    with open(snapshot_path) as f:
        snapshot = json.load(f)

    current = snapshot.get("slugs", {})

    url = "https://code.claude.com/docs/sitemap.xml"
    req = urllib.request.Request(url, headers={"User-Agent": "verity-freshness-check/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        xml_bytes = resp.read()

    root = ET.fromstring(xml_bytes)
    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}

    live: dict[str, str | None] = {}
    for url_elem in root.findall("sm:url", ns):
        loc_elem = url_elem.find("sm:loc", ns)
        lastmod_elem = url_elem.find("sm:lastmod", ns)
        if loc_elem is None:
            continue
        loc = loc_elem.text or ""
        if "/docs/en/" not in loc:
            continue
        slug = loc.replace("https://code.claude.com/docs/", "")
        live[slug] = lastmod_elem.text if lastmod_elem is not None else None

    added = {s: live[s] for s in live if s not in current}
    removed = {s: current[s] for s in current if s not in live}
    updated = {
        s: {"old": current[s], "new": live[s]}
        for s in current
        if s in live and live[s] != current[s] and current[s] is not None
    }
    unchanged_count = sum(
        1 for s in current if s in live and live[s] == current[s]
    )

    return {
        "added": added,
        "removed": removed,
        "updated": updated,
        "unchanged_count": unchanged_count,
        "live_slug_count": len(live),
        "snapshot_slug_count": len(current),
    }


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "verity/references/lastmod-snapshot.json"
    print(json.dumps(run(path), indent=2))
