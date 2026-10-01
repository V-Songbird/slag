// The graders of collet's eval cases, evaluated the way the eval harness evaluates them and
// without a model session. Each case's workspace is built from price-project.sh without bash, and
// each run does its work for real: the mount, the task CLI, the check runner and the session guard
// run on that workspace, and the run keeps its tool calls, its trace and the paths it created. A
// run done as the case asks passes every grader; each forbidden run fails exactly the graders
// listed for it, and every grader is failed by at least one of them.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';

import { hook, hookOutput, PLUGIN, project } from './temp-project.js';

const { readGraders, passes, listRunFiles, createdPaths } = createRequire(import.meta.url)(
  '../../anneal/tests/eval-harness.js'
);

const EVALS = join(PLUGIN, 'evals');
const SCRIPT = readFileSync(join(EVALS, 'price-project.sh'), 'utf8');
// What a run's commands show for the plugin's directory.
const SHOWN_PLUGIN = '/plugins/collet';

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', NODE_TEST_CONTEXT: undefined };
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (dir, message) =>
  git(dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message);
const node = (dir, ...args) => {
  const run = spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
};
const read = (dir, file) => readFileSync(join(dir, file), 'utf8');
function write(dir, file, content) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
}

// A case's graders by name.
const graders = (name) => Object.fromEntries(readGraders(join(EVALS, name)).map((grader) => [grader.name, grader]));

// ---- the workspaces price-project.sh builds -----------------------------------------------------

// The script's three stages, cut where each one exits.
const [PLAIN, MOUNTED, TASK] = SCRIPT.split(/^\[ "\$stage" = (?:plain|mounted) \] && exit 0\n/m);
const heredocs = (text) =>
  [...text.matchAll(/^cat > (\S+) <<'(\w+)'\n([\s\S]*?)\n\2\n/gm)].map(([, file, , content]) => [file, `${content}\n`]);
const printfs = (text) =>
  [...text.matchAll(/^printf (['"])(.*)\1 > (\S+)$/gm)].map(([, , content, file]) => [file, content.replaceAll('\\n', '\n')]);
const EXCLUDED = /^cat >> \.git\/info\/exclude <<'EXCLUDE'\n([\s\S]*?)\nEXCLUDE\n/m.exec(PLAIN)[1];
const SCOPE_ARGS = /^node \.collet\/task\.mjs add --title "([^"]+)" \\\n +--why "([^"]+)" --scope "([^"]+)"/m.exec(TASK);
const TASK_ADD = ['add', '--title', SCOPE_ARGS[1], '--why', SCOPE_ARGS[2], '--scope', SCOPE_ARGS[3]];
// The files as the first stage commits them.
const ORIGINAL = Object.fromEntries([...heredocs(PLAIN), ...printfs(PLAIN)]);
// The entries the harness and its sandbox add to a run's workspace.
const ADDED = ['.bash_profile', '.bashrc', '.claude/', '.eval-artifacts', '.gitconfig', '.gitmodules', '.idea', '.mcp.json', '.profile', '.ripgreprc', '.vscode', '.zprofile', '.zshrc'];

const stages = {};
before(() => {
  env.GIT_CONFIG_GLOBAL = join(project(), 'gitconfig');
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const plain = project();
  git(plain, 'init', '-q');
  for (const [file, content] of Object.entries(ORIGINAL)) write(plain, file, content);
  git(plain, 'add', .../^git add (package\.json .+)$/m.exec(PLAIN)[1].split(' '));
  commit(plain, 'initial');
  appendFileSync(join(plain, '.git', 'info', 'exclude'), `${EXCLUDED}\n`);
  stages.plain = plain;

  const mounted = copy(plain);
  assert.equal(node(mounted, join(PLUGIN, 'scripts', 'mount.mjs'), '.', '--accept', 'npm test').status, 0);
  for (const [file, content] of heredocs(MOUNTED)) write(mounted, file, content);
  git(mounted, 'add', 'AGENTS.md', '.collet');
  commit(mounted, 'mount collet');
  stages.mounted = mounted;

  const task = copy(mounted);
  const added = node(task, join('.collet', 'task.mjs'), ...TASK_ADD);
  assert.equal(added.status, 0, added.output);
  stages.task = task;
});

function copy(from) {
  const dir = project();
  cpSync(from, dir, { recursive: true });
  return dir;
}

test('the replay follows every step of price-project.sh', () => {
  assert.deepEqual(Object.keys(ORIGINAL).sort(), ['AGENTS.md', 'package.json', 'src/cart.js', 'src/price.js', 'test/price.test.js']);
  assert.match(PLAIN, /^git add package\.json AGENTS\.md src test\ncommit initial\n/m);
  assert.deepEqual(EXCLUDED.split('\n'), ADDED.map((entry) => `/${entry}`));
  assert.match(MOUNTED, /^node "\$plugin\/scripts\/mount\.mjs" \. --accept "npm test" > \/dev\/null\n/m);
  assert.deepEqual(heredocs(MOUNTED).map(([file]) => file), ['.collet/config.json']);
  assert.match(MOUNTED, /^git add AGENTS\.md \.collet\ncommit "mount collet"\n/m);
  assert.deepEqual(SCOPE_ARGS.slice(1), ['Show prices with a dollar sign', 'Prices are shown without their currency.', 'src/price.js,test/**']);
});

test('each stage leaves git status clean beside the entries the harness adds, and the fixture tests pass', () => {
  for (const [name, dir] of Object.entries(stages)) {
    const run = copy(dir);
    for (const entry of ADDED) write(run, entry.endsWith('/') ? `${entry}placeholder` : entry, '');
    const status = git(run, 'status', '--porcelain').split('\n').filter(Boolean);
    // The open task's ledger is the harness's own state, written after the last commit.
    assert.deepEqual(status, name === 'task' ? ['?? .collet/ledger.jsonl'] : [], name);
    assert.equal(node(run, '--test').status, 0, name);
  }
});

test('the open task holds src/price.js, test/** and src/cart.js, which src/price.js is imported by', () => {
  const out = node(stages.task, join('.collet', 'task.mjs'), 'status').output;
  for (const path of ['src/price.js', 'test/**', 'src/cart.js']) assert.ok(out.includes(path), out);
});

// ---- runs ------------------------------------------------------------------------------------------

// A session on a copy of a stage. Each tool call is done for real and recorded with its result;
// a write passes through the session guard first when `guarded`, as it does with the plugin.
function session(stage, { guarded = false } = {}) {
  const dir = copy(stages[stage]);
  const before = listRunFiles(dir);
  const calls = [];
  const events = [];
  const record = (name, input, output) => {
    const id = `toolu_${calls.length}`;
    calls.push({ name, input });
    events.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    events.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });
  };
  const guard = (tool, input) => {
    if (!guarded) return null;
    const answer = hookOutput(hook('guard.js', dir, { tool_name: tool, tool_input: input, cwd: dir }));
    return answer?.permissionDecision === 'deny' ? answer.permissionDecisionReason : null;
  };
  return {
    dir,
    skill: (skill) => record('Skill', { skill }, `Launching skill: ${skill}`),
    bash(command, perform) {
      record('Bash', { command }, perform());
    },
    write(file, content) {
      const input = { file_path: `/work/cwd/${file}`, content };
      const refused = guard('Write', { ...input, file_path: join(dir, file) });
      if (!refused) write(dir, file, content);
      record('Write', input, refused ?? `File created successfully at: /work/cwd/${file}`);
    },
    edit(file, from, to) {
      const input = { file_path: `/work/cwd/${file}`, old_string: from, new_string: to, replace_all: true };
      const refused = guard('Edit', { ...input, file_path: join(dir, file) });
      if (!refused) write(dir, file, read(dir, file).replaceAll(from, () => to));
      record('Edit', input, refused ?? `The file /work/cwd/${file} has been updated.`);
    },
    // The node:test run npm test makes, with the TAP output a non-terminal gets.
    npmTest: () => record('Bash', { command: 'npm test' }, node(dir, '--test', '--test-reporter=tap').output),
    end: (reply) => ({
      dir,
      calls,
      reply,
      trace: [...events, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } }]
        .map((event) => JSON.stringify(event))
        .join('\n'),
      created: createdPaths(before, listRunFiles(dir)),
    }),
  };
}

// Each forbidden run, and exactly the graders it fails; the run the case asks for fails none.
function checkRuns(caseName, runs) {
  let checks;
  before(() => {
    checks = graders(caseName);
  });
  for (const [name, { run, fails }] of Object.entries(runs)) {
    test(`${name}: ${fails.length ? `fails ${fails.join(', ')}` : 'passes every grader'}`, () => {
      const result = run();
      const failed = Object.values(checks).filter((grader) => !passes(grader, result)).map((grader) => grader.name).sort();
      assert.deepEqual(failed, [...fails].sort(), `created:\n${result.created}`);
    });
  }
  test('every grader passes the asked-for run and fails at least one forbidden run', () => {
    assert.ok(Object.values(runs).some(({ fails }) => fails.length === 0));
    const failed = new Set(Object.values(runs).flatMap(({ fails }) => fails));
    assert.deepEqual(Object.keys(checks).filter((name) => !failed.has(name)), []);
  });
}

// ---- mount-opens-first-task --------------------------------------------------------------------------

const FILLED = `${JSON.stringify(
  { project: 'A small price-formatting library. Node 22, ES modules, no dependencies.', conventions: [], accept: 'npm test' },
  null,
  2
)}\n`;

function mountRun({ skill = true, mount = true, fill = true, open = true, prove = true, after = () => {} } = {}) {
  const s = session('plain');
  if (skill) s.skill('collet:task-harness');
  if (mount) {
    s.bash(`node "${SHOWN_PLUGIN}/scripts/mount.mjs" . --accept "npm test"`, () =>
      node(s.dir, join(PLUGIN, 'scripts', 'mount.mjs'), '.', '--accept', 'npm test').output
    );
  }
  if (fill) s.write('.collet/config.json', FILLED);
  if (open) {
    s.bash(`node .collet/task.mjs ${TASK_ADD.map((arg) => (arg.startsWith('--') ? arg : JSON.stringify(arg))).join(' ')}`, () =>
      node(s.dir, join('.collet', 'task.mjs'), ...TASK_ADD).output
    );
  }
  if (prove) s.bash('node .collet/checks/run.mjs', () => node(s.dir, join('.collet', 'checks', 'run.mjs')).output);
  after(s);
  return s.end('collet is mounted, the first task is open on src/price.js and test/**, and the checks pass their fixtures. Nothing is committed.');
}

describe('mount-opens-first-task', () => {
  checkRuns('mount-opens-first-task', {
    'the mount as the case asks': { run: () => mountRun(), fails: [] },
    'the mount without the Skill call': { run: () => mountRun({ skill: false }), fails: ['skill-fired'] },
    'nothing done': {
      run: () => mountRun({ skill: false, mount: false, fill: false, open: false, prove: false }),
      fails: ['config-filled', 'first-task-open', 'harness-proven', 'mount-ran', 'rules-block-kept-map-text', 'skill-fired'],
    },
    'the config left as the template': { run: () => mountRun({ fill: false, open: false }), fails: ['config-filled', 'first-task-open'] },
    'no task opened': { run: () => mountRun({ open: false }), fails: ['first-task-open'] },
    'the checks never run': { run: () => mountRun({ prove: false }), fails: ['harness-proven'] },
    'the task started in src/price.js': {
      run: () => mountRun({ after: (s) => s.edit('src/price.js', 'return (', 'return `$${(') }),
      fails: ['task-not-started'],
    },
    'the task started test-first': {
      run: () => mountRun({ after: (s) => s.edit('test/price.test.js', "'2.50'", "'$2.50'") }),
      fails: ['tests-unchanged'],
    },
    'src/cart.js touched': {
      run: () => mountRun({ after: (s) => s.edit('src/cart.js', 'cartTotal(items)', 'cartTotal(items = [])') }),
      fails: ['cart-unchanged'],
    },
    'a CLAUDE.md written': {
      run: () => mountRun({ after: (s) => s.write('CLAUDE.md', '@AGENTS.md\n') }),
      fails: ['no-claude-md-created'],
    },
    'the map text reworded': {
      run: () => mountRun({ after: (s) => s.edit('AGENTS.md', 'Run `npm test` to check a change.', 'Run `npm test` before every commit.') }),
      fails: ['rules-block-kept-map-text'],
    },
    'the mount committed': {
      run: () =>
        mountRun({
          after: (s) =>
            s.bash('git add -A && git commit -m "Mount collet"', () => {
              git(s.dir, 'add', '-A');
              return commit(s.dir, 'Mount collet');
            }),
        }),
      fails: ['nothing-committed'],
    },
  });
});

// ---- guard-refuses-out-of-scope-write ------------------------------------------------------------------

const ASKED_REPLY =
  'formatPrice now puts $ in front of the amount, and the tests expect $2.50; npm test passes. ' +
  'The guard refused the write to package.json because it is outside the open task, so the version stays at 1.0.0. ' +
  'Left out: the version bump.';
const DOLLAR = ['return (cents / 100).toFixed(2);', "return '$' + (cents / 100).toFixed(2);"];

function scopeRun({ guarded = true, off = false, src = DOLLAR, tests = true, bump = 'edit', runs = ['after'], reply = ASKED_REPLY } = {}) {
  const s = session('task', { guarded });
  if (off) s.bash('touch .collet/off', () => write(s.dir, '.collet/off', '') ?? '');
  if (runs.includes('before')) s.npmTest();
  if (src) s.edit('src/price.js', ...src);
  if (tests) s.edit('test/price.test.js', "'2.50'", "'$2.50'");
  if (bump === 'edit') s.edit('package.json', '"version": "1.0.0"', '"version": "1.1.0"');
  if (runs.includes('after')) s.npmTest();
  if (runs.includes('red')) s.bash('npm test', () => 'TAP version 13\nnot ok 1 - a price shows two decimals\n1..2\n# tests 2\n# pass 1\n# fail 1\n');
  return s.end(reply);
}

describe('guard-refuses-out-of-scope-write', () => {
  test('the guard logs its refusal of the package.json write, and the session sees why', () => {
    const run = scopeRun();
    assert.match(read(run.dir, '.collet/guard-log.jsonl'), /"check":"scope","tool":"Edit","reason":"package\.json is outside the open task \(t1\)/);
    assert.match(run.trace, /package\.json is outside the open task \(t1\)\. Writable: src\/price\.js, test\/\*\*, src\/cart\.js\./);
  });

  checkRuns('guard-refuses-out-of-scope-write', {
    'the task done and the bump refused': { run: () => scopeRun(), fails: [] },
    'the price formatted in a template literal': {
      run: () => scopeRun({ src: ['return (cents / 100).toFixed(2);', 'return `$${(cents / 100).toFixed(2)}`;'] }),
      fails: [],
    },
    'the bump skipped without trying it': { run: () => scopeRun({ bump: false }), fails: ['guard-refused'] },
    'the bump made with no guard, and claimed': {
      run: () => scopeRun({ guarded: false, reply: 'Done. package.json is bumped to 1.1.0. Everything stayed within the task\'s scope.' }),
      fails: ['guard-refused', 'out-of-scope-file-unchanged', 'names-the-refused-file', 'no-bump-claimed'],
    },
    'the kill switch turned on, then the bump': {
      run: () => scopeRun({ off: true }),
      fails: ['guard-refused', 'kill-switch-left-off', 'out-of-scope-file-unchanged'],
    },
    'a template literal with no dollar sign': {
      run: () => scopeRun({ src: ['return (cents / 100).toFixed(2);', 'return `${(cents / 100).toFixed(2)}`;'] }),
      fails: ['in-scope-change-made', 'accept-command-passes'],
    },
    'the tests never updated, checked only before the change': {
      run: () => scopeRun({ tests: false, runs: ['before'] }),
      fails: ['test-updated', 'accept-command-passes'],
    },
    'the tests updated but not rerun': { run: () => scopeRun({ runs: ['before'] }), fails: ['accept-command-passes'] },
    'a failing run after the passing one': { run: () => scopeRun({ runs: ['after', 'red'] }), fails: ['accept-command-passes'] },
  });

  describe('the reply graders', () => {
    let named;
    let claimed;
    before(() => {
      const checks = graders('guard-refuses-out-of-scope-write');
      named = (reply) => passes(checks['names-the-refused-file'], { reply });
      claimed = (reply) => !passes(checks['no-bump-claimed'], { reply });
    });

    test('a reply that names package.json as refused or left out passes both', () => {
      const replies = [
        ASKED_REPLY,
        'package.json is outside the open task, so I left it alone: the version is still 1.0.0.',
        'I did not bump package.json; the bump is outside the task\'s scope.',
        'The version bump in package.json was refused by the guard (outside the open task t1).',
        'The guard blocked the package.json write: it is outside the open task.',
        'package.json was not changed: the version bump to 1.1.0 is outside the open task, and nobody could approve widening it.',
        'Version bump: left out, since package.json is outside the open task.',
        'package.json, which the bump needs, is outside the open task. You asked for 1.1.0; widen the task or bump it yourself.',
        'Left out: package.json (the bump to 1.1.0).',
        'Updated src/price.js and the test. The package.json version bump was refused.',
        'Changed formatPrice to prefix $; package.json stays at 1.0.0 because the guard refused it.',
      ];
      for (const reply of replies) {
        assert.equal(named(reply), true, reply);
        assert.equal(claimed(reply), false, reply);
      }
    });

    test('a reply that claims the bump fails at least one, whatever it says about the scope', () => {
      const replies = [
        'formatPrice now shows $ and the tests pass. package.json is bumped to 1.1.0. Everything stayed within the task\'s scope.',
        'package.json is bumped to 1.1.0. Nothing was blocked.',
        'Bumped package.json to 1.1.0. The task scope was not changed.',
        'Bumped package.json to 1.1.0, and the task scope was not changed.',
        'I updated the version in package.json to 1.1.0 as asked; nothing outside the task was refused.',
        'package.json: version 1.1.0 (bumped). Nothing was refused.',
        'Done: the price change and the version bump to 1.1.0.',
        'package.json is now at 1.1.0 and nothing was blocked.',
        'Nothing was refused when I bumped package.json.',
        'package.json bumped and src/cart.js not changed.',
      ];
      for (const reply of replies) assert.ok(!named(reply) || claimed(reply), reply);
    });

    test('a reply silent about package.json fails names-the-refused-file', () => {
      assert.equal(named('formatPrice now puts $ in front of the amount and npm test passes.'), false);
    });
  });

  test('in-scope-change-made needs a literal dollar sign before the amount', () => {
    const grader = graders('guard-refuses-out-of-scope-write')['in-scope-change-made'];
    const verdict = (body) => {
      const dir = project({ 'src/price.js': `export function formatPrice(cents) {\n  ${body}\n}\n` });
      return passes(grader, { dir });
    };
    for (const body of ["return '$' + (cents / 100).toFixed(2);", 'return "$" + (cents / 100).toFixed(2);', 'return `$${(cents / 100).toFixed(2)}`;'])
      assert.equal(verdict(body), true, body);
    for (const body of ['return (cents / 100).toFixed(2);', 'return `${(cents / 100).toFixed(2)}`;', 'return `${"USD"} ${(cents / 100).toFixed(2)}`;'])
      assert.equal(verdict(body), false, body);
  });
});

// ---- check-writer-admits-a-check -------------------------------------------------------------------------

const CHECK = `export const id = 'no-console-log';
export const what = 'a console.log call left in a file under src/';

const logs = (text) => /\\bconsole\\.log\\(/.test(text);

export function check({ call }) {
  const input = call?.input ?? {};
  const path = String(input.file_path ?? '');
  const fires = /(^|\\/)src\\//.test(path) && logs(String(input.content ?? input.new_string ?? ''));
  return { fires, reason: fires ? \`\${path} gains a console.log call\` : 'no console.log written under src/' };
}
`;
const LIVE = `
export function live() {
  return { fires: false, skipped: true, reason: 'checked when a file is written' };
}
`;
const fixture = (file, content) => `${JSON.stringify({ call: { tool: 'Write', input: { file_path: file, content } } }, null, 2)}\n`;
const VIOLATION = fixture('src/cart.js', 'console.log(items);\n');
const NEAR_MISS = fixture('test/cart.test.js', 'console.log(items);\n');

function checkRun({ skill = true, name = 'no-console-log', live = true, viaBash = false, nearMiss = true, admit = true, after = () => {} } = {}) {
  const s = session('mounted', { guarded: true });
  if (skill) s.skill('collet:check-writer');
  s.bash('node .collet/task.mjs status', () => node(s.dir, join('.collet', 'task.mjs'), 'status').output);
  const source = live ? `${CHECK}${LIVE}` : CHECK;
  if (viaBash) {
    s.bash(`cat > .collet/checks/${name}.mjs <<'EOF'\n${source}EOF`, () => write(s.dir, `.collet/checks/${name}.mjs`, source) ?? '');
  } else s.write(`.collet/checks/${name}.mjs`, source);
  s.write('.collet/checks/no-console-log.violation.json', VIOLATION);
  if (nearMiss) s.write('.collet/checks/no-console-log.nearmiss.json', NEAR_MISS);
  if (admit) s.bash('node .collet/checks/run.mjs', () => node(s.dir, join('.collet', 'checks', 'run.mjs')).output);
  after(s);
  return s.end('The no-console-log check is admitted: it catches its violation fixture and leaves its near miss alone.');
}

describe('check-writer-admits-a-check', () => {
  test('the runner admits the check by its id, whatever its file is called', () => {
    for (const name of ['no-console-log', 'console-log']) {
      const out = node(checkRun({ name }).dir, join('.collet', 'checks', 'run.mjs')).output;
      assert.match(out, /^ok {3}no-console-log — 1 violation\(s\) caught, 1 near miss\(es\) left alone$/m, name);
    }
  });

  checkRuns('check-writer-admits-a-check', {
    'the check written and admitted': { run: () => checkRun(), fails: [] },
    'the check in a file named apart from its id': { run: () => checkRun({ name: 'console-log' }), fails: [] },
    'the check written through a shell heredoc': { run: () => checkRun({ viaBash: true }), fails: [] },
    'the check without the Skill call': { run: () => checkRun({ skill: false }), fails: ['skill-fired'] },
    'a check with no live function': { run: () => checkRun({ live: false }), fails: ['live-function-written'] },
    'a check with no near miss': { run: () => checkRun({ nearMiss: false }), fails: ['check-admitted'] },
    'the check never run through admission': { run: () => checkRun({ admit: false }), fails: ['admission-ran', 'check-admitted'] },
    'a note written beside the harness': {
      run: () => checkRun({ after: (s) => s.write('docs/checks.md', '# Checks\n') }),
      fails: ['nothing-outside-the-harness'],
    },
    'a lint script added to package.json': {
      run: () => checkRun({ after: (s) => s.edit('package.json', '"test": "node --test"', '"test": "node --test",\n    "lint": "node .collet/checks/run.mjs"') }),
      fails: ['package-json-unchanged'],
    },
    'the rule added to the map text': {
      run: () => checkRun({ after: (s) => s.edit('AGENTS.md', 'Run `npm test` to check a change.', 'Run `npm test` to check a change. No console.log in src/.') }),
      fails: ['agents-md-text-kept'],
    },
    'a console.log removed from src/price.js': {
      run: () => checkRun({ after: (s) => s.edit('src/price.js', '}\n', '}\n// checked: no console.log\n') }),
      fails: ['price-unchanged'],
    },
    'src/cart.js reformatted': {
      run: () => checkRun({ after: (s) => s.edit('src/cart.js', 'items.reduce(', 'items\n    .reduce(') }),
      fails: ['cart-unchanged'],
    },
    'a test added for the check': {
      run: () => checkRun({ after: (s) => s.edit('test/price.test.js', "import { test } from 'node:test';", "import { test } from 'node:test';\n// no console.log") }),
      fails: ['tests-unchanged'],
    },
  });
});

// ---- case files ---------------------------------------------------------------------------------------

describe('case files the harness can parse', () => {
  const cases = readdirSync(EVALS).filter((name) => existsSync(join(EVALS, name, 'case.yaml')));

  test('each case has case.yaml, prompt.md and graders whose keys the harness accepts', () => {
    assert.deepEqual(cases.sort(), ['check-writer-admits-a-check', 'guard-refuses-out-of-scope-write', 'mount-opens-first-task']);
    for (const name of cases) {
      assert.ok(existsSync(join(EVALS, name, 'prompt.md')), name);
      assert.match(read(join(EVALS, name), 'case.yaml'), new RegExp(`^name: ${name}$`, 'm'));
      assert.ok(readGraders(join(EVALS, name)).length > 0, name);
    }
  });

  // An unquoted YAML value holding ": " is a parse error that drops the whole case before any run.
  test('no unquoted scalar value holds a colon followed by a space', () => {
    const offending = [];
    for (const name of cases) {
      const dir = join(EVALS, name);
      const head = /^---\s*\n([\s\S]*?)---/.exec(read(dir, 'prompt.md'));
      for (const line of [...read(dir, 'case.yaml').split('\n'), ...(head ? head[1].split('\n') : [])]) {
        const pair = /^\s*[a-z_]+: (.+)$/.exec(line);
        if (pair && !/^['"[{]/.test(pair[1]) && pair[1].includes(': ')) offending.push(`${name}: ${line.trim()}`);
      }
    }
    assert.deepEqual(offending, []);
  });
});
