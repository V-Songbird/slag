#!/usr/bin/env node
// Writes the harness into a project. This is the mechanical half of the mount: the interview and
// the judgement about what a task's scope should be belong to the skill, and everything that has
// to be identical every time belongs here, where it is executed rather than followed.
//
//   node scripts/mount.mjs <project-directory> [--accept "npm test"] [--checks [--edition <id>]...]
//
// collet's own scripts are refreshed on every run; the project's config.json, unverified.md and
// .gitignore are kept. The rules block is written between its markers, so re-running replaces the
// block and leaves everything around it exactly as it was.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cataloguesFor, prepareCatalogue } from './catalogue.mjs';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATES = join(HERE, 'templates');
const target = resolve(process.argv[2] ?? '');
let accept = null;
let withChecks = false;
const editions = [];

if (!process.argv[2] || !existsSync(target) || !statSync(target).isDirectory()) {
  console.error('usage: node scripts/mount.mjs <project-directory> [--accept "npm test"] [--checks [--edition <id>]...]');
  process.exit(2);
}

try {
  for (let index = 3; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === '--checks') withChecks = true;
    else if (flag === '--accept' || flag === '--edition') {
      const value = process.argv[++index];
      if (!value || value.startsWith('--')) {
        throw new Error('--accept needs a command; --edition needs a language id and --checks.');
      }
      if (flag === '--accept') accept = value;
      else editions.push(value);
    } else throw new Error(`Unknown mount option: ${flag}.`);
  }
  if (editions.length && !withChecks) throw new Error('--edition needs a language id and --checks.');
} catch (error) {
  console.error(`${error.message} Nothing was written.`);
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

let bundle;
if (withChecks) {
  try {
    const selected = cataloguesFor(target, editions);
    bundle = { files: [], kept: [], editions: selected.map((item) => item.id) };
    // Preflight every selected language before changing the project. A failure in the last
    // edition must not leave the first edition installed as a misleading partial success.
    for (const catalogue of selected) {
      const prepared = await prepareCatalogue(target, catalogue);
      bundle.files.push(...prepared.files);
      bundle.kept.push(...prepared.kept);
    }
  } catch (error) {
    console.error(`${error.message}\nNothing was written.`);
    process.exit(2);
  }
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

if (bundle) {
  if (!existsSync(join(state, 'source.mjs'))) {
    cpSync(join(TEMPLATES, 'source.mjs'), join(state, 'source.mjs'));
    wrote.push('.collet/source.mjs');
  } else {
    skipped.push('.collet/source.mjs (already there)');
  }
  for (const [name, content] of bundle.files) {
    writeFileSync(join(state, 'checks', name), content, 'utf8');
    wrote.push(`.collet/checks/${name}`);
  }
  for (const line of bundle.kept) skipped.push(`.collet/checks/${line}`);
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
// for whichever tool happened to be configured first. `CLAUDE.md` is only ever joined, never
// created: one host reads `AGENTS.md` only while no `CLAUDE.md` exists, so creating it here would
// hide the project's own instructions behind a file holding nothing but this block.
const block = readFileSync(join(TEMPLATES, 'rules.md'), 'utf8')
  .trim()
  .replace('{{WIDEN}}', '`node .collet/task.mjs widen --add <path> --why "<reason>"`.')
  .replace(
    '{{CLOSE}}',
    '`node .collet/task.mjs close` checks the working tree against the task, then runs the accept command.'
  );

const surfaces = ['AGENTS.md'];
if (existsSync(join(target, 'CLAUDE.md'))) surfaces.push('CLAUDE.md');
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

if (bundle) {
  console.log(`\nSelected check editions: ${bundle.editions.join(', ')}`);
  console.log('\nProving the mounted checks against their examples:');
  const proof = spawnSync(process.execPath, [join(state, 'checks', 'run.mjs')], { cwd: target, stdio: 'inherit' });
  if (proof.error || proof.status !== 0) {
    console.error('Mounted check verification failed. Existing checks were preserved; a reported check is not automatically disabled. Review the failures before trusting the harness.');
    process.exit(1);
  }
}

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
