'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { currentTokens, decide, nudge } = require('../hooks/brink.js');

let seq = 0;
const made = [];
function writeTranscript(lines) {
  const p = path.join(os.tmpdir(), `brink-test-${process.pid}-${seq++}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  made.push(p);
  return p;
}
function assistant(usage, extra = {}) {
  return { type: 'assistant', message: { usage, content: [{ type: 'text', text: 'ok' }] }, ...extra };
}
test.after(() => {
  for (const p of made) try { fs.unlinkSync(p); } catch { /* gone */ }
});

describe('currentTokens', () => {
  test('sums every numeric *_tokens field of the last main-thread assistant usage', () => {
    const p = writeTranscript([
      { type: 'user', message: { content: 'hi' } },
      assistant({ input_tokens: 10, cache_read_input_tokens: 100000, cache_creation_input_tokens: 5000, output_tokens: 200 }),
    ]);
    assert.strictEqual(currentTokens(p), 105210);
  });

  test('picks the LAST main-thread assistant, not an earlier one', () => {
    const p = writeTranscript([
      assistant({ input_tokens: 1, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 5 }),
      { type: 'user', message: { content: 'more' } },
      assistant({ input_tokens: 2, cache_read_input_tokens: 90000, cache_creation_input_tokens: 0, output_tokens: 8 }),
    ]);
    assert.strictEqual(currentTokens(p), 90010);
  });

  test('ignores sidechain (subagent) usage that follows the main turn', () => {
    const p = writeTranscript([
      assistant({ input_tokens: 5, cache_read_input_tokens: 120000, cache_creation_input_tokens: 0, output_tokens: 10 }),
      assistant({ input_tokens: 999999, cache_read_input_tokens: 999999, output_tokens: 999999 }, { isSidechain: true }),
    ]);
    assert.strictEqual(currentTokens(p), 120015);
  });

  test('skips torn/partial lines and non-numeric usage fields', () => {
    const p = writeTranscript([
      '{ this is not json',
      assistant({ input_tokens: 7, cache_read_input_tokens: 3000, service_tier: 'standard', output_tokens: 3 }),
    ]);
    assert.strictEqual(currentTokens(p), 3010);
  });

  test('null when the path is missing or empty', () => {
    assert.strictEqual(currentTokens(undefined), null);
    assert.strictEqual(currentTokens(path.join(os.tmpdir(), `brink-nope-${process.pid}.jsonl`)), null);
    assert.strictEqual(currentTokens(writeTranscript([{ type: 'user', message: { content: 'no usage here' } }])), null);
  });
});

describe('decide', () => {
  const T = 150000;
  const R = 120000;

  test('fires once when armed and at/above the threshold', () => {
    assert.deepStrictEqual(decide(150000, false, T, R), { notify: true, notified: true });
    assert.deepStrictEqual(decide(180000, false, T, R), { notify: true, notified: true });
  });

  test('stays silent once already notified, even while still high', () => {
    assert.deepStrictEqual(decide(190000, true, T, R), { notify: false, notified: true });
  });

  test('does not flap between the re-arm band and the threshold', () => {
    // notified, drifting down but still above rearm — no re-arm, no nudge.
    assert.deepStrictEqual(decide(130000, true, T, R), { notify: false, notified: true });
  });

  test('re-arms only after occupancy drops below the rearm line', () => {
    assert.deepStrictEqual(decide(119999, true, T, R), { notify: false, notified: false });
    // armed again: a fresh climb past the threshold fires once more.
    assert.deepStrictEqual(decide(160000, false, T, R), { notify: true, notified: true });
  });

  test('armed but still climbing below the threshold: silent, stays armed', () => {
    assert.deepStrictEqual(decide(140000, false, T, R), { notify: false, notified: false });
  });

  test('a null/absent reading changes nothing', () => {
    assert.deepStrictEqual(decide(null, true, T, R), { notify: false, notified: true });
    assert.deepStrictEqual(decide(null, false, T, R), { notify: false, notified: false });
  });
});

describe('nudge', () => {
  test('rounds to k tokens and hands over a pasteable /compact instruction', () => {
    const msg = nudge(156789);
    assert.match(msg, /~157k tokens/);
    assert.match(msg, /\/compact /);
    assert.match(msg, /Drop resolved exploration/);
  });
});
