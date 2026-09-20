// Shared scaffolding for the suites. Every test gets its own temp project and removes it again,
// so nothing here depends on the order the suites run in.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
export const TEMPLATES = join(PLUGIN, 'templates');

/** A temp directory with the given files written into it. */
export function project(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'collet-test-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content, 'utf8');
  }
  return root;
}

export function clean(root) {
  rmSync(root, { recursive: true, force: true });
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

/** Run a hook the way the host does: the event on stdin, the project in the environment. */
export function hook(name, root, event = {}) {
  return spawnSync(process.execPath, [join(PLUGIN, 'hooks', name)], {
    cwd: root,
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
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
