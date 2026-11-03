#!/usr/bin/env node
// PreCompact: write down what the next session needs, so a compacted or resumed one does not have
// to rebuild it from the diff.
//
// The note carries the id of the task it describes. A handoff outlives the work it was written
// for, and one that is read back after the task closed contradicts the ledger in the same session
// start that states it — so the id is what lets the next reader tell the difference.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { COLLET, fileText, finished, listsClaims, mounted, projectModule, readEvent, root, started, withoutHidden } from './lib.js';

const event = readEvent();
const dir = root(event);
if (!mounted(dir)) process.exit(0);

// Marked before anything slow: a run the host stops leaves the mark, and the next session start
// says the note may be missing or stale.
const run = started(dir, 'handoff');
const done = () => {
  finished(dir, 'handoff', run);
  process.exit(0);
};

const state = await projectModule(dir, 'state.mjs');
if (!state) done();

const path = join(dir, COLLET, 'handoff.md');
const task = state.openTask(dir);
if (!task) {
  rmSync(path, { force: true });
  done();
}

// Each field as session start reads it: without characters that do not show on screen, and with a
// closing line naming the fields that held them. An id made only of them leaves the task unlinked
// in both hooks.
const visible = withoutHidden();
const title = visible(`the title of task ${task.id}`, task.title);
const scope = (task.scope ?? []).map((entry) => visible(`the scope of task ${task.id}`, entry));
const accept = visible(`the accept command of task ${task.id}`, task.accept);
const foreman = task.foreman && visible(`the Foreman id of task ${task.id}`, String(task.foreman));

const body = [
  '# Handoff',
  '',
  `task: ${task.id}`,
  `Written ${new Date().toISOString()}${event.trigger ? ` (context ${event.trigger})` : ''}.`,
  '',
  `"${title}" is still open. Writable: ${scope.join(', ') || 'none declared'}.`,
  `It ends when \`${accept}\` exits zero, which \`node .collet/task.mjs close\` runs.`,
  'Run `git status` and `git diff` for what has changed so far.',
  foreman
    ? `Anything claimed but not yet checked belongs in the \`unverified:\` lines of Foreman entry ${foreman}'s notes.`
    : 'Anything claimed but not yet checked belongs in `.collet/unverified.md`.',
  // Claims earlier unlinked tasks listed there stay there.
  ...(foreman && listsClaims(fileText(dir, 'unverified.md'))
    ? ['What earlier tasks left unchecked is still in `.collet/unverified.md`.']
    : []),
  ...[visible.report()].filter(Boolean),
  '',
].join('\n');

try {
  writeFileSync(path, body, 'utf8');
} catch {
  /* a handoff nobody could write is not worth stopping the session for */
}

done();
