#!/usr/bin/env node
// Writes the harness into a project. This is the mechanical half of the mount: the interview and
// the judgement about what a task's scope should be belong to the skill, and everything that has
// to be identical every time belongs here, where it is executed rather than followed.
//
//   node scripts/mount.mjs <project-directory> [--accept "npm test"]
//
// Nothing already there is overwritten. The rules block is written between its markers, so
// re-running replaces the block and leaves everything around it exactly as it was.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATES = join(HERE, 'templates');
const target = resolve(process.argv[2] ?? '');
const acceptFlag = process.argv.indexOf('--accept');
const accept = acceptFlag === -1 ? null : process.argv[acceptFlag + 1];

if (!process.argv[2] || !existsSync(target)) {
  console.error('usage: node scripts/mount.mjs <project-directory> [--accept "npm test"]');
  process.exit(2);
}

/**
 * True when the project already records its work in a roadmap another tool owns.
 *
 * Read from the directory, from the format marker, or from an entry's own shape — a roadmap
 * written before that marker existed carries none, and missing it would mean mounting anyway.
 */
function plannedElsewhere(dir) {
  if (existsSync(join(dir, '.foreman'))) return true;
  let entries = [];
  try {
    entries = readFileSync(join(dir, 'ROADMAP.jsonl'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return false;
  }
  if (!entries.length) return false;
  if (Object.prototype.hasOwnProperty.call(entries[0], 'foreman_roadmap_format')) return true;
  return entries.some(
    (entry) => entry.id && (Array.isArray(entry.planned_touches) || Array.isArray(entry.touches))
  );
}

// A project that already plans its work elsewhere is left alone, entirely. collet has one ledger
// and no way to share one, so mounting here would put a second record of the same work on disk
// with nobody able to say which is authoritative. It also has nothing to add: the files an entry
// declares there are a forecast that tool re-reads and rewrites, not a boundary to enforce.
if (plannedElsewhere(target)) {
  console.error(`${target} already plans its work in a roadmap collet does not own.`);
  console.error('Nothing was written. That tool owns the plan, the files an entry names and when');
  console.error('the entry is done. collet mounts on a project that keeps no such roadmap.');
  process.exit(2);
}

const wrote = [];
const skipped = [];

const state = join(target, '.collet');
mkdirSync(join(state, 'checks'), { recursive: true });

for (const name of ['task.mjs', 'state.mjs']) {
  cpSync(join(TEMPLATES, name), join(state, name));
  wrote.push(`.collet/${name}`);
}

for (const name of readdirSync(join(TEMPLATES, 'checks'))) {
  cpSync(join(TEMPLATES, 'checks', name), join(state, 'checks', name));
  wrote.push(`.collet/checks/${name}`);
}

// Derived, machine-local or regenerated on demand. Committing them would make every session's
// diff carry the previous session's noise.
const ignore = join(state, '.gitignore');
if (!existsSync(ignore)) {
  writeFileSync(ignore, ['guard-log.jsonl', 'handoff.md', 'checks/discarded.json', 'off', ''].join('\n'), 'utf8');
  wrote.push('.collet/.gitignore');
}

const config = join(state, 'config.json');
const template = JSON.parse(readFileSync(join(TEMPLATES, 'config.json'), 'utf8'));
if (accept) template.accept = accept;
if (existsSync(config)) {
  // Keep what the project already said; only fill in an accept command it is missing.
  const mine = JSON.parse(readFileSync(config, 'utf8'));
  if (accept && (!mine.accept || mine.accept.startsWith('REPLACE'))) {
    mine.accept = accept;
    writeFileSync(config, JSON.stringify(mine, null, 2) + '\n', 'utf8');
    wrote.push('.collet/config.json (accept command filled in)');
  } else {
    skipped.push('.collet/config.json (already there)');
  }
} else {
  writeFileSync(config, JSON.stringify(template, null, 2) + '\n', 'utf8');
  wrote.push('.collet/config.json — fill in the project line, the conventions and the accept command');
}

const unverified = join(state, 'unverified.md');
if (!existsSync(unverified)) {
  writeFileSync(unverified, '# Not checked\n\nClaims nobody has checked yet. One line each.\n', 'utf8');
  wrote.push('.collet/unverified.md');
}

// The same block in every surface a different agent reads. A session loads exactly one of them, so
// the repetition costs nothing at run time and the alternative is a project that is only guarded
// for whichever tool happened to be configured first.
const block = readFileSync(join(TEMPLATES, 'rules.md'), 'utf8')
  .trim()
  .replace('{{WIDEN}}', '`node .collet/task.mjs widen --add <path> --why "<reason>"`.')
  .replace(
    '{{CLOSE}}',
    '`node .collet/task.mjs close` checks the working tree against the task, then runs the accept command.'
  );

const surfaces = ['AGENTS.md', 'CLAUDE.md'];
if (existsSync(join(target, '.cursor'))) surfaces.push('.cursor/rules/collet.md');

for (const surface of surfaces) {
  const path = join(target, surface);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const start = existing.indexOf('<!-- collet:begin');
  const end = existing.indexOf('<!-- collet:end -->');
  let next;
  if (start !== -1 && end !== -1) {
    next = existing.slice(0, start) + block + existing.slice(end + '<!-- collet:end -->'.length);
    wrote.push(`${surface} (block replaced in place)`);
  } else if (existing.trim()) {
    next = `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
    wrote.push(`${surface} (block appended, your text untouched)`);
  } else {
    next = `${block}\n`;
    wrote.push(surface);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
}

console.log(`collet mounted into ${target}\n`);
for (const line of wrote) console.log(`  wrote    ${line}`);
for (const line of skipped) console.log(`  kept     ${line}`);

console.log(`
next:
  1. Fill in .collet/config.json — the project line and the conventions a change must respect.
     A task cannot be opened while those placeholders are still there.`);

console.log(`  2. Open the first task, with the scope derived from reading the code it touches:
       node .collet/task.mjs add --title "..." --why "..." --scope "src/**,test/**"
  3. Prove the harness before trusting it:
       node .collet/task.mjs status
       node .collet/checks/run.mjs`);

console.log(`  4. With no task open, nothing is enforced. That is the documented hole, not a bug.
     \`.collet/off\` switches every session guard off on purpose; the checks keep running.`);
