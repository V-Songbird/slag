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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { colletLedger, config, filled, foremanProject, openTask } from './state.mjs';

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

function describe(task) {
  return [
    `task ${task.id} — ${task.title} [${task.status}]`,
    `  why:    ${task.why ?? ''}`,
    `  scope:  ${(task.scope ?? []).join(', ')}`,
    `  accept: ${task.accept ?? '(the tool that owns the roadmap decides when this is done)'}`,
    task.widenings?.length
      ? `  widened ${task.widenings.length}x: ${task.widenings.map((w) => `${w.path} (${w.why})`).join('; ')}`
      : '  widened 0x',
    task.status === 'done' ? `  left out: ${task.left_out}\n  not checked: ${task.unverified}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The last few refusals, so the log the guard writes is read by something. */
function recentDenials(limit = 3) {
  if (!existsSync(GUARD_LOG)) return [];
  try {
    return readFileSync(GUARD_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function refuseUnderOtherOwner(command) {
  console.error('this project plans its work in ROADMAP.jsonl, which collet does not write.');
  console.error(`Use that plugin's own CLI for \`${command}\`; collet enforces the files it declares.`);
  console.error('`node .collet/task.mjs status` reads the open entry, and');
  console.error('`node .collet/checks/run.mjs --live` checks the tree against it.');
  process.exit(2);
}

// ---- commands ---------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const args = flags(rest);
const external = foremanProject(ROOT);
const tasks = colletLedger(ROOT);
const task = openTask(ROOT);

switch (command) {
  case 'add': {
    if (external) refuseUnderOtherOwner('add');
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
    if (task) {
      console.error(`task ${task.id} is still open. Close it before opening another.`);
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
    if (task.owner !== 'collet') {
      console.log("  ledger: ROADMAP.jsonl — collet enforces this entry's files and writes nothing");
    }
    const denials = recentDenials();
    if (denials.length) {
      console.log(`\n  last ${denials.length} refusal(s):`);
      for (const line of denials) console.log(`    ${line.at?.slice(0, 19) ?? ''}  ${line.reason}`);
    }
    break;
  }

  case 'list':
    if (external) {
      console.error('this project plans its work in ROADMAP.jsonl; list it with that plugin.');
      process.exit(2);
    }
    for (const entry of tasks) console.log(`${describe(entry)}\n`);
    break;

  case 'widen': {
    if (external) refuseUnderOtherOwner('widen');
    if (!task) {
      console.error('no task open to widen');
      process.exit(2);
    }
    const added = list(args.add);
    if (!added.length || !args.why) {
      console.error('widen needs --add <path> (repeatable) and --why "<reason>"');
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
    if (external) refuseUnderOtherOwner('close');
    if (!task) {
      console.error('no task open to close');
      process.exit(2);
    }
    if (!args.leftOut || !args.unverified) {
      console.error('close needs --left-out "<what you did not do>" and --unverified "<what nobody has checked>"');
      console.error('"nothing" is a valid answer for either, and it goes on the record as a claim.');
      process.exit(2);
    }

    // The scope first, and cheaply: a green command says the tests passed, never that the work
    // stayed where it said it would.
    console.log('checking the working tree against the task:');
    const scoped = spawnSync(process.execPath, [join(STATE, 'checks', 'run.mjs'), '--live'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (scoped.status !== 0) {
      console.error(`\nchanges landed outside ${task.id}. Task stays open.`);
      console.error('Widen the list with a reason, or put the change back:');
      console.error('  node .collet/task.mjs widen --add <path> --why "<reason>"');
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

    console.log(`task ${entry.id} closed. Nothing changed outside its files, and the accept command exited 0.`);
    break;
  }

  default:
    console.log('usage: node .collet/task.mjs add|status|list|widen|close');
    process.exit(command ? 2 : 0);
}
