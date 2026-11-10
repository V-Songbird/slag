#!/usr/bin/env node
// PreToolUse: refuse a call that one of the project's checks fires on.
//
// The checks themselves live in the project — `.collet/checks/*.mjs` — so the same code that
// refuses a write here also runs at commit time and in CI, where no plugin is installed. This
// file only wires an event to them, and falls back to the plugin's own copy of `scope.mjs` when
// the project's is missing, so that deleting one file cannot silently disarm the guard.
//
// The host is the first argument: `claude` (also Codex, which speaks the same shape) or
// `antigravity`. It decides how the call is read off the event and how the answer is written.
import { appendFileSync, closeSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { COLLET, config, host, mounted, projectModule, readEvent, root } from './lib.js';

const SCOPE = 'scope.mjs';
// A write outside the open task is refused only in a project whose config sets this key to true.
// Everywhere else it goes ahead with a note, and the scope check at close counts it.
const REFUSE_OUTSIDE = 'refuse_out_of_scope_writes';
const LOG = 'guard-log.jsonl';
// hooks.json gives the guard 10 s, and a host that cuts it short lets the call go ahead unjudged.
// A start older than that with no finish is such a call, not one still running beside this one.
const TIMEOUT_MS = 10_000;
const TAIL_BYTES = 64 * 1024;
// One id per guard call, so that its finish can be matched to its start.
const RUN = `${Date.now()}-${process.pid}`;

// Every check the project owns, scope first and the rest in a stable order. `scope.mjs` is named
// even when the directory cannot be read: projectModule falls back to the plugin's own copy, and
// an unreadable directory is one check rather than none.
function checkFiles(dir) {
  let rest = [];
  try {
    rest = readdirSync(join(dir, COLLET, 'checks'))
      .filter((name) => name.endsWith('.mjs') && name !== 'run.mjs' && name !== SCOPE)
      .sort();
  } catch {
    /* fall through to scope alone */
  }
  return [SCOPE, ...rest];
}

/**
 * What the checks say about this call: `refused`, the refusal or null, and `outside`, a write
 * outside the open task that the project lets through, or null. The harness's own files and every
 * other check refuse whatever the config says. Every way of not knowing is null: this guard fails
 * open.
 */
async function judged(dir, task, call) {
  const strict = config(dir)[REFUSE_OUTSIDE] === true;
  let outside = null;
  for (const file of checkFiles(dir)) {
    const check = await projectModule(dir, join('checks', file));
    if (typeof check?.check !== 'function') continue;
    let result;
    try {
      result = check.check({ root: dir, task, call });
    } catch {
      continue; // a check that throws must not stop the session, nor the checks after it
    }
    if (result?.fires) {
      const id = check.id ?? file.replace(/\.mjs$/, '');
      const found = { file, id, reason: result.reason, harness: result.harness === true };
      if (file === SCOPE && !found.harness && !strict) {
        outside = found;
        continue; // the checks after scope still judge the edit itself
      }
      return { refused: found, outside: null };
    }
  }
  return { refused: null, outside };
}

// Scope is the one check whose remedy is a command. Every other check caught a mistake inside the
// edit itself, where widening the task would be the wrong move and worth refusing to suggest.
const REMEDY = {
  [SCOPE]:
    ` Widen the task only for a file the stated task needs: ` +
    `node .collet/task.mjs widen --add <path> --why "<reason>". A file the task does not need ` +
    `stays out, even when the person asks for it. If a needed file goes beyond what the person ` +
    `asked for, ask them first. ` +
    `When the file is not needed, or nobody can be asked, leave it alone and name it in your summary.`,
  // The harness's own files are refused whatever the task lists, so widening would send the
  // session round in a circle.
  harness:
    ` Widening cannot make a harness file writable. Change the harness between tasks: finish and ` +
    `close the open task with node .collet/task.mjs close --left-out "..." --unverified "...", add ` +
    `the check or make the change with no task open, then open the next task. Until then, name ` +
    `what the harness needs in your summary.`,
  other:
    ` Fix the edit rather than working around the check. If this is a false alarm, leave the check ` +
    `alone and say so in your summary.`,
};
// Scope marks a refusal of the harness's own files with `harness: true`; the wording is for people.
function remedy({ file, harness }) {
  if (file === SCOPE && harness) return REMEDY.harness;
  return REMEDY[file] ?? REMEDY.other;
}

/** Append one record to the guard log. The log never decides: a record it cannot write is skipped. */
function record(dir, entry) {
  try {
    appendFileSync(join(dir, COLLET, LOG), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    /* the answer matters more than the record of it */
  }
}

/** Earlier guard calls of this task that started, never finished and were not reported yet. */
function cutShort(dir, taskId) {
  // The log gains two lines for every call the guard judges, so only its tail is read: a call cut
  // short is reported by one of the calls just after it.
  const tail = Buffer.alloc(TAIL_BYTES);
  let read = 0;
  try {
    const fd = openSync(join(dir, COLLET, LOG), 'r');
    try {
      read = readSync(fd, tail, 0, TAIL_BYTES, Math.max(0, fstatSync(fd).size - TAIL_BYTES));
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const entries = tail.toString('utf8', 0, read).split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const closed = new Set(entries.flatMap((entry) => [entry.finish, entry.reported]));
  return entries.filter(
    (entry) => entry.start && entry.task === taskId && !closed.has(entry.start) && Date.now() - Date.parse(entry.at) > TIMEOUT_MS
  );
}

/** The call in one line for the log: its command, or the file it writes. */
function described(call) {
  const input = call.input ?? {};
  return String(input.command ?? input.file_path ?? input.notebook_path ?? input.patch ?? '').replace(/\s+/g, ' ').slice(0, 200);
}

const event = readEvent();
const adapter = host(process.argv[2]);
const dir = root(event);
const call = adapter.call(event);
// With no open task nothing is enforced. Documented, not accidental: opening one is a command
// nobody runs by accident.
const task = mounted(dir) ? (await projectModule(dir, 'state.mjs'))?.openTask(dir) : null;
const earlier = task ? cutShort(dir, task.id) : [];
let refused = null;
let outside = null;
if (task) {
  // Written before any check runs: a guard cut short from here on leaves a start with no finish.
  record(dir, { start: RUN, task: task.id, tool: call.tool, call: described(call) });
  ({ refused, outside } = await judged(dir, task, call));
  record(dir, { finish: RUN, ...(refused && { task: task.id, check: refused.id, tool: call.tool, reason: refused.reason }) });
}

const notice = [
  ...(outside
    ? [`${outside.reason} The write goes ahead; node .collet/task.mjs close counts it against the task unless the task is widened for a file it needs or the change is undone.`]
    : []),
  ...earlier.map((entry) => `A guard call did not finish: ${entry.tool} ${entry.call} at ${entry.at}. The host may have run it unjudged; check what it changed.`),
].join(' ');
const answer = refused ? adapter.deny(`${refused.reason}${remedy(refused)}${notice && ` ${notice}`}`) : adapter.allow(notice);
if (answer) process.stdout.write(JSON.stringify(answer));
for (const entry of earlier) record(dir, { reported: entry.start });
