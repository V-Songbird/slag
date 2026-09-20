#!/usr/bin/env node
// PreToolUse: refuse a write outside the open task's files.
//
// The check itself lives in the project — `.collet/checks/scope.mjs` — so the same code that
// refuses a write here also runs at commit time and in CI, where no plugin is installed. This
// file only wires an event to that check, and falls back to the plugin's own copy when the
// project's is missing, so that deleting one file cannot silently disarm the guard.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { COLLET, deny, mounted, projectModule, readEvent, root } from './lib.js';

const dir = root();
if (!mounted(dir)) process.exit(0);

const state = await projectModule(dir, 'state.mjs');
if (!state) process.exit(0);

const task = state.openTask(dir);
// With no open task nothing is enforced. Documented, not accidental: opening one is a command
// nobody runs by accident.
if (!task) process.exit(0);

const check = await projectModule(dir, join('checks', 'scope.mjs'));
if (!check || typeof check.check !== 'function') process.exit(0);

const event = readEvent();
const call = { tool: event.tool_name ?? '', input: event.tool_input ?? {} };

let result = null;
try {
  result = check.check({ root: dir, task, call });
} catch {
  process.exit(0); // fail open: a check that throws must not stop the session
}

if (!result?.fires) process.exit(0);

try {
  appendFileSync(
    join(dir, COLLET, 'guard-log.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), task: task.id, tool: call.tool, reason: result.reason }) + '\n'
  );
} catch {
  /* the refusal matters more than the record of it */
}

deny(
  'PreToolUse',
  `${result.reason} If the file is genuinely part of the task, widen it first: ` +
    `node .collet/task.mjs widen --add <path> --why "<reason>". That is allowed and recorded. ` +
    `Otherwise leave it alone and say in your summary what you found instead.`
);
