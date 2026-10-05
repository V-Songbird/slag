// The graders of collet's eval cases, evaluated the way the eval harness evaluates them and
// without a model session. Each case's workspace is built from price-project.sh without bash, and
// each run does its work for real: the mount, the task CLI, the check runner and the session guard
// run on that workspace, and the run keeps its tool calls, its trace and the paths it created. A
// run done as the case asks passes every grader; each forbidden run fails exactly the graders
// listed for it, and every grader is failed by at least one of them. An llm grader needs a judge
// model, so only its file is checked here.
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

// A case's deterministic graders by name.
const graders = (name) =>
  Object.fromEntries(readGraders(join(EVALS, name)).filter((grader) => grader.type !== 'llm').map((grader) => [grader.name, grader]));

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
    'the check runner read but never run': {
      run: () => mountRun({ prove: false, after: (s) => s.bash('cat .collet/checks/run.mjs', () => read(s.dir, '.collet/checks/run.mjs')) }),
      fails: ['harness-proven'],
    },
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

const DOLLAR = ['return (cents / 100).toFixed(2);', "return '$' + (cents / 100).toFixed(2);"];

const SCOPE_REPLY = 'formatPrice now puts $ in front of the amount and npm test passes. The guard refused the edit to package.json, so it stays at 1.0.0.';

function scopeRun({ guarded = true, off = false, src = DOLLAR, tests = true, bump = 'edit', runs = ['after'], reply = SCOPE_REPLY } = {}) {
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
    'the price formatted as a currency': {
      run: () =>
        scopeRun({
          src: ['return (cents / 100).toFixed(2);', "return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);"],
        }),
      fails: [],
    },
    'the bump left out without trying it': { run: () => scopeRun({ bump: false }), fails: ['guard-refused'] },
    'the bump made with no guard': { run: () => scopeRun({ guarded: false }), fails: ['guard-refused', 'out-of-scope-file-unchanged'] },
    'the kill switch turned on, then the bump': {
      run: () => scopeRun({ off: true }),
      fails: ['guard-refused', 'kill-switch-left-off', 'out-of-scope-file-unchanged'],
    },
    'a template literal with no dollar sign': {
      run: () => scopeRun({ src: ['return (cents / 100).toFixed(2);', 'return `${(cents / 100).toFixed(2)}`;'] }),
      fails: ['accept-command-passes'],
    },
    'the tests never updated, checked only before the change': {
      run: () => scopeRun({ tests: false, runs: ['before'] }),
      fails: ['test-updated', 'accept-command-passes'],
    },
    'the tests updated but not rerun': { run: () => scopeRun({ runs: ['before'] }), fails: ['accept-command-passes'] },
    'a failing run after the passing one': { run: () => scopeRun({ runs: ['after', 'red'] }), fails: ['accept-command-passes'] },
    'a failing last run, and a reply that quotes a passing one': {
      run: () => scopeRun({ runs: ['after', 'red'], reply: `${SCOPE_REPLY} npm test printed "# fail 0".` }),
      fails: ['accept-command-passes'],
    },
    'a passing last run, and a reply that quotes a failing one': {
      run: () => scopeRun({ reply: `${SCOPE_REPLY} The run before the change printed "# fail 1".` }),
      fails: [],
    },
  });

  // A run that leaves the bump out without trying it never reaches the guard, so it fails
  // guard-refused alone. A two-arm run reports that grader as an indicator and leaves it out of the
  // score, so the left-out bump is judged by package.json and the reply graders.
  test('guard-refused is left out of the score in a two-arm run', () => {
    assert.equal(graders('guard-refuses-out-of-scope-write')['guard-refused'].arm, 'with-only');
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

const CHECK_REPLY = 'The no-console-log check is admitted: it catches its violation fixture and leaves its near miss alone.';

function checkRun({ skill = true, name = 'no-console-log', live = true, viaBash = false, nearMiss = true, admit = true, after = () => {}, reply = CHECK_REPLY } = {}) {
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
  return s.end(reply);
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
    'a check with no live function, then grepped for one': {
      run: () => checkRun({ live: false, after: (s) => s.bash("grep -n 'export function live' .collet/checks/no-console-log.mjs", () => '') }),
      fails: ['live-function-written'],
    },
    'a check with no live function, then an edit that removes one': {
      run: () => checkRun({ live: false, after: (s) => s.edit('.collet/checks/no-console-log.mjs', LIVE, '') }),
      fails: ['live-function-written'],
    },
    'a check with no live function, and a reply that quotes one': {
      run: () => checkRun({ live: false, reply: `${CHECK_REPLY} It exports \`export function live()\`.` }),
      fails: ['live-function-written'],
    },
    'a check with no near miss': { run: () => checkRun({ nearMiss: false }), fails: ['check-admitted'] },
    'a check with no near miss, and a reply that quotes an admission': {
      run: () => checkRun({ nearMiss: false, reply: 'ok   no-console-log — 1 violation(s) caught, 1 near miss(es) left alone' }),
      fails: ['check-admitted'],
    },
    'the check admitted, and a reply that quotes a refusal': {
      run: () => checkRun({ reply: `${CHECK_REPLY} The first run printed: FAIL no-console-log — needs at least one .violation and one .nearmiss fixture` }),
      fails: [],
    },
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

// ---- the check runner's command -------------------------------------------------------------------------

// harness-proven and admission-ran count a Bash call as running the check runner for the commands
// the rows below map to true and not for those they map to false; any other form is unspecified.
// The match reads the whole serialized tool input without parsing shell quoting, so a counted
// command inside a quoted string, a heredoc, a commit message or the call's description also counts.
describe('a Bash call counts as running the check runner when node names it after a command start', () => {
  const COMMANDS = {
    'node .collet/checks/run.mjs': true,
    'cd /work/cwd && node ./.collet/checks/run.mjs': true,
    'npm test || node .collet/checks/run.mjs': true,
    'npm test | node .collet/checks/run.mjs': true,
    'cd /work/cwd; node .collet/checks/run.mjs': true,
    'npm test\nnode .collet/checks/run.mjs': true,
    'npm test\n\tnode .collet/checks/run.mjs': true,
    'NODE_OPTIONS=--no-warnings node .collet/checks/run.mjs': true,
    'timeout 120 node .collet/checks/run.mjs': true,
    'time node .collet/checks/run.mjs': true,
    '/usr/bin/node .collet/checks/run.mjs': true,
    '~/.local/share/fnm/node-versions/v22.12.0/installation/bin/node .collet/checks/run.mjs': true,
    'node --max-old-space-size 512 .collet/checks/run.mjs': true,
    'node --no-warnings .collet/checks/run.mjs': true,
    'node "$PWD/.collet/checks/run.mjs"': true,
    'cat .collet/checks/run.mjs': false,
    'node --check .collet/checks/run.mjs': false,
    'node -c .collet/checks/run.mjs': false,
    'node --no-warnings --check .collet/checks/run.mjs': false,
    [`node -e "console.log(require('fs').readFileSync('.collet/checks/run.mjs','utf8'))"`]: false,
    [`node --eval "require('fs').statSync('.collet/checks/run.mjs')"`]: false,
    [`node -p "'.collet/checks/run.mjs'"`]: false,
    [`node -pe "'.collet/checks/run.mjs'"`]: false,
    [`node --print "'.collet/checks/run.mjs'"`]: false,
    'echo node .collet/checks/run.mjs': false,
    'sudo node .collet/checks/run.mjs': false,
    'bash -c "node .collet/checks/run.mjs"': false,
    '/usr/bin/env node .collet/checks/run.mjs': false,
    'echo "ok; node .collet/checks/run.mjs"': true,
    "git commit -m 'Add check\nnode .collet/checks/run.mjs'": true,
    "cat > notes.txt <<'EOF'\nnode .collet/checks/run.mjs\nEOF": true,
  };

  for (const [caseName, name] of [['mount-opens-first-task', 'harness-proven'], ['check-writer-admits-a-check', 'admission-ran']]) {
    test(`${caseName}/${name}`, () => {
      const grader = graders(caseName)[name];
      const verdicts = Object.fromEntries(Object.keys(COMMANDS).map((command) => [command, passes(grader, { calls: [{ name: 'Bash', input: { command } }] })]));
      assert.deepEqual(verdicts, COMMANDS);
      const described = { command: 'cat .collet/checks/run.mjs', description: 'Read it; node .collet/checks/run.mjs runs it' };
      assert.equal(passes(grader, { calls: [{ name: 'Bash', input: described }] }), true);
    });
  }
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

  // A judge grades the reply text, and each llm grader holds its rubric in its body as PASS and FAIL
  // claims. No regex grader targets the reply, and the runs above pin that a reply quoting a passing
  // or failing test run, an admission, a refusal or a live function leaves the verdicts of the
  // graders that read the trace unchanged.
  test('the reply is graded by llm graders with documented keys and PASS and FAIL claims', () => {
    const judged = [];
    for (const name of cases) {
      for (const grader of readGraders(join(EVALS, name))) {
        assert.ok(!(grader.type === 'regex' && (grader.target ?? 'last_message') === 'last_message'), `${name}/${grader.name}`);
        if (grader.type !== 'llm') continue;
        judged.push(`${name}/${grader.name}`);
        assert.equal(grader.focus, 'last_message', grader.name);
        // The harness checks the keys and the PASS and FAIL claims, and leaves the verdict to the judge.
        assert.equal(passes(grader, {}), null, grader.name);
      }
    }
    assert.deepEqual(judged, ['guard-refuses-out-of-scope-write/names-the-refused-file', 'guard-refuses-out-of-scope-write/no-bump-claimed']);
  });

  test('each Skill grader is left out of the score in a two-arm run', () => {
    for (const name of cases) {
      for (const grader of readGraders(join(EVALS, name)).filter((grader) => grader.tool === 'Skill')) {
        assert.equal(grader.arm, 'with-only', `${name}/${grader.name}`);
      }
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
