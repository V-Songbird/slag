"use strict";

// Navigation candidates: a path that did not exist, a whole file read again, a read the host cut, a host notice
// in place of a file, and a large output. Each keeps what the transcript shows apart from a cause it might have,
// the scope that would act on that cause, the smallest change and how to check it. The cause is never verified here.

const path = require("node:path");
const { cut, excerpt } = require("./session-evidence-redaction.js");
const { FOLLOWED } = require("./session-evidence-records.js");
const { CONTENT, placeOf } = require("./session-evidence-shell.js");

const WINDOW = 4; // the actor's later calls kept after a missing path or a cut read
const LARGE = 20000; // characters of one tool output
// Operations whose large output is a candidate. A read's size is its file's, and one read of a long file is often the work.
const LOUD = new Set(["search", "command", "mixed", "other"]);
const DOCUMENT = /\.(?:md|mdx|markdown|rst|adoc)$/i;
// Reading an image or a PDF again shows what changed in it, not a lost place.
const MEDIA = /\.(?:png|jpe?g|gif|webp|bmp|ico|pdf)$/i;
// Claude Code's answer, in place of the file, to a Read of a file unchanged since the session last read it.
const UNCHANGED = /^\s*Wasted call\s*[—–-]\s*file unchanged since your last Read\b/;
// A plan is the agent's own text.
const OWN_TEXT = new Set(["ExitPlanMode"]);
const QUIET = new Set(["none", "transient"]);

// The smallest change for each candidate cause, and how to check it, with the scope that would make it.
const SECTION = [
  "documentation",
  "Hand the document to docs-align: a descriptive heading or a section link lets one section be read alone. Split only a separable topic.",
  "The next session reaches the section it needs with one ranged read or search.",
];
const ADVICE = {
  "missing-path:wrong-location": [
    "map-file", "Add a focused path hint for this file to the map file's Where things live, unless it already names the place.",
    "Confirm from observed.next that the later file is the one the actor looked for.",
  ],
  "missing-path:outside-project": [
    "machine", "No repository change. Report the location for the owner's own global instruction file.",
    "Confirm that the later path lies outside the repository.",
  ],
  "missing-path:temporary-output": ["transient", "No change: temporary output is not part of the project.", "Confirm that the path is a temporary location."],
  "missing-path:not-yet-created": [
    "none", "No change: the actor checked for a file that it then created.", "Confirm the later write of the same path in observed.next.",
  ],
  "missing-path:unknown": [
    "none", "No change, unless the transcript shows that the actor needed this file.", "Read the calls in observed.next to see what the actor did instead.",
  ],
  "truncated-read:paged": [
    "none", "No change: the actor read the rest by range or by search.", "Confirm that the later read or search in observed.next reached what the task needed.",
  ],
  "truncated-read:long-document": SECTION,
  "truncated-read:long-file": [
    "none", "No change: a long file is read by range or search, and its size alone is no reason to split it.",
    "Confirm that the task did not depend on the part that was cut.",
  ],
  "repeated-read:long-document": SECTION,
  "repeated-read:re-read": ["none", "No change: reading a file again is ordinary work.", "Confirm that nothing between the reads changed the file."],
  "repeated-read:possible-change": [
    "none", "No change: a call of unknown effect ran between the reads, so the second read may check its result.",
    "Read the calls between observed.earlierCallLine and observed.callLine.",
  ],
  "host-notice:re-read": [
    "none", "No change: the host answered with a notice instead of the file.", "Do not count this result as a content read or as evidence about the file.",
  ],
  "large-output:verbose-command": [
    "reporter", "If the command passed, name the quieter form the project already supports, such as a reporter flag, in the map file's Commands. "
      + "A check script that prints on success goes to repo-layout.",
    "The quieter command still prints failures and prints less when it passes.",
  ],
  "large-output:command-output": [
    "none", "No change: reading, formatting, version control or a program that is no project tool printed it, so no project reporter is at fault.",
    "Confirm that the command runs no project build, test or package tool.",
  ],
  "large-output:outside-script": [
    "source", "No repository change. Report it against the plugin or tool whose script printed it: the script lies outside the project.",
    "Confirm that the script the command ran lies outside the working directory.",
  ],
  "large-output:background-output": [
    "none", "No change for the tool that returned it: the text is a background command's output. A project tool's output routes like a verbose command.",
    "Find the call that started the task and check what it ran.",
  ],
  "large-output:broad-search": [
    "layout", "Run repo-layout's audit: if generated or dependency folders fill the results, ignore them. Otherwise no change.",
    "The same search prints fewer lines once those folders are ignored.",
  ],
  "large-output:failure-output": ["none", "No change: a failure's output is its evidence.", "Read the failure candidate for the same call."],
  "large-output:tool-output": [
    "source", "No repository change. Report it against the tool or server that returned it.",
    "Confirm that the output came from that tool, not from a project command.",
  ],
  "large-output:appended-text": [
    "source", "No repository change. Report it against the host, hook, output style or plugin that appended the text.",
    "Confirm that the appended text is not the tool's own output.",
  ],
};

function navigator(limit) {
  return {
    limit, facts: new WeakMap(), byKey: new Map(), actors: new Map(), reads: new Map(), versions: new Map(), backgrounds: [], open: [],
    unknownEffects: 0, compactions: 0, kept: [], counts: {},
  };
}

// An actor's task phase when it issued a call: orientation while it has only read and searched since its prompt, change
// once it edited or wrote a file, and unknown after a command, a mixed command or a delegated call, or with no prompt.
// The calls of one assistant message ran together, so each has the phase the first of them had.
function phaseOf(nav, actor, promptLine, message) {
  const state = nav.actors.get(actor);
  if (promptLine === null) return "unknown";
  if (!state || state.promptLine !== promptLine) return "orientation";
  if (message !== null && state.message === message) return state.messagePhase;
  return state.changed ? "change" : state.unknown ? "unknown" : "orientation";
}

// A new call: it moves its actor's phase, may change files, and joins the calls that follow an open candidate. `key`
// is its call id, `message` the assistant message that issued it, `background` whether it started a background
// command, and `task` the background task whose output it returns.
function called(nav, call, shape, { actor, key, message, cwd, background = false, task = null }) {
  let state = nav.actors.get(actor);
  if (!state || state.promptLine !== call.promptLine) {
    state = { promptLine: call.promptLine, changed: false, unknown: false, message: null, messagePhase: null };
    nav.actors.set(actor, state);
  }
  if (message === null || state.message !== message) Object.assign(state, { message, messagePhase: call.phase });
  const changes = call.operation === "edit" || call.operation === "write";
  const unknown = call.operation === "command" || call.operation === "mixed" || Boolean(shape.opaque);
  state.changed = state.changed || changes;
  state.unknown = state.unknown || unknown;
  if (changes && shape.path) nav.versions.set(shape.path, (nav.versions.get(shape.path) || 0) + 1);
  else if (changes || unknown) nav.unknownEffects += 1;
  const fact = {
    actor, call, message, path: shape.path, whole: Boolean(shape.whole), tool: Boolean(shape.tool), outside: Boolean(shape.outside), cwd,
    background, task, line: null, timestamp: null, outcome: null, characters: 0, saved: null, started: "", source: null, cut: false, repeated: false,
  };
  nav.facts.set(call, fact);
  // Only a Read can receive the host's notice that it was cut.
  if (call.operation === "read") nav.byKey.set(key, fact);
  if (background) nav.backgrounds.push(fact);
  // Calls arrive in line order and a candidate opens at its result, so a call issued before the result never joins.
  // Neither does one from the same assistant message: it ran beside the call, whenever the host wrote it down.
  for (const candidate of nav.open) {
    const follows = candidate.fact.actor === actor && candidate.observed.promptLine === call.promptLine
      && !(message !== null && candidate.fact.message === message);
    if (follows && candidate.next.length < WINDOW) candidate.next.push(fact);
  }
}

// Two calls from one assistant message ran together, whatever order the host wrote them in.
function siblings(nav, a, b) {
  const first = nav.facts.get(a);
  const second = nav.facts.get(b);
  return Boolean(first && second && first.message !== null && first.message === second.message);
}

// A candidate that means no change and will keep meaning it: one without later calls; a cut read of a file that is no
// document, or one already read on, which later calls can only leave at no change; a file the actor went on to
// create; or one whose later calls are all answered and can have no more company, because four are in or because
// its actor has moved on to a later prompt.
function settledQuiet(nav, candidate) {
  const cause = judge(candidate);
  if (!QUIET.has(ADVICE[`${candidate.kind}:${cause}`][0])) return false;
  if (!candidate.next || cause === "paged" || cause === "long-file" || cause === "not-yet-created") return true;
  if (candidate.fact.path && placeOf(candidate.fact.path, candidate.fact.cwd) === "temporary") return true;
  const closed = candidate.next.length === WINDOW || nav.actors.get(candidate.fact.actor).promptLine !== candidate.observed.promptLine;
  return closed && candidate.next.every((call) => call.outcome !== null);
}

// The kept candidates are bounded. One that settled on no change leaves first, so that it never pushes out one that
// may call for a change.
function note(nav, kind, observed, fact, follows = false) {
  const candidate = { kind, observed, fact, next: follows ? [] : null };
  nav.counts[kind] = (nav.counts[kind] || 0) + 1;
  nav.kept.push(candidate);
  if (nav.kept.length > nav.limit) nav.kept.splice(Math.max(nav.kept.findIndex((kept) => settledQuiet(nav, kept)), 0), 1);
  if (follows) nav.open.push(candidate);
  nav.open = nav.open.filter((open) => open.next.length < WINDOW && nav.kept.includes(open));
}

// The call that started the background task a call reads: the last background command of the same actor whose
// result names the task.
function startOf(nav, fact) {
  if (!fact.task) return null;
  const id = new RegExp(String.raw`(?:^|[^\w-])${fact.task.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\w-])`);
  return nav.backgrounds.filter((start) => start.actor === fact.actor && id.test(start.started)).pop() || null;
}

// A settled call inside the interval, and the candidates its result starts. `size` is the output's length, or the size
// the host states for an output it saved elsewhere; `missing` and `cut` are the result's lines that say its path does
// not exist or that its content was cut.
function answered(nav, call, result) {
  const fact = nav.facts.get(call);
  if (!fact) return;
  Object.assign(fact, { line: result.line, timestamp: result.timestamp, outcome: result.outcome, characters: result.size, saved: result.saved });
  if (fact.background) fact.started = result.output.slice(0, 400);
  const observed = { line: result.line, timestamp: result.timestamp, ...call };
  const { size: characters, persisted } = result;
  const ok = result.outcome === "ok";
  if (result.missing && FOLLOWED.has(call.operation)) {
    note(nav, "missing-path", { ...observed, resultExcerpt: excerpt(result.missing, 240) }, fact, true);
  }
  if (call.operation === "read") {
    const key = JSON.stringify([fact.actor, fact.path]);
    const earlier = fact.path ? nav.reads.get(key) : undefined;
    if (result.cut) {
      fact.cut = true;
      note(nav, "truncated-read", { ...observed, characters, persisted, noticeLine: null, resultExcerpt: excerpt(result.cut, 240) }, fact, true);
    } else if (ok && UNCHANGED.test(result.output)) {
      note(nav, "host-notice", {
        ...observed, notice: "unchanged-since-read", earlierLine: earlier ? earlier.line : null, resultExcerpt: excerpt(result.output, 240),
      }, fact);
    } else if (ok && fact.path && fact.whole && !MEDIA.test(fact.path) && placeOf(fact.path, fact.cwd) === "project") {
      const version = nav.versions.get(fact.path) || 0;
      // The same actor, task, file content and context: no prompt, change or compaction came between, and the earlier
      // read was no sibling from the same assistant message.
      if (earlier && earlier.promptLine === call.promptLine && earlier.version === version && earlier.compactions === nav.compactions
        && !(fact.message !== null && earlier.message === fact.message)) {
        fact.repeated = true;
        note(nav, "repeated-read", {
          ...observed, characters, earlierLine: earlier.line, earlierCallLine: earlier.callLine,
          unknownEffectsBetween: nav.unknownEffects - earlier.unknownEffects,
        }, fact);
      }
      nav.reads.set(key, {
        line: result.line, callLine: call.callLine, promptLine: call.promptLine, message: fact.message, version,
        compactions: nav.compactions, unknownEffects: nav.unknownEffects,
      });
    }
  }
  if ((characters >= LARGE && LOUD.has(call.operation) && !OWN_TEXT.has(call.tool)) || result.appended >= LARGE) {
    fact.source = startOf(nav, fact);
    note(nav, "large-output", {
      ...observed, characters, persisted, appendedCharacters: result.appended, outcome: result.outcome,
      startedBy: fact.source ? fact.source.call.callLine : null,
    }, fact);
  }
}

// Claude Code's notice, in a record of its own after the result, that it showed only part of a Read. A cut read is
// not a whole read of its file, so it neither repeats one nor is one to repeat.
function noticed(nav, key, line, banner) {
  const fact = nav.byKey.get(key);
  if (!fact || fact.cut || fact.call.operation !== "read" || fact.outcome !== "ok") return;
  fact.cut = true;
  const read = JSON.stringify([fact.actor, fact.path]);
  if (nav.reads.has(read) && nav.reads.get(read).line === fact.line) nav.reads.delete(read);
  if (fact.repeated) {
    nav.kept = nav.kept.filter((candidate) => !(candidate.kind === "repeated-read" && candidate.fact === fact));
    nav.counts["repeated-read"] -= 1;
    if (!nav.counts["repeated-read"]) delete nav.counts["repeated-read"];
  }
  note(nav, "truncated-read", {
    line: fact.line, timestamp: fact.timestamp, ...fact.call, characters: fact.characters, persisted: false, noticeLine: line,
    resultExcerpt: excerpt(banner, 240),
  }, fact, true);
}

// The cause the observed facts leave most plausible. It is a hypothesis for the reviewer to verify.
function judge({ kind, observed, fact, next }) {
  const later = next || [];
  const same = (call) => fact.path !== null && call.path === fact.path && call.outcome === "ok";
  if (kind === "missing-path") {
    if (fact.path && placeOf(fact.path, fact.cwd) === "temporary") return "temporary-output";
    if (later.some((call) => same(call) && call.call.operation === "write")) return "not-yet-created";
    const name = fact.path && path.posix.basename(fact.path);
    const found = name && later.find((call) => call.outcome === "ok" && call.path && call.path !== fact.path && path.posix.basename(call.path) === name);
    if (!found) return "unknown";
    return { project: "wrong-location", temporary: "temporary-output", outside: "outside-project" }[placeOf(found.path, found.cwd)];
  }
  if (kind === "truncated-read") {
    // The rest is a ranged read or a search of the same file, or a read of the output the host saved.
    const rest = (call) => (same(call) && (call.call.operation === "search" || (call.call.operation === "read" && !call.whole)))
      || (fact.saved !== null && call.path === fact.saved && call.outcome === "ok" && CONTENT.has(call.call.operation));
    if (later.some(rest)) return "paged";
    return fact.path && DOCUMENT.test(fact.path) ? "long-document" : "long-file";
  }
  if (kind === "repeated-read") {
    if (observed.unknownEffectsBetween > 0) return "possible-change";
    return DOCUMENT.test(fact.path) && observed.characters >= LARGE ? "long-document" : "re-read";
  }
  if (kind === "host-notice") return "re-read";
  if (observed.characters < LARGE || !LOUD.has(observed.operation) || OWN_TEXT.has(observed.tool)) return "appended-text";
  if (observed.outcome === "failed") return "failure-output";
  if (fact.task === null && observed.operation === "search") return "broad-search";
  if (fact.task === null && observed.operation === "other") return "tool-output";
  // A background task's output is its command's: it routes like that command's own output.
  const origin = fact.task === null ? fact : fact.source;
  if (!origin) return "background-output";
  return origin.tool ? "verbose-command" : origin.outside ? "outside-script" : "command-output";
}

// A call that followed a candidate, as the evidence shows it.
function laterCall({ call, line, outcome }) {
  const input = call.commandOrArguments === null ? null : cut(call.commandOrArguments, 160);
  return { line, callLine: call.callLine, tool: call.tool, operation: call.operation, path: call.path, commandOrArguments: input, outcome };
}

function navigationOf(nav, warnings) {
  const total = Object.values(nav.counts).reduce((sum, n) => sum + n, 0);
  if (total > nav.limit) {
    warnings.add(`Only ${nav.limit} navigation candidates are shown, those that mean no change leaving first; counts cover the selected interval.`);
  }
  return nav.kept.map((candidate) => {
    const cause = judge(candidate);
    const [scope, intervention, verification] = ADVICE[`${candidate.kind}:${cause}`];
    const observed = candidate.next ? { ...candidate.observed, next: candidate.next.map(laterCall) } : candidate.observed;
    return { kind: candidate.kind, observed, candidateCause: cause, scope, intervention, verification };
  });
}

module.exports = { navigator, phaseOf, called, siblings, answered, noticed, navigationOf };
