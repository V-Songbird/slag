#!/usr/bin/env node
// The only writer of .collet/ledger.jsonl, and the only thing that runs a task's accept command.
//
//   node .collet/task.mjs add --title "..." --why "..." --scope "src/**,test/**" --accept "npm test"
//   node .collet/task.mjs status | list
//   node .collet/task.mjs widen --add <path> --why "<reason>"
//   node .collet/task.mjs close --left-out "..." --unverified "..."
//
// On a project whose work is planned elsewhere it writes nothing at all: `status` reads that
// plan and every mutating subcommand refuses, naming the tool that owns the record. Two ledgers
// and nobody knowing which is authoritative is worse than no ledger.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { COLLET, colletLedger, config, filled, HIDDEN_CHARACTERS, openTask, unseen } from './state.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE = join(ROOT, '.collet');
const LEDGER = join(STATE, 'ledger.jsonl');
const HANDOFF = join(STATE, 'handoff.md');
const GUARD_LOG = join(STATE, 'guard-log.jsonl');

const SKIP_DIRS = new Set(['.git', '.collet', 'node_modules', 'dist', 'build', 'coverage', '.venv', 'vendor']);
const CODE = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);
const TRY_EXT = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts'];
const SCOPE_CAP = 12;

// ---- scope ------------------------------------------------------------------------------------

function walk(root) {
  const found = [];
  const step = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        step(path);
      } else {
        found.push(relative(root, path).split('\\').join('/'));
      }
    }
  };
  step(root);
  return found;
}

function matches(pattern, path) {
  const glob = String(pattern).split('\\').join('/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!glob) return false;
  if (glob.endsWith('/**')) {
    const base = glob.slice(0, -3);
    return path === base || path.startsWith(`${base}/`);
  }
  if (glob.includes('*')) {
    const escape = (part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const source = glob
      .split('**')
      .map((chunk) => chunk.split('*').map(escape).join('[^/]*'))
      .join('.*');
    return new RegExp(`^${source}$`).test(path);
  }
  return path === glob || path.startsWith(`${glob}/`);
}

/** Every file in the repository the declared scope already covers, glob entries included. */
function filesInScope(root, scope) {
  const literal = scope.filter((entry) => !entry.includes('*'));
  const globbed = scope.filter((entry) => entry.includes('*'));
  const direct = literal.filter((entry) => isFile(join(root, entry)));
  if (!globbed.length && direct.length === literal.length) return direct;
  const tree = walk(root);
  return [...new Set([...direct, ...tree.filter((path) => scope.some((entry) => matches(entry, path)))])];
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A relative specifier resolved to a file in the repository, or null. */
function resolveSpecifier(from, spec) {
  const base = resolve(dirname(from), spec);
  if (isFile(base)) return base;
  for (const ext of TRY_EXT) {
    if (isFile(`${base}${ext}`)) return `${base}${ext}`;
  }
  for (const ext of TRY_EXT) {
    const inner = join(base, `index${ext}`);
    if (isFile(inner)) return inner;
  }
  return null;
}

/**
 * Closes a scope over the project files its own files import, one level deep.
 *
 * A declared scope answers "what may I write", and a session reading it as "where does this
 * belong" works inside the list instead of asking whether the list is right — the change then
 * lands in the module that merely calls the behaviour rather than the one that owns it. A change
 * to a module legitimately reaches the modules it imports, so the list starts there instead of one
 * command away from it. Both `add` and `widen` do this: widening is the moment the list was
 * already wrong, which is exactly when the closure matters most.
 */
export function expandScope(root, scope, from = scope) {
  const added = [];
  const known = new Set(scope);
  for (const entry of filesInScope(root, from)) {
    if (!CODE.has(extname(entry))) continue;
    const full = join(root, entry);
    let text = '';
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const target = resolveSpecifier(full, match[1]);
      if (!target) continue;
      const rel = relative(root, target).split('\\').join('/');
      if (!rel || rel.startsWith('..')) continue;
      if (known.has(rel) || scope.some((pattern) => matches(pattern, rel))) continue;
      known.add(rel);
      added.push({ path: rel, why: `imported by ${entry}` });
      if (added.length >= SCOPE_CAP) return { scope: [...scope, ...added.map((item) => item.path)], added };
    }
  }
  return { scope: [...scope, ...added.map((item) => item.path)], added };
}

// ---- ledger -----------------------------------------------------------------------------------

function writeLedger(tasks) {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(LEDGER, tasks.map((task) => JSON.stringify(task)).join('\n') + '\n', 'utf8');
}

/** Highest existing number plus one, so removing a line can never hand out an id twice. */
function nextId(tasks) {
  const highest = tasks.reduce((best, task) => {
    const value = Number.parseInt(String(task.id ?? '').replace(/^t/, ''), 10);
    return Number.isFinite(value) && value > best ? value : best;
  }, 0);
  return `t${highest + 1}`;
}

const VALUE_EXPECTED = {
  '--add': 'add',
  '--scope': 'scope',
  '--why': 'why',
  '--left-out': 'leftOut',
  '--unverified': 'unverified',
  '--title': 'title',
  '--accept': 'accept',
};

function flags(argv) {
  const out = { add: [], scope: [], why: null, leftOut: null, unverified: null, title: null, accept: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = VALUE_EXPECTED[argv[i]];
    if (!key) continue;
    const value = argv[i + 1];
    // A flag where a value belongs means the value was left out. Silently swallowing the next
    // flag produces a scope of "--accept", which matches nothing and fires on everything.
    if (value === undefined || VALUE_EXPECTED[value]) {
      console.error(`${argv[i]} needs a value`);
      process.exit(2);
    }
    if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = value;
    i += 1;
  }
  return out;
}

function list(values) {
  return values
    .flatMap((value) => String(value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * The entries naming the harness's own files. The guard refuses those whatever a task lists (the
 * unverified list aside, which checks/scope.mjs keeps writable), so recording one in a scope would
 * promise a write that never comes.
 */
function harnessEntries(paths) {
  return paths.filter((path) => {
    const entry = path.split('\\').join('/').replace(/^\.\//, '').replace(/\/+$/, '');
    // The rule of harnessPath in checks/scope.mjs, which this CLI does not import so that a missing
    // or broken scope check still leaves status, add and close working: .collet itself or anything
    // under it, in any letter case, since a case-insensitive filesystem resolves .Collet/off to it.
    return `${entry}/`.toLowerCase().startsWith(`${COLLET}/`) && entry !== `${COLLET}/unverified.md`;
  });
}

/**
 * Stops before anything is written when a field holds characters a person does not see. The ledger
 * is read back into every session, so what nobody can review never gets into it. Each problem names
 * its field, a path by what shows of it, and never repeats the rest.
 */
function refuseUnseen(fields, outcome) {
  const problems = fields.map(([field, value]) => unseen(field, value)).filter(Boolean);
  if (!problems.length) return;
  for (const problem of problems) console.error(problem);
  console.error(`${outcome} Type the text again without them.`);
  process.exit(2);
}

const pathField = (flag, path) => `${flag} ${JSON.stringify(path.replace(HIDDEN_CHARACTERS, ''))}`;

function describe(task) {
  return [
    `task ${task.id} — ${task.title} [${task.status}]`,
    `  why:    ${task.why ?? ''}`,
    `  scope:  ${(task.scope ?? []).join(', ')}`,
    `  accept: ${task.accept ?? 'none recorded'}`,
    task.widenings?.length
      ? `  widened ${task.widenings.length}x: ${task.widenings.map((w) => `${w.path} (${w.why})`).join('; ')}`
      : '  widened 0x',
    task.status === 'done' ? `  left out: ${task.left_out}\n  not checked: ${task.unverified}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** What the guard logged, oldest first. A line that does not parse is skipped. */
function guardLog() {
  let lines = [];
  try {
    lines = readFileSync(GUARD_LOG, 'utf8').split('\n');
  } catch {
    return [];
  }
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** The last few refusals, so the log the guard writes is read by something. */
function recentDenials(limit = 3) {
  return guardLog()
    .filter((entry) => entry.reason)
    .slice(-limit);
}

/**
 * The last few guard calls of a task that started and never finished. The host cut them short and
 * may have run the call unjudged. A start younger than the guard's 10 s timeout may still be running.
 */
function reportUnfinished(id, limit = 3) {
  const entries = guardLog();
  const finished = new Set(entries.map((entry) => entry.finish));
  const calls = entries
    .filter((entry) => entry.start && entry.task === id && !finished.has(entry.start) && Date.now() - Date.parse(entry.at) > 10_000)
    .slice(-limit);
  if (!calls.length) return;
  console.log(`\n  ${calls.length} guard call(s) did not finish, so the host may have run them unjudged:`);
  for (const line of calls) console.log(`    ${line.at.slice(0, 19)}  ${line.tool} ${line.call}`);
}

/**
 * After a task closes, the log without what no command reads any more: the task's calls that
 * finished, their plain finish records and the markers that reported its calls cut short. Every
 * refusal, every call that never finished, every other task's record and every line that does not
 * parse stay, in their order. The guard may append while this runs, so the bytes past what was read
 * are copied over just before the rename. Any failure leaves the log as it was.
 */
function pruneGuardLog(id) {
  const temp = `${GUARD_LOG}.${process.pid}.tmp`;
  try {
    const read = readFileSync(GUARD_LOG);
    const lines = read.toString('utf8').split('\n');
    const entries = lines.map((line) => {
      try {
        const entry = JSON.parse(line);
        return entry && typeof entry === 'object' ? entry : null;
      } catch {
        return null;
      }
    });
    const finished = new Set(entries.flatMap((entry) => (entry?.finish ? [entry.finish] : [])));
    const starts = new Set(entries.flatMap((entry) => (entry?.start && entry.task === id ? [entry.start] : [])));
    const done = new Set([...starts].filter((start) => finished.has(start)));
    const kept = lines.filter((line, index) => {
      const entry = entries[index];
      if (!entry) return true;
      if (entry.start && entry.task === id) return !done.has(entry.start);
      if (entry.finish && !entry.reason) return !done.has(entry.finish);
      if (entry.reported) return !starts.has(entry.reported);
      return true;
    });
    if (kept.length === lines.length) return;
    writeFileSync(temp, kept.join('\n'));
    const appended = readFileSync(GUARD_LOG).subarray(read.length);
    if (appended.length) appendFileSync(temp, appended);
    renameSync(temp, GUARD_LOG);
  } catch {
    rmSync(temp, { force: true });
  }
}

// ---- commands ---------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const args = flags(rest);
const tasks = colletLedger(ROOT);
const task = openTask(ROOT);

switch (command) {
  case 'add': {
    const settings = config(ROOT) ?? {};
    if (!filled(settings.project) || !filled(settings.accept)) {
      console.error('.collet/config.json still carries its placeholders.');
      console.error('Fill in the project line and the accept command before opening a task: a');
      console.error('session is told that file before it reads anything, and REPLACE ME is not a fact.');
      process.exit(2);
    }
    const accept = args.accept ?? filled(settings.accept);
    const scope = list(args.scope);
    if (!args.title || !args.why || !scope.length || !accept) {
      console.error('add needs --title, --why, --scope (repeatable) and an accept command');
      console.error('--accept is refused when empty on purpose: a task with no command that can tell');
      console.error('you it worked is not defined yet. If you cannot name one, say so instead.');
      process.exit(2);
    }
    refuseUnseen(
      [
        ['--title', args.title],
        ['--why', args.why],
        ...scope.map((path) => [pathField('--scope', path), path]),
        [args.accept ? '--accept' : 'the accept command in .collet/config.json', accept],
      ],
      'No task was opened.'
    );
    if (task) {
      console.error(`task ${task.id} is still open. Close it before opening another.`);
      process.exit(2);
    }
    const harness = harnessEntries(scope);
    if (harness.length) {
      console.error(`${harness.join(', ')}: the harness's own files cannot join a task, so no task was opened.`);
      console.error('With no task open they are writable now: add the check or make the change first,');
      console.error('then open the task without them.');
      process.exit(2);
    }
    const { scope: closed, added } = expandScope(ROOT, scope);
    const entry = {
      id: nextId(tasks),
      title: args.title,
      why: args.why,
      status: 'in_progress',
      scope: closed,
      accept,
      opened: new Date().toISOString().slice(0, 10),
      widenings: [],
      left_out: null,
      unverified: null,
    };
    writeLedger([...tasks, entry]);
    console.log(describe(entry));
    if (added.length) {
      console.log(`\n  ${added.length} file(s) added to the scope because the files named import them:`);
      for (const item of added) console.log(`    ${item.path}  (${item.why})`);
    }
    break;
  }

  case 'status': {
    if (!task) {
      console.log('no task open — nothing is being enforced');
      break;
    }
    console.log(describe(task));
    const denials = recentDenials();
    if (denials.length) {
      console.log(`\n  last ${denials.length} refusal(s):`);
      for (const line of denials) console.log(`    ${line.at?.slice(0, 19) ?? ''}  ${line.reason}`);
    }
    reportUnfinished(task.id);
    break;
  }

  case 'list':
    for (const entry of tasks) console.log(`${describe(entry)}\n`);
    break;

  case 'widen': {
    if (!task) {
      console.error('no task open to widen');
      process.exit(2);
    }
    const added = list(args.add);
    if (!added.length || !args.why) {
      console.error('widen needs --add <path> (repeatable) and --why "<reason>"');
      process.exit(2);
    }
    refuseUnseen([...added.map((path) => [pathField('--add', path), path]), ['--why', args.why]], 'Nothing was widened.');
    const harness = harnessEntries(added);
    if (harness.length) {
      console.error(`${harness.join(', ')}: the harness's own files cannot join a task, so nothing was widened.`);
      console.error('Change the harness between tasks: finish and close this one with');
      console.error('node .collet/task.mjs close --left-out "..." --unverified "...", add the check or make');
      console.error('the change with no task open, then open the next task.');
      process.exit(2);
    }
    const entry = tasks.filter((item) => item.status === 'in_progress').pop();
    // Closed over the paths being added, not over the whole list again: widening for one reason
    // should not quietly pull in a file that some already-listed module happens to import.
    const { scope: closed, added: pulled } = expandScope(
      ROOT,
      [...new Set([...(entry.scope ?? []), ...added])],
      added
    );
    const today = new Date().toISOString().slice(0, 10);
    entry.scope = closed;
    entry.widenings = [
      ...(entry.widenings ?? []),
      ...added.map((path) => ({ path, why: args.why, at: today })),
      ...pulled.map((item) => ({ path: item.path, why: item.why, at: today })),
    ];
    writeLedger(tasks);
    console.log(`scope widened: ${entry.scope.join(', ')}`);
    if (pulled.length) {
      console.log(`\n  ${pulled.length} file(s) came with them, because the files named import them:`);
      for (const item of pulled) console.log(`    ${item.path}  (${item.why})`);
    }
    break;
  }

  case 'close': {
    if (!task) {
      console.error('no task open to close');
      process.exit(2);
    }
    if (!args.leftOut || !args.unverified) {
      console.error('close needs --left-out "<what you did not do>" and --unverified "<what nobody has checked>"');
      console.error('"nothing" is a valid answer for either, and it goes on the record as a claim.');
      process.exit(2);
    }
    // Both go into the ledger and .collet/unverified.md, which sessions read back.
    refuseUnseen(
      [
        ['--left-out', args.leftOut],
        ['--unverified', args.unverified],
      ],
      `Task ${task.id} stays open; the accept command was not run.`
    );
    // Reported, never refused: the live checks below still read what such a call changed.
    reportUnfinished(task.id);

    // The live checks first: a green accept command does not prove the scope held or that no
    // other admitted check found a mistake in the working tree. Every check must have run:
    // an unavailable Git baseline or a skipped custom check cannot support a successful close.
    // An empty check directory otherwise reports zero failures, even in strict mode.
    if (!existsSync(join(STATE, 'checks', 'scope.mjs'))) {
      console.error(`The required scope check is missing. Task ${task.id} stays open.`);
      console.error('Restore .collet/checks/scope.mjs before closing; the accept command was not run.');
      process.exit(1);
    }
    const checks = ['.collet/checks/run.mjs', '--live', '--strict'];
    console.log(`running checks: node ${checks.join(' ')}`);
    const checked = spawnSync(process.execPath, checks, { cwd: ROOT, stdio: 'inherit' });
    if (checked.status !== 0) {
      console.error(`\nLive checks failed. Task ${task.id} stays open.`);
      console.error('Resolve failed or unavailable checks reported above before closing; the accept command was not run.');
      process.exit(1);
    }

    console.log(`\nrunning accept command: ${task.accept}`);
    const run = spawnSync(task.accept, { cwd: ROOT, shell: true, stdio: 'inherit' });
    if (run.status !== 0) {
      console.error(`accept command failed (exit ${run.status ?? 'null'}). Task ${task.id} stays open.`);
      process.exit(1);
    }

    const entry = tasks.filter((item) => item.status === 'in_progress').pop();
    entry.status = 'done';
    entry.left_out = args.leftOut;
    entry.unverified = args.unverified;
    entry.closed = new Date().toISOString().slice(0, 10);
    writeLedger(tasks);

    const unverified = join(STATE, 'unverified.md');
    const header = existsSync(unverified) ? readFileSync(unverified, 'utf8').replace(/\s*$/, '') : '# Not checked\n';
    writeFileSync(
      unverified,
      `${header}\n- ${entry.closed} ${entry.id}: ${args.unverified}\n- ${entry.closed} ${entry.id} left out: ${args.leftOut}\n`,
      'utf8'
    );

    // The handoff described a task that is now finished. Left behind, it is stated at every
    // future session start as if the work were still open.
    rmSync(HANDOFF, { force: true });
    pruneGuardLog(entry.id);

    console.log(`task ${entry.id} closed. Nothing changed outside its files, and the accept command exited 0.`);
    break;
  }

  default:
    console.log('usage: node .collet/task.mjs add|status|list|widen|close');
    process.exit(command ? 2 : 0);
}
