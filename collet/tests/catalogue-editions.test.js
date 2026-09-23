// Every language bundle must survive the mounted runner and host guard, including the look-alikes
// authored for its siblings. Source fixtures are read as data; no language toolchain is required.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { prepareCatalogue } from '../scripts/catalogue.mjs';
import { checkSource } from '../templates/source.mjs';
import { checks, CONFIG, hook, hookOutput, mount, PLUGIN, project, task } from './temp-project.js';

const editions = ['python', 'go', 'rust', 'jvm', 'dotnet'];

for (const edition of editions) {
  test(`${edition} proves its original examples, host refusals and sibling near misses`, async (t) => {
    const catalogue = JSON.parse(readFileSync(join(PLUGIN, 'catalogue', `${edition}.json`), 'utf8'));
    const root = project();
    const prepared = await prepareCatalogue(root, catalogue);
    assert.equal(existsSync(join(root, '.collet')), false, 'preflight must not mount anything');
    const generated = new Map(prepared.files);
    const mounted = mount(root, ['--checks', '--edition', edition]);
    assert.equal(mounted.status, 0, mounted.stdout + mounted.stderr);
    const proof = checks(root);
    assert.equal(proof.status, 0, proof.stdout + proof.stderr);
    writeFileSync(join(root, '.collet', 'config.json'), CONFIG, 'utf8');
    const opened = task(root, ['add', '--title', 'Preserve verification', '--why', 'Exercise the bundle', '--scope', '**']);
    assert.equal(opened.status, 0, opened.stderr);

    const modules = new Map();
    const nearMisses = [];
    for (const item of catalogue.classes) {
      const id = `${edition}.${item.id}`;
      modules.set(id, await import(pathToFileURL(join(root, '.collet', 'checks', `${id}.mjs`)).href));
    }
    for (const item of catalogue.classes) {
      const id = `${edition}.${item.id}`;
      await t.test(item.id, () => {
        const examples = [{ ...item.fixtures, id: '' }, ...(item.fixtures.additional ?? [])];
        assert.ok(proof.stdout.includes(`ok   ${id} — ${examples.length} violation(s) caught, ${examples.length} near miss(es) left alone`), proof.stdout);
        assert.ok(item.fixtures.violation.includes(item.example), `${id} example must be an actual violation excerpt`);
        for (const example of examples) {
          const suffix = example.id ? `-${example.id}` : '';
          for (const [half, original, expected] of [
            ['violation', example.violation, true],
            ['nearmiss', example.nearMiss, false],
          ]) {
            const filename = `${id}.${half}${suffix}.json`;
            const fixture = JSON.parse(readFileSync(join(root, '.collet', 'checks', filename), 'utf8'));
            assert.equal(fixture.call.input.content, original, `${filename} must preserve source text`);
            assert.deepEqual(fixture, JSON.parse(generated.get(filename)), `${filename} changed after preflight`);
            const context = { root, task: fixture.task, call: fixture.call };
            assert.equal(modules.get(id).check(context).fires, expected, filename);
            const out = hook('guard.js', root, { tool_name: fixture.call.tool, tool_input: fixture.call.input });
            assert.equal(out.status, 0, out.stderr);
            if (expected) {
              const decision = hookOutput(out);
              assert.equal(decision?.permissionDecision, 'deny', out.stdout);
              // A violation can legitimately contain more than one mistake; the guard reports
              // its first refusal. Prove that reported check too, without assuming load order.
              const reported = [...modules].find(([candidate]) => decision.permissionDecisionReason.includes(`${candidate} (`));
              assert.ok(reported, decision.permissionDecisionReason);
              assert.equal(reported[1].check(context).fires, true, decision.permissionDecisionReason);
              assert.ok(decision.permissionDecisionReason.includes(fixture.call.input.file_path), decision.permissionDecisionReason);
              assert.doesNotMatch(decision.permissionDecisionReason, /widen --add/);
            } else {
              assert.equal(out.stdout, '', `${filename} was refused: ${out.stdout}`);
              nearMisses.push({ id, filename, fixture });
            }
          }
        }
      });
    }

    const crossHits = [];
    let comparisons = 0;
    for (const [id, module] of modules) {
      for (const { id: owner, filename, fixture } of nearMisses) {
        if (id === owner) continue;
        const result = module.check({ root, task: fixture.task, call: fixture.call });
        comparisons += 1;
        if (result.fires) crossHits.push(`${id} on ${filename}: ${result.reason}`);
      }
    }
    t.diagnostic(`${comparisons} sibling near-miss comparisons; ${crossHits.length} findings`);
    assert.deepEqual(crossHits, [], crossHits.join('\n'));
  });
}

test('the JVM comment-suppression example proves the second detector independently', () => {
  const catalogue = JSON.parse(readFileSync(join(PLUGIN, 'catalogue', 'jvm.json'), 'utf8'));
  const item = catalogue.classes.find((entry) => entry.id === 'blanket-lint-suppression');
  const example = item.fixtures.additional.find((entry) => entry.id === 'comment-suppression');
  for (const [index, expected] of [[0, false], [1, true]]) {
    const spec = { ...item, ...item.detectors[index], detectors: undefined, commentSyntax: catalogue.commentSyntax };
    const context = {
      root: process.cwd(),
      task: { id: 't1', scope: ['**'] },
      call: { tool: 'Edit', input: { file_path: example.path, old_string: '', new_string: example.violation } },
    };
    assert.equal(checkSource(context, spec).fires, expected, `detector ${index}`);
    context.call.input.new_string = example.nearMiss;
    assert.equal(checkSource(context, spec).fires, false, `detector ${index} near miss`);
  }
});

test('a preserved runtime that ignores extra detectors cannot silently mount the JVM bundle', () => {
  const runtime = pathToFileURL(join(PLUGIN, 'templates', 'source.mjs')).href;
  const source = [
    `import { checkSource as current, liveSource } from ${JSON.stringify(runtime)};`,
    'export { liveSource };',
    'export const checkSource = (context, spec) => current(context, { ...spec, detectors: undefined });',
    '',
  ].join('\n');
  const root = project({ '.collet/source.mjs': source, 'AGENTS.md': '# Keep existing instructions\n' });
  const out = mount(root, ['--checks', '--edition', 'jvm']);
  assert.equal(out.status, 2, out.stdout + out.stderr);
  assert.match(out.stderr, /jvm\.blanket-lint-suppression failed its violation example/);
  assert.equal(readFileSync(join(root, '.collet', 'source.mjs'), 'utf8'), source);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '# Keep existing instructions\n');
  assert.equal(existsSync(join(root, '.collet', 'checks')), false);
});

test('the combined language bundle leaves every original and additional near miss alone', async (t) => {
  const root = project();
  const specs = [];
  const examples = [];
  for (const edition of ['javascript-typescript', ...editions]) {
    const catalogue = JSON.parse(readFileSync(join(PLUGIN, 'catalogue', `${edition}.json`), 'utf8'));
    for (const item of catalogue.classes) {
      specs.push({ ...item, id: `${edition}.${item.id}`, commentSyntax: catalogue.commentSyntax });
    }
    const prepared = await prepareCatalogue(root, catalogue);
    for (const [filename, content] of prepared.files) {
      if (filename.includes('.nearmiss') && filename.endsWith('.json')) {
        examples.push({ filename, owner: filename.split('.nearmiss')[0], fixture: JSON.parse(content) });
      }
    }
  }
  assert.equal(existsSync(join(root, '.collet')), false, 'comparisons need an empty source baseline');
  let comparisons = 0;
  let crossComparisons = 0;
  const findings = [];
  for (const spec of specs) {
    for (const { filename, owner, fixture } of examples) {
      const result = checkSource({ root, task: fixture.task, call: fixture.call }, spec);
      comparisons += 1;
      if (spec.id !== owner) crossComparisons += 1;
      assert.equal(Boolean(result.skipped), false, `${spec.id} skipped ${filename}: ${result.reason}`);
      if (result.fires) findings.push(`${spec.id} on ${filename} at ${fixture.call.input.file_path}: ${result.reason}`);
    }
  }
  t.diagnostic(`${specs.length} classes against ${examples.length} near misses: ${comparisons} comparisons (${crossComparisons} across classes); ${findings.length} findings`);
  assert.deepEqual(findings, [], findings.join('\n'));
});

test('opt-in, exclude and remedy fields are optional, checked, and change nothing when absent', async () => {
  const js = JSON.parse(readFileSync(join(PLUGIN, 'catalogue', 'javascript-typescript.json'), 'utf8'));
  const plain = js.classes.find((entry) => entry.id === 'focused-test');
  const catalogue = (item) => ({ ...js, classes: [item] });
  const root = project();
  const before = await prepareCatalogue(root, catalogue(plain));
  assert.deepEqual(before.optional, []);
  assert.doesNotMatch(before.files[0][1], /"exclude"|"remedy"|"optional"/);

  const optIn = { ...plain, optional: true };
  const skipped = await prepareCatalogue(root, catalogue(optIn));
  assert.deepEqual(skipped.files, []);
  assert.deepEqual(skipped.optional, ['javascript-typescript.focused-test']);
  const chosen = await prepareCatalogue(root, catalogue(optIn), ['javascript-typescript.focused-test']);
  assert.deepEqual(chosen.files.map(([name]) => name), before.files.map(([name]) => name));

  const excluded = await prepareCatalogue(root, catalogue({
    ...plain,
    exclude: ['**/generated/**'],
    remedy: 'Remove the focus before closing.',
    fixtures: { ...plain.fixtures, additional: [{ id: 'excluded', nearMissPath: 'generated/a.test.js', violation: plain.fixtures.violation, nearMiss: plain.fixtures.violation }] },
  }));
  const nearMiss = JSON.parse(new Map(excluded.files).get('javascript-typescript.focused-test.nearmiss-excluded.json'));
  assert.equal(nearMiss.call.input.file_path, 'generated/a.test.js');
  const module = excluded.files[0][1];
  assert.match(module, /"exclude": \[\n\s+"\*\*\/generated\/\*\*"\n\s+\]/);
  assert.match(module, /"remedy": "Remove the focus before closing\."/);

  for (const [field, value] of [['remedy', 3], ['exclude', 'dist/**'], ['optional', 'yes']]) {
    await assert.rejects(prepareCatalogue(root, catalogue({ ...plain, [field]: value })), new RegExp(`focused-test has an? ${field}`));
  }
});
