// Living beside a project that already plans its work.
//
// The rule is one sentence: collet writes no ledger it does not own, and refuses nothing another
// tool is already guarding. What it adds is write-time enforcement of files that plan declares
// and nothing polices.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { foremanProject, openTask } from '../templates/state.mjs';
import { clean, CONFIG, hook, hookOutput, mount, project, task, TREE } from './temp-project.js';

const ENTRY = {
  id: '002',
  title: 'Add JWT refresh middleware',
  why: 'Sessions expire mid-request.',
  what: 'Refresh before expiry.',
  status: 'in_progress',
  source: 'user',
  depends_on: ['001'],
  planned_touches: ['src/auth/'],
  observed_touches: [],
  commits: [],
  created_at: '2026-09-02',
  updated_at: '2026-09-02',
  notes: '',
};

const roadmap = (lines) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';

const PLANNED = {
  'src/auth/middleware.ts': 'export const mw = 1;\n',
  'src/routes.ts': 'export const r = 1;\n',
  'ROADMAP.jsonl': roadmap([{ foreman_roadmap_format: 2 }, ENTRY]),
};

function ready(files = PLANNED) {
  const root = project(files);
  mount(root);
  writeFileSync(join(root, '.collet', 'config.json'), CONFIG, 'utf8');
  return root;
}

test('a planned project is recognised by its directory, its marker, or an entry it holds', () => {
  const byDir = project({ '.foreman/config.json': '{}' });
  const byMarker = project({ 'ROADMAP.jsonl': roadmap([{ foreman_roadmap_format: 2 }, ENTRY]) });
  // A roadmap written before the marker existed carries none. Missing it would mean writing the
  // second ledger anyway, which is the whole failure this detection exists to avoid.
  const byShape = project({ 'ROADMAP.jsonl': roadmap([ENTRY]) });
  const plain = project(TREE);
  assert.equal(foremanProject(byDir), true);
  assert.equal(foremanProject(byMarker), true);
  assert.equal(foremanProject(byShape), true);
  assert.equal(foremanProject(plain), false);
  [byDir, byMarker, byShape, plain].forEach(clean);
});

test('the open entry is read, and its completion is left to whoever owns it', () => {
  const root = ready();
  const open = openTask(root);
  assert.equal(open.id, '002');
  assert.equal(open.owner, 'foreman');
  assert.deepEqual(open.scope, ['src/auth/']);
  assert.equal(open.accept, null);
  clean(root);
});

test('a legacy roadmap that still says touches is read the same way', () => {
  const root = project({
    'ROADMAP.jsonl': roadmap([{ ...ENTRY, planned_touches: undefined, touches: ['src/auth/'] }]),
  });
  assert.deepEqual(openTask(root).scope, ['src/auth/']);
  clean(root);
});

test('no second ledger is written, and every command that would write one refuses', () => {
  const root = ready();
  assert.equal(existsSync(join(root, '.collet', 'ledger.jsonl')), false);
  for (const args of [
    ['add', '--title', 't', '--why', 'w', '--scope', 'src/auth/'],
    ['widen', '--add', 'src/routes.ts', '--why', 'w'],
    ['close', '--left-out', 'nothing', '--unverified', 'nothing'],
    ['list'],
  ]) {
    const out = task(root, args);
    assert.equal(out.status, 2, args[0]);
    assert.match(out.stderr, /ROADMAP\.jsonl/, args[0]);
  }
  assert.equal(existsSync(join(root, '.collet', 'ledger.jsonl')), false);
  clean(root);
});

test('status reads that plan instead of inventing one', () => {
  const root = ready();
  const out = task(root, ['status']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /task 002 — Add JWT refresh middleware/);
  assert.match(out.stdout, /collet enforces this entry's files and writes nothing/);
  clean(root);
});

test('the declared files are enforced, folder hints included', () => {
  const root = ready();
  const inside = hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/auth/middleware.ts' } });
  assert.equal(inside.stdout, '');
  const outside = hookOutput(
    hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/routes.ts' } })
  );
  assert.equal(outside.permissionDecision, 'deny');
  clean(root);
});

test('the roadmap and its state are never refused here', () => {
  const root = ready();
  for (const path of ['ROADMAP.jsonl', '.foreman/archive.jsonl', '.foreman/config.json']) {
    assert.equal(hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: path } }).stdout, '', path);
  }
  clean(root);
});

test('the refusal names a remedy that exists in this project', () => {
  const root = ready();
  const reason = hookOutput(
    hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/routes.ts' } })
  ).permissionDecisionReason;
  // Pointing at a CLI that refuses here would send the session in a circle.
  assert.doesNotMatch(reason, /node \.collet\/task\.mjs widen/);
  assert.match(reason, /ROADMAP\.jsonl/);
  clean(root);
});

test('session start adds one line about enforcement and does not restate the plan', () => {
  const root = ready();
  const context = hookOutput(hook('session-start.js', root)).additionalContext;
  assert.match(context, /recorded in ROADMAP\.jsonl, which collet neither writes nor guards/);
  assert.match(context, /src\/auth\//);
  assert.doesNotMatch(context, /node \.collet\/task\.mjs close/);
  clean(root);
});

test('an entry nobody is working on leaves everything unenforced', () => {
  const root = ready({ ...PLANNED, 'ROADMAP.jsonl': roadmap([{ ...ENTRY, status: 'planned' }]) });
  assert.equal(openTask(root), null);
  assert.equal(hook('guard.js', root, { tool_name: 'Write', tool_input: { file_path: 'src/routes.ts' } }).stdout, '');
  clean(root);
});
