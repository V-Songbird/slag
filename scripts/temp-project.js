'use strict';

// Scaffolding for the repository tests that need a throwaway project: a temp directory
// holding the given files, a Git helper and a one-commit repository. Every directory
// is removed when the test process exits. The name keeps this file out of test discovery.
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const roots = new Set();
process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A temp directory with the given files written into it. */
function project(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'slag-test-'));
  roots.add(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  return root;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Turns the directory into a Git repository with every file committed. */
function repo(root) {
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: root,
    stdio: 'ignore',
  });
}

module.exports = { project, git, repo };
