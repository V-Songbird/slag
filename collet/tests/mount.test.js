// The installer. It is the half that must be identical every time, so every claim the skill makes
// about what mounting does is checked here rather than trusted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { git, mount, project, repo, TEMPLATES, TREE } from './temp-project.js';

test('the rules block reaches every surface an agent reads', () => {
  const root = project({ ...TREE, 'CLAUDE.md': '# House rules\n', '.cursor/rules/.keep': '' });
  mount(root);
  for (const surface of ['AGENTS.md', 'CLAUDE.md', '.cursor/rules/collet.md']) {
    assert.match(readFileSync(join(root, surface), 'utf8'), /collet:begin/, surface);
  }
  assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /# House rules/);
});

// One host reads `AGENTS.md` only while no `CLAUDE.md` exists. A `CLAUDE.md` created here would
// hold nothing but the block, and would hide everything the project wrote in `AGENTS.md`.
test('a project that keeps only AGENTS.md is not given a CLAUDE.md', () => {
  const root = project({ ...TREE, 'AGENTS.md': '# House rules\n' });
  const out = mount(root);
  assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /collet:begin/);
  assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(root, '.cursor')), false);
  assert.doesNotMatch(out.stdout, /CLAUDE\.md/);
});

test('mounting twice does not duplicate the block', () => {
  const root = project(TREE);
  mount(root);
  const once = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  mount(root);
  const twice = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(once, twice);
  assert.equal(twice.split('collet:begin').length - 1, 1);
});

test("a project's own text survives a mount and a remount", () => {
  const root = project({ ...TREE, 'AGENTS.md': '# House rules\n\nCommit messages are in English.\n' });
  mount(root);
  mount(root);
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.match(text, /Commit messages are in English/);
  assert.match(text, /collet:begin/);
});

test('an existing config is kept, and only a missing accept command is filled in', () => {
  const root = project(TREE);
  mount(root);
  writeFileSync(
    join(root, '.collet', 'config.json'),
    JSON.stringify({ project: 'mine', conventions: [], accept: 'REPLACE ME: x' }),
    'utf8'
  );
  mount(root, ['--accept', 'npm test']);
  const config = JSON.parse(readFileSync(join(root, '.collet', 'config.json'), 'utf8'));
  assert.equal(config.project, 'mine');
  assert.equal(config.accept, 'npm test');
});

test('the placeholders leave no room to mistake them for a decision', () => {
  const root = project(TREE);
  mount(root);
  const config = JSON.parse(readFileSync(join(root, '.collet', 'config.json'), 'utf8'));
  assert.match(config.project, /^REPLACE ME/);
  assert.match(config.accept, /^REPLACE ME/);
  assert.equal(config.verifier, undefined);
});

test('every check a project receives arrives with the fixtures that admit it', () => {
  const root = project(TREE);
  mount(root);
  const dir = join(root, '.collet', 'checks');
  const checks = readdirSync(dir).filter((name) => name.endsWith('.mjs') && name !== 'run.mjs');
  assert.ok(checks.length > 0);
  for (const file of checks) {
    const id = file.replace(/\.mjs$/, '');
    const fixtures = readdirSync(dir).filter((name) => name.startsWith(`${id}.`) && name.endsWith('.json'));
    assert.ok(fixtures.some((name) => name.startsWith(`${id}.violation`)), `${id} has no violation`);
    assert.ok(fixtures.some((name) => name.startsWith(`${id}.nearmiss`)), `${id} has no near miss`);
  }
  assert.equal(existsSync(join(dir, 'run.mjs')), true);
});

test('what a session regenerates is not committed', () => {
  const root = project(TREE);
  mount(root);
  const ignore = readFileSync(join(root, '.collet', '.gitignore'), 'utf8');
  for (const name of ['guard-log.jsonl', 'handoff.md', 'checks/discarded.json', 'off']) {
    assert.match(ignore, new RegExp(name.replace('/', '\\/')), name);
  }
});

test('a running mark a stopped hook leaves is not committed', () => {
  const root = project(TREE);
  repo(root);
  mount(root);
  assert.equal(git(root, ['check-ignore', '.collet/handoff.running']).trim(), '.collet/handoff.running');
});

test('a remount adds the running-mark line once to an older ignore list and keeps its own lines', () => {
  const older = 'guard-log.jsonl\nhandoff.md\ncheckpoints/';
  const root = project({ ...TREE, '.collet/.gitignore': older });
  const out = mount(root);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /\.collet\/\.gitignore \(\*\.running added/);
  mount(root);
  assert.equal(readFileSync(join(root, '.collet', '.gitignore'), 'utf8'), `${older}\n*.running\n`);
});

test('the rules a project receives name commands that work in that project', () => {
  const own = project(TREE);
  mount(own);
  const mine = readFileSync(join(own, 'AGENTS.md'), 'utf8');
  assert.match(mine, /node \.collet\/task\.mjs widen/);
  assert.match(mine, /node \.collet\/task\.mjs close/);
  assert.doesNotMatch(mine, /\{\{/);
});

// What must never happen without asking is the person's answer: stored, and stated as a fact about
// the project rather than an order. A project that gave no answer keeps what it always had.
test('an ask-first list is stored in the config and stated as a fact in the rules block', () => {
  const root = project(TREE);
  mount(root, ['--accept', 'npm test', '--ask-first', 'deploy', '--ask-first', 'publish a release']);
  const config = JSON.parse(readFileSync(join(root, '.collet', 'config.json'), 'utf8'));
  assert.deepEqual(config.ask_first, ['deploy', 'publish a release']);
  assert.match(
    readFileSync(join(root, 'AGENTS.md'), 'utf8'),
    /reads anything\.\n\nIn this project the person is asked before any of these: deploy, publish a release\. Every other step goes ahead until the open task's accept command exits zero\.\n\n1\. /
  );
});

test('without an ask-first list the config and rules block are what they always were', () => {
  const root = project(TREE);
  mount(root);
  const config = JSON.parse(readFileSync(join(root, '.collet', 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(config), ['project', 'conventions', 'accept']);
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.match(text, /reads anything\.\n\n1\. \*\*Change only/);
  assert.doesNotMatch(text, /asked before/);
});

test('a remount fills in a missing ask-first list and keeps one the project already has', () => {
  const root = project(TREE);
  mount(root);
  assert.match(mount(root, ['--ask-first', 'deploy']).stdout, /config\.json \(ask-first list filled in\)/);
  mount(root, ['--ask-first', 'spend money']);
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.collet', 'config.json'), 'utf8')).ask_first, ['deploy']);
  assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /asked before any of these: deploy\. /);
});

test('--ask-first with nothing after it is refused before anything is written', () => {
  const root = project(TREE);
  const out = mount(root, ['--ask-first']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /--ask-first needs .*Nothing was written/);
  assert.equal(existsSync(join(root, '.collet')), false);
});

// The whole of collet's relationship with a project that plans its work elsewhere: it stays out.
// Mounting would put a second record of the same work on disk, and the files such a roadmap names
// are a forecast its own tool rewrites rather than a boundary worth refusing a write against.
// Three signals, because a roadmap written before the format marker existed carries none.
test('a project that plans its work elsewhere is left alone entirely', () => {
  const entry = '{"id":"002","status":"in_progress","planned_touches":["src/auth/"]}\n';
  for (const files of [
    { '.foreman/config.json': '{}' },
    { 'ROADMAP.jsonl': '{"foreman_roadmap_format":2}\n' },
    { 'ROADMAP.jsonl': entry },
  ]) {
    const root = project({ ...TREE, ...files });
    const out = mount(root);
    assert.equal(out.status, 2, JSON.stringify(files));
    assert.match(out.stderr, /roadmap collet does not own/);
    assert.equal(existsSync(join(root, '.collet')), false);
    assert.equal(existsSync(join(root, 'AGENTS.md')), false);
  }
});

// A config the mount cannot read stops it before anything is written. Halfway, it left collet's
// scripts refreshed and no rules block; an array even mounted and overwrote the file.
test('an unreadable config.json stops the mount before any file changes', () => {
  const files = (root) =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .map((path) => `${path.slice(root.length)} ${readFileSync(path, 'utf8')}`)
      .sort();
  for (const [text, problem] of [['{ not json', /JSON/], ['[]', /does not hold a JSON object/], ['null', /does not hold a JSON object/]]) {
    const root = project({ ...TREE, 'AGENTS.md': '# Keep this\n', '.collet/config.json': text });
    const before = files(root);
    const out = mount(root, ['--accept', 'npm test']);
    assert.equal(out.status, 2, text);
    assert.match(out.stderr, /config\.json cannot be read as collet's config: /, text);
    assert.match(out.stderr, problem, text);
    assert.match(out.stderr, /Nothing was written/, text);
    assert.deepEqual(files(root), before, text);
  }
});

// An accept that is not text stops the mount the same way, with or without --accept. Filling one
// in used to call a string method on it and fail after the scripts were written.
test('a config whose accept is not a string stops the mount before any file changes', () => {
  const files = (root) =>
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .map((path) => `${path.slice(root.length)} ${readFileSync(path, 'utf8')}`)
      .sort();
  for (const accept of [5, null, { run: 'npm test' }]) {
    for (const args of [['--accept', 'npm test'], []]) {
      const label = `${JSON.stringify(accept)} ${args.join(' ')}`;
      const text = JSON.stringify({ project: 'p', conventions: [], accept });
      const root = project({ ...TREE, 'AGENTS.md': '# Keep this\n', '.collet/config.json': text });
      const before = files(root);
      const out = mount(root, args);
      assert.equal(out.status, 2, label);
      assert.match(out.stderr, /config\.json cannot be read as collet's config: its "accept" field is not a string/, label);
      assert.match(out.stderr, /Nothing was written/, label);
      assert.deepEqual(files(root), before, label);
    }
  }
});

test('mounting refuses a directory that is not there rather than creating one', () => {
  const out = mount(join(project({}), 'nope'));
  assert.equal(out.status, 2);
  assert.match(out.stderr, /usage:/);
});

// The bundle checks' shared runtime gets collet's fixes on a remount like collet's other files, but
// only while it holds what collet wrote: a project may edit it, and a remount keeps those edits.
test('a remount refreshes a source check collet wrote and keeps one the project edited', () => {
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  const template = readFileSync(join(TEMPLATES, 'source.mjs'), 'utf8');
  const earlier = 'export function checkSource() { return { fires: false }; }\nexport function liveSource() { return { fires: false }; }\n';
  const root = project({ ...TREE, '.collet/source.mjs': `// collet:source ${hash(earlier)} - an earlier mount\n${earlier}` });
  const out = mount(root);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /\.collet\/source\.mjs \(refreshed/);
  assert.match(out.stdout, /Proving the mounted checks against their examples/);
  const current = readFileSync(join(root, '.collet', 'source.mjs'), 'utf8');
  assert.match(current, new RegExp(`^// collet:source ${hash(template)} `));
  assert.ok(current.endsWith(template));
  assert.match(mount(root).stdout, /\.collet\/source\.mjs \(already current\)/);

  const edited = `${current}// The project's own line.\n`;
  writeFileSync(join(root, '.collet', 'source.mjs'), edited, 'utf8');
  const kept = mount(root);
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.match(kept.stdout, /\.collet\/source\.mjs \(kept: it has edits of its own/);
  assert.equal(readFileSync(join(root, '.collet', 'source.mjs'), 'utf8'), edited);
});

test('a source check equal to the template but missing its first line is refreshed', () => {
  const template = readFileSync(join(TEMPLATES, 'source.mjs'), 'utf8');
  const root = project({ ...TREE, '.collet/source.mjs': template });
  const out = mount(root);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /\.collet\/source\.mjs \(refreshed/);
  assert.match(readFileSync(join(root, '.collet', 'source.mjs'), 'utf8'), /^\/\/ collet:source [0-9a-f]{64} /);
});

test('--with names an opt-in check class, needs --checks and refuses an unknown class before writing', () => {
  const root = project({ ...TREE, 'package.json': '{}\n' });
  const bare = mount(root, ['--with', 'javascript-typescript.focused-test']);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /--with needs a check class and --checks/);
  const unknown = mount(root, ['--checks', '--with', 'javascript-typescript.no-such-class']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown check class for the selected editions: javascript-typescript\.no-such-class/);
  assert.equal(existsSync(join(root, '.collet')), false);
  const named = mount(root, ['--checks', '--with', 'javascript-typescript.focused-test']);
  assert.equal(named.status, 0, named.stdout + named.stderr);
  assert.match(named.stdout, /wrote {4}\.collet\/checks\/javascript-typescript\.focused-test\.mjs/);
});

// A bundle check the project took out on purpose must not come back with the next remount.
test('a removed check class stays out across remounts until the project restores it', () => {
  const id = 'javascript-typescript.focused-test';
  const root = project({ ...TREE, 'package.json': '{}\n' });
  assert.equal(mount(root, ['--checks']).status, 0);
  const configPath = join(root, '.collet', 'config.json');
  const config = readFileSync(configPath, 'utf8');
  const own = () => readdirSync(join(root, '.collet', 'checks')).filter((name) => name.startsWith(`${id}.`));
  const installed = own();
  assert.ok(installed.length >= 3);

  const removed = mount(root, ['--checks', '--remove', id]);
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.match(removed.stdout, new RegExp(`wrote {4}\\.collet/checks/${id} removed`));
  assert.deepEqual(own(), []);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).removed_checks, [id]);

  const again = mount(root, ['--checks']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(own(), []);
  assert.match(again.stdout, new RegExp(`kept {5}\\.collet/checks/${id} \\(removed by this project`));

  const restored = mount(root, ['--checks', '--restore', id]);
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.deepEqual(own(), installed);
  assert.equal(readFileSync(configPath, 'utf8'), config);
});

test('a project that removed nothing keeps its config and mount output, and a bad removal writes nothing', () => {
  const root = project({ ...TREE, 'package.json': '{}\n' });
  const first = mount(root, ['--checks']);
  assert.doesNotMatch(first.stdout, /removed/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, '.collet', 'config.json'), 'utf8'))), ['project', 'conventions', 'accept']);
  const other = project({ ...TREE, 'package.json': '{}\n' });
  for (const args of [['--remove', 'javascript-typescript.focused-test'], ['--checks', '--remove', 'javascript-typescript.nope'],
    ['--checks', '--remove', 'javascript-typescript.focused-test', '--with', 'javascript-typescript.focused-test']]) {
    const out = mount(other, args);
    assert.equal(out.status, 2, args.join(' '));
    assert.match(out.stderr, /Nothing was written/);
  }
  assert.equal(existsSync(join(other, '.collet')), false);
});

// The preflight proves new catalogue checks against the runtime the mount leaves in place.
const alwaysSilent = 'export function checkSource() { return { fires: false }; }\nexport function liveSource() { return { fires: false }; }\n';

test('a --checks remount over an unedited older runtime proves the new checks against the one it installs', () => {
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  const root = project({ ...TREE, 'package.json': '{}\n', '.collet/source.mjs': `// collet:source ${hash(alwaysSilent)} - an earlier mount\n${alwaysSilent}` });
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /\.collet\/source\.mjs \(refreshed/);
  assert.ok(readFileSync(join(root, '.collet', 'source.mjs'), 'utf8').endsWith(readFileSync(join(TEMPLATES, 'source.mjs'), 'utf8')));
});

test('an edited runtime is still the one the preflight proves new checks against', () => {
  const root = project({ ...TREE, 'package.json': '{}\n', '.collet/source.mjs': alwaysSilent });
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /failed its violation example/);
  assert.equal(readFileSync(join(root, '.collet', 'source.mjs'), 'utf8'), alwaysSilent);
});

test('a project without a runtime mounts its checks as before', () => {
  const root = project({ ...TREE, 'package.json': '{}\n' });
  const out = mount(root, ['--checks']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /wrote {4}\.collet\/source\.mjs\n/);
});
