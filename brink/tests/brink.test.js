'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scan, currentTokens, decide, nudge, emit } = require('../hooks/brink.js');

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

describe('scan signals', () => {
  test('pulls tokens, recent file basenames (distinct, newest-first, capped), and the task line', () => {
    const p = writeTranscript([
      { type: 'user', message: { content: 'Fix the failing pricing test\nsecond line ignored' } },
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/repo/src/pricing.js' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'D:\\repo\\src\\pricing.js' } }, // same basename → de-duped
      ] } },
      assistant({ input_tokens: 10, cache_read_input_tokens: 160000, output_tokens: 30 }),
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Write', input: { file_path: '/repo/tests/pricing.test.js' } },
      ] } },
    ]);
    const s = scan(p);
    assert.strictEqual(s.tokens, 160040);
    assert.deepStrictEqual(s.files, ['pricing.test.js', 'pricing.js']);
    assert.strictEqual(s.task, 'Fix the failing pricing test');
  });

  test('caps the file list at three, newest first', () => {
    const p = writeTranscript([
      { type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: 'a.js' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'b.js' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'c.js' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'd.js' } },
      ] } },
      assistant({ input_tokens: 1, cache_read_input_tokens: 5, output_tokens: 1 }),
    ]);
    assert.deepStrictEqual(scan(p).files, ['a.js', 'b.js', 'c.js']);
  });

  test('ignores sidechain file ops and truncates a long task line', () => {
    const long = 'A'.repeat(200);
    const p = writeTranscript([
      { type: 'user', message: { content: long } },
      { type: 'assistant', isSidechain: true, message: { content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: '/sub/agent.js' } },
      ] } },
      assistant({ input_tokens: 1, cache_read_input_tokens: 5, output_tokens: 1 }),
    ]);
    const s = scan(p);
    assert.deepStrictEqual(s.files, []);
    assert.ok(s.task.length <= 80 && s.task.endsWith('…'));
  });

  test('ignores harness-injected (non-human) user turns when choosing the task', () => {
    const p = writeTranscript([
      { type: 'user', message: { content: 'the real task' } },
      { type: 'user', isMeta: true, message: { content: 'scheduled wakeup' } },
      { type: 'user', origin: { kind: 'task' }, message: { content: 'task notification' } },
      assistant({ input_tokens: 1, cache_read_input_tokens: 5, output_tokens: 1 }),
    ]);
    assert.strictEqual(scan(p).task, 'the real task');
  });

  test('empty signals when there is no transcript', () => {
    assert.deepStrictEqual(scan(undefined), { tokens: null, files: [], task: null });
  });
});

describe('decide', () => {
  const T = 200000;
  const R = 160000;
  const P = 75000;

  test('fires when armed and at/above the threshold', () => {
    assert.deepStrictEqual(decide(200000, null, T, R, P), { notify: true, firedAt: 200000 });
    assert.deepStrictEqual(decide(230000, null, T, R, P), { notify: true, firedAt: 230000 });
  });

  test('stays silent until the window grows a full repeat step past the last nudge', () => {
    assert.deepStrictEqual(decide(240000, 200000, T, R, P), { notify: false, firedAt: 200000 });
    assert.deepStrictEqual(decide(274999, 200000, T, R, P), { notify: false, firedAt: 200000 });
  });

  test('repeats every repeat tokens of further growth', () => {
    assert.deepStrictEqual(decide(275000, 200000, T, R, P), { notify: true, firedAt: 275000 });
    assert.deepStrictEqual(decide(350000, 275000, T, R, P), { notify: true, firedAt: 350000 });
  });

  test('a custom repeat step moves the next nudge', () => {
    assert.deepStrictEqual(decide(210000, 200000, T, R, 10000), { notify: true, firedAt: 210000 });
  });

  test('does not flap between the re-arm band and the threshold', () => {
    // already nudged, drifting down but still above rearm — no re-arm, no nudge.
    assert.deepStrictEqual(decide(170000, 200000, T, R, P), { notify: false, firedAt: 200000 });
  });

  test('re-arms only after occupancy drops below the rearm line', () => {
    assert.deepStrictEqual(decide(159999, 200000, T, R, P), { notify: false, firedAt: null });
    // armed again: a fresh climb past the threshold fires from scratch.
    assert.deepStrictEqual(decide(210000, null, T, R, P), { notify: true, firedAt: 210000 });
  });

  test('armed but still climbing below the threshold: silent, stays armed', () => {
    assert.deepStrictEqual(decide(190000, null, T, R, P), { notify: false, firedAt: null });
  });

  test('a null/absent reading changes nothing', () => {
    assert.deepStrictEqual(decide(null, 200000, T, R, P), { notify: false, firedAt: 200000 });
    assert.deepStrictEqual(decide(null, null, T, R, P), { notify: false, firedAt: null });
  });
});

describe('nudge', () => {
  test('rounds to k tokens and hands over a pasteable /compact instruction', () => {
    const msg = nudge(156789);
    assert.match(msg, /~157k tokens/);
    assert.match(msg, /\/compact /);
    assert.match(msg, /Drop resolved exploration/);
  });

  test('weaves the live task and files into the keep-clause when given', () => {
    const msg = nudge(160000, { task: 'fix the coupon rounding bug', files: ['pricing.js', 'pricing.test.js'] });
    assert.match(msg, /the current task \(fix the coupon rounding bug\)/);
    assert.match(msg, /the files in play \(pricing\.js, pricing\.test\.js\)/);
    assert.match(msg, /still open\. Prefer the most recent/); // oxford "and" joins the clause, sentence then continues
  });

  test('falls back to the generic clause with no signals', () => {
    const msg = nudge(160000, { task: null, files: [] });
    assert.match(msg, /Keep, in priority order, the current task and goal,/);
    assert.doesNotMatch(msg, /files in play/);
  });

  test('tells the summary to favour the most recent work', () => {
    assert.match(nudge(210000), /Prefer the most recent work over older history\./);
  });
});

describe('emit', () => {
  test('carries the same text on both channels', () => {
    const out = emit('brink: go compact');
    assert.strictEqual(out.systemMessage, 'brink: go compact');
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /^brink: go compact\n\n/);
    assert.match(out.hookSpecificOutput.additionalContext, /verbatim/);
  });
});

describe('hook process', () => {
  const hook = path.join(__dirname, '..', 'hooks', 'brink.js');

  function run(transcriptPath, env = {}, session = {}) {
    const out = execFileSync(process.execPath, [hook], {
      input: JSON.stringify({
        session_id: session.id || `brink-test-${process.pid}-${seq++}`,
        transcript_path: transcriptPath,
      }),
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: session.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'brink-data-')),
        ...env,
      },
      encoding: 'utf8',
    });
    return out ? JSON.parse(out) : null;
  }

  test('emits both channels once over the threshold', () => {
    const p = writeTranscript([
      { type: 'user', message: { content: 'chase the flaky test' } },
      assistant({ input_tokens: 10, cache_read_input_tokens: 210000, output_tokens: 30 }),
    ]);
    const out = run(p);
    assert.match(out.systemMessage, /~210k tokens/);
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /chase the flaky test/);
  });

  test('stays silent below the threshold', () => {
    const p = writeTranscript([assistant({ input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 30 })]);
    assert.strictEqual(run(p), null);
  });

  test('nudges again a repeat step later in the same session, not before', () => {
    const at = (n) => writeTranscript([assistant({ input_tokens: 0, cache_read_input_tokens: n, output_tokens: 0 })]);
    const session = { id: `brink-repeat-${process.pid}`, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'brink-data-')) };
    assert.match(run(at(205000), {}, session).systemMessage, /~205k tokens/);
    assert.strictEqual(run(at(270000), {}, session), null);
    assert.match(run(at(280000), {}, session).systemMessage, /~280k tokens/);
  });

  test('BRINK_REPEAT sets the distance between nudges', () => {
    const at = (n) => writeTranscript([assistant({ input_tokens: 0, cache_read_input_tokens: n, output_tokens: 0 })]);
    const session = { id: `brink-repeat-cfg-${process.pid}`, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'brink-data-')) };
    const env = { BRINK_REPEAT: '10000' };
    assert.match(run(at(205000), env, session).systemMessage, /~205k tokens/);
    assert.match(run(at(216000), env, session).systemMessage, /~216k tokens/);
  });

  test('BRINK_DISABLE=1 silences a reading that would otherwise fire', () => {
    const p = writeTranscript([assistant({ input_tokens: 10, cache_read_input_tokens: 400000, output_tokens: 30 })]);
    assert.strictEqual(run(p, { BRINK_DISABLE: '1' }), null);
  });
});
