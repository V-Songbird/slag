'use strict';

// Fails when this repository's mounted .collet/state.mjs differs from collet/templates/state.mjs,
// the file collet's mount copies there byte for byte.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const harness = import('../collet/tests/temp-project.js');

const template = 'collet/templates/state.mjs';
const mounted = '.collet/state.mjs';

const inSync = (dir) => readFileSync(path.join(dir, mounted)).equals(readFileSync(path.join(dir, template)));

test('the mounted .collet/state.mjs matches its template', () => {
  assert.ok(inSync(root), `${mounted} differs from ${template}; copy the template over it`);
});

test('a changed copy is caught', async () => {
  const { project } = await harness;
  const text = readFileSync(path.join(root, template), 'utf8');
  assert.equal(inSync(project({ [template]: text, [mounted]: text })), true);
  assert.equal(inSync(project({ [template]: text, [mounted]: `${text}// changed\n` })), false);
});
