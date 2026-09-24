'use strict';

// Fails on raw invisible characters in the repository's text files. Write them as escapes
// (\u200B, \u{E0041}) instead. The pattern and its emoji exceptions are anneal's audit's own.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HIDDEN_CHARACTERS } = require('../anneal/scripts/audit.js');

const root = path.resolve(__dirname, '..');
const harness = import('../collet/tests/temp-project.js');

// Tracked files in a Git work tree; every file but .git/ and node_modules/ in an exported tree.
function listFiles(dir) {
  const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status === 0 && path.resolve(top.stdout.trim()).toLowerCase() === path.resolve(dir).toLowerCase()) {
    const listed = spawnSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    return listed.stdout.split('\0').filter(Boolean);
  }
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((file) => !file.split('/').some((part) => part === '.git' || part === 'node_modules'));
}

function findHiddenCharacters(dir) {
  const found = [];
  for (const file of listFiles(dir)) {
    let buffer;
    try {
      buffer = readFileSync(path.join(dir, file));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') continue; // deleted or a submodule
      throw error;
    }
    if (buffer.includes(0)) continue; // binary
    buffer.toString('utf8').split('\n').forEach((line, index) => {
      for (const match of line.matchAll(HIDDEN_CHARACTERS)) {
        if (index === 0 && match.index === 0 && match[0] === '\uFEFF') continue;
        const code = match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
        found.push(`${file}:${index + 1}: U+${code}`);
      }
    });
  }
  return found;
}

test('tracked text files hold no raw invisible characters', () => {
  assert.deepEqual(findHiddenCharacters(root), []);
});

const fixtureFiles = {
  'zero-width.md': 'first line\nbad\u200Bword\n',
  'tag.txt': 'plain \u{E0041} tag\n',
  'allowed.md': '\uFEFFfamily \u{1F468}\u200D\u{1F469}\u200D\u{1F467} and \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}\n',
  'binary.bin': Buffer.from([0, 0xe2, 0x80, 0x8b]),
};
const expected = ['tag.txt:1: U+E0041', 'zero-width.md:2: U+200B'];

test('flags raw characters in a Git work tree and allows emoji joiners and subdivision flags', async () => {
  const { project } = await harness;
  const fixture = project(fixtureFiles);
  for (const args of [['init', '-q'], ['add', '-A']]) {
    const result = spawnSync('git', ['-C', fixture, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(findHiddenCharacters(fixture).sort(), expected);
});

test('walks an exported tree without Git, skipping node_modules', async () => {
  const { project } = await harness;
  const fixture = project({ ...fixtureFiles, 'node_modules/dep/index.js': 'x\u200By\n' });
  assert.deepEqual(findHiddenCharacters(fixture).sort(), expected);
});
