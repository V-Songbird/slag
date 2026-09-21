import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { prepareCatalogue } from '../scripts/catalogue.mjs';
import { checkSource, liveSource } from '../templates/source.mjs';
import { clean, PLUGIN, project, repo } from './temp-project.js';

const task = { id: 't1', status: 'in_progress', scope: ['**'] };
const edition = (name) => JSON.parse(readFileSync(join(PLUGIN, `catalogue/${name}.json`), 'utf8'));
const spec = (language, id) => {
  const data = edition(language);
  return { ...data.classes.find((entry) => entry.id === id), commentSyntax: data.commentSyntax };
};
const python = spec('python', 'test-config-loosened');
const nullable = spec('dotnet', 'nullable-context-disabled');
const kotlin = spec('jvm', 'non-null-assertion');
const java = spec('jvm', 'skipped-test');
const call = (root, check, file, source, tool = 'Write', before = '') => checkSource({
  root, task, call: { tool, input: {
    file_path: file, content: source, old_string: before, new_string: source,
  } },
}, check);

test('INI and CFG discard full-line comments while preserving actual options', (t) => {
  const root = project();
  t.after(() => clean(root));
  const comments = '[pytest]\n# addopts = --no-cov\n  ; xfail_strict = false\n\t# fail_under = 0\naddopts = --cov=src\n';
  for (const file of ['pytest.ini', 'tox.ini', 'setup.cfg']) {
    for (const tool of ['Write', 'Edit']) {
      assert.equal(call(root, python, file, comments, tool).fires, false, `${file} ${tool}`);
      assert.equal(call(root, python, file, comments + 'xfail_strict = false\n', tool).fires, true);
    }
  }
});

test('INI inline hash and semicolon characters remain value text', (t) => {
  const root = project();
  t.after(() => clean(root));
  for (const file of ['pytest.ini', 'setup.cfg']) {
    for (const source of [
      '[pytest]\naddopts = token#fragment --no-cov\n',
      '[pytest]\naddopts = token;fragment --no-cov\n',
      '[pytest]\naddopts = "#fragment --no-cov"\n',
      '[pytest]\naddopts = \n    --no-cov\n',
    ]) assert.equal(call(root, python, file, source).fires, true, source);
    assert.equal(call(root, { ...python, stripComments: false }, file, '# addopts = --no-cov\n').fires, true);
  }
});

const rawCases = [
  { check: nullable, file: 'Example.cs', near: 'var example = """\n#nullable disable\n""";\n', real: '#nullable disable\n' },
  { check: nullable, file: 'Four.cs', near: 'var example = """"\n"""\n#nullable disable\n"""";\n', real: '#nullable disable\n' },
  { check: nullable, file: 'Verbatim.cs', near: 'var example = @"\n#nullable disable\n";\n', real: '#nullable disable\n' },
  { check: kotlin, file: 'Example.kt', near: 'val example = """\nval unsafe = value!!\n"""\n', real: 'val unsafe = value!!\n' },
  { check: kotlin, file: 'Example.kts', near: 'val example = """value!!"""\n', real: 'val unsafe = value!!\n' },
  { check: java, file: 'src/test/Example.java', near: 'class Example { String text = """\n@Disabled\nvoid fake() {}\n"""; }\n', real: '@Disabled\nclass DisabledExample {}\n' },
];

test('raw blocks are quiet but matching source after the closing delimiter still fires', (t) => {
  const root = project();
  t.after(() => clean(root));
  for (const { check, file, near, real } of rawCases) {
    for (const tool of ['Write', 'Edit']) {
      assert.equal(call(root, check, file, near, tool).fires, false, `${file} ${tool}`);
      assert.equal(call(root, check, file, near + real, tool).fires, true, `${file} ${tool}`);
    }
  }
});

test('Java escapes differ from Kotlin and C# raw delimiter termination', (t) => {
  const root = project();
  t.after(() => clean(root));
  const escaped = 'class Example { String text = """\n\\"""\n@Disabled\n"""; }\n';
  assert.equal(call(root, java, 'src/test/Example.java', escaped).fires, false);
  assert.equal(call(root, java, 'src/test/Example.java', escaped + '@Disabled\nclass Bad {}\n').fires, true);
  const even = 'class Example { String text = """\ncontent \\\\"""; }\n@Disabled\nclass Bad {}\n';
  assert.equal(call(root, java, 'src/test/Example.java', even).fires, true);
  assert.equal(call(root, kotlin, 'Example.kt', 'val text = """content \\"""\nval unsafe = value!!\n').fires, true);
  assert.equal(call(root, nullable, 'Example.cs', 'var text = """content \\""";\n#nullable disable\n').fires, true);
});

test('ordinary escaped strings and multiline comments retain their existing blanking', (t) => {
  const root = project();
  t.after(() => clean(root));
  const csharp = 'var text = "escaped \\" quote #nullable disable";\n/*\n#nullable disable\n*/\n';
  assert.equal(call(root, nullable, 'Example.cs', csharp).fires, false);
  assert.equal(call(root, nullable, 'Example.cs', csharp + '#nullable disable\n').fires, true);
  const source = 'val text = "escaped \\" quote value!!"\n/*\nval unsafe = value!!\n*/\n';
  assert.equal(call(root, kotlin, 'Example.kt', source).fires, false);
  assert.equal(call(root, kotlin, 'Example.kt', source + 'val unsafe = value!!\n').fires, true);
  const verbatim = 'var text = @"quoted ""value""\n#nullable disable\n";\n';
  assert.equal(call(root, nullable, 'Example.cs', verbatim).fires, false);
  assert.equal(call(root, nullable, 'Example.cs', verbatim + '#nullable disable\n').fires, true);
});

test('stripStrings false preserves intentionally inspected quoted text and raw text', (t) => {
  const root = project();
  t.after(() => clean(root));
  const check = spec('jvm', 'blanket-lint-suppression');
  const source = 'class Example { String text = """\n@SuppressWarnings("unchecked")\n// literal text\n"""; }\n';
  assert.equal(call(root, check, 'Example.java', source).fires, true);
  assert.equal(call(root, check, 'Example.java', '@SuppressWarnings("unchecked")\nclass Example {}\n').fires, true);
  assert.equal(call(root, { ...nullable, stripStrings: false }, 'Example.cs', rawCases[0].near).fires, true);
});

test('unterminated and interpolated raw blocks never hide executable matches', (t) => {
  const root = project();
  t.after(() => clean(root));
  assert.equal(call(root, kotlin, 'Example.kt', 'val text = """\nval unsafe = value!!\n').fires, true);
  assert.equal(call(root, nullable, 'Example.cs', 'var text = """"\n#nullable disable\n""";\n').fires, true);
  assert.equal(call(root, kotlin, 'Example.kt', 'val text = """${value!!}"""\n').fires, true);
  const assertion = spec('dotnet', 'softened-assertion');
  assert.equal(call(root, assertion, 'Example.cs', 'var text = $"""{Run(() => Assert.True(true))}""";\n').fires, true);
  assert.equal(call(root, assertion, 'Example.cs', 'var text = $@"{Run(() => Assert.True(true))}";\n').fires, true);
  assert.equal(call(root, assertion, 'Example.cs', 'var text = @$"{Run(() => Assert.True(true))}";\n').fires, true);
});

test('text-block syntax stays restricted to source extensions', (t) => {
  const root = project();
  t.after(() => clean(root));
  const check = { id: 'marker', title: 'marker', paths: ['**/*'], patterns: ['MARKER'], stripComments: false, stripStrings: true };
  assert.equal(call(root, check, 'example.xml', '<example>"""\nMARKER\n"""</example>').fires, true);
  assert.equal(call(root, check, 'example.json', '{"example":"\\"\\"\\"MARKER\\"\\"\\""}').fires, false);
});

test('live checks ignore added raw blocks and INI comments but catch real directives against HEAD', (t) => {
  const cases = [...rawCases, { check: python, file: 'pytest.ini', near: '[pytest]\n# addopts = --no-cov\n; xfail_strict = false\n', real: 'addopts = --no-cov\n' }];
  const root = project(Object.fromEntries(cases.map(({ file }) => [file, '\n'])));
  t.after(() => clean(root));
  repo(root);
  for (const { file, near } of cases) writeFileSync(join(root, file), near);
  for (const { check, file, near, real } of cases) {
    assert.equal(liveSource({ root, task }, check).fires, false, file);
    writeFileSync(join(root, file), near + real);
    assert.equal(liveSource({ root, task }, check).fires, true, file);
    writeFileSync(join(root, file), near);
  }
});

test('shipped comment and text-block pairs independently pass mount preflight', async (t) => {
  const root = project();
  t.after(() => clean(root));
  for (const [language, id, example] of [
    ['python', 'test-config-loosened', 'ini-comments'],
    ['dotnet', 'nullable-context-disabled', 'raw-string-directive'],
    ['dotnet', 'nullable-context-disabled', 'verbatim-string-directive'],
    ['jvm', 'non-null-assertion', 'raw-string-assertion'],
    ['jvm', 'skipped-test', 'text-block-annotation'],
  ]) {
    const data = edition(language);
    const item = data.classes.find((entry) => entry.id === id);
    const prepared = await prepareCatalogue(root, { ...data, classes: [item] });
    assert.ok(prepared.files.some(([name]) => name.endsWith(`.violation-${example}.json`)));
    assert.ok(prepared.files.some(([name]) => name.endsWith(`.nearmiss-${example}.json`)));
  }
});

test('shipped near misses reject a preserved runtime that lacks the literal and INI handling', async (t) => {
  const runtime = pathToFileURL(join(PLUGIN, 'templates/source.mjs')).href;
  const oldRuntime = `import { checkSource as current, liveSource } from ${JSON.stringify(runtime)};\n` +
    'export { liveSource };\nexport function checkSource(context, spec) {\n' +
    '  const old = { ...spec, commentSyntax: { ...spec.commentSyntax, ".ini": "slash", ".cfg": "slash" } };\n' +
    '  if (/\\.(?:cs|java|kt)$/.test(context.call.input.file_path)) old.stripStrings = false;\n' +
    '  return current(context, old);\n}\n';
  const root = project({ '.collet/source.mjs': oldRuntime });
  t.after(() => clean(root));
  for (const [language, id] of [
    ['python', 'test-config-loosened'], ['dotnet', 'nullable-context-disabled'],
    ['jvm', 'non-null-assertion'], ['jvm', 'skipped-test'],
  ]) {
    const data = edition(language);
    await assert.rejects(prepareCatalogue(root, {
      ...data, classes: [data.classes.find((entry) => entry.id === id)],
    }), /failed its near-miss example/);
  }
});
