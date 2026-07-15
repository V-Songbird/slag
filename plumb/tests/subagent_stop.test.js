'use strict';

// SubagentStop gate, probe-first. A live probe (findings restated in
// stop-gate.js's SubagentStop comment block) confirmed
// decision:"block" IS honored on SubagentStop and every subagent-transcript
// entry carries isSidechain:true. These tests exercise the real hook as a
// subprocess (Spec P6 liveness discipline), an agent-scoped state file per
// two concurrent agents, and the hooks.json registration shape.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runHook, hookOutput, freshSession, writeSubagentTurn, freshLog } = require('./helpers');
const { gateStateId, subagentTranscriptFallback, blockReason } = require('../hooks/stop-gate');

function subagentInput({ session, agentId = 'agent-hex-1', calls, finalText, extra } = {}) {
  return {
    session_id: session || freshSession(),
    agent_id: agentId,
    agent_type: 'general-purpose',
    prompt_id: `prompt-${agentId}`,
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    agent_transcript_path: writeSubagentTurn({ calls, finalText }),
    ...(extra || {}),
  };
}

describe('SubagentStop: routes to the gate', () => {
  test('a code-edit + completion-claim subagent turn logs a candidate in dormant mode', () => {
    const log = freshLog();
    const input = subagentInput({
      calls: [{ name: 'Edit', input: { file_path: 'src/sub.js' } }],
      finalText: 'Done — the fix works.',
    });
    assert.strictEqual(hookOutput(runHook('stop-gate.js', input, { PLUMB_LOG: log })), null);
    const lines = fs.readFileSync(log, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].kind, 'candidate-dormant');
    assert.strictEqual(lines[0].agent_id, 'agent-hex-1');
  });

  test('a non-SubagentStop, non-Stop event is ignored', () => {
    const input = subagentInput({ extra: { hook_event_name: 'SomethingElse' } });
    const r = runHook('stop-gate.js', input, { PLUMB_LOG: freshLog() });
    assert.strictEqual(r.stdout, '');
  });

  test('missing agent_id stays silent (cannot scope state)', () => {
    const input = { session_id: freshSession(), hook_event_name: 'SubagentStop', agent_transcript_path: writeSubagentTurn({ finalText: 'done' }) };
    const r = runHook('stop-gate.js', input, { PLUMB_LOG: freshLog() });
    assert.strictEqual(r.stdout, '');
  });

  test('stop_hook_active:true short-circuits (loop guard, same as Stop)', () => {
    const log = freshLog();
    const input = subagentInput({ calls: [{ name: 'Edit', input: { file_path: 'a.js' } }], finalText: 'Done.', extra: { stop_hook_active: true } });
    const r = runHook('stop-gate.js', input, { PLUMB_LOG: log });
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(fs.existsSync(log), false);
  });
});

describe('SubagentStop: block-vs-observe matches the probe finding (block IS honored)', () => {
  test('armed mode blocks a candidate exactly like the main Stop gate', () => {
    const input = subagentInput({
      calls: [{ name: 'Edit', input: { file_path: 'src/sub.js' } }],
      finalText: 'Done — the fix works.',
    });
    const r = runHook('stop-gate.js', input, { PLUMB_ARM: '1', PLUMB_LOG: freshLog() });
    assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { decision: 'block', reason: blockReason(['src/sub.js']) });
  });

  test('dormant mode never blocks, only logs', () => {
    const input = subagentInput({
      calls: [{ name: 'Edit', input: { file_path: 'src/sub.js' } }],
      finalText: 'Done — the fix works.',
    });
    const r = runHook('stop-gate.js', input, { PLUMB_LOG: freshLog() });
    assert.strictEqual(r.stdout, '');
  });
});

describe('SubagentStop: agent-scoped state isolates two agents in one session', () => {
  test('two agents in the same session each get their own dedup + armedBlocks budget', () => {
    const session = freshSession();
    const log = freshLog();

    const inputA1 = subagentInput({ session, agentId: 'agent-A', calls: [{ name: 'Edit', input: { file_path: 'a.js' } }], finalText: 'Done — works.' });
    const rA1 = runHook('stop-gate.js', inputA1, { PLUMB_ARM: '1', PLUMB_LOG: log });
    assert.strictEqual(JSON.parse(rA1.stdout.trim()).decision, 'block');

    // Agent B, same session, different agent_id and its own transcript/turn:
    // must NOT be treated as a dedup-repeat of agent A's turn, and must get
    // its own fresh armedBlocks budget rather than inheriting A's.
    const inputB1 = subagentInput({ session, agentId: 'agent-B', calls: [{ name: 'Edit', input: { file_path: 'b.js' } }], finalText: 'Done — works.' });
    const rB1 = runHook('stop-gate.js', inputB1, { PLUMB_ARM: '1', PLUMB_LOG: log });
    assert.strictEqual(JSON.parse(rB1.stdout.trim()).decision, 'block');

    const lines = fs.readFileSync(log, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const kinds = lines.map((l) => `${l.agent_id}:${l.kind}`);
    assert.deepStrictEqual(kinds, ['agent-A:candidate-armed-blocked', 'agent-B:candidate-armed-blocked']);
  });
});

describe('gateStateId (razor pattern, reimplemented)', () => {
  test('composes session--agent_id when agent_id is present', () => {
    assert.strictEqual(gateStateId({ session_id: 's1', agent_id: 'a1' }), 's1--a1');
  });

  test('falls back to plain session_id when agent_id is absent (main thread)', () => {
    assert.strictEqual(gateStateId({ session_id: 's1' }), 's1');
  });
});

describe('subagentTranscriptFallback', () => {
  test('builds the historical <project>/<session>/subagents/agent-<id>.jsonl convention', () => {
    const data = { transcript_path: path.join('C:', 'proj', 's1.jsonl'), session_id: 's1', agent_id: 'a1' };
    assert.strictEqual(subagentTranscriptFallback(data), path.join('C:', 'proj', 's1', 'subagents', 'agent-a1.jsonl'));
  });

  test('returns null when required fields are missing', () => {
    assert.strictEqual(subagentTranscriptFallback({ session_id: 's1' }), null);
  });
});

describe('hooks.json: SubagentStop registration shape', () => {
  test('SubagentStop mirrors the Stop registration (same command form, stop-gate.js)', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf-8'));
    assert.ok(Array.isArray(hooks.hooks.SubagentStop), 'SubagentStop key present');
    const entry = hooks.hooks.SubagentStop[0].hooks[0];
    assert.strictEqual(entry.type, 'command');
    assert.strictEqual(entry.command, 'node');
    assert.ok(entry.args[0].endsWith('stop-gate.js'));
    assert.strictEqual(entry.args[0], hooks.hooks.Stop[0].hooks[0].args[0]);
  });
});
