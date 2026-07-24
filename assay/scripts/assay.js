#!/usr/bin/env node
"use strict";

// assay engine — deterministic scoring of Claude Code rule files and
// .claude/skills/*/SKILL.md frontmatter descriptions.
//
// Commands (run from the project root being audited):
//   node assay.js scan [--root <path>]   discover + extract + mechanical scores;
//                                        writes .assay-tmp/scan.json, prints a
//                                        JSON summary with the judgment worklist
//   node assay.js report [--verbose] [--json] [--root <path>]
//                                        merges .assay-tmp/judgments.json, computes
//                                        composite scores + placement candidates,
//                                        prints the finished markdown report
//   node assay.js remeasure [--verbose] [--json] [--root <path>]
//                                        re-scans after fixes, reuses cached
//                                        judgments (re-judging only reworded
//                                        rules), prints a before/after report
//   node assay.js clean [--root <path>]  removes .assay-tmp/
//
// Everything mechanical happens here; the only model-judged inputs are F3
// (trigger-action distance) and F8 (enforceability), supplied via judgments.json.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const TMP_DIR = ".assay-tmp";

// ---------------------------------------------------------------------------
// Data tables
// ---------------------------------------------------------------------------

const VERB_TIERS_RAW = [
  { score: 1.0, label: "unconditional_mandate", verbs: ["must", "required"] },
  { score: 0.95, label: "strong_prohibition", verbs: ["never", "do not", "don't", "forbidden", "cannot", "must not"] },
  {
    score: 0.85, label: "bare_imperative", verbs: [
      "use", "run", "ensure", "place", "return", "validate", "add", "create", "implement", "include",
      "set", "write", "check", "apply", "import", "export", "call", "pass", "configure", "define",
      "make", "keep", "follow", "put", "handle", "wrap", "throw", "catch", "extend", "override",
      "test", "verify", "assert", "name", "format", "structure", "organize", "separate", "split",
      "merge", "combine", "convert", "transform", "parse", "serialize", "render", "display", "log",
      "track", "store", "save", "load", "read", "delete", "remove", "update", "replace", "insert",
      "append", "prepend", "edit", "modify", "regenerate", "rebuild", "restart", "install", "deploy",
      "commit", "push", "pull", "fetch", "rebase", "tag", "release", "document", "annotate",
      "refactor", "migrate", "initialize", "register", "enable", "disable", "allow", "block",
      "reject", "accept", "emit", "publish", "subscribe", "listen", "watch", "mount", "unmount",
      "report", "record", "reset", "revert", "avoid", "enforce", "restrict", "limit", "generate",
      "execute", "maintain", "expose", "guard", "preserve", "notify", "specify", "invoke", "compose",
      "bind", "defer", "inline", "encrypt", "decrypt", "sanitize", "normalize", "optimize", "lint",
      "retry", "abort", "cache", "pin", "scope", "flush", "throttle", "debounce", "suppress",
      "freeze", "truncate", "rotate", "scaffold", "bootstrap", "populate", "drain", "terminate",
      "preload", "paginate", "escalate", "centralize", "standardize", "prioritize", "coordinate",
      "minimize", "authenticate", "authorize", "archive", "batch", "aggregate", "benchmark",
      "profile", "isolate", "provision", "orchestrate", "coerce", "cut", "drop"
    ]
  },
  { score: 0.7, label: "advisory", verbs: ["should", "always"] },
  { score: 0.5, label: "preference", verbs: ["prefer", "default to", "favor"] },
  { score: 0.3, label: "suggestion", verbs: ["consider", "aim to", "where practical"] },
  { score: 0.2, label: "hedged", verbs: ["try to", "try to prefer", "where possible", "when you can"] },
  { score: 0.1, label: "weak_suggestion", verbs: ["you might want to", "it's worth", "keep in mind"] },
];
const IMPLICIT_VERB_DEFAULT = 0.7;

// Flattened, pattern-precompiled, longest-first.
const VERB_TIERS = [];
for (const tier of VERB_TIERS_RAW) {
  for (const verb of tier.verbs) {
    VERB_TIERS.push({
      verb,
      score: tier.score,
      label: tier.label,
      pattern: new RegExp("(?:^|[\\s,;(])(" + escapeRe(verb) + ")(?:[\\s,;.)!?]|$)"),
    });
  }
}
VERB_TIERS.sort((a, b) => b.verb.length - a.verb.length);

const ALL_VERBS = new Set(VERB_TIERS.map((t) => t.verb));

const PROHIBITION_MARKERS = ["never ", "do not ", "don't ", "avoid ", "must not "];
// A prohibition marker only counts when it leads its clause — "those APIs
// don't exist" is a statement of fact, not a directive, and must not read as
// a stall-risk prohibition. Mid-clause directives still match after
// punctuation, a dash, an opening quote/paren, or bold markers.
const PROHIBITION_CLAUSE_RE = new RegExp(
  "(?:^|[.!?;:,]\\s|[—–]\\s?|[(\"*])(?:" +
  ["never", "do not", "don't", "avoid", "must not"].map((m) => escapeRe(m)).join("|") +
  ")\\b"
);
const HEDGED_MARKERS = ["prefer ", "default to ", "when possible"];
const ALTERNATIVE_MARKERS = ["instead", " rather than "];

const CONCRETE_REGEX = [
  /`[^`]+`/g,
  /\b[A-Z][a-zA-Z]+(?:Manager|Service|Controller|Factory|Builder|Handler|Provider|Repository|Validator|Schema|Config|Context|Store|Router|Middleware|Plugin|Hook|Component|Module|Interface|Type|Enum|Error|Exception)\b/g,
  /\b\w+\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|md|json|yaml|yml|toml|css|scss|html|sql|sh|bash)\b/g,
  /(?:src|lib|test|tests|spec|specs|components|pages|api|utils|hooks|services|models|types|config|scripts)\/[\w/.-]+/g,
  /\b(?:React|Vue|Angular|Express|Django|Flask|FastAPI|Spring|Rails|Next|Nuxt|Svelte|Tailwind|TypeScript|Zod|Prisma|Jest|Vitest|pytest|JUnit|ESLint|Prettier|Webpack|Vite|Docker|Kubernetes|GraphQL|REST|gRPC|Redis|PostgreSQL|MongoDB|MySQL|SQLite)\b/g,
];

// Bright-line numeric thresholds count as concrete markers — they turn an
// adjective ("short", "soon") into something mechanically checkable.
const NUMERIC_THRESHOLD_REGEX = [
  /\b(?:fewer|less|more|greater|under|over|above|below|at\s+most|at\s+least|no\s+more\s+than|no\s+less\s+than|no\s+fewer\s+than|up\s+to)\s+(?:than\s+)?\d+(?:\.\d+)?\s*(?:%|(?:ms|milliseconds?|sec(?:ond)?s?|min(?:ute)?s?|hours?|days?|weeks?|months?|years?|kb|mb|gb|bytes?|chars?|characters?|words?|lines?|items?|entries|rows?|examples?|pages?|files?)\b)?/gi,
  /\b\d+(?:\.\d+)?\s*(?:%|(?:ms|milliseconds?|sec(?:ond)?s?|min(?:ute)?s?|hours?|days?|weeks?|months?|years?|kb|mb|gb|bytes?|chars?|characters?|words?|lines?|items?|entries|rows?)\b)/gi,
  /\bbetween\s+\d+(?:\.\d+)?\s+and\s+\d+(?:\.\d+)?\b/gi,
];

// A rule written in a non-Latin script can still match an English verb on a
// borrowed token — a Cyrillic sentence containing "commit" scores F1 0.85 by
// lookup — so the grade reads confident while English-only scoring never
// applied. Flagging the script lets the report say so.
// razor: ceiling is script detection, not language detection — Latin-script
// non-English (Spanish, French, German) is not covered and is not meant to be.
const NON_LATIN_SCRIPT = new RegExp(
  "[\\u0370-\\u03FF\\u0400-\\u04FF\\u0530-\\u058F\\u0590-\\u05FF\\u0600-\\u06FF" +
  "\\u0900-\\u097F\\u0E00-\\u0E7F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF]"
);

const ABSTRACT_MARKERS = [
  "good", "appropriate", "reasonable", "clean", "thoughtful", "proper", "correct", "careful",
  "best practice", "when possible", "where practical", "as needed", "properly", "correctly",
  "carefully", "error handling", "naming", "code quality", "best practices", "maintainable",
  "readable", "scalable", "efficient", "expensive", "simple", "clear", "obvious", "intuitive",
];

const CONCRETE_TERMS = [
  "functional components", "class components", "named exports", "default exports", "barrel exports",
  "type aliases", "interfaces", "enums", "generics", "strict mode", "strict null checks",
  "type guards", "type assertions", "arrow functions", "async functions", "generator functions",
  "unit tests", "integration tests", "end-to-end tests", "snapshot tests", "pre-commit hook",
  "pre-push hook", "commit message", "pull request", "middleware", "error boundary",
  "higher-order component", "custom hook", "dependency injection", "API endpoint", "REST API",
  "GraphQL query", "GraphQL mutation", "database migration", "schema migration", "seed data",
  "environment variable", "config file", "secrets manager", "CI pipeline", "CD pipeline",
  "build step", "deploy step", "code review", "merge request", "branch protection", "linter rule",
  "formatter config", "tsconfig", "eslint config", "request body", "response body",
  "query parameter", "path parameter", "handler boundary", "controller layer", "service layer",
  "repository layer", "connection pool", "input validation", "type guard", "type assertion",
  "type narrowing",
];

// Composite weights and floors — the quality-heuristic contract.
const WEIGHTS = { F1: 1.5, F2: 1.0, F3: 1.3, F4: 1.0, F5: 1.5, F7: 2.0 };
const WEIGHTS_TOTAL = 8.3;
const SOFT_FLOOR_THRESHOLD = 0.2; // applied to F4 and F7
const STALENESS_MULTIPLIER = 0.05;
// A bare prohibition can stall a headless run outright when the task needs the
// banned action — capped to grade F regardless of the other factors.
const STALL_RISK_CAP = 0.3;
// Position only starts to bite in files long enough to bury their bottom rules.
const LONG_FILE_LINES = 50;
const BURIED_F5_THRESHOLD = 0.6;
const F8_HOOK_THRESHOLD = 0.4;
const F4_NO_OVERLAP_SCORE = 0.85;
const F4_AMBIGUOUS_SCORE = 0.65;
const CATEGORY_FLOORS = { mandate: 0.5, override: 0.25, preference: 0.25 };
const LETTER_GRADES = [[0.8, "A"], [0.65, "B"], [0.5, "C"], [0.35, "D"]];

const FRIENDLY_FIXES = {
  F1: "Start with a clear action verb: Use, Always, Never, Run",
  F2: "Name the alternative: 'Never X — do Y instead' (a bare prohibition can stall the task)",
  F3: "Add a trigger: 'When editing X...' or 'Before committing...'",
  F4: "Move to a scoped rule file with paths: frontmatter, or broaden the language",
  F5: "Move the rule into the top quarter of the file, or split the file",
  F7: "Add a file path, code example, or before/after comparison",
};

// Plain-English names for the scoring factors, for the user-facing report. The
// factor codes (F1, F3, F8…) stay internal — a reader shouldn't need the rubric.
const FACTOR_LABELS = {
  F1: "weak verb",
  F2: "framing",
  F3: "no clear trigger",
  F4: "scope mismatch",
  F5: "buried in the file",
  F7: "too vague",
};
// Verbose per-rule table: friendly column headers in factor order.
const FACTOR_COLUMNS = [
  ["F1", "Verb"], ["F2", "Framing"], ["F3", "Trigger"], ["F4", "Scope"],
  ["F5", "Position"], ["F7", "Concrete"], ["F8", "Judgment"],
];

// Placement detection signals (hook / skill / subagent / compound).
const PLACEMENT_CANDIDATE_THRESHOLD = 0.6;
const PLACEMENT_COMPOUND_THRESHOLD = 0.35;

const PLACEMENT_SIGNALS = {
  hook: [
    { name: "f8-low", weight: 0.4, f8Below: F8_HOOK_THRESHOLD },
    { name: "tool-invocation-match", weight: 0.3, pattern: /\b(git\s+(commit|push|tag|reset|rebase|checkout|merge|force-push)|npm\s+(publish|version|install)|yarn\s+(publish|version)|pnpm\s+(publish|version)|pip\s+install|docker\s+push)\b/i },
    { name: "mechanical-verb", weight: 0.2, pattern: /^\s*(never|always|do not|don't)\s+\w+/i },
    { name: "lifecycle-trigger-keyword", weight: 0.25, pattern: /\b(before\s+(committing|pushing|merging|releasing|publishing)|after\s+(tests?\s+pass|the?\s*build|each\s+(edit|write|save))|on\s+save|pre[-\s]commit|post[-\s]commit|session\s+start)\b/i },
    // keep-file-X-in-sync duties: prose compliance is fragile, a PostToolUse
    // hook fires on every edit deterministically
    { name: "distant-file-duty", weight: 0.5, pattern: /\b(?:update|add|append|record|note|log|sync|list|mirror|document)\b[^.;]*\b(?:in|into|to)\s+`?(?:[\w-]+\/)*[\w.-]+\.(?:md|txt|json|ya?ml)\b/i },
  ],
  skill: [
    { name: "reference-pointer-phrase", weight: 0.4, pattern: /\b(follow\s+the\s+(style\s+guide|conventions?|patterns?|spec)|conventions?\s+(are|live)\s+in|see\s+[`"[].*?\bfor\b|refer\s+to\s+(the\s+)?[`"[]|check\s+(against|in)\s+(the\s+)?[`"[]|consult\s+[`"[]|documented\s+in\s+[`"[])/i },
    { name: "external-reference-to-md", weight: 0.25, pattern: /\b[`"[][\w./-]+\.md[`"\]](?!\s*$)/ },
    { name: "workflow-step-chain", weight: 0.35, anyPattern: [/\bfirst\b.*?\bthen\b.*?\b(then|finally|and\s+then)\b/i, /\bstep\s*1\b.*?\bstep\s*2\b/i, /,\s*then\b.*?,\s*then\b/i, /\bafter\s+[^,]+,\s*(do|run|execute)\b.*?,\s*(then|finally)\b/i] },
    { name: "named-procedure-trigger", weight: 0.3, pattern: /^\s*when\s+(deploying|releasing|publishing|shipping|cutting\s+a\s+release|preparing\s+a\s+release|creating\s+a\s+(new\s+)?(component|page|module|service)|scaffolding|bootstrapping)\b/i },
    { name: "pointer-shape", weight: 0.25, pointerShape: true },
  ],
  subagent: [
    { name: "read-large-tree", weight: 0.4, pattern: /\b(read\s+the\s+(full|entire|whole)\s+[\w\s]+|read\s+the\s+source\s+(at|in)|check\s+every\s+[\w\s]+|scan\s+(all|every)\s+[\w\s]+|inspect\s+(all|every)\s+[\w\s]+|traverse\s+(all|every|the\s+entire))\b/i },
    { name: "audit-verb", weight: 0.4, pattern: /\b(audit|review|verify|check)\s+(the\s+)?(diff|code|changes?|coverage|implementation|module|component|feature|test\s+suite|pr|branch|commit)\b/i },
    { name: "judgment-verification-phrase", weight: 0.4, pattern: /\b(make\s+sure\s+(the\s+)?[\w\s]+?\s+(covers?|is\s+(tested|verified|asserted)|meets?)|ensure\s+(the\s+)?[\w\s]+?\s+(complies|satisfies|matches)|verify\s+(the\s+)?[\w\s]+?\s+(covers?|is\s+exercised))\b/i },
    { name: "bias-independence-language", weight: 0.2, pattern: /\b(fresh\s+context|second\s+opinion|independent\s+review|without\s+(knowing|seeing)\s+what\s+was\s+written|unbiased\s+review|from\s+scratch\b|blind\s+review)\b/i },
    { name: "delimited-summary-output", weight: 0.2, pattern: /\b(return\s+(a\s+)?(summary|verdict|list|inventory|report|contract|approved|ok)|report\s+back\s+with|produce\s+(a\s+)?(contract|inventory|summary|report|list\s+of))\b/i },
    { name: "context-heavy-reference", weight: 0.25, pattern: /\b(the\s+(full|entire|whole)\s+(repository|repo|codebase|source\s+tree)|sibling\s+(repo|codebase|project)|external\s+(repository|project|codebase))\b|[A-Za-z]:[\\/][\w\\/.\- ]+|(?<![\w/])\/[\w./-]+\/[\w./-]+/i },
    { name: "agent-invocation-phrase", weight: 0.65, pattern: /\b(run|invoke|delegate\s+to|call|use|spawn|launch)\s+(the\s+)?`?[\w][\w.-]*`?\s+(agent|subagent)\b/i },
  ],
};
const COMPOUND_CONJUNCTION = /(,\s+and\s+|\s+—\s+|\s+--\s+|;\s+|\s+while\s+also\s+|\s+plus\s+)/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function grade(score) {
  for (const [threshold, letter] of LETTER_GRADES) {
    if (score >= threshold) return letter;
  }
  return "F";
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const fm = {};
  const lines = content.split("\n");
  if (!lines.length || lines[0].trim() !== "---") return fm;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end === -1) return fm;
  let i = 1;
  while (i < end) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#") || !line.includes(":")) { i++; continue; }
    const sep = line.indexOf(":");
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim().replace(/^["']|["']$/g, "");
    if (/^[>|][+-]?$/.test(value)) {
      const parts = [];
      i++;
      while (i < end && (!lines[i].trim() || /^\s/.test(lines[i]))) {
        parts.push(lines[i].trim());
        i++;
      }
      fm[key] = parts.filter(Boolean).join(" ");
      continue;
    }
    if (!value && i + 1 < end && lines[i + 1].trim().startsWith("- ")) {
      const items = [];
      i++;
      while (i < end && lines[i].trim().startsWith("- ")) {
        const item = lines[i].trim().slice(2).trim().replace(/^["']|["']$/g, "");
        if (item) items.push(item);
        i++;
      }
      fm[key] = items;
      continue;
    }
    fm[key] = value;
    i++;
  }
  return fm;
}

function countGlobMatches(globs, root) {
  // razor: fs.globSync needs Node 22+; on older Node the count is unknown
  // and dead-glob detection is skipped rather than reimplementing a matcher.
  if (typeof fs.globSync !== "function") return null;
  let count = 0;
  for (const pattern of globs) {
    try {
      count += fs.globSync(pattern, { cwd: root }).length;
    } catch {
      // malformed pattern counts as zero matches
    }
  }
  return count;
}

function findInstructionFiles(root) {
  const files = [];
  const rootClaude = path.join(root, "CLAUDE.md");
  const altClaude = path.join(root, ".claude", "CLAUDE.md");
  if (fs.existsSync(rootClaude)) {
    files.push({ path: "CLAUDE.md", absPath: rootClaude, alwaysLoaded: true });
  } else if (fs.existsSync(altClaude)) {
    files.push({ path: ".claude/CLAUDE.md", absPath: altClaude, alwaysLoaded: true });
  }
  const rulesDir = path.join(root, ".claude", "rules");
  if (fs.existsSync(rulesDir) && fs.statSync(rulesDir).isDirectory()) {
    for (const name of fs.readdirSync(rulesDir).sort()) {
      if (!name.endsWith(".md")) continue;
      files.push({ path: ".claude/rules/" + name, absPath: path.join(rulesDir, name), alwaysLoaded: false });
    }
  }
  for (const f of files) {
    const content = fs.readFileSync(f.absPath, "utf-8");
    const fm = parseFrontmatter(content);
    let globs = fm.paths || [];
    if (typeof globs === "string") globs = globs ? [globs] : [];
    f.content = content;
    f.globs = globs;
    f.globMatchCount = globs.length ? countGlobMatches(globs, root) : null;
    f.defaultCategory = fm["default-category"] || "mandate";
    f.lineCount = content.split("\n").length;
    // an unscoped .claude/rules file loads every session, same as CLAUDE.md
    if (!f.alwaysLoaded && globs.length === 0) f.alwaysLoaded = true;
  }
  return files;
}

// ---------------------------------------------------------------------------
// Skill descriptions — graded against the craft trigger recipe
// ---------------------------------------------------------------------------

const SKILL_TRIGGER_CLAUSE = /\b(?:use|trigger|invoke)\s+(?:this\s+skill\s+)?when\b/i;
const SKILL_QUOTED_PHRASE = /"[^"]+"|“[^”]+”/g;
const SKILL_EXCLUSION_CLAUSE = /\b(?:do\s+not|don'?t|never)\s+(?:use|trigger|invoke)\b/i;
// Global variants for counting clauses (String.match needs /g to count them).
// "load" joins the trigger set here because "Load when …" is a real trigger
// opener — the append fix bolts a "Use when" beside one, which is the pair we
// want to catch even though the missing-trigger check keys on the recipe form.
const SKILL_TRIGGER_CLAUSE_G = /\b(?:use|trigger|invoke|load)\s+(?:this\s+skill\s+)?when\b/gi;
const SKILL_EXCLUSION_CLAUSE_G = /\b(?:do\s+not|don'?t|never)\s+(?:use|trigger|invoke|load)\b/gi;
const SKILL_FILE_TYPE_NOUN = /(?:^|[\s(`"'])\.[a-z][a-z0-9]{0,5}\b|\b(?:markdown|csv|json|ya?ml|html?|pdf|svg|xlsx|docx|pptx)\b/i;

// description + when_to_use share one skill-listing entry, truncated past this
// many characters — and the exclusion clause sits last, so it is the first thing
// lost. A fix that appends recipe parts can push a description over the cap; the
// rewrite folds the parts in instead and comes out no longer than it started.
const DESCRIPTION_CAP = 1536;

const SKILL_CHECK_LABELS = {
  trigger: 'no "Use when" trigger clause',
  concrete: "no concrete artifact or file type named",
  exclusion: 'no "Do NOT use" exclusion clause',
  redundant: "a clause is duplicated — merge the pair, keep every distinct phrasing",
  overCap: "over the 1,536-char listing cap — the tail is truncated",
  overSpecified: "model-disabled — drop when_to_use and trigger phrasings, keep a short user-facing summary",
  whenToUse: "model-invocable — drop when_to_use, fold any trigger phrases into description",
  empty: "no description",
  dead: "no model or user invocation — recommend removing the skill",
};

function checkSkillDescription(description) {
  const text = (description || "").trim();
  const quotes = text.match(SKILL_QUOTED_PHRASE) || [];
  // the base sentence must name the artifact itself — quoted trigger phrases
  // don't count toward concreteness
  const base = text.replace(SKILL_QUOTED_PHRASE, " ");
  const missing = [];
  // The trigger clause is the requirement; the quote COUNT is not. A proof A/B
  // (docs/research/proof/skill-trim/) measured 0, 1, 2 and 4 quoted phrasings on
  // two fixtures: more quotes never improved firing, and quotes that did not
  // cover the real ask collapsed it. A floor of 2 pushed authors to invent
  // off-target quotes, so there is no floor — quotedPhrases is still reported.
  if (!SKILL_TRIGGER_CLAUSE.test(text)) missing.push("trigger");
  if (!CONCRETE_REGEX.some((p) => (base.match(p) || []).length > 0) && !SKILL_FILE_TYPE_NOUN.test(base)) {
    missing.push("concrete");
  }
  if (!SKILL_EXCLUSION_CLAUSE.test(text)) missing.push("exclusion");
  // Redundancy = the append fix's leftovers, safe to merge: the same quoted
  // phrase twice, two exclusion clauses, or a second "Use when the user asks
  // to …" recipe clause bolted beside a trigger that already exists. A plain
  // "Load when A … also load when B" enumeration under one verb is legitimate
  // and must NOT flag — the "asks to" guard keeps the trigger-count signal off
  // it. Strip exclusion openers before counting triggers: the recipe's own
  // "Do NOT use when …" contains "use when" and must not read as a trigger.
  const exclusionCount = (text.match(SKILL_EXCLUSION_CLAUSE_G) || []).length;
  const triggerCount = (text.replace(SKILL_EXCLUSION_CLAUSE_G, " ").match(SKILL_TRIGGER_CLAUSE_G) || []).length;
  const quoteVals = quotes.map((q) => q.replace(/[“”"]/g, "").trim().toLowerCase()).filter(Boolean);
  const dupQuote = quoteVals.some((q, i) => quoteVals.indexOf(q) !== i);
  const recipeTriggerAtop = triggerCount >= 2 && /\b(?:the\s+user\s+)?asks?\s+to\b|\buser\s+asks\b/i.test(text);
  const redundant = dupQuote || exclusionCount >= 2 || recipeTriggerAtop;
  return { quotedPhrases: quotes.length, missing, redundant, length: text.length, overCap: text.length > DESCRIPTION_CAP };
}

// A skill's invocation flags decide what "good" means. The trigger recipe only
// governs auto-routing (disable-model-invocation unset). A user-only slash
// command wants a short plain summary, not trigger machinery; a skill neither
// side can invoke is dead. Defaults are on/on, so an unflagged skill is graded
// on the recipe exactly as before. A model-invocable skill is graded on the
// combined text but flagged if when_to_use still exists as its own field: a
// proof A/B (docs/research/proof/skill-trim/) found no firing penalty from
// dropping it and a measurable recall lift on sonnet over keeping it.
function gradeSkill(router, whenToUse, modelInvocable, userInvocable) {
  if (modelInvocable) {
    return { mode: "model", ...checkSkillDescription(router), hasWhenToUse: Boolean(whenToUse.trim()) };
  }
  const length = router.trim().length;
  if (!userInvocable) {
    return { mode: "dead", missing: [], redundant: false, overCap: length > DESCRIPTION_CAP, length };
  }
  // user-only: the recipe is irrelevant. Flag only over-specification — trigger
  // machinery it does not need — or an empty/oversized summary.
  const quotes = (router.match(SKILL_QUOTED_PHRASE) || []).length;
  const overSpecified = Boolean(whenToUse.trim()) || (SKILL_TRIGGER_CLAUSE.test(router) && quotes >= 2);
  return { mode: "user-only", missing: [], redundant: false, overCap: length > DESCRIPTION_CAP, length, overSpecified, empty: length === 0 };
}

function findSkillFiles(root) {
  const skillsDir = path.join(root, ".claude", "skills");
  const skills = [];
  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) return skills;
  for (const name of fs.readdirSync(skillsDir).sort()) {
    const skillMd = path.join(skillsDir, name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    const fm = parseFrontmatter(fs.readFileSync(skillMd, "utf-8"));
    const descText = typeof fm.description === "string" ? fm.description : "";
    const whenToUse = typeof fm.when_to_use === "string" ? fm.when_to_use : "";
    // when_to_use carries trigger text in some skills; the router reads both
    const description = [descText, whenToUse].filter(Boolean).join(" ");
    // flags default to on: an unflagged skill is model- and user-invocable
    const modelInvocable = !(fm["disable-model-invocation"] === "true" || fm["disable-model-invocation"] === true);
    const userInvocable = !(fm["user-invocable"] === "false" || fm["user-invocable"] === false);
    skills.push({
      path: ".claude/skills/" + name + "/SKILL.md",
      name: typeof fm.name === "string" && fm.name ? fm.name : name,
      description,
      modelInvocable,
      userInvocable,
      checks: gradeSkill(description, whenToUse, modelInvocable, userInvocable),
    });
  }
  return skills;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const BARE_LINK = /^\s*[-*]?\s*\[.*?\]\(.*?\)\s*$/;
const PROSE_STARTERS = /^(?:this means|this is because|the reason|note that|background:|overview:|for context|these rules|this rule|this file|these files|this section|the following|detailed conventions|scoped rules)/i;
const MECHANISM = /^(?:the\s+\w+\s+(?:pipeline|agent|system|layer|service)\s+(?:runs|handles|manages|processes))/i;
const REFERENCE = /^see\s+[`"[].*?\b(?:for|about)\b/i;
const DESCRIPTION_BULLET = /^\*\*[^*]+\*\*\s*(?:—|--|:)\s/;
const NAVIGATION_POINTER = /^`[^`]+\.md`\s*(?:—|--|:|→)\s|^\*\*[^*]+\*\*\s*(?:→|—|--)\s*\[?`?[\w./-]*\.md|^\[[^\]]+\]\([^)]*\.md\)\s*(?:—|--|:|→)\s/;
// Definition/reference bullets, not directives: a command or term followed by a
// dash-led gloss (`` `./gradlew build` — full compile ``) or a colon-labelled
// entry (`**Grammar Kit:** write .bnf rules`). Command listings and glossaries
// live under Commands/Reference/Competencies headings and are documentation, not
// rules — matching one turns a bare "run the build" into a fake weak rule.
const REFERENCE_BULLET = /^(?:`[^`]+`\s*(?:—|–|--)|\*\*[^*]+:\*\*(?:\s|$))/;
const CLARIFICATION_STARTERS = /^(?:this means|for example|i\.e\.|e\.g\.|in other words|specifically|that is)/i;
const CONSTRAINT_KEYWORDS = [/\bonly\b/, /\brequired\b/, /\bforbidden\b/, /\bmandatory\b/];

function hasImperativeVerb(text) {
  const lower = text.toLowerCase();
  for (const t of VERB_TIERS) {
    if (t.pattern.test(lower)) return true;
  }
  return false;
}

function hasConstraintKeyword(text) {
  const lower = text.toLowerCase();
  return CONSTRAINT_KEYWORDS.some((p) => p.test(lower));
}

function stripMetadata(content) {
  const lines = content.split("\n");
  const result = [];
  const annotations = {}; // lineNum -> category
  const ignored = new Set(); // lineNums following an assay-ignore comment

  let frontmatterEnd = 0;
  if (lines.length && lines[0].trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") { frontmatterEnd = i + 1; break; }
    }
  }

  const fenceRegions = new Set();
  let inFence = false;
  for (let i = frontmatterEnd; i < lines.length; i++) {
    if (lines[i].trim().startsWith("```")) {
      inFence = !inFence;
      fenceRegions.add(i);
    } else if (inFence) {
      fenceRegions.add(i);
    }
  }

  // <example>…</example>-style tag blocks hold worked-example content, not
  // rules — treat them like code fences. Only a tag alone on its line opens a
  // region, and an unclosed tag strips nothing.
  const tagRegions = new Set();
  let openTag = null, tagStart = 0;
  for (let i = frontmatterEnd; i < lines.length; i++) {
    if (fenceRegions.has(i)) continue;
    const t = lines[i].trim();
    if (!openTag) {
      const m = t.match(/^<([a-z][\w-]*)>$/i);
      if (m) { openTag = m[1]; tagStart = i; }
    } else if (t === "</" + openTag + ">") {
      for (let j = tagStart; j <= i; j++) tagRegions.add(j);
      openTag = null;
    }
  }

  const tableRegions = new Set();
  for (let i = frontmatterEnd; i < lines.length; i++) {
    if (tableRegions.has(i) || fenceRegions.has(i) || tagRegions.has(i)) continue;
    if (lines[i].trim().startsWith("|") && i + 1 < lines.length && /^\|[\s:]*-/.test(lines[i + 1].trim())) {
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith("|")) {
        tableRegions.add(j);
        j++;
      }
    }
  }

  for (let i = frontmatterEnd; i < lines.length; i++) {
    const lineNum = i + 1;
    if (fenceRegions.has(i) || tableRegions.has(i) || tagRegions.has(i)) continue;
    const raw = lines[i];
    const stripped = raw.trim();

    const catMatch = stripped.match(/^<!--\s*category:\s*(\w+)\s*-->$/);
    if (catMatch) { annotations[lineNum] = catMatch[1]; continue; }
    if (/^<!--\s*assay-ignore\s*-->$/.test(stripped)) { ignored.add(lineNum); continue; }

    if (/^#{1,6}\s/.test(stripped)) {
      result.push({ lineNum, text: "", isContent: false, isBlank: false, isHeading: true, raw: stripped });
      continue;
    }
    if (/^(?:---+|___+|\*\*\*+)\s*$/.test(stripped)) continue;
    if (!stripped) {
      result.push({ lineNum, text: "", isContent: false, isBlank: true, isHeading: false, raw: "" });
      continue;
    }
    if (BARE_LINK.test(stripped)) continue;
    result.push({ lineNum, text: stripped, isContent: true, isBlank: false, isHeading: false, raw });
  }

  return { lines: result, annotations, ignored };
}

function identifyChunks(lines) {
  const chunks = [];
  let current = null;
  let heading = null;
  let headingLine = null;

  for (const line of lines) {
    if (!line.isContent) {
      if (line.isHeading) {
        const text = line.raw.replace(/^#{1,6}\s+/, "").trim();
        if (text) { heading = text; headingLine = line.lineNum; }
      }
      if (line.isBlank && current) { chunks.push(current); current = null; }
      continue;
    }
    const isBullet = /^(?:[-*]|\d+\.)\s/.test(line.text);
    const isContinuation = /^(?:\s{2,}|\t)/.test(line.raw) && !isBullet;
    if (isBullet) {
      if (current) chunks.push(current);
      current = {
        lineStart: line.lineNum, lineEnd: line.lineNum,
        text: line.text.replace(/^(?:[-*]|\d+\.)\s+/, ""),
        isBullet: true, heading, headingLine,
      };
    } else if (isContinuation && current) {
      current.lineEnd = line.lineNum;
      current.text += " " + line.text;
    } else if (!current) {
      current = { lineStart: line.lineNum, lineEnd: line.lineNum, text: line.text, isBullet: false, heading, headingLine };
    } else {
      current.lineEnd = line.lineNum;
      current.text += " " + line.text;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function classifyChunk(chunk) {
  const text = chunk.text;
  const plain = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  if (PROSE_STARTERS.test(text) || MECHANISM.test(text) || REFERENCE.test(text)) return "prose";
  if (chunk.isBullet && (NAVIGATION_POINTER.test(text) || REFERENCE_BULLET.test(text))) return "prose";
  if (hasImperativeVerb(plain) || hasConstraintKeyword(text)) return "rule";
  if (chunk.isBullet) {
    if (DESCRIPTION_BULLET.test(text)) return "prose";
    return "rule";
  }
  return "prose";
}

function isVerblessBullet(chunk) {
  return chunk.isBullet && !hasImperativeVerb(chunk.text) && !hasConstraintKeyword(chunk.text);
}

function mergeTwo(rule, extra) {
  return {
    lineStart: rule.lineStart, lineEnd: extra.lineEnd,
    text: rule.text + " " + extra.text,
    isBullet: rule.isBullet, heading: rule.heading,
  };
}

function mergeClarifications(chunks) {
  const classified = chunks.map((c) => [c, classifyChunk(c)]);
  const merged = [];
  let i = 0;
  while (i < classified.length) {
    let [chunk, cls] = classified[i];
    if (cls !== "rule") { merged.push([chunk, cls]); i++; continue; }

    // Verbless bullets under a heading merge into a synthetic "Heading: ..."
    // parent so conditional blocks keep their directive context.
    if (isVerblessBullet(chunk) && chunk.heading) {
      const heading = chunk.heading;
      let combined = mergeTwo(
        { lineStart: chunk.headingLine ?? chunk.lineStart, lineEnd: chunk.lineStart, text: heading + ":", isBullet: false, heading },
        chunk
      );
      let j = i + 1;
      while (j < classified.length) {
        const [next, nextCls] = classified[j];
        if (nextCls === "rule" && isVerblessBullet(next) && next.heading === heading) {
          combined = mergeTwo(combined, next);
          j++;
        } else break;
      }
      merged.push([combined, "rule"]);
      i = j;
      continue;
    }

    let j = i + 1;
    while (j < classified.length) {
      const [next, nextCls] = classified[j];
      const isClarification = nextCls === "prose" && (CLARIFICATION_STARTERS.test(next.text) || next.text.startsWith("```"));
      const isDependentBullet = nextCls === "rule" && next.isBullet && !chunk.isBullet && isVerblessBullet(next);
      if (isClarification || isDependentBullet) {
        chunk = mergeTwo(chunk, next);
        j++;
      } else break;
    }
    merged.push([chunk, "rule"]);
    i = j;
  }
  return merged;
}

// [Foreman: 056]
// A clause is its own directive only when an imperative verb leads it.
// `hasImperativeVerb` matches a verb anywhere in the text, and the bare
// imperative tier holds ordinary words (save, keep, cut, drop, report), so a
// trailing subordinate clause qualified and got graded as a rule of its own.
function leadsWithImperativeVerb(text) {
  const lower = text.toLowerCase().replace(/^[^a-z]+/, "");
  for (const t of VERB_TIERS) {
    if (!lower.startsWith(t.verb)) continue;
    const rest = lower.slice(t.verb.length);
    if (rest === "" || /^[\s,;.)!?]/.test(rest)) return true;
  }
  return false;
}

function splitCompound(chunk) {
  const text = chunk.text;
  const sub = (t) => ({ lineStart: chunk.lineStart, lineEnd: chunk.lineEnd, text: t, isBullet: chunk.isBullet, heading: chunk.heading });

  // razor: only semicolon-joined directives split. A conjunction joins clauses
  // of one sentence, and the continuation after it is mid-sentence prose, not a
  // second rule — restore an `and` split only behind a check that the
  // continuation stands alone on its own.
  if (text.includes(";")) {
    const parts = text.split(";").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2 && parts.every(leadsWithImperativeVerb)) return parts.map(sub);
  }
  return [chunk];
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

// Directories never worth walking when hunting for a file that moved.
const WALK_IGNORE = new Set([
  ".git", ".svn", ".hg", "node_modules", ".assay-tmp", "dist", "build",
  "coverage", ".next", ".nuxt", ".cache", ".venv", "__pycache__", "vendor", "target",
]);

// One full walk of the project indexed by basename, built lazily on the first
// missing reference so a corpus with no stale paths never pays for it.
function buildBasenameIndex(root) {
  const index = new Map();
  const stack = ["."];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!WALK_IGNORE.has(e.name)) stack.push(path.join(rel, e.name));
      } else if (e.isFile()) {
        const p = path.join(rel, e.name).split(path.sep).join("/").replace(/^\.\//, "");
        const list = index.get(e.name);
        if (list) list.push(p);
        else index.set(e.name, [p]);
      }
    }
  }
  return index;
}

function makeBasenameResolver(root) {
  let index = null;
  return (basename) => {
    if (index === null) index = buildBasenameIndex(root);
    return index.get(basename) || [];
  };
}

// A backtick token is checkable only as a project-relative concrete path.
// Whitespace means a command with arguments (`./gradlew generateLexer`), not a path.
function backtickToPath(name) {
  if (!name.includes("/")) return null;
  if (/[<>{}*$\s]|:\/\//.test(name)) return null;
  if (name.startsWith("/") || name.startsWith("~") || /^[A-Za-z]:/.test(name)) return null;
  return name;
}

// A markdown link target, normalized to a project-relative path or null. A
// leading "/" is repo-root-relative, the way docs conventionally link.
function linkTargetToPath(target) {
  let t = target.trim().replace(/^<(.*)>$/, "$1").split(/\s+/)[0];
  t = t.split("#")[0].split("?")[0];
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null; // scheme: http, mailto, C:, data…
  if (/[<>{}*$]/.test(t) || t.startsWith("~")) return null;
  if (t.startsWith("/")) t = t.slice(1);
  if (!t) return null;
  if (!t.includes("/") && !/\.[a-zA-Z0-9]+$/.test(t)) return null; // bare word, not a path
  return t;
}

function checkStaleness(text, root, findMoved) {
  const resolve = findMoved || makeBasenameResolver(root);
  const refs = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const p = backtickToPath(m[1]);
    if (p) refs.push(p);
  }
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const p = linkTargetToPath(m[1]);
    if (p) refs.push(p);
  }
  const missing = [];
  const seen = new Set();
  for (const ref of refs) {
    const clean = ref.replace(/\/+$/, "");
    if (seen.has(clean)) continue;
    seen.add(clean);
    if (fs.existsSync(path.join(root, clean))) continue;
    const moved = resolve(path.basename(clean)).filter((c) => c !== clean);
    missing.push({ ref: clean, moved });
  }
  // A ref whose file merely moved still points at something real — report it
  // as fixable, but only a truly dead ref crushes the score.
  return { gated: missing.some((m) => m.moved.length === 0), missing };
}

// ---------------------------------------------------------------------------
// Mechanical scoring — F1, F2, F4, F7
// ---------------------------------------------------------------------------

const NOUN_VERB_AMBIGUOUS = new Set([
  "document", "format", "log", "name", "set", "watch", "report", "display", "record", "test",
  "check", "cache", "scope", "limit", "batch", "profile", "audit", "benchmark", "aggregate",
  "archive", "guard", "pin", "drain",
]);
const NOUN_FOLLOWERS = new Set([
  "headers", "files", "strings", "entries", "requests", "messages", "logs", "values", "types",
  "fields", "options", "conventions", "names", "rules", "paths", "settings", "keys", "items",
  "objects", "results", "records", "operations", "endpoints", "variables", "pages", "data",
  "clauses", "layers", "levels", "lines", "traits", "pipes", "pools", "connections", "events",
  "configs",
]);

function looksLikeStatement(lower) {
  const starts = [
    /^(?:all|each|every|the|a|an|this|that|these|those)\s/,
    /^(?:files?|code|modules?|components?|functions?|classes|methods)\s/,
    /^tests?\s+(?!the\s|a\s|an\s)/,
  ];
  if (starts.some((p) => p.test(lower))) return true;
  const words = lower.split(/\s+/);
  return words.length >= 2 && NOUN_VERB_AMBIGUOUS.has(words[0]) && NOUN_FOLLOWERS.has(words[1]);
}

function scoreF1(text) {
  const lower = text.toLowerCase();
  const matches = [];
  for (const t of VERB_TIERS) {
    const m = t.pattern.exec(lower);
    if (m) matches.push({ verb: t.verb, score: t.score, label: t.label, pos: m.index });
  }
  if (!matches.length) {
    if (looksLikeStatement(lower)) return { value: IMPLICIT_VERB_DEFAULT, method: "implicit_imperative_default", matchedVerb: null };
    return { value: null, method: "extraction_failed", matchedVerb: null };
  }
  const bestScore = Math.max(...matches.map((m) => m.score));
  if (looksLikeStatement(lower) && bestScore <= 0.85) {
    return { value: IMPLICIT_VERB_DEFAULT, method: "implicit_imperative_default", matchedVerb: null };
  }
  const hedgingLabels = new Set(["hedged", "suggestion", "weak_suggestion", "preference"]);
  const hedges = matches.filter((m) => hedgingLabels.has(m.label));
  let best;
  if (hedges.length >= 2) {
    best = hedges.reduce((a, b) => (a.score <= b.score ? a : b));
  } else {
    best = matches.reduce((a, b) => (a.score >= b.score ? a : b));
  }
  if (matches.some((m) => m.verb === "always")) {
    const imperative = matches.find((m) => m.verb !== "always" && m.label === "bare_imperative");
    if (imperative) return { value: 1.0, method: "lookup", matchedVerb: "always + " + imperative.verb };
  }
  return { value: best.score, method: "lookup", matchedVerb: best.verb };
}

function hasPositiveImperative(text) {
  const lower = text.toLowerCase().trim();
  if (PROHIBITION_MARKERS.some((p) => lower.startsWith(p.trim()))) return false;
  for (const t of VERB_TIERS) {
    if ((t.label === "bare_imperative" || t.label === "unconditional_mandate") && t.pattern.test(lower)) return true;
  }
  return false;
}

function hasContrastNot(text) {
  if (/`[^`]+`\s*[,;:]?\s+not\s+`[^`]+`/.test(text)) return true;
  const negations = [
    /\b(?:is|are|was|were|be|been|being)\s+not\b/i,
    /,\s+not\s+\w+(?:ing|ed|ly)\b/i,
    /,\s+not\s+\w+\s+(?:on|to|in|with|from|by|at|of|as|for|after|before)\b/i,
  ];
  if (negations.some((p) => p.test(text))) return false;
  return /,\s+not\s+\w+/i.test(text);
}

function scoreF2(text) {
  const lower = text.toLowerCase();
  // "must not" is deontic — it never appears in a factual negation — so it
  // counts as a prohibition anywhere, even after a subject ("tests must not X").
  const isProhibition = PROHIBITION_CLAUSE_RE.test(lower) || lower.includes("must not ");
  const isHedged = HEDGED_MARKERS.some((p) => lower.includes(p));
  const hasAlternative = ALTERNATIVE_MARKERS.some((p) => lower.includes(p)) || hasContrastNot(text);

  if (isProhibition) {
    // Prohibition + named alternative is the strongest framing; a prohibition
    // without one converts blocked tasks into stalls, not compliance.
    const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])|[;—–]\s*/);
    if (hasAlternative || (sentences.length >= 2 && sentences.some(hasPositiveImperative))) {
      return { value: 0.95, category: "prohibition_with_alternative" };
    }
    return { value: 0.2, category: "bare_prohibition", stallRisk: true };
  }
  if (isHedged) return { value: 0.35, category: "hedged_preference" };
  if (hasAlternative) return { value: 0.95, category: "positive_with_alternative" };
  return { value: 0.85, category: "positive_imperative" };
}

const TRIGGER_SCOPE_PATTERNS = [
  /\bwhen\s+(?:editing|working\s+(?:on|with)|modifying|creating)\s+(\w+)\s+files?\b/gi,
  /\bfor\s+(\w+)\s+files?\b/gi,
  /\bin\s+(?:the\s+)?(\w+)\s+(?:directory|folder|module)\b/gi,
  /\bduring\s+(\w+)\b/gi,
];

function extractTriggerScope(lower) {
  const triggers = new Set();
  for (const p of TRIGGER_SCOPE_PATTERNS) {
    for (const m of lower.matchAll(p)) triggers.add(m[1].toLowerCase());
  }
  return triggers;
}

function extractGlobKeywords(globs) {
  const keywords = new Set();
  for (const g of globs) {
    for (const part of g.split(/[/\\*?.[\]{}]+/)) {
      const p = part.toLowerCase().trim();
      if (p && p.length > 1 && !["src", "lib", "test", "tests"].includes(p)) keywords.add(p);
    }
  }
  return keywords;
}

const RULE_KEYWORD_STOPWORDS = new Set([
  "the", "and", "for", "all", "new", "with", "not", "use", "when", "this", "that", "from",
  "into", "over", "than", "must", "should", "always", "never", "before", "after", "each",
  "every", "where", "only", "also", "just", "about", "more", "most", "some", "any",
]);

function scoreF4(rule, file) {
  const lower = rule.text.toLowerCase();
  if (rule.staleness && rule.staleness.gated) return { value: 0.05, method: "stale" };
  const globs = file.globs || [];
  if (globs.length && file.globMatchCount === 0) return { value: 0.05, method: "dead_glob" };

  if (file.alwaysLoaded && !globs.length) {
    if (extractTriggerScope(lower).size) return { value: 0.4, method: "misaligned" };
    return { value: 0.95, method: "always_universal" };
  }
  if (globs.length) {
    const triggers = extractTriggerScope(lower);
    const globKeywords = extractGlobKeywords(globs);
    if (triggers.size) {
      const overlap = [...triggers].some((t) => globKeywords.has(t));
      return overlap ? { value: 0.95, method: "glob_match" } : { value: 0.25, method: "wrong_scope" };
    }
    const words = (lower.match(/\b[a-z]{3,}\b/g) || []).filter((w) => !RULE_KEYWORD_STOPWORDS.has(w));
    if (words.some((w) => globKeywords.has(w))) return { value: 0.9, method: "keyword_overlap" };
    // No trigger text and no overlap: the paths: frontmatter is doing the
    // alignment work — a correctly lean rule, not a misaligned one.
    return { value: F4_NO_OVERLAP_SCORE, method: "implicit_scope_trust" };
  }
  return { value: F4_AMBIGUOUS_SCORE, method: "no_signal" };
}

function scoreF5(lineStart, file) {
  if (file.lineCount <= LONG_FILE_LINES) return { value: 0.95, method: "short_file" };
  const frac = lineStart / file.lineCount;
  if (frac <= 0.25) return { value: 0.95, method: "top" };
  if (frac <= 0.5) return { value: 0.8, method: "upper_middle" };
  if (frac <= 0.75) return { value: 0.6, method: "lower_middle" };
  return { value: 0.4, method: "bottom" };
}

function scoreF7(text) {
  const markers = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) markers.push(m[1]);
  const stripped = text.replace(/`[^`]+`/g, "");
  for (const pattern of CONCRETE_REGEX.slice(1)) {
    for (const m of stripped.matchAll(pattern)) {
      if (!markers.includes(m[0])) markers.push(m[0]);
    }
  }
  for (const pattern of NUMERIC_THRESHOLD_REGEX) {
    for (const m of stripped.matchAll(pattern)) {
      const phrase = m[0].trim();
      if (!markers.some((x) => x.includes(phrase) || phrase.includes(x))) markers.push(phrase);
    }
  }
  const lower = text.toLowerCase();
  const markersLower = markers.map((m) => m.toLowerCase());
  for (const term of CONCRETE_TERMS) {
    const termLower = term.toLowerCase();
    if (lower.includes(termLower) && !markersLower.some((m) => m.includes(termLower) || termLower.includes(m))) {
      markers.push(term);
      markersLower.push(termLower);
    }
  }
  const abstract = ABSTRACT_MARKERS.filter((a) => lower.includes(a));

  const c = markers.length, a = abstract.length;
  let value;
  if (c === 0 && a === 0) value = 0.05;
  else if (c === 0) value = 0.1;
  else if (a === 0) value = c >= 4 ? 0.95 : c >= 2 ? 0.85 : 0.8;
  else {
    const ratio = c / (c + a);
    if (ratio >= 0.8) value = 0.75 + 0.1 * Math.min(c / 4, 1);
    else if (ratio >= 0.5) value = 0.45 + 0.2 * ratio;
    else if (ratio >= 0.25) value = 0.25 + 0.15 * ratio;
    else value = 0.1 + 0.1 * ratio;
  }
  return { value: Math.round(value * 100) / 100, concrete: markers, abstract };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

function softFloor(x) {
  return Math.min(1, x / SOFT_FLOOR_THRESHOLD);
}

function composeScore(factors, stale) {
  // factors: { F1..F7 } as plain numbers in [0,1]; F1 null falls back to 0.5
  const values = { ...factors };
  if (values.F1 == null) values.F1 = 0.5;
  if (values.F5 == null) values.F5 = 0.95;
  let linear = 0;
  for (const [name, weight] of Object.entries(WEIGHTS)) linear += weight * values[name];
  linear /= WEIGHTS_TOTAL;
  const floor = Math.min(softFloor(values.F7), softFloor(values.F4), stale ? STALENESS_MULTIPLIER : 1);
  const score = linear * floor;

  let dominant = null, dominantGap = -1;
  for (const [name, weight] of Object.entries(WEIGHTS)) {
    const gap = weight * (1 - values[name]);
    if (gap > dominantGap) { dominantGap = gap; dominant = name; }
  }
  return { score: round3(score), preFloor: round3(linear), floor: round3(floor), dominantWeakness: dominant };
}

// ---------------------------------------------------------------------------
// Placement detection
// ---------------------------------------------------------------------------

function countActionVerbs(text) {
  const lower = text.toLowerCase();
  let count = 0;
  for (const t of VERB_TIERS) {
    if (t.label === "bare_imperative" || t.label === "unconditional_mandate") {
      const matches = lower.match(new RegExp(t.pattern.source, "g"));
      if (matches) count += matches.length;
    }
  }
  return count;
}

function detectPlacement(ruleText, f8) {
  const detections = {};
  for (const [primitive, signals] of Object.entries(PLACEMENT_SIGNALS)) {
    let confidence = 0;
    const evidence = [];
    for (const s of signals) {
      let hit = false;
      if (s.f8Below !== undefined) hit = f8 != null && f8 < s.f8Below;
      else if (s.anyPattern) hit = s.anyPattern.some((p) => p.test(ruleText));
      else if (s.pointerShape) hit = countActionVerbs(ruleText) <= 1 && (/\.md\b/.test(ruleText) || /`[^`]*\/[^`]*`/.test(ruleText));
      else hit = s.pattern.test(ruleText);
      if (hit) { confidence += s.weight; evidence.push(s.name); }
    }
    confidence = Math.min(1, round3(confidence));
    if (evidence.length) detections[primitive] = { confidence, evidence };
  }

  const candidates = Object.entries(detections).filter(([, d]) => d.confidence >= PLACEMENT_CANDIDATE_THRESHOLD);
  const firing = Object.entries(detections).filter(([, d]) => d.confidence >= PLACEMENT_COMPOUND_THRESHOLD);
  const compound = firing.length >= 2 && COMPOUND_CONJUNCTION.test(ruleText);

  if (!candidates.length && !compound) return null;
  let bestFit = compound ? "compound" : null;
  if (!bestFit) bestFit = candidates.reduce((a, b) => (a[1].confidence >= b[1].confidence ? a : b))[0];
  return { bestFit, detections, compound };
}

// ---------------------------------------------------------------------------
// Hook inventory — what's already mechanically enforced
// ---------------------------------------------------------------------------

// The last path-shaped token of a hook command line names the script; the
// interpreter and env-var prefixes around it are noise.
function hookCommandLabel(cmd) {
  const clean = String(cmd).replace(/["']/g, "");
  const pathy = clean.split(/\s+/).filter((t) => /[\\/]/.test(t));
  const token = pathy.length ? pathy[pathy.length - 1] : clean.split(/\s+/)[0];
  return token.split(/[\\/]/).pop();
}

function readHookConfig(file, source, entries) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return; // absent or malformed — no inventory from this file
  }
  for (const [event, groups] of Object.entries(cfg.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of g.hooks || []) {
        if (!h || !h.command) continue;
        entries.push({ event, matcher: g.matcher || "*", command: hookCommandLabel(h.command), source });
      }
    }
  }
}

// Hooks that already run for this project: project + user settings, plus every
// installed plugin's hooks.json. A rule the audit flags as a hook candidate may
// already be enforced by one of these — the report lists them so the candidate
// can be checked instead of rebuilt.
function collectHooks(root) {
  const entries = [];
  readHookConfig(path.join(root, ".claude", "settings.json"), "project", entries);
  readHookConfig(path.join(root, ".claude", "settings.local.json"), "project", entries);
  readHookConfig(path.join(os.homedir(), ".claude", "settings.json"), "user", entries);
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json"), "utf-8"));
    for (const [key, installs] of Object.entries(reg.plugins || {})) {
      const name = key.split("@")[0];
      for (const inst of Array.isArray(installs) ? installs : []) {
        if (!inst || !inst.installPath) continue;
        readHookConfig(path.join(inst.installPath, "hooks", "hooks.json"), "plugin: " + name, entries);
      }
    }
  } catch {
    // no plugin registry — nothing to add
  }
  const seen = new Set();
  return entries.filter((e) => {
    const k = e.event + "|" + e.matcher + "|" + e.command + "|" + e.source;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

// [Foreman: 059]
// judgments.json is keyed by this, not by the R### display id. The R### is a
// positional counter, so inserting one rule renumbers every rule after it and a
// re-scan would hand each one its neighbour's saved judgment — including the
// notRule verdict from 058, which would then suppress the wrong row. The content
// hash is stable across edits elsewhere in the file: an unchanged rule keeps its
// key and its judgment, and only a new or reworded rule presents an unknown key
// that needs a fresh judgment. File path is folded in so identical wording in two
// files stays two keys; identical wording twice in one file is the same rule said
// twice and sharing a judgment is correct.
function ruleKey(file, text) {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return crypto.createHash("sha1").update(file + "\0" + normalized).digest("hex").slice(0, 12);
}

function scan(root) {
  const files = findInstructionFiles(root);
  const rules = [];
  let counter = 0;
  const findMoved = makeBasenameResolver(root);

  files.forEach((file, fileIndex) => {
    const { lines, annotations, ignored } = stripMetadata(file.content);
    const chunks = identifyChunks(lines);
    const merged = mergeClarifications(chunks);

    for (const [chunk, cls] of merged) {
      if (cls !== "rule") continue;
      for (const part of splitCompound(chunk)) {
        // an <!-- assay-ignore --> comment on either of the two lines above skips the rule
        if (ignored.has(part.lineStart - 1) || ignored.has(part.lineStart - 2)) continue;
        counter++;
        let category = file.defaultCategory;
        for (let ln = part.lineStart - 2; ln < part.lineStart; ln++) {
          if (annotations[ln]) category = annotations[ln];
        }
        const staleness = checkStaleness(part.text, root, findMoved);
        const f1 = scoreF1(part.text);
        const rule = {
          id: "R" + String(counter).padStart(3, "0"),
          key: ruleKey(file.path, part.text),
          fileIndex,
          file: file.path,
          text: part.text,
          lineStart: part.lineStart,
          lineEnd: part.lineEnd,
          category,
          staleness,
          nonLatin: NON_LATIN_SCRIPT.test(part.text),
          factors: {
            F1: f1,
            F2: scoreF2(part.text),
            F4: scoreF4({ text: part.text, staleness }, file),
            F5: scoreF5(part.lineStart, file),
            F7: scoreF7(part.text),
          },
        };
        rules.push(rule);
      }
    }
  });

  return {
    root: path.resolve(root),
    files: files.map(({ content, absPath, ...rest }) => rest),
    rules,
    skills: findSkillFiles(root),
    hookInventory: collectHooks(root),
  };
}

function cmdScan(root) {
  const result = scan(root);
  const tmpDir = path.join(root, TMP_DIR);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "scan.json"), JSON.stringify(result, null, 2));

  const summary = {
    ruleCount: result.rules.length,
    skillCount: result.skills.length,
    fileCount: result.files.length,
    files: result.files.map((f) => f.path),
    scanFile: TMP_DIR + "/scan.json",
    judgmentsFile: TMP_DIR + "/judgments.json",
    hookInventory: result.hookInventory,
    judge: result.rules.map((r) => ({
      id: r.id,
      key: r.key,
      text: r.text,
      needsF1: r.factors.F1.method === "extraction_failed",
    })),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function loadJudgments(root, rules) {
  const file = path.join(root, TMP_DIR, "judgments.json");
  if (!fs.existsSync(file)) {
    return { error: "Missing " + TMP_DIR + "/judgments.json — write it before running report." };
  }
  let judgments;
  try {
    judgments = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    return { error: TMP_DIR + "/judgments.json is not valid JSON: " + err.message };
  }
  const problems = [];
  for (const rule of rules) {
    // [Foreman: 059] keyed by the stable content hash, not the R### display id
    const label = rule.id + "=" + rule.key;
    const j = judgments[rule.key];
    if (!j || typeof j.F3 !== "number" || typeof j.F8 !== "number") {
      problems.push(label);
      continue;
    }
    for (const k of ["F3", "F8", "F1"]) {
      if (j[k] !== undefined && (typeof j[k] !== "number" || j[k] < 0 || j[k] > 1)) problems.push(label + "." + k);
    }
    // [Foreman: 058]
    // The verification pass writes its verdict into this same file, so the
    // script keeps taking every model judgment from disk and stays a pure
    // function of its inputs. A reason is mandatory: an entry vanishes from the
    // report only when the model said, in words, why it was never a rule.
    if (j.notRule !== undefined && (typeof j.notRule !== "string" || !j.notRule.trim())) {
      problems.push(label + ".notRule");
    }
  }
  if (problems.length) {
    return { error: "Judgments missing, malformed, or out of range [0,1] for: " + problems.join(", ") };
  }
  return { judgments };
}

function composeAudit(scanData, judgments) {
  const rules = scanData.rules.map((r) => {
    // [Foreman: 059] keyed by the stable content hash; r.key falls back to r.id
    // so a hand-written scanData without keys still composes
    const j = judgments[r.key || r.id];
    const factors = {
      // F1 extraction can fail (value null); fall back to the same 0.5 the
      // composer uses, so the stored value is never null for the report to render
      F1: j.F1 !== undefined ? j.F1 : (r.factors.F1.value != null ? r.factors.F1.value : 0.5),
      F2: r.factors.F2.value,
      F3: j.F3,
      F4: r.factors.F4.value,
      F5: r.factors.F5 ? r.factors.F5.value : 0.95,
      F7: r.factors.F7.value,
    };
    const composed = composeScore(factors, r.staleness.gated);
    const stallRisk = r.factors.F2.stallRisk === true;
    const score = stallRisk ? Math.min(composed.score, STALL_RISK_CAP) : composed.score;
    const placement = detectPlacement(r.text, j.F8);
    const notRule = typeof j.notRule === "string" && j.notRule.trim() ? j.notRule.trim() : null;
    return {
      ...r,
      factorValues: factors,
      f8: j.F8,
      ...composed,
      score,
      grade: grade(score),
      stallRisk,
      hookOpportunity: j.F8 < F8_HOOK_THRESHOLD,
      placement,
      weak: score < (CATEGORY_FLOORS[r.category] ?? CATEGORY_FLOORS.mandate),
      suppressed: notRule !== null,
      suppressedReason: notRule,
    };
  });

  // [Foreman: 058]
  // A suppressed entry keeps its own score and factor values untouched — the
  // pass may never rescore — but it leaves the population the report averages
  // over. Counting a lessons file's 18 non-rules into the corpus grade is the
  // pollution this entry exists to remove, so hiding the rows while keeping the
  // headline number would fix nothing that matters.
  const counted = rules.filter((r) => !r.suppressed);

  const files = scanData.files.map((f, i) => {
    const own = counted.filter((r) => r.fileIndex === i);
    const mean = own.length ? own.reduce((s, r) => s + r.score, 0) / own.length : null;
    return { ...f, ruleCount: own.length, score: mean === null ? null : round3(mean), grade: mean === null ? null : grade(mean) };
  });

  const mandates = counted.filter((r) => r.category === "mandate");
  const corpus = mandates.length ? round3(mandates.reduce((s, r) => s + r.score, 0) / mandates.length) : null;

  return {
    root: scanData.root, files, rules, skills: scanData.skills || [],
    hookInventory: scanData.hookInventory || [],
    corpusScore: corpus, corpusGrade: corpus === null ? null : grade(corpus),
  };
}

function fmt(x) {
  return x.toFixed(2);
}

function pushWeakSkillSection(out, weakSkills) {
  out.push(`## Weak skill descriptions (${weakSkills.length} to fix)`);
  out.push("");
  out.push("A skill's frontmatter description is how Claude decides to invoke it, and its `description` plus `when_to_use` share one listing entry capped at 1,536 characters — past that the tail is silently truncated. Model-invocable skills are graded on the trigger recipe folded into `description` alone; a lingering `when_to_use` field is flagged to fold in and delete, not a place to stash overflow. A `disable-model-invocation` skill is graded as a plain user-facing summary instead, and a skill neither side can invoke is flagged for removal. assay can rewrite each one for you from the fix menu (dead skills are flagged, not rewritten).");
  out.push("");
  out.push("| Skill | Where | Chars | Issue |");
  out.push("|---|---|---|---|");
  for (const s of weakSkills) {
    const c = s.checks;
    let issues;
    if (c.mode === "dead") {
      issues = [SKILL_CHECK_LABELS.dead];
    } else if (c.mode === "user-only") {
      issues = [];
      if (c.empty) issues.push(SKILL_CHECK_LABELS.empty);
      if (c.overSpecified) issues.push(SKILL_CHECK_LABELS.overSpecified);
      if (c.overCap) issues.push(SKILL_CHECK_LABELS.overCap);
    } else {
      issues = c.missing.map((k) => SKILL_CHECK_LABELS[k]);
      if (c.redundant) issues.push(SKILL_CHECK_LABELS.redundant);
      if (c.overCap) issues.push(SKILL_CHECK_LABELS.overCap);
      if (c.hasWhenToUse) issues.push(SKILL_CHECK_LABELS.whenToUse);
    }
    out.push(`| ${s.name} | [${s.path}](${s.path}) | ${c.length}/${DESCRIPTION_CAP} | ${issues.join(", ")} |`);
  }
  out.push("");
}

// [Foreman: 057]
// The dominant weakness alone repeats down the whole table: F7 carries the
// heaviest weight, so any vague rule floors it and wins the argmax outright —
// on a prose-heavy corpus every row read "too vague" with one identical fix.
// Naming every factor that is materially weak, worst-first, gives each row the
// part that is actually its own.
// razor: two factors per row. The table is a diagnosis, not a rewrite plan, and
// a third fix makes the cell unreadable — raise MAX_ROW_FACTORS if the report
// ever moves somewhere wider than a terminal.
const WEAK_FACTOR_THRESHOLD = 0.6;
const MAX_ROW_FACTORS = 2;

function rowWeaknesses(rule) {
  const values = rule.factorValues || {};
  const gap = (name) => WEIGHTS[name] * (1 - values[name]);
  const weak = Object.keys(WEIGHTS)
    .filter((name) => values[name] != null && values[name] < WEAK_FACTOR_THRESHOLD)
    .sort((a, b) => gap(b) - gap(a));
  return weak.length ? weak.slice(0, MAX_ROW_FACTORS) : [rule.dominantWeakness];
}

// [Foreman: 058]
// Suppressed entries never disappear silently — --verbose brings every one back
// with the model's own words for why it was dropped, so the pass stays auditable
// while its false-suppression rate is still unmeasured.
function pushSuppressedSection(out, suppressed) {
  out.push(`## Suppressed (${suppressed.length} judged not to be rules)`);
  out.push("");
  out.push("These were extracted and scored, then dropped from every count above — the verification pass judged them prose rather than instructions. Their scores are unchanged; only their membership in the report is.");
  out.push("");
  for (const r of suppressed) {
    out.push(`- ${r.id} ([${r.file}:${r.lineStart}](${r.file}:${r.lineStart})) "${truncate(r.text, 70)}" — "${r.suppressedReason}"`);
  }
  out.push("");
}

// [Foreman: 061]
// One audit pass leaves the grade short of where iterating gets it — an observed
// corpus climbed C→A only across five scan-fix-scan rounds, and a single report
// never shows whether a fix landed. When `remeasure` hands renderReport the prior
// audit, this section leads with the movement: corpus grade then, corpus grade
// now, and each file's before/after. Files are matched by path, so a file that
// was split or renamed simply drops out of the comparison rather than pairing
// with the wrong one.
function gradeCell(score, gradeVal) {
  return score === null || score === undefined ? "—" : `${gradeVal} (${fmt(score)})`;
}

function pushProgressSection(out, audit, prev) {
  out.push("## Since last audit");
  out.push("");
  out.push(`Corpus grade ${gradeCell(prev.corpusScore, prev.corpusGrade)} → ${gradeCell(audit.corpusScore, audit.corpusGrade)}.`);
  out.push("");
  const prevByPath = new Map((prev.files || []).map((f) => [f.path, f]));
  const rows = audit.files.filter((f) => prevByPath.has(f.path));
  if (rows.length) {
    out.push("| File | Before | After |");
    out.push("|---|---|---|");
    for (const f of rows) {
      const p = prevByPath.get(f.path);
      out.push(`| ${f.path} | ${gradeCell(p.score, p.grade)} | ${gradeCell(f.score, f.grade)} |`);
    }
    out.push("");
  }
}

function renderReport(audit, opts = {}) {
  const out = [];
  const { files } = audit;
  const rules = audit.rules.filter((r) => !r.suppressed);
  const suppressed = audit.rules.filter((r) => r.suppressed);
  // file:line as a markdown link — Claude Code renders it clickable, opening
  // the rule at its exact line
  const loc = (r) => `[${r.file}:${r.lineStart}](${r.file}:${r.lineStart})`;
  // The rule cell itself is the click target: a bare line number is useless to
  // a reader, so the rule id + text opens the file at its line. Brackets in the
  // label would break the markdown link, so drop them.
  const ruleLink = (r, n) => `[${r.id} "${truncate(r.text, n).replace(/[[\]]/g, "")}"](${r.file}:${r.lineStart})`;
  const weakSkills = (audit.skills || []).filter((s) => {
    const c = s.checks;
    if (c.mode === "dead") return true;
    if (c.mode === "user-only") return c.overSpecified || c.overCap || c.empty;
    return c.missing.length || c.overCap || c.redundant || c.hasWhenToUse;
  });
  out.push("# Rule audit — " + path.basename(audit.root));
  out.push("");
  if (!rules.length) {
    out.push("No rules found in CLAUDE.md or .claude/rules/.");
    if (weakSkills.length) {
      out.push("");
      pushWeakSkillSection(out, weakSkills);
    }
    if (opts.verbose && suppressed.length) {
      out.push("");
      pushSuppressedSection(out, suppressed);
    }
    return out.join("\n");
  }
  const corpusBit = audit.corpusScore === null
    ? "no mandate rules left to grade"
    : `corpus grade **${audit.corpusGrade} (${fmt(audit.corpusScore)})**, mandate rules only`;
  out.push(`**${rules.length} rules across ${files.filter((f) => f.ruleCount > 0).length} file(s)** — ${corpusBit}.`);
  out.push("");
  out.push("Grades assume the rules must survive the least forgiving reader — small models, subagents, headless runs. If only large models in interactive sessions read this corpus, treat severity one notch softer.");
  out.push("");
  const nonLatin = rules.filter((r) => r.nonLatin);
  if (nonLatin.length) {
    out.push(`**${nonLatin.length} rule(s) contain non-Latin script.** assay grades English only, so treat their scores as unreliable rather than low.`);
    out.push("");
  }

  if (opts.prev) pushProgressSection(out, audit, opts.prev);

  out.push("## Files");
  out.push("");
  out.push("| File | Rules | Grade | Loading |");
  out.push("|---|---|---|---|");
  for (const f of files) {
    const loading = f.globs && f.globs.length ? "scoped: " + f.globs.join(", ") : "always loaded";
    const g = f.grade === null ? "—" : `${f.grade} (${fmt(f.score)})`;
    out.push(`| ${f.path} | ${f.ruleCount} | ${g} | ${loading} |`);
  }
  out.push("");

  const weak = rules.filter((r) => r.weak).sort((a, b) => a.score - b.score);
  if (weak.length) {
    out.push(`## Weak rules (${weak.length} below their category floor)`);
    out.push("");
    out.push("Click a rule to open it at its line.");
    out.push("");
    out.push("| Rule | Score | Main issue | Suggested fix |");
    out.push("|---|---|---|---|");
    for (const r of weak) {
      const names = rowWeaknesses(r);
      out.push(`| ${ruleLink(r, 60)} | ${r.grade} (${fmt(r.score)}) | ${names.map((n) => FACTOR_LABELS[n] || n).join(", ")} | ${names.map((n) => FRIENDLY_FIXES[n]).filter(Boolean).join("; ")} |`);
    }
    out.push("");
  }

  const stalls = rules.filter((r) => r.stallRisk);
  if (stalls.length) {
    out.push("## Stall risks (bare prohibitions)");
    out.push("");
    out.push('A prohibition with no named alternative can stall a run outright when the task needs the banned thing. Pair it with the replacement — "Never X — do Y instead" — or with the escape hatch ("stop and ask").');
    out.push("");
    for (const r of stalls) {
      out.push(`- ${r.id} (${loc(r)}) "${truncate(r.text, 80)}"`);
    }
    out.push("");
  }

  const buried = rules.filter((r) => r.factorValues.F5 <= BURIED_F5_THRESHOLD);
  if (buried.length) {
    out.push("## Buried rules");
    out.push("");
    out.push("These sit in the bottom half of a long file, where rules lose force. Move load-bearing rules into the top quarter, or split the file into scoped rule files.");
    out.push("");
    for (const r of buried) {
      const total = files[r.fileIndex] ? files[r.fileIndex].lineCount : "?";
      out.push(`- ${r.id} (${loc(r)}) "${truncate(r.text, 80)}" — line ${r.lineStart} of ${total}`);
    }
    out.push("");
  }

  const stale = rules.filter((r) => r.staleness.missing.length);
  if (stale.length) {
    out.push("## Stale references");
    out.push("");
    out.push("A rule pointing at a path that no longer resolves makes Claude re-discover it or give up. Fix the path or drop the reference.");
    out.push("");
    for (const r of stale) {
      for (const m of r.staleness.missing) {
        const moved = m.moved || [];
        let hint;
        if (moved.length === 1) hint = " → likely moved to `" + moved[0] + "`";
        else if (moved.length > 1) hint = " → same name lives at: " + moved.slice(0, 4).map((c) => "`" + c + "`").join(", ");
        else hint = " → no file by that name in the repo";
        out.push(`- ${r.id} (${loc(r)}) cites \`${m.ref}\`${hint}`);
      }
    }
    out.push("");
  }

  const hooks = rules.filter((r) => r.hookOpportunity);
  if (hooks.length) {
    out.push("## Better enforced by a hook");
    out.push("");
    out.push("A hook or script could enforce these mechanically, on every run, instead of relying on Claude to read and remember them:");
    out.push("");
    for (const r of hooks) {
      out.push(`- ${r.id} (${loc(r)}) "${truncate(r.text, 80)}"`);
    }
    out.push("");
    // The wired-hook inventory stays out of the report: it is the reader's
    // working input for marking a candidate already covered, and once those
    // marks are in the list above nothing else consumes it. It ships in the
    // scan summary and in audit.json instead.
  }

  const placed = rules.filter((r) => r.placement);
  if (placed.length) {
    out.push("## Placement candidates");
    out.push("");
    out.push("Rules whose job fits a Claude Code primitive better than rule prose:");
    out.push("");
    for (const r of placed) {
      const det = Object.entries(r.placement.detections)
        .map(([prim, d]) => `${prim} ${fmt(d.confidence)} [${d.evidence.join(", ")}]`)
        .join("; ");
      out.push(`- ${r.id} (${loc(r)}) → **${r.placement.bestFit}** — "${truncate(r.text, 70)}"`);
      out.push(`  - signals: ${det}`);
    }
    out.push("");
  }

  if (weakSkills.length) pushWeakSkillSection(out, weakSkills);

  if (opts.verbose) {
    out.push("## All rules");
    out.push("");
    out.push("Each column scores one thing about the rule, 0 (worst) to 1 (best): whether it has a firm verb, names an alternative, has a clear trigger, is scoped right, sits high in the file, is concrete, and how much it needs Claude's judgment rather than a hook.");
    out.push("");
    out.push("| Rule | Cat | " + FACTOR_COLUMNS.map(([, h]) => h).join(" | ") + " | Score | Grade |");
    out.push("|---|---|" + FACTOR_COLUMNS.map(() => "---").join("|") + "|---|---|");
    for (const r of rules) {
      const v = r.factorValues;
      const cells = FACTOR_COLUMNS.map(([f]) => fmt(f === "F8" ? r.f8 : v[f])).join(" | ");
      out.push(`| ${ruleLink(r, 40)} | ${r.category} | ${cells} | ${fmt(r.score)} | ${r.grade} |`);
    }
    out.push("");
    if (suppressed.length) pushSuppressedSection(out, suppressed);
  }

  return out.join("\n");
}

function truncate(text, n) {
  const clean = text.replace(/\|/g, "\\|").replace(/\s+/g, " ");
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
}

function cmdReport(root, opts) {
  const scanFile = path.join(root, TMP_DIR, "scan.json");
  if (!fs.existsSync(scanFile)) {
    process.stderr.write("No " + TMP_DIR + "/scan.json — run scan first.\n");
    process.exit(1);
  }
  const scanData = JSON.parse(fs.readFileSync(scanFile, "utf-8"));
  const { judgments, error } = loadJudgments(root, scanData.rules);
  if (error) {
    process.stderr.write(error + "\n");
    process.exit(1);
  }
  const audit = composeAudit(scanData, judgments);
  fs.writeFileSync(path.join(root, TMP_DIR, "audit.json"), JSON.stringify(audit, null, 2));
  if (opts.json) process.stdout.write(JSON.stringify(audit, null, 2) + "\n");
  else process.stdout.write(renderReport(audit, opts) + "\n");
}

// [Foreman: 061]
// Remeasure closes the fix-and-check loop: re-scan the edited corpus, reuse every
// cached judgment whose rule is unchanged (keyed by the 059 content hash), and
// re-judge only the rules a fix reworded. The previous audit.json is read before
// the re-scan overwrites it, so the report can lead with before/after. This is
// why the audit skill no longer bans a second pass — it bounds it to one instead.
function cmdRemeasure(root, opts) {
  const tmp = path.join(root, TMP_DIR);
  const judgeFile = path.join(tmp, "judgments.json");
  if (!fs.existsSync(judgeFile)) {
    process.stderr.write("No " + TMP_DIR + "/judgments.json — run a full scan → judge → report before remeasuring.\n");
    process.exit(1);
  }
  const auditFile = path.join(tmp, "audit.json");
  const prev = fs.existsSync(auditFile) ? JSON.parse(fs.readFileSync(auditFile, "utf-8")) : null;

  const scanData = scan(root);
  fs.writeFileSync(path.join(tmp, "scan.json"), JSON.stringify(scanData, null, 2));

  let judgments;
  try {
    judgments = JSON.parse(fs.readFileSync(judgeFile, "utf-8"));
  } catch (err) {
    process.stderr.write(TMP_DIR + "/judgments.json is not valid JSON: " + err.message + "\n");
    process.exit(1);
  }

  const unknown = scanData.rules.filter((r) => !judgments[r.key]);
  if (unknown.length) {
    // The fixes reworded these, so their hash is new and their old judgment is
    // gone. Emit them as a worklist and stop — the skill judges only these,
    // merges, and reruns. Nothing is composed or overwritten on this branch.
    process.stdout.write(JSON.stringify({
      remeasure: true,
      pending: unknown.length,
      judgmentsFile: TMP_DIR + "/judgments.json",
      note: "Judge these reworded rules, merge into judgments.json, then rerun remeasure.",
      judge: unknown.map((r) => ({ id: r.id, key: r.key, text: r.text, needsF1: r.factors.F1.method === "extraction_failed" })),
    }, null, 2) + "\n");
    return;
  }

  const { judgments: valid, error } = loadJudgments(root, scanData.rules);
  if (error) {
    process.stderr.write(error + "\n");
    process.exit(1);
  }
  const audit = composeAudit(scanData, valid);
  fs.writeFileSync(auditFile, JSON.stringify(audit, null, 2));
  if (opts.json) process.stdout.write(JSON.stringify({ ...audit, previous: prev }, null, 2) + "\n");
  else process.stdout.write(renderReport(audit, { ...opts, prev }) + "\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const rootIdx = args.indexOf("--root");
  const root = rootIdx !== -1 ? args[rootIdx + 1] : process.cwd();
  const opts = { verbose: args.includes("--verbose"), json: args.includes("--json") };

  if (command === "scan") cmdScan(root);
  else if (command === "report") cmdReport(root, opts);
  else if (command === "remeasure") cmdRemeasure(root, opts);
  else if (command === "clean") fs.rmSync(path.join(root, TMP_DIR), { recursive: true, force: true });
  else {
    process.stderr.write("Usage: assay.js <scan|report|remeasure|clean> [--root <path>] [--verbose] [--json]\n");
    process.exit(2);
  }
}

module.exports = {
  parseFrontmatter, findInstructionFiles, stripMetadata, identifyChunks, classifyChunk,
  mergeClarifications, splitCompound, checkStaleness, scoreF1, scoreF2, scoreF4, scoreF5, scoreF7,
  composeScore, grade, detectPlacement, scan, composeAudit, renderReport, loadJudgments,
  looksLikeStatement, hasImperativeVerb, checkSkillDescription, gradeSkill, findSkillFiles,
};

if (require.main === module) main();
