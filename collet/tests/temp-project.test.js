// The helper's own promise: a temp project lasts as long as the test that made it, whatever the
// verdict, unless COLLET_KEEP_FAILED_PROJECTS asks to keep a failing test's project. A suite run
// in a child runner records real verdicts, so the failing case is a real failure, not a simulation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import test from 'node:test';

import { project } from './temp-project.js';

const HELPER = new URL('./temp-project.js', import.meta.url).href;

const suite = (log) => `import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import test from 'node:test';
import { project } from ${JSON.stringify(HELPER)};

const made = (name, root) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name, root }) + '\\n');

test('passes', () => made('passes', project()));
test('fails', () => {
  made('fails', project());
  assert.fail('planned failure');
});
test('parent', async (t) => {
  const root = project();
  made('parent', root);
  await t.test('child', () => made('child', project()));
  assert.equal(existsSync(root), true, 'the subtest removed its parent project');
});
`;

function runSuite(env = {}) {
  const dir = project();
  const log = join(dir, 'made.jsonl');
  writeFileSync(join(dir, 'lifecycle.test.mjs'), suite(log), 'utf8');
  const childEnv = { ...process.env, ...env };
  // A standalone runner, not another worker of this suite's runner, and only the switch given here.
  delete childEnv.NODE_TEST_CONTEXT;
  if (!env.COLLET_KEEP_FAILED_PROJECTS) delete childEnv.COLLET_KEEP_FAILED_PROJECTS;
  const out = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'lifecycle.test.mjs'], {
    cwd: dir, env: childEnv, encoding: 'utf8', windowsHide: true,
  });
  const made = Object.fromEntries(
    readFileSync(log, 'utf8').trim().split('\n').map((line) => Object.values(JSON.parse(line)))
  );
  return { out, made };
}

test('a helper project is removed when its test ends, pass or fail', () => {
  const { out, made } = runSuite();
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stdout, /^# pass 3\r?$/m);
  assert.match(out.stdout, /^# fail 1\r?$/m);
  assert.deepEqual(Object.keys(made).sort(), ['child', 'fails', 'parent', 'passes']);
  for (const [name, root] of Object.entries(made)) assert.equal(existsSync(root), false, `${name} left ${root}`);
});

test('COLLET_KEEP_FAILED_PROJECTS keeps only a failing test project and says where', (t) => {
  const { out, made } = runSuite({ COLLET_KEEP_FAILED_PROJECTS: '1' });
  t.after(() => rmSync(made.fails, { recursive: true, force: true }));
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.equal(existsSync(made.fails), true);
  assert.match(out.stdout, new RegExp(`# kept .*${basename(made.fails)} \\(COLLET_KEEP_FAILED_PROJECTS\\)`));
  for (const name of ['passes', 'parent', 'child']) assert.equal(existsSync(made[name]), false, name);
});
