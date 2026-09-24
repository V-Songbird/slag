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
// joiner, a byte order mark past the start, bidi embeddings and isolates, and Unicode tags. Text
// written at mount can carry an order in them that nobody reviewing the file can read, and stating
// it would deliver that order every session. They are left out, and a closing line names the field
// that held them and their code points, counting tags and never decoding them. The joiner inside an
// emoji and the tags of a subdivision flag render, so they stay.
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { COLLET, config, cutShort, emit, fileText, finished, mounted, projectModule, readEvent, root, started } from './lib.js';

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

// Copied from anneal's audit, since collet ships alone.
const HIDDEN_CHARACTERS =
  /(?<!\p{Extended_Pictographic}\uFE0F?|[\u{1F3FB}-\u{1F3FF}])\u200D|[\u200B\u200C\u2060\uFEFF\u202A-\u202E\u2066-\u2069]|(?<!\u{1F3F4}[\u{E0020}-\u{E007E}]*)[\u{E0000}-\u{E007F}]/gu;
const hidden = new Map(); // field → the code points left out of it

function visible(field, text) {
  if (typeof text !== 'string') return text;
  const found = [...text.matchAll(HIDDEN_CHARACTERS)].map(([char]) => char.codePointAt(0));
  if (!found.length) return text;
  hidden.set(field, [...(hidden.get(field) ?? []), ...found]);
  return text.replace(HIDDEN_CHARACTERS, '');
}

const configured = (field) =>
  (Array.isArray(settings[field]) ? settings[field] : [])
    .map((value) => visible(`${field} in .collet/config.json`, filled(value)))
    .filter(Boolean);

const project = visible('project in .collet/config.json', filled(settings.project));
if (project) lines.push(project);

const task = state.openTask(dir);
const accept = task && visible(`the accept command of task ${task.id}`, task.accept);
if (task) {
  const scope = (task.scope ?? []).map((path) => visible(`the scope of task ${task.id}`, path));
  lines.push(
    `The open task is ${task.id} — "${visible(`the title of task ${task.id}`, task.title)}" (status ${task.status}).` +
      ` Writable files: ${scope.join(', ') || 'none declared'}.` +
      ` Writes outside that list are refused, and \`node .collet/task.mjs widen --add <path> --why "<reason>"\` is the way to extend it.` +
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

if (fileText(dir, 'unverified.md')) lines.push('What nobody has checked yet is in .collet/unverified.md.');

const handoff = fileText(dir, 'handoff.md');
if (handoff) {
  const stamped = /^task:\s*(\S+)/m.exec(handoff);
  if (task && stamped && stamped[1] === String(task.id)) {
    lines.push(`State carried over from the previous session:\n${visible('.collet/handoff.md', handoff)}`);
  } else {
    // It describes work that is finished or replaced. Saying it would contradict the line above.
    rmSync(join(dir, COLLET, 'handoff.md'), { force: true });
  }
}

if (hidden.size) {
  const held = [...hidden].map(([field, found]) => {
    const tags = found.filter((code) => code >= 0xe0000).length;
    const named = [...new Set(found.filter((code) => code < 0xe0000))].map(
      (code) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
    );
    if (tags) named.push(`${tags} Unicode tag character${tags === 1 ? '' : 's'}`);
    return `${field} held ${named.join(', ')}`;
  });
  lines.push(`Characters that do not show on screen were left out of what is stated here: ${held.join('; ')}.`);
}

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
