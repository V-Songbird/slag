# scribe scope

- **Status:** proposed target scope — the three foundation forks (name, mechanism,
  v1 posture) were ratified by the owner on 2026-08-11 in the scaffold interview;
  the rest of this document awaits sign-off item S1 in
  `docs/research/scribe/00-BRIEF.md`
- **Product:** scribe
- **Host:** Claude Code
- **Default mode:** advisory, local, log-everything

This document defines what scribe is, what it owns, and what it must never
become. Existing gaps between this contract and the implementation are
migration work, not exceptions to the scope.

## Product definition

scribe is a clarify-first gate for ambiguous requests.

> When a request could honestly be executed several materially different ways,
> scribe has Claude ask one focused question round — numbered questions, each
> with options and a recommended answer first — and repeat until the task is
> defined well enough to execute cleanly. A precise request passes untouched.

scribe operationalizes the four-quadrant unknowns model from Anthropic's
field-guide post (claude.com/blog/a-field-guide-to-claude-fable-finding-your-unknowns):

| Quadrant | scribe's treatment |
| --- | --- |
| Known knowns | Facts in the prompt or repository — never asked, ever |
| Known unknowns | The question frontier — asked, numbered, options first |
| Unknown knowns | The recommended answer each question carries |
| Unknown unknowns | A blind-spot pass names them before round one |

## Product promise

Before Claude acts on an ambiguous request, the user can answer three things:

1. **What did Claude think I meant?** — the recommended reading, stated.
2. **What else could I have meant?** — the live alternatives, as options.
3. **What does my answer unlock?** — follow-ups appear only when an answer
   opens them; the loop closes when the frontier is empty.

## Who scribe is for

Anyone whose requests are sometimes underspecified — which is everyone. The
design center is a developer in an interactive session who would rather spend
ten seconds answering than ten minutes unwinding the wrong guess.

## Experience contract

New capability must preserve these expectations:

- scribe works immediately after installation with no initialization step;
- a precise request is never interrupted — the gate's default is silence;
- at most one question round fires before work starts; follow-ups ride the
  conversation, not a queue of separate interruptions;
- every question leads with a recommended answer, so agreement is one click;
- "just do it" (and any equivalent) is always honored, that turn, without
  argument, and is itself logged;
- facts derivable from the prompt, the repository, or configuration are never
  asked;
- slash commands and skill invocations are never judged — they are precise by
  construction;
- the user's answers to scribe's own questions are never themselves judged;
- unattended contexts (headless runs, autonomous loops, background agents)
  are detected and scribe stands down rather than blocking on a question;
- every decision — asked or passed through — is recorded in a local ledger;
  no telemetry, no account, no service;
- the always-loaded prompt cost is measured, capped, and enforced by a test.

## The jobs scribe owns

1. **Judge** — classify each actionable request: precise, ambiguous, or
   out of scope for judging (commands, answers, unattended contexts).
2. **Ask** — craft the question frontier: numbered, optioned, recommendation
   first, nothing already derivable, nothing fatiguing.
3. **Record** — write every decision to the ledger with enough context to
   evaluate it later.
4. **Tune** — expose the asking bar as evidence-backed configuration, adjusted
   from the ledger, never from vibes.

## Mechanical-first split

Ambiguity is a semantic judgment; scribe does not pretend otherwise.

- **Mechanical, owned by code:** hook wiring and stand-down detection, the
  observed-ask ledger (asks are tool calls a hook can see), configuration and
  kill switch, the injected-prompt byte budget and its enforcing test.
- **Model, owned by prose:** the ambiguity judgment itself, question and
  option crafting, the recommended answer. These are disclosed as
  model-judged and are exactly why the gate is advisory, never enforcing.

## Product boundaries

- **A gate, not a planner.** scribe defines the task; it does not produce
  implementation plans, designs, or estimates. Plan mode exists.
- **A question, not a wall.** scribe influences the model; it never blocks a
  turn, retries a refusal, or holds "done" hostage.
- **Prompt-time, not setup-time.** Project-setup interviews belong to other
  tools; scribe judges live requests in ordinary work.
- **Under-specification only.** Coaching an over-specified prompt back toward
  flexibility is out of scope at v1 — a named known unknown, not a feature.
- **Local, always.** No hosted anything.

## Feature admission test

A proposed feature belongs in scribe when:

1. it reduces wrong-guess executions, or the cost of preventing them;
2. it respects the silence default — precise requests stay uninterrupted;
3. its important invariant is testable mechanically;
4. it keeps the always-loaded budget inside the measured cap;
5. the user could explain what scribe asked and why in one sentence.

## Release gates

The first cut (0.1.0-alpha) is releasable only when:

- a labeled prompt fixture — ambiguous, precise, near-miss — exists, and the
  shipped rubric names the fixture's categories correctly;
- the injected prompt stays under its declared byte cap, asserted by a test;
- every stand-down path (kill switch, unattended context, slash command) is
  covered by a test that pipes a synthetic prompt through the real hook;
- the ledger records both an ask and a pass-through in a live session
  (witnessed, jig-style, before the cut is called done);
- the plugin adds zero always-loaded cost beyond the one measured rubric;
- the README stops saying "not built yet".
