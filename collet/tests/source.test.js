import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { checkSource, liveSource } from '../templates/source.mjs';
import { git, mount, PLUGIN, project, repo } from './temp-project.js';

const edition = JSON.parse(readFileSync(join(PLUGIN, 'catalogue/javascript-typescript.json'), 'utf8'));
const task = { id: 't1', status: 'in_progress', scope: ['**'] };
const spec = (id) => ({ ...edition.classes.find((entry) => entry.id === id), commentSyntax: edition.commentSyntax });
const focused = spec('focused-test');
const focus = "it.only('case', () => { expect(1).toBe(1); });\n";
const ordinary = "it('case', () => { expect(1).toBe(1); });\n";
const write = (root, file, content, check = focused, cwd = root) =>
  checkSource({ root, task, call: { tool: 'Write', cwd, input: { file_path: file, content } } }, check);

test('a Rust result invariant is a real assertion while a literal tautology is refused', () => {
  const catalogue = JSON.parse(readFileSync(join(PLUGIN, 'catalogue/rust.json'), 'utf8'));
  const item = catalogue.classes.find((entry) => entry.id === 'softened-assertion');
  const check = { ...item, commentSyntax: catalogue.commentSyntax };
  const pair = item.fixtures.additional.find((entry) => entry.id === 'result-invariant');
  const root = project({ [pair.path]: pair.nearMiss });
  repo(root);
  const changed = pair.nearMiss + '\n// Preserve the successful operation invariant.\n';
  assert.equal(write(root, pair.path, changed, check).fires, false);
  writeFileSync(join(root, pair.path), changed);
  assert.equal(liveSource({ root, task }, check).fires, false);
  assert.equal(write(root, pair.path, pair.violation, check).fires, true);
  writeFileSync(join(root, pair.path), pair.violation);
  assert.equal(liveSource({ root, task }, check).fires, true);
});

function fixturePath(glob) {
  return glob.replace(/\{([^{}]+)\}/g, (_, choices) => choices.split(',')[0])
    .replace(/\*\*\//g, '').replace(/\*/g, 'fixture');
}

test('the twelve source classes prove their original plain-source fixture pairs', () => {
  const root = project();
  assert.equal(edition.classes.length, 12);
  assert.equal(new Set(edition.classes.map((entry) => entry.id)).size, 12);
  for (const entry of edition.classes) {
    assert.equal(typeof entry.fixtures.violation, 'string', entry.id);
    assert.equal(typeof entry.fixtures.nearMiss, 'string', entry.id);
    assert.ok(entry.example, entry.id);
    assert.ok(entry.gapNotes, entry.id);
    const file = fixturePath(entry.paths[0]);
    assert.equal(write(root, file, entry.fixtures.violation, spec(entry.id)).fires, true, `${entry.id} violation`);
    assert.equal(write(root, file, entry.fixtures.nearMiss, spec(entry.id)).fires, false, `${entry.id} near miss`);
  }
});

test('Write compares the existing file and detects growth beyond a preexisting match', () => {
  const root = project({ 'a.test.js': focus });
  assert.equal(write(root, 'a.test.js', focus + ordinary).fires, false);
  assert.equal(write(root, 'a.test.js', focus.repeat(2)).fires, true);
  assert.equal(write(root, 'a.test.js', ordinary).fires, false);
});

test('Edit and every MultiEdit replacement compare old and new text', () => {
  const root = project();
  const edit = (tool, input) => checkSource({ root, task, call: { tool, input: { file_path: 'a.test.js', ...input } } }, focused);
  assert.equal(edit('Edit', { old_string: focus, new_string: focus + ordinary }).fires, false);
  assert.equal(edit('Edit', { old_string: focus, new_string: focus.repeat(2) }).fires, true);
  assert.equal(edit('MultiEdit', { edits: [
    { old_string: ordinary, new_string: ordinary },
    { old_string: ordinary, new_string: focus },
  ] }).fires, true);
  assert.equal(edit('MultiEdit', { edits: [{ old_string: focus, new_string: ordinary }] }).fires, false);
  assert.equal(edit('MultiEdit', { edits: [{ new_string: focus }] }).skipped, true);
});

test('patterns count independently so removing one shape cannot conceal a newly added shape', () => {
  const root = project({ 'a.test.js': focus });
  assert.equal(write(root, 'a.test.js', "it.concurrent.only('case', () => { expect(1).toBe(1); });").fires, true);
});

test('source blanking ignores comments, quoted text and regex bodies but keeps live calls', () => {
  const root = project();
  const prose = [
    '// it.only("comment", run);',
    '/* it.only("block", run); */',
    'const quote = "it.only(";',
    "const apostrophe = 'it.only(';",
    'const template = `it.only(`;',
    'const pattern = /it.only[(]/;',
  ].join('\n');
  assert.equal(write(root, 'a.test.js', prose).fires, false);
  assert.equal(write(root, 'a.test.js', `${prose}\n${focus}`).fires, true);
  assert.equal(write(root, 'a.ts', 'const note = "@ts-ignore";', spec('blanket-type-suppression')).fires, false);
  assert.equal(write(root, 'a.ts', '// @ts-ignore\nconst x = 1;', spec('blanket-type-suppression')).fires, true);
});

test('keeping string content does not mistake URLs and path globs for comments', () => {
  const root = project();
  const source = 'export default { url: "https://example.invalid", include: ["**/*.test.ts"], allowOnly: true };';
  assert.equal(write(root, 'vitest.config.ts', source, spec('test-config-loosened')).fires, true);
  assert.equal(write(root, 'tsconfig.json', '// "strict": false\n{"strict": true}', spec('relaxed-tsconfig-strictness')).fires, false);
  assert.equal(write(root, '.github/workflows/ci.yml', '# npx vitest run -u\nrun: npx vitest run', spec('snapshot-updated-wholesale')).fires, false);
});

test('per-line matches grow from one to two and never combine separate lines', () => {
  const source = '- run: npm test || true\n- run: npm run lint\n';
  const root = project({ '.github/workflows/ci.yml': source });
  const ci = spec('ci-step-allowed-to-fail');
  assert.equal(write(root, '.github/workflows/ci.yml', source + '- run: npm run build\n', ci).fires, false);
  assert.equal(write(root, '.github/workflows/ci.yml', source + '- run: npm run typecheck || true\n', ci).fires, true);
  assert.equal(write(root, '.github/workflows/ci.yml', '- run: npm test ||\ntrue\n', ci).fires, false);
  const lineCheck = { ...ci, paths: ['**/*.js'], patterns: ['^\\s*disabled$'], stripComments: true, stripStrings: true };
  assert.equal(write(root, 'a.js', '/* two\nlines */ disabled\n', lineCheck).fires, true);
});

test('path matching handles root files, nested braces, call directories and unusual filenames', () => {
  const root = project();
  assert.equal(write(root, 'root.spec.tsx', focus).fires, true);
  assert.equal(write(root, 'nested/a test.spec.mts', focus).fires, true);
  assert.equal(write(root, '../a.test.js', focus, focused, join(root, 'nested')).fires, true);
  assert.equal(write(root, 'ordinary.js', focus).fires, false);
  assert.equal(write(root, '../outside.test.js', focus).fires, false);
  assert.equal(write(root, '..valid.test.js', focus).fires, true);
});

test('unsupported tools, incomplete inputs and unreadable existing files disclose a gap', () => {
  const root = project();
  mkdirSync(join(root, 'directory.test.js'));
  assert.equal(write(root, 'directory.test.js', focus).skipped, true);
  assert.equal(write(root, 'a.test.js', undefined).skipped, true);
  for (const tool of ['apply_patch', 'Bash', 'NotebookEdit']) {
    const out = checkSource({ root, task, call: { tool, input: { file_path: 'a.test.js', content: focus } } }, focused);
    assert.equal(out.skipped, true, tool);
    assert.match(out.reason, /live check/);
  }
  assert.equal(checkSource({ root, task: null, call: {} }, focused).skipped, true);
});

test('live checks keep the HEAD baseline for unchanged matches and detect staged or unstaged growth', () => {
  const root = project({ 'a.test.js': focus, 'base.txt': 'base\n' });
  repo(root);
  writeFileSync(join(root, 'a.test.js'), focus + ordinary);
  assert.equal(liveSource({ root, task }, focused).fires, false);
  writeFileSync(join(root, 'a.test.js'), focus.repeat(2));
  assert.equal(liveSource({ root, task }, focused).fires, true);
  git(root, ['add', 'a.test.js']);
  assert.equal(liveSource({ root, task }, focused).fires, true);
  writeFileSync(join(root, 'a.test.js'), ordinary);
  assert.equal(liveSource({ root, task }, focused).fires, false);
});

test('live checks include untracked names verbatim, respect ignores and accept deletions', () => {
  const root = project({ 'a.test.js': focus, '.gitignore': 'ignored.test.js\n' });
  repo(root);
  unlinkSync(join(root, 'a.test.js'));
  writeFileSync(join(root, 'ignored.test.js'), focus);
  assert.equal(liveSource({ root, task }, focused).fires, false);
  const name = 'new café space.test.js';
  writeFileSync(join(root, name), focus.replace('case', 'new case'));
  const out = liveSource({ root, task }, focused);
  assert.equal(out.fires, true);
  assert.ok(out.reason.includes(name));
  unlinkSync(join(root, name));
  mkdirSync(join(root, '.collet'));
  writeFileSync(join(root, '.collet', 'internal.test.js'), focus);
  assert.equal(liveSource({ root, task }, focused).fires, false);
});

test('a tracked rename carries the original HEAD source into its new filename', () => {
  const root = project({ 'old.test.js': focus.repeat(8) });
  repo(root);
  renameSync(join(root, 'old.test.js'), join(root, 'renamed café.test.js'));
  git(root, ['add', '-A']);
  assert.equal(liveSource({ root, task }, focused).fires, false);
  writeFileSync(join(root, 'renamed café.test.js'), focus.repeat(9));
  assert.equal(liveSource({ root, task }, focused).fires, true);
});

test('a rename into a checked filename introduces source that was previously outside the check', () => {
  const root = project({ 'example.txt': focus });
  repo(root);
  renameSync(join(root, 'example.txt'), join(root, 'example.test.js'));
  git(root, ['add', '-A']);
  assert.equal(liveSource({ root, task }, focused).fires, true);
});

const only = (name) => `it.only('${name}', () => { expect(1).toBe(1); });\n`;

test('splitting a file moves its matches without introducing them, while one more match is refused', () => {
  const root = project({ 'suite.test.js': ['dates', 'totals', 'rows', 'names'].map(only).join('') + ordinary });
  repo(root);
  unlinkSync(join(root, 'suite.test.js'));
  writeFileSync(join(root, 'dates.test.js'), only('dates') + ordinary);
  writeFileSync(join(root, 'totals.test.js'), `describe('totals', () => {\n  ${only('totals')}  ${only('rows')}});\n`);
  writeFileSync(join(root, 'names.test.js'), only('names'));
  assert.equal(liveSource({ root, task }, focused).fires, false);
  git(root, ['add', '-A']);
  assert.equal(liveSource({ root, task }, focused).fires, false);
  writeFileSync(join(root, 'added.test.js'), only('added'));
  const out = liveSource({ root, task }, focused);
  assert.equal(out.fires, true);
  assert.ok(out.reason.includes('added.test.js'));
  unlinkSync(join(root, 'added.test.js'));
  writeFileSync(join(root, 'names.test.js'), only('names') + only('added'));
  assert.equal(liveSource({ root, task }, focused).fires, true);
  writeFileSync(join(root, 'names.test.js'), only('names') + only('names'));
  assert.equal(liveSource({ root, task }, focused).fires, true);
});

test('a rename that keeps some matches and moves the rest is not an introduction', () => {
  const root = project({ 'old.test.js': only('kept') + only('moved') + ordinary.repeat(20) });
  repo(root);
  unlinkSync(join(root, 'old.test.js'));
  writeFileSync(join(root, 'kept.test.js'), only('kept') + ordinary.repeat(20));
  writeFileSync(join(root, 'moved.test.js'), only('moved'));
  git(root, ['add', '-A']);
  assert.match(git(root, ['diff', '--cached', '--find-renames', '--name-status', 'HEAD']), /^R\d+\told\.test\.js\tkept\.test\.js$/m);
  assert.equal(liveSource({ root, task }, focused).fires, false);
  writeFileSync(join(root, 'moved.test.js'), only('moved') + only('added'));
  assert.equal(liveSource({ root, task }, focused).fires, true);
});

test('only a net loss of the same match explains growth in another file', () => {
  const root = project({ 'a.test.js': only('first') + only('second'), 'b.test.js': ordinary, 'c.test.js': ordinary });
  repo(root);
  // A different match removed elsewhere does not excuse an added one.
  writeFileSync(join(root, 'a.test.js'), only('first'));
  writeFileSync(join(root, 'b.test.js'), only('other'));
  assert.equal(liveSource({ root, task }, focused).fires, true);
  // A match replaced in place leaves no loss to explain a copy of the original.
  writeFileSync(join(root, 'a.test.js'), only('first') + only('changed'));
  writeFileSync(join(root, 'b.test.js'), only('second'));
  assert.equal(liveSource({ root, task }, focused).fires, true);
  // One match lost explains one match gained, not two.
  writeFileSync(join(root, 'a.test.js'), only('replacement'));
  writeFileSync(join(root, 'c.test.js'), only('first'));
  assert.equal(liveSource({ root, task }, focused).fires, true);
  writeFileSync(join(root, 'c.test.js'), ordinary);
  assert.equal(liveSource({ root, task }, focused).fires, false);
});

test('a refusal names every introducing file in change order and keeps the single-file text', () => {
  const single = (rel) =>
    `${focused.id} (${focused.title}): ${rel} introduces a matching source pattern. Fix the change before continuing.`;
  const root = project({ 'a.test.js': ordinary, 'b.test.js': ordinary, 'c.test.js': ordinary });
  repo(root);
  assert.equal(write(root, 'a.test.js', focus).reason, single('a.test.js'));
  writeFileSync(join(root, 'b.test.js'), focus);
  assert.deepEqual(liveSource({ root, task }, focused), { fires: true, reason: single('b.test.js') });
  writeFileSync(join(root, 'a.test.js'), focus);
  writeFileSync(join(root, 'new.test.js'), focus);
  const out = liveSource({ root, task }, focused);
  assert.equal(out.fires, true);
  assert.match(out.reason, /: 3 files introduce a matching source pattern: a\.test\.js, b\.test\.js, new\.test\.js\. Fix/);
});

test('a refusal with many introducing files names ten and counts the rest', () => {
  const root = project({ 'base.txt': 'base\n' });
  repo(root);
  const names = Array.from({ length: 12 }, (_, index) => `f${String(index).padStart(2, '0')}.test.js`);
  for (const name of names) writeFileSync(join(root, name), focus);
  const out = liveSource({ root, task }, focused);
  assert.equal(out.fires, true);
  assert.ok(out.reason.includes(`12 files introduce a matching source pattern: ${names.slice(0, 10).join(', ')} and 2 more.`));
  assert.ok(!out.reason.includes(names[10]));
});

test('checks sharing a cache read the change list once and reach the verdicts they reach alone', () => {
  const root = project({ 'a.test.ts': ordinary, 'b.ts': 'export const b = 1;\n', 'suite.test.ts': focus });
  repo(root);
  writeFileSync(join(root, 'a.test.ts'), focus.replace('case', 'a'));
  writeFileSync(join(root, 'b.ts'), 'export const b = 1 as any;\n');
  unlinkSync(join(root, 'suite.test.ts'));
  writeFileSync(join(root, 'moved.test.ts'), focus);
  const checks = edition.classes.map((entry) => spec(entry.id));
  const alone = checks.map((check) => liveSource({ root, task }, check));
  assert.ok(alone.filter((result) => result.fires).length >= 2);
  const cache = new Map();
  assert.deepEqual(checks.map((check) => liveSource({ root, task, cache }, check)), alone);
  assert.equal(cache.size, 1);
  // The pass keeps the list it read first: a file added afterwards is seen only without that cache.
  writeFileSync(join(root, 'late.test.ts'), focus.replace('case', 'late'));
  const index = edition.classes.findIndex((entry) => entry.id === 'focused-test');
  assert.deepEqual(liveSource({ root, task, cache }, focused), alone[index]);
  assert.match(liveSource({ root, task }, focused).reason, /late\.test\.ts/);
});

test('a class exclude takes paths out at write and close time, and a remedy follows the refusal', () => {
  const check = { ...focused, exclude: ['generated/**'], remedy: 'Remove the focus before closing.' };
  const root = project({ 'generated/a.test.js': ordinary, 'src/a.test.js': ordinary });
  repo(root);
  assert.equal(write(root, 'generated/a.test.js', focus, check).fires, false);
  const refused = write(root, 'src/a.test.js', focus, check);
  assert.equal(refused.reason.endsWith('Fix the change before continuing. Remove the focus before closing.'), true);
  assert.equal(write(root, 'src/a.test.js', focus).reason.endsWith('Fix the change before continuing.'), true);
  writeFileSync(join(root, 'generated/a.test.js'), focus);
  assert.equal(liveSource({ root, task }, check).fires, false);
  assert.equal(liveSource({ root, task }, focused).fires, true);
  renameSync(join(root, 'generated/a.test.js'), join(root, 'src/b.test.js'));
  git(root, ['add', '-A']);
  assert.match(liveSource({ root, task }, check).reason, /src\/b\.test\.js introduces/);
});

test('a project exclude keeps a generated mirror out of every bundle check, and no list changes nothing', () => {
  const root = project({ 'src/a.test.js': ordinary, 'deno_dist/a.test.js': ordinary });
  repo(root);
  writeFileSync(join(root, 'deno_dist/a.test.js'), focus);
  assert.equal(write(root, 'deno_dist/b.test.js', focus).fires, true);
  assert.equal(liveSource({ root, task }, focused).fires, true);
  mkdirSync(join(root, '.collet'));
  writeFileSync(join(root, '.collet', 'config.json'), JSON.stringify({ exclude: ['deno_dist/**'] }));
  assert.equal(write(root, 'deno_dist/b.test.js', focus).fires, false);
  assert.equal(liveSource({ root, task }, focused).fires, false);
  assert.equal(write(root, 'src/a.test.js', focus).fires, true);
  writeFileSync(join(root, 'src/a.test.js'), focus);
  assert.match(liveSource({ root, task }, focused).reason, /^[^:]+\([^)]*\): src\/a\.test\.js introduces/);
  writeFileSync(join(root, '.collet', 'config.json'), '{ not json');
  assert.equal(write(root, 'deno_dist/b.test.js', focus).fires, true);
});

test('mount stores a project exclude only when --exclude names one', () => {
  const plain = project({ 'package.json': '{}\n' });
  assert.equal(mount(plain).status, 0);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(plain, '.collet', 'config.json'), 'utf8'))), ['project', 'conventions', 'accept']);
  const mirrored = project({ 'package.json': '{}\n' });
  assert.equal(mount(mirrored, ['--exclude', 'deno_dist/**']).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(mirrored, '.collet', 'config.json'), 'utf8')).exclude, ['deno_dist/**']);
  assert.equal(mount(project({}), ['--exclude']).status, 2);
});

test('a deleted file whose HEAD source cannot be read explains no move', () => {
  const root = project({ 'suite.test.js': only('dates') });
  repo(root);
  const blob = git(root, ['rev-parse', 'HEAD:suite.test.js']).trim();
  unlinkSync(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  unlinkSync(join(root, 'suite.test.js'));
  writeFileSync(join(root, 'dates.test.js'), only('dates'));
  const out = liveSource({ root, task }, focused);
  assert.equal(out.fires, true);
  assert.ok(out.reason.includes('dates.test.js'));
});

test('a mount below the Git root matches its own paths and reads the corresponding HEAD files', () => {
  const root = project({ 'nested/a.test.js': focus, 'outside.test.js': ordinary });
  repo(root);
  const nested = join(root, 'nested');
  writeFileSync(join(root, 'outside.test.js'), focus);
  writeFileSync(join(nested, 'a.test.js'), focus + ordinary);
  assert.equal(liveSource({ root: nested, task }, focused).fires, false);
  writeFileSync(join(nested, 'a.test.js'), focus.repeat(2));
  assert.equal(liveSource({ root: nested, task }, focused).fires, true);
  writeFileSync(join(nested, 'a.test.js'), ordinary);
  writeFileSync(join(nested, 'untracked.test.js'), focus.replace('case', 'new case'));
  assert.equal(liveSource({ root: nested, task }, focused).fires, true);
});

test('live per-line patterns compare counts across the complete HEAD and working files', () => {
  const file = '.github/workflows/ci.yml';
  const source = '- run: npm test || true\n- run: npm run lint\n';
  const root = project({ [file]: source });
  repo(root);
  writeFileSync(join(root, file), source + '- run: npm run build\n');
  assert.equal(liveSource({ root, task }, spec('ci-step-allowed-to-fail')).fires, false);
  writeFileSync(join(root, file), source + '- run: npm run build || true\n');
  assert.equal(liveSource({ root, task }, spec('ci-step-allowed-to-fail')).fires, true);
});

test('missing Git history and unreadable HEAD blobs never become clean baseline results', () => {
  const root = project({ 'a.test.js': ordinary });
  assert.equal(liveSource({ root, task }, focused).skipped, true);
  git(root, ['init', '-q']);
  assert.equal(liveSource({ root, task }, focused).skipped, true);
  repo(root);
  const blob = git(root, ['rev-parse', 'HEAD:a.test.js']).trim();
  unlinkSync(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  writeFileSync(join(root, 'a.test.js'), focus);
  const out = liveSource({ root, task }, focused);
  assert.equal(out.skipped, true);
  assert.equal(out.fires, false);
  assert.match(out.reason, /baseline/);
});
