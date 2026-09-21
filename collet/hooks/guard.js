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
import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { COLLET, host, mounted, projectModule, readEvent, root } from './lib.js';

const SCOPE = 'scope.mjs';

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

/** The refusal for this call, or null. Every way of not knowing is null: this guard fails open. */
async function refusal(dir, call) {
  if (!mounted(dir)) return null;
  const state = await projectModule(dir, 'state.mjs');
  const task = state?.openTask(dir);
  // With no open task nothing is enforced. Documented, not accidental: opening one is a command
  // nobody runs by accident.
  if (!task) return null;
  for (const file of checkFiles(dir)) {
    const check = await projectModule(dir, join('checks', file));
    if (typeof check?.check !== 'function') continue;
    let result;
    try {
      result = check.check({ root: dir, task, call });
    } catch {
      continue; // a check that throws must not stop the session, nor the checks after it
    }
    if (result?.fires) return { task, file, id: check.id ?? file.replace(/\.mjs$/, ''), reason: result.reason };
  }
  return null;
}

// Scope is the one check whose remedy is a command. Every other check caught a mistake inside the
// edit itself, where widening the task would be the wrong move and worth refusing to suggest.
const REMEDY = {
  [SCOPE]:
    ` If the file is genuinely part of the task, widen it first: ` +
    `node .collet/task.mjs widen --add <path> --why "<reason>". That is allowed and recorded. ` +
    `Otherwise leave it alone and say in your summary what you found instead.`,
  other:
    ` Fix the edit rather than working around the check. If this is a false alarm, leave the check ` +
    `alone and say so in your summary.`,
};

const event = readEvent();
const adapter = host(process.argv[2]);
const dir = root(event);
const call = adapter.call(event);
const refused = await refusal(dir, call);

if (refused) {
  try {
    appendFileSync(
      join(dir, COLLET, 'guard-log.jsonl'),
      JSON.stringify({
        at: new Date().toISOString(),
        task: refused.task.id,
        check: refused.id,
        tool: call.tool,
        reason: refused.reason,
      }) + '\n'
    );
  } catch {
    /* the refusal matters more than the record of it */
  }
}

const answer = refused
  ? adapter.deny(refused.reason + (REMEDY[refused.file] ?? REMEDY.other))
  : adapter.allow();
if (answer) process.stdout.write(JSON.stringify(answer));
