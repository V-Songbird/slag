#!/usr/bin/env node
// PreCompact: write down what the next session needs, so a compacted or resumed one does not have
// to rebuild it from the diff.
//
// The note carries the id of the task it describes. A handoff outlives the work it was written
// for, and one that is read back after the task closed contradicts the ledger in the same session
// start that states it — so the id is what lets the next reader tell the difference.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { COLLET, finished, mounted, projectModule, readEvent, root, started } from './lib.js';

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

const body = [
  '# Handoff',
  '',
  `task: ${task.id}`,
  `Written ${new Date().toISOString()}${event.trigger ? ` (context ${event.trigger})` : ''}.`,
  '',
  `"${task.title}" is still open. Writable: ${(task.scope ?? []).join(', ') || 'none declared'}.`,
  `It ends when \`${task.accept}\` exits zero, which \`node .collet/task.mjs close\` runs.`,
  'Run `git status` and `git diff` for what has changed so far.',
  'Anything claimed but not yet checked belongs in `.collet/unverified.md`.',
  '',
].join('\n');

try {
  writeFileSync(path, body, 'utf8');
} catch {
  /* a handoff nobody could write is not worth stopping the session for */
}

done();
