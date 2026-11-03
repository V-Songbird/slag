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
//
// Nor is a character a model reads and a person does not see: zero-width characters, the word
// joiner, a byte order mark past the start, bidi embeddings and isolates, and Unicode tags. The
// mount and the task CLI refuse them, but text edited in by hand, or written by an earlier collet,
// can still carry an order in them that nobody reviewing the file can read, and stating it would
// deliver that order every session. They are left out, and a closing line names the field that
// held them and their code points, counting tags and never decoding them. The joiner inside an
// emoji and the tags of a subdivision flag render, so they stay.
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { COLLET, config, cutShort, emit, fileText, finished, HIDDEN_REPORT, listsClaims, mounted, projectModule, readEvent, root, started, withoutHidden } from './lib.js';

const dir = root(readEvent());
if (!mounted(dir)) process.exit(0); // not a collet project, or switched off: stay out of the way

// Runs the host stopped at its timeout, read before this run marks itself: they are reported below.
const lastStart = cutShort(dir, 'session-start');
const lastHandoff = cutShort(dir, 'handoff');
const run = started(dir, 'session-start');

const state = await projectModule(dir, 'state.mjs');
if (!state) {
  finished(dir, 'session-start', run);
  process.exit(0);
}

const settings = config(dir);
const filled = state.filled;
const lines = [];

const visible = withoutHidden();

const configured = (field) =>
  (Array.isArray(settings[field]) ? settings[field] : [])
    .map((value) => visible(`${field} in .collet/config.json`, filled(value)))
    .filter(Boolean);

const project = visible('project in .collet/config.json', filled(settings.project));
if (project) lines.push(project);

const task = state.openTask(dir);
const id = task && visible('the id of the open task', String(task.id));
const accept = task && visible(`the accept command of task ${id}`, task.accept);
if (task) {
  const scope = (task.scope ?? []).map((path) => visible(`the scope of task ${id}`, path));
  lines.push(
    `The open task is ${id} — "${visible(`the title of task ${id}`, task.title)}" (status ${task.status}).` +
      ` Writable files: ${scope.join(', ') || 'none declared'}.` +
      ` Writes outside that list are refused. \`node .collet/task.mjs widen --add <path> --why "<reason>"\` extends it for a file the stated task needs; a file beyond what the person asked for needs their yes first.` +
      ` The task ends when \`${accept}\` exits zero, which \`node .collet/task.mjs close\` runs after checking that nothing landed outside the list.`
  );
} else {
  lines.push('No task is open, and nothing is being enforced until one is opened.');
}

// What the person asked to be consulted on, as a fact about the project; without a list, nothing.
const askFirst = configured('ask_first');
if (askFirst.length) {
  lines.push(
    `In this project the person is asked before any of these: ${askFirst.join(', ')}.` +
      (task
        ? ` Every other step goes ahead until \`${accept}\` exits zero, or until a missing input or a broken environment` +
          ' means it cannot pass as the task stands: then the work ends as a blocker named in the summary.'
        : '')
  );
}

const conventions = configured('conventions');
if (conventions.length) lines.push(`Conventions that constrain a change here: ${conventions.join(' ')}`);

// A task linked to a Foreman entry keeps its unchecked claims in that entry's notes. Claims that
// earlier unlinked tasks listed in .collet/unverified.md stay there, so the file is still named.
const foreman = task?.foreman && visible(`the Foreman id of task ${id}`, String(task.foreman));
const unverified = fileText(dir, 'unverified.md');
if (foreman) {
  lines.push(`What nobody has checked for task ${id} belongs in the unverified: lines of Foreman entry ${foreman}'s notes.`);
  if (listsClaims(unverified)) lines.push('What nobody has checked from earlier tasks is still in .collet/unverified.md.');
} else if (unverified) {
  lines.push('What nobody has checked yet is in .collet/unverified.md.');
}

const handoff = fileText(dir, 'handoff.md');
if (handoff) {
  const stamped = /^task:\s*(\S+)/m.exec(handoff);
  if (task && stamped && stamped[1] === id) {
    // The note's own report line names fields of the same ledger task, which this hook has just read
    // and reports itself, so it is left out rather than stated twice.
    const carried = handoff.split('\n').filter((line) => !line.startsWith(HIDDEN_REPORT)).join('\n');
    lines.push(`State carried over from the previous session:\n${visible('.collet/handoff.md', carried)}`);
  } else {
    // It describes work that is finished or replaced. Saying it would contradict the line above.
    rmSync(join(dir, COLLET, 'handoff.md'), { force: true });
  }
}

const left = visible.report();
if (left) lines.push(left);

if (lastHandoff) {
  lines.push(
    `The handoff hook that ran before the last compaction started at ${lastHandoff.at} and did not finish, so .collet/handoff.md may be missing or stale.`
  );
}
if (lastStart) {
  lines.push(`The previous session start began at ${lastStart.at} and did not finish, so that session may have started without this context.`);
}

emit('SessionStart', lines.join('\n'));
// Each is reported once: this run's own mark replaced the last start's, and the handoff's goes now.
if (lastHandoff) finished(dir, 'handoff', lastHandoff.run);
finished(dir, 'session-start', run);
