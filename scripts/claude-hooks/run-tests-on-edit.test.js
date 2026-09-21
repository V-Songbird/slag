'use strict';

// Tests for scripts/claude-hooks/run-tests-on-edit.js -- repo-wide dev hook (not
// shipped with any plugin) that reruns whichever plugin's own test suite
// after an Edit/Write lands in that plugin's scripts/, hooks/ or templates/.
//
// Covers:
//   - findPluginRoot only matches <plugin>/<watched>/... when that plugin
//     folder has a .claude-plugin/plugin.json marker
//   - case-insensitive on the watched segment, takes .js and .mjs, ignores
//     every other extension, ignores files outside the watched dirs, ignores
//     files outside the repo
//   - end-to-end: reruns the owning plugin's tests, silent on green,
//     surfaces failure via additionalContext on red

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK_PATH = path.join(__dirname, 'run-tests-on-edit.js');
const { findPluginRoot, runTests } = require('./run-tests-on-edit');

function runHook(payload, env) {
  return spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, ...(env || {}) },
  });
}

/** Build a throwaway repo root with one fake plugin folder (marked via .claude-plugin/plugin.json). */
function makeFakeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slag-hook-'));
  const pluginRoot = path.join(root, 'demo-plugin');
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), '{"name":"demo-plugin"}', 'utf-8');
  fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'tests'), { recursive: true });
  return { root, pluginRoot };
}

describe('findPluginRoot', () => {
  test('matches a file under <plugin>/scripts/ when plugin.json marker exists', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      const found = findPluginRoot(root, path.join(pluginRoot, 'scripts', 'x.js'));
      assert.equal(found, pluginRoot);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('matches a file under <plugin>/hooks/, case-insensitively', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      const found = findPluginRoot(root, path.join(pluginRoot, 'HOOKS', 'x.js'));
      assert.equal(found, pluginRoot);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not match without a .claude-plugin/plugin.json marker', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slag-hook-'));
    try {
      const notAPlugin = path.join(root, 'not-a-plugin');
      fs.mkdirSync(path.join(notAPlugin, 'scripts'), { recursive: true });
      assert.equal(findPluginRoot(root, path.join(notAPlugin, 'scripts', 'x.js')), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('matches a file under <plugin>/templates/ -- collet mounts those', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      const found = findPluginRoot(root, path.join(pluginRoot, 'templates', 'checks', 'scope.mjs'));
      assert.equal(found, pluginRoot);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('takes .mjs as well as .js', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      assert.equal(findPluginRoot(root, path.join(pluginRoot, 'scripts', 'x.mjs')), pluginRoot);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores every other extension', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      assert.equal(findPluginRoot(root, path.join(pluginRoot, 'scripts', 'notes.md')), null);
      assert.equal(findPluginRoot(root, path.join(pluginRoot, 'templates', 'config.json')), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores files outside scripts/ and hooks/', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      assert.equal(findPluginRoot(root, path.join(pluginRoot, 'tests', 'x.test.js')), null);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing file_path is not a match', () => {
    assert.equal(findPluginRoot(process.cwd(), undefined), null);
  });
});

describe('runTests', () => {
  // The regression that mattered while node 20 was this repo's floor: passing
  // <plugin>/tests/*.test.js as an argument exits "Could not find" on node 20,
  // and the hook reads that as a suite that did not complete. Discovery has to
  // come from cwd. This test fails on node 20 the moment a glob argument
  // comes back; on 22 a glob expands, so there it only proves discovery works.
  test('discovers a suite without relying on node --test glob expansion', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      fs.writeFileSync(
        path.join(pluginRoot, 'tests', 'ok.test.js'),
        "require('node:test')('passes', () => {});"
      );
      assert.deepEqual(runTests(pluginRoot), { passed: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('main (end-to-end against a real plugin)', () => {
  test('stays silent when the owning plugin\'s tests are green', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      fs.writeFileSync(
        path.join(pluginRoot, 'tests', 'ok.test.js'),
        "require('node:test')('passes', () => {});"
      );
      const payload = { tool_name: 'Edit', tool_input: { file_path: path.join(pluginRoot, 'scripts', 'x.js') } };
      const result = runHook(payload, { CLAUDE_PROJECT_DIR: root });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports a failure via additionalContext when the owning plugin\'s tests are red', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      fs.writeFileSync(
        path.join(pluginRoot, 'tests', 'broken.test.js'),
        "const assert = require('node:assert/strict'); require('node:test')('fails', () => assert.equal(1, 2));"
      );
      const payload = { tool_name: 'Edit', tool_input: { file_path: path.join(pluginRoot, 'scripts', 'x.js') } };
      const result = runHook(payload, { CLAUDE_PROJECT_DIR: root });
      assert.equal(result.status, 0, result.stderr);
      const out = JSON.parse(result.stdout);
      assert.match(out.hookSpecificOutput.additionalContext, /demo-plugin\/ failed after this edit to x\.js/);
      assert.match(out.hookSpecificOutput.additionalContext, /# fail \d/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('non-Edit/Write tool call stays silent', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      const payload = { tool_name: 'Read', tool_input: { file_path: path.join(pluginRoot, 'scripts', 'x.js') } };
      const result = runHook(payload, { CLAUDE_PROJECT_DIR: root });
      assert.equal(result.stdout, '');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
