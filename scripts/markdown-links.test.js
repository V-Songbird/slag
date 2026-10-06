'use strict';

// Fails on a relative link or in-page anchor in a tracked public Markdown file whose target is
// not a tracked file or directory, or whose #anchor names no heading or <a> id or name in the
// target. Heading anchors use GitHub's slugs, numbered past slugs already used and matched without
// case; <a> id and name anchors match with case. Links inside code spans, fenced blocks, HTML comments
// and leading YAML frontmatter are not links. Files under the private directories are skipped at
// any depth.
// Known limits: a link target containing ')' is cut at it; HTML entities in headings are slugged
// without decoding; headings inside blockquotes or list items get no anchor; relative href and
// src targets in raw HTML are not checked; indented code blocks and backslash-escaped brackets
// are read as prose.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const harness = import('../collet/tests/temp-project.js');
const PRIVATE = /(^|\/)(\.private|docs\/tasks|docs\/decisions|docs\/knowledge\/private|docs\/apis\/private)\//;

function trackedFiles(dir) {
  const listed = spawnSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split('\0').filter(Boolean);
}

// The file's lines with frontmatter, fenced blocks and HTML comments blanked, and code spans
// removed unless keepCode is set.
function proseLines(text, keepCode = false) {
  let fence = null;
  let comment = false;
  const lines = text
    .replace(/^---\r?\n[\s\S]*?\n---[ \t]*(?=\r?\n|$)/, (c) => c.replace(/[^\n]/g, ''))
    .split(/\r?\n/);
  return lines.map((line) => {
    if (comment) {
      const end = line.indexOf('-->');
      if (end < 0) return '';
      comment = false;
      line = line.slice(end + 3);
    }
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.trim().slice(marker[1].length).trim()) fence = null;
      return '';
    }
    if (marker) {
      fence = marker[1];
      return '';
    }
    // A code span is kept or removed; a comment is blanked, and one left open continues below.
    return line.replace(/(`+)[\s\S]*?\1(?!`)|<!--[\s\S]*?(-->|$)/g, (match, ticks, closed) => {
      if (ticks) return keepCode ? match : '';
      if (!closed) comment = true;
      return '';
    });
  });
}

// Heading text as rendered: code span text stays as written, links keep their label, tags go, and
// underscore emphasis at word boundaries (not after a backslash) loses its markers.
function rendered(text) {
  return text.replace(
    /(`+)(.*?)\1(?!`)|!?\[([^\]]*)\]\([^)]*\)|<[^>]+>|(^|[^\p{L}\p{N}_\\])(_+)(?=\S)(.*?\S)\5(?![\p{L}\p{N}_])/gu,
    (m, ticks, code, label, before, marks, inner) => (ticks ? code : label !== undefined ? rendered(label) : before !== undefined ? before + rendered(inner) : ''),
  );
}

function slug(heading) {
  return rendered(heading).trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

const ATX = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/;

// Heading slugs, numbered as GitHub does, and the HTML id and name anchors of a file.
function anchors(text) {
  const headings = new Map();
  const ids = new Set();
  const prose = proseLines(text);
  const lines = proseLines(text, true);
  lines.forEach((line, index) => {
    const atx = line.match(ATX);
    const before = index > 0 ? lines[index - 1] : '';
    const setext = !atx && before.trim() && !ATX.test(before) && /^ {0,3}(=+|-+)\s*$/.test(line) && !/^\s*([-*+]|\d+[.)])\s/.test(before);
    const heading = atx ? atx[1] : setext ? before.trim() : null;
    if (heading !== null) {
      const base = slug(heading);
      let anchor = base;
      while (headings.has(anchor)) {
        headings.set(base, headings.get(base) + 1);
        anchor = `${base}-${headings.get(base)}`;
      }
      headings.set(anchor, 0);
    }
    for (const match of prose[index].matchAll(/<a\s[^>]*\b(?:name|id)=["']([^"']+)["']/gi)) ids.add(match[1]);
  });
  return { headings, ids };
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
    if (!file.endsWith('.md') || PRIVATE.test(file)) continue;
    proseLines(read(file)).forEach((line, index) => {
      const links = [
        ...[...line.matchAll(/\]\(\s*(<[^>]*>|[^\s)]+)/g)].map((m) => m[1]),
        ...[...line.matchAll(/^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>]*>|\S+)/g)].map((m) => m[1]),
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
        else if (anchor && resolved.endsWith('.md') && files.has(resolved)) {
          const { headings, ids } = anchorsOf(resolved);
          const name = decode(anchor);
          if (!headings.has(name.toLowerCase()) && !ids.has(name)) broken.push(`${where} (no heading)`);
        }
      }
    });
  }
  return broken;
}

test('relative links and anchors in tracked public Markdown resolve', () => {
  assert.deepEqual(findBrokenLinks(root), []);
});

test('reports a missing file, a missing heading and an untracked target, skipping private notes', async () => {
  const { project, git } = await harness;
  const privateNotes = ['.private', 'docs/tasks', 'docs/decisions', 'docs/knowledge/private', 'docs/apis/private'].flatMap((folder) => [`${folder}/kept.md`, `collet/${folder}/kept.md`]);
  const fixture = project({
    '.gitignore': 'docs/tasks/note.md\n',
    'README.md': [
      '# Guide',
      '',
      'See [docs](docs/), [usage](docs/usage.md#run-it-now), [top](#guide) and [ref][r].',
      'Also [gone](docs/missing.md), [bad anchor](docs/usage.md#nowhere) and [note](docs/tasks/note.md).',
      'Here [self](#not-here), `[code](missing-span.md)` and <https://example.com>.',
      'Spans [plugin](docs/usage.md#plugin-folder), [span](docs/usage.md#ab-x) and [escaped](docs/usage.md#_a_-b).',
      'Then [code](docs/usage.md#use-npm-run-check), [html](docs/usage.md#Foo), [stub](docs/usage.md#use-) and [front](docs/usage.md#title-front).',
      'Next [note](docs/usage.md#note-on-snake_case), [marks](docs/usage.md#_note_-on-snake_case), [lower](docs/usage.md#foo) and [third](docs/usage.md#a-1-1).',
      'After [head](docs/usage.md#head), [underline](docs/usage.md#-head) and a span `<!--` before [after](missing-after-span.md).',
      '',
      '<!-- [hidden](missing-comment.md) -->',
      '<!--',
      '[hidden](missing-comment.md)',
      '```',
      '-->',
      '[shown](missing-after-comment.md)',
      '```text',
      '[fenced](missing-fence.md) and ](?:[^"]+)',
      '```',
      '',
      '[r]: docs/usage.md#second',
      '[web](https://example.com/missing.md) and [mail](mailto:a@example.com)',
      '[^1]: See the notes',
    ].join('\n'),
    'docs/usage.md': [
      '---\ntitle: Front\n---\n## Run it, now!\n\nSecond\n------\n\n## Use `npm run check`\n',
      '## _Note_ on snake_case\n\n## A\n\n## A\n\n## A-1\n\n## `<plugin>` folder\n\n## `[a](b)` x\n\n## \\_a\\_ b\n\n## Head\n---\n\n<a id="Foo"></a>\n',
    ].join('\n'),
    'docs/tasks/note.md': '[private](missing-private.md)\n',
    ...Object.fromEntries(privateNotes.map((note) => [note, '[private](missing-private.md)\n'])),
  });
  git(fixture, ['init', '-q']);
  git(fixture, ['add', '-A']);
  const tracked = trackedFiles(fixture);
  assert.deepEqual(privateNotes.filter((note) => !tracked.includes(note)), []);
  assert.deepEqual(findBrokenLinks(fixture), [
    'README.md:4: docs/missing.md (no tracked target)',
    'README.md:4: docs/usage.md#nowhere (no heading)',
    'README.md:4: docs/tasks/note.md (no tracked target)',
    'README.md:5: #not-here (no heading)',
    'README.md:7: docs/usage.md#use- (no heading)',
    'README.md:7: docs/usage.md#title-front (no heading)',
    'README.md:8: docs/usage.md#_note_-on-snake_case (no heading)',
    'README.md:8: docs/usage.md#foo (no heading)',
    'README.md:9: docs/usage.md#-head (no heading)',
    'README.md:9: missing-after-span.md (no tracked target)',
    'README.md:16: missing-after-comment.md (no tracked target)',
  ]);
});
