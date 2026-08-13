---
name: clarify
description: >-
  Runs scribe's clarify rounds for an underspecified request: numbered
  questions via AskUserQuestion, each with concrete options and the
  recommended answer first, repeated until nothing material is left to ask,
  then a one-line task statement and execution. Use when the scribe gate has judged
  the current request ambiguous, or the user says "clarify first", "ask me
  before building", "what would you need to know". Do NOT use for project
  setup or roadmap interviews (other tools own those), to produce an
  implementation plan, or to judge the user's answers to its own questions.
---

# clarify — define the task before cutting it

The request could honestly be executed in materially different ways. Your job
is to close every one of those gaps before you cut, then execute. Never
mention this skill's machinery; just ask well.

If this session is unattended — headless, goal-driven, a background agent —
do not ask. Take the most reasonable reading, proceed, and say so in one line
when you report. Under a silence-first output style, an ask made here is the
permitted case: you are blocked on input only the user can provide.

## The rounds

0. **Check the project's remembered answers.** If `.scribe/memory.jsonl`
   exists, read it (latest line per term wins; a `forgotten` line removes the
   term). A remembered term is a stated assumption, never a question: fold it
   into the close line ("Assuming improve = speed here, as remembered") and
   drop that question from the round.
1. **Blind-spot pass first.** Before asking anything, name to yourself what
   the request never mentions but the work will hit: neighboring code, tests,
   callers, docs, error paths. A finding becomes a question only if it changes
   what you would build.
2. **Ask the whole frontier in ONE AskUserQuestion call** — every question
   that is currently askable. The tool holds 4, so a wider frontier spills
   into the next round. Do not drip questions one at a time.
3. **Every question carries options (max 4), your best guess first, its label
   suffixed "(Recommended)".** Ground each option in this codebase — what the
   file actually does, who actually calls it — never generic categories.
4. **Never ask what you can read.** Facts derivable from the prompt, the
   repository, or configuration are not questions. Asking one burns trust.
5. **Keep asking until the frontier is empty.** A follow-up is earned two
   ways: it spilled over from a call that held only 4, or an answer unlocked
   it ("Speed" may unlock "the hot path is in a dependency — wrap it or
   refactor it too?"). Stop when neither is left, not before. Leaving a
   material gap unasked is the failure this skill exists to prevent.
6. **Close in one line.** State the now-defined task ("Task: memoize
   `normalize()` at this call site, measure before and after") and execute.
   The user can veto in a glance.

## Hard rules

- Rounds continue until nothing material is left to ask; they ride the
  conversation naturally rather than queueing as separate interruptions.
- "Just do it" — or any equivalent — is honored instantly, that turn, without
  argument. Proceed on your recommended reading.
- Never judge the user's answers to these questions; answers are answers.
- Asks are logged automatically by scribe's observer; you log nothing.

Option-crafting rules, materiality examples, and the full method live in
[references/method.md](references/method.md) — read it when a round needs
more than the rules above.
