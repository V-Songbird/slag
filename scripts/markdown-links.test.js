'use strict';

// Fails on a relative link or in-page anchor in a tracked public Markdown file whose target is
// not a tracked file or directory, or whose #anchor names no heading in the target. Anchors use
// GitHub's heading slugs. Links inside code spans, fenced blocks and HTML comments are not links.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const harness = import('../collet/tests/temp-project.js');
const PRIVATE = ['.private/', 'docs/tasks/', 'docs/decisions/', 'docs/knowledge/private/', 'docs/apis/private/'];

function trackedFiles(dir) {
  const listed = spawnSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split('\0').filter(Boolean);
}

// The file's lines with fenced blocks blanked, and code spans and HTML comments removed.
function proseLines(text) {
  let fence = null;
  const lines = text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, '')).split(/\r?\n/);
  return lines.map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.trim().slice(marker[1].length).trim()) fence = null;
      return '';
    }
    if (marker) {
      fence = marker[1];
      return '';
    }
    return line.replace(/(`+)[\s\S]*?\1(?!`)/g, '');
  });
}

function slug(heading) {
  const text = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*`]/g, '')
    .trim()
    .toLowerCase();
  return text.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

function anchors(text) {
  const found = new Set();
  const counts = new Map();
  const lines = proseLines(text);
  lines.forEach((line, index) => {
    const atx = line.match(/^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/);
    const setext = !atx && index > 0 && lines[index - 1].trim() && /^ {0,3}(=+|-+)\s*$/.test(line) && !/^\s*([-*+]|\d+[.)])\s/.test(lines[index - 1]);
    const heading = atx ? atx[1] : setext ? lines[index - 1].trim() : null;
    if (heading !== null) {
      const base = slug(heading);
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      found.add(seen ? `${base}-${seen}` : base);
    }
    for (const match of line.matchAll(/<a\s[^>]*\b(?:name|id)=["']([^"']+)["']/gi)) found.add(match[1]);
  });
  return found;
}

function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function findBrokenLinks(dir) {
  const tracked = trackedFiles(dir);
  const files = new Set(tracked);
  const dirs = new Set(tracked.flatMap((file) => file.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  const read = (file) => readFileSync(path.join(dir, file), 'utf8');
  const cache = new Map();
  const anchorsOf = (file) => cache.get(file) ?? cache.set(file, anchors(read(file))).get(file);
  const broken = [];
  for (const file of tracked) {
    if (!file.endsWith('.md') || PRIVATE.some((prefix) => file.startsWith(prefix))) continue;
    proseLines(read(file)).forEach((line, index) => {
      const links = [
        ...[...line.matchAll(/\]\(\s*(<[^>]*>|[^\s)]+)/g)].map((m) => m[1]),
        ...[...line.matchAll(/^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/g)].map((m) => m[1]),
      ];
      for (const raw of links) {
        const link = raw.replace(/^<|>$/g, '');
        if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(link)) continue; // URL or another scheme
        const [target, anchor] = link.split('?')[0].split('#');
        let resolved = file;
        if (target) {
          const decoded = decode(target);
          resolved = path.posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(path.posix.dirname(file), decoded)).replace(/\/$/, '');
        }
        const where = `${file}:${index + 1}: ${link}`;
        if (!files.has(resolved) && !dirs.has(resolved) && resolved !== '.') broken.push(`${where} (no tracked target)`);
        else if (anchor && resolved.endsWith('.md') && files.has(resolved) && !anchorsOf(resolved).has(decode(anchor).toLowerCase())) broken.push(`${where} (no heading)`);
      }
    });
  }
  return broken;
}

test('relative links and anchors in tracked public Markdown resolve', () => {
  assert.deepEqual(findBrokenLinks(root), []);
});

test('reports a missing file, a missing heading and an untracked target', async () => {
  const { project, git } = await harness;
  const fixture = project({
    '.gitignore': 'docs/tasks/\n',
    'README.md': [
      '# Guide',
      '',
      'See [docs](docs/), [usage](docs/usage.md#run-it-now), [top](#guide) and [ref][r].',
      'Also [gone](docs/missing.md), [bad anchor](docs/usage.md#nowhere) and [note](docs/tasks/note.md).',
      'Here [self](#not-here), `[code](missing-span.md)` and <https://example.com>.',
      '',
      '<!-- [hidden](missing-comment.md) -->',
      '```text',
      '[fenced](missing-fence.md) and ](?:[^"]+)',
      '```',
      '',
      '[r]: docs/usage.md#second',
      '[web](https://example.com/missing.md) and [mail](mailto:a@example.com)',
    ].join('\n'),
    'docs/usage.md': '## Run it, now!\n\nSecond\n------\n',
    'docs/tasks/note.md': '[private](missing-private.md)\n',
  });
  git(fixture, ['init', '-q']);
  git(fixture, ['add', '-A']);
  assert.deepEqual(findBrokenLinks(fixture), [
    'README.md:4: docs/missing.md (no tracked target)',
    'README.md:4: docs/usage.md#nowhere (no heading)',
    'README.md:4: docs/tasks/note.md (no tracked target)',
    'README.md:5: #not-here (no heading)',
  ]);
});
