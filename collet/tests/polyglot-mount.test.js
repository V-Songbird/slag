import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { checks, mount, PLUGIN, project } from './temp-project.js';

const markers = {
  'Service.csproj': '<Project />\n', 'go.mod': 'module service\n', 'package.json': '{}\n',
  'build.gradle.kts': '// Project build\n', 'pyproject.toml': '[project]\n', 'Cargo.toml': '[package]\n',
};
const editions = ['dotnet', 'go', 'javascript-typescript', 'jvm', 'python', 'rust'];
function installed(root) {
  return readdirSync(join(root, '.collet/checks')).filter((name) => name.endsWith('.mjs') && name !== 'run.mjs' && name !== 'scope.mjs');
}

test('all detected languages are mounted and admitted together', () => {
  const root = project(markers);
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /Selected check editions: dotnet, go, javascript-typescript, jvm, python, rust/);
  assert.equal(installed(root).length, 46);
  assert.match(out.stdout, /opt-in {3}javascript-typescript\.type-widened-to-any \(add it with --with/);
  for (const edition of editions) assert.ok(installed(root).some((name) => name.startsWith(`${edition}.`)), edition);
  assert.equal(checks(root).status, 0);
  for (const [file, content] of Object.entries(markers)) assert.equal(readFileSync(join(root, file), 'utf8'), content);
});

test('explicit editions select only the requested languages and repeated ids do not duplicate writes', () => {
  const root = project(markers);
  const out = mount(root, ['--checks', '--edition', 'python', '--edition', 'javascript-typescript', '--edition', 'python']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /Selected check editions: javascript-typescript, python/);
  assert.equal(installed(root).length, 19);
  assert.ok(installed(root).every((name) => /^(?:javascript-typescript|python)\./.test(name)));
  assert.equal(checks(root).status, 0);
});

test('solution filename globs detect a language while marker-shaped directories do not', () => {
  const root = project({ 'Project.SLNX': '<Solution />\n' });
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.ok(installed(root).every((name) => name.startsWith('dotnet.')));
  const directory = project({});
  mkdirSync(join(directory, 'package.json'));
  assert.equal(mount(directory, ['--checks']).status, 2);
  assert.equal(existsSync(join(directory, '.collet')), false);
});

test('a bad later edition does not leave an earlier bundle partly installed', () => {
  const root = project({ 'AGENTS.md': '# Keep this\n', ...markers });
  const out = mount(root, ['--checks', '--edition', 'go', '--edition', 'unknown']);
  assert.equal(out.status, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /Unknown check edition/);
  assert.equal(existsSync(join(root, '.collet')), false);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '# Keep this\n');
});

test('preflight rejects a runtime that misses an independently proven secondary detector', () => {
  const runtimeUrl = pathToFileURL(join(PLUGIN, 'templates/source.mjs')).href;
  const oldRuntime = `import { checkSource as current, liveSource } from ${JSON.stringify(runtimeUrl)};\n` +
    'export { liveSource };\nexport function checkSource(context, spec) { return current(context, { ...spec, detectors: undefined }); }\n';
  const root = project({ ...markers, '.collet/source.mjs': oldRuntime });
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /jvm\.blanket-lint-suppression failed its violation example/);
  assert.equal(existsSync(join(root, '.collet/checks')), false);
  assert.equal(readFileSync(join(root, '.collet/source.mjs'), 'utf8'), oldRuntime);
});

test('a later partial check set leaves every selected language untouched', () => {
  const root = project({
    ...markers, 'AGENTS.md': '# Keep this\n',
    '.collet/checks/rust.skipped-test.violation.json': '{"what":"Project example"}\n',
  });
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /incomplete check\/example set/);
  assert.deepEqual(readdirSync(join(root, '.collet/checks')), ['rust.skipped-test.violation.json']);
  assert.equal(existsSync(join(root, '.collet/source.mjs')), false);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '# Keep this\n');
});
