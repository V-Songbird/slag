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
//   - a suite that fails outside its tests counts as red and is named, through
//     the suite-failure reporter that npm run check also uses

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK_PATH = path.join(__dirname, 'run-tests-on-edit.js');
const { findPluginRoot, runTests, editedPaths, repoRoot } = require('./run-tests-on-edit');

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
  fs.mkdirSync(path.join(root, '.git'));
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

  test('reports a suite that fails outside its tests, which plain node --test exits 0 on', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      for (const fixture of ['suite-throws', 'after-hook-throws']) {
        fs.copyFileSync(path.join(__dirname, '..', 'fixtures', `${fixture}.js`), path.join(pluginRoot, 'tests', `${fixture}.test.js`));
      }
      const payload = { tool_name: 'Edit', tool_input: { file_path: path.join(pluginRoot, 'scripts', 'x.js') } };
      const result = runHook(payload, { CLAUDE_PROJECT_DIR: root });
      assert.equal(result.status, 0, result.stderr);
      const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
      assert.match(context, /demo-plugin\/ failed after this edit to x\.js/);
      assert.match(context, /Suite failed outside its tests: "a suite that throws while defining its tests"/);
      assert.match(context, /Suite failed outside its tests: "a suite whose after hook throws"/);
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

describe('patch events', () => {
  test('extracts all operation paths without reading diff contents', () => {
    const cwd = path.resolve('nested');
    const paths = editedPaths({ tool_name: 'apply_patch', cwd, tool_input: { command: [
      '*** Begin Patch',
      '*** Add File: ../demo-plugin/scripts/new file.js',
      '+*** Delete File: ignored.js',
      '*** Update File: ../demo-plugin/scripts/old.js',
      '*** Move to: ../demo-plugin/templates/new.mjs',
      '*** Delete File: ../demo-plugin/hooks/gone.js',
      '*** End Patch',
    ].join('\r\n') } });
    assert.deepEqual(paths, [
      '../demo-plugin/scripts/new file.js', '../demo-plugin/scripts/old.js',
      '../demo-plugin/templates/new.mjs', '../demo-plugin/hooks/gone.js',
    ].map(file => path.resolve(cwd, file)));
    assert.deepEqual(editedPaths({ tool_name: 'apply_patch', tool_input: { command: null } }), []);
  });

  test('finds the root from a nested cwd and a worktree pointer', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      fs.rmdirSync(path.join(root, '.git'));
      fs.writeFileSync(path.join(root, '.git'), 'gitdir: unused');
      assert.equal(repoRoot({ tool_name: 'apply_patch', cwd: path.join(pluginRoot, 'scripts') }), root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('runs both sides of a cross-plugin move once and combines failures', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      const second = path.join(root, 'other-plugin');
      fs.mkdirSync(path.join(second, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(second, '.claude-plugin', 'plugin.json'), '{}');
      fs.mkdirSync(path.join(second, 'tests'));
      for (const dir of [pluginRoot, second]) {
        fs.writeFileSync(path.join(dir, 'tests', 'broken.test.js'),
          "const fs = require('fs'); require('node:test')('fails', () => { fs.appendFileSync('runs.txt', 'run\\n'); throw new Error('intentional'); });");
      }
      const cwd = path.join(pluginRoot, 'scripts');
      const result = runHook({ tool_name: 'apply_patch', cwd, tool_input: { command: [
        '*** Begin Patch',
        '*** Update File: old.js',
        '*** Move to: ../../other-plugin/templates/moved.mjs',
        '*** Add File: another.js',
        '*** Delete File: gone.js',
        '*** End Patch',
      ].join('\n') } }, { CLAUDE_PROJECT_DIR: path.join(root, 'wrong-root') });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout).hookSpecificOutput;
      assert.equal(output.hookEventName, 'PostToolUse');
      assert.match(output.additionalContext, /demo-plugin\/ failed/);
      assert.match(output.additionalContext, /other-plugin\/ failed/);
      for (const dir of [pluginRoot, second]) {
        assert.equal(fs.readFileSync(path.join(dir, 'runs.txt'), 'utf8'), 'run\n');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('stays silent on green and ignores unwatched or outside paths', () => {
    const { root, pluginRoot } = makeFakeRepo();
    try {
      const marker = path.join(pluginRoot, 'runs.txt');
      fs.writeFileSync(path.join(pluginRoot, 'tests', 'ok.test.js'),
        "require('node:test')('passes', () => require('fs').appendFileSync('runs.txt', 'run\\n'));");
      const invoke = (file) => runHook({ tool_name: 'apply_patch', cwd: root,
        tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n*** End Patch` } });
      for (const file of ['demo-plugin/tests/ok.test.js', 'demo-plugin/scripts/notes.md', '../outside/scripts/x.js']) {
        assert.equal(invoke(file).stdout, '');
      }
      assert.equal(fs.existsSync(marker), false);
      const result = invoke(path.join(pluginRoot, 'scripts', 'absolute.js'));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(fs.readFileSync(marker, 'utf8'), 'run\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports an exhausted shared timeout without launching another suite', () => {
    const result = runTests(__dirname, 0);
    assert.equal(result.passed, false);
    assert.match(result.output, /budget exhausted/);
  });

  test('registered command runs from a repository subdirectory', () => {
    const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../.codex/hooks.json'), 'utf8'));
    const group = config.hooks.PostToolUse[0];
    assert.equal(new RegExp(group.matcher).test('apply_patch'), true);
    const command = group.hooks[0];
    assert.equal(command.timeout, 120);
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-Command', command.command] : ['-c', command.command];
    const result = spawnSync(shell, args, {
      cwd: __dirname, input: '{}', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  });
});
