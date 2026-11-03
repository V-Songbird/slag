#!/usr/bin/env node
// Runs this project's checks. No plugin, no account, no dependencies: `node` is enough.
//
//   node .collet/checks/run.mjs           admission — every check against its own fixtures
//   node .collet/checks/run.mjs --live    the same checks against the working tree
//   node .collet/checks/run.mjs --live --strict   a check that could not run fails the command
//
// A check is admitted when it fires on every one of its own violation fixtures and stays silent on
// every one of its near misses. Nothing else admits it. One that fails is written to
// discarded.json and reported; it is never quietly dropped and never counted as coverage.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openTask } from '../state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const live = process.argv.includes('--live');
const strict = process.argv.includes('--strict');

function fixtures() {
  return readdirSync(HERE).filter((name) => name.endsWith('.json') && name !== 'discarded.json');
}

async function loadChecks() {
  const files = readdirSync(HERE).filter((name) => name.endsWith('.mjs') && name !== 'run.mjs');
  const checks = [];
  for (const file of files) {
    try {
      const module = await import(pathToFileURL(join(HERE, file)).href);
      if (typeof module.check === 'function') checks.push({ file, module });
      else checks.push({ file, broken: 'no check() export' });
    } catch (error) {
      checks.push({ file, broken: String(error.message) });
    }
  }
  return checks;
}

// ---- live ------------------------------------------------------------------------------------
if (live) {
  const task = openTask(ROOT);
  if (!task) {
    console.log('no task is open — nothing enforced. Open one with: node .collet/task.mjs add ...');
    process.exit(0);
  }
  console.log(`open task ${task.id} — "${task.title}"`);
  let failed = 0;
  let skipped = 0;
  // One cache per pass, shared by every check: the source checks list the changes and read each
  // HEAD baseline once instead of once per check.
  const cache = new Map();
  for (const { file, module, broken } of await loadChecks()) {
    const id = module?.id ?? file.replace(/\.mjs$/, '');
    if (broken || typeof module.live !== 'function') {
      console.log(`skip ${id} — ${broken ?? 'no live check'}`);
      skipped += 1;
      continue;
    }
    let result;
    try {
      result = module.live({ root: ROOT, task, cache });
    } catch (error) {
      console.log(`fail ${id} — threw: ${String(error.message)}`);
      failed += 1;
      continue;
    }
    // A missing return or an unawaited Promise is no verdict. The live contract is synchronous;
    // invalid results fail even outside strict mode rather than being mistaken for a clean tree.
    if (!result || typeof result !== 'object' || typeof result.then === 'function' ||
        (result.skipped !== true && typeof result.fires !== 'boolean')) {
      console.log(`fail ${id} — live() must return a synchronous result with fires: boolean or skipped: true`);
      failed += 1;
      continue;
    }
    // "could not run" is never printed as ok. A green for an absent tool is the false comfort
    // this whole design refuses, and it lands where nobody is watching.
    if (result.skipped === true) {
      console.log(`skip ${id} — ${result.reason}`);
      skipped += 1;
      continue;
    }
    console.log(`${result?.fires ? 'fail' : 'ok  '} ${id} — ${result?.reason}`);
    if (result?.fires) failed += 1;
  }
  if (skipped && strict) console.log(`\n${skipped} check(s) could not run, and --strict counts that as a failure`);
  process.exit(failed || (strict && skipped) ? 1 : 0);
}

// ---- admission -------------------------------------------------------------------------------
const checks = await loadChecks();
const allFixtures = fixtures();
const discarded = [];
let failed = 0;

for (const { file, module, broken } of checks) {
  const id = module?.id ?? file.replace(/\.mjs$/, '');
  if (broken) {
    console.log(`FAIL ${id} — could not load: ${broken}`);
    discarded.push({ id, why: broken });
    failed += 1;
    continue;
  }

  const violations = allFixtures.filter((name) => name.startsWith(`${id}.violation`));
  const nearMisses = allFixtures.filter((name) => name.startsWith(`${id}.nearmiss`));
  if (!violations.length || !nearMisses.length) {
    console.log(`FAIL ${id} — needs at least one .violation and one .nearmiss fixture`);
    discarded.push({ id, why: 'no fixture pair' });
    failed += 1;
    continue;
  }

  const problems = [];
  for (const [names, expectation] of [
    [violations, true],
    [nearMisses, false],
  ]) {
    for (const name of names) {
      // A fixture that does not parse is a discarded check, not a stack trace. A runner that
      // crashes here stops every check after it and reports none of them.
      let fixture;
      try {
        fixture = JSON.parse(readFileSync(join(HERE, name), 'utf8'));
      } catch (error) {
        problems.push(`${name} does not parse: ${String(error.message)}`);
        continue;
      }
      const root = mkdtempSync(join(tmpdir(), 'collet-'));
      try {
        // `setup` is either a list of paths (created empty) or a map of path to contents, which is
        // what a check that reads files rather than paths needs.
        const setup = fixture.setup ?? [];
        const entries = Array.isArray(setup)
          ? setup.map((path) => [path, '// fixture\n'])
          : Object.entries(setup);
        for (const [path, content] of entries) {
          mkdirSync(dirname(join(root, path)), { recursive: true });
          writeFileSync(join(root, path), content, 'utf8');
        }
        let result;
        try {
          result = module.check({ root, task: fixture.task, call: fixture.call });
        } catch (error) {
          problems.push(`${name} threw: ${String(error.message)}`);
          continue;
        }
        if (Boolean(result?.fires) !== expectation) {
          problems.push(
            expectation
              ? `${name} did not fire (a violation it misses is not a check)`
              : `${name} fired (${result?.reason}) — a near miss it catches is a false alarm`
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }

  if (problems.length) {
    console.log(`FAIL ${id} — ${problems.join('; ')}`);
    discarded.push({ id, why: problems });
    failed += 1;
  } else {
    console.log(`ok   ${id} — ${violations.length} violation(s) caught, ${nearMisses.length} near miss(es) left alone`);
  }
}

if (discarded.length) {
  writeFileSync(join(HERE, 'discarded.json'), JSON.stringify({ at: new Date().toISOString(), discarded }, null, 2));
  console.log(`\n${discarded.length} check(s) discarded — written to .collet/checks/discarded.json`);
}

if (!checks.length) console.log('no checks in .collet/checks/ yet');
process.exit(failed ? 1 : 0);
