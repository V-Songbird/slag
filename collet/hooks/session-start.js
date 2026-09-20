#!/usr/bin/env node
// SessionStart: state the open task, the files it may touch, the command that ends it and the
// conventions that constrain a change — before the model reads anything.
//
// Every line is a statement about the repository, never an order: text phrased as an out-of-band
// command can trip the model's injection defences and get shown to the person instead of used.
//
// Two things are deliberately never stated. A config value still carrying its placeholder says
// nothing, so it is dropped rather than read out as if it were a fact. And a handoff describing a
// task that is no longer open is stale by definition — repeating it would contradict the ledger in
// the same breath.
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { COLLET, config, emit, fileText, mounted, projectModule, root } from './lib.js';

const dir = root();
if (!mounted(dir)) process.exit(0); // not a collet project, or switched off: stay out of the way

const state = await projectModule(dir, 'state.mjs');
if (!state) process.exit(0);

const settings = config(dir);
const filled = state.filled;
const lines = [];

const project = filled(settings.project);
if (project) lines.push(project);

const task = state.openTask(dir);
if (task) {
  lines.push(
    `The open task is ${task.id} — "${task.title}" (status ${task.status}).` +
      ` Writable files: ${(task.scope ?? []).join(', ') || 'none declared'}.` +
      ` Writes outside that list are refused, and \`node .collet/task.mjs widen --add <path> --why "<reason>"\` is the way to extend it.` +
      ` The task ends when \`${task.accept}\` exits zero, which \`node .collet/task.mjs close\` runs after checking that nothing landed outside the list.`
  );
} else {
  lines.push('No task is open, and nothing is being enforced until one is opened.');
}

const conventions = (Array.isArray(settings.conventions) ? settings.conventions : [])
  .map(filled)
  .filter(Boolean);
if (conventions.length) lines.push(`Conventions that constrain a change here: ${conventions.join(' ')}`);

if (fileText(dir, 'unverified.md')) lines.push('What nobody has checked yet is in .collet/unverified.md.');

const handoff = fileText(dir, 'handoff.md');
if (handoff) {
  const stamped = /^task:\s*(\S+)/m.exec(handoff);
  if (task && stamped && stamped[1] === String(task.id)) {
    lines.push(`State carried over from the previous session:\n${handoff}`);
  } else {
    // It describes work that is finished or replaced. Saying it would contradict the line above.
    rmSync(join(dir, COLLET, 'handoff.md'), { force: true });
  }
}

emit('SessionStart', lines.join('\n'));
