"use strict";

// Stall candidates: a turn that ended on an offer to go on, a question or a list of next steps, after which the
// owner's next prompt only said to continue. The session waited for a word it did not need. The ending and the
// prompt are read from their text alone; whether the stop was needed is for the reviewer to judge.

const { excerpt } = require("./session-evidence-redaction.js");
const { shellShape } = require("./session-evidence-shell.js");

// A prompt that only says to go on, in English or Spanish: words of assent, politeness and going on, ending on one
// that asks to go on, and nothing else. Assent alone, such as "yes", answers a question, so it is no such prompt.
const ASSENT = String.raw`(?:ok(?:ay)?|yes|yeah|yep|sure|alright|good|great|perfect|thanks|thank you|s[ií]|vale|bueno|claro|perfecto|genial|listo|gracias|de acuerdo)`;
const GO_ON = String.raw`(?:continue|go on|go ahead|keep going|carry on|proceed|resume|next|contin[uú]a|contin[uú]e|contin[uú]emos|continuar|sigue|segu[ií]|sigamos|seguir|prosigue|adelante|dale|avanza|siguiente)`;
const POLITE = String.raw`(?:please|pls|then|por favor|entonces|pues)`;
const CONTINUE_ONLY = new RegExp(String.raw`^(?:(?:${ASSENT}|${POLITE}|${GO_ON}) )*${GO_ON}(?: ${POLITE})*$`, "u");

// Offers to go on, in the ending's last paragraph.
const OFFER = new RegExp([
  String.raw`\b(?:do you )?want me to\b`, String.raw`\bwould you like (?:me )?to\b`, String.raw`\bshall I\b`,
  String.raw`\bshould I (?:continue|proceed|go ahead|keep going|go on|move on|start|begin|carry on)\b`,
  String.raw`\b(?:let me know|tell me) (?:if|whether|when)\b`, String.raw`\bif you(?:'d| would)? (?:like|want|prefer),? I (?:can|could|will|'ll)\b`,
  String.raw`\bI can (?:continue|proceed|keep going|go on|move on|start|begin|carry on)\b`, String.raw`\bready (?:to (?:continue|proceed|start)|for the next)\b`,
  String.raw`\bsay (?:the word|go|yes|continue)\b`, String.raw`\bwith your (?:go-ahead|ok|approval)\b`,
  String.raw`\bquieres que\b`, String.raw`\bte gustar[ií]a que\b`, String.raw`(?:^|[\s¿])(?:sigo|contin[uú]o|procedo|avanzo|arranco|empiezo)\b`,
  String.raw`\bsi (?:quieres|gustas|te parece),? (?:puedo|sigo|contin[uú]o|procedo)\b`, String.raw`\bpuedo (?:continuar|seguir|proceder|avanzar)\b`,
  String.raw`\b(?:dime|av[ií]same) (?:si|cu[aá]ndo)\b`, String.raw`\bcuando (?:digas|quieras)\b`, String.raw`\bcon tu (?:visto bueno|s[ií]|ok|aprobaci[oó]n)(?![\p{L}\p{N}_])`,
].join("|"), "iu");
// A heading or lead-in that names what is left to do, and a closing line that names the one next step.
const NEXT_STEPS = /\b(?:next steps?|remaining|still (?:to do|open|left)|to-?dos?|what'?s left|left to do|pending|follow-?ups?|open items)\b|(?:pr[oó]ximos pasos|siguientes pasos|pendientes?|lo que falta|falta(?:n)? por hacer|queda(?:n)? por hacer|por hacer)/iu;
const NEXT_LINE = /^\W*(?:next(?: step)?|siguiente(?: paso)?|pr[oó]ximo paso)\W*:/iu;
const LIST_ITEM = /^\s*(?:[-*•+]|\d+[.)])\s+\S/;
const CODE_SPAN = /`([^`\n]+)`/g;
// An action an owner authorizes on its own, whatever the task: a commit, a push, a merge, a release or a deployment,
// and spending money. An ending that asks for one is a real stop, not a stall.
// Word edges are Unicode letters, so "Próximos" holds no "PR".
const GATED = [
  /(?<![\p{L}\p{N}_])(?:commit|push|merge|deploy|publish|release|spend|commite|publica|despleg|desplieg|gasta)\p{L}*(?![\p{L}\p{N}_])/iu,
  /(?<![\p{L}\p{N}_])(?:pull requests?|tag|costs?|cuesta)(?![\p{L}\p{N}_])|\$\s?\d/iu,
  /(?<![\p{L}\p{N}_])PRs?(?![\p{L}\p{N}_])/u,
];

// The prompt's words, lower case, without punctuation, symbols or markup.
function words(text) {
  return text.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
}

// Whether a prompt only says to go on: its text alone, once host envelopes such as <system-reminder>…</…> are removed.
function continueOnly(text) {
  const typed = text.replace(/<([a-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  return typed.length <= 80 && CONTINUE_ONLY.test(words(typed));
}

// How an assistant's final text ends: an offer to go on, a question or a list of next steps, which can be one closing
// line such as "Next: …"; null for anything else, such as a finished result. Only the last paragraph, or the list the
// text ends with and the line that leads into it, is read, so an offer or a question earlier in the text does not count.
function endingOf(text) {
  const lines = text.replace(/\r/g, "").trimEnd().split("\n");
  let start = lines.length - 1;
  while (start > 0 && lines[start - 1].trim() !== "") start -= 1;
  const paragraph = lines.slice(start).join("\n").trim();
  if (!paragraph) return null;
  if (OFFER.test(paragraph)) return { ending: "offer", tail: paragraph };
  // The list the text ends with, across blank lines between its items, and the line before it.
  let first = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (LIST_ITEM.test(lines[i])) first = i;
    else if (lines[i].trim() !== "" && !/^\s{2,}\S/.test(lines[i])) break;
  }
  if (first < lines.length) {
    let lead = first - 1;
    while (lead >= 0 && lines[lead].trim() === "") lead -= 1;
    if (lead >= 0 && NEXT_STEPS.test(lines[lead])) return { ending: "next-steps", tail: lines.slice(lead).join("\n").trim() };
  }
  const last = paragraph.split("\n").pop();
  if (last.replace(/[\s*_`)"'\]]+$/, "").endsWith("?")) return { ending: "question", tail: paragraph };
  if (NEXT_LINE.test(last)) return { ending: "next-steps", tail: last.trim() };
  return null;
}

// The project commands an ending names in code spans, such as `npm test`, by the shell classification's project tools.
function projectCommands(tail) {
  const named = [];
  for (const [, span] of tail.matchAll(CODE_SPAN)) if (shellShape(span, null).tool && !named.includes(span)) named.push(span);
  return named;
}

const CAUSES = { offer: "offer-to-continue", question: "question-before-continuing", "next-steps": "next-steps-listed" };

// The main session's turns, read in line order: its latest text, cleared by any later call or result, and the outcome
// of its latest result. The owner's next prompt settles the turn.
function stallTracker(limit) {
  return { limit, ending: null, outcome: null, promptLine: null, kept: [], counts: {} };
}

// The assistant's text. Codex repeats a message as an event, so the first record of the same text keeps its line.
function said(stalls, text, line, timestamp) {
  if (text.trim() && !(stalls.ending && stalls.ending.text === text)) stalls.ending = { text, line, timestamp };
}

// A call or its result after the text: the turn did not end on the text. `outcome` is a result's, or null for a call.
function worked(stalls, outcome = null) {
  stalls.ending = null;
  if (outcome !== null) stalls.outcome = outcome;
}

// A prompt from the owner. It makes a candidate when the turn before it ended on text of one of the shapes that asks
// for no authorized action, its latest result did not fail, and the prompt only says to go on. `plain` is false when
// the prompt carries more than text, such as an image, or arrived while the session worked.
function prompted(stalls, { line, timestamp, text, plain = true }) {
  const { ending, outcome, promptLine } = stalls;
  Object.assign(stalls, { ending: null, outcome: null, promptLine: line });
  if (!ending || outcome === "failed" || !plain || !continueOnly(text)) return;
  const shape = endingOf(ending.text);
  if (!shape || GATED.some((pattern) => pattern.test(shape.tail))) return;
  const commands = projectCommands(shape.tail);
  stalls.counts[shape.ending] = (stalls.counts[shape.ending] || 0) + 1;
  stalls.kept.push({
    kind: "stall",
    observed: {
      line: ending.line, timestamp: ending.timestamp, promptLine, ending: shape.ending, endingExcerpt: excerpt(shape.tail, 240),
      nextPromptLine: line, nextPromptTimestamp: timestamp, nextPrompt: excerpt(text.trim(), 120),
      projectCommands: commands.slice(0, 3).map((command) => excerpt(command, 120)),
    },
    candidateCause: CAUSES[shape.ending],
    scope: commands.length ? "map-file" : "machine",
    intervention: commands.length
      ? "If the owner wants the named command run without asking, name it in the map file's Commands or Rules. Otherwise no change."
      : "No repository change. Report a line for the owner's own global instruction file: finish the task without stopping to offer, ask or list next steps, unless a real stop applies.",
    verification: "Read the turn's last text and the owner's next prompt, and check that no instruction, approval or permission required the stop.",
  });
  if (stalls.kept.length > stalls.limit) stalls.kept.shift();
}

function stallsOf(stalls, warnings) {
  const total = Object.values(stalls.counts).reduce((sum, n) => sum + n, 0);
  if (total > stalls.limit) warnings.add(`Only the last ${stalls.limit} stall candidates are shown; counts cover the selected interval.`);
  return { stallCounts: stalls.counts, stallCandidates: stalls.kept };
}

module.exports = { stallTracker, said, worked, prompted, stallsOf };
