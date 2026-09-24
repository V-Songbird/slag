#!/usr/bin/env node
// Writes the harness into a project. This is the mechanical half of the mount: the interview and
// the judgement about what a task's scope should be belong to the skill, and everything that has
// to be identical every time belongs here, where it is executed rather than followed.
//
//   node scripts/mount.mjs <project-directory> [--accept "npm test"] [--ask-first <thing>]... [--ask-rule <rule>]...
//                          [--exclude <glob>]...
//                          [--checks [--edition <id>]... [--with <edition>.<class>]...
//                                    [--remove <edition>.<class>]... [--restore <edition>.<class>]...]
//
// collet's own scripts are refreshed on every run; the project's config.json, unverified.md and
// .gitignore are kept. The rules block is written between its markers, so re-running replaces the
// block and leaves everything around it exactly as it was.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cataloguesFor, prepareCatalogue, SOURCE_TEXT, unedited } from './catalogue.mjs';
import { HIDDEN_CHARACTERS, unseen } from '../templates/state.mjs';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATES = join(HERE, 'templates');
const target = resolve(process.argv[2] ?? '');
let accept = null;
let withChecks = false;
const editions = [];
// Opt-in catalogue classes to write, named <edition>.<class>.
const chosen = [];
// Bundle classes to take out and keep out, and ones to bring back. The list lives in config.json.
const toRemove = [];
const toRestore = [];
// What must never happen here without asking the person, one thing per --ask-first.
const askFirst = [];
// Claude Code permission rules the person confirmed for that list, one per --ask-rule.
const askRules = [];
// Paths no bundle check reads, such as a committed generated mirror, one glob per --exclude.
const exclude = [];

if (!process.argv[2] || !existsSync(target) || !statSync(target).isDirectory()) {
  console.error('usage: node scripts/mount.mjs <project-directory> [--accept "npm test"] [--ask-first <thing>]... [--ask-rule <rule>]... [--exclude <glob>]... [--checks [--edition <id>]... [--with <edition>.<class>]... [--remove <edition>.<class>]... [--restore <edition>.<class>]...]');
  process.exit(2);
}

// The config, the settings and the rules block carry these values into every session, so one
// holding characters a person does not see is refused, named by what shows of it.
function shown(flag, value) {
  const problem = value && unseen(`${flag} ${JSON.stringify(value.replace(HIDDEN_CHARACTERS, ''))}`, value);
  if (problem) throw new Error(problem);
  return value;
}

try {
  for (let index = 3; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === '--checks') withChecks = true;
    else if (flag === '--ask-first') {
      const value = shown(flag, process.argv[++index]?.trim());
      if (!value || value.startsWith('--')) throw new Error('--ask-first needs the thing to ask about, such as deploy.');
      askFirst.push(value);
    } else if (flag === '--ask-rule') {
      const value = shown(flag, process.argv[++index]?.trim());
      // A Claude Code permission rule: a tool name, optionally followed by its specifier in parentheses.
      if (!value || !/^[A-Za-z][\w-]*(\(.+\))?$/s.test(value)) {
        throw new Error('--ask-rule needs a Claude Code permission rule such as "Bash(npm publish *)" or "PowerShell(npm publish *)".');
      }
      if (!askRules.includes(value)) askRules.push(value);
    } else if (flag === '--exclude') {
      const value = process.argv[++index]?.trim();
      if (!value || value.startsWith('--')) throw new Error('--exclude needs a path glob such as deno_dist/**.');
      exclude.push(value);
    } else if (flag === '--with' || flag === '--remove' || flag === '--restore') {
      const value = process.argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a check class such as javascript-typescript.type-widened-to-any, and --checks.`);
      ({ '--with': chosen, '--remove': toRemove, '--restore': toRestore })[flag].push(value);
    } else if (flag === '--accept' || flag === '--edition') {
      const value = process.argv[++index];
      if (!value || value.startsWith('--')) {
        throw new Error('--accept needs a command; --edition needs a language id and --checks.');
      }
      if (flag === '--accept') accept = shown(flag, value);
      else editions.push(value);
    } else throw new Error(`Unknown mount option: ${flag}.`);
  }
  if (editions.length && !withChecks) throw new Error('--edition needs a language id and --checks.');
  if (chosen.length && !withChecks) throw new Error('--with needs a check class and --checks.');
  if ((toRemove.length || toRestore.length) && !withChecks) throw new Error('--remove and --restore need a check class and --checks.');
  const both = toRemove.filter((id) => chosen.includes(id) || toRestore.includes(id));
  if (both.length) throw new Error(`${both.join(', ')} cannot be removed and added in one mount.`);
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

/** The ask-first entries worth stating: text, with placeholders left out. */
function stated(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item && !item.startsWith('REPLACE'));
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

// The project's own config is read before anything is written. A mount that stopped on it halfway
// would leave collet's scripts refreshed and no rules block.
const config = join(target, '.collet', 'config.json');
let mine = null;
if (existsSync(config)) {
  try {
    mine = JSON.parse(readFileSync(config, 'utf8'));
    if (!mine || typeof mine !== 'object' || Array.isArray(mine)) throw new Error('it does not hold a JSON object');
    // The accept command is run as text; a mount that filled one in would call a string method on it.
    if ('accept' in mine && typeof mine.accept !== 'string') throw new Error('its "accept" field is not a string');
  } catch (error) {
    console.error(`${config} cannot be read as collet's config: ${error.message}.`);
    console.error('Nothing was written. Fix or remove that file, then mount again.');
    process.exit(2);
  }
}
// An ask-first entry edited into the config by hand never passed --ask-first, and the rules block
// renders it into every session, so it is held to the same rule here.
const hiddenAsked = stated(mine?.ask_first)
  .map((item) => unseen(`ask_first ${JSON.stringify(item.replace(HIDDEN_CHARACTERS, ''))} in .collet/config.json`, item))
  .filter(Boolean);
if (hiddenAsked.length) {
  console.error(`${hiddenAsked.join('\n')}\nNothing was written. Type the entry again without them, then mount again.`);
  process.exit(2);
}
// The classes this project removed, as its config records them, with this mount's changes applied.
const recorded = Array.isArray(mine?.removed_checks) ? mine.removed_checks.filter((id) => typeof id === 'string') : [];
const removals = [...new Set([...recorded, ...toRemove])].filter((id) => !toRestore.includes(id));

// Ask rules go only into the project's shared Claude Code settings, and only for a project that
// names what it asks first. Read before anything is written, like the config above.
const claudeSettings = join(target, '.claude', 'settings.json');
let claude = null;
if (askRules.length) {
  const problem = (message) => {
    console.error(`${message}\nNothing was written.`);
    process.exit(2);
  };
  if (!askFirst.length && !stated(mine?.ask_first).length) {
    problem('--ask-rule needs an ask-first list, from --ask-first or from .collet/config.json.');
  }
  if (existsSync(claudeSettings)) {
    try {
      claude = JSON.parse(readFileSync(claudeSettings, 'utf8').replace(/^\uFEFF/, ''));
      if (!claude || typeof claude !== 'object' || Array.isArray(claude)) throw new Error('it does not hold a JSON object');
      const { permissions } = claude;
      if (permissions !== undefined && (!permissions || typeof permissions !== 'object' || Array.isArray(permissions))) {
        throw new Error('its "permissions" field is not an object');
      }
      if (permissions?.ask !== undefined && !Array.isArray(permissions.ask)) throw new Error('its "permissions.ask" field is not a list');
    } catch (error) {
      problem(`${claudeSettings} cannot be read as Claude Code settings: ${error.message}. Fix that file, then mount again.`);
    }
  } else claude = {};
}

let bundle;
if (withChecks) {
  try {
    const selected = cataloguesFor(target, editions);
    bundle = { files: [], kept: [], optional: [], removed: [], editions: selected.map((item) => item.id) };
    const known = selected.flatMap((catalogue) => catalogue.classes.map((item) => `${catalogue.id}.${item.id}`));
    const unknown = [...chosen, ...toRemove, ...toRestore].filter((id) => !known.includes(id));
    if (unknown.length) throw new Error(`Unknown check class for the selected editions: ${unknown.join(', ')}.`);
    // Preflight every selected language before changing the project. A failure in the last
    // edition must not leave the first edition installed as a misleading partial success.
    for (const catalogue of selected) {
      const prepared = await prepareCatalogue(target, catalogue, chosen, removals);
      bundle.files.push(...prepared.files);
      bundle.kept.push(...prepared.kept);
      bundle.optional.push(...prepared.optional);
      bundle.removed.push(...prepared.removed);
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

const source = join(state, 'source.mjs');
let refreshed = false;
if (existsSync(source)) {
  const current = readFileSync(source, 'utf8');
  if (current === SOURCE_TEXT) {
    skipped.push('.collet/source.mjs (already current)');
  } else if (unedited(current)) {
    writeFileSync(source, SOURCE_TEXT, 'utf8');
    wrote.push('.collet/source.mjs (refreshed: it held only what an earlier collet wrote)');
    refreshed = true;
  } else {
    skipped.push('.collet/source.mjs (kept: it has edits of its own, so this version\'s fixes to it are not applied; remove it and mount again to take them)');
  }
} else if (bundle) {
  writeFileSync(source, SOURCE_TEXT, 'utf8');
  wrote.push('.collet/source.mjs');
}

if (bundle) {
  for (const [name, content] of bundle.files) {
    writeFileSync(join(state, 'checks', name), content, 'utf8');
    wrote.push(`.collet/checks/${name}`);
  }
  for (const line of bundle.kept) skipped.push(`.collet/checks/${line}`);
  const checksDir = join(state, 'checks');
  for (const id of bundle.removed) {
    const own = readdirSync(checksDir).filter((name) => name === `${id}.mjs` ||
      ((name.startsWith(`${id}.violation`) || name.startsWith(`${id}.nearmiss`)) && name.endsWith('.json')));
    for (const name of own) unlinkSync(join(checksDir, name));
    if (toRemove.includes(id)) wrote.push(`.collet/checks/${id} removed (kept out on every remount; --restore ${id} brings it back)`);
    else skipped.push(`.collet/checks/${id} (removed by this project; --restore ${id} brings it back)`);
  }
}

// Derived, machine-local or regenerated on demand. Committing them would make every session's
// diff carry the previous session's noise. A hook the host stops leaves its *.running mark behind,
// so a list an earlier mount wrote gets that one line and keeps every other.
const ignore = join(state, '.gitignore');
if (!existsSync(ignore)) {
  writeFileSync(ignore, ['guard-log.jsonl', 'handoff.md', 'checks/discarded.json', 'off', '*.running', ''].join('\n'), 'utf8');
  wrote.push('.collet/.gitignore');
} else {
  const lines = readFileSync(ignore, 'utf8');
  if (!lines.split('\n').some((line) => line.trim() === '*.running')) {
    writeFileSync(ignore, `${lines}${lines === '' || lines.endsWith('\n') ? '' : '\n'}*.running\n`, 'utf8');
    wrote.push('.collet/.gitignore (*.running added, your lines untouched)');
  }
}

const template = JSON.parse(readFileSync(join(TEMPLATES, 'config.json'), 'utf8'));
if (accept) template.accept = accept;
// Only a project that named something gets the field: without one its config stays as it was.
if (askFirst.length) template.ask_first = askFirst;
if (exclude.length) template.exclude = exclude;
if (removals.length) template.removed_checks = removals;
let settings = template;
if (mine) {
  // Keep what the project already said; only fill in an accept command or ask-first list it is missing.
  const filledIn = [];
  if (accept && (!mine.accept || mine.accept.startsWith('REPLACE'))) {
    mine.accept = accept;
    filledIn.push('accept command');
  }
  if (askFirst.length && !stated(mine.ask_first).length) {
    mine.ask_first = askFirst;
    filledIn.push('ask-first list');
  }
  if (exclude.length && !(Array.isArray(mine.exclude) && mine.exclude.length)) {
    mine.exclude = exclude;
    filledIn.push('exclude list');
  }
  // Only a --remove or --restore changes the list; with neither the config stays byte for byte.
  if (bundle && (toRemove.length || toRestore.length)) {
    const before = JSON.stringify(mine.removed_checks);
    if (removals.length) mine.removed_checks = removals;
    else delete mine.removed_checks;
    if (JSON.stringify(mine.removed_checks) !== before) filledIn.push('removed-checks list');
  }
  if (filledIn.length) {
    writeFileSync(config, JSON.stringify(mine, null, 2) + '\n', 'utf8');
    wrote.push(`.collet/config.json (${filledIn.join(' and ')} filled in)`);
  } else {
    skipped.push('.collet/config.json (already there)');
  }
  settings = mine;
} else {
  writeFileSync(config, JSON.stringify(template, null, 2) + '\n', 'utf8');
  wrote.push('.collet/config.json — fill in the project line, the conventions and the accept command');
}

// Every existing key and rule stays; a rule already there is not added twice.
if (claude) {
  const ask = claude.permissions?.ask ?? [];
  const added = askRules.filter((rule) => !ask.includes(rule));
  if (added.length) {
    claude.permissions = { ...claude.permissions, ask: [...ask, ...added] };
    mkdirSync(dirname(claudeSettings), { recursive: true });
    writeFileSync(claudeSettings, JSON.stringify(claude, null, 2) + '\n', 'utf8');
    wrote.push(`.claude/settings.json (ask rules added: ${added.join(', ')}; a headless run stops at a matching command)`);
  } else {
    skipped.push('.claude/settings.json (those ask rules are already there)');
  }
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
const asked = stated(settings.ask_first);
const block = readFileSync(join(TEMPLATES, 'rules.md'), 'utf8')
  .trim()
  .replace('{{WIDEN}}', '`node .collet/task.mjs widen --add <path> --why "<reason>"`.')
  .replace(
    '{{CLOSE}}',
    '`node .collet/task.mjs close` checks the working tree against the task, then runs the accept command.'
  )
  // A fact about the project, never an order. Without a list the block reads exactly as before.
  .replace(
    '{{ASK_FIRST}}',
    asked.length
      ? `\n\nIn this project the person is asked before any of these: ${asked.join(', ')}.` +
          " Every other step goes ahead until the open task's accept command exits zero, or until a missing" +
          ' input or a broken environment means it cannot pass as the task stands: then the work ends as a' +
          ' blocker named in the summary.'
      : ''
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
for (const id of bundle?.optional ?? []) console.log(`  opt-in   ${id} (add it with --with ${id})`);

if (bundle) console.log(`\nSelected check editions: ${bundle.editions.join(', ')}`);
// A refreshed runtime runs every bundle check the project kept, so it is proven the same way.
if (bundle || refreshed) {
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
     A task cannot be opened while the project line or the accept command is a placeholder.`);

console.log(`  2. Open the first task, with the scope derived from reading the code it touches:
       node .collet/task.mjs add --title "..." --why "..." --scope "src/**,test/**"
  3. Prove the harness before trusting it:
       node .collet/task.mjs status
       node .collet/checks/run.mjs`);

console.log(`  4. With no task open, nothing is enforced. That is the documented hole, not a bug.
     \`.collet/off\` switches every session guard off on purpose; the checks keep running.`);
