// The optional bundle must earn its refusals through the original fixture pairs, survive a
// remount without replacing project decisions, and reject bad input before changing the project.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { checks, clean, CONFIG, hook, hookOutput, mount, PLUGIN, project, task } from './temp-project.js';

const catalogue = JSON.parse(readFileSync(join(PLUGIN, 'catalogue', 'javascript-typescript.json'), 'utf8'));
const marker = { 'package.json': '{"private":true}\n' };
const checkId = `${catalogue.id}.${catalogue.classes[0].id}`;
const triplet = [`${checkId}.mjs`, `${checkId}.violation.json`, `${checkId}.nearmiss.json`];

function temporary(t, files = marker) {
  const root = project(files);
  t.after(() => clean(root));
  return root;
}

function mounted(t, files = marker) {
  const root = temporary(t, files);
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  return root;
}

function snapshot(root) {
  const files = {};
  function visit(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), rel + '/');
      else files[rel] = readFileSync(join(dir, entry.name));
    }
  }
  visit(root);
  return files;
}

test('the default mount keeps the catalogue opt-in even when a language marker is present', (t) => {
  const root = temporary(t);
  const out = mount(root);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(existsSync(join(root, '.collet', 'source.mjs')), false);
  assert.equal(readdirSync(join(root, '.collet', 'checks')).some((name) => name.startsWith(`${catalogue.id}.`)), false);
  assert.equal(checks(root).status, 0);
});

test('a detected bundle proves each original pair and the host guard applies it', async (t) => {
  const root = mounted(t);
  writeFileSync(join(root, '.collet', 'config.json'), CONFIG, 'utf8');
  const opened = task(root, ['add', '--title', 'Preserve the checks', '--why', 'Exercise the guard', '--scope', '**']);
  assert.equal(opened.status, 0, opened.stderr);
  const proof = checks(root);
  assert.equal(proof.status, 0, proof.stdout + proof.stderr);

  for (const item of catalogue.classes) {
    await t.test(item.id, () => {
      const id = `${catalogue.id}.${item.id}`;
      const pairs = 1 + (item.fixtures.additional?.length ?? 0);
      assert.ok(proof.stdout.includes(`ok   ${id} — ${pairs} violation(s) caught, ${pairs} near miss(es) left alone`), proof.stdout);
      for (const [half, original, deny] of [
        ['violation', item.fixtures.violation, true],
        ['nearmiss', item.fixtures.nearMiss, false],
      ]) {
        const fixture = JSON.parse(readFileSync(join(root, '.collet', 'checks', `${id}.${half}.json`), 'utf8'));
        assert.equal(fixture.call.input.content, original, `${id} changed its original ${half}`);
        const out = hook('guard.js', root, {
          tool_name: fixture.call.tool,
          tool_input: fixture.call.input,
        });
        assert.equal(out.status, 0, out.stderr);
        if (deny) {
          const response = hookOutput(out);
          assert.equal(response?.permissionDecision, 'deny', out.stdout);
          assert.ok(response.permissionDecisionReason.includes(id), response.permissionDecisionReason);
          assert.ok(response.permissionDecisionReason.includes(fixture.call.input.file_path), response.permissionDecisionReason);
          assert.doesNotMatch(response.permissionDecisionReason, /widen --add/);
          assert.equal(response.permissionDecisionReason.includes(root), false);
        } else {
          assert.equal(out.stdout, '', `${id} refused its near miss: ${out.stdout}`);
        }
      }
    });
  }
});

test('an explicit edition reaches a nested JavaScript project inside a polyglot root', (t) => {
  const files = {
    'services/web/package.json': '{"private":true}\n',
    'pyproject.toml': '[project]\nname = "service"\n',
    'go.mod': 'module service\n',
  };
  const root = temporary(t, files);
  const out = mount(root, ['--checks', '--edition', 'javascript-typescript']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(checks(root).status, 0);
  assert.equal(existsSync(join(root, '.collet', 'checks', 'javascript-typescript.skipped-test.mjs')), true);
  for (const [path, content] of Object.entries(files)) assert.equal(readFileSync(join(root, path), 'utf8'), content);
});

test('invalid catalogue requests fail before changing the project', async (t) => {
  for (const [name, args, files, message] of [
    ['unsupported edition', ['--checks', '--edition', 'not-supported'], marker, /Unknown check edition/],
    ['missing edition', ['--checks', '--edition'], marker, /--edition needs a language id/],
    ['a flag instead of an edition', ['--edition', '--checks'], marker, /--edition needs a language id/],
    ['edition without opt-in', ['--edition', 'javascript-typescript'], marker, /--edition needs a language id and --checks/],
    ['missing accept command', ['--checks', '--accept'], marker, /--accept needs a command/],
    ['unknown option', ['--checks', '--editions', 'python'], marker, /Unknown mount option/],
    ['no supported root marker', ['--checks'], { 'nested/package.json': '{}\n' }, /No supported language marker/],
  ]) {
    await t.test(name, (sub) => {
      const root = temporary(sub, { ...files, 'AGENTS.md': '# Existing project instructions\n' });
      const before = snapshot(root);
      const out = mount(root, args);
      assert.equal(out.status, 2, out.stdout + out.stderr);
      assert.match(out.stderr, message);
      assert.deepEqual(snapshot(root), before);
      assert.equal(existsSync(join(root, '.collet')), false);
    });
  }
});

test('requesting checks does not cross the foreign-roadmap boundary', (t) => {
  const root = temporary(t, {
    ...marker,
    'ROADMAP.jsonl': '{"id":"002","status":"in_progress","planned_touches":["src/"]}\n',
    'AGENTS.md': '# Existing instructions\n',
    '.collet/checks/owned.mjs': '// Existing project file\n',
  });
  const before = snapshot(root);
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /roadmap collet does not own/);
  assert.deepEqual(snapshot(root), before);
});

test('remount preserves customized shared source, check and fixture bytes', (t) => {
  const root = mounted(t);
  const paths = ['.collet/source.mjs', ...triplet.map((name) => `.collet/checks/${name}`)];
  const expected = new Map();
  for (const rel of paths) {
    const path = join(root, rel);
    const original = readFileSync(path, 'utf8');
    const customized = rel.endsWith('.mjs')
      ? `// Project customization kept by remount.\n${original}`
      : JSON.stringify({ ...JSON.parse(original), what: 'Project-owned example', projectNote: 'Keep this wording.' }, null, 4) + '\n';
    writeFileSync(path, customized, 'utf8');
    expected.set(path, readFileSync(path));
  }
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /existing check or fixture; set preserved/);
  for (const [path, bytes] of expected) assert.deepEqual(readFileSync(path), bytes, path);
});

test('an incomplete check or orphaned fixture refuses remount before changing any files', async (t) => {
  for (const [name, removed] of [
    ['check missing its near miss', [triplet[2]]],
    ['orphaned violation fixture', [triplet[0], triplet[2]]],
  ]) {
    await t.test(name, (sub) => {
      const root = mounted(sub);
      const dir = join(root, '.collet', 'checks');
      for (const file of removed) rmSync(join(dir, file));
      const before = snapshot(root);
      const out = mount(root, ['--checks']);
      assert.equal(out.status, 2, out.stdout + out.stderr);
      assert.match(out.stderr, /incomplete check\/example set/);
      assert.deepEqual(snapshot(root), before);
      for (const file of removed) assert.equal(existsSync(join(dir, file)), false);
    });
  }
});

test('a valid earlier check revision remains usable when the catalogue gains more examples', (t) => {
  const root = mounted(t);
  const dir = join(root, '.collet/checks');
  const saved = new Map();
  for (const item of catalogue.classes.filter((entry) => ['focused-test', 'skipped-test'].includes(entry.id))) {
    const id = `${catalogue.id}.${item.id}`;
    for (const example of item.fixtures.additional ?? []) {
      rmSync(join(dir, `${id}.violation-${example.id}.json`));
      rmSync(join(dir, `${id}.nearmiss-${example.id}.json`));
    }
    for (const suffix of ['.mjs', '.violation.json', '.nearmiss.json']) {
      saved.set(id + suffix, readFileSync(join(dir, id + suffix)));
    }
  }
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  for (const [name, bytes] of saved) assert.deepEqual(readFileSync(join(dir, name)), bytes);
  assert.equal(readdirSync(dir).some((name) => name.includes('native-options')), false);
  assert.equal(checks(root).status, 0);
});

test('a project may rename fixture suffixes without making its admitted check incomplete', (t) => {
  const root = mounted(t);
  const dir = join(root, '.collet/checks');
  renameSync(join(dir, triplet[1]), join(dir, `${checkId}.violation-project.json`));
  renameSync(join(dir, triplet[2]), join(dir, `${checkId}.nearmiss-project.json`));
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(existsSync(join(dir, triplet[1])), false);
  assert.equal(existsSync(join(dir, triplet[2])), false);
  assert.equal(checks(root).status, 0);
});

test('a preserved runtime must prove the original pairs before any mount writes', (t) => {
  const root = temporary(t, {
    ...marker,
    'AGENTS.md': '# Existing instructions\n',
    '.collet/source.mjs': [
      'export function checkSource() { return { fires: false, reason: "Project runtime misses the violation" }; }',
      'export function liveSource() { return { fires: false }; }',
      '',
    ].join('\n'),
  });
  const before = snapshot(root);
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /failed its violation example/);
  assert.match(out.stderr, /No catalogue checks were written/);
  assert.deepEqual(snapshot(root), before);
  assert.equal(existsSync(join(root, '.collet', 'checks')), false);
});

test('a failing preserved check is reported without replacing its implementation or examples', (t) => {
  const root = mounted(t);
  const dir = join(root, '.collet', 'checks');
  writeFileSync(join(dir, triplet[0]), [
    `export const id = ${JSON.stringify(checkId)};`,
    'export function check() { return { fires: false, reason: "Project check misses the violation" }; }',
    '',
  ].join('\n'), 'utf8');
  const before = new Map(triplet.map((name) => [name, readFileSync(join(dir, name))]));
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.ok(out.stdout.includes(`FAIL ${checkId}`), out.stdout);
  assert.match(out.stdout, /did not fire/);
  assert.match(out.stderr, /Mounted check verification failed/);
  for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(dir, name)), bytes);
});
