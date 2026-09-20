#!/usr/bin/env node
// PreToolUse: refuse a write outside the open task's files.
//
// The check itself lives in the project — `.collet/checks/scope.mjs` — so the same code that
// refuses a write here also runs at commit time and in CI, where no plugin is installed. This
// file only wires an event to that check, and falls back to the plugin's own copy when the
// project's is missing, so that deleting one file cannot silently disarm the guard.
//
// The host is the first argument: `claude` (also Codex, which speaks the same shape) or
// `antigravity`. It decides how the call is read off the event and how the answer is written.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { COLLET, host, mounted, projectModule, readEvent, root } from './lib.js';

/** The refusal for this call, or null. Every way of not knowing is null: this guard fails open. */
async function refusal(dir, call) {
  if (!mounted(dir)) return null;
  const state = await projectModule(dir, 'state.mjs');
  const task = state?.openTask(dir);
  // With no open task nothing is enforced. Documented, not accidental: opening one is a command
  // nobody runs by accident.
  if (!task) return null;
  const check = await projectModule(dir, join('checks', 'scope.mjs'));
  if (typeof check?.check !== 'function') return null;
  try {
    const result = check.check({ root: dir, task, call });
    return result?.fires ? { task, reason: result.reason } : null;
  } catch {
    return null; // a check that throws must not stop the session
  }
}

const event = readEvent();
const adapter = host(process.argv[2]);
const dir = root(event);
const call = adapter.call(event);
const refused = await refusal(dir, call);

if (refused) {
  try {
    appendFileSync(
      join(dir, COLLET, 'guard-log.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), task: refused.task.id, tool: call.tool, reason: refused.reason }) + '\n'
    );
  } catch {
    /* the refusal matters more than the record of it */
  }
}

const answer = refused
  ? adapter.deny(
      `${refused.reason} If the file is genuinely part of the task, widen it first: ` +
        `node .collet/task.mjs widen --add <path> --why "<reason>". That is allowed and recorded. ` +
        `Otherwise leave it alone and say in your summary what you found instead.`
    )
  : adapter.allow();
if (answer) process.stdout.write(JSON.stringify(answer));
