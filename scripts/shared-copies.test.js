'use strict';

// Fails when collet's copy of the eval harness differs from anneal's. Each plugin ships alone, so
// each keeps the file its grader tests load; line endings aside, the two hold the same text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const original = 'anneal/tests/eval-harness.js';
const copy = 'collet/tests/eval-harness.cjs';

const text = (file) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test("collet's eval harness matches anneal's", () => {
  assert.strictEqual(text(copy), text(original), `${copy} differs from ${original}; copy one over the other`);
});
