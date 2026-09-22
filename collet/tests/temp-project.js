// Shared scaffolding for the suites. Every test gets its own temp project, and the project is
// removed when the test that created it ends, pass or fail, so nothing here depends on the order
// the suites run in or on a test reaching its last line.
//
// Debugging: COLLET_KEEP_FAILED_PROJECTS=1 keeps the projects of a failing test and prints where
// each one was kept. A passing test's projects are removed either way.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';

export const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
export const TEMPLATES = join(PLUGIN, 'templates');

const KEEP_FAILED = process.env.COLLET_KEEP_FAILED_PROJECTS === '1';
// The tests running now, innermost last. A project belongs to the test that created it, so a
// parent's project outlives the subtests that share it.
const running = [];
const owners = new Map();
const remove = (root) => rmSync(root, { recursive: true, force: true });

beforeEach((t) => {
  running.push(t);
});
afterEach((t) => {
  const index = running.lastIndexOf(t);
  if (index !== -1) running.splice(index, 1);
  for (const [root, owner] of owners) {
    if (owner !== t) continue;
    owners.delete(root);
    if (KEEP_FAILED && !t.passed) t.diagnostic(`kept ${root} (COLLET_KEEP_FAILED_PROJECTS)`);
    else remove(root);
  }
});
// A project made outside any test has no test to end with, and neither has one made by a test
// that loaded this file after it started, as scripts/ignore-policy.test.js does.
after(() => {
  for (const root of owners.keys()) remove(root);
});

/** A temp directory with the given files written into it, removed when its test ends. */
export function project(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'collet-test-'));
  owners.set(root, running.at(-1));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content, 'utf8');
  }
  return root;
}

export function mount(root, extra = []) {
  return spawnSync(process.execPath, [join(PLUGIN, 'scripts', 'mount.mjs'), root, ...extra], {
    encoding: 'utf8',
  });
}

export function task(root, args) {
  return spawnSync(process.execPath, [join(root, '.collet', 'task.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

export function checks(root, args = []) {
  return spawnSync(process.execPath, [join(root, '.collet', 'checks', 'run.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

/**
 * Run a hook the way a host does: the event on stdin, and the project wherever that host puts it.
 * Claude Code names it in the environment; `project: null` is a host that does not, and `cwd` is
 * where that host runs the hook from.
 */
export function hook(name, root, event = {}, { args = [], cwd = root, project = root } = {}) {
  const env = { ...process.env };
  if (project) env.CLAUDE_PROJECT_DIR = project;
  else delete env.CLAUDE_PROJECT_DIR;
  return spawnSync(process.execPath, [join(PLUGIN, 'hooks', name), ...args], {
    cwd,
    input: JSON.stringify(event),
    encoding: 'utf8',
    env,
  });
}

export function hookOutput(result) {
  if (!result.stdout.trim()) return null;
  return JSON.parse(result.stdout).hookSpecificOutput;
}

export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

export function repo(root) {
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: root,
    stdio: 'ignore',
  });
}

export const CONFIG = JSON.stringify(
  {
    project: 'A digest CLI. Node 22, no dependencies.',
    conventions: ['Dates are parsed in one place.'],
    accept: 'node -e 0',
  },
  null,
  2
);

export const TREE = {
  'src/cli.mjs': "import { build } from './digest.mjs';\nexport const run = () => build();\n",
  'src/digest.mjs': "import { t } from './theme.mjs';\nexport const build = () => t;\n",
  'src/theme.mjs': 'export const t = 1;\n',
  'src/report.mjs': 'export const r = 2;\n',
  'test/a.test.mjs': 'ok\n',
};
