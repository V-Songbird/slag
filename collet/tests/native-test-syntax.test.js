import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { prepareCatalogue } from '../scripts/catalogue.mjs';
import { checkSource, liveSource } from '../templates/source.mjs';
import { git, PLUGIN, project, repo } from './temp-project.js';

const edition = JSON.parse(readFileSync(join(PLUGIN, 'catalogue/javascript-typescript.json'), 'utf8'));
const task = { id: 't1', status: 'in_progress', scope: ['**'] };
const specs = {
  only: edition.classes.find((entry) => entry.id === 'focused-test'),
  skip: edition.classes.find((entry) => entry.id === 'skipped-test'),
};
const spec = (key) => ({ ...specs[key], commentSyntax: edition.commentSyntax });
const call = (root, key, tool, input) => checkSource({
  root, task, call: { tool, input: { file_path: 'native.test.mjs', ...input } },
}, spec(key));
const write = (root, key, content) => call(root, key, 'Write', { content });
const declaration = (key, value = 'true', name = 'test') =>
  `${name}('case', { ${key}: ${value} }, () => { assert.equal(1, 1); });\n`;

function nativeRunner(root, extra = []) {
  const env = { ...process.env };
  // The fixture is a standalone runner, not another worker of this suite's runner.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...extra, 'native.test.mjs'], {
    cwd: root, env, encoding: 'utf8', windowsHide: true,
  });
}

test('native inline options catch all four public test and suite spellings', () => {
  const root = project();
  for (const key of ['skip', 'only']) {
    for (const name of ['test', 'it', 'describe', 'suite']) {
      assert.equal(write(root, key, declaration(key, 'true', name)).fires, true, `${name} ${key}: true`);
      assert.equal(write(root, key, declaration(key, 'false', name)).fires, false, `${name} ${key}: false`);
    }
  }
});

test('native patterns accept common literal names, omitted names and shallow companion options', () => {
  const root = project();
  for (const key of ['skip', 'only']) {
    const samples = [
      `test("case", { ${key}: true }, fn);`,
      `it(\`case\`, { ${key}: true }, fn);`,
      `test({ ${key}: true }, fn);`,
      `suite('case', { timeout: 1_000, ${key}: true, concurrency: false }, fn);`,
      `describe('case', { ${key}: true, signal: controller.signal, timeout: 1000, }, fn);`,
      `test( /* name */ 'case', {\n timeout: 100,\n /* option */ ${key}: /* literal */ true,\n}, fn);`,
      `await test('case', { ${key}: true }, async () => {});`,
    ];
    for (const sample of samples) assert.equal(write(root, key, sample).fires, true, sample);
  }
});

test('comments and strings resembling native calls stay quiet', () => {
  const root = project();
  for (const key of ['skip', 'only']) {
    const samples = [
      `// test('case', { ${key}: true }, fn);`,
      `/* test('case', { ${key}: true }, fn); */`,
      `const example = "test('case', { ${key}: true }, fn)";`,
      `const example = \`test('case', { ${key}: true }, fn)\`;`,
      `test('case ${key}: true', { timeout: 100 }, fn);`,
      `test('case', { timeout: 100 /* ${key}: true */ }, fn);`,
    ];
    for (const sample of samples) assert.equal(write(root, key, sample).fires, false, sample);
  }
});

test('option-like objects outside the options argument are honest look-alikes', () => {
  const root = project();
  for (const key of ['skip', 'only']) {
    const samples = [
      `const options = { ${key}: true };`,
      `configure('case', { ${key}: true }, fn);`,
      `test('case', () => { const options = { ${key}: true }; });`,
      `test('case', { timeout: 100 }, () => { const options = { ${key}: true }; });`,
      `test('case', { ${key}: false }, () => { use({ ${key}: true }); });`,
      `test('case', function () { return { ${key}: true }; });`,
      `test('case', () => ({ ${key}: true }));`,
      `test('case', { metadata: { ${key}: true } }, fn);`,
      `test('case', { timeout: 100 }, function () { this.${key} = true; });`,
    ];
    for (const sample of samples) assert.equal(write(root, key, sample).fires, false, sample);
  }
});

test('computed, shadowed and dynamic option forms remain outside the conservative native pattern', () => {
  const root = project();
  for (const key of ['skip', 'only']) {
    const samples = [
      declaration(key, 'false'),
      declaration(key, 'enabled'),
      declaration(key, 'true && enabled'),
      `test('case', { '${key}': true }, fn);`,
      `test('case', { [flag]: true }, fn);`,
      `test('case', { ${key}: true, ${key}: false }, fn);`,
      `test('case', { ${key}: false, ${key}: true }, fn);`,
      `test('case', { ${key}: true, ...options }, fn);`,
      `test('case', { ...options, ${key}: true }, fn);`,
      `test('case', { ${key}: true, metadata: { flag: true } }, fn);`,
      `test(dynamicName, { ${key}: true }, fn);`,
      `test('case', options, fn);`,
      `check('case', { ${key}: true }, fn);`,
      `context.test('case', { ${key}: true }, fn);`,
      `context. test('case', { ${key}: true }, fn);`,
      `context. /* member */ test('case', { ${key}: true }, fn);`,
    ];
    for (const sample of samples) assert.equal(write(root, key, sample).fires, false, sample);
  }
});

test('a native test option is read independently from the other option', () => {
  const root = project();
  assert.equal(write(root, 'skip', "test('case', { only: true, skip: false }, fn);").fires, false);
  assert.equal(write(root, 'only', "test('case', { only: false, skip: true }, fn);").fires, false);
  assert.equal(write(root, 'skip', "test('case', { only: false, skip: true }, fn);").fires, true);
  assert.equal(write(root, 'only', "test('case', { only: true, skip: false }, fn);").fires, true);
});

test('native Write and Edit calls detect introduced options but preserve a preexisting match', () => {
  const root = project();
  for (const key of ['skip', 'only']) {
    const before = declaration(key);
    writeFileSync(join(root, 'native.test.mjs'), before);
    assert.equal(write(root, key, before + declaration(key, 'false')).fires, false);
    assert.equal(write(root, key, before.repeat(2)).fires, true);
    assert.equal(call(root, key, 'Edit', {
      old_string: declaration(key, 'false'), new_string: before,
    }).fires, true);
    assert.equal(call(root, key, 'Edit', { old_string: before, new_string: before }).fires, false);
    assert.equal(call(root, key, 'MultiEdit', { edits: [
      { old_string: 'const n = 1;', new_string: 'const n = 2;' },
      { old_string: declaration(key, 'false'), new_string: before },
    ] }).fires, true);
  }
});

test('native live checks compare the complete HEAD source and catch a context-free edit at close', () => {
  const root = project({
    'native.test.mjs': declaration('skip') + declaration('only') + declaration('skip', 'false'),
  });
  repo(root);
  const before = readFileSync(join(root, 'native.test.mjs'), 'utf8');
  writeFileSync(join(root, 'native.test.mjs'), before + '// unrelated update\n');
  for (const key of ['skip', 'only']) assert.equal(liveSource({ root, task }, spec(key)).fires, false);
  // A replacement containing only a property has no call context; the full-file live pass does.
  assert.equal(call(root, 'skip', 'Edit', { old_string: 'skip: false', new_string: 'skip: true' }).fires, false);
  writeFileSync(join(root, 'native.test.mjs'), before.replace('skip: false', 'skip: true'));
  assert.equal(liveSource({ root, task }, spec('skip')).fires, true);
  assert.equal(liveSource({ root, task }, spec('only')).fires, false);
  writeFileSync(join(root, 'native.test.mjs'), before + declaration('only'));
  git(root, ['add', 'native.test.mjs']);
  assert.equal(liveSource({ root, task }, spec('only')).fires, true);
});

test('the original catalogue pairs still prove the existing call spellings', () => {
  const root = project();
  for (const key of ['skip', 'only']) {
    assert.equal(write(root, key, specs[key].fixtures.violation).fires, true);
    assert.equal(write(root, key, specs[key].fixtures.nearMiss).fires, false);
  }
});

test('the shipped native option pairs independently admit the appended patterns', async () => {
  const root = project();
  for (const key of ['skip', 'only']) {
    const entry = specs[key];
    const pair = entry.fixtures.additional.find((fixture) => fixture.id === 'native-options');
    assert.equal(pair.path, 'native.test.mjs');
    assert.equal(write(root, key, pair.violation).fires, true);
    assert.equal(write(root, key, pair.nearMiss).fires, false);
    const prepared = await prepareCatalogue(root, { ...edition, classes: [entry] });
    assert.ok(prepared.files.some(([name]) => name.endsWith('.violation-native-options.json')));
    assert.ok(prepared.files.some(([name]) => name.endsWith('.nearmiss-native-options.json')));

    // Original method-call fixtures still pass if the new options pattern goes missing. The
    // extra shipped pair must make that incomplete check fail admission on its own evidence.
    const withoutNative = { ...entry, patterns: entry.patterns.slice(0, 2) };
    const check = (content) => checkSource({ root, task, call: {
      tool: 'Write', input: { file_path: pair.path, content },
    } }, { ...withoutNative, commentSyntax: edition.commentSyntax });
    assert.equal(check(entry.fixtures.violation).fires, true);
    assert.equal(check(entry.fixtures.nearMiss).fires, false);
    assert.equal(check(pair.violation).fires, false);
    await assert.rejects(
      prepareCatalogue(root, { ...edition, classes: [withoutNative] }),
      /failed its violation example/,
    );
  }
});

test('a planted native skip hides a real failing body and its false look-alike runs the failure', () => {
  const pair = specs.skip.fixtures.additional.find((fixture) => fixture.id === 'native-options');
  const source = pair.violation;
  const root = project({ 'native.test.mjs': source });
  const skipped = nativeRunner(root);
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
  assert.match(skipped.stdout, /# skipped 1/);
  writeFileSync(join(root, 'native.test.mjs'), source.replace('skip: true', 'skip: false'));
  const active = nativeRunner(root);
  assert.equal(active.status, 1, active.stdout + active.stderr);
  assert.match(active.stdout, /# fail 1/);
  writeFileSync(join(root, 'native.test.mjs'), pair.nearMiss);
  const honest = nativeRunner(root);
  assert.equal(honest.status, 0, honest.stdout + honest.stderr);
  assert.match(honest.stdout, /# pass 2/);
  assert.match(honest.stdout, /# skipped 0/);
});

test('a planted native focus hides an unfocused failure when the runner enables only mode', () => {
  const pair = specs.only.fixtures.additional.find((fixture) => fixture.id === 'native-options');
  const source = pair.violation;
  const root = project({ 'native.test.mjs': source });
  const selected = nativeRunner(root, ['--test-only']);
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  assert.match(selected.stdout, /selected passing case/);
  assert.match(selected.stdout, /# tests 1/);
  assert.doesNotMatch(selected.stdout, /unfocused regression/);
  const complete = nativeRunner(root);
  assert.equal(complete.status, 1, complete.stdout + complete.stderr);
  assert.match(complete.stdout, /# fail 1/);
  writeFileSync(join(root, 'native.test.mjs'), pair.nearMiss);
  const honest = nativeRunner(root);
  assert.equal(honest.status, 0, honest.stdout + honest.stderr);
  assert.match(honest.stdout, /# pass 2/);
  assert.match(honest.stdout, /# skipped 0/);
});
