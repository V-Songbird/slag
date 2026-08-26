#!/usr/bin/env node
"use strict";

// assay engine — deterministic scoring of Claude Code rule files and
// .claude/skills/*/SKILL.md frontmatter descriptions.
//
// Commands (run from the project root being audited):
//   node assay.js scan [--root <path>] [--project-only]
//                                        discover + extract + mechanical scores;
//                                        writes .assay-tmp/scan.json, prints a
//                                        JSON summary with the judgment worklist
//   node assay.js report [--plain] [--verbose] [--json] [--root <path>]
//                                        merges .assay-tmp/judgments.json when it
//                                        exists, computes composite scores +
//                                        placement candidates, prints the finished
//                                        markdown report. With no judgments file
//                                        the report is deterministic-only and says so
//   node assay.js remeasure [--verbose] [--json] [--root <path>] [--project-only]
//                                        re-scans after fixes, reuses cached
//                                        judgments (re-judging only reworded
//                                        rules), prints a before/after report
//   node assay.js clean [--root <path>]  removes .assay-tmp/, and the change
//                                        journal once it holds no open change
//
// [Foreman: 081] The safe-change transaction — diagnose is the scan/audit record
// above, and these four are the mutation half:
//   node assay.js plan --from <draft.json>
//                                        validates + canonicalizes a draft plan,
//                                        fingerprints every affected file and
//                                        writes .assay/plan-<id>.json
//   node assay.js apply --change <id> [--change <id> …] | --batch <id>
//                                        applies ONLY the changes named here;
//                                        the argument is the approval boundary
//   node assay.js validate --change <id> [--external "<kind>: <result>"]
//                                        runs the mechanical checks and records
//                                        external attestations as evidence
//   node assay.js rollback --change <id> | --transaction <id>
//                                        restores journalled pre-images
//
// [Foreman: 084] Opt-in CI output — deterministic, read-only, writes nothing:
//   node assay.js ci [--host <name>] [--project-only] [--fail-on <gate>[,…]] [--json]
//                                        scans, composes and evaluates in
//                                        memory; exits 0 clean, 2 when a
//                                        selected gate failed, 1 on a usage
//                                        error. The gate set is closed and
//                                        evidence-bounded — see CI_GATES
//
// --project-only skips user-scope discovery; ASSAY_USER_DIR overrides where the
// user's own instruction files are looked for (default ~/.claude).
//
// [Foreman: 079] --host <claude-code|codex> selects the host profile discovery
// runs under, defaulting to claude-code. It is the adapter that changes, not the
// analyzers: a profile declares where its host loads instructions from and which
// analyses apply to it, and everything below reads that declaration. `report`
// takes the profile from the record it reads, so the flag matters on the
// commands that discover — scan and remeasure.
//
// Everything mechanical happens here; the only model-judged inputs are F3
// (trigger-action distance) and F8 (enforceability), supplied via judgments.json.
//
// [Foreman: 071] Deterministic analysis is the default and needs no model at all:
// judgments.json is optional. Absent, the audit composes without F3/F8, the score
// renormalizes over the factors that were measured, findings that depend on a
// model judgment simply do not derive, and every renderer labels the run
// deterministic-only. Present, the model layer is purely additive — it can add
// findings and regroup the report, never delete inventory or alter a
// deterministic finding.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
// [Foreman: 167] Only the hook admission pass runs anything, and only a command
// out of the change it is proving.
const { spawnSync } = require("child_process");

// [Foreman: 073] Real parsers, bundled rather than installed. Both are the
// published single-file UMD dists, committed verbatim under scripts/vendor/ —
// see vendor/VENDOR.md for versions, licenses and integrity hashes. The plugin
// still has no package.json and nothing for a user to install.
const MarkdownIt = require("./vendor/markdown-it.js");
const yaml = require("./vendor/js-yaml.js");

// [Foreman: 074] The host adapter owns every "where does Claude load this from"
// question — source discovery, precedence, skills, subagents, hooks, budgets,
// documentation provenance. Nothing below infers loading from a filename; it
// reads what the adapter returned. Swapping this require is what a second host
// profile costs.
const claudeAdapter = require("./adapters/claude.js");

// [Foreman: 160] The model-profile seam: every scoring weight and threshold
// below is read from a resolved profile, never written at module level. The
// default reproduces the shipped numbers exactly.
const { PROFILES, resolveProfile } = require("./models/index.js");

// [Foreman: 162] The durability seam. `.assay/` is where a run records what it
// is about to change, so the record outlives the `clean` that removes
// `.assay-tmp/`. STATE_DIR and statePath are defined there rather than here
// because that file is the one that must never be told to write elsewhere.
const {
  STATE_DIR, TRANSACTIONS_FILE, statePath, preflight, backupFiles, appendTransaction,
  // [Foreman: 170] the after-report reads the run back out of the same records
  readTransactions, revertPlan,
} = require("./safety.js");

// [Foreman: 079] The second host profile, and with it the registry `--host`
// selects from. Adding one is adding a line here plus an adapter file; nothing
// in the analyzers below branches on which one is active. A profile's own
// `policy` is how it withdraws an analysis it has no evidence for — see
// PROFILE_POLICY.
const ADAPTERS = {
  "claude-code": claudeAdapter,
  codex: require("./adapters/codex.js"),
};
const DEFAULT_HOST = claudeAdapter.name;

// CommonMark plus GFM tables (markdown-it's "default" preset), with raw HTML
// recognized so comments and tag blocks arrive as their own tokens.
const md = new MarkdownIt({ html: true });

const TMP_DIR = ".assay-tmp";

// ---------------------------------------------------------------------------
// Instruction System record — the versioned shape of every JSON artifact
// ---------------------------------------------------------------------------

// [Foreman: 072]
// scan.json and audit.json are not loose bags of fields: each is one versioned
// record that names who analyzed the project, with which parser, under which
// host profile, in which context. The analyzers keep their internal structures;
// the envelope is added at the file boundary and validated on the way back in.
//
// Determinism: every field except `context.analysisTime` is a pure function of
// the project state and the version consts below. Two scans of an unchanged
// project are byte-identical once that field is dropped.
//
// A release cut keeps ANALYZER_VERSION in step with assay's version in
// .claude-plugin/marketplace.json, which owns the published number.
const SCHEMA_VERSION = 1;
const ANALYZER_VERSION = "2.1.0";
const PARSER_NAME = "assay-markdown";
// [Foreman: 073] 2 = markdown-it 14.1.0 + js-yaml 4.1.0 behind assay's adapter.
// 1 was the handwritten line scanner; a record naming version 1 was produced by
// a different parser and its spans are not comparable.
const PARSER_VERSION = 2;
// [Foreman: 074] Host identity and profile version come from the adapter, so a
// record always names the profile that actually produced it.
const PROFILE_HOST = claudeAdapter.name;
const PROFILE_VERSION = claudeAdapter.profileVersion;
// [Foreman: 071] The semantic pass's other cache axis. Judgment keys are content
// hashes, so an edited rule re-judges by construction; a changed RUBRIC is what
// that cannot see. The number here is the one printed at the top of
// references/rubrics.md, and the two move together — bump both or
// neither. A judgments file recorded under a different one still composes; the
// report says the judgments predate the current rubric.
// Owed at the next substantive bump, and deliberately not done for its own
// sake: rubrics.md gains a one-line evidence note naming the study, the model
// tier it was measured on, and the date — the same disclosure
// WORDING_STUDY_EVIDENCE already carries for the deterministic factors. Doing
// it alone would invalidate every cached judgments file for a sentence.
// [Foreman: 172] 3: the sonnet5 column moved when rule-lab measured the tier.
const RUBRIC_VERSION = "3";

const RECORD_SCHEMA = {
  version: SCHEMA_VERSION,
  // Required at the top level of every record, whatever its kind.
  envelope: ["schemaVersion", "analyzer", "parser", "profile", "context", "coverage"],
  // Required inside `context`.
  context: ["projectRoot", "startupDirectory", "analysisTime"],
  // Required payload arrays, by record kind.
  // [Foreman: 073] `sources` is required, not reserved: it carries the lossless
  // line inventory, and a record without it cannot show that nothing was lost.
  // [Foreman: 081] `plan` is the third kind, through the same envelope: a plan
  // is an analysis artifact like the other two and names the same analyzer,
  // parser, profile and context. Additive by construction — scan and audit
  // validation reads its own row of this table and never sees this one.
  payload: {
    scan: ["files", "sources", "rules", "skills", "hookInventory"],
    audit: ["files", "sources", "rules", "skills", "hookInventory"],
    plan: ["changes"],
  },
  // Reserved: the output contract promises these, nothing fills them yet, and
  // they are allowed but never required at the top level. Later entries add
  // them — do not invent content for one here.
  // [Foreman: 075] `findings` left this list: an audit record emits it. It is
  // still not required, so a prior audit written before 075 stays readable and
  // only loses its finding deltas. A scan record carries no findings — nothing
  // is derived before the model judgments land.
  // [Foreman: 071] `semantic` left it too — see the block below.
  // [Foreman: 076] `relationships` left it as well: an audit record emits the
  // deterministic relationship graph. Still not required, so an audit written
  // before 076 stays readable.
  // [Foreman: 077] `mechanisms` left it too — see the block below. Still
  // optional: an audit written before 077 loses its ladder and nothing else.
  // [Foreman: 149] `changes` leaves as well, and it should have left with the
  // migration transaction: `payload.plan` requires it, so a plan record has
  // carried it since 081. Naming it on both lists said "required here, and
  // nothing fills it" in one object, which is the kind of contradiction the
  // record contract exists to prevent.
  reserved: [
    "instructions",
    "evidence", "plans", "validation",
  ],
};

// [Foreman: 071]
// `semantic` — optional audit payload, never required, never on a scan record.
// Absent means the audit ran deterministically: no model judged anything, and
// every renderer says so. Present, it is the provenance of the semantic pass
// that fed this audit:
//
//   semantic: {
//     provenance: { model, promptVersion, judgedAt, pass } | null,
//     judged:     <number of rules a judgment was found for>,
//     suppressed: <number of entries the verification pass dropped>,
//     candidates: [ … ]   // reserved, see below
//   }
//
// `provenance` is copied verbatim from judgments.json's optional top-level
// `_provenance`, which the audit skill writes after judging. Null means the
// judgments carried none — an older file, or a hand-written one.
//
// `candidates[]` is the contract the semantic half of a later entry fills; the
// engine defines the shape and emits nothing:
//
//   { kind: "paraphrase-duplicate" | "indirect-conflict" | "ambiguous-meaning"
//         | "placement" | "rewrite",
//     sources: [{ path, lineStart, lineEnd }],
//     summary: <one line, the model's own words>,
//     accepted: true | false | null,   // null = not yet reviewed
//     reason:  <why the model proposed it> }
//
// Every candidate stays a proposal: accepting one may regroup the report, and
// may never remove a source span or overwrite a deterministic finding.
const SEMANTIC_CANDIDATE_KINDS = [
  "paraphrase-duplicate", "indirect-conflict", "ambiguous-meaning", "placement", "rewrite",
];

// [Foreman: 077]
// `mechanisms` — optional audit payload. One entry per mechanism instance the
// project has wired, at its level on SCOPE.md's enforcement ladder. Level 1 is
// the prose itself and gets no entry: the rules ARE the corpus.
//
//   { id, type, level, name, source,
//     states:   { configured, enabled, trusted, applicable, verified },
//     coverage: { events?, matchers?, tools?, paths?, limits: [] },
//     provenance }
//
// Each state is `true`, `false`, or `"unknown"` — three different answers, and
// the report prints all three rather than collapsing the last two. `verified` is
// never true: assay reads configuration and never watches anything run, so no
// entry here is evidence that a mechanism executed. Presence is not strength.
const MECHANISM_LEVELS = { skill: 2, subagent: 2, hook: 3, "repo-check": 4, "remote-gate": 5 };
const MECHANISM_LEVEL_LABELS = {
  1: "the rules themselves",
  2: "skill and subagent workflows",
  3: "agent lifecycle guardrails",
  4: "repository enforcement",
  5: "remote enforcement",
};
// The limits vocabulary, deliberately small: a reader learns five sentences, not
// one phrasing per mechanism.
const MECHANISM_LIMITS = {
  notExecuted: "configured is not executed — assay read this out of a file and never watched it run",
  routing: "invocation is probabilistic — a description routes it, nothing guarantees it is reached",
  trust: "workspace trust is not introspectable from a static read",
  repo: "presence in the repository — assay does not check that any gate actually runs it",
  remote: "the workflow file exists — assay does not read its triggers, its jobs, or the branch policy",
  // [Foreman: 080] The Codex trust vocabulary. The adapter names which of these
  // apply to each hook by key — it declares the facts, this file owns the words,
  // and a reader still learns one sentence per idea rather than one per host.
  hookHashTrust: "trust is recorded against this definition's hash — editing the command marks it for review again, and it is skipped until re-trusted",
  projectTrust: "project-local hooks load only when the project `.codex/` layer is trusted, which is not a fact on disk",
  managedTrust: "managed by policy: trusted without review and not disableable from the hook browser — assay still never saw it run",
  managedOnly: "an `allow_managed_hooks_only` policy is in force, so this source is skipped whatever it says",
  mergedRepresentations: "this layer configures hooks in both `hooks.json` and inline `[hooks]`; the host merges them and warns at startup",
  explicitOnly: "implicit routing is switched off for this skill — it is reached only when a session names it explicitly",
};

// [Foreman: 079]
// What a host profile permits the shared analyzers to apply to its sources. The
// profile declares it, the record carries it, and every consumer reads it from
// there — no analyzer, renderer or derivation asks which host it is looking at.
// That is the 074 seam extended one step: 074 stopped shared code inferring
// LOADING from a filename, and this stops it inferring ANALYSIS from a host name.
//
//   wordingRubric — may the Claude-measured wording levers (explicit trigger,
//     must/always force, negative grammar, line position, task distance, worked
//     examples) score this profile's sources, and may the hygiene grade those
//     factors sum to be shown? Default true; the Claude profile is where they
//     were measured. A profile that sets it false still gets every host-neutral
//     analysis: availability gates, staleness, conflicts, duplicates, missing
//     escape hatches, and the lossless inventory.
//   skillRecipe — may the Claude-measured skill trigger recipe (quoted trigger
//     phrases, an exclusion clause, the per-description listing cap) grade this
//     profile's skills? Default true. A profile that sets it false still gets
//     mechanical validation of whatever metadata its own host documents as
//     required, plus any listing budget that host publishes — see readSkills.
const DEFAULT_POLICY = { wordingRubric: true, skillRecipe: true };

function profilePolicy(record) {
  const declared = record && record.profile && record.profile.policy;
  return isRecordObject(declared) ? { ...DEFAULT_POLICY, ...declared } : DEFAULT_POLICY;
}

// [Foreman: 080] The mechanism nouns a report uses for the profile that produced
// it. Advice that names a `.claude/rules/` file or a Claude Code primitive is
// wrong under a Codex record and right under a Claude one, and no renderer may
// learn a host name to tell them apart — so the words ride on the record beside
// the policy. The defaults are the Claude profile's, which is what keeps its
// output identical to the byte: that adapter declares no nouns and this object
// is what it always printed.
const DEFAULT_NOUNS = {
  primitive: "Claude Code primitive",
  scopedRules: "scoped `.claude/rules/` files",
  // [ADR 2026-08-05 D3] The host's own documented remedy for a shape-broken
  // memory file, offered as an extra safeAction on the file-shape finding. It
  // rides the profile's nouns so a host without a `/doctor` (Codex, which nulls
  // it) never prints it; the citation lives in the adapter's docs() row.
  doctorRemedy: "or run the host's `/doctor` checkup — documented to trim a checked-in CLAUDE.md and migrate the always-loaded guidance that remains into skills and nested CLAUDE.md, with confirmation (v2.1.206+)",
};

function profileNouns(record) {
  const declared = record && record.profile && record.profile.nouns;
  return isRecordObject(declared) ? { ...DEFAULT_NOUNS, ...declared } : DEFAULT_NOUNS;
}

// [Foreman: 082] Where this profile's host lets a NEW rule, skill or hook be
// written — the third fact that rides the record so an authoring flow never
// infers a host surface from a host name. There is deliberately NO default: a
// write path is not a thing to fall back on, and a profile that declares none
// gets an authoring flow that says so instead of one that guesses a filename.
function profileTargets(record) {
  const declared = record && record.profile && record.profile.targets;
  return isRecordObject(declared) ? declared : null;
}

function isRecordObject(x) {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

// The one content-hash primitive: a source file's fingerprint. `sources[]` has
// carried it since 073, and [Foreman: 081] the change transaction reuses it —
// a plan's staleness check and a scan's inventory must agree on what "this file
// is unchanged" means, and they do because it is the same function.
function hashContent(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

// null when the record is a valid instance of `kind`; otherwise a short reason,
// naming the schema version found so the caller can say what to rerun.
function validateRecord(record, kind) {
  const payload = RECORD_SCHEMA.payload[kind];
  if (!payload) return "unknown record kind: " + kind;
  if (!isRecordObject(record)) return "not a JSON object";
  if (!Number.isInteger(record.schemaVersion)) return "found schema pre-1";
  if (record.schemaVersion !== SCHEMA_VERSION) return "found schema " + record.schemaVersion;
  for (const key of RECORD_SCHEMA.envelope) {
    if (key === "schemaVersion") continue;
    if (!isRecordObject(record[key])) return key + " is missing or not an object";
  }
  if (typeof record.analyzer.name !== "string" || typeof record.analyzer.version !== "string") {
    return "analyzer is missing a name/version string";
  }
  if (typeof record.parser.name !== "string" || !Number.isInteger(record.parser.version)) {
    return "parser is missing a name string or integer version";
  }
  if (typeof record.profile.host !== "string" || !Number.isInteger(record.profile.version)) {
    return "profile is missing a host string or integer version";
  }
  for (const key of RECORD_SCHEMA.context) {
    if (typeof record.context[key] !== "string") return "context." + key + " is missing or not a string";
  }
  for (const key of payload) {
    if (!Array.isArray(record[key])) return key + " is missing or not an array";
  }
  // [Foreman: 081] A plan is the one record kind a later command WRITES FROM, so
  // its payload is checked at the read boundary too, not only when it is built.
  // A hand-edited plan missing a fingerprint or a patch is rejected here rather
  // than discovered halfway through an apply.
  if (kind === "plan") {
    const problem = validatePlanChanges(record.changes, record.batches);
    if (problem) return problem;
    // The id IS the content. Recomputing it here makes an approved plan
    // tamper-evident: an edited patch, path or batch changes the hash, and the
    // plan stops resolving instead of quietly authorizing different writes.
    const expectedId = hashContent(JSON.stringify({ changes: record.changes, batches: record.batches })).slice(0, 12);
    if (record.planId !== expectedId) {
      return "planId " + record.planId + " does not match the plan's content (now " + expectedId +
        ") — the file was edited after `plan` wrote it; re-plan from a draft";
    }
    return null;
  }
  return null;
}

function makeRecord(kind, payload, root) {
  const { coverage = null, context = null, profile = null, model = null, ...rest } = payload;
  const projectRoot = path.resolve(root);
  return {
    schemaVersion: SCHEMA_VERSION,
    analyzer: { name: "assay", version: ANALYZER_VERSION },
    parser: { name: PARSER_NAME, version: PARSER_VERSION },
    // [Foreman: 079] The profile the analysis actually ran under, carried from
    // the payload so a record always names the adapter that produced it. The
    // shape is unchanged — host and version, plus whatever policy that profile
    // declares. The consts remain the fallback for a hand-built payload.
    profile: profile || { host: PROFILE_HOST, version: PROFILE_VERSION },
    // [Foreman: 175] The model column the numbers in this record were produced
    // under - a sibling of the host profile above, and read back by every
    // command that renders a record it did not compute.
    model: model || MODEL_PROFILE.id,
    // [Foreman: 074] The context the adapter fixed for this analysis, carried
    // through unchanged. `userDir` null means user scope was off; `hostVersion`
    // null means the host was not probed or did not answer. Both are additive:
    // an older reader ignores them, and neither is required by the schema.
    // [Foreman: 079] The spread carries whatever else the adapter fixed — the
    // Codex profile's effective config.toml values, for one — so a reader can
    // see which cap was applied and whether it was configured or the default.
    // The Claude context has exactly the four keys below, so its record is
    // unchanged.
    context: {
      ...(context || {}),
      projectRoot: (context && context.projectRoot) || projectRoot,
      startupDirectory: (context && context.startupDirectory) || projectRoot,
      userDir: context ? context.userDir : null,
      hostVersion: context ? context.hostVersion : null,
      analysisTime: new Date().toISOString(),
    },
    coverage,
    ...rest,
  };
}

function writeRecord(file, kind, payload, root) {
  fs.writeFileSync(file, JSON.stringify(makeRecord(kind, payload, root), null, 2));
}

// [Foreman: 072] Old artifacts get a clean break, never a migration: a record
// this assay cannot read is rejected and rerun, because silently misreading a
// field is worse than repeating a scan that costs seconds.
function readRecord(file, kind) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    return { problem: "not valid JSON: " + err.message };
  }
  const problem = validateRecord(record, kind);
  if (problem) return { problem };
  // [Foreman: 175] One adoption point for every reader, so no command can
  // render a record's numbers through a different column than produced them.
  adoptRecordModel(record);
  return { record };
}

// One provenance line for every renderer: who analyzed this, under which host
// profile, against which record schema. Falls back to this process's own
// versions when handed a bare composed audit rather than a record.
function recordBanner(record) {
  const analyzer = (record && record.analyzer) || { name: "assay", version: ANALYZER_VERSION };
  const profile = (record && record.profile) || { host: PROFILE_HOST };
  const version = record && Number.isInteger(record.schemaVersion) ? record.schemaVersion : SCHEMA_VERSION;
  return `${analyzer.name} ${analyzer.version} · ${profile.host} profile · schema ${version}`;
}

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
const NON_LATIN_SCRIPT = new RegExp(
  "[\\u0370-\\u03FF\\u0400-\\u04FF\\u0530-\\u058F\\u0590-\\u05FF\\u0600-\\u06FF" +
  "\\u0900-\\u097F\\u0E00-\\u0E7F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF]"
);

// [Foreman: 084]
// The explicit language mode every rule and skill description carries. English
// is the one SUPPORTED mode and the only mode anything here is scored under.
//
//   "english"                  — the wording rubric applies
//   "non-latin-script"         — the script screen fired (the 065 behavior,
//                                now stated in this vocabulary)
//   "latin-unsupported:<lang>" — the function-word screen read one non-English
//                                Latin-script language
//
// This detects and discloses. It does not score: SCOPE.md's standing rule is
// that a wording score for a new language requires a separate VALIDATED
// language-specific analyzer, and none is built here. An unsupported mode
// therefore withdraws the English factors and the grade from that rule and says
// so; every language-independent mechanical analysis still runs on it in full.
//
// The asymmetry between the two possible mistakes is what sets the thresholds.
// A false "unsupported" silently ungrades a real English rule — the rubric goes
// quiet on exactly the rule that needed it, and nothing in the report says a
// check was skipped in error. A false "english" only reproduces the misread
// that already existed. The second is the cheaper error, so reclassification
// takes STRONG evidence and everything ambiguous, mixed or short stays
// English-scored.
//
// razor: hardcoded closed-class word lists for the five obvious Latin-script
// cases, not a language identifier. Upgrade path is a validated per-language
// analyzer, which SCOPE.md requires before any of these modes could be SCORED
// rather than merely named.
const LANGUAGE_NAMES = { es: "Spanish", pt: "Portuguese", fr: "French", it: "Italian", de: "German" };
const FUNCTION_WORDS_RAW = {
  en: ["the", "a", "an", "of", "to", "in", "for", "with", "when", "before", "after", "and", "or",
    "that", "this", "is", "are", "be", "on", "at", "from", "by", "as", "it", "its", "every",
    "each", "never", "always", "must", "not", "into", "than", "then", "if", "while", "any",
    "no", "only", "out", "over", "under", "per", "without", "you", "your", "we", "our", "but"],
  es: ["el", "la", "los", "las", "un", "una", "y", "o", "no", "que", "de", "del", "para", "con",
    "en", "al", "se", "su", "sus", "sobre", "siempre", "nunca", "antes", "después", "cada",
    "es", "son", "este", "esta", "como", "donde", "cuando", "porque", "pero", "más", "ya"],
  pt: ["o", "a", "os", "as", "do", "da", "dos", "das", "um", "uma", "e", "ou", "não", "que",
    "para", "com", "em", "no", "na", "nos", "nas", "sempre", "nunca", "antes", "depois",
    "cada", "é", "são", "este", "esta", "ao", "pelo", "pela", "se", "como", "mas"],
  fr: ["le", "la", "les", "des", "du", "un", "une", "et", "ou", "ne", "pas", "que", "qui", "dans",
    "pour", "avec", "sur", "sous", "avant", "après", "toujours", "jamais", "chaque", "est",
    "sont", "ce", "cette", "aux", "au", "par", "se", "son", "ses", "plus", "tout", "mais"],
  it: ["il", "lo", "la", "gli", "le", "dei", "delle", "un", "una", "e", "o", "non", "che", "chi",
    "nel", "nella", "per", "con", "su", "prima", "dopo", "sempre", "mai", "ogni", "è", "sono",
    "questo", "questa", "al", "dal", "da", "si", "come", "ma"],
  de: ["der", "die", "das", "den", "dem", "und", "oder", "nicht", "mit", "für", "bei", "vor",
    "nach", "immer", "nie", "wenn", "ein", "eine", "einen", "im", "ist", "sind", "sich", "auf",
    "aus", "zu", "von", "als", "wird", "werden", "kein", "keine", "aber"],
};
// A word that is English AND one of the screened languages — "no", "a", "in",
// "son", "die" — is evidence for neither side, so it leaves every list here
// rather than being curated out by hand and forgotten.
const FUNCTION_WORDS = (() => {
  const others = new Set(Object.entries(FUNCTION_WORDS_RAW)
    .filter(([lang]) => lang !== "en").flatMap(([, words]) => words));
  const shared = new Set(FUNCTION_WORDS_RAW.en.filter((w) => others.has(w)));
  return Object.fromEntries(Object.entries(FUNCTION_WORDS_RAW)
    .map(([lang, words]) => [lang, new Set(words.filter((w) => !shared.has(w)))]));
})();
// The order a tie between two screened languages resolves in — Spanish and
// Portuguese share most of their closed class, and a stable order beats a coin
// flip. Which of the two is named is a guess and the finding says so; that it
// is NOT English is what the screen actually established.
const LANGUAGE_ORDER = ["es", "pt", "fr", "it", "de"];
// Fewer prose tokens than this and there is nothing to screen: a short line
// stays English-scored.
const LANGUAGE_MIN_TOKENS = 6;
// Distinct closed-class words of one language needed to reclassify.
const LANGUAGE_MIN_HITS = 3;
// Any English closed-class word at all makes the line mixed, and mixed stays
// English-scored — see the asymmetry above.
const LANGUAGE_MAX_ENGLISH_HITS = 0;

// The prose a language screen may read: code identifiers, paths, file names and
// backtick spans are language-neutral and would answer for whichever list their
// letters happened to match, so none of them reaches the token count.
function languageTokens(text) {
  const prose = String(text)
    .replace(/`[^`]*`/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[\w.-]*[/\\][\w./\\-]*/g, " ")
    .replace(/\b[\w-]+\.[A-Za-z]{1,5}\b/g, " ")
    .replace(/\b[\w-]*_[\w-]*\b/g, " ");
  return (prose.match(/\p{L}[\p{L}'’-]*/gu) || [])
    .filter((w) => !/\p{Lu}/u.test(w.slice(1)))
    .map((w) => w.toLowerCase());
}

function detectLanguageMode(text) {
  if (NON_LATIN_SCRIPT.test(String(text || ""))) return "non-latin-script";
  const tokens = languageTokens(text);
  if (tokens.length < LANGUAGE_MIN_TOKENS) return "english";
  const seen = new Set(tokens);
  let english = 0;
  for (const w of seen) if (FUNCTION_WORDS.en.has(w)) english++;
  if (english > LANGUAGE_MAX_ENGLISH_HITS) return "english";
  let best = null, bestHits = 0;
  for (const lang of LANGUAGE_ORDER) {
    let hits = 0;
    for (const w of seen) if (FUNCTION_WORDS[lang].has(w)) hits++;
    if (hits > bestHits) { best = lang; bestHits = hits; }
  }
  if (!best || bestHits < LANGUAGE_MIN_HITS) return "english";
  return "latin-unsupported:" + best;
}

// English scoring applies, or it does not. One predicate, read everywhere the
// rubric, the grade or an English pattern would otherwise fire.
function englishScored(subject) {
  return ((subject && subject.languageMode) || "english") === "english";
}

function languageModeLabel(mode) {
  if (mode === "non-latin-script") return "a non-Latin script";
  const lang = LANGUAGE_NAMES[String(mode).split(":")[1]];
  return lang ? lang : "a language assay does not score";
}

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

// [Foreman: 160] Composite weights and floors — the quality-heuristic contract,
// read from the resolved model profile rather than written here. The default
// profile is haiku45, which holds exactly the numbers this file used to carry;
// see scripts/models/haiku45.js for why that is the shipped column and not a
// coincidence. Nothing selects a different profile yet.
// [Foreman: 175] Reassignable, and reassigned exactly twice: once by `--model`
// during argument parsing, and once when a command reads a record that names
// the column its numbers were produced under. Both happen before any scoring
// runs. Nothing below reads a weight or a threshold at module load - see
// PLACEMENT_SIGNALS, which names its threshold instead of copying its value.
let MODEL_PROFILE = resolveProfile();
let WEIGHTS = MODEL_PROFILE.weights;
let THRESHOLDS = MODEL_PROFILE.thresholds;

// Set from the flag, this pins the column: a record read later may not quietly
// move the numbers out from under an id the caller typed.
let modelPinnedByFlag = false;

function useModelProfile(id, fromFlag) {
  MODEL_PROFILE = resolveProfile(id);
  WEIGHTS = MODEL_PROFILE.weights;
  THRESHOLDS = MODEL_PROFILE.thresholds;
  if (fromFlag) modelPinnedByFlag = true;
}

// A record carries the column it was produced under. `report` re-renders a scan
// this process did not run, so adopting that column is what keeps a reported
// number the number that was measured, rather than the default one.
function adoptRecordModel(record) {
  if (modelPinnedByFlag) return;
  const id = record && record.model;
  if (typeof id === "string" && PROFILES[id]) useModelProfile(id, false);
}
const STALENESS_MULTIPLIER = 0.05;
// A bare prohibition can stall a headless run outright when the task needs the
// banned action — capped to grade F regardless of the other factors.
const STALL_RISK_CAP = 0.3;
// Position only starts to bite in files long enough to bury their bottom rules.
const LONG_FILE_LINES = 50;
// [Foreman: 062] A file's problem is shape, not wording, when it is mostly
// narrative, buries most of its rules, or is simply too long to hold one topic.
// A per-rule rewrite can't reach any of these — the report names the restructure
// instead. The thresholds below were chosen against labelled fixtures.
const RESTRUCTURE_NARRATIVE_SHARE = 0.6; // 60%+ of the graded content is prose
const RESTRUCTURE_BELOW_MIDPOINT = 0.5;  // half+ of its rules sit past the midpoint
// [ADR 2026-08-05 D1] 200 also matches the memory docs' per-CLAUDE.md-file size
// target (the adapter's docs() claim carries the citation; no second hardcoded
// URL here). The docs state no line target for `.claude/rules/` files, so the
// finding's limits clause naming that guidance only fires on a memory-kind file.
const RESTRUCTURE_LONG_FILE_LINES = 200; // long enough that one file should be several
const F4_NO_OVERLAP_SCORE = 0.85;
const F4_AMBIGUOUS_SCORE = 0.65;
const CATEGORY_FLOORS = { mandate: 0.5, override: 0.25, preference: 0.25 };
const LETTER_GRADES = [[0.8, "A"], [0.65, "B"], [0.5, "C"], [0.35, "D"]];

// [Foreman: 097] `FACTOR_LABELS` and `FRIENDLY_FIXES` lived here — a second set
// of names for the same six factors, printed only by `--verbose`, so the place a
// confused reader was sent renamed what confused them ("too vague to act on"
// became "framing"). One vocabulary now, PLAIN_PROBLEMS/PLAIN_FIXES, read by
// both reports. Both tables covered exactly the six keys of WEIGHTS, so nothing
// fell through to them.
// Verbose per-rule table: friendly column headers in factor order.
const FACTOR_COLUMNS = [
  ["F1", "Verb"], ["F2", "Framing"], ["F3", "Trigger"], ["F4", "Scope"],
  ["F5", "Position"], ["F7", "Concrete"], ["F8", "Judgment"],
];

// Placement detection signals (hook / skill / subagent / compound).

const PLACEMENT_SIGNALS = {
  hook: [
    // [Foreman: 175] The threshold is NAMED here, not copied: this table is
    // built at module load, before `--model` has chosen a column.
    { name: "f8-low", weight: 0.4, f8BelowThreshold: "f8Hook" },
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
  // [ADR 2026-08-05 D7] Anthropic's context-engineering guidance articulates the
  // subagent pattern these signals detect — a focused task, a clean context, a
  // condensed summary back. The weights stay assay's own heuristics; this note
  // records where the vocabulary is corroborated, and changes no number.
  subagent: [
    { name: "read-large-tree", weight: 0.4, pattern: /\b(read\s+the\s+(full|entire|whole)\s+[\w\s]+|read\s+the\s+source\s+(at|in)|check\s+every\s+[\w\s]+|scan\s+(all|every)\s+[\w\s]+|inspect\s+(all|every)\s+[\w\s]+|traverse\s+(all|every|the\s+entire))\b/i },
    { name: "audit-verb", weight: 0.4, pattern: /\b(audit|review|verify|check)\s+(the\s+)?(diff|code|changes?|coverage|implementation|module|component|feature|test\s+suite|pr|branch|commit)\b/i },
    { name: "judgment-verification-phrase", weight: 0.4, pattern: /\b(make\s+sure\s+(the\s+)?[\w\s]+?\s+(covers?|is\s+(tested|verified|asserted)|meets?)|ensure\s+(the\s+)?[\w\s]+?\s+(complies|satisfies|matches)|verify\s+(the\s+)?[\w\s]+?\s+(covers?|is\s+exercised))\b/i },
    // [ADR 2026-08-05 D6] "adversarially verify/review/check" is the workflows
    // docs' own phrasing for the same independent-check intent — a rule written
    // against current docs scored 0 on this signal without it.
    { name: "bias-independence-language", weight: 0.2, pattern: /\b(fresh\s+context|second\s+opinion|independent\s+review|without\s+(knowing|seeing)\s+what\s+was\s+written|unbiased\s+review|from\s+scratch\b|blind\s+review|adversarial(?:ly)?\s+(?:verif|review|check)\w*)\b/i },
    { name: "delimited-summary-output", weight: 0.2, pattern: /\b(return\s+(a\s+)?(summary|verdict|list|inventory|report|contract|approved|ok)|report\s+back\s+with|produce\s+(a\s+)?(contract|inventory|summary|report|list\s+of))\b/i },
    { name: "context-heavy-reference", weight: 0.25, pattern: /\b(the\s+(full|entire|whole)\s+(repository|repo|codebase|source\s+tree)|sibling\s+(repo|codebase|project)|external\s+(repository|project|codebase))\b|[A-Za-z]:[\\/][\w\\/.\- ]+|(?<![\w/])\/[\w./-]+\/[\w./-]+/i },
    { name: "agent-invocation-phrase", weight: 0.65, pattern: /\b(run|invoke|delegate\s+to|call|use|spawn|launch)\s+(the\s+)?`?[\w][\w.-]*`?\s+(agent|subagent)\b/i },
  ],
};
const COMPOUND_CONJUNCTION = /(,\s+and\s+|\s+—\s+|\s+--\s+|;\s+|\s+while\s+also\s+|\s+plus\s+)/;

// [Foreman: 076] The hook event a rule's own wording names, and the tool matcher
// that event implies. Only explicit lifecycle phrasing infers one: a rule that
// never says when it fires leaves this null, and the check that reads it — "a
// hook is already wired for this moment" — stays silent rather than guessing at
// an event and calling a policy covered.
const HOOK_EVENT_SIGNALS = [
  { pattern: /\bpre[-\s]?commit\b|\bbefore\s+(?:you\s+|the\s+|each\s+|every\s+|any\s+)?(?:commit|committing|push|pushing)\b/i, event: "PreToolUse", matcher: "Bash" },
  { pattern: /\bon\s+save\b|\bafter\s+(?:each\s+|every\s+|any\s+|the\s+)?(?:edit|write|save)\b|\bafter\s+editing\b/i, event: "PostToolUse", matcher: "Edit|Write" },
  { pattern: /\bsession\s+start\b|\bat\s+the\s+start\s+of\s+(?:each\s+|every\s+)?session\b/i, event: "SessionStart", matcher: null },
];

function inferHookEvent(ruleText) {
  for (const s of HOOK_EVENT_SIGNALS) {
    if (s.pattern.test(ruleText)) return { event: s.event, matcher: s.matcher };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

// [ADR 2026-08-05 B2] The documented MEMORY.md read cap is a per-file line/byte
// limit — unlike the ambiguous chain-wide cap — measured over the content that
// actually loads: a leading YAML frontmatter block and block-level HTML comments
// are stripped before the host counts. This returns the real source line of the
// last line still inside the cap (a rule after it is definitively never read at
// session start), or null when the whole file fits. The engine owns the
// arithmetic; the cap numbers and their provenance are adapter-declared.
function memoryIndexBoundary(content, cap) {
  const lines = content.split("\n");
  let i = 0;
  if (lines[0] === "---") {
    let j = 1;
    while (j < lines.length && lines[j] !== "---") j++;
    if (j < lines.length) i = j + 1; // skip the frontmatter block, closing --- included
  }
  let measuredLines = 0;
  let measuredBytes = 0;
  let inComment = false;
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (inComment) {
      if (trimmed.includes("-->")) inComment = false;
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) inComment = true;
      continue;
    }
    measuredLines += 1;
    measuredBytes += Buffer.byteLength(lines[i] + "\n", "utf-8");
    // The current raw line is the first past the cap; the last in-budget line
    // is the previous one, whose 1-based number equals this 0-based index.
    if (measuredLines > cap.lines || measuredBytes > cap.bytes) return i;
  }
  return null;
}

// [Foreman: 097] A finding's `safeActions` are written as phrases ("repair the
// glob"), because they are also plan input. A report cell is a sentence.
function upperFirst(s) {
  const t = String(s);
  return t.charAt(0).toUpperCase() + t.slice(1);
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

// ---------------------------------------------------------------------------
// Frontmatter — parsed by js-yaml, normalized for the analyzers
// ---------------------------------------------------------------------------

// [Foreman: 073] Frontmatter used to be read by a line scanner that guessed at
// flow arrays, block lists and folded scalars and silently mangled anything
// else. It is real YAML, so a real YAML parser reads it: quoted strings,
// anchors, nested maps, multi-line flow sequences and every scalar style come
// out right, and a file whose frontmatter does not parse is reported instead of
// half-read.
//
// The analyzers only ever read strings and arrays of strings, so every other
// value is normalized down to one of those. A value with no faithful
// string form — a nested map — is dropped from the returned metadata and named
// as an unsupported construct rather than flattened into a fake string.
function normalizeFrontmatterValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map(normalizeFrontmatterValue).filter((v) => typeof v === "string" && v !== "");
  }
  return null;
}

// The frontmatter block's line span, 0-based, with `end` the index of the
// closing "---". null when the file opens with anything else.
function frontmatterSpan(lines) {
  if (!lines.length || lines[0].trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return { start: 0, end: i };
  }
  return null;
}

// { data, span, error, unreadKeys }. `error` is a message, never a throw: a
// malformed block costs the file its metadata, never its rules.
function parseFrontmatterBlock(content) {
  const lines = content.split("\n");
  const span = frontmatterSpan(lines);
  const empty = { data: {}, span, error: null, unreadKeys: [] };
  if (!span) return empty;

  let loaded;
  try {
    loaded = yaml.load(lines.slice(1, span.end).join("\n"), { schema: yaml.DEFAULT_SCHEMA });
  } catch (err) {
    return { ...empty, error: err.reason || err.message };
  }
  if (loaded === null || loaded === undefined) return empty;
  if (typeof loaded !== "object" || Array.isArray(loaded)) {
    return { ...empty, error: "frontmatter is not a mapping" };
  }

  const data = {};
  const unreadKeys = [];
  for (const [key, value] of Object.entries(loaded)) {
    const normalized = normalizeFrontmatterValue(value);
    if (normalized !== null) { data[key] = normalized; continue; }
    // [Foreman: 097] A nested map is not unreadable, it is one level deeper. Its
    // scalar entries arrive as `key.subkey`, which is how a file that declares
    // what KIND of file it is — `metadata: { node_type: memory }` — stops being
    // reported as a defect in the very block that answers the question. A value
    // nested deeper still has no faithful flat form and is named, as before.
    const flat = isRecordObject(value)
      ? Object.entries(value).map(([k, v]) => [key + "." + k, normalizeFrontmatterValue(v)])
      : [];
    if (!flat.length || flat.some(([, v]) => v === null)) { unreadKeys.push(key); continue; }
    for (const [k, v] of flat) data[k] = v;
  }
  return { data, span, error: null, unreadKeys };
}

function parseFrontmatter(content) {
  return parseFrontmatterBlock(content).data;
}

// The project files a scoped rules file's globs actually resolve to, sorted and
// deduplicated, or null when this Node cannot glob. [Foreman: 076] The paths
// themselves — not just their count — are what lets two scoped files be compared
// for a shared target.
function globMatchPaths(globs, root) {
  // razor: fs.globSync needs Node 22+; on older Node the match set is unknown
  // and dead-glob detection is skipped rather than reimplementing a matcher.
  if (typeof fs.globSync !== "function") return null;
  const matched = new Set();
  for (const pattern of globs) {
    try {
      for (const hit of fs.globSync(pattern, { cwd: root })) matched.add(hit.split("\\").join("/"));
    } catch {
      // malformed pattern matches nothing
    }
  }
  return [...matched].sort();
}

// [Foreman: 141] A repository vendored inside this one loads like a project
// source and reads like project policy, and the reader owns none of it: those
// rules were written elsewhere, their paths resolve against their own root, and
// a rewrite offered here is overwritten by the next update. Same class as the
// host's auto-memory notes — files that load, that the reader does not own.
//
// Two mechanical signals, no heuristics: a `path =` entry in `.gitmodules`
// (which catches a submodule that was never initialized and so has no `.git`),
// or a nested `.git` between the file and the root (which catches a plain clone
// dropped into the tree, submodule or not).
const vendoredDeclared = new Map();
function declaredSubmodules(root) {
  if (vendoredDeclared.has(root)) return vendoredDeclared.get(root);
  const roots = new Set();
  try {
    for (const line of fs.readFileSync(path.join(root, ".gitmodules"), "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
      if (m) roots.add(m[1].split(path.sep).join("/").replace(/^\.\//, "").replace(/\/+$/, ""));
    }
  } catch {
    // No `.gitmodules` is the normal case, not a failure.
  }
  vendoredDeclared.set(root, roots);
  return roots;
}

// Outermost match wins by construction, so a repository inside a vendored
// repository is attributed to the one the reader can actually see.
function vendoredRootOf(absPath, root) {
  const stop = path.resolve(root);
  const rel = path.relative(stop, path.dirname(path.resolve(absPath)));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const declared = declaredSubmodules(stop);
  const parts = rel.split(path.sep).filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    if (declared.has(sub)) return sub;
    if (fs.existsSync(path.join(stop, ...parts.slice(0, i), ".git"))) return sub;
  }
  return null;
}

// [Foreman: 141] "Not the reader's to fix", in one place instead of six. Three
// ways a file that loads can fail that test: it lives outside the repository,
// the host wrote it, or it belongs to a repository vendored inside this one.
// Every caller that used to spell out the scope test now asks this.
function notReadersOwn(file) {
  if (!file) return false;
  return file.scope === "user" || file.scope === "ancestor" ||
    Boolean(file.autoMemory) || Boolean(file.vendored);
}

// [Foreman: 074] Reading and parsing is shared; *which* files exist and how
// they load is the adapter's answer, arriving as `sources`. This function opens
// each one and does nothing host-specific with it except ask the adapter the one
// loading question that depends on parsed content (see adapter.loadsAlways).
//
// [Foreman: 070] A file that is discovered but unreadable leaves the corpus
// and is reported, not thrown on: one locked file must not take the whole
// audit down, and it must not vanish either.
function readSources(sources, root, inaccessible = [], adapter = claudeAdapter, context = null) {
  const parsed = [];
  const openSource = (source) => {
    let content;
    try {
      content = fs.readFileSync(source.absPath, "utf-8");
    } catch (err) {
      inaccessible.push({ path: source.path, reason: err.code || err.message });
      return null;
    }
    const fm = parseFrontmatter(content);
    let globs = fm.paths || [];
    if (typeof globs === "string") globs = globs ? [globs] : [];
    const f = { ...source, content };
    f.globs = globs;
    // [Foreman: 076] `globMatched` is working state for scope-overlap detection;
    // scan drops it before the record is written, the way `content` is dropped.
    f.globMatched = globs.length ? globMatchPaths(globs, root) : null;
    f.globMatchCount = f.globMatched === null ? null : f.globMatched.length;
    f.defaultCategory = fm["default-category"] || "mandate";
    f.lineCount = content.split("\n").length;
    f.alwaysLoaded = adapter.loadsAlways(source, globs);
    // [Foreman: 141] Only a project-scope source can be vendored: a user or
    // ancestor file is already outside the repository by definition, and asking
    // the filesystem about it would answer a question nobody asked.
    if (source.scope !== "user" && source.scope !== "ancestor" && source.absPath) {
      const from = vendoredRootOf(source.absPath, root);
      if (from) {
        f.vendored = true;
        f.vendoredRoot = from;
      }
    }
    // [Foreman: 079] A source whose host budget runs out partway through it
    // arrives carrying the byte offset where that happens. Turning the offset
    // into a line is shared arithmetic over an adapter-declared fact: the
    // engine never decides WHERE a budget lands, only which rules fall past it.
    // Counted over BYTES, not characters: the budget is a byte budget, so a
    // multi-byte character before the boundary must not shift the line.
    if (Number.isInteger(source.truncatedAtByte)) {
      const upTo = Buffer.from(content, "utf-8").subarray(0, source.truncatedAtByte).toString("utf-8");
      f.truncatedAtLine = upTo.split("\n").length;
    }
    // [ADR 2026-08-05 B2] A per-source documented read cap (auto-memory's
    // MEMORY.md today): the line past which content is dropped on the next load.
    if (source.docCap) {
      const line = memoryIndexBoundary(content, source.docCap);
      if (line !== null) f.docCapLine = line;
    }
    return f;
  };

  for (const source of sources) {
    const f = openSource(source);
    if (f) parsed.push(f);
  }

  // [Foreman: 090] Memory files can pull other files into the loaded set with
  // the host's @path import syntax. The adapter reads the syntax and resolves
  // each target; this loop owns recursion, the documented hop cap, and the
  // one-read-per-real-file guarantee that makes an import cycle terminate.
  // An unresolved path-shaped import lands in `inaccessible` — the agent was
  // promised that file and assay could not read it.
  if (typeof adapter.discoverImports === "function") {
    const ctx = { projectRoot: root, userDir: context && context.userDir };
    const realOf = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    const seen = new Set(parsed.map((f) => realOf(f.absPath)));
    let frontier = parsed.slice();
    const maxDepth = adapter.IMPORT_MAX_DEPTH || 5;
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next = [];
      for (const file of frontier) {
        const found = adapter.discoverImports(file, ctx);
        for (const u of found.unresolved) {
          inaccessible.push({ path: u.target, reason: "imported by " + u.importedBy + ":" + u.line + " — " + u.reason });
        }
        for (const src of found.sources) {
          const real = realOf(src.absPath);
          if (seen.has(real)) continue; // a cycle or a double import reads once
          seen.add(real);
          const f = openSource(src);
          if (f) { parsed.push(f); next.push(f); }
        }
      }
      frontier = next;
    }
    // A file past the hop cap is never opened; the import that names it must
    // not vanish from coverage just because the recursion stopped.
    for (const file of frontier) {
      const found = adapter.discoverImports(file, ctx);
      for (const src of found.sources) {
        if (seen.has(realOf(src.absPath))) continue;
        inaccessible.push({ path: src.path, reason: src.selectionReason + " — beyond the documented " + maxDepth + "-hop import depth, not read" });
      }
    }
  }

  return parsed;
}

// Kept for callers that only want the project's parsed instruction files. User
// scope is off here: a caller passing nothing but a root is asking about a
// project, and picking up the developer's own ~/.claude behind its back would be
// a surprise.
function findInstructionFiles(root, inaccessible = []) {
  const ctx = claudeAdapter.detectContext({ root, projectOnly: true });
  const found = claudeAdapter.discoverSources(ctx);
  inaccessible.push(...found.inaccessible);
  return readSources(found.sources, ctx.projectRoot, inaccessible, claudeAdapter, ctx);
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
// [ADR 2026-08-05 C4] This is the DOCUMENTED host default, not an assay
// invention — skills.md states the 1,536-char cap and makes it configurable via
// `skillListingMaxDescChars` (the adapter's docs() row carries the citation).
// Reading a project's override is out of scope; the default is what assay grades.
const DESCRIPTION_CAP = 1536;

// [Foreman: 097] The defect the trigger recipe calls its largest measured
// effect, and the one nothing checked for: an opening sentence that enumerates a
// domain's whole surface. The router reads one entry per skill, and a base
// sentence listing eight things dilutes every one of them — shortening it is the
// highest-value edit on a description that already has its trigger clause.
//
// razor: a comma count over the text before the trigger clause, not a parser.
// Five is the line because four reads as a normal sentence with a list in it and
// six is unmistakably an inventory; assay's own four descriptions sat at 3, 3, 7
// and 8 when this was written.
const SKILL_ENUMERATION_COMMAS = 5;

function enumeratedOpener(text) {
  const before = String(text).split(SKILL_TRIGGER_CLAUSE)[0];
  return (before.match(/,/g) || []).length >= SKILL_ENUMERATION_COMMAS;
}

const SKILL_CHECK_LABELS = {
  trigger: 'no "Use when" trigger clause',
  enumerated: "the opening sentence lists too much — shorten it to what the skill is for",
  concrete: "no concrete artifact or file type named",
  exclusion: 'no "Do NOT use" exclusion clause',
  redundant: "a clause is duplicated — merge the pair, keep every distinct phrasing",
  overCap: "over the 1,536-char listing cap — the tail is truncated",
  overSpecified: "model-disabled — drop when_to_use and trigger phrasings, keep a short user-facing summary",
  whenToUse: "model-invocable — drop when_to_use, fold any trigger phrases into description",
  empty: "no description",
  dead: "no model or user invocation — recommend removing the skill",
  // [Foreman: 095] The frontmatter key itself can be the missing thing — a
  // subagent file with no `description:` line at all. Without a label the row
  // said the field name, or nothing.
  description: "no `description` in the frontmatter",
};

function checkSkillDescription(description) {
  const text = (description || "").trim();
  const quotes = text.match(SKILL_QUOTED_PHRASE) || [];
  // the base sentence must name the artifact itself — quoted trigger phrases
  // don't count toward concreteness
  const base = text.replace(SKILL_QUOTED_PHRASE, " ");
  const missing = [];
  // The trigger clause is the requirement; the quote COUNT is not. A local A/B
  // study measured 0, 1, 2 and 4 quoted phrasings on
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
  if (enumeratedOpener(text)) missing.push("enumerated");
  return { quotedPhrases: quotes.length, missing, redundant, length: text.length, overCap: text.length > DESCRIPTION_CAP };
}

// A skill's invocation flags decide what "good" means. The trigger recipe only
// governs auto-routing (disable-model-invocation unset). A user-only slash
// command wants a short plain summary, not trigger machinery; a skill neither
// side can invoke is dead. Defaults are on/on, so an unflagged skill is graded
// on the recipe exactly as before. A model-invocable skill is graded on the
// combined text but flagged if when_to_use still exists as its own field: a
// local A/B study found no firing penalty from
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

// [Foreman: 080] The `agents/openai.yaml` sidecar, read with the same vendored
// YAML parser the frontmatter uses. Parsing lives here, discovery lives in the
// adapter — the same split SKILL.md has had since 074.
//
// A sidecar that will not parse is REPORTED, never thrown and never guessed at:
// the skill keeps its documented defaults and the file is named as unreadable,
// exactly like malformed frontmatter.
function readSkillMetadata(absPath) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, "utf-8");
  } catch (err) {
    return { metadata: null, issue: err.code || err.message };
  }
  let doc;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    return { metadata: null, issue: String(err.message).split("\n")[0].trim() };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { metadata: null, issue: "not a YAML mapping" };
  }
  const iface = doc.interface && typeof doc.interface === "object" ? doc.interface : {};
  const policy = doc.policy && typeof doc.policy === "object" ? doc.policy : {};
  const deps = doc.dependencies && typeof doc.dependencies === "object" ? doc.dependencies : {};
  const tools = Array.isArray(deps.tools) ? deps.tools : [];
  return {
    metadata: {
      displayName: typeof iface.display_name === "string" ? iface.display_name : null,
      shortDescription: typeof iface.short_description === "string" ? iface.short_description : null,
      // Documented default: implicit invocation is on unless a sidecar says
      // otherwise. `false` is the only value that turns it off.
      allowImplicitInvocation: policy.allow_implicit_invocation !== false,
      toolDependencies: tools
        .filter((t) => t && typeof t === "object")
        .map((t) => ({
          type: typeof t.type === "string" ? t.type : null,
          value: typeof t.value === "string" ? t.value : null,
        })),
    },
    issue: null,
  };
}

// [Foreman: 074] Skill locations come from the adapter; reading the frontmatter
// and grading it stays here.
// [Foreman: 080] `policy` decides which grading applies. Under a profile that
// withholds the trigger recipe, a skill still gets everything its own host
// documents as required — see gradeSkill's validation mode.
function readSkills(found, policy = DEFAULT_POLICY) {
  const skills = [];
  for (const s of found) {
    let raw;
    try {
      raw = fs.readFileSync(s.absPath, "utf-8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    if (policy.skillRecipe === false) {
      const meta = s.metadataAbsPath ? readSkillMetadata(s.metadataAbsPath) : { metadata: null, issue: null };
      const name = typeof fm.name === "string" ? fm.name.trim() : "";
      const descText = typeof fm.description === "string" ? fm.description.trim() : "";
      skills.push({
        path: s.path,
        name: name || s.name,
        description: descText,
        scope: s.scope,
        source: s.source,
        // The two fields the host documents as required, checked mechanically.
        checks: {
          mode: "required-metadata",
          missing: [...(name ? [] : ["name"]), ...(descText ? [] : ["description"])],
          length: descText.length,
        },
        // The listing entry this skill costs: its name and its description are
        // what the host lists before any of them is selected.
        listingChars: (name || s.name).length + descText.length,
        ...(s.metadataPath ? { metadataPath: s.metadataPath } : {}),
        ...(meta.metadata ? { metadata: meta.metadata } : {}),
        ...(meta.issue ? { metadataIssue: meta.issue } : {}),
      });
      continue;
    }
    const descText = typeof fm.description === "string" ? fm.description : "";
    const whenToUse = typeof fm.when_to_use === "string" ? fm.when_to_use : "";
    // when_to_use carries trigger text in some skills; the router reads both
    const description = [descText, whenToUse].filter(Boolean).join(" ");
    // flags default to on: an unflagged skill is model- and user-invocable
    const modelInvocable = !(fm["disable-model-invocation"] === "true" || fm["disable-model-invocation"] === true);
    const userInvocable = !(fm["user-invocable"] === "false" || fm["user-invocable"] === false);
    // [Foreman: 084] The trigger recipe is an English recipe — quoted trigger
    // phrasings, an exclusion clause, a concrete noun — so a description it
    // cannot read is set aside exactly as a rule is. The one check that survives
    // is the character cap, which counts characters and asks no language.
    const languageMode = detectLanguageMode(description);
    const checks = englishScored({ languageMode })
      ? gradeSkill(description, whenToUse, modelInvocable, userInvocable)
      : {
        mode: "unsupported-language", missing: [], redundant: false,
        length: description.trim().length, overCap: description.trim().length > DESCRIPTION_CAP,
      };
    skills.push({
      path: s.path,
      name: typeof fm.name === "string" && fm.name ? fm.name : s.name,
      description,
      languageMode,
      modelInvocable,
      userInvocable,
      checks,
    });
  }
  return skills;
}

function findSkillFiles(root) {
  return readSkills(claudeAdapter.discoverSkills(claudeAdapter.detectContext({ root, projectOnly: true })).project);
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

// A table body row's cells, left to right. The row's outer pipes go, escaped
// pipes stay inside their cell, and a cell with no letters in any script — a
// dash, a count, an empty column — carries nothing to grade and drops out.
// [Foreman: 073] The letter test is Unicode-wide: a Cyrillic or CJK cell used to
// read as letter-free and vanish from the inventory entirely.
function tableCells(row) {
  return row.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim())
    .filter((c) => /\p{L}/u.test(c));
}

// ---------------------------------------------------------------------------
// Markdown adapter — markdown-it tokens in, assay's line model out
// ---------------------------------------------------------------------------

// [Foreman: 073]
// Block structure used to be found by hand: a fence state machine, a
// "starts with a pipe and the next line has dashes" table sniffer, a heading
// regex. Each was approximately right and wrong at the edges — a fence indented
// inside a list item, a table with no leading pipe, a setext heading, an
// indented code block. markdown-it decides all of that now, and every token
// carries `map` = [startLine, endLine) over the source, so the answer comes back
// as line numbers into the file the caller already has.
//
// What stays assay's own, deliberately, because it is policy and not Markdown:
// HTML-comment stripping, `<!-- assay-ignore -->` handling, `<!-- category: -->`
// annotations and `<example>`-style tag bodies. Those live in stripMetadata.
function addRange(set, map) {
  if (!map) return;
  for (let i = map[0]; i < map[1]; i++) set.add(i);
}

function markdownRegions(lines, frontmatterEnd) {
  const fenceLines = new Set();     // fenced and indented code — never graded
  const headings = new Set();       // first line of a heading, ATX or setext
  const headingLines = new Set();   // every line a heading occupies
  const hrLines = new Set();
  const tableLines = new Set();
  const tableBodyRows = new Set();
  const quoteLines = new Set();     // block quotes — cited, not commanded
  const unsupported = [];
  const regions = { fenceLines, headings, headingLines, hrLines, tableLines, tableBodyRows, quoteLines, unsupported };

  // The frontmatter is YAML, not Markdown: blank it out so its "---" markers
  // cannot read as a thematic break or a setext underline. Blanking rather than
  // slicing keeps every token line number an index into the original file.
  const masked = lines.map((l, i) => (i < frontmatterEnd ? "" : l)).join("\n");

  let tokens;
  try {
    tokens = md.parse(masked, {});
  } catch (err) {
    // A parser that gives up must not take the audit down and must not drop a
    // line: the body becomes one unsupported construct, graded like a code
    // fence — that is, not at all.
    for (let i = frontmatterEnd; i < lines.length; i++) fenceLines.add(i);
    unsupported.push({
      reason: "markdown parse failed: " + (err && err.message ? err.message : String(err)),
      startLine: frontmatterEnd + 1,
      endLine: lines.length,
    });
    return regions;
  }

  let inTableBody = false;
  for (const token of tokens) {
    switch (token.type) {
      case "fence": {
        addRange(fenceLines, token.map);
        // An unclosed fence swallows everything below it. That is what CommonMark
        // says, and it is almost never what the author meant, so it is named.
        const marker = token.markup ? token.markup[0] : "`";
        const closer = new RegExp("^" + escapeRe(marker) + "{" + (token.markup || "```").length + ",}\\s*$");
        if (token.map && !closer.test((lines[token.map[1] - 1] || "").trim())) {
          unsupported.push({
            reason: "unclosed code fence — every line below it is read as code",
            startLine: token.map[0] + 1,
            endLine: token.map[1],
          });
        }
        break;
      }
      case "code_block":
        addRange(fenceLines, token.map);
        break;
      case "heading_open":
        addRange(headingLines, token.map);
        if (token.map) headings.add(token.map[0]);
        break;
      case "hr":
        addRange(hrLines, token.map);
        break;
      case "table_open":
        addRange(tableLines, token.map);
        break;
      // [Foreman: 091] A block quote is a citation by construction — a pasted
      // requirement, a retro line, someone else's words. Its lines stay in the
      // inventory as content and never chunk into rules; before this, "> We
      // never test on Fridays" graded as a live mandate with the marker
      // breaking verb detection on genuinely imperative quotes.
      case "blockquote_open":
        addRange(quoteLines, token.map);
        break;
      case "tbody_open":
        inTableBody = true;
        break;
      case "tbody_close":
        inTableBody = false;
        break;
      case "tr_open":
        if (inTableBody) addRange(tableBodyRows, token.map);
        break;
      default:
        break;
    }
  }
  return regions;
}

function stripMetadata(content) {
  const lines = content.split("\n");
  const result = [];
  const annotations = {}; // lineNum -> category
  const ignored = new Set(); // lineNums following an assay-ignore comment
  const unsupported = []; // { reason, startLine, endLine } — 1-based, inclusive

  // [Foreman: 073] Malformed frontmatter is inventoried, never guessed at and
  // never thrown on: the block is named as unsupported and the rest of the file
  // is still parsed for rules.
  const fm = parseFrontmatterBlock(content);
  const frontmatterEnd = fm.span ? fm.span.end + 1 : 0;
  if (fm.error) {
    unsupported.push({ reason: "malformed frontmatter: " + fm.error, startLine: 1, endLine: frontmatterEnd });
  }
  for (const key of fm.unreadKeys) {
    unsupported.push({
      reason: "frontmatter key `" + key + "` holds a nested map — inventoried, not analyzed",
      startLine: 1,
      endLine: frontmatterEnd,
    });
  }

  const regions = markdownRegions(lines, frontmatterEnd);
  const fenceRegions = regions.fenceLines;
  unsupported.push(...regions.unsupported);

  // Claude Code strips block-level HTML comments before injecting instructions.
  // Remove them here too, while retaining visible text around an inline comment.
  // Code fences win: a comment marker inside a fence is code, so fenced lines
  // never enter the comment state machine.
  const visibleLines = lines.slice();
  const htmlCommentOnly = new Set();
  let inHtmlComment = false;
  let commentOpenedAt = -1;
  for (let i = frontmatterEnd; i < lines.length; i++) {
    if (fenceRegions.has(i)) continue;
    const raw = lines[i];

    let visible = "";
    let cursor = 0;
    let removedComment = inHtmlComment;
    while (cursor < raw.length) {
      if (inHtmlComment) {
        const end = raw.indexOf("-->", cursor);
        if (end === -1) {
          cursor = raw.length;
          break;
        }
        inHtmlComment = false;
        cursor = end + 3;
        continue;
      }
      const start = raw.indexOf("<!--", cursor);
      if (start === -1) {
        visible += raw.slice(cursor);
        break;
      }
      visible += raw.slice(cursor, start);
      removedComment = true;
      inHtmlComment = true;
      commentOpenedAt = i;
      cursor = start + 4;
    }
    visibleLines[i] = visible;
    if (!visible.trim() && (raw.trim() || removedComment)) htmlCommentOnly.add(i);
  }
  if (inHtmlComment) {
    unsupported.push({
      reason: "unclosed HTML comment — every line below it is stripped",
      startLine: commentOpenedAt + 1,
      endLine: lines.length,
    });
  }

  // <example>…</example>-style tag blocks hold worked-example content, not
  // rules — treat them like code fences. Only a tag alone on its line opens a
  // region, and an unclosed tag strips nothing.
  //
  // Any OTHER tag name gets the same exclusion — the host reads tag bodies as
  // plain text, so the rules inside a <critical> wrapper are live policy assay
  // is not grading — and that is exactly why it cannot happen silently: every
  // non-example block is disclosed as an unsupported construct, so the report
  // and CI say what was set aside instead of a clean audit hiding it.
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
      if (!/^examples?$/i.test(openTag)) {
        unsupported.push({
          reason: "<" + openTag + "> tag block — its body is set aside from rule extraction; " +
            "unwrap the rules, or fence the block with assay-ignore markers if that is meant",
          startLine: tagStart + 1,
          endLine: i + 1,
        });
      }
      openTag = null;
    }
  }

  // [Foreman: 060]
  // An author fences off narrative that reads like rules but commands nothing —
  // a motivating story, a pasted requirement, a tier definition — with a
  // <!-- assay-ignore-start --> / <!-- assay-ignore-end --> pair. Every line
  // between them, markers included, leaves the content stream like a code fence
  // and also leaves the F5 position denominator, so a real rule below the block
  // is not judged as buried by prose that isn't graded. A start with no end runs
  // to end of file, the same way an unclosed fence swallows the tail.
  const ignoreRegions = new Set();
  let inIgnore = false;
  for (let i = frontmatterEnd; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!inIgnore) {
      if (/^<!--\s*assay-ignore-start\s*-->$/.test(t)) { inIgnore = true; ignoreRegions.add(i); }
    } else {
      ignoreRegions.add(i);
      if (/^<!--\s*assay-ignore-end\s*-->$/.test(t)) inIgnore = false;
    }
  }

  // [Foreman: 069] A table's header row and its separator are layout, but its
  // body cells carry real directives — "Never commit secrets" in a Do/Don't
  // table is a rule like any other, and dropping the whole table dropped it from
  // grading entirely. Layout rows still leave the stream; body rows come back
  // cell by cell below, each keeping the row's own line number.
  // [Foreman: 073] Which rows are body rows is markdown-it's answer now, so a
  // GFM table with no leading pipe or an alignment row is recognized too.
  const tableRegions = regions.tableLines;
  const tableBodyRows = regions.tableBodyRows;

  for (let i = frontmatterEnd; i < lines.length; i++) {
    const lineNum = i + 1;
    if (fenceRegions.has(i) || tagRegions.has(i) || ignoreRegions.has(i)) continue;
    // [Foreman: 091] Quoted lines are inventoried as content, never graded.
    if (regions.quoteLines.has(i)) {
      result.push({ lineNum, text: "", isContent: false, isBlank: false, isHeading: false, raw: visibleLines[i].trim() });
      continue;
    }
    if (tableRegions.has(i)) {
      if (tableBodyRows.has(i)) {
        for (const cell of tableCells(visibleLines[i])) {
          result.push({ lineNum, text: cell, isContent: true, isBlank: false, isHeading: false, isTableCell: true, raw: cell });
        }
      }
      continue;
    }
    const control = lines[i].trim();
    const raw = visibleLines[i];
    const stripped = raw.trim();

    const catMatch = control.match(/^<!--\s*category:\s*(\w+)\s*-->$/);
    if (catMatch) { annotations[lineNum] = catMatch[1]; continue; }
    if (/^<!--\s*assay-ignore\s*-->$/.test(control)) { ignored.add(lineNum); continue; }

    if (regions.headings.has(i)) {
      // The visible line minus its markers is the heading text: an ATX line
      // still carries its "#"s for identifyChunks to shave, a setext line is
      // already bare, and either way an inline comment is gone.
      result.push({ lineNum, text: "", isContent: false, isBlank: false, isHeading: true, raw: stripped });
      continue;
    }
    if (regions.headingLines.has(i)) continue; // a setext underline
    if (regions.hrLines.has(i)) continue;
    if (!stripped) {
      result.push({ lineNum, text: "", isContent: false, isBlank: true, isHeading: false, raw: "" });
      continue;
    }
    if (BARE_LINK.test(stripped)) continue;
    result.push({ lineNum, text: stripped, isContent: true, isBlank: false, isHeading: false, raw });
  }

  // [Foreman: 060] lines fenced off as narrative — an assay-ignore span or a
  // <context>/<example> tag body — that leave the F5 position denominator, keyed
  // by 1-based line number to match a rule's lineStart
  const excluded = new Set();
  for (const i of ignoreRegions) excluded.add(i + 1);
  for (const i of tagRegions) excluded.add(i + 1);
  for (const i of htmlCommentOnly) excluded.add(i + 1);

  // [Foreman: 073] The inventory invariant: every physical line of the file
  // lands in exactly one class. `instruction` is filled in by scan() once it
  // knows which lines became graded rules; everything the parser can already
  // decide is decided here. Precedence runs unsupported > ignored > excluded >
  // content, so a line the adapter could not map is never counted as understood.
  const classes = new Array(lines.length).fill("content");
  for (const i of tagRegions) classes[i] = "excluded";
  for (const i of htmlCommentOnly) classes[i] = "excluded";
  for (const i of ignoreRegions) classes[i] = "ignored";
  for (const n of ignored) classes[n - 1] = "ignored";
  for (const u of unsupported) {
    for (let n = Math.max(1, u.startLine); n <= Math.min(lines.length, u.endLine); n++) classes[n - 1] = "unsupported";
  }

  return { lines: result, annotations, ignored, excluded, classes, unsupported };
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
    // [Foreman: 069] A recovered table cell is a chunk of its own: it neither
    // continues the paragraph above it nor merges with the cell beside it, and a
    // non-directive cell has to stay free to classify as prose on its own.
    if (line.isTableCell) {
      if (current) { chunks.push(current); current = null; }
      chunks.push({
        lineStart: line.lineNum, lineEnd: line.lineNum,
        text: line.text, isBullet: false, heading, headingLine,
      });
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
    sourceText: rule.sourceText || rule.text,
    sourceLineEnd: rule.sourceLineEnd || rule.lineEnd,
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

    // A verbless convention bullet needs its heading as judgment context, but
    // the source text must remain exact for clickable locations and rewrites.
    // Keep sibling bullets separate: they are separate policies and must not be
    // collapsed into one synthetic rule.
    if (isVerblessBullet(chunk) && chunk.heading) {
      merged.push([{
        ...chunk,
        text: chunk.heading + ": " + chunk.text,
        sourceText: chunk.text,
        sourceLineEnd: chunk.lineEnd,
      }, "rule"]);
      i++;
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
function leadingVerb(text) {
  const lower = text.toLowerCase().replace(/^[^a-z]+/, "");
  for (const t of VERB_TIERS) {
    if (!lower.startsWith(t.verb)) continue;
    const rest = lower.slice(t.verb.length);
    if (rest === "" || /^[\s,;.)!?]/.test(rest)) return t.verb;
  }
  return null;
}

function leadsWithImperativeVerb(text) {
  return leadingVerb(text) !== null;
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

  // [Foreman: 069] Two directive sentences in one paragraph are two policies,
  // and one grade covering both hides the weaker of them. Split only when every
  // sentence leads with an imperative verb — a clarification ("This means …")
  // stays attached to the rule it explains — and never when F2 reads the pair as
  // a prohibition beside the alternative that rescues it: that is one policy
  // said in two sentences, and splitting it would grade the ban as bare.
  const sentences = text.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
  if (sentences.length >= 2 && sentences.every(leadsWithImperativeVerb) &&
      scoreF2(text).category !== "prohibition_with_alternative") {
    return sentences.map(sub);
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
  // [Foreman: 091] A Windows-authored corpus writes `scripts\release.md`; a
  // backslash token is treated as a path only when its last segment carries an
  // extension, so `\d+` and other escape-shaped tokens never read as files.
  // razor: extension required — a bare `scripts\hooks` stays invisible; widen
  // when a real corpus shows the need.
  if (!name.includes("/") && /^[A-Za-z0-9_.-]+(\\[A-Za-z0-9_.-]+)+$/.test(name) &&
      /\.[A-Za-z0-9]+$/.test(name)) {
    name = name.replace(/\\/g, "/");
  }
  if (!name.includes("/")) return null;
  if (/[<>{}*$\s]|:\/\//.test(name)) return null;
  if (name.startsWith("/") || name.startsWith("~") || /^[A-Za-z]:/.test(name)) return null;
  // A quoted token is an illustration of a value, not a reference to a file —
  // `"./plugin-name"` in prose about manifests names a shape, and flagging it
  // as missing gates a build on an example.
  if (/["']/.test(name)) return null;
  // Same for a bare single-segment directory: `hooks/` says "the hooks folder"
  // wherever that lives, and only a path with at least two segments commits to
  // a checkable location.
  if (name.replace(/\/+$/, "").split("/").filter(Boolean).length < 2) return null;
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
  const rootRelative = t.startsWith("/");
  if (rootRelative) t = t.slice(1);
  if (!t) return null;
  if (!t.includes("/") && !/\.[a-zA-Z0-9]+$/.test(t)) return null; // bare word, not a path
  return { path: t, rootRelative };
}

function checkStaleness(text, root, findMoved, sourceFile = "") {
  const resolve = findMoved || makeBasenameResolver(root);
  const refs = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const p = backtickToPath(m[1]);
    if (p) refs.push({ ref: p, resolved: p });
  }
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = linkTargetToPath(m[1]);
    if (target) {
      const sourceDir = path.posix.dirname(sourceFile.split(path.sep).join("/"));
      const resolved = target.rootRelative
        ? target.path
        : path.posix.normalize(path.posix.join(sourceDir === "." ? "" : sourceDir, target.path));
      refs.push({ ref: target.path, resolved });
    }
  }
  // [Foreman: 097] `@path` imports are references too, and the loudest kind: the
  // host pulls the named file into the loaded set, so a dead one is a promise
  // the session cannot keep. The adapter owns resolving them for DISCOVERY; this
  // reads the same syntax so a dead import lands in the stale bucket beside every
  // other dead path instead of grading A. Only project-relative sources are
  // checked — a user-scope file's imports resolve outside this root.
  if (sourceFile && !path.isAbsolute(sourceFile) && !/^[A-Za-z]:/.test(sourceFile)) {
    const importDir = path.posix.dirname(sourceFile.split(path.sep).join("/"));
    for (const m of text.replace(/`[^`]*`/g, " ").matchAll(/(?:^|\s)@([A-Za-z0-9_.][A-Za-z0-9_./-]*)/g)) {
      const target = m[1].replace(/[.,;:)]+$/, "");
      // A bare token with no separator is a mention, not an import — the same
      // line the adapter draws.
      if (!target.includes("/")) continue;
      const resolved = path.posix.normalize(path.posix.join(importDir === "." ? "" : importDir, target));
      if (resolved.startsWith("..")) continue;
      refs.push({ ref: "@" + target, resolved });
    }
  }
  const missing = [];
  const seen = new Set();
  for (const item of refs) {
    const clean = item.resolved.replace(/\/+$/, "");
    if (seen.has(clean)) continue;
    seen.add(clean);
    if (fs.existsSync(path.join(root, clean))) continue;
    const moved = resolve(path.basename(clean)).filter((c) => c !== clean);
    // `resolved` is the project-relative path the check actually probed — the
    // shared key that lets the corpus analyzer group two rules citing one
    // dead target under different spellings.
    missing.push({ ref: item.ref.replace(/\/+$/, ""), resolved: clean, moved });
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
  // [Foreman: 075] A hedge governs the force of the whole sentence, downward,
  // however firm the rest of it sounds. "Always try to use functional components"
  // used to score 1.00: the always+imperative upgrade beat a weakest-hedge branch
  // that only ran on two hedges or more. One hedge is a hedge, so the weakest one
  // wins outright and no upgrade can climb back over it.
  const hedgingLabels = new Set(["hedged", "suggestion", "weak_suggestion", "preference"]);
  const hedges = matches.filter((m) => hedgingLabels.has(m.label));
  if (hedges.length) {
    const weakest = hedges.reduce((a, b) => (a.score <= b.score ? a : b));
    return { value: weakest.score, method: "lookup", matchedVerb: weakest.verb, hedged: true };
  }
  if (matches.some((m) => m.verb === "always")) {
    const imperative = matches.find((m) => m.verb !== "always" && m.label === "bare_imperative");
    if (imperative) return { value: 1.0, method: "lookup", matchedVerb: "always + " + imperative.verb };
  }
  const best = matches.reduce((a, b) => (a.score >= b.score ? a : b));
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

// Sentence boundary: a terminator, whitespace, then something that can open a
// new sentence (a capital, a code span, bold, or a quote).
const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z`*_"'])/;
const CLAUSE_SPLIT = /(?<=[.!?])\s+(?=[A-Z`*_"'])|[;—–]\s*|,\s+/;

function isProhibitionText(text) {
  const lower = text.toLowerCase();
  // "must not" is deontic — it never appears in a factual negation — so it
  // counts as a prohibition anywhere, even after a subject ("tests must not X").
  return PROHIBITION_CLAUSE_RE.test(lower) || lower.includes("must not ");
}

// [Foreman: 069]
// Content words of a clause, for deciding whether one clause is about the same
// thing as another: case-folded, plural/participle endings shaved off, and the
// words that carry no topic — stopwords and the imperative verb vocabulary —
// dropped. Deliberately crude; it only ever answers "same subject matter?".
function contentTokens(text) {
  const tokens = new Set();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9_-]*/g) || []) {
    if (w.length < 2 || RULE_KEYWORD_STOPWORDS.has(w) || ALL_VERBS.has(w)) continue;
    tokens.add(w.replace(/(?:ies|es|s)$/, "").replace(/(?:ing|ed)$/, ""));
  }
  return tokens;
}

// [Foreman: 069]
// A prohibition is only rescued by an alternative that plausibly replaces the
// banned thing. Three deterministic signals: the alternative points back at the
// ban ("instead", "rather than"), it names something the ban named, or it
// performs the very action the ban forbade on a different object ("Never use
// `var`." / "Use `const` for locals."). An unrelated directive standing next to
// a prohibition leaves it exactly as bare as no directive at all.
function resolvesProhibition(banned, alternative) {
  const alt = alternative.toLowerCase();
  if (ALTERNATIVE_MARKERS.some((m) => alt.includes(m.trim()))) return true;
  const bannedLower = banned.toLowerCase();
  const bannedTokens = contentTokens(bannedLower);
  for (const t of contentTokens(alt)) {
    if (bannedTokens.has(t)) return true;
  }
  const verb = leadingVerb(alternative);
  return verb !== null && new RegExp("\\b" + escapeRe(verb) + "\\b").test(bannedLower);
}

function scoreF2(text) {
  const lower = text.toLowerCase();
  const isProhibition = isProhibitionText(text);
  const isHedged = HEDGED_MARKERS.some((p) => lower.includes(p));
  const hasAlternative = ALTERNATIVE_MARKERS.some((p) => lower.includes(p)) || hasContrastNot(text);

  if (isProhibition) {
    // Prohibition + named alternative is the strongest framing; a prohibition
    // without one converts blocked tasks into stalls, not compliance.
    const clauses = text.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);
    const banned = clauses.find(isProhibitionText) || text;
    const rescued = clauses.some((c) => c !== banned && hasPositiveImperative(c) && resolvesProhibition(banned, c));
    if (hasAlternative || rescued) {
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

// [Foreman: 069] "TypeScript files" and paths: ["**/*.ts", "**/*.tsx"] scope the
// same rule, but F4 compared the two spellings and called it a mismatch. Both
// directions of this table are folded into the glob keywords before comparing —
// nothing fuzzier: a language not listed here still has to match literally.
const LANGUAGE_EXTENSIONS = {
  typescript: ["ts", "tsx"],
  javascript: ["js", "jsx", "mjs", "cjs"],
  python: ["py"],
  ruby: ["rb"],
  rust: ["rs"],
  golang: ["go"],
  java: ["java"],
  kotlin: ["kt", "kts"],
  markdown: ["md"],
  shell: ["sh", "bash"],
};
const EXTENSION_LANGUAGES = new Map();
for (const [lang, exts] of Object.entries(LANGUAGE_EXTENSIONS)) {
  for (const ext of exts) EXTENSION_LANGUAGES.set(ext, lang);
}

function expandLanguageTerms(terms) {
  const out = new Set(terms);
  for (const t of terms) {
    for (const ext of LANGUAGE_EXTENSIONS[t] || []) out.add(ext);
    const lang = EXTENSION_LANGUAGES.get(t);
    if (lang) out.add(lang);
  }
  return out;
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
    const globKeywords = expandLanguageTerms(extractGlobKeywords(globs));
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

// [Foreman: 069] Backticks alone are not specificity. `src/api/handler.ts`,
// `npm test`, `CreateUserSchema` and `--force` each name something a reader can
// check; `code`, `it` and `file` name nothing, so a lone generic word in
// backticks no longer clears the concreteness bar by itself. Anything carrying a
// non-letter (path, command, flag, extension, digit) or an uppercase letter
// (camelCase, PascalCase) still counts, as do all the other concrete signals.
const GENERIC_BACKTICK_WORDS = new Set([
  "code", "it", "them", "here", "there", "thing", "things", "stuff", "file",
  "files", "folder", "folders", "name", "names", "value", "values", "data",
  "text", "item", "items", "one", "good", "bad", "ok", "yes", "etc",
]);

function isConcreteBacktick(span) {
  const s = span.trim();
  if (!s) return false;
  if (/[^A-Za-z]/.test(s)) return true;
  if (/[A-Z]/.test(s)) return true;
  const lower = s.toLowerCase();
  return !GENERIC_BACKTICK_WORDS.has(lower) && !RULE_KEYWORD_STOPWORDS.has(lower);
}

function scoreF7(text) {
  const markers = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    if (isConcreteBacktick(m[1])) markers.push(m[1]);
  }
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
  return Math.min(1, x / THRESHOLDS.softFloor);
}

function composeScore(factors, stale) {
  // factors: { F1..F7 } as plain numbers in [0,1]; F1 null falls back to 0.5
  const values = { ...factors };
  if (values.F1 == null) values.F1 = 0.5;
  if (values.F5 == null) values.F5 = 0.95;
  // [Foreman: 071] Renormalization. A factor nobody measured — F3 on a
  // deterministic-only run, where no model judged the trigger — drops out of the
  // numerator AND the denominator, so the composite stays a weighted mean over
  // the factors that actually have evidence:
  //
  //     score = ( Σ wᵢ·vᵢ  over present i ) / ( Σ wᵢ  over present i ) × floor
  //
  // With every factor present the denominator is the full weight sum (8.3) and
  // the number is what it always was. Dropping the weight rather than substituting
  // a default is what keeps the missing factor honest: a default would be a
  // score assay invented, and the whole point of the mode is that it invents
  // nothing. Consequence, accepted: a deterministic-only score is NOT comparable
  // to a model-judged one — it is a mean over a different factor set.
  let linear = 0, weighted = 0;
  for (const [name, weight] of Object.entries(WEIGHTS)) {
    if (values[name] == null) continue;
    linear += weight * values[name];
    weighted += weight;
  }
  linear = weighted ? linear / weighted : 0;
  const floor = Math.min(softFloor(values.F7), softFloor(values.F4), stale ? STALENESS_MULTIPLIER : 1);
  const score = linear * floor;

  let dominant = null, dominantGap = -1;
  for (const [name, weight] of Object.entries(WEIGHTS)) {
    if (values[name] == null) continue;
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
      if (s.f8BelowThreshold !== undefined) hit = f8 != null && f8 < THRESHOLDS[s.f8BelowThreshold];
      else if (s.anyPattern) hit = s.anyPattern.some((p) => p.test(ruleText));
      else if (s.pointerShape) hit = countActionVerbs(ruleText) <= 1 && (/\.md\b/.test(ruleText) || /`[^`]*\/[^`]*`/.test(ruleText));
      else hit = s.pattern.test(ruleText);
      if (hit) { confidence += s.weight; evidence.push(s.name); }
    }
    confidence = Math.min(1, round3(confidence));
    if (evidence.length) detections[primitive] = { confidence, evidence };
  }

  const candidates = Object.entries(detections).filter(([, d]) => d.confidence >= THRESHOLDS.placementCandidate);
  const firing = Object.entries(detections).filter(([, d]) => d.confidence >= THRESHOLDS.placementCompound);
  const compound = firing.length >= 2 && COMPOUND_CONJUNCTION.test(ruleText);

  if (!candidates.length && !compound) return null;
  let bestFit = compound ? "compound" : null;
  if (!bestFit) bestFit = candidates.reduce((a, b) => (a[1].confidence >= b[1].confidence ? a : b))[0];
  // [Foreman: 076] Null unless hook signals fired AND the wording names a
  // lifecycle moment — see HOOK_EVENT_SIGNALS.
  const hookEvent = detections.hook ? inferHookEvent(ruleText) : null;
  return { bestFit, detections, compound, hookEvent };
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

// [Foreman: 073]
// Exact positions, carried beside the line numbers rather than instead of them.
// Offsets are character indexes into the file as read, so
// `content.slice(startOffset, endOffset)` returns the rule's own source text
// whenever that text survives verbatim on one line; a rule assembled from
// several lines spans from its first non-blank column to the end of its last
// line. Columns are 0-based within their line, lines are 1-based to match
// lineStart / lineEnd.
// razor: character offsets, not byte offsets. Every file is read as UTF-8 and
// the two agree for ASCII; a byte-true range under another encoding waits for
// the file to be read as a Buffer, which nothing needs yet.
function lineOffsets(lines) {
  const offsets = new Array(lines.length);
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = at;
    at += lines[i].length + 1;
  }
  return offsets;
}

function sourceRange(lines, offsets, startLine, endLine, text) {
  const first = lines[startLine - 1] || "";
  const last = lines[endLine - 1] || "";
  let startCol = first.length - first.trimStart().length;
  let endCol = last.length;
  if (startLine === endLine) {
    const at = first.indexOf(text);
    if (at !== -1) { startCol = at; endCol = at + text.length; }
  }
  return {
    startLine, startCol, endLine, endCol,
    startOffset: (offsets[startLine - 1] || 0) + startCol,
    endOffset: (offsets[endLine - 1] || 0) + endCol,
  };
}

// [Foreman: 074] `options.adapter` is the seam: scan does not know it is looking
// at Claude Code, only that something handed it sources, skills, agents and
// hooks. `userDir` / `projectOnly` / `probeHost` are passed straight through to
// the adapter's own context detection.
function scan(root, options = {}) {
  const adapter = options.adapter || claudeAdapter;
  const context = adapter.detectContext({
    root,
    userDir: options.userDir,
    // [Foreman: 079] Passed through untouched: whether the startup directory can
    // differ from the project root at all is the adapter's question, and the
    // Codex profile is the one that answers yes.
    startup: options.startup,
    projectOnly: options.projectOnly === true,
    probeHost: options.probeHost === true,
    ancestorStop: options.ancestorStop,
  });
  // [Foreman: 097] Not an adapter question: WHERE the root came from is the CLI's
  // decision, and it rides the context so the report can say so rather than
  // leaving the reader to wonder which directory was audited.
  if (options.rootFoundFrom) context.rootFoundFrom = options.rootFoundFrom;
  const discovered = adapter.discoverSources(context);
  const inaccessible = [...(discovered.inaccessible || [])];
  const files = readSources(discovered.sources, context.projectRoot, inaccessible, adapter, context);
  const skillsFound = adapter.discoverSkills(context);
  const rules = [];
  const sources = [];
  let counter = 0;
  let proseChunks = 0, excludedLines = 0;
  const findMoved = makeBasenameResolver(root);

  files.forEach((file, fileIndex) => {
    const { lines, annotations, ignored, excluded, classes, unsupported } = stripMetadata(file.content);
    const chunks = identifyChunks(lines);
    const merged = mergeClarifications(chunks);
    const rawLines = file.content.split("\n");
    const offsets = lineOffsets(rawLines);

    // [Foreman: 062] Narrative share = the fraction of graded content that reads
    // as prose rather than a rule. A file that is mostly motivating narrative is
    // a restructure candidate, not a per-rule-rewrite one. Blank lines, headings,
    // fences, and fenced-off spans never enter identifyChunks, so this ratio is
    // over the graded corpus alone — the same population F5 and the grade see.
    let proseLines = 0, ruleLines = 0;
    for (const [chunk, cls] of merged) {
      const span = chunk.lineEnd - chunk.lineStart + 1;
      if (cls === "rule") ruleLines += span; else { proseLines += span; proseChunks++; }
    }
    excludedLines += excluded.size;
    const gradedLines = proseLines + ruleLines;
    file.narrativeShare = gradedLines ? round3(proseLines / gradedLines) : null;

    // [Foreman: 060] F5 measures how far down the *graded* content a rule sits,
    // so narrative fenced off above it must not push it toward the bottom. Both
    // the denominator and each rule's position drop the excluded lines.
    const excludedSorted = [...excluded].sort((a, b) => a - b);
    const f5File = { lineCount: file.lineCount - excluded.size };
    const effectivePosition = (lineStart) => lineStart - excludedSorted.filter((n) => n < lineStart).length;

    for (const [chunk, cls] of merged) {
      if (cls !== "rule") continue;
      for (const part of splitCompound(chunk)) {
        // an <!-- assay-ignore --> comment on either of the two lines above skips the rule
        if (ignored.has(part.lineStart - 1) || ignored.has(part.lineStart - 2)) continue;
        counter++;
        let category = file.defaultCategory;
        let categoryLine = null;
        for (let ln = part.lineStart - 2; ln < part.lineStart; ln++) {
          if (annotations[ln]) { category = annotations[ln]; categoryLine = ln; }
        }
        // [Foreman: 069] A misspelled category annotation used to pass silently
        // and take the rule out of every category-keyed count with it — the
        // corpus grade averages mandates only. The rule stays graded under its
        // file's default; the bad annotation is reported instead of swallowed.
        let invalidCategory = null;
        if (!(category in CATEGORY_FLOORS)) {
          invalidCategory = { value: category, line: categoryLine || part.lineStart };
          category = file.defaultCategory in CATEGORY_FLOORS ? file.defaultCategory : "mandate";
        }
        const effectiveText = part.text;
        const sourceText = part.sourceText || effectiveText;
        const staleness = checkStaleness(effectiveText, root, findMoved, file.path);
        const f1 = scoreF1(effectiveText);
        const lineEnd = part.sourceLineEnd || part.lineEnd;
        // [Foreman: 073] Every line this rule occupies leaves the `content`
        // class for `instruction` — that reclassification is what makes the
        // inventory's span counts add up to the file.
        for (let n = part.lineStart; n <= lineEnd; n++) {
          if (classes[n - 1] === "content") classes[n - 1] = "instruction";
        }
        const rule = {
          id: "R" + String(counter).padStart(3, "0"),
          key: ruleKey(file.path, effectiveText),
          fileIndex,
          file: file.path,
          text: sourceText,
          contextText: effectiveText,
          lineStart: part.lineStart,
          lineEnd,
          sourceRange: sourceRange(rawLines, offsets, part.lineStart, lineEnd, sourceText),
          category,
          invalidCategory,
          staleness,
          // [Foreman: 084] Which language rubric this rule is read under. Set
          // in scan because it is a property of the text, like staleness.
          languageMode: detectLanguageMode(effectiveText),
          factors: {
            F1: f1,
            F2: scoreF2(effectiveText),
            F4: scoreF4({ text: effectiveText, staleness }, file),
            F5: scoreF5(effectivePosition(part.lineStart), f5File),
            F7: scoreF7(effectiveText),
          },
        };
        rules.push(rule);
      }
    }

    // [Foreman: 073] The lossless inventory: one entry per parsed file, whose
    // span counts sum to its line count by construction. Nothing the parser saw
    // is missing from it — a line is instruction, ordinary content, explicitly
    // ignored, excluded from grading, or named as unsupported.
    const spans = { instruction: 0, content: 0, ignored: 0, excluded: 0, unsupported: 0 };
    for (const cls of classes) spans[cls]++;
    sources.push({
      path: file.path,
      // [Foreman: 074] how the host loads this file, straight from the adapter
      scope: file.scope,
      kind: file.kind,
      precedence: file.precedence,
      selectionReason: file.selectionReason,
      // [Foreman: 076] what the host actually loads every session, and how much
      // of the window it costs — the two inputs the context-pressure line needs
      alwaysLoaded: file.alwaysLoaded === true,
      // [Foreman: 090] how this file entered the loaded set, when not directly
      ...(file.nested ? { nested: true } : {}),
      ...(file.imported ? { imported: true } : {}),
      // [ADR 2026-08-05 B1/B2] the auto-memory labels ride the inventory so the
      // record shows the surface and its documented read cap, not just its bytes
      ...(file.autoMemory ? { autoMemory: true } : {}),
      ...(file.docCap ? { docCap: file.docCap } : {}),
      ...(Number.isInteger(file.docCapLine) ? { docCapLine: file.docCapLine } : {}),
      bytes: Buffer.byteLength(file.content, "utf-8"),
      sourceHash: hashContent(file.content),
      lineCount: file.lineCount,
      spans,
      unsupported,
    });
  });

  // [Foreman: 076] Two scoped rules files that both claim the same project file.
  // Computed here because the glob resolution lives here; bare overlap is normal,
  // so the finding that reads this stays silent until the two files also share a
  // duplicate or a conflict.
  const scopeOverlaps = [];
  const scoped = files.filter((f) => (f.globMatched || []).length);
  for (let i = 0; i < scoped.length; i++) {
    for (let j = i + 1; j < scoped.length; j++) {
      const other = new Set(scoped[j].globMatched);
      const shared = scoped[i].globMatched.filter((p) => other.has(p)).length;
      if (shared) {
        scopeOverlaps.push({
          a: scoped[i].path, b: scoped[j].path,
          globs: { a: scoped[i].globs, b: scoped[j].globs },
          shared,
        });
      }
    }
  }

  // [Foreman: 079] What the host documents as a hard limit on how much of this
  // it will read, and what the profile must disclose about its own coverage.
  // Both are emitted only when the adapter supplies them, so a profile that
  // documents neither produces exactly the record it produced before.
  const budget = adapter.budgets ? (adapter.budgets(context) || {}).documented : null;
  // [Foreman: 080] The host's second documented budget, if it publishes one: what
  // the initial skill LIST costs before any skill is selected. Separate from the
  // instruction cap because it is a different pool spent on different content.
  const skillBudget = adapter.budgets ? (adapter.budgets(context) || {}).skillListing : null;
  // [Foreman: 097] The adapter is handed what was actually discovered, so a note
  // about a surface this project does not have never prints.
  const profileNotes = adapter.coverageNotes
    ? adapter.coverageNotes({ sources: files, projectRoot: context.projectRoot, userDir: context.userDir })
    : [];

  // [Foreman: 080] An adapter may return its hooks bare, or paired with the hook
  // configuration it found and could not read. The second form exists because a
  // hook layer that exists and will not parse is a hole in the ladder, and the
  // ladder already has one place that names holes — the repository checks'
  // `inaccessible` list, which prints "any gate there is missing from this
  // ladder". Nothing changes for an adapter that returns the bare array.
  const hooksFound = adapter.discoverHooks(context);
  const hookInventory = Array.isArray(hooksFound) ? hooksFound : hooksFound.hooks || [];
  // [Foreman: 169] Every output style on disk, and which one the settings chain
  // selects. The ACTIVE one is already a graded source - the adapter put it in
  // `sources` - so this is the inventory around it: the styles one `/config`
  // away, and the case where the setting names a style nothing answers to. A
  // profile that has no such surface returns nothing and nothing prints.
  const outputStyles = adapter.discoverOutputStyles ? adapter.discoverOutputStyles(context) : null;
  const hookIssues = Array.isArray(hooksFound) ? [] : hooksFound.inaccessible || [];
  const repoChecks = adapter.discoverRepoChecks ? adapter.discoverRepoChecks(context) : { checks: [], inaccessible: [] };
  if (hookIssues.length) {
    repoChecks.inaccessible = [...(repoChecks.inaccessible || []), ...hookIssues];
  }

  const policy = adapter.policy ? { ...DEFAULT_POLICY, ...adapter.policy } : DEFAULT_POLICY;

  // [Foreman: 080] A user-scope skill is counted and named, never graded — but
  // where the host publishes a collective listing budget it still SPENDS from
  // it, so its listing cost travels with it. No budget, no extra keys.
  const userSkills = (skillsFound.user || []).map((s) => {
    const facts = skillFacts(s.absPath, s.name);
    return {
      name: s.name,
      hasDescription: facts.hasDescription,
      ...(skillBudget ? { scope: s.scope, listingChars: facts.listingChars } : {}),
    };
  });

  return {
    root: context.projectRoot,
    context,
    // [Foreman: 079] The profile that produced this record, including the
    // analyses it declares out of scope for itself.
    profile: {
      host: adapter.name,
      version: adapter.profileVersion,
      ...(adapter.policy ? { policy: adapter.policy } : {}),
      // [Foreman: 080] The mechanism nouns this profile's advice uses, when it
      // declares any. A profile that declares none keeps the record it had.
      ...(adapter.nouns ? { nouns: adapter.nouns } : {}),
      // [Foreman: 082] Where this host lets a new rule, skill or hook be
      // written. Discovery answers where existing sources are; this answers
      // where a new one may go, which no discovery of an absent file can.
      ...(adapter.targets ? { targets: adapter.targets } : {}),
    },
    files: files.map(({ content, absPath, globMatched, ...rest }) => rest),
    sources,
    scopeOverlaps,
    rules,
    skills: readSkills(skillsFound.project || [], policy),
    hookInventory,
    ...(outputStyles ? { outputStyles } : {}),
    // [Foreman: 077] Levels 4 and 5 of the ladder, as the adapter found them.
    // Raw discovery, like hookInventory: `mechanisms` is derived from it.
    repoChecks,
    // [Foreman: 070] What the audit did and did not look at. The report prints
    // this so a number is never read as covering more than it measured.
    coverage: {
      filesDiscovered: files.length + inaccessible.length,
      filesParsed: files.length,
      inaccessible,
      proseChunks,
      excludedLines,
      // [Foreman: 074] Surfaces the audit saw but did not grade. User files are
      // graded, but under their own heading and outside the project grade, so
      // the marker says which corpus the numbers above cover.
      userFilesIncluded: files.some((f) => f.scope === "user"),
      userSkills,
      // [Foreman: 091] Subagent descriptions are routing triggers, graded on
      // the same recipe as a model-invocable skill description.
      agents: gradeAgents(adapter.discoverAgents(context)),
      ...(budget ? { budget } : {}),
      ...(skillBudget ? { skillBudget } : {}),
      ...(profileNotes.length ? { profileNotes } : {}),
    },
  };
}

// [Foreman: 091] A subagent's frontmatter description decides when the model
// reaches for it — the skill trigger recipe applies verbatim. A file that will
// not read or parse keeps its name and carries the issue instead of a verdict.
function gradeAgents(found) {
  return (found || []).map((a) => {
    if (typeof a === "string") return { name: a, path: ".claude/agents/" + a + ".md", checks: null };
    let fm;
    try {
      fm = parseFrontmatter(fs.readFileSync(a.absPath, "utf-8"));
    } catch (err) {
      return { name: a.name, path: a.path, checks: null, issue: err.code || String(err.message).split("\n")[0] };
    }
    const description = typeof fm.description === "string" ? fm.description.trim() : "";
    return {
      name: typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : a.name,
      path: a.path,
      description,
      checks: description
        ? { mode: "model", ...checkSkillDescription(description), hasWhenToUse: false }
        : { mode: "model", missing: ["description"], redundant: false, length: 0, overCap: false, quotedPhrases: 0, hasWhenToUse: false },
    };
  });
}

// Inventory-grade facts about a skill nobody grades: does it declare a
// description at all, and what does its listing entry cost. One read for both.
// User skills are counted and named, never scored — see the adapter.
function skillFacts(absPath, fallbackName) {
  try {
    const fm = parseFrontmatter(fs.readFileSync(absPath, "utf-8"));
    const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : fallbackName || "";
    const description = typeof fm.description === "string" ? fm.description.trim() : "";
    return { hasDescription: description.length > 0, listingChars: name.length + description.length };
  } catch {
    return { hasDescription: false, listingChars: 0 };
  }
}

// [Foreman: 097]
// An interrupted or unvalidated fix used to be invisible to every command except
// `clean`, at the end of the NEXT audit — whose report was computed from the
// half-written files without saying so. Every command that reads the working
// tree says it first, on stderr, so no stdout contract moves.
function warnOpenChanges(root) {
  let rows;
  try {
    rows = readJournal(root);
  } catch {
    return; // a damaged journal is the transaction commands' problem to report
  }
  const open = openChangeIds(rows);
  if (!open.length) return;
  const state = replayJournal(rows);
  const files = [...new Set(open.flatMap((id) =>
    changeWrites(state.get(id)).filter((w) => !w.restored).map((w) => w.path)))];
  process.stderr.write(
    "Note: an earlier fix is still open. " + files.join(", ") + " " +
    (files.length === 1 ? "was" : "were") + " written and neither checked nor undone, " +
    "so what follows reads " + (files.length === 1 ? "it" : "them") + " as they are now.\n" +
    "  Finish with `assay.js validate --change <id>`, or undo with `assay.js rollback --change <id>`: " +
    open.join(", ") + "\n");
}

function cmdScan(root, opts = {}) {
  // `--startup` names the directory the session is modeled as beginning in. The
  // Codex profile reads a chain from the root down to it; the default stays the
  // root, so an invocation without the flag is unchanged.
  const result = scan(root, {
    projectOnly: opts.projectOnly, probeHost: true, adapter: opts.adapter, startup: opts.startup,
    rootFoundFrom: opts.rootFoundFrom,
  });
  requireStartupHonored(opts, result.context);
  warnOpenChanges(root);
  const tmpDir = path.join(root, TMP_DIR);
  fs.mkdirSync(tmpDir, { recursive: true });
  // [Foreman: 097] The directory is disposable by contract, so it excludes
  // itself. The first run on a project used to leave it in the working tree for
  // the user to notice and delete.
  const ignore = path.join(tmpDir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  writeRecord(path.join(tmpDir, "scan.json"), "scan", result, root);

  const summary = {
    ruleCount: result.rules.length,
    skillCount: result.skills.length,
    fileCount: result.files.length,
    files: result.files.map((f) => f.path),
    scanFile: TMP_DIR + "/scan.json",
    judgmentsFile: TMP_DIR + "/judgments.json",
    hookInventory: result.hookInventory,
    ...(result.outputStyles ? { outputStyles: result.outputStyles } : {}),
    judge: result.rules.map((r) => ({
      id: r.id,
      key: r.key,
      text: r.text,
      context: r.contextText !== r.text ? r.contextText : undefined,
      needsF1: r.factors.F1.method === "extraction_failed",
      // [Foreman: 097] Where the entry came from. The verification pass asks "is
      // this a rule at all", and the decisive signal — this line is a note the
      // host wrote about the project, not an instruction to follow — was stripped
      // out of the payload, leaving the model to hand-score them from text alone.
      file: r.file,
      scope: (result.files[r.fileIndex] || {}).scope,
      ...((result.files[r.fileIndex] || {}).autoMemory ? { autoMemory: true } : {}),
    })),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

// [Foreman: 071]
// { judgments } when the file is there and valid, { judgments: null } when there
// is no file at all — the deterministic default, not a failure — and { error }
// when a file that DOES exist cannot be trusted. The third case stays fatal:
// running without judgments is a mode, running with broken ones is a mistake.
// How many rules an error names before it points at the whole list. Past this a
// wall of ids is not information.
const JUDGMENT_ERROR_CAP = 5;

function loadJudgments(root, rules) {
  const file = path.join(root, TMP_DIR, "judgments.json");
  if (!fs.existsSync(file)) return { judgments: null };
  let judgments;
  try {
    judgments = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    return { error: TMP_DIR + "/judgments.json is not valid JSON: " + err.message };
  }
  const problems = [];
  // [Foreman: 071] `_provenance` is the one top-level key that is not a rule
  // judgment. Per-key validation iterates the RULES, so it never reaches this
  // key by construction; its own shape is checked loosely here — every field is
  // optional, and only a wrong type is an error.
  const prov = judgments._provenance;
  if (prov !== undefined) {
    if (!isRecordObject(prov)) problems.push("_provenance (not an object)");
    else {
      for (const k of ["model", "promptVersion", "judgedAt", "pass"]) {
        if (prov[k] !== undefined && typeof prov[k] !== "string") problems.push("_provenance." + k);
      }
    }
  }
  // [Foreman: 076] `_candidates` is the second non-rule top-level key: the
  // semantic pass's proposals. Types are checked loosely — a proposal is prose
  // the model wrote — but an unrecognized `kind` is fatal, because a kind
  // nothing renders would be a proposal that silently disappeared.
  const candidates = judgments._candidates;
  if (candidates !== undefined) {
    if (!Array.isArray(candidates)) problems.push("_candidates (not an array)");
    else candidates.forEach((c, i) => {
      const at = "_candidates[" + i + "]";
      if (!isRecordObject(c)) return problems.push(at + " (not an object)");
      if (!SEMANTIC_CANDIDATE_KINDS.includes(c.kind)) {
        problems.push(at + ".kind (unknown kind: " + c.kind + ")");
      }
      if (!Array.isArray(c.keys) || !c.keys.every((k) => typeof k === "string")) problems.push(at + ".keys");
      for (const k of ["summary", "reason"]) {
        if (c[k] !== undefined && typeof c[k] !== "string") problems.push(at + "." + k);
      }
      if (c.accepted !== undefined && c.accepted !== null && typeof c.accepted !== "boolean") {
        problems.push(at + ".accepted");
      }
    });
  }
  // [Foreman: 097] Grouped by cause and carrying each rule's own address. The
  // message was one 1,956-character line of `R###=<hash>` pairs with three
  // different causes merged into one sentence and no way to act on any of them.
  const unjudged = [];
  const outOfRange = [];
  for (const rule of rules) {
    // [Foreman: 059] keyed by the stable content hash, not the R### display id
    const label = rule.id + "=" + rule.key;
    const j = judgments[rule.key];
    if (!j || typeof j.F3 !== "number" || typeof j.F8 !== "number") {
      unjudged.push(rule);
      problems.push(label);
      continue;
    }
    for (const k of ["F3", "F8", "F1"]) {
      if (j[k] !== undefined && (typeof j[k] !== "number" || j[k] < 0 || j[k] > 1)) {
        outOfRange.push({ rule, field: k, value: j[k] });
        problems.push(label + "." + k);
      }
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
    const at = (r) => r.file + ":" + r.lineStart;
    const lines = [TMP_DIR + "/judgments.json cannot be used, so nothing was composed from it."];
    const shape = problems.filter((p) => p.startsWith("_"));
    if (unjudged.length) {
      lines.push(`  ${unjudged.length} rule(s) carry no F3 and F8 pair:`);
      for (const r of unjudged.slice(0, JUDGMENT_ERROR_CAP)) {
        lines.push(`    ${r.id}  ${at(r)}  "${truncate(r.text, 60)}"  key ${r.key}`);
      }
      if (unjudged.length > JUDGMENT_ERROR_CAP) lines.push(`    …and ${unjudged.length - JUDGMENT_ERROR_CAP} more`);
    }
    if (outOfRange.length) {
      lines.push(`  ${outOfRange.length} value(s) outside the 0–1 range:`);
      for (const p of outOfRange.slice(0, JUDGMENT_ERROR_CAP)) {
        lines.push(`    ${p.rule.id}  ${at(p.rule)}  ${p.field} = ${JSON.stringify(p.value)}`);
      }
      if (outOfRange.length > JUDGMENT_ERROR_CAP) lines.push(`    …and ${outOfRange.length - JUDGMENT_ERROR_CAP} more`);
    }
    const notRule = problems.filter((p) => p.endsWith(".notRule"));
    if (notRule.length) {
      lines.push(`  ${notRule.length} suppression(s) carry no reason — a \`notRule\` entry needs the words for why it is not a rule.`);
    }
    if (shape.length) lines.push("  malformed top-level entries: " + shape.join(", "));
    lines.push("  Judge the rules named above and merge them in, keyed by the `key` shown —");
    lines.push("  or delete " + TMP_DIR + "/judgments.json to fall back to the report that needs no model.");
    return { error: lines.join("\n") };
  }
  return { judgments };
}

// [Foreman: 071] `judgments` null (or simply missing this rule's key) is the
// deterministic mode, not an error: F3 and F8 stay null, the score renormalizes
// over the factors that were measured, and every derivation that reads a model
// judgment declines to fire. The model layer is additive on top of this, never a
// precondition for it.
// [Foreman: 140] `opts.semantic` is the only thing the third argument carries
// today. It is opt-in because what it adds is proposals, not findings, and a
// default run must stay identical to the byte.
function composeAudit(scanData, judgments, opts = {}) {
  const deterministic = judgments == null;
  // [Foreman: 079] A profile that declines the wording rubric declines the score
  // it sums to. The factor VALUES are still measured and still travel in the
  // record — they are inventory, and F1's extraction and F2's stall risk feed
  // host-neutral findings — but nothing composed from their weights is presented
  // as a judgment about this profile's sources. SCOPE.md: a hygiene score is
  // retained "for one host profile", never inherited by a second without its own
  // evidence.
  const graded = profilePolicy(scanData).wordingRubric;
  let judged = 0;
  const rules = scanData.rules.map((r) => {
    // [Foreman: 059] keyed by the stable content hash; r.key falls back to r.id
    // so a hand-written scanData without keys still composes
    const j = (judgments && judgments[r.key || r.id]) || {};
    if (typeof j.F3 === "number") judged++;
    const factors = {
      // F1 extraction can fail (value null); fall back to the same 0.5 the
      // composer uses, so the stored value is never null for the report to render
      F1: j.F1 !== undefined ? j.F1 : (r.factors.F1.value != null ? r.factors.F1.value : 0.5),
      F2: r.factors.F2.value,
      // The two model-judged factors. Null when nothing judged them — the
      // composer drops their weight rather than inventing a value.
      F3: j.F3 !== undefined ? j.F3 : null,
      F4: r.factors.F4.value,
      F5: r.factors.F5 ? r.factors.F5.value : 0.95,
      F7: r.factors.F7.value,
    };
    const f8 = j.F8 !== undefined ? j.F8 : null;
    const composed = composeScore(factors, r.staleness.gated);
    const stallRisk = r.factors.F2.stallRisk === true;
    const score = stallRisk ? Math.min(composed.score, STALL_RISK_CAP) : composed.score;
    const placement = detectPlacement(r.contextText || r.text, f8);
    const notRule = typeof j.notRule === "string" && j.notRule.trim() ? j.notRule.trim() : null;
    // [Foreman: 084] The one place an unsupported language withdraws English
    // scoring. The factor VALUES stay in the record — they are inventory, and a
    // reader can see what the English tables made of a sentence they never
    // covered — but nothing composed from them is presented as a judgment, and
    // the rule leaves the populations the file and corpus grades average over.
    // Every English PATTERN dies with them: the stall-risk cap and the
    // placement signals are English regexes, so firing either on this text
    // would be the same misread wearing a different name.
    const english = englishScored(r);
    return {
      ...r,
      factorValues: factors,
      f8,
      ...composed,
      score: graded && english ? score : null,
      grade: graded && english ? grade(score) : null,
      stallRisk: english && stallRisk,
      hookOpportunity: f8 != null && f8 < THRESHOLDS.f8Hook,
      placement: english ? placement : null,
      weak: graded && english && score < (CATEGORY_FLOORS[r.category] ?? CATEGORY_FLOORS.mandate),
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
    // [Foreman: 084] A rule the rubric could not read carries no score, so it
    // cannot drag the file's mean the way a misread English sentence would. It
    // is still counted as a rule — inventory is not scoring.
    const scored = own.filter((r) => r.score !== null);
    const mean = graded && scored.length ? scored.reduce((s, r) => s + r.score, 0) / scored.length : null;
    return { ...f, ruleCount: own.length, score: mean === null ? null : round3(mean), grade: mean === null ? null : grade(mean) };
  });

  // [Foreman: 074] The corpus grade is the PROJECT's grade. A user-scope file is
  // graded and shown, but it belongs to the machine, not the repo — folding it in
  // would move a number the project's own authors cannot fix.
  // [Foreman: 076] A shadowed file's rules never take effect, so grading the
  // project on them would score policy the host never reads.
  // [Foreman: 084] A rule under an unsupported language mode has no score to
  // average, for the same reason: the rubric never read it.
  const mandates = !graded ? [] : counted.filter((r) => r.category === "mandate" && r.score !== null &&
    (files[r.fileIndex] || {}).scope !== "user" && (files[r.fileIndex] || {}).scope !== "ancestor" &&
    (files[r.fileIndex] || {}).selected !== false);
  const corpus = mandates.length ? round3(mandates.reduce((s, r) => s + r.score, 0) / mandates.length) : null;

  const audit = {
    root: scanData.root, context: scanData.context || null,
    // [Foreman: 079] carried forward so every consumer reads the profile — and
    // the analyses it declares out of scope — off the record it was handed
    profile: scanData.profile || null,
    files, rules, skills: scanData.skills || [],
    hookInventory: scanData.hookInventory || [],
    // [Foreman: 169] carried through untouched, like hookInventory
    ...(scanData.outputStyles ? { outputStyles: scanData.outputStyles } : {}),
    // [Foreman: 077] raw level-4/5 discovery, carried so the derivation below
    // stays a pure function of the audit
    repoChecks: scanData.repoChecks || null,
    // [Foreman: 073] the inventory travels with the audit, unchanged
    sources: scanData.sources || [],
    // [Foreman: 076] resolved in scan, where the globs are; read by the
    // scope-overlap finding
    scopeOverlaps: scanData.scopeOverlaps || [],
    coverage: scanData.coverage || null,
    corpusScore: corpus, corpusGrade: corpus === null ? null : grade(corpus),
  };
  // [Foreman: 085] An analysis that did not run is part of what the audit
  // covered, so it lands in coverage beside every other honest gap — one field
  // in the record, one line in the coverage block. It is a disclosure and
  // never a finding: nothing about a large corpus is a defect in it, and a
  // build must not fail because assay declined to pair.
  const comparableCount = comparableRules(audit).length;
  if (comparableCount > PAIRWISE_RULE_CAP) {
    audit.coverage = { ...(audit.coverage || {}), pairwiseSkipped: comparableCount };
  }
  // [Foreman: 071] What the model contributed, if anything. Absent on a
  // deterministic run — the audit does not claim a semantic pass it never had.
  if (!deterministic) {
    audit.semantic = {
      provenance: isRecordObject(judgments._provenance) ? judgments._provenance : null,
      judged,
      suppressed: rules.filter((r) => r.suppressed).length,
      // [Foreman: 076] The model's proposals, carried verbatim. They are
      // rendered and labelled; they never enter `findings` or `relationships`,
      // and nothing below reads them back into a score or a state.
      candidates: Array.isArray(judgments._candidates) ? judgments._candidates : [],
    };
    // [Foreman: 140] The engine's own proposals join the model's in the one
    // array the contract already defines, each carrying which side proposed it
    // so a reader is never told a script found a contradiction it did not.
    if (opts.semantic) {
      for (const p of nearMissConflictPairs(audit)) {
        audit.semantic.candidates.push({
          kind: "indirect-conflict",
          // The one field the model's proposals do not carry. A reader must
          // never be told a script found a contradiction it did not find.
          proposedBy: "analyzer",
          // `keys`, not ids: the renderer resolves a candidate to its rules by
          // content hash, which is what survives a rewrite.
          keys: [p.a.key, p.b.key],
          sources: [
            { path: p.a.file, lineStart: p.a.lineStart, lineEnd: p.a.lineEnd },
            { path: p.b.file, lineStart: p.b.lineStart, lineEnd: p.b.lineEnd },
          ],
          summary: `both rules command \`${p.action}\` with opposite polarity, but they share too few words to call it a contradiction`,
          reason: "a rule that explains itself dilutes the words it is compared on, so the pair falls under the threshold a reported conflict has to clear — read the two together and decide whether they are about the same thing",
          // Unreviewed, like every proposal. The audit skills ask about each one
          // and write the answer back here.
          accepted: null,
        });
      }
    }
  }
  // [Foreman: 077] The enforcement ladder, before the findings that read it.
  audit.mechanisms = deriveMechanisms(audit);
  // [Foreman: 075] Findings are the product's primary output, so they are part
  // of the composed audit, not something a renderer invents on the way out.
  audit.findings = deriveFindings(audit);
  // [Foreman: 076] The deterministic relationship graph beside them.
  audit.relationships = deriveRelationships(audit);
  return audit;
}

// ---------------------------------------------------------------------------
// Findings — the primary output
// ---------------------------------------------------------------------------

// [Foreman: 075]
// Every loaded rule gets exactly ONE primary state, derived from signals the
// analyzers already produce, at the precedence below: a rule the host never
// loads is not also "at risk", it is simply not there. `shadowed` and
// `conflicting` are named because the finding contract names them; nothing
// derives them until corpus analysis lands.
//
// "healthy" means no static issue was found within analyzer coverage. It never
// means the agent will comply — no static check can say that.
const FINDING_STATES = [
  "inactive", "shadowed", "blocked", "conflicting",
  "ambiguous", "at-risk", "mechanical-candidate", "advisory", "healthy",
];
const HARD_GATE_STATES = new Set(["inactive", "shadowed", "blocked"]);
const OPERATIONAL_STATES = new Set(["ambiguous", "conflicting", "at-risk"]);

// An experiment-supported finding must disclose the tier it was measured on and
// what that does not cover: a Claude-profile signal, never a cross-agent law.
const WORDING_STUDY_EVIDENCE = {
  level: "experiment-supported",
  tier: "small-model tier (haiku 4.5)",
  basis: "local wording studies, rule-lab 2026-07 (haiku 4.5 n=20/arm, sonnet 4.x n=5 spot checks, anti-default fixtures) and rule-lab exp-010-claude5, 2026-08-25 (sonnet 5, 440 cells at n=20/arm)",
  // [Foreman: 172] The 5-generation gap is measured now, on one tier, and the
  // answer changed the sentence rather than extending it: on sonnet 5 position
  // and verb strength showed NO effect across two intents each, and the
  // bare-prohibition penalty held in one intent of two. Every arm sat at a
  // ceiling — once a rule was present at all it was followed — so what is
  // measured there is that these levers stop separating outcomes, not that a
  // buried rule became a good one.
  limits: "measured on one host profile against fixtures built to defeat the model's defaults; it does not carry to other agents. The wording effects above are the 2026-07 haiku 4.5 measurements. On a Claude-5 tier (sonnet 5, 2026-08-25) rule position and verb strength measured NULL in two rule intents each, and the bare-prohibition penalty replicated in one of two, all against a ceiling; the other Claude-5 tiers are still unmeasured",
};
// [Foreman: 079] The same finding, for a profile the study never covered. A
// prohibition with nothing named to do instead is a structural fact about the
// rule and every profile is checked for it; the measured effect is what does not
// travel, so the evidence level drops rather than the finding disappearing.
const STALL_STRUCTURE_EVIDENCE = {
  level: "heuristic",
  basis: "a prohibition with no named alternative and no escape hatch",
  limits: "the experiment behind this pattern was run on another host profile; here it is a structural observation, not a measured effect",
};
const MODEL_JUDGMENT_LIMITS = "one model pass in this audit session; another session may judge it differently";

// The tag every finding line carries. The interface must not let a heuristic
// read as a mechanical fact — this tag is that distinction, so it stays plain.
function evidenceTag(evidence) {
  if (!evidence) return "";
  return "[" + evidence.level + (evidence.tier ? ": " + evidence.tier : "") + "]";
}

// [Foreman: 097]
// The next step a finding already carries. `deriveFindings` attaches
// `safeActions` to 23 kinds of finding and exactly one of them was ever printed,
// so the reader was handed a diagnosis and left to invent the repair. One
// sub-bullet, at whatever depth the caller is writing at.
function pushSafeActions(out, finding, indent = "  ") {
  const actions = (finding && finding.safeActions) || [];
  if (!actions.length) return;
  out.push(redactSecrets(`${indent}- what to do: ${actions.join("; ")}`));
}

function stateWord(state, n) {
  if (state !== "mechanical-candidate") return state;
  return n === 1 ? "mechanical candidate" : "mechanical candidates";
}

// [Foreman: 097] What each state word means, in words the reader had before they
// installed anything. The vocabulary itself is the record's contract and does not
// move; this is the legend the report never printed.
const STATE_GLOSS = {
  inactive: "the host never reads it",
  shadowed: "it sits in a file the host skipped",
  blocked: "it points at a file that is not there",
  conflicting: "another rule bans what it asks for",
  ambiguous: "when it applies has more than one reading",
  "at-risk": "it loads, but something makes it easy to miss",
  "mechanical-candidate": "a script could do this instead",
  advisory: "judgment that belongs in prose",
  healthy: "nothing the checks look for fired on it",
};

function ruleSpan(rule) {
  return [{ path: rule.file, lineStart: rule.lineStart, lineEnd: rule.lineEnd || rule.lineStart }];
}

function fileSpan(file) {
  return [{ path: file.path, lineStart: 1, lineEnd: file.lineCount || 1 }];
}

// [Foreman: 066]
// Every rule is graded on its own, so the same duty stated in CLAUDE.md and
// again in a scoped rules file used to be graded twice and named never. Two
// tiers, both computed without a model: identical normalized text (the same
// normalization the judgment key uses, so two rules that share a key across
// files are exactly the pairs this catches), and a token-set overlap for
// wording that drifted. The near tier needs both sides to carry a few content
// tokens — a three-token rule shares all of them with anything on its subject,
// and without the floor every short rule reads as a copy of every other.
// Advisory like Restructure candidates: a pair never moves a score or the
// corpus grade, because which copy survives is the developer's policy call.
// razor: findings only, and a pair, not a cluster — three copies of one duty
// emit three pairs. 076 owns the relationship model; when it lands it builds
// `relationships` from these same pairs rather than re-detecting them.
const DUPLICATE_JACCARD = 0.75;
const DUPLICATE_MIN_TOKENS = 4;

function jaccard(a, b) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}

// [Foreman: 076] The population every corpus comparison runs over: rules the
// host actually applies. A suppressed entry was judged not to be a rule, and a
// shadowed one sits in a file the host never selected — pairing either with a
// live rule would report a relationship that does not exist in the session.
// [Foreman: 079] Is this rule certainly part of what the host receives? Three
// adapter-declared facts, no filename: the file lost its selection, the file
// falls past a declared byte budget, or the rule sits below where that budget
// lands inside the file.
//
// The third case is the asymmetric one, and deliberately so. Its state is
// `at-risk`, not `inactive`, because calling it unread would be a positive
// non-delivery claim the documentation does not support — but pairing it with a
// live rule as a duplicate or a conflict would be the opposite positive claim,
// that both are active together. Under a documented ambiguity assay makes
// neither: the rule is named as at risk, and it is left out of the relationship
// graph until a live host settles the question.
function hostReceives(rule, file) {
  const f = file || {};
  if (f.selected === false || f.loaded === false) return false;
  // [ADR 2026-08-05 B2] Past the documented MEMORY.md read cap the rule is
  // definitively dropped, so it leaves the relationship population entirely.
  if (Number.isInteger(f.docCapLine) && rule.lineStart > f.docCapLine) return false;
  return !(Number.isInteger(f.truncatedAtLine) && rule.lineStart > f.truncatedAtLine);
}

function comparableRules(audit) {
  const files = audit.files || [];
  return (audit.rules || []).filter((r) => !r.suppressed && hostReceives(r, files[r.fileIndex]));
}

// [Foreman: 085] Both relationship walks compare every comparable rule with
// every other one. At a few hundred rules that is free; past this line the pair
// count — and the findings it can emit — grows as the square, and a corpus of a
// few thousand near-identical rules produced an audit record too large for
// `JSON.stringify` to return, which crashed the report outright.
//
// The cap is 500 because 500 rules is already a corpus no one reads end to end,
// it is an order of magnitude above any real instruction system assay has been
// pointed at, and 500 × 500 pairs still composes in well under a second.
//
// Past it the pairwise analysis does not run AT ALL, and says so. Sampling was
// the obvious alternative and is the wrong one: a partial walk reports "no
// conflicts" when it means "did not look everywhere", which is precisely the
// false assurance this product exists to remove.
//
// razor: a hard cap with a disclosure, not a faster algorithm. The upgrade path
// is an inverted index over content tokens — candidates come from shared rare
// tokens, and only candidate pairs are compared — which removes the cap instead
// of raising it. Named, not built.
const PAIRWISE_RULE_CAP = 500;

// The comparable rules, or null when there are too many to pair honestly.
function pairwiseRules(audit) {
  const rules = comparableRules(audit);
  return rules.length > PAIRWISE_RULE_CAP ? null : rules;
}

function byPairPosition(p, q) {
  return p.a.file.localeCompare(q.a.file) || p.a.lineStart - q.a.lineStart ||
    p.b.file.localeCompare(q.b.file) || p.b.lineStart - q.b.lineStart;
}

// Sorted by file then line on both sides, so two runs over one corpus emit the
// same pairs in the same order.
// [Foreman: 076] A pair the conflict analyzer claims is never also a duplicate:
// two rules of opposite polarity are not one duty stated twice, however far
// their content tokens overlap, and reporting both would name the same pair
// twice with contradictory advice.
function duplicatePairs(audit) {
  const comparable = pairwiseRules(audit);
  if (!comparable) return [];
  const conflicting = new Set([...conflictPairs(audit), ...conditionalConflictPairs(audit)]
    .map((p) => p.a.id + "|" + p.b.id));
  const graded = comparable.map((r) => {
    const text = r.contextText || r.text;
    return { rule: r, normalized: text.trim().toLowerCase().replace(/\s+/g, " "), tokens: contentTokens(text) };
  });
  const pairs = [];
  for (let i = 0; i < graded.length; i++) {
    for (let j = i + 1; j < graded.length; j++) {
      const a = graded[i], b = graded[j];
      if (conflicting.has(a.rule.id + "|" + b.rule.id)) continue;
      let tier = null;
      if (a.normalized === b.normalized) tier = "exact";
      else if (a.tokens.size >= DUPLICATE_MIN_TOKENS && b.tokens.size >= DUPLICATE_MIN_TOKENS &&
        jaccard(a.tokens, b.tokens) >= DUPLICATE_JACCARD) tier = "near";
      if (tier) pairs.push({ tier, a: a.rule, b: b.rule });
    }
  }
  return pairs.sort(byPairPosition);
}

// [Foreman: 076]
// A direct conflict is a wording-level judgment and nothing more: two rules on
// one subject that ban and command the SAME action. Every gate below exists to
// keep a normal corpus quiet, because a fabricated conflict costs more trust
// than a missed one is worth:
//
//   1. opposite polarity — exactly one side is a prohibition, the other a
//      positive imperative;
//   2. same subject — token-set Jaccard over contentTokens() at or above
//      CONFLICT_JACCARD, both sides carrying CONFLICT_MIN_TOKENS content tokens;
//   3. same action — the verb the ban forbids is the verb the mandate commands.
//      This is the gate that separates a contradiction from the ALTERNATIVE
//      pattern: "Never float the base image" beside "Always pin the base image"
//      shares its subject but names a DIFFERENT action, so the second rule is
//      the replacement for the first, not an argument with it;
//   4. neither side already carries an alternative clause ("… instead", "rather
//      than …"), which is that same pattern spelled out.
//
// razor: `resolvesProhibition` is the token machinery behind gate 3, but it
// cannot be called directly — it fires on plain subject overlap, which a real
// conflict has in full, so it would veto every true pair. Gate 3 is its
// verb-level half, which is the discriminating one.
//
// [ADR 2026-08-05 D5] Vendor corroboration of the HARM, not the detector:
// Anthropic transcript analysis (context-engineering post, claude.com/blog,
// 2026-07-24) reports that conflicting instructions in one request force extra
// deliberation on Claude 5-generation models. It strengthens why this check
// earns its place; the rendered finding and its evidence level are unchanged.
const CONFLICT_JACCARD = 0.6;
// [Foreman: 140] The floor under a near-miss proposal. Below this the two rules
// share an action verb and a polarity and nothing else, which is a coincidence
// of grammar rather than a subject in common.
const NEAR_MISS_FLOOR = 0.2;
const CONFLICT_MIN_TOKENS = 4;
// [Foreman: 097] Gate 2 compares the DIRECTIVE clause, not the whole bullet.
// "Never validate input at the API edge; the gateway does it." says the same
// thing as the bare ban, and the trailing explanation added three content tokens
// that were about the gateway rather than the subject — enough to drop the pair
// under the threshold and report nothing at all. Splitting on sentence, semicolon
// and dash boundaries (never a comma, which joins one clause to itself) and
// comparing the half that carries the commanded action puts an explained rule
// back on the same footing as a bare one.
const DIRECTIVE_SPLIT = /(?<=[.!?])\s+(?=[A-Z`*_"'])|[;—–]\s*/;

function directiveClause(text) {
  const clauses = String(text).split(DIRECTIVE_SPLIT).map((c) => c.trim()).filter(Boolean);
  if (clauses.length < 2) return String(text);
  return clauses.find((c) => commandedAction(c) !== null) || String(text);
}
// The words that carry polarity rather than action; the action verb is whatever
// leads the directive once one of these is stepped over.
const POLARITY_LEADS = new Set([
  "never", "do not", "don't", "must not", "must", "cannot", "forbidden",
  "always", "should", "required", "avoid",
]);

function stripLead(text, verb) {
  return text.toLowerCase().replace(/^[^a-z]+/, "").slice(verb.length).replace(/^[^a-z]+/, "");
}

// The action a directive commands or bans — "Never pin X" and "Always pin X"
// both answer "pin". Null when no verb from the table leads it.
function commandedAction(text) {
  let rest = text;
  for (let step = 0; step < 2; step++) {
    const verb = leadingVerb(rest);
    if (verb === null) return null;
    if (!POLARITY_LEADS.has(verb)) return verb;
    rest = stripLead(rest, verb);
  }
  return null;
}

function carriesAlternative(rule) {
  const text = (rule.contextText || rule.text).toLowerCase();
  return ALTERNATIVE_MARKERS.some((m) => text.includes(m.trim())) || hasContrastNot(rule.text);
}

function conflictPairs(audit) {
  const comparable = pairwiseRules(audit);
  if (!comparable) return [];
  const graded = comparable.map((r) => {
    const text = r.contextText || r.text;
    return {
      rule: r, text,
      prohibition: isProhibitionText(text),
      positive: hasPositiveImperative(text),
      action: commandedAction(text),
      alternative: carriesAlternative(r),
      // [Foreman: 097] the subject of the DIRECTIVE, not of the whole bullet
      tokens: contentTokens(directiveClause(text)),
    };
  });
  const pairs = [];
  for (let i = 0; i < graded.length; i++) {
    for (let j = i + 1; j < graded.length; j++) {
      const a = graded[i], b = graded[j];
      if (a.prohibition === b.prohibition) continue;
      const ban = a.prohibition ? a : b;
      const mandate = a.prohibition ? b : a;
      if (!mandate.positive) continue;
      if (ban.alternative || mandate.alternative) continue;
      if (ban.action === null || ban.action !== mandate.action) continue;
      if (a.tokens.size < CONFLICT_MIN_TOKENS || b.tokens.size < CONFLICT_MIN_TOKENS) continue;
      if (jaccard(a.tokens, b.tokens) < CONFLICT_JACCARD) continue;
      pairs.push({ a: a.rule, b: b.rule, ban: ban.rule, mandate: mandate.rule, action: ban.action });
    }
  }
  return pairs.sort(byPairPosition);
}

// A conditional conflict is a direct conflict living behind one shared
// condition. A leading "when …," clause hides the directive's verb from
// commandedAction, so these pairs are invisible to conflictPairs — and a rule
// gated on a moment is exactly where a contradiction bites, because both sides
// fire together when that moment arrives.
//
// Deliberately narrower than the direct analyzer, because the exception
// pattern ("Never push. When the user approves, push.") is legitimate layering:
//   1. BOTH sides carry a leading condition clause — one conditional side and
//      one unconditional side reads as a rule and its exception, and stays
//      silent;
//   2. the two conditions describe one moment — token Jaccard at or above
//      CONDITION_JACCARD;
//   3. the remainders pass every direct-conflict gate: opposite polarity, the
//      same commanded action, subject overlap, no alternative clause.
const CONDITION_LEAD = /^\s*(?:when|whenever|if|unless|while|before|after|once|during)\b([^,]{1,80}),\s*/i;
const CONDITION_JACCARD = 0.5;

function splitCondition(text) {
  const m = text.match(CONDITION_LEAD);
  if (!m) return null;
  return { condition: m[0], rest: text.slice(m[0].length) };
}

function conditionalConflictPairs(audit) {
  const comparable = pairwiseRules(audit);
  if (!comparable) return [];
  const graded = [];
  for (const r of comparable) {
    const split = splitCondition(r.contextText || r.text);
    if (!split) continue;
    graded.push({
      rule: r,
      conditionText: split.condition.replace(/,\s*$/, "").trim(),
      conditionTokens: contentTokens(split.condition),
      prohibition: isProhibitionText(split.rest),
      positive: hasPositiveImperative(split.rest),
      action: commandedAction(split.rest),
      alternative: carriesAlternative(r),
      tokens: contentTokens(split.rest),
    });
  }
  const pairs = [];
  for (let i = 0; i < graded.length; i++) {
    for (let j = i + 1; j < graded.length; j++) {
      const a = graded[i], b = graded[j];
      if (a.prohibition === b.prohibition) continue;
      const ban = a.prohibition ? a : b;
      const mandate = a.prohibition ? b : a;
      if (!mandate.positive) continue;
      if (ban.alternative || mandate.alternative) continue;
      if (ban.action === null || ban.action !== mandate.action) continue;
      if (a.tokens.size < CONFLICT_MIN_TOKENS || b.tokens.size < CONFLICT_MIN_TOKENS) continue;
      if (jaccard(a.tokens, b.tokens) < CONFLICT_JACCARD) continue;
      if (jaccard(a.conditionTokens, b.conditionTokens) < CONDITION_JACCARD) continue;
      pairs.push({
        a: a.rule, b: b.rule, ban: ban.rule, mandate: mandate.rule,
        action: ban.action, condition: ban.conditionText,
      });
    }
  }
  return pairs.sort(byPairPosition);
}

// [Foreman: 140] The pairs that pass every conflict gate except the last one.
//
// Explaining a rule dilutes its content tokens below the overlap threshold:
// "Always validate input at the API edge" against "Never validate input at the
// API edge; the gateway does it" shares three tokens of six and reports
// nothing. 1.11.0 widened the comparison to the directive clause, which catches
// most of these; a pair that still misses is invisible, and silence about a
// contradiction is the worst thing this analyzer can do.
//
// These are PROPOSALS and nothing more. They never enter `relationships[]`,
// never move a state, a score or a grade, and never gate a build — the Jaccard
// threshold is what separates "assay found a contradiction" from "these two
// might be about the same subject, look". Emitted only under `--semantic`, so a
// default run is unchanged to the byte.
function nearMissConflictPairs(audit) {
  const comparable = pairwiseRules(audit);
  if (!comparable) return [];
  const graded = comparable.map((r) => {
    const text = r.contextText || r.text;
    return {
      rule: r, text,
      prohibition: isProhibitionText(text),
      positive: hasPositiveImperative(text),
      action: commandedAction(text),
      alternative: carriesAlternative(r),
      tokens: contentTokens(directiveClause(text)),
    };
  });
  const pairs = [];
  for (let i = 0; i < graded.length; i++) {
    for (let j = i + 1; j < graded.length; j++) {
      const a = graded[i], b = graded[j];
      // Every gate conflictPairs applies, in the same order…
      if (a.prohibition === b.prohibition) continue;
      const ban = a.prohibition ? a : b;
      const mandate = a.prohibition ? b : a;
      if (!mandate.positive) continue;
      if (ban.alternative || mandate.alternative) continue;
      if (ban.action === null || ban.action !== mandate.action) continue;
      if (a.tokens.size < CONFLICT_MIN_TOKENS || b.tokens.size < CONFLICT_MIN_TOKENS) continue;
      // …and then the opposite of its last one. A pair at or above the
      // threshold is already a reported conflict and must not be proposed twice.
      const overlap = jaccard(a.tokens, b.tokens);
      if (overlap >= CONFLICT_JACCARD) continue;
      // A pair with nothing in common is not a near miss, it is two unrelated
      // rules. The floor keeps the proposal list about subjects that touch.
      if (overlap < NEAR_MISS_FLOOR) continue;
      pairs.push({ a: a.rule, b: b.rule, ban: ban.rule, mandate: mandate.rule, action: ban.action, overlap });
    }
  }
  return pairs.sort(byPairPosition);
}

// [Foreman: 097]
// One policy question, one row. The same contradictory pair written into two
// files produces four pairs — every copy of the ban against every copy of the
// mandate — and four identical rows filled the whole fix table while asking the
// reader for one decision. Pairs whose ban text and mandate text are literally
// the same policy (normalized the way a duplicate is) collapse into one group
// carrying every site.
//
// razor: identical normalized text only. Two rules that merely rhyme stay two
// groups — collapsing on similarity would hide a second real decision behind the
// first.
function normalizedRuleText(rule) {
  return (rule.contextText || rule.text).trim().toLowerCase().replace(/\s+/g, " ");
}

function groupConflictPairs(pairs) {
  const groups = new Map();
  for (const pair of pairs) {
    const key = [pair.action, pair.condition || "", normalizedRuleText(pair.ban), normalizedRuleText(pair.mandate)].join("\0");
    const found = groups.get(key);
    if (found) found.pairs.push(pair);
    else groups.set(key, { key, first: pair, pairs: [pair] });
  }
  return [...groups.values()].map((g) => {
    const rules = [];
    const seen = new Set();
    for (const p of g.pairs) {
      for (const r of [p.a, p.b]) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        rules.push(r);
      }
    }
    // First-seen order, which is the pair order the analyzer already sorted —
    // never re-sorted here, so a single-pair group's spans are byte-identical to
    // what it emitted before grouping existed.
    return { ...g.first, rules, copies: g.pairs.length };
  });
}

// The host's documented load order for the two sides, stated as a fact about
// loading and never as a resolution: which policy is right is not a question
// load order answers. Empty when the adapter ranks the two sources equally —
// there is no order to name, and inventing one would be the resolution this
// analyzer must not make.
function precedenceNote(fileA, fileB) {
  const pa = (fileA || {}).precedence, pb = (fileB || {}).precedence;
  if (!Number.isInteger(pa) || !Number.isInteger(pb) || pa === pb) return "";
  const [later, earlier] = pa > pb ? [fileA, fileB] : [fileB, fileA];
  return ` The host reads \`${earlier.path}\` before \`${later.path}\`, so \`${later.path}\` is the later word in the documented load order — that is the order, not a decision about which policy is correct.`;
}

// Which copy looks worth keeping — advisory, never an instruction to delete.
// A scoped `.claude/rules/` file is a more specific home than a memory file;
// [ADR 2026-08-05 B6] then the checked-in project copy over a machine-local,
// host-rewritable one — an auto-memory note and a project rule are both kind
// `memory`, and without this the tie could advise keeping the host-owned copy;
// then the higher-scoring copy; then the one that comes first. `a` is always
// the earlier-positioned rule.
const KEEP_WHY = ["a scoped rules file", "the checked-in project copy", "the higher-scoring copy"];
function keepSuggestion(pair, files) {
  const rank = (r) => {
    const f = files[r.fileIndex] || {};
    return [f.kind === "rules" ? 1 : 0, f.scope === "project" ? 1 : 0, r.score == null ? 0 : r.score];
  };
  const ra = rank(pair.a), rb = rank(pair.b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) {
      const why = KEEP_WHY[i];
      return ra[i] > rb[i] ? { keep: pair.a, drop: pair.b, why } : { keep: pair.b, drop: pair.a, why };
    }
  }
  return { keep: pair.a, drop: pair.b, why: "stated first" };
}

// One primary state for one rule, first match wins.
// [Foreman: 076] `conflicted` maps a rule id to the rule it contradicts.
// [Foreman: 079] `policy` is the profile's own declaration of which analyses
// apply to it. Six rows below are the Claude wording rubric and are skipped when
// a profile declines it; every other row is host-neutral and always runs.
function deriveRuleState(rule, file, conflicted = new Map(), policy = DEFAULT_POLICY) {
  const factors = rule.factors || {};
  const values = rule.factorValues || {};
  const globs = (file && file.globs) || [];
  // [Foreman: 084] Two independent reasons the English wording rubric may not
  // apply: the profile withholds it, or the rule is not in English. Either way
  // the rows below that read a wording factor stay silent, and the mechanical
  // rows — selection, budget, glob, reference resolution, conflict — do not.
  const rubric = policy.wordingRubric !== false && englishScored(rule);

  // [Foreman: 079] The host's own documented budget ran out before this file.
  // The instruction exists, reads like live policy, and the session never
  // receives it — which is `inactive` exactly as the finding contract defines it.
  if (file && file.loaded === false) {
    return {
      state: "inactive", severity: "high", analyzer: "byte-budget",
      summary: "`" + rule.file + "` begins at byte " + file.startsAtByte + " of the instruction chain, past the host's cap — it is never read",
      explanation: "The host reads its instruction sources in order until a documented byte limit is reached and stops adding files. Everything in this one falls after that point, so no wording change reaches this rule while the files ahead of it stay this large.",
      evidence: { level: "documented", basis: "the host's documented combined instruction byte limit, applied over the discovered read order" },
      safeActions: ["raise the configured limit", "shorten a source read earlier in the chain", "move the rule into a file the host reaches"],
    };
  }
  // [ADR 2026-08-05 B2] The documented MEMORY.md read cap lands above this rule.
  // Unlike the chain-wide cap this is a per-file limit the docs state definitively
  // ("content beyond that threshold is not loaded"), so the state is inactive,
  // not the ambiguous at-risk the crossing-file case gets.
  if (file && Number.isInteger(file.docCapLine) && rule.lineStart > file.docCapLine && file.docCap) {
    return {
      state: "inactive", severity: "high", analyzer: "memory-index-cap",
      summary: "`" + rule.file + "` sits past line " + file.docCapLine + ", the documented MEMORY.md read limit — it is never loaded at session start",
      explanation: "Only the first 200 lines or 25KB of the auto-memory index load at the start of a conversation, measured over the content that loads (frontmatter and block HTML comments stripped). Everything after that is dropped on the next load, so no wording change reaches this rule until the index is shortened.",
      evidence: {
        level: "documented", basis: file.docCap.claim, url: file.docCap.url,
        limits: "the byte value behind \"25KB\" is not stated on the page and is read as 25×1024",
      },
      safeActions: ["move this entry into the first 200 lines / 25KB of MEMORY.md", "move the detail into a topic file"],
    };
  }
  if (globs.length && file.globMatchCount === 0) {
    return {
      state: "inactive", severity: "high", analyzer: "glob-resolution",
      summary: "`" + rule.file + "` is scoped to globs that match no file, so the host never loads it",
      explanation: "The host loads a scoped rules file only for paths matching its `paths:` frontmatter, and nothing in the project matches. No wording change reaches this rule while the glob stays dead.",
      evidence: { level: "mechanical", basis: "dead-glob resolution against the project tree" },
      safeActions: ["repair the glob", "move the rule to an always-loaded file", "retire the rule"],
    };
  }
  // [Foreman: 076] The file exists and reads like live policy; the host picked
  // its sibling and never loads this one. No wording change reaches it.
  if (file && file.selected === false) {
    return {
      state: "shadowed", severity: "medium", analyzer: "source-selection",
      summary: "`" + rule.file + "` is not the variant the host selected — " + (file.selectionReason || "another file was selected"),
      explanation: "Two files compete for the same slot and the host loads exactly one of them. This rule sits in the copy that lost, so it takes no effect at all — it is graded here only so nothing in the file goes unreported.",
      evidence: { level: "mechanical", basis: "same-level source selection" },
      safeActions: ["move the rule into the selected file", "delete the unselected variant"],
    };
  }
  if (conflicted.has(rule.id)) {
    const { other, note } = conflicted.get(rule.id);
    return {
      state: "conflicting", severity: "high", analyzer: "conflict-detection",
      summary: "it contradicts " + other.file + ":" + other.lineStart + " — one bans what the other commands",
      explanation: "Two loaded rules ban and command the same action on the same subject. assay does not decide which policy is correct: both are reported, neither is edited, and the choice is yours." + note,
      evidence: { level: "heuristic", basis: "opposite-polarity wording on one topic" },
      safeActions: ["retire one of the two", "narrow one rule's scope so they stop overlapping"],
    };
  }
  // [Foreman: 097] Not on a host-written note. An auto-memory entry is a dated
  // OBSERVATION — "closed the gate in scripts/gate.js on 2026-07-28" — and the
  // file it names being gone later is the record working, not a defect in it.
  // Grading those as blocked rules made every hard gate in a real project a
  // completion record, and made `assay ci` fail a build on the machine's notes.
  if (rule.staleness && rule.staleness.gated && !(file && file.autoMemory)) {
    const dead = rule.staleness.missing.filter((m) => !(m.moved || []).length).map((m) => "`" + m.ref + "`");
    return {
      state: "blocked", severity: "high", analyzer: "reference-resolution",
      summary: "it requires " + dead.join(", ") + ", which the project does not contain",
      explanation: "The rule loads, but a path it depends on does not resolve, so following it means re-discovering the target or giving up.",
      evidence: { level: "mechanical", basis: "reference resolution against the working tree" },
      safeActions: ["repair reference", "drop the reference"],
    };
  }
  // [Foreman: 079] Rubric row: without a wording rubric an unextractable action
  // is a maintainability observation, not a reliability failure — deriveFindings
  // emits it as one.
  if (rubric && factors.F1 && factors.F1.method === "extraction_failed") {
    return {
      state: "ambiguous", severity: "medium", analyzer: "verb-strength",
      summary: "no directive verb could be read out of it — the action is not stated plainly",
      explanation: "The wording carries no recognizable action, so what the rule asks for is left to the reader.",
      evidence: {
        level: "heuristic", basis: "verb-table extraction",
        limits: "English-only wording table; a rule in another language reads as unextractable whatever it says",
      },
      safeActions: ["rewrite with a leading action verb"],
    };
  }
  // Rubric row: the explicit-trigger requirement.
  if (rubric && values.F3 != null && values.F3 <= THRESHOLDS.ambiguousF3) {
    return {
      state: "ambiguous", severity: "medium", analyzer: "trigger-distance",
      summary: "the moment it fires has more than one reading",
      explanation: "The rule never names the situation it applies to, so recognizing that moment is left to inference.",
      evidence: { level: "model-inferred", basis: "audit-session model judgment (trigger distance)", limits: MODEL_JUDGMENT_LIMITS },
      safeActions: ["name the trigger", "rewrite"],
    };
  }
  // [Foreman: 079] The documented cap lands inside this file, above this rule.
  // Not `inactive`: the doc says the host "stops adding files" once the combined
  // size reaches the limit, which is file-granular — whether the crossing file
  // arrives whole or cut at the boundary is exactly what it does not say. assay
  // has no live-host evidence to settle it, so this states the risk and declines
  // the claim. It sits here because `at-risk` is where an unsettled risk belongs
  // on the state ladder, and above stallRisk because the budget fact is the more
  // specific of the two.
  if (file && Number.isInteger(file.truncatedAtLine) && rule.lineStart > file.truncatedAtLine) {
    return {
      state: "at-risk", severity: "high", analyzer: "byte-budget",
      summary: "the host's documented cap lands at line " + file.truncatedAtLine + " of `" + rule.file + "`, above this rule",
      explanation: "The combined instruction chain reaches the host's documented limit partway through this file, at byte " + file.truncatedAtByte + " of it. The documentation says the host stops adding files at that point; it does not say whether this file arrives whole or is cut at the boundary. Either this rule is delivered or it is not, and no static read settles which.",
      evidence: {
        level: "documented", basis: "the host's documented combined instruction byte limit, applied over the discovered read order",
        limits: "the limit and the read order are documented; the fate of the crossing file's remainder is not, and assay has not watched this host apply it",
      },
      safeActions: ["raise the configured limit", "move the rule above the boundary", "shorten a source read earlier in the chain"],
    };
  }
  // Not a rubric row: a prohibition with no alternative is a missing escape
  // hatch, which every profile is checked for. Only the EVIDENCE is
  // profile-bound — the study behind it measured one host, so a profile the
  // study never covered gets the same finding at the honest evidence level
  // rather than a borrowed experimental claim.
  if (rule.stallRisk) {
    return {
      state: "at-risk", severity: "high", analyzer: "framing-polarity",
      summary: "a bare prohibition — nothing is named to do instead, so a task needing the banned thing can stall",
      explanation: "A ban with no replacement and no escape hatch converts a blocked task into a stopped one.",
      evidence: rubric ? WORDING_STUDY_EVIDENCE : STALL_STRUCTURE_EVIDENCE,
      safeActions: ["name the alternative", "add an escape hatch"],
    };
  }
  // Rubric row: the must/always force lever.
  if (rubric && factors.F1 && factors.F1.hedged) {
    return {
      state: "at-risk", severity: "medium", analyzer: "verb-strength",
      summary: "hedged force — `" + factors.F1.matchedVerb + "` governs the directive",
      explanation: "A hedge sets the whole sentence's force, however firm the rest of it sounds, so the rule reads as optional.",
      evidence: {
        level: "heuristic", basis: "hedge-marker lookup",
        limits: "the force gap behind this check was measured only on a pre-Claude-5 small tier (haiku 4.5, rule-lab 2026-07) and had already saturated on sonnet 4.x",
      },
      safeActions: ["rewrite with a firm verb", "restate it as a preference on purpose"],
    };
  }
  // Rubric row: the line-position lever.
  if (rubric && values.F5 != null && values.F5 <= THRESHOLDS.buriedF5) {
    return {
      state: "at-risk", severity: "low", analyzer: "position",
      summary: "buried in the bottom half of a long file, where rules lose force",
      explanation: "Position within a long file is the part of loading the author controls; the bottom of one is the weakest place to put a rule.",
      evidence: { level: "heuristic", basis: "position within the file's graded content" },
      safeActions: ["move to the top quarter", "split the file"],
    };
  }
  if (rule.placement) {
    return {
      state: "mechanical-candidate", severity: "low", analyzer: "placement-detection",
      summary: "a " + rule.placement.bestFit + " could own this policy more reliably than prose",
      explanation: "The rule's job matches a deterministic or delegated mechanism; prose is the least reliable place to keep it.",
      evidence: { level: "heuristic", basis: "placement signal patterns" },
      safeActions: ["promote to " + rule.placement.bestFit, "park the promotion plan"],
    };
  }
  if (rule.hookOpportunity) {
    return {
      state: "mechanical-candidate", severity: "low", analyzer: "enforceability",
      summary: "a hook or script could enforce this mechanically, on every run",
      explanation: "Nothing here needs judgment, so leaving it to prose spends attention on something an exit code settles.",
      evidence: { level: "model-inferred", basis: "audit-session model judgment (enforceability)", limits: MODEL_JUDGMENT_LIMITS },
      safeActions: ["promote to hook", "park the promotion plan"],
    };
  }
  if (rule.category === "preference") {
    return {
      state: "advisory", severity: "info", analyzer: "category",
      summary: "annotated a preference — judgment that appropriately stays prose",
      explanation: "The rule is declared a preference, so it is held to a preference's floor and not to a mandate's.",
      evidence: { level: "mechanical", basis: "category annotation" },
      safeActions: [],
    };
  }
  if (rule.f8 != null && rule.f8 >= THRESHOLDS.advisoryF8) {
    return {
      state: "advisory", severity: "info", analyzer: "enforceability",
      summary: "needs judgment no mechanism can supply — it appropriately stays prose",
      explanation: "No hook or linter can decide this, so prose is the right home for it rather than a weaker place to have left it.",
      evidence: { level: "model-inferred", basis: "audit-session model judgment (enforceability)", limits: MODEL_JUDGMENT_LIMITS },
      safeActions: [],
    };
  }
  return {
    state: "healthy", severity: "info", analyzer: "state-derivation",
    summary: "no static issue found within analyzer coverage",
    explanation: "Nothing the analyzers check fired on this rule. That is not a prediction that the agent will follow it.",
    evidence: {
      level: "mechanical", basis: "no finding at material severity across the checks this analyzer runs",
      limits: "absence of a finding is bounded by analyzer coverage; it is never a compliance prediction",
    },
    safeActions: [],
  };
}

function byPathOf(files, wanted) {
  return files.find((f) => f.path === wanted) || { path: wanted };
}

// [Foreman: 076]
// Everything the host loads before the session reads anything: user memory,
// project memory, local memory, and every unscoped rules file. The adapter
// documents no byte cap — `budgets()` returns `{ documented: null }` — so the
// number below is assay's own heuristic line and every finding built on it says
// so. It is not a limit Claude Code enforces.
// [ADR 2026-08-05 D4] Set under the pre-Claude-5 host and re-affirmed against the
// 2026 docs, which still document no CLAUDE.md byte cap (only per-file line
// guidance). Not rescaled off the blog's 80% system-prompt figure — that would
// be category confusion, since this threshold counts user-corpus bytes, not
// system-prompt tokens. S4 corroborates the direction only: context-rot degrades
// recall as a gradient with total tokens. Comment note; the number stands.
const CONTEXT_PRESSURE_BYTES = 40_000;

function alwaysLoadedBytes(audit) {
  const loaded = (audit.sources || []).filter((s) => s.alwaysLoaded && Number.isInteger(s.bytes));
  return {
    total: loaded.reduce((n, s) => n + s.bytes, 0),
    largest: [...loaded].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, 3),
  };
}

// A wired hook covers a rule's moment when it fires on the same event and its
// matcher admits the tool the rule implies. `*` (or an absent matcher) admits
// everything; a rule that implies no tool is covered by any hook on its event.
function matcherCovers(wiredMatcher, impliedMatcher) {
  if (!impliedMatcher) return true;
  const wired = wiredMatcher || "*";
  if (wired === "*" || wired === "") return true;
  const admitted = wired.split("|");
  return impliedMatcher.split("|").some((tool) => admitted.includes(tool));
}

function hookCoverage(audit) {
  // [Foreman: 080] A hook a policy switches off covers nothing. Where an adapter
  // declares `enabled: false` — an `allow_managed_hooks_only` layer, say — the
  // rule it would have covered is still uncovered, and the report must not mark
  // it handled.
  const wired = (audit.hookInventory || []).filter((h) => !h.states || h.states.enabled !== false);
  const covered = [];
  for (const rule of comparableRules(audit)) {
    const inferred = (rule.placement || {}).hookEvent;
    if (!inferred) continue;
    const hook = wired.find((h) => h.event === inferred.event && matcherCovers(h.matcher, inferred.matcher));
    if (hook) covered.push({ rule, hook, event: inferred.event });
  }
  return covered;
}

// [Foreman: 077]
// Every mechanism this project has wired, at its ladder level, with the state
// chain the placement contract names. Pure over the audit, emitted level-first
// so two runs produce identical ids.
//
// The honesty rules, per type, are the whole point of the function:
//   - a hook is configured and loads, but workspace trust cannot be read from
//     here, and its matcher is a coverage limit, not a footnote;
//   - a skill or subagent carries no trust gate and no guarantee of invocation;
//   - a repository or remote check is a name in a manifest or a file on disk —
//     everything past `configured` is unknown.
// `verified` is false everywhere, always. Nothing in this codebase watches a
// mechanism run, so nothing here may say it did.
function deriveMechanisms(audit) {
  const mechs = [];
  const add = (type, name, source, states, limits, coverage = {}) => {
    mechs.push({
      type, level: MECHANISM_LEVELS[type], name, source,
      states: { verified: false, ...states },
      coverage: { ...coverage, limits },
      provenance: source,
    });
  };

  const skillStates = { configured: true, enabled: true, trusted: true, applicable: "unknown" };
  const skillLimits = [MECHANISM_LIMITS.routing, MECHANISM_LIMITS.notExecuted];
  for (const skill of audit.skills || []) {
    // [Foreman: 080] How a skill fires is not one story. A host that documents a
    // per-skill implicit-routing switch has skills the description never routes:
    // those are reached by naming them, and saying "a description routes it"
    // about one would be the wrong limit on the wrong mechanism.
    const explicitOnly = skill.metadata ? skill.metadata.allowImplicitInvocation === false : false;
    add("skill", skill.name, skill.path || ".claude/skills/", skillStates,
      explicitOnly ? [MECHANISM_LIMITS.explicitOnly, MECHANISM_LIMITS.notExecuted] : skillLimits);
  }
  for (const skill of ((audit.coverage || {}).userSkills) || []) {
    add("skill", skill.name, "user scope", skillStates, skillLimits);
  }
  for (const agent of ((audit.coverage || {}).agents) || []) {
    // [Foreman: 091] entries are graded objects now; a pre-091 record's bare
    // names still render
    const name = typeof agent === "string" ? agent : agent.name;
    const p = typeof agent === "string" ? ".claude/agents/" + agent + ".md" : agent.path;
    add("subagent", name, p, skillStates, skillLimits);
  }
  for (const hook of audit.hookInventory || []) {
    const matcher = hook.matcher || "*";
    const restricts = matcher !== "*" && matcher !== "";
    // [Foreman: 080] The adapter may declare the hook's state chain and which
    // limits apply, by key into the vocabulary above. It knows what its host
    // documents about trust; this file knows how to say it. An adapter that
    // declares neither keeps the states and limits it always had.
    const limits = Array.isArray(hook.limitKeys)
      ? hook.limitKeys.map((k) => MECHANISM_LIMITS[k]).filter(Boolean)
      : [MECHANISM_LIMITS.trust, MECHANISM_LIMITS.notExecuted];
    if (restricts) {
      // Which field the matcher filters on is the host's business: an event that
      // filters on a trigger or a session source restricts something other than
      // a tool, and the limit has to say which.
      const filters = hook.matcherFilters ? `\`${hook.matcherFilters}\`` : "the event's own matcher field";
      limits.unshift(hook.matcherFilters
        ? `the \`${matcher}\` matcher is the whole of this hook's reach — it matches on ${filters} and raises no event for anything else`
        : `the \`${matcher}\` matcher is the whole of this hook's reach — it raises no event for any other tool`);
    }
    // A hook wired in project or user settings, or shipped by an installed
    // plugin, loads when it is present. Whether the workspace is trusted is
    // the axis a static read cannot settle.
    const states = isRecordObject(hook.states)
      ? hook.states
      : { configured: true, enabled: true, trusted: "unknown", applicable: true };
    // [Foreman: 091] `label` is the display name; the full command stays on the
    // inventory record for redaction and target checks to read.
    add("hook", hook.label || hook.command, hook.source, states, limits, restricts
      ? { events: [hook.event], matchers: [matcher], tools: matcher.split("|") }
      : { events: [hook.event], matchers: [matcher] });
  }
  for (const check of ((audit.repoChecks || {}).checks) || []) {
    add(check.type, check.name, check.path, {
      configured: true, enabled: "unknown", trusted: "unknown", applicable: "unknown",
    }, [check.type === "remote-gate" ? MECHANISM_LIMITS.remote : MECHANISM_LIMITS.repo, MECHANISM_LIMITS.notExecuted]);
  }

  // Stable by construction: the sort is stable, and every list above arrives
  // sorted from the adapter.
  return mechs.sort((a, b) => a.level - b.level)
    .map((m, i) => ({ id: "M" + String(i + 1).padStart(3, "0"), ...m }));
}

// Every finding in the audit, rule states first, then the findings that belong
// to a file, an annotation, or the corpus rather than to one rule. Pure: two
// derivations over the same audit produce the same list in the same order.
function deriveFindings(audit) {
  const findings = [];
  const push = (finding) => findings.push({ id: "F" + String(findings.length + 1).padStart(3, "0"), ...finding });
  const all = audit.rules || [];
  const rules = all.filter((r) => !r.suppressed);
  const files = audit.files || [];
  const policy = profilePolicy(audit);

  // [Foreman: 076] Both sides of a conflict take the state; the pair itself is
  // named once, below, with both spans.
  // [Foreman: 093] Conditional pairs join the same map: both rules go
  // `conflicting`, and the note carries the shared condition so the state row
  // says when the contradiction fires.
  const conflicts = conflictPairs(audit);
  const conditionalConflicts = conditionalConflictPairs(audit);
  const conflicted = new Map();
  for (const pair of conflicts) {
    const note = precedenceNote(files[pair.a.fileIndex], files[pair.b.fileIndex]);
    conflicted.set(pair.a.id, { other: pair.b, note });
    conflicted.set(pair.b.id, { other: pair.a, note });
  }
  for (const pair of conditionalConflicts) {
    const note = ` Both fire under one condition — "${pair.condition}".` +
      precedenceNote(files[pair.a.fileIndex], files[pair.b.fileIndex]);
    if (!conflicted.has(pair.a.id)) conflicted.set(pair.a.id, { other: pair.b, note });
    if (!conflicted.has(pair.b.id)) conflicted.set(pair.b.id, { other: pair.a, note });
  }

  for (const rule of rules) {
    push({ ...deriveRuleState(rule, files[rule.fileIndex], conflicted, policy), rule: rule.id, sources: ruleSpan(rule) });
  }
  // [Foreman: 079] Without a wording rubric, a rule whose action cannot be read
  // out of it is a maintainability item: worth tidying, not a claim that the
  // host will fail on it. Under a rubric this is the `ambiguous` state instead,
  // and this loop is silent.
  if (policy.wordingRubric === false) {
    for (const rule of rules.filter((r) => englishScored(r) &&
      (r.factors || {}).F1 && r.factors.F1.method === "extraction_failed")) {
      push({
        type: "action-clarity", severity: "low", analyzer: "verb-strength", rule: rule.id, tier: "maintainability",
        summary: "no directive verb could be read out of it — whatever it asks for is left to the reader",
        explanation: "assay could not extract a commanded action from this line. That is an observation about how it reads, not a measured reliability risk on this host: no experiment covers this profile's wording.",
        evidence: {
          level: "heuristic", basis: "verb-table extraction",
          limits: "English-only wording table; a rule in another language reads as unextractable whatever it says",
        },
        sources: ruleSpan(rule), safeActions: ["rewrite with a leading action verb", "leave it as prose on purpose"],
      });
    }
  }
  // [Foreman: 084] One finding per rule and per skill description the wording
  // rubric could not read, naming the mode it was set aside under. The rule is
  // not ungraded quietly: this is where the report says the checks were skipped
  // and which of them still ran.
  const unsupportedText = (mode) => "Wording checks need English and this reads as " +
    languageModeLabel(mode) + ", so no English factor and no grade was applied to it. " +
    "The language-independent checks still did: stale references, duplicates and conflicts, " +
    "availability, and the byte budgets. assay names the language it could not score; it does not score it.";
  const unsupportedEvidence = (mode) => ({
    level: "heuristic",
    basis: mode === "non-latin-script" ? "non-Latin script detection" : "closed-class function-word screen",
    limits: mode === "non-latin-script"
      ? "script detection — it establishes that the text is not Latin script, not which language it is"
      : "the language named is a guess and related languages are easily confused; what the screen establishes is that the text is not English",
  });
  for (const rule of rules.filter((r) => !englishScored(r))) {
    push({
      type: "unsupported-language", severity: "low", analyzer: "language-mode",
      rule: rule.id, mode: rule.languageMode,
      summary: "wording checks need English — this reads as " + languageModeLabel(rule.languageMode) +
        "; the mechanical findings still apply",
      explanation: unsupportedText(rule.languageMode),
      evidence: unsupportedEvidence(rule.languageMode),
      sources: ruleSpan(rule), safeActions: ["translate the rule", "exclude the file from grading"],
    });
  }
  for (const skill of (audit.skills || []).filter((s) => !englishScored(s))) {
    push({
      type: "unsupported-language", severity: "low", analyzer: "language-mode", mode: skill.languageMode,
      summary: "`" + skill.path + "` describes itself in " + languageModeLabel(skill.languageMode) +
        " — the trigger recipe was not applied to it",
      explanation: unsupportedText(skill.languageMode),
      evidence: unsupportedEvidence(skill.languageMode),
      sources: [{ path: skill.path, lineStart: 1, lineEnd: 1 }],
      safeActions: ["translate the description", "leave it as is — routing is the host's call, not assay's"],
    });
  }
  for (const rule of rules.filter((r) => r.invalidCategory)) {
    const line = rule.invalidCategory.line;
    push({
      type: "unknown-category", severity: "low", analyzer: "category", rule: rule.id,
      summary: "`<!-- category: " + rule.invalidCategory.value + " -->` names no known category",
      explanation: "The annotation was not recognized, so the rule was graded under its file's default category and holds the wrong pass mark.",
      evidence: { level: "mechanical", basis: "category annotation vocabulary" },
      sources: [{ path: rule.file, lineStart: line, lineEnd: line }],
      safeActions: ["fix the spelling", "drop the annotation"],
    });
  }
  // [Foreman: 076] One corpus finding per conflicting pair, naming both spans.
  // [Foreman: 097] Copies of one policy question collapse into a single row that
  // names every site — see groupConflictPairs.
  const copiesNote = (g) => (g.copies > 1
    ? ` The same disagreement is written ${g.copies} times, at ${g.rules.map((r) => r.file + ":" + r.lineStart).join(", ")} — it is one decision, not ${g.copies}.`
    : "");
  for (const pair of groupConflictPairs(conflicts)) {
    const note = precedenceNote(files[pair.a.fileIndex], files[pair.b.fileIndex]);
    push({
      type: "conflict", severity: "high", analyzer: "conflict-detection",
      summary: `\`${pair.ban.file}:${pair.ban.lineStart}\` bans \`${pair.action}\` and \`${pair.mandate.file}:${pair.mandate.lineStart}\` commands it`,
      explanation: "The two rules are about one subject and take opposite positions on the same action, so whichever one the agent reaches for, it breaks the other. assay does not decide which policy is correct — it names the pair and leaves the intent to you." + copiesNote(pair) + note,
      evidence: { level: "heuristic", basis: "opposite-polarity wording on one topic" },
      sources: pair.rules.flatMap(ruleSpan),
      safeActions: [`retire ${pair.ban.file}:${pair.ban.lineStart}`, `retire ${pair.mandate.file}:${pair.mandate.lineStart}`, "scope one of the two so they no longer overlap"],
    });
  }
  // [Foreman: 093] Conditional pairs: the same contradiction, gated on one
  // shared moment. Both sides conditional by construction — a conditional side
  // against an unconditional one reads as a rule and its exception and is
  // never reported.
  for (const pair of groupConflictPairs(conditionalConflicts)) {
    const note = precedenceNote(files[pair.a.fileIndex], files[pair.b.fileIndex]);
    push({
      type: "conditional-conflict", severity: "high", analyzer: "conflict-detection",
      summary: `under "${pair.condition}", \`${pair.ban.file}:${pair.ban.lineStart}\` bans \`${pair.action}\` and \`${pair.mandate.file}:${pair.mandate.lineStart}\` commands it`,
      explanation: "Both rules are gated on the same condition and take opposite positions on the same action, so the moment the condition holds, following either one breaks the other. assay does not decide which policy is correct — it names the pair and leaves the intent to you." + copiesNote(pair) + note,
      evidence: { level: "heuristic", basis: "opposite-polarity wording on one topic under one condition" },
      sources: pair.rules.flatMap(ruleSpan),
      safeActions: [`retire ${pair.ban.file}:${pair.ban.lineStart}`, `retire ${pair.mandate.file}:${pair.mandate.lineStart}`, "reword one condition so the two moments no longer coincide"],
    });
  }
  const duplicates = duplicatePairs(audit);
  // [Foreman: 076] Two scoped files claiming the same project file is ordinary
  // and stays silent; it becomes a finding only once their rules already
  // duplicate or contradict each other, which is when the shared scope is the
  // thing that made the collision possible.
  const relatedFiles = new Set([...conflicts, ...conditionalConflicts, ...duplicates].map((p) => [p.a.file, p.b.file].sort().join("\0")));
  for (const overlap of audit.scopeOverlaps || []) {
    if (!relatedFiles.has([overlap.a, overlap.b].sort().join("\0"))) continue;
    push({
      type: "scope-overlap", severity: "info", analyzer: "scope-resolution",
      summary: `\`${overlap.a}\` (${overlap.globs.a.join(", ")}) and \`${overlap.b}\` (${overlap.globs.b.join(", ")}) both load for ${overlap.shared} shared file(s)`,
      explanation: "Both files load together for those paths, which is why their rules can collide. Overlapping scopes are normal on their own; this is reported because these two already state something twice or contradict each other.",
      evidence: { level: "mechanical", basis: "glob resolution against the project tree" },
      sources: [fileSpan(byPathOf(files, overlap.a))[0], fileSpan(byPathOf(files, overlap.b))[0]],
      safeActions: ["narrow one of the two glob sets", "merge the two files"],
    });
  }
  // [Foreman: 076] A policy a wired hook already covers. "Configured", never
  // "verified": assay reads the settings, it does not watch the hook run.
  for (const covered of hookCoverage(audit)) {
    push({
      type: "redundant-enforcement", severity: "low", analyzer: "mechanism-coverage", rule: covered.rule.id,
      summary: `a \`${covered.event}\` hook (\`${covered.hook.label || covered.hook.command}\`, ${covered.hook.source}) is already wired for the moment this rule names`,
      explanation: "The rule asks the agent to remember something a configured hook already fires on. assay read the hook out of the settings files; it has not watched it run, so treat this as configured, not verified.",
      evidence: {
        level: "heuristic", basis: "a wired hook already covers this event",
        limits: "the hook is configured, not observed — assay never checks that it fires or that it enforces this rule",
      },
      sources: ruleSpan(covered.rule),
      safeActions: ["confirm the hook covers this rule", "retire the prose once the hook is confirmed"],
    });
  }
  // [Foreman: 091] Two mechanical checks on the wired hooks themselves. A hook
  // whose script is gone never fires, and a matcher that is not a valid regex
  // matches nothing — both read straight out of the configuration, and both
  // only for project-source hooks, whose commands resolve inside this repo.
  // [Foreman: 093] `deadHookTargets` feeds the shared-target aggregation below.
  const deadHookTargets = [];
  for (const hook of audit.hookInventory || []) {
    if (hook.source !== "project") continue;
    const cmd = String(hook.command || "");
    const tokens = cmd.replace(/["']/g, "").split(/\s+/);
    const pathy = tokens.filter((t) => /[\\/]/.test(t) && !t.startsWith("-"));
    const scriptTok = pathy.length ? pathy[pathy.length - 1] : null;
    if (scriptTok) {
      const substituted = scriptTok
        .replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, ".")
        .replace(/%CLAUDE_PROJECT_DIR%/g, ".");
      if (!path.isAbsolute(substituted) && !/^[A-Za-z]:/.test(substituted) && !substituted.startsWith("~")) {
        let missing = false;
        try { fs.statSync(path.join(audit.root, substituted)); } catch { missing = true; }
        if (missing) {
          deadHookTargets.push({ hook, target: path.posix.normalize(substituted.split(path.sep).join("/")).replace(/^\.\//, "") });
          push({
            type: "hook-target-missing", severity: "high", analyzer: "mechanism-coverage",
            summary: `a \`${hook.event}\` hook runs \`${hook.label || hook.command}\`, and \`${substituted}\` is not in the project`,
            explanation: "The hook is configured but the script its command names does not resolve inside this repository, so the guardrail it promises never runs. A rule this hook was said to cover is not covered.",
            evidence: { level: "mechanical", basis: "the command's script path, resolved against the project root" },
            sources: [{ path: ".claude/settings.json" }],
            safeActions: ["fix the script path", "remove the dead hook entry"],
          });
        }
      }
    }
    const matcher = hook.matcher;
    if (matcher && matcher !== "*" && matcher !== "") {
      let bad = null;
      try { new RegExp(matcher); } catch (err) { bad = String(err.message).split("\n")[0]; }
      if (bad) {
        push({
          type: "hook-matcher-invalid", severity: "high", analyzer: "mechanism-coverage",
          summary: `a \`${hook.event}\` hook's matcher \`${matcher}\` is not a valid pattern`,
          explanation: "The host reads a matcher as a regular expression, and this one does not compile: " + bad + ". The hook cannot match the events it was written for.",
          evidence: { level: "mechanical", basis: "the matcher compiled as a regular expression" },
          sources: [{ path: ".claude/settings.json" }],
          safeActions: ["fix the matcher pattern"],
        });
      }
    }
  }
  // [Foreman: 093] Stale shared targets: one dead path that several sources
  // still point at. The per-rule `blocked` row and the per-hook finding above
  // each name their own referrer; this is the corpus view — the target named
  // once, with everything that depends on it, because restoring one file fixes
  // every line listed and no single-referrer finding says so.
  {
    const referrers = new Map(); // resolved target -> [{rule} | {hook}]
    const addRef = (target, entry) => {
      if (!referrers.has(target)) referrers.set(target, []);
      referrers.get(target).push(entry);
    };
    for (const rule of rules) {
      // [Foreman: 097] Same reason as the blocked state above: a note is not a
      // policy leaning on a path.
      if ((files[rule.fileIndex] || {}).autoMemory) continue;
      for (const m of ((rule.staleness || {}).missing) || []) {
        if ((m.moved || []).length) continue; // moved is fixable, not dead
        if (m.resolved) addRef(m.resolved, { rule });
      }
    }
    for (const dead of deadHookTargets) addRef(dead.target, { hook: dead.hook });
    for (const [target, refs] of [...referrers.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (refs.length < 2) continue;
      const ruleRefs = refs.filter((r) => r.rule);
      const hookRefs = refs.filter((r) => r.hook);
      const names = [
        ...ruleRefs.map((r) => r.rule.file + ":" + r.rule.lineStart),
        ...hookRefs.map((r) => "a `" + r.hook.event + "` hook (`" + (r.hook.label || r.hook.command) + "`)"),
      ];
      push({
        type: "stale-shared-target", severity: "high", analyzer: "reference-resolution",
        summary: `\`${target}\` does not exist, and ${refs.length} sources still point at it`,
        explanation: "Several policies share this one target, so its absence breaks them together: " +
          names.join(", ") + ". Restoring the file, or repairing every reference at once, fixes the whole set — " +
          "fixing one citation at a time leaves the rest still pointing at nothing.",
        evidence: { level: "mechanical", basis: "reference resolution against the working tree" },
        sources: [
          ...ruleRefs.flatMap((r) => ruleSpan(r.rule)),
          ...hookRefs.map(() => ({ path: ".claude/settings.json" })),
        ],
        safeActions: [`restore \`${target}\``, "repair every reference that names it"],
      });
    }
  }
  // [Foreman: 077] One skill name defined in two scopes. Mechanical and cheap:
  // two names matched, nothing inferred about which one the host picks.
  const projectSkillNames = new Set((audit.skills || []).map((s) => s.name));
  for (const skill of ((audit.coverage || {}).userSkills) || []) {
    if (!projectSkillNames.has(skill.name)) continue;
    push({
      type: "mechanism-overlap", severity: "low", analyzer: "mechanism-coverage",
      summary: `the project and user scopes both define skill \`${skill.name}\``,
      explanation: "Two mechanisms carry the same name at different scopes. Which one a session reaches for is host-defined — assay reads both directories and does not resolve the routing, so treat the duplicate name as ambiguity to remove rather than as redundancy that helps.",
      evidence: {
        level: "mechanical", basis: "skill names matched across project and user scope",
        limits: "names only — the two skills may do entirely different things",
      },
      sources: [], safeActions: ["rename one of the two skills", "retire the copy that no longer applies"],
    });
  }
  // [Foreman: 080] Skill findings for a profile that withholds the trigger
  // recipe. Nothing here is a wording judgment: a required field is present or
  // it is not, a sidecar parses or it does not, two names match or they do not,
  // and a documented budget is spent or it is not.
  const skillAt = (s) => [{ path: s.path, lineStart: 1, lineEnd: 1 }];
  if (policy.skillRecipe === false) {
    for (const skill of (audit.skills || []).filter((s) => (s.checks || {}).mode === "required-metadata")) {
      if (skill.checks.missing.length) {
        push({
          type: "skill-metadata", severity: "high", analyzer: "skill-metadata",
          summary: `\`${skill.path}\` declares no ${skill.checks.missing.join(" and no ")} — the host documents ${skill.checks.missing.length === 1 ? "it" : "both"} as required`,
          explanation: "The host requires these fields in a skill's frontmatter. A skill missing one is not a skill written badly — it is a skill the host has nothing to list or route on.",
          evidence: {
            level: "documented", basis: "SKILL.md frontmatter requires `name` and `description`",
            limits: "the field is read out of the file; assay has not watched this host reject the skill",
          },
          sources: skillAt(skill),
          safeActions: skill.checks.missing.map((k) => `add a \`${k}\` to the frontmatter`),
        });
      }
      if (skill.metadataIssue) {
        push({
          type: "skill-metadata-unreadable", severity: "medium", analyzer: "skill-metadata",
          summary: `\`${skill.metadataPath}\` could not be parsed (${skill.metadataIssue}) — its interface metadata, invocation policy and tool dependencies were not read`,
          explanation: "The sidecar is optional, so a skill without one is normal; one that exists and will not parse is different. assay reports it rather than guessing at its contents, and the skill keeps the documented defaults — which includes implicit routing staying on.",
          evidence: { level: "mechanical", basis: "YAML parse of the skill's metadata sidecar" },
          sources: skillAt(skill), safeActions: ["repair the YAML", "delete the sidecar if it is unused"],
        });
      }
    }
    // "If two skills share the same `name`, Codex doesn't merge them; both can
    // appear in skill selectors." There is no winner to report, which is the
    // finding: two entries, one name, and no documented resolution.
    const byName = new Map();
    for (const skill of (audit.skills || []).filter((s) => (s.checks || {}).mode === "required-metadata")) {
      if (!byName.has(skill.name)) byName.set(skill.name, []);
      byName.get(skill.name).push(skill);
    }
    for (const [name, group] of byName) {
      if (group.length < 2) continue;
      push({
        type: "skill-name-collision", severity: "medium", analyzer: "skill-discovery",
        summary: `${group.length} skills are named \`${name}\` — ${group.map((s) => "`" + s.path + "`").join(", ")}`,
        explanation: "The host does not merge two skills that share a name; both stay listed, and which one a session reaches is not documented. assay names every copy and picks no winner, because the documentation defines none.",
        evidence: {
          level: "documented", basis: "two skills sharing a name are not merged — both can appear in skill selectors",
          limits: "names matched, nothing else — the copies may do entirely different things",
        },
        sources: group.flatMap(skillAt),
        safeActions: ["rename all but one", "remove the copy that no longer applies"],
      });
    }
  }
  // The collective listing budget: what every discovered skill costs before any
  // of them is selected. One finding for the whole list, because the budget is
  // one pool and no single skill overruns it alone.
  const skillBudget = (audit.coverage || {}).skillBudget;
  if (skillBudget) {
    const listed = [
      ...(audit.skills || []).map((s) => ({ name: s.name, chars: s.listingChars || 0, path: s.path })),
      ...(((audit.coverage || {}).userSkills) || []).map((s) => ({ name: s.name, chars: s.listingChars || 0, path: null })),
    ];
    const total = listed.reduce((n, s) => n + s.chars, 0);
    if (total > skillBudget.amount) {
      const largest = [...listed].sort((a, b) => b.chars - a.chars).slice(0, 3);
      push({
        type: "skill-listing-budget", severity: "medium", analyzer: "skill-listing-budget",
        summary: `${listed.length} skills list for about ${total} characters against a documented ${skillBudget.amount}-character budget — largest: ${largest.map((s) => "`" + s.name + "` (" + s.chars + ")").join(", ")}`,
        explanation: "The host builds one list of every skill at session start and holds it to a budget. Past it, descriptions are shortened first and skills can be dropped from the list entirely — so a skill can exist, be well written, and never be offered. Shortening the longest descriptions is what buys the list back.",
        evidence: {
          level: "heuristic", basis: skillBudget.claim,
          limits: "the budget is documented; the exact listing serialization is not, so this total counts each skill's name and description and is a floor rather than the host's own arithmetic",
        },
        sources: largest.filter((s) => s.path).map((s) => ({ path: s.path, lineStart: 1, lineEnd: 1 })),
        safeActions: ["shorten the longest descriptions", "remove skills this project no longer uses"],
      });
    }
  }
  // [Foreman: 079] The host's own documented budget, spent. The adapter decided
  // where the limit lands and marked each source; this loop only reports what it
  // marked, with the arithmetic a reader needs to check it. One finding per
  // source, so a chain that overruns by three files says so three times rather
  // than hiding two of them behind a total.
  const budget = (audit.coverage || {}).budget;
  if (budget) {
    const inChain = files.filter((f) => Number.isInteger(f.startsAtByte));
    const chainBytes = inChain.reduce((n, f) => n + (f.bytes || 0), 0);
    const arithmetic = `the chain is ${chainBytes} bytes, the cap is ${budget.amount} (${budget.source})`;
    for (const file of inChain) {
      if (file.loaded === false) {
        push({
          type: "budget-exceeded", severity: "high", analyzer: "byte-budget",
          summary: `\`${file.path}\` starts at byte ${file.startsAtByte} of the instruction chain and is never read — ${arithmetic}`,
          explanation: "The host stops adding instruction sources once the combined size reaches its documented limit. Everything in this file is past that point, so none of it reaches a session started here.",
          evidence: { level: "documented", basis: budget.claim, limits: "the limit and the read order are documented; assay has not watched this host apply them" },
          sources: fileSpan(file),
          safeActions: ["raise the configured limit", "shorten a source read earlier in the chain", "move this file earlier in the chain"],
        });
      } else if (file.truncated) {
        push({
          type: "budget-truncation", severity: "high", analyzer: "byte-budget",
          summary: `the cap lands inside \`${file.path}\`, at byte ${file.truncatedAtByte} of it${Number.isInteger(file.truncatedAtLine) ? ` (line ${file.truncatedAtLine})` : ""} — ${arithmetic}`,
          explanation: "This file begins below the host's documented limit and crosses it. The documentation says where the limit lands, not whether the remainder of a crossing file is delivered — so every rule below that line is reported at-risk rather than called unread.",
          evidence: {
            level: "documented", basis: budget.claim,
            limits: "the limit and the read order are documented; the fate of the crossing file's remainder is not, and assay has not watched this host apply either",
          },
          sources: fileSpan(file),
          safeActions: ["raise the configured limit", "move the rules below the boundary higher in the file", "shorten a source read earlier in the chain"],
        });
      }
    }
  }
  // [Foreman: 076] The window cost of everything loaded before the session
  // starts. The line always prints; only real heft becomes a finding.
  // [Foreman: 079] Skipped where the host documents a cap of its own: this
  // threshold exists because Claude Code documents none, and a profile with a
  // real limit is measured against that limit instead of against assay's line.
  const pressure = alwaysLoadedBytes(audit);
  if (!budget && pressure.total > CONTEXT_PRESSURE_BYTES) {
    push({
      type: "context-pressure", severity: "low", analyzer: "context-pressure",
      summary: `${pressure.total} bytes of instructions load before every session — largest: ${pressure.largest.map((s) => "`" + s.path + "` (" + s.bytes + ")").join(", ")}`,
      explanation: "Every session pays for these bytes before it reads a single file of yours. Nothing here is broken; it is a cost worth knowing, and scoping the largest file to the paths it applies to is what reduces it.",
      evidence: {
        level: "heuristic", basis: "summed bytes of always-loaded sources against assay's own threshold",
        limits: "the nearest documented host statement is per-file adherence guidance (target under 200 lines per CLAUDE.md, memory docs); it is about lines per file, not total bytes, and neither sets nor confirms this figure — the 40k line stays assay's own",
      },
      sources: pressure.largest.map((s) => ({ path: s.path, lineStart: 1, lineEnd: s.lineCount || 1 })),
      safeActions: ["scope the largest file with `paths:` frontmatter", "split it into scoped rules files"],
    });
  }
  // [Foreman: 066] One finding per pair. Neither rule loses its own state — both
  // copies are real rules, and the duplication is a property of the pair.
  for (const pair of duplicates) {
    const exact = pair.tier === "exact";
    const { keep, drop, why } = keepSuggestion(pair, files);
    const crossScope = (files[pair.a.fileIndex] || {}).scope !== (files[pair.b.fileIndex] || {}).scope;
    push({
      type: "duplicate", severity: exact ? "medium" : "low", analyzer: "duplicate-detection",
      // [Foreman: 078] The tier and the keep/drop call travel WITH the finding so
      // a renderer can print the same line without re-pairing the corpus.
      tier: pair.tier, keepWhy: why,
      keep: { path: keep.file, lineStart: keep.lineStart },
      drop: { path: drop.file, lineStart: drop.lineStart },
      summary: `the same duty is stated at ${pair.a.file}:${pair.a.lineStart} and at ${pair.b.file}:${pair.b.lineStart}`,
      explanation: (exact
        ? "The two are identical once whitespace and case are normalized."
        : "The two share most of their content words, so they read as one duty said twice.") +
        (crossScope ? " They sit in different scopes — the duty is stated in your own setup and in this project both." : "") +
        " Both copies are graded and neither is edited: which one survives is a policy call.",
      evidence: exact
        ? { level: "mechanical", basis: "identical normalized rule text" }
        : {
          level: "heuristic", basis: "content-token overlap between two rules",
          limits: "token overlap, not meaning — two rules about one subject can overlap heavily without stating the same duty",
        },
      sources: [...ruleSpan(pair.a), ...ruleSpan(pair.b)],
      safeActions: [`keep ${keep.file}:${keep.lineStart}`, `retire ${drop.file}:${drop.lineStart}`],
    });
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const doctorRemedy = profileNouns(audit).doctorRemedy;
  for (const candidate of restructureCandidates(audit)) {
    const file = byPath.get(candidate.path);
    const memoryKind = Boolean(file) && file.kind === "memory";
    // [ADR 2026-08-05 D1] The 200-line reason echoes the memory docs' per-file
    // line guidance, but only on a memory-kind file under a profile that grades
    // position — the docs set no line target for `.claude/rules/`, and Codex
    // (wordingRubric false) never prints it.
    const evidence = { level: "heuristic", basis: "narrative share, rule position, and file length thresholds" };
    const wordingProfile = !(audit.profile && audit.profile.policy && audit.profile.policy.wordingRubric === false);
    if (memoryKind && wordingProfile && file.lineCount > RESTRUCTURE_LONG_FILE_LINES) {
      evidence.limits = "the >200 line reason echoes the memory docs' per-CLAUDE.md-file size guidance (lines per file, not a byte cap); the other reasons and every threshold stay assay's own";
    }
    // [ADR 2026-08-05 D3] The host's documented `/doctor` remedy, memory-kind
    // gated and offered only where the profile carries the noun.
    const safeActions = memoryKind && doctorRemedy
      ? [...candidate.restructures, doctorRemedy]
      : candidate.restructures;
    push({
      type: "file-shape", severity: "medium", analyzer: "file-shape",
      // [Foreman: 078] carried so the renderer lists the reasons without
      // re-measuring the file
      reasons: candidate.reasons,
      summary: "the file's shape holds its rules back: " + candidate.reasons.join(", "),
      explanation: "This is a property of the file, not of any one rule in it, so no per-rule rewrite reaches it.",
      evidence,
      sources: fileSpan(file || { path: candidate.path }),
      safeActions,
    });
  }
  for (const source of audit.sources || []) {
    for (const construct of source.unsupported || []) {
      push({
        type: "unsupported-construct", severity: "low", analyzer: "parser",
        summary: construct.reason,
        explanation: "The parser could not map this span faithfully, so it was inventoried rather than graded. It lowers coverage; it never becomes an inferred non-rule.",
        evidence: { level: "mechanical", basis: "parser coverage" },
        sources: [{ path: source.path, lineStart: construct.startLine, lineEnd: construct.endLine }],
        safeActions: ["repair the construct"],
      });
    }
  }
  for (const source of ((audit.coverage || {}).inaccessible) || []) {
    push({
      type: "inaccessible-source", severity: "medium", analyzer: "discovery",
      summary: "could not be read (" + source.reason + ") — nothing in it was graded",
      explanation: "The host loads this file but the audit could not open it, so every count in this report excludes whatever it contains.",
      evidence: { level: "mechanical", basis: "filesystem read" },
      sources: [{ path: source.path, lineStart: 1, lineEnd: 1 }],
      safeActions: ["fix the permissions", "rerun the audit"],
    });
  }
  for (const rule of all.filter((r) => r.suppressed)) {
    push({
      type: "suppressed-entry", severity: "info", analyzer: "verification-pass", rule: rule.id,
      summary: "dropped from every count — judged prose rather than an instruction: " + rule.suppressedReason,
      explanation: "The verification pass may only drop an entry; its score and factor values are unchanged.",
      evidence: { level: "model-inferred", basis: "audit-session verification pass", limits: MODEL_JUDGMENT_LIMITS },
      sources: ruleSpan(rule), safeActions: [],
    });
  }
  return findings;
}

// [Foreman: 076]
// The relationship graph: what the deterministic analyzers found BETWEEN two
// things in the corpus, rather than about either one of them. Findings are what
// a report shows a human; relationships are the edges a later consumer walks.
// Every edge is built from the pairs the findings were built from — nothing is
// detected a second time here.
//
// `between` names two sites: a rule by its content key, a source by its path.
// Ordering is kind first, then the site order each analyzer already emits (the
// sort is stable), so two runs over one corpus produce identical ids.
function deriveRelationships(audit) {
  const rels = [];
  const files = audit.files || [];
  const site = (rule) => rule.key || rule.id;

  for (const pair of conflictPairs(audit)) {
    rels.push({
      kind: "conflict", between: [site(pair.a), site(pair.b)],
      explanation: `${pair.a.file}:${pair.a.lineStart} and ${pair.b.file}:${pair.b.lineStart} take opposite positions on \`${pair.action}\`. assay does not decide which policy is correct.` +
        precedenceNote(files[pair.a.fileIndex], files[pair.b.fileIndex]),
      evidence: { level: "heuristic", basis: "opposite-polarity wording on one topic" },
    });
  }
  // [Foreman: 093] A conditional pair is a conflict edge like any other — the
  // contract's kind vocabulary is fixed, so the condition lives in the
  // explanation and the evidence basis, not in a new kind.
  for (const pair of conditionalConflictPairs(audit)) {
    rels.push({
      kind: "conflict", between: [site(pair.a), site(pair.b)],
      explanation: `${pair.a.file}:${pair.a.lineStart} and ${pair.b.file}:${pair.b.lineStart} take opposite positions on \`${pair.action}\` under one condition — "${pair.condition}". assay does not decide which policy is correct.` +
        precedenceNote(files[pair.a.fileIndex], files[pair.b.fileIndex]),
      evidence: { level: "heuristic", basis: "opposite-polarity wording on one topic under one condition" },
    });
  }
  for (const covered of hookCoverage(audit)) {
    rels.push({
      kind: "covers", between: [covered.hook.source + ":" + (covered.hook.label || covered.hook.command), site(covered.rule)],
      explanation: `a wired \`${covered.event}\` hook covers the moment ${covered.rule.file}:${covered.rule.lineStart} names — configured, not verified`,
      evidence: { level: "heuristic", basis: "a wired hook already covers this event" },
    });
  }
  for (const pair of duplicatePairs(audit)) {
    rels.push({
      kind: "duplicate", between: [site(pair.a), site(pair.b)],
      explanation: `${pair.a.file}:${pair.a.lineStart} and ${pair.b.file}:${pair.b.lineStart} state one duty twice (${pair.tier} copy)`,
      evidence: pair.tier === "exact"
        ? { level: "mechanical", basis: "identical normalized rule text" }
        : { level: "heuristic", basis: "content-token overlap between two rules" },
    });
  }
  for (const file of files.filter((f) => f.selected === false && f.shadowedBy)) {
    rels.push({
      kind: "shadows", between: [file.shadowedBy, file.path],
      explanation: `${file.shadowedBy} was selected at this level, so ${file.path} never loads`,
      evidence: { level: "mechanical", basis: "same-level source selection" },
    });
  }
  return rels
    .sort((a, b) => a.kind.localeCompare(b.kind))
    .map((rel, i) => ({ id: "REL" + String(i + 1).padStart(3, "0"), ...rel }));
}

// ---------------------------------------------------------------------------
// Secret redaction — one function, applied at render time by every renderer
// ---------------------------------------------------------------------------

// [Foreman: 078]
// A hook command, a repository-check name, or a provenance string is copied out
// of configuration somebody wrote, and configuration is where a pasted token
// ends up. Redaction hides the VALUE and never the finding: the mechanism stays
// listed, at its level, with its state chain — only the credential is masked.
// Rule text is never redacted; it is the developer's own prose and the thing
// this product is about.
//
// razor: fixed high-confidence prefixes plus a key=value form. No entropy scan —
// a "long random-looking string" detector eats commit SHAs, content hashes, and
// rule ids, and a false redaction in a report about wording is worse than a
// missed one in a file the developer already has open. The upgrade path is a
// user-supplied pattern list in config, not a cleverer regex.
const REDACTED = "[redacted]";
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[A-Z0-9]{12,}/g,
  /Bearer\s+\S{16,}/g,
  // the key survives so the reader still knows WHICH credential was there
  /((?:token|secret|password|api[_-]?key)\s*[=:]\s*)\S+/gi,
];

function redactSecrets(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    // a pattern with no capture group hands the callback the match offset, not a
    // key — only a string second argument is the key half of `key=value`
    out = out.replace(pattern, (match, key) => (typeof key === "string" ? key : "") + REDACTED);
  }
  return out;
}

// [Foreman: 079] A profile with no hygiene rubric carries no score to print, and
// an em dash is what "not measured" looks like everywhere else in these reports.
function fmt(x) {
  return x == null ? "—" : x.toFixed(2);
}

// [Foreman: 080] The trigger recipe's own verdict, and only it. A skill graded
// under a profile that withholds the recipe carries the `required-metadata`
// check instead, and its problems are findings — this table has nothing to say
// about it and must not print an empty verdict against it.
// [Foreman: 080] The findings a profile makes about its skills instead of
// grading them. One set, so the skills table and the findings list can never
// disagree about which of them a skill's problem belongs to.
const SKILL_FINDING_TYPES = new Set([
  "skill-metadata", "skill-metadata-unreadable", "skill-name-collision", "skill-listing-budget",
]);

// [Foreman: 095] What is actually wrong with one description, in the labels the
// checks already carry. Both report views read this, so the short one can never
// tell a different story about a skill than the full one does.
function skillIssues(s) {
  // A subagent whose file would not read has no checks at all — it carries the
  // reason instead, and that reason is the finding.
  if (!s.checks) return [s.issue || "unreadable"];
  const c = s.checks;
  if (c.mode === "dead") return [SKILL_CHECK_LABELS.dead];
  const issues = [];
  if (c.mode === "user-only") {
    if (c.empty) issues.push(SKILL_CHECK_LABELS.empty);
    if (c.overSpecified) issues.push(SKILL_CHECK_LABELS.overSpecified);
    if (c.overCap) issues.push(SKILL_CHECK_LABELS.overCap);
    return issues;
  }
  // `|| k` is load-bearing: a subagent with no `description` at all reports the
  // field name, which has no label of its own. Without the fallback the row
  // renders blank and says a description is weak without saying why.
  issues.push(...(c.missing || []).map((k) => SKILL_CHECK_LABELS[k] || k));
  if (c.redundant) issues.push(SKILL_CHECK_LABELS.redundant);
  if (c.overCap) issues.push(SKILL_CHECK_LABELS.overCap);
  if (c.hasWhenToUse) issues.push(SKILL_CHECK_LABELS.whenToUse);
  return issues;
}

function isWeakSkill(s) {
  const c = s.checks || {};
  if (c.mode === "required-metadata") return false;
  // [Foreman: 084] A description the recipe could not read has no recipe
  // verdict; only the character cap, which counts characters, still holds.
  if (c.mode === "unsupported-language") return Boolean(c.overCap);
  if (c.mode === "dead") return true;
  if (c.mode === "user-only") return c.overSpecified || c.overCap || c.empty;
  return c.missing.length || c.overCap || c.redundant || c.hasWhenToUse;
}

// [Foreman: 106] The shapes a skill written against older guidance carries.
// Every one of them is a check that already ships and is already evidenced —
// this adds no detector, no threshold and no new evidence claim. What it adds
// is the reading: several of these together are not five unrelated nits, they
// are one skill authored before the guidance moved, and the repair is one
// rewrite rather than five patches.
//
// The bar is TWO. One of these alone is an ordinary weak description, which the
// table above already says. Two or more is a pattern.
const PRE_GEN_SHAPES = {
  whenToUse: "keeps `when_to_use` as its own field",
  overSpecified: "keeps `when_to_use` as its own field",
  enumerated: "opens by enumerating instead of naming what it is for",
  redundant: "repeats a clause the listing budget then pays for twice",
  overCap: "runs past the listing cap, so its tail never reaches the model",
  exclusion: "names no case it should NOT fire on",
};

function preGenerationShapes(s) {
  const c = s.checks || {};
  if (c.mode === "dead" || !c.missing) return [];
  const hits = new Set();
  for (const k of c.missing || []) if (PRE_GEN_SHAPES[k]) hits.add(PRE_GEN_SHAPES[k]);
  if (c.hasWhenToUse) hits.add(PRE_GEN_SHAPES.whenToUse);
  if (c.overSpecified) hits.add(PRE_GEN_SHAPES.overSpecified);
  if (c.redundant) hits.add(PRE_GEN_SHAPES.redundant);
  if (c.overCap) hits.add(PRE_GEN_SHAPES.overCap);
  return [...hits];
}

function pushPreGenerationSkills(out, skills) {
  const stale = (skills || [])
    .map((s) => ({ skill: s, shapes: preGenerationShapes(s) }))
    .filter((x) => x.shapes.length >= 2);
  if (!stale.length) return;
  out.push("### Written against older guidance");
  out.push("");
  out.push("Each of these carries several shapes at once that the current guidance for routing a skill argues against. Individually they are the rows above; together they read as one description written before that guidance and never revisited, which makes them one rewrite rather than several patches. Nothing here is a new check — every shape named is read out of the frontmatter, the same way the table above reads it. [mechanical]");
  out.push("");
  for (const { skill, shapes } of stale) {
    out.push(`- \`${skill.name}\` — ${mdPathLink(skill.path)} — ${shapes.join("; ")}`);
  }
  out.push("");
  out.push("`/assay:craft-skill <name>` refits one against the current recipe, and shows you the old description beside the new one before anything is written.");
  out.push("");
}

function pushWeakSkillSection(out, weakSkills) {
  out.push(`## Weak skill descriptions (${weakSkills.length} to fix)`);
  out.push("");
  out.push("A skill's frontmatter description is how Claude decides to invoke it, and its `description` plus `when_to_use` share one listing entry capped at 1,536 characters — past that the tail is silently truncated. Model-invocable skills are graded on the trigger recipe folded into `description` alone; a lingering `when_to_use` field is flagged to fold in and delete, not a place to stash overflow. A `disable-model-invocation` skill is graded as a plain user-facing summary instead, and a skill neither side can invoke is flagged for removal. assay can rewrite each one for you from the fix menu (dead skills are flagged, not rewritten).");
  out.push("");
  out.push("Every check below is read out of the frontmatter, not judged. [mechanical]");
  out.push("");
  out.push("| Skill | Where | Chars | Issue |");
  out.push("|---|---|---|---|");
  for (const s of weakSkills) {
    const c = s.checks;
    const issues = skillIssues(s);
    out.push(`| ${s.name} | ${mdPathLink(s.path)} | ${c.length}/${DESCRIPTION_CAP} | ${issues.join(", ")} |`);
  }
  out.push("");
}

// [Foreman: 091] Same recipe, different mechanism: a subagent's description is
// how the model decides to delegate to it, and one that reads as documentation
// fails the same way a skill description does.
function pushWeakAgentSection(out, weakAgents) {
  out.push(`## Weak subagent descriptions (${weakAgents.length} to fix)`);
  out.push("");
  out.push("A subagent's frontmatter description is how the model decides to delegate to it — the same trigger recipe as a skill description, read out of `.claude/agents/`. Every check is mechanical.");
  out.push("");
  out.push("| Subagent | Where | Chars | Issue |");
  out.push("|---|---|---|---|");
  for (const a of weakAgents) {
    const c = a.checks;
    // [Foreman: 095] Shared with the short report, so the two views can never
    // tell different stories about one description.
    out.push(`| ${a.name} | ${mdPathLink(a.path)} | ${c ? c.length : "—"}/${DESCRIPTION_CAP} | ${skillIssues(a).join(", ")} |`);
  }
  out.push("");
}

function isWeakAgent(a) {
  if (typeof a === "string") return false; // pre-091 record — names only
  if (!a.checks) return true; // unreadable file
  return Boolean(a.checks.missing.length || a.checks.redundant);
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
const MAX_ROW_FACTORS = 2;

function rowWeaknesses(rule) {
  const values = rule.factorValues || {};
  const gap = (name) => WEIGHTS[name] * (1 - values[name]);
  const weak = Object.keys(WEIGHTS)
    .filter((name) => values[name] != null && values[name] < THRESHOLDS.weakFactor)
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
    out.push(`- ${r.id} (${mdPathLink(r.file, r.lineStart)}) "${truncateCell(r.text, 70)}" — "${r.suppressedReason}"`);
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

function stateCounts(findings) {
  const counts = new Map();
  for (const f of findings || []) {
    if (f.state) counts.set(f.state, (counts.get(f.state) || 0) + 1);
  }
  return counts;
}

function pushProgressSection(out, audit, prev, findings) {
  out.push("## Since last audit");
  out.push("");
  // [Foreman: 075] Findings move first, because they are what the report is
  // about; the grade follows as the hygiene summary it now is.
  const before = stateCounts(prev.findings);
  const after = stateCounts(findings);
  // A prior audit written before findings existed has nothing to diff — the
  // grade comparison still runs.
  if (prev.findings) {
    const states = FINDING_STATES.filter((s) => before.get(s) || after.get(s));
    if (states.length) {
      out.push("| Finding | Before | After |");
      out.push("|---|---|---|");
      for (const s of states) {
        const n = after.get(s) || 0;
        out.push(`| ${stateWord(s, n)} | ${before.get(s) || 0} | ${n} |`);
      }
      out.push("");
    }
  }
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
  pushRubricOnlyGains(out, audit, prev);
}

// [Foreman: 147] The corpus list this product was designed against ends with
// "suspicious improvements caused only by rubric-oriented wording", and it is
// the one item that never shipped. A grade can rise because a rule got better,
// or because it acquired the words the rubric rewards. Those look identical in
// a before/after table, and the second one is the failure mode a scoring
// product invites.
//
// This is a DISCLOSURE, not a verdict, and every input to it is mechanical: a
// grade that rose, against a rule count, a dead-reference count and a
// disagreement count that did not. It scores nothing, penalizes nothing and
// reverses nothing — deciding whether a rewrite is honest needs the meaning of
// both versions, which is not a thing a script can read.
const RUBRIC_GAIN = 0.05;

function pushRubricOnlyGains(out, audit, prev) {
  // Matched on the file and the rule's own text is impossible — a rewrite
  // changes both the text and the content-hash key. The file's mean is the
  // level at which a "gain with nothing behind it" is still observable without
  // pretending to have tracked an individual rule across a rewrite.
  const prevByPath = new Map((prev.files || []).map((f) => [f.path, f]));
  const suspicious = [];
  for (const f of audit.files || []) {
    const p = prevByPath.get(f.path);
    if (!p || p.score === null || f.score === null) continue;
    if (f.score - p.score < RUBRIC_GAIN) continue;
    // Nothing a reader would call an improvement changed. A per-rule finding
    // carries a STATE, not a type, so the states are what to count: a repaired
    // dead path drops a `blocked`, a resolved argument drops a `conflicting`,
    // and a rule the host now reads drops one of the hard-gate states. Any of
    // those is a real gain and the file is not listed.
    const statesFor = (rec) => {
      const counts = new Map();
      for (const x of rec.findings || []) {
        if (!x.state) continue;
        if (!(x.sources || []).some((s) => s.path === f.path)) continue;
        counts.set(x.state, (counts.get(x.state) || 0) + 1);
      }
      return counts;
    };
    const was = statesFor(prev), is = statesFor(audit);
    const moved = FINDING_STATES.some((s) => s !== "healthy" && (was.get(s) || 0) !== (is.get(s) || 0));
    if (moved) continue;
    if ((p.ruleCount || 0) !== (f.ruleCount || 0)) continue;
    suspicious.push({ path: f.path, from: p.score, to: f.score });
  }
  if (!suspicious.length) return;
  out.push("**Grades rose with nothing else changing.** These files score higher and");
  out.push("carry the same rules, the same dead references and the same disagreements as");
  out.push("before. That is what a rewrite aimed at the rubric looks like from here, and");
  out.push("it is also what a genuinely clearer rewrite looks like — only reading both");
  out.push("versions tells them apart.");
  out.push("");
  for (const s of suspicious.slice(0, 6)) {
    out.push(`- ${mdPathLink(s.path)} — ${round3(s.from)} → ${round3(s.to)}`);
  }
  if (suspicious.length > 6) out.push(`- …and ${suspicious.length - 6} more`);
  out.push("");
}

// [Foreman: 062]
// The per-rule rewrite path caps each fix at one short bullet and never merges
// or moves rules across a file, so a file whose grade is dragged down by its
// shape — mostly narrative, most of its rules buried, or simply too long — can't
// be fixed rule by rule. This section names the file-level restructure instead.
// razor: advisory only, like Buried rules and Placement candidates — it never
// edits a file. The upgrade path is a whole-file fix mode; if one is ever built,
// it MUST ship a preservation check that token-diffs version numbers, paths,
// backticked identifiers, and quoted lines old against new before writing. That
// guard is the ceiling here — detection now, safe rewriting later.
function restructureCandidates(audit) {
  const candidates = [];
  // [Foreman: 080] "Split into scoped `.claude/rules/` files" is advice about a
  // mechanism one host has. The noun comes off the record's profile so the same
  // detection gives the right instruction under either one.
  const scopedRules = profileNouns(audit).scopedRules;
  audit.files.forEach((f, i) => {
    const own = audit.rules.filter((r) => !r.suppressed && r.fileIndex === i);
    const belowMid = own.filter((r) => r.factorValues.F5 <= THRESHOLDS.buriedF5);
    const belowShare = own.length ? belowMid.length / own.length : 0;
    const reasons = [];
    const restructures = [];
    // [ADR 2026-08-05 D2] Gated on file length like the below-midpoint reason
    // just below: a short, mostly-prose CLAUDE.md is a fine repo description, not
    // a restructure. This is assay's own consistency call (F5 already exempts
    // ≤50-line files), backed by a labeled fixture — no host doc is cited.
    if (f.narrativeShare != null && f.narrativeShare >= RESTRUCTURE_NARRATIVE_SHARE && f.lineCount > LONG_FILE_LINES) {
      reasons.push(`${Math.round(f.narrativeShare * 100)}% narrative`);
      restructures.push("Fence the narrative with an `<!-- assay-ignore-start -->` / `<!-- assay-ignore-end -->` span, or move it out of the rule file.");
    }
    // A short file scores every rule F5 0.95, so a below-midpoint share only
    // means anything once the file is long enough for position to bite, and it
    // needs two or more rules for a "share" to exist at all.
    if (own.length >= 2 && f.lineCount > LONG_FILE_LINES && belowShare >= RESTRUCTURE_BELOW_MIDPOINT) {
      reasons.push(`${belowMid.length} of ${own.length} rules below the midpoint`);
      restructures.push(`Move the load-bearing rules into the top quarter, or split into ${scopedRules}.`);
    }
    if (f.lineCount > RESTRUCTURE_LONG_FILE_LINES) {
      reasons.push(`${f.lineCount} lines`);
      restructures.push(`Split into ${scopedRules} by topic.`);
    }
    if (reasons.length) candidates.push({ path: f.path, reasons, restructures });
  });
  return candidates;
}

// [Foreman: 066] One line per pair: both sites clickable, the tier's evidence
// tag, and which copy looks worth keeping. The wording stays a suggestion —
// assay names the removal candidate and edits nothing.
// [Foreman: 078] Read out of the duplicate findings, never re-paired here: the
// tier, the keeper and the reason all travel with the finding.
function pushDuplicateSection(out, dupes, span) {
  out.push("### Duplicates");
  out.push("");
  out.push("The same duty stated twice. Both copies are graded — a duplicate never moves a score or the corpus grade — and assay edits neither: pick which one survives.");
  out.push("");
  for (const f of dupes) {
    const [a, b] = f.sources;
    out.push(`- ${span(a)} ↔ ${span(b)} — ${f.tier} copy ${evidenceTag(f.evidence)} — consider keeping ${span(f.keep)} (${f.keepWhy}); ${span(f.drop)} is the removal candidate`);
  }
  out.push("");
}

function pushRestructureSection(out, shapes) {
  out.push("### Restructure candidates");
  out.push("");
  out.push("These files score low because of their shape, not their wording — a per-rule rewrite can't reach the problem. Reshape the file itself: [heuristic]");
  out.push("");
  for (const f of shapes) {
    const p = f.sources[0].path;
    out.push(`- ${mdPathLink(p)} — ${(f.reasons || []).join(", ")}`);
    for (const r of f.safeActions) out.push(`  - ${r}`);
  }
  out.push("");
}

// [Foreman: 074]
// Files Claude loads for this project that do not live in it. Graded on the same
// rubric and kept in their own table, because the fix for one of these is in the
// reader's own setup, not in this repo.
// [Foreman: 097] How many rules from outside the repository the report lists
// before pointing at the record. These are somebody else's to fix, and the list
// ran to 27 lines inside a report whose whole problem was its length.
const OUTSIDE_LIST_CAP = 6;

function pushOutsideWeak(out, label, weak, helpers) {
  if (!weak.length || !helpers) return;
  out.push(`${label} (${weak.length}), worst first:`);
  out.push("");
  for (const r of weak.slice(0, OUTSIDE_LIST_CAP)) {
    out.push(`- ${helpers.ruleLink(r, 60)} — ${r.grade} (${fmt(r.score)})`);
  }
  if (weak.length > OUTSIDE_LIST_CAP) {
    out.push(`- …and ${weak.length - OUTSIDE_LIST_CAP} more — every one is in \`--json\``);
  }
  out.push("");
}

function pushUserScopeSection(out, files, userWeak = [], helpers = null) {
  const userFiles = files.filter((f) => f.scope === "user");
  if (!userFiles.length) return;
  out.push("### User scope");
  out.push("");
  // [Foreman: 097] Some of these are the host's own auto-memory notes, written by
  // the assistant rather than by the reader, so the section no longer calls the
  // whole set "your own files".
  out.push("These load for every project on this machine — your own instruction files, and the notes the assistant keeps for this project. They are graded here but left out of the project grade, and nothing in them can fail a build: fix them where they live, or rerun with `--project-only` to leave them out entirely.");
  out.push("");
  out.push("| File | Rules | Grade |");
  out.push("|---|---|---|");
  for (const f of userFiles) {
    const g = f.grade === null ? "—" : `${f.grade} (${fmt(f.score)})`;
    const label = mdPathLink(f.path);
    out.push(`| ${label} | ${f.ruleCount} | ${g} |`);
  }
  out.push("");
  // [Foreman: 091] User weak rules render here, beside the files they belong
  // to, instead of inside the project's fix list.
  pushOutsideWeak(out, "Weak rules in these files", userWeak, helpers);
}

// [Foreman: 093]
// CLAUDE.md files in directories above the project root. The host reads them
// before the project's own memory for every session started here; the fix for
// one belongs to the directory that owns it, so like user scope they get their
// own table and never move the project grade.
function pushAncestorScopeSection(out, files, ancestorWeak = [], helpers = null) {
  const ancestorFiles = files.filter((f) => f.scope === "ancestor");
  if (!ancestorFiles.length) return;
  out.push("### Above the project root");
  out.push("");
  out.push("These sit in parent directories of this project and load, in full, for every session started here — outermost first. They are graded but left out of the project grade: the fix lives in the directory that owns each file, or in `claudeMdExcludes` in your own settings.");
  out.push("");
  out.push("| File | Rules | Grade |");
  out.push("|---|---|---|");
  for (const f of ancestorFiles) {
    const g = f.grade === null ? "—" : `${f.grade} (${fmt(f.score)})`;
    const label = mdPathLink(f.path);
    out.push(`| ${label} | ${f.ruleCount} | ${g} |`);
  }
  out.push("");
  pushOutsideWeak(out, "Weak rules above the root", ancestorWeak, helpers);
}

// [Foreman: 079]
// The resolved instruction chain: every directory the host reads, what was
// selected there and why, what lost the selection, the merge order, and the
// running byte total against the documented cap. Built entirely from the source
// facts the adapter declared — the renderer resolves nothing.
//
// It renders for any profile whose sources carry a read-order offset, which is
// the mechanical signal that the host reads its sources as an ordered chain
// under a budget. A profile without one (Claude Code today) never reaches it.
function chainRows(files) {
  return (files || []).filter((f) => Number.isInteger(f.startsAtByte) || f.shadowedBy);
}

// The Files table's Loading cell. Every branch reads a
// fact the adapter declared — a file the host never opens must never read as
// "always loaded" because it happens to carry no scope declaration.
function loadingCell(f) {
  if (f.selected === false) return "not loaded — shadowed";
  if (f.loaded === false) return "not loaded — past the host's byte cap";
  if (f.truncated) return "crosses the host's byte cap at byte " + f.truncatedAtByte;
  if (f.globs && f.globs.length) return "scoped: " + f.globs.join(", ");
  return "always loaded";
}

function chainStatus(file) {
  if (file.selected === false) return "shadowed by `" + file.shadowedBy + "`";
  if (file.loaded === false) return "**not read** — begins past the cap";
  if (file.truncated) {
    return `**crosses the cap** at byte ${file.truncatedAtByte}` +
      (Number.isInteger(file.truncatedAtLine) ? ` (line ${file.truncatedAtLine})` : "");
  }
  return "read in full";
}

// [Foreman: 169] The ACTIVE style is a graded source and appears with the rest
// of the corpus. What no table above can show is the styles sitting beside it:
// each is one `/config` away from replacing the system prompt, and a rule that
// survives this audit can be overridden by any of them in the next session.
function pushOutputStyleSection(out, audit) {
  const inventory = ((audit.outputStyles || {}).styles || []).filter((st) => !st.active);
  if (!inventory.length) return;
  out.push("### Output styles on disk but not loaded");
  out.push("");
  out.push("Selecting one of these replaces the system prompt for every turn of the next session. They are not graded here — they are not loaded. [mechanical]");
  out.push("");
  for (const st of inventory) {
    out.push("- " + mdPathLink(st.path) + " — `" + st.name + "`" +
      (st.description ? ": " + escapeTableCell(st.description) : "") +
      (st.keepCodingInstructions ? "" : " (drops the built-in engineering instructions)"));
  }
  out.push("");
}

function pushChainSection(out, files, budget) {
  const rows = chainRows(files);
  if (!rows.length) return;
  out.push("## Instruction chain");
  out.push("");
  out.push("The order the host reads these in, and where its budget runs out. A file lower in the table is the later word; a file the host never opens takes no effect whatever it says. [mechanical]");
  out.push("");
  out.push("| # | Source | Bytes | From | Status | Why |");
  out.push("|---|---|---|---|---|---|");
  // The # column is the read order — the same counting the Why column's "chain
  // position N of M" uses. A shadowed variant is never read, so it gets no
  // number.
  let position = 0;
  for (const f of rows) {
    const from = Number.isInteger(f.startsAtByte) ? String(f.startsAtByte) : "—";
    const pos = Number.isInteger(f.startsAtByte) ? String(++position) : "—";
    out.push(`| ${pos} | ${mdPathLink(f.path)} | ${f.bytes == null ? "—" : f.bytes} | ${from} | ${chainStatus(f)} | ${f.selectionReason || ""} |`);
  }
  out.push("");
  if (budget) {
    const total = rows.filter((f) => Number.isInteger(f.startsAtByte)).reduce((n, f) => n + (f.bytes || 0), 0);
    out.push(`Chain total ${total} bytes against a documented ${budget.amount}-byte cap (${budget.source}) — ${budget.scope}.`);
    out.push("");
  }
}

// [Foreman: 070]
// Every count above is over what the audit actually parsed, and until this block
// existed nothing said what that excluded. It prints on every report, not just
// --verbose: the suppressed ROWS stay verbose-only, but a silent drop is the one
// thing the verification pass must never do, so its count belongs here.
// razor: counts and one line per unreadable source — not a per-file table. The
// per-file breakdown already exists under "## Files".
// [Foreman: 078] The coverage story as data rather than as prose the report
// writes inline, so a second view of it would say the same sentences instead of
// inventing its own. `finding` names the finding a line stands for, wherever one
// exists.
function coverageLines(audit, rules, suppressed, findings) {
  const cov = audit.coverage || {};
  const parsed = cov.filesParsed != null ? cov.filesParsed : audit.files.length;
  const discovered = cov.filesDiscovered != null ? cov.filesDiscovered : parsed;
  const out = [];
  const add = (text, finding = null, depth = 0) => out.push({ text, finding, depth });
  // [Foreman: 084] "graded" is a claim, so it counts the rules a rubric actually
  // read. A rule set aside for its language is extracted and inventoried; saying
  // it was graded would be the exact overreach the mode vocabulary exists to
  // stop. With an all-English corpus the two numbers are equal and the line
  // reads as it always did.
  const gradedRules = rules.filter(englishScored).length;
  add(`${parsed} of ${discovered} instruction file(s) parsed, ${gradedRules} rule(s) graded` +
    (gradedRules === rules.length ? "" : ` of ${rules.length} extracted`) +
    `, ${cov.proseChunks || 0} prose chunk(s) set aside`);
  add(`${cov.excludedLines || 0} line(s) excluded from grading (assay-ignore spans, tag bodies, comment-only lines)`);
  // [Foreman: 076] What every session pays before it reads anything. The count
  // always prints; it only becomes a finding above assay's own threshold, and
  // the finding says the host documents no cap of its own.
  // [Foreman: 079] Where the host documents a cap, the bytes are reported
  // against it — the number a reader needs is how much of the budget is spent,
  // not an abstract total.
  const budget = cov.budget;
  if (budget) {
    const inChain = (audit.files || []).filter((f) => Number.isInteger(f.startsAtByte));
    const chainBytes = inChain.reduce((n, f) => n + (f.bytes || 0), 0);
    add(`${chainBytes} bytes of instructions across ${inChain.length} source(s), against a documented ${budget.amount}-byte cap (${budget.source}, ${budget.scope})`);
  } else {
    add(`${alwaysLoadedBytes(audit).total} bytes of always-loaded instructions (user, above-root and project memory, unscoped rules)`);
  }
  // [Foreman: 090] Files that entered the loaded set indirectly. Counted here
  // so "N files parsed" is never read as "N files sit beside the root".
  const nestedCount = (audit.sources || []).filter((s) => s.nested).length;
  if (nestedCount) add(`${nestedCount} nested CLAUDE.md file(s) — each loads only when Claude works in its directory`);
  const importedCount = (audit.sources || []).filter((s) => s.imported).length;
  if (importedCount) add(`${importedCount} file(s) pulled in by @path imports, graded like the files that import them`);
  const pressure = (findings || []).find((f) => f.type === "context-pressure");
  if (pressure) add(`${pressure.summary} ${evidenceTag(pressure.evidence)} — ${pressure.evidence.limits}`, pressure, 1);
  // [Foreman: 085] The pairwise analyses that did not run, named with the number
  // that stopped them — never left to read as "no duplicates, no conflicts".
  if (cov.pairwiseSkipped) {
    add(`${cov.pairwiseSkipped} rules exceed the pairwise-analysis cap of ${PAIRWISE_RULE_CAP} — duplicate and conflict detection did not run; every other check did`);
  }
  // [Foreman: 079] What this profile does not cover, in the profile's own words.
  // Coverage is a promise about what was looked at; a profile that analyzes one
  // surface of a host says so here rather than letting an empty section imply
  // there was nothing to find.
  for (const note of cov.profileNotes || []) add(note);
  // [Foreman: 071] The coverage gap the deterministic default opens, named where
  // every other gap is named. What did not run is part of what the audit covered.
  if (!audit.semantic) {
    add("model-judged checks did not run (trigger clarity, enforceability, rule-verification); deterministic findings only");
  }
  if (suppressed.length) {
    add(`${suppressed.length} entr${suppressed.length === 1 ? "y" : "ies"} suppressed by the verification pass as not rules — rerun with \`--verbose\` to see each one with its reason`);
  }
  // [Foreman: 084] Per mode, so the report's numbers never silently cover text
  // the rubric could not read. This generalizes the non-Latin line rather than
  // sitting beside it — one vocabulary, one count.
  const byMode = new Map();
  for (const subject of [...rules, ...(audit.skills || [])]) {
    if (englishScored(subject)) continue;
    byMode.set(subject.languageMode, (byMode.get(subject.languageMode) || 0) + 1);
  }
  for (const mode of [...byMode.keys()].sort()) {
    add(`${byMode.get(mode)} rule(s) or skill description(s) read as ${languageModeLabel(mode)} (\`${mode}\`) — set aside from English wording checks and from every grade; the mechanical findings still cover them`);
  }
  const badCategories = rules.filter((r) => r.invalidCategory).length;
  if (badCategories) add(`${badCategories} unknown category annotation(s) — listed below`);
  // [Foreman: 073] A construct the parser could not map faithfully is named
  // here rather than quietly read as prose. It lowers coverage; it never
  // becomes an inferred non-rule.
  // [Foreman: 078] Named one by one, not only counted — a construct nothing
  // names is a finding the reader cannot act on.
  const constructs = (findings || []).filter((f) => f.type === "unsupported-construct");
  if (constructs.length) {
    add(`${constructs.length} unsupported construct(s) — inventoried, not graded`);
    for (const f of constructs) {
      add(`\`${displayPath(f.sources[0].path)}\`:${f.sources[0].lineStart} — ${f.summary}`, f, 1);
    }
  }
  // [Foreman: 074] Surfaces that exist and shape behavior but are not scored.
  const userSkills = (cov.userSkills || []).length;
  if (userSkills) add(`${userSkills} user skill(s) present — not graded`);
  const agents = (cov.agents || []).length;
  if (agents) add(`${agents} subagent(s) defined in \`.claude/agents/\` — descriptions graded like skill descriptions`);
  const unreadable = (findings || []).filter((f) => f.type === "inaccessible-source");
  for (const s of cov.inaccessible || []) {
    const f = unreadable.find((x) => (x.sources[0] || {}).path === s.path) || null;
    add(redactSecrets(`could not read \`${displayPath(s.path)}\` (${s.reason}) — nothing in it was graded`), f);
  }
  return out;
}

function pushCoverageSection(out, audit, rules, suppressed, findings) {
  out.push("## Coverage");
  out.push("");
  for (const line of coverageLines(audit, rules, suppressed, findings)) {
    out.push("  ".repeat(line.depth) + "- " + line.text);
  }
  out.push("");
}

// [Foreman: 077]
// The enforcement ladder: what this project has at each level, and the state
// chain of every mechanism in it. One line per level that has entries, plus the
// prose level read from the corpus itself.
//
// The standing line is the section's whole discipline: nothing here is evidence
// that anything ran. A hook listed at level 3 is a hook somebody wired, and that
// is all the report is allowed to say about it.
const MECHANISM_TYPE_WORDS = {
  skill: "skill", subagent: "subagent", hook: "hook",
  "repo-check": "repository check", "remote-gate": "remote gate",
};
const STATE_ORDER = ["configured", "enabled", "trusted", "applicable", "verified"];

// [Foreman: 097] The chain used to print in full on every mechanism —
// `configured ✓ · enabled ✓ · trusted ? · applicable ✓ · verified ✗`, five terms
// and three glyphs with no legend anywhere, repeated once per hook. Two of those
// five are the same on every entry of a type and are stated once per section
// instead; what is left is the one thing this mechanism does not share with its
// neighbours.
function stateException(states) {
  const notes = [];
  for (const k of STATE_ORDER) {
    if (k === "verified" || k === "configured") continue;
    if (states[k] === false) notes.push("not " + k);
  }
  return notes.join(", ");
}

// The two sentences that are true of every mechanism at a level. Said once, as a
// preamble, rather than under each entry.
const LADDER_BLANKET = new Set([MECHANISM_LIMITS.notExecuted, MECHANISM_LIMITS.trust, MECHANISM_LIMITS.routing]);

// [Foreman: 078] Every mechanism string a renderer prints goes through
// redaction — the name of a hook is a shell command out of settings.json.
function mechanismDetail(m) {
  return redactSecrets(m.type === "hook" ? `${(m.coverage.events || [])[0]}: ${m.name}` : m.name);
}

// The level line names what is there, not everything that is there: a project
// with two dozen plugin hooks would bury the ladder in one line. `--verbose`
// prints every entry with its state chain.
const LADDER_DETAIL_CAP = 4;

function groupBySource(mechanisms) {
  const bySource = new Map();
  for (const m of mechanisms) {
    const key = String(m.source);
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(m);
  }
  return [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function mechanismDetails(atLevel) {
  const shown = atLevel.slice(0, LADDER_DETAIL_CAP).map(mechanismDetail);
  const rest = atLevel.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
}

function pushLadderSection(out, audit, mechanisms, activeRules, opts, findings) {
  out.push("### Enforcement ladder");
  out.push("");
  out.push("A mechanism listed here is configured. Only validation can show it runs — assay never infers execution from presence.");
  out.push("");
  // [Foreman: 097] Said once, here, instead of under every entry. On a machine
  // with a few installed plugins those two sentences were 64 of this report's
  // lines, and repetition is not emphasis.
  out.push("Nothing below was watched running: this is what is wired, not what fires. A hook also needs a trusted workspace, which no static read can confirm, and a skill or subagent is reached by its description, which routes it without guaranteeing it.");
  out.push("");
  out.push(`- **Level 1 — ${MECHANISM_LEVEL_LABELS[1]}**: ${activeRules} active rule(s)`);
  for (const level of [2, 3, 4, 5]) {
    const atLevel = mechanisms.filter((m) => m.level === level);
    if (!atLevel.length) continue;
    const counts = [];
    for (const type of Object.keys(MECHANISM_TYPE_WORDS)) {
      const n = atLevel.filter((m) => m.type === type).length;
      if (n) counts.push(`${n} ${MECHANISM_TYPE_WORDS[type]}${n === 1 ? "" : "s"}`);
    }
    out.push(`- **Level ${level} — ${MECHANISM_LEVEL_LABELS[level]}**: ${counts.join(", ")} (${mechanismDetails(atLevel)}) — configured, not verified`);
    if (!opts.verbose) continue;
    // [Foreman: 097] This project's own mechanisms, one line each. The ones it
    // inherits — the reader's own settings, and every installed plugin — are
    // summarized per source: on a machine with a few plugins they were 26 of the
    // 33 lines here, and not one of them is a thing this repository can change.
    const own = atLevel.filter((m) => !/^(user|plugin: )/.test(String(m.source)));
    const inherited = atLevel.filter((m) => /^(user|plugin: )/.test(String(m.source)));
    for (const [source, group] of groupBySource(inherited)) {
      const events = [...new Set(group.map((m) => (m.coverage.events || [])[0]).filter(Boolean))];
      out.push(redactSecrets(`  - ${group.length} from ${source}${events.length ? " — " + events.join(", ") : ""}`));
    }
    for (const m of own) {
      // One line per mechanism, carrying the matcher — the fact a reader wants
      // and the one the sentence below it used to spend a whole line on.
      const cov = m.coverage || {};
      const matcher = (cov.matchers || [])[0];
      const reach = m.type === "hook"
        ? ` — ${(cov.events || [])[0]}${matcher && matcher !== "*" ? " on `" + matcher + "`" : ""}`
        : "";
      const off = stateException(m.states);
      out.push(redactSecrets(`  - ${m.id} \`${m.name}\` (${m.source})${reach}${off ? " — " + off : ""}`));
      // Only a limit this mechanism does NOT share with its neighbours: the
      // blanket two are in the preamble, and the matcher is on the line above.
      const matcherPrefix = matcher && matcher !== "*" ? "the `" + matcher + "` matcher" : null;
      for (const limit of cov.limits || []) {
        if (LADDER_BLANKET.has(limit)) continue;
        if (matcherPrefix && limit.startsWith(matcherPrefix)) continue;
        out.push(redactSecrets(`    - ${limit}`));
      }
    }
  }
  // [Foreman: 078] One name defined at two scopes is a property of the ladder,
  // so it prints here rather than being a finding no view ever shows.
  for (const f of (findings || []).filter((x) => x.type === "mechanism-overlap")) {
    out.push(`- ${redactSecrets(f.summary)} ${evidenceTag(f.evidence)}`);
  }
  // [Foreman: 091] A wired hook that cannot work is a ladder property too: the
  // level-3 count above includes it, so the break is named right beside it.
  for (const f of (findings || []).filter((x) => x.type === "hook-target-missing" || x.type === "hook-matcher-invalid")) {
    out.push(`- ${redactSecrets(f.summary)} ${evidenceTag(f.evidence)}`);
    pushSafeActions(out, f);
  }
  // A surface that exists and could not be read is a hole in this ladder, named
  // here rather than counted as an empty level.
  for (const s of ((audit.repoChecks || {}).inaccessible) || []) {
    out.push(redactSecrets(`- could not read \`${s.path}\` (${s.reason}) — any gate there is missing from this ladder`));
  }
  if (!opts.verbose) {
    out.push("");
    out.push("Rerun with `--verbose` to list every mechanism, with what each one reaches.");
  }
  out.push("");
}

// ---------------------------------------------------------------------------
// renderBrief — the default report
// ---------------------------------------------------------------------------

// [Foreman: 095]
// The report a person actually reads. Three properties define it, and each one
// is asserted by a release gate rather than left to taste:
//
//   G1  it fits on a screen                    (BRIEF_MAX_LINES)
//   G2  a rule is named once, never twice      (the `claim` bucketing below)
//   G3  no word in it needs host internals     (BRIEF_BANNED_WORDS)
//
// It derives nothing. Every list here is a filter over the same audit record
// renderReport reads; this function only chooses what a reader sees first and
// says it in words they had before they installed anything.
//
// razor: a filter, NOT a second report. --verbose routes to renderReport
// unchanged, and nothing is removed from the record — so the upgrade path from
// any line cut here is one flag, and there is no second rendering of a finding
// to keep in step with the first.

const BRIEF_MAX_LINES = 40;
const BRIEF_FIX_ROWS = 8;
const BRIEF_LIST_ITEMS = 4;

// The six wording factors said out loud, and the ONE vocabulary both reports
// use. `--verbose` adds the score and the kind of evidence around these
// sentences; it never replaces them with a terser second set of names.
const PLAIN_PROBLEMS = {
  F1: "no clear action",
  F2: "says what not to do, never what to do",
  F3: "no clear moment it applies",
  F4: "applies too broadly",
  F5: "buried near the bottom",
  F7: "too vague to act on",
};
// [Foreman: 097] F1 and F7 used to restate what the scorer measured. "Start with
// Use, Always, Never, or Run" applied literally to a line like "CHANGELOG entries
// are short" produces nonsense, and "name a path" is unfollowable advice for a
// rule that has no path to name. Both are edits now.
const PLAIN_FIXES = {
  F1: "Rewrite it as an instruction — name the action to take",
  F2: "Add what to do instead",
  F3: 'Say when it applies: "When editing X…"',
  F4: "Move it to a rules file that lists the paths",
  F5: "Move it nearer the top, or split the file",
  F7: "Name a file, a command, or show an example",
};

// [Foreman: 097] The words that made the "too vague" verdict. They are computed
// on every rule and were read by nobody, so six rows carried one identical
// sentence and the reader had to guess which word was the problem.
function vagueEvidence(rule) {
  const f7 = (rule.factors || {}).F7 || {};
  const abstract = (f7.abstract || []).slice(0, 2);
  if (abstract.length) {
    return {
      problem: `“${abstract.join("” and “")}” leave${abstract.length === 1 ? "s" : ""} the standard to the reader`,
      fix: "Say what passes and what does not",
    };
  }
  return { problem: PLAIN_PROBLEMS.F7, fix: PLAIN_FIXES.F7 };
}

// [Foreman: 095] G3's list. Every one of these is precise and every one of them
// asks the reader to know how the host loads files, what an evidence level is,
// or what the rubric measures. They all keep working in --verbose and in the
// JSON record; this is about the default view only.
const BRIEF_BANNED_WORDS = [
  "corpus", "mandate", "renormalized", "heuristic", "model-inferred",
  "experiment-supported", "evidence mix", "state chain", "configured, not verified",
  "enforcement ladder", "always-loaded", "unscoped", "advisory prose",
  "hygiene", "schema", "profile", "coverage", "provenance", "rubric",
];

// [Foreman: 097] The full report is where a confused reader is SENT, so the terms
// with an everyday twin are barred there too. This is deliberately a subset of
// the list above: `--verbose` is allowed to name an evidence level and a host
// profile, because those are what it exists to show. What it may not do is
// invent a second name for something the short report already said plainly.
const REPORT_BANNED_WORDS = ["renormalized", "evidence mix", "state chain", "advisory prose"];

function renderBrief(audit, opts = {}) {
  const out = [];
  // [Foreman: 097] `--top` raises both caps together without leaving the brief's
  // vocabulary — the two zoom levels used to be 8 rows or a 100-row table of
  // decimals, with nothing in between.
  const fixRows = Number.isInteger(opts.top) && opts.top > 0 ? opts.top : BRIEF_FIX_ROWS;
  const listItems = Number.isInteger(opts.top) && opts.top > 0 ? opts.top : BRIEF_LIST_ITEMS;
  const files = audit.files || [];
  const rules = (audit.rules || []).filter((r) => !r.suppressed);
  const findings = audit.findings || [];
  const rulesById = new Map(rules.map((r) => [r.id, r]));
  // A finding's source span carries the rule's own file and start line
  // (`ruleSpan`), so this is how a corpus finding — a conflict names a pair of
  // places, not a pair of ids — gets back to the rules it is about.
  const ruleAt = new Map(rules.map((r) => [r.file + ":" + r.lineStart, r]));

  // [Foreman: 097] One shared implementation; see mdPathLink.
  const showPath = displayPath;
  // A pipe in ANY cell splits the row into a phantom column, and the text in a
  // cell is not always the author's — a gate's reason and a stale reference are
  // built from paths, and a path may carry one. `truncate` gives the rule text
  // this guarantee; `cell` gives it to everything else in a row.
  const cell = escapeTableCell;
  // `cell` first, then `mdLabel`: the brackets `mdLabel` adds are for the link
  // and must not themselves be escaped again for the table.
  const where = (p, line) => mdPathLink(p, line);
  const at = (r) => where(r.file, r.lineStart);
  // A newline in a list item would end the item and break the section's shape.
  const oneLine = (s) => cell(String(s).replace(/\s*\n\s*/g, " "));
  // Brackets would break the link label the rule text sits in.
  const quote = (r, n) => '"' + truncateCell(r.text, n).replace(/[[\]]/g, "") + '"';

  // G2, mechanically. A rule lands in the first bucket that claims it and is
  // invisible to every bucket after — so "one rule, one line" is a property of
  // the data here, not a discipline the sections below have to remember.
  const claimed = new Set();
  const claim = (candidates) => {
    const kept = [];
    for (const r of candidates) {
      if (!r || claimed.has(r.id)) continue;
      claimed.add(r.id);
      kept.push(r);
    }
    return kept;
  };

  // The reader can only fix what they own. A rule of their own that loads from
  // outside the repository is real, and so is one inside a vendored repository,
  // and neither is this report's business.
  const outside = new Set(files.filter(notReadersOwn).map((f) => f.path));
  const mine = rules.filter((r) => !outside.has(r.file));

  // Bucket 1 — the host never applies it. Nothing else about the rule matters
  // until that is fixed, so this claims before anything else.
  //
  // [Foreman: 097] `blocked` is NOT here, though it shares the hard-gate set. A
  // blocked rule loads perfectly; what is missing is a file it cites. It belongs
  // to the stale bucket below, which already has the true sentence and the fix
  // that repairs it — and bucket 1's own words ("never reaches the assistant")
  // were written for a rule the host does not read at all.
  const gateFindings = findings.filter((f) => HARD_GATE_STATES.has(f.state) && f.state !== "blocked");
  const gateBy = new Map(gateFindings.map((f) => [f.rule, f]));
  const gated = claim(gateFindings.map((f) => rulesById.get(f.rule)).filter((r) => r && !outside.has(r.file)));

  // Bucket 2 — two rules that argue. Every side is claimed by the group,
  // because it is one problem with one decision behind it and no half can be
  // edited alone. [Foreman: 097] A group may carry more than two spans when the
  // same disagreement was copied into several files; it is still one row.
  const conflictRows = [];
  for (const f of findings) {
    if (f.type !== "conflict" && f.type !== "conditional-conflict") continue;
    const spans = f.sources || [];
    if (spans.length < 2) continue;
    claim(spans.map((s) => ruleAt.get(s.path + ":" + s.lineStart)));
    conflictRows.push({ spans });
  }

  // Bucket 3 — points at a file that is not there. Mechanical and certain, so
  // it outranks anything about wording.
  const stale = claim(mine.filter((r) => r.staleness && r.staleness.missing.length));

  // Bucket 4 — [Foreman: 097] one duty written twice. Mechanical like a dead
  // path, one decision like a conflict, and the README sells it as a headline
  // capability the default report never mentioned. Every copy is claimed by the
  // row, because deciding which one survives settles all of them at once.
  const duplicateRows = [];
  for (const f of findings) {
    if (f.type !== "duplicate") continue;
    const spans = (f.sources || []).filter((s) => !outside.has(s.path));
    if (spans.length < 2) continue;
    const kept = claim(spans.map((s) => ruleAt.get(s.path + ":" + s.lineStart)));
    if (!kept.length) continue;
    duplicateRows.push({ finding: f, spans, rule: kept[0] });
  }

  // Bucket 5 — the wording itself. This is what the rewrite option repairs.
  // [Foreman: 097] A rule every session reads outranks one only some sessions
  // reach, so an always-loaded rule sorts above a nested one at the same score.
  const alwaysLoadedFiles = new Set(files.filter((f) => f.alwaysLoaded).map((f) => f.path));
  const blastRadius = (r) => (alwaysLoadedFiles.has(r.file) ? 0 : 1);
  const weak = claim(mine.filter((r) => r.weak)
    .sort((a, b) => blastRadius(a) - blastRadius(b) || a.score - b.score));

  // Bucket 6 — a script could do this instead of asking the model to remember.
  // [Foreman: 097] A rule a wired hook already covers leaves this list: telling
  // the reader to automate what is already automated is the opposite of a next
  // step. It gets its own line below instead.
  const alreadyWired = new Set(findings.filter((f) => f.type === "redundant-enforcement").map((f) => f.rule));
  const mechanical = claim(mine.filter((r) => (r.hookOpportunity || r.placement) && !alreadyWired.has(r.id)));
  const covered = mine.filter((r) => alreadyWired.has(r.id));

  // Bucket 7 — sound, but sitting where it gets skimmed.
  const buried = claim(mine.filter((r) => (r.factorValues || {}).F5 <= THRESHOLDS.buriedF5));

  // [Foreman: 097] Filtered by the same `outside` set the fix buckets use. This
  // list is the FIRST advice in the report, and it was telling the reader to
  // restructure the host's own memory notes — files this repository does not own
  // and no edit here would keep.
  const shapes = findings.filter((f) => f.type === "file-shape" && (f.sources || []).length &&
    !outside.has(f.sources[0].path));
  const weakDescriptions = (audit.skills || []).filter(isWeakSkill)
    .map((s) => ({ kind: "skill", name: s.name, issues: skillIssues(s) }))
    .concat((((audit.coverage || {}).agents) || []).filter(isWeakAgent)
      .map((a) => ({ kind: "subagent", name: a.name, issues: skillIssues(a) })));
  // Rules of the reader's own that load from outside this repository. They are
  // real and they are not fixable here, so they get a pointer rather than a
  // place in the fix list — but never silence, which would read as "clean".
  const weakOutside = rules.filter((r) => outside.has(r.file) && r.weak).length;

  // --- the report -----------------------------------------------------------

  out.push("# assay — " + path.basename(audit.root || "."));
  out.push("");

  // A conflict is one row but two rules, so it gets its own clause rather than
  // being counted as a rule and quietly halving itself.
  // [Foreman: 097] A dead path is its own clause too: "needs work" reads as a
  // wording problem, and a missing file is not one.
  const needWork = weak.length;
  const fixCount = gated.length + conflictRows.length + stale.length + duplicateRows.length + needWork;
  const headline = [];
  if (gated.length) headline.push(`**${gated.length} ${gated.length === 1 ? "rule never loads" : "rules never load"}.**`);
  if (conflictRows.length) headline.push(`**${conflictRows.length} ${conflictRows.length === 1 ? "pair of rules disagrees" : "pairs of rules disagree"}.**`);
  if (stale.length) headline.push(`**${stale.length} ${stale.length === 1 ? "rule points" : "rules point"} at files that aren't there.**`);
  if (duplicateRows.length) headline.push(`**${duplicateRows.length} ${duplicateRows.length === 1 ? "duty is stated" : "duties are stated"} twice.**`);
  if (needWork) headline.push(`**${needWork} ${needWork === 1 ? "rule needs" : "rules need"} work.**`);
  if (mechanical.length) headline.push(`${mechanical.length} more could be handled by a script instead.`);
  const noRules = mine.length === 0;
  if (!fixCount && !mechanical.length) {
    // Only the rules this repository owns can be called clean here, and only
    // when nothing else below has something to say.
    // [Foreman: 097] A project with no rules at all is not a clean project. It
    // used to be congratulated in the same words as an audited one.
    headline.push(noRules
      ? "**No rules to look at yet.**"
      : (weakOutside || weakDescriptions.length || shapes.length || buried.length
        ? "**Nothing in this repo's rules needs fixing.**"
        : "**Nothing here needs fixing.**"));
  }
  // The rule count is the project's own rules, so it can never disagree with the
  // buckets underneath it.
  //
  // [Foreman: 143] The file count is every file this report READ, which is the
  // same population the provenance line names below — not the subset that
  // happened to yield a rule. A live run said "126 rules in 12 files" over a
  // provenance line naming 22, because one number counted files-with-rules and
  // the other counted files-read. A read file that produced no rule was still
  // looked at, and saying so is the honest half of "looked at".
  const nFiles = files.filter((f) => !outside.has(f.path)).length;
  // [Foreman: 097] On a monorepo a nested `CLAUDE.md` loads only when Claude is
  // working in its folder, and flattening it into one count left the reader with
  // no way to tell a rule every session reads from one a few sessions do.
  const nestedPaths = new Set(files.filter((f) => f.nested).map((f) => f.path));
  const nested = mine.filter((r) => nestedPaths.has(r.file)).length;
  const scopeNote = nested
    ? ` ${nested} of ${nested === 1 ? "them loads" : "them load"} only when Claude works in ${nested === 1 ? "its" : "their"} own folder.`
    : "";
  out.push(`Looked at ${mine.length} ${mine.length === 1 ? "rule" : "rules"} in ${nFiles} ${nFiles === 1 ? "file" : "files"}.${scopeNote} ` + headline.join(" "));

  // [Foreman: 097]
  // What this run read, and which whole classes of check did not run on it.
  // Before this line the reader could not tell "nothing is wrong" from "nothing
  // was looked at": a deterministic run, a corpus past the pairing cap, an
  // unreadable file, a host whose wording checks are withheld, and a rule in a
  // language assay does not score all produced the same confident silence. It
  // sits directly under the headline, unseparated, so the two read as one
  // paragraph about this run and it costs the budget one line.
  const cov = audit.coverage || {};
  const notRun = [];
  if (!audit.semantic) {
    notRun.push("whether each rule names a clear moment to act, and whether a script could do the job instead");
  }
  if (cov.pairwiseSkipped) {
    notRun.push(`whether any two rules repeat or disagree — that comparison stops at ${PAIRWISE_RULE_CAP} rules and there are ${cov.pairwiseSkipped}`);
  }
  if (profilePolicy(audit).wordingRubric === false) {
    notRun.push("how the rules are worded — those checks are only measured on one kind of host, and this is not it");
  }
  const unscored = rules.filter((r) => !englishScored(r)).length;
  if (unscored) notRun.push(`the wording of ${unscored} ${unscored === 1 ? "rule" : "rules"} not written in English`);
  const provenance = [];
  const readNames = files.filter((f) => !outside.has(f.path)).map((f) => "`" + oneLine(showPath(f.path)) + "`");
  if (readNames.length) {
    provenance.push(`Read ${readNames.slice(0, 4).join(", ")}${readNames.length > 4 ? `, and ${readNames.length - 4} more` : ""}.`);
  }
  if (notRun.length) provenance.push(`Did not check: ${notRun.join("; ")}.`);
  const unread = (cov.inaccessible || []).map((s) => "`" + oneLine(showPath(s.path)) + "`");
  if (unread.length) {
    provenance.push(`Could not read ${unread.slice(0, 2).join(", ")}${unread.length > 2 ? `, and ${unread.length - 2} more` : ""} — nothing in ${unread.length === 1 ? "it" : "them"} was looked at.`);
  }
  // [Foreman: 097] The single most useful sentence in the report on a machine
  // with auto memory: most of what was graded is not in this repository at all.
  // It used to be pushed last into a four-item list and truncated away, so the
  // reader saw "17 rules" beside a scan of 100 with nothing reconciling them.
  const elsewhere = rules.length - mine.length;
  if (elsewhere > 0) {
    provenance.push(`${elsewhere} more ${elsewhere === 1 ? "rule loads" : "rules load"} from outside this repo — \`--project-only\` leaves ${elsewhere === 1 ? "it" : "them"} out.`);
  }
  // [Foreman: 141] Listed, never gated. A vendored repository's rules load and
  // the reader should know they are in context — but they are somebody else's
  // file, so naming the folder is the whole of what this report can usefully
  // say about them.
  const vendoredRoots = [...new Set(files.filter((f) => f.vendored && f.vendoredRoot).map((f) => f.vendoredRoot))].sort();
  if (vendoredRoots.length) {
    const shown = vendoredRoots.slice(0, 3).map((v) => "`" + oneLine(showPath(v)) + "`").join(", ");
    const more = vendoredRoots.length > 3 ? `, and ${vendoredRoots.length - 3} more` : "";
    provenance.push(`${shown}${more} ${vendoredRoots.length === 1 ? "is a repository" : "are repositories"} vendored inside this one — its rules load, and nothing here offers to rewrite a file you do not own.`);
  }
  // Where the run decided the project was, when it was not simply told.
  const walkedFrom = (audit.context || {}).rootFoundFrom;
  if (walkedFrom) {
    provenance.push(`Started in \`${oneLine(showPath(walkedFrom))}\` and used \`${oneLine(showPath(audit.root))}\` as the project.`);
  }
  if (provenance.length) out.push(provenance.join(" "));
  out.push("");

  if (fixCount) {
    out.push("## Fix these first");
    out.push("");
    out.push("| Rule | Where | Problem | Fix |");
    out.push("|---|---|---|---|");
    // [Foreman: 142] One list per class, not one flat list. Order still matches
    // `claim()` — a rule the host never reads outranks a pair that argues, which
    // outranks a dead path, which outranks wording — but a flat list plus a cap
    // let one crowded class take every seat. A live run with 20 dead paths and
    // 20 weak rules printed eight dead paths and then closed by telling the
    // reader to rewrite the weak ones it had never shown them.
    const buckets = [
      { key: "gated", label: "the host never loads", rows: [] },
      { key: "conflicts", label: "that disagree", rows: [] },
      { key: "stale", label: "pointing at a file that is not there", rows: [] },
      { key: "duplicates", label: "written twice", rows: [] },
      { key: "weak", label: "weakly worded", rows: [] },
    ];
    const bucket = Object.fromEntries(buckets.map((b) => [b.key, b.rows]));
    // [Foreman: 097] Both cells are the finding's own words. A hardcoded sentence
    // here is a second opinion about a rule the analyzer already diagnosed, and
    // it was wrong on the states it had not been written for.
    for (const r of gated) {
      const f = gateBy.get(r.id);
      const why = (f && f.summary) || "the host never loads it";
      const fix = (f && (f.safeActions || [])[0]) || "move it to a file that gets read";
      bucket.gated.push(`| ${quote(r, 46)} | ${at(r)} | ${cell(oneLine(why))} | ${cell(upperFirst(oneLine(fix)))} |`);
    }
    for (const { spans } of conflictRows) {
      const where2 = spans.slice(0, 2).map((s) => where(s.path, s.lineStart)).join(" and ");
      const more = spans.length > 2 ? ` and ${spans.length - 2} more` : "";
      bucket.conflicts.push(`| two rules disagree | ${where2}${more} | one bans what the other asks for | Decide which one you meant, then drop or narrow the other |`);
    }
    for (const r of stale) {
      const missing = (r.staleness && r.staleness.missing) || [];
      const refs = missing.slice(0, 2).map((m) => cell("`" + m.ref + "`")).join(", ");
      const rest = missing.length > 2 ? ` and ${missing.length - 2} more` : "";
      bucket.stale.push(`| ${quote(r, 46)} | ${at(r)} | points at ${refs}${rest}, which is not there | Fix the path, or drop the mention |`);
    }
    // [Foreman: 097] One duty, one row, every address on it — a duplicated rule
    // used to print as two unrelated wording problems.
    for (const { finding, spans } of duplicateRows) {
      const where2 = spans.slice(0, 2).map((s) => where(s.path, s.lineStart)).join(" and ");
      const more = spans.length > 2 ? ` and ${spans.length - 2} more` : "";
      const how = finding.tier === "exact" ? "the same rule is written twice" : "two rules say nearly the same thing";
      const keep = finding.keep ? `Keep ${cell(showPath(finding.keep.path))}:${finding.keep.lineStart} — ${cell(finding.keepWhy || "stated first")} — and drop the other` : "Decide which copy survives, then drop the other";
      bucket.duplicates.push(`| ${how} | ${where2}${more} | one duty in two places, graded twice | ${keep} |`);
    }
    for (const r of weak) {
      const names = rowWeaknesses(r);
      // [Foreman: 097] The vague verdict quotes the words that caused it, so six
      // rows stop carrying one identical sentence.
      const evidence = vagueEvidence(r);
      const problems = names.map((n) => (n === "F7" ? evidence.problem : PLAIN_PROBLEMS[n])).join("; ");
      // [Foreman: 097] A mechanism annotates rather than competes. A rule a script
      // should own is normally a terse imperative, which is exactly what scores
      // low on concreteness — so wording claimed it and the mechanism advice was
      // never printed anywhere. The row stays one row; only its Fix cell changes.
      const owner = r.placement ? r.placement.bestFit : (r.hookOpportunity ? "hook" : null);
      let fixes;
      if (alreadyWired.has(r.id)) {
        fixes = "A hook is already wired for this — check it covers the rule, then decide whether to keep the prose";
      } else if (owner) {
        fixes = `A ${owner} could do this on every run — build that instead of rewording it`;
      } else {
        fixes = names.map((n) => (n === "F7" ? evidence.fix : PLAIN_FIXES[n])).filter(Boolean).join("; ");
      }
      bucket.weak.push(`| ${quote(r, 46)} | ${at(r)} | ${cell(problems)} | ${cell(fixes)} |`);
    }
    // [Foreman: 142] Every class present gets one seat before any class gets a
    // second; the seats left over then go in priority order, so the most urgent
    // class still fills most of the table. The reader sees every kind of problem
    // they have, and the closing line never offers a repair for something the
    // table withheld.
    const used = buckets.map(() => 0);
    let seated = 0;
    for (let i = 0; i < buckets.length && seated < fixRows; i++) {
      if (buckets[i].rows.length) { used[i] = 1; seated++; }
    }
    for (let i = 0; i < buckets.length && seated < fixRows; i++) {
      const room = Math.min(buckets[i].rows.length - used[i], fixRows - seated);
      used[i] += room;
      seated += room;
    }
    buckets.forEach((b, i) => { for (let k = 0; k < used[i]; k++) out.push(b.rows[k]); });
    out.push("");
    const withheld = buckets.map((b, i) => ({ label: b.label, n: b.rows.length - used[i] })).filter((c) => c.n > 0);
    const total = buckets.reduce((s, b) => s + b.rows.length, 0);
    if (total > seated) {
      // Naming the classes is the point: a bare count reads as "more of the same".
      const what = withheld.map((c) => `${c.n} ${c.label}`).join(", ");
      out.push(`${total - seated} more not shown here — ${what}. Run \`--top ${Math.min(total, 40)}\` for more rows, or \`--verbose\` for the full list.`);
      out.push("");
    }
  }

  if (mechanical.length) {
    out.push("## Could be automatic instead");
    out.push("");
    out.push("A script could check these on every run, instead of counting on them being remembered:");
    out.push("");
    for (const r of mechanical.slice(0, listItems)) out.push(`- ${at(r)} — ${quote(r, 66)}`);
    if (mechanical.length > listItems) out.push(`- …and ${mechanical.length - listItems} more`);
    out.push("");
  }

  // Everything that belongs here is collected before the cap is applied, so the
  // "…and N more" line counts every entry withheld and not just some of them.
  const also = [];
  // [Foreman: 144] File-shape advice is per-SHAPE, not per-file, so three files
  // with the same problem used to print the same sentence three times. Group by
  // the advice: say it once as a lead, list the files under it, and keep a
  // per-file line only where the advice actually differs. 1.14.0 did this for
  // the full report's blanket caveats; the short report never got the same
  // treatment, and its one list is where the repetition showed.
  const byAdvice = new Map();
  for (const f of shapes) {
    const advice = oneLine((f.safeActions || [])[0] || "reshape this file");
    if (!byAdvice.has(advice)) byAdvice.set(advice, []);
    byAdvice.get(advice).push(f.sources[0].path);
  }
  for (const [advice, paths] of byAdvice) {
    if (paths.length === 1) {
      also.push(`- ${mdPathLink(paths[0])} — ${advice}`);
    } else {
      also.push(`- ${paths.map(mdPathLink).join(", ")} — ${advice}`);
    }
  }
  if (covered.length) {
    // [Foreman: 097] Configured, not watched running — so the next step is to
    // check the hook, never to trust it.
    also.push(`- ${covered.length} ${covered.length === 1 ? "rule is" : "rules are"} already handled by a hook — check the hook covers ${covered.length === 1 ? "it" : "them"}, then decide whether to keep the prose.`);
  }
  if (buried.length) {
    // [Foreman: 097] Name the file. "4 rules sit near the bottom of a long file"
    // named no file, no rule and no link, so there was nowhere to go from it.
    const byFile = new Map();
    for (const r of buried) byFile.set(r.file, (byFile.get(r.file) || 0) + 1);
    const worst = [...byFile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const elsewhere = buried.length - worst[1];
    also.push(`- ${worst[1]} ${worst[1] === 1 ? "rule sits" : "rules sit"} near the bottom of ${mdPathLink(worst[0])}${elsewhere ? `, and ${elsewhere} more elsewhere` : ""}, where they get skimmed — move the important ones up.`);
  }
  for (const d of weakDescriptions) {
    also.push(`- The \`${d.name}\` ${d.kind} may never get picked: ${oneLine(d.issues.join("; ")) || "its description needs work"}.`);
  }
  if (weakOutside) {
    // "1 rule outside this repo needs work" — the noun is partitive and stays
    // plural while the verb agrees with the count.
    // [Foreman: 097] Not "your own": some of these files are written by the host,
    // not by the reader.
    also.push(`- ${weakOutside} of the rules outside this repo ${weakOutside === 1 ? "needs" : "need"} work — fix those where they live.`);
  }
  if (also.length) {
    out.push("## Also worth a look");
    out.push("");
    for (const line of also.slice(0, listItems)) out.push(line);
    if (also.length > listItems) out.push(`- …and ${also.length - listItems} more`);
    out.push("");
  }

  // The claude profile has one door, so its closing line can name it. The codex
  // profile is driven from two — one on each install host — and this engine
  // cannot know which one the reader came through, so its line names only the
  // flag: the one thing true behind both.
  const codexHost = (audit.profile || {}).host === "codex";
  // [Foreman: 097] A project with no rules has nothing to open in --verbose. It
  // gets pointed at writing one instead, in the place this host writes rules.
  if (noRules) {
    const place = ((profileTargets(audit) || {}).rule || {}).places || [];
    out.push(codexHost
      ? `Nothing to audit yet — write your first rule in \`${(place[0] || {}).path || "the project's instruction file"}\`.`
      : "Nothing to audit yet — run `/assay:craft-rules` to write your first rule.");
    return out.join("\n");
  }
  // [Foreman: 097] A function of the table above it. It used to offer an
  // apply-everything flag whenever anything was weak and nothing at all otherwise — so a report of
  // gates, disagreements and dead paths ended with no action to take.
  // [Foreman: 165] The line named the retired one-command audit and its retired
  // apply-everything flag. Both halves are gone: the audit is four model
  // commands now and the engine cannot know which one the reader typed, so it
  // names the offer rather than a command. The menu is always offered.
  const next = [];
  if (weak.length && !codexHost) next.push("The audit offers to rewrite the weak ones.");
  if (gated.length || conflictRows.length || stale.length || duplicateRows.length) {
    next.push("The rest are yours to decide — each row above carries its own fix.");
  }
  if (weakDescriptions.length && !codexHost) {
    next.push("Run `/assay:craft-skill <name>` to rewrite a description that never fires.");
  }
  next.push("Rerun with `--verbose` to see everything assay found.");
  out.push(next.join(" "));

  return out.join("\n");
}


// [Foreman: 164] The third renderer, beside the short report and `--verbose`.
// The auto-fix flow shows this to the owner before the transaction opens, so
// what it owes them is the worst thing first, in words they had before they
// installed anything, and an honest list of the hooks about to appear on disk.
// No factor codes and no grade: a letter is a verdict on the project, and this
// page is a list of decisions about to be taken on the reader's behalf.
//
// razor: a filter over the same audit record the other two read. It derives
// nothing, keeps renderBrief's bucket order, and reuses its `claim` discipline
// so "one rule, one line" is a property of the data rather than of care taken
// here — which is what G7 asserts.

// G7. The auto-fix flow shows this above a prompt, so it is budgeted much
// harder than the short report: a page the reader must scroll to reach the
// approval line is a page they approve without reading.
const PLAIN_MAX_LINES = 25;
const PLAIN_MAX_ITEMS = 10;
const PLAIN_MAX_HOOKS = 6;

function renderPlain(audit) {
  const out = [];
  const files = audit.files || [];
  const rules = (audit.rules || []).filter((r) => !r.suppressed);
  const findings = audit.findings || [];
  const rulesById = new Map(rules.map((r) => [r.id, r]));
  const ruleAt = new Map(rules.map((r) => [r.file + ":" + r.lineStart, r]));
  const outside = new Set(files.filter(notReadersOwn).map((f) => f.path));
  const mine = rules.filter((r) => !outside.has(r.file));

  const claimed = new Set();
  const claim = (candidates) => {
    const kept = [];
    for (const r of candidates) {
      if (!r || claimed.has(r.id)) continue;
      claimed.add(r.id);
      kept.push(r);
    }
    return kept;
  };
  // A group row names every place it is about, so it may only print while ALL
  // of them are still unclaimed — otherwise one line repeats an address an
  // earlier, more urgent line already used.
  const freeSpans = (spans) => {
    const found = spans.map((s) => ruleAt.get(s.path + ":" + s.lineStart));
    return found.every((r) => r && !claimed.has(r.id)) ? found : null;
  };
  const at = (r) => displayPath(r.file) + ":" + r.lineStart;
  const spanList = (spans) => spans.map((s) => displayPath(s.path) + ":" + s.lineStart).join(" and ");
  const quote = (r) => '"' + truncateCell(String(r.text).replace(/\s*\n\s*/g, " "), 56) + '"';

  const items = [];
  // Bucket order is renderBrief's, for the same reasons: a rule the host never
  // reads outranks a pair that argues, which outranks a dead path, which
  // outranks a duty written twice, which outranks wording.
  const gated = findings.filter((f) => HARD_GATE_STATES.has(f.state) && f.state !== "blocked");
  for (const r of claim(gated.map((f) => rulesById.get(f.rule)).filter((r) => r && !outside.has(r.file)))) {
    items.push(`${at(r)} — ${quote(r)} is never read by the assistant. Move it somewhere that loads.`);
  }
  for (const f of findings) {
    if (f.type !== "conflict" && f.type !== "conditional-conflict") continue;
    const spans = (f.sources || []).filter((s) => !outside.has(s.path));
    if (spans.length < 2) continue;
    const kept = freeSpans(spans);
    if (!kept) continue;
    claim(kept);
    items.push(`${spanList(spans)} — these rules ask for opposite things. Decide which one you meant.`);
  }
  for (const r of claim(mine.filter((r) => r.staleness && r.staleness.missing.length))) {
    const missing = r.staleness.missing[0].ref;
    items.push(`${at(r)} — ${quote(r)} points at ${missing}, which is not there. Fix the path or drop it.`);
  }
  for (const f of findings) {
    if (f.type !== "duplicate") continue;
    const spans = (f.sources || []).filter((s) => !outside.has(s.path));
    if (spans.length < 2) continue;
    const kept = freeSpans(spans);
    if (!kept) continue;
    claim(kept);
    items.push(`${spanList(spans)} — the same job is written out twice. Keep one copy.`);
  }
  // Wording. A rule every session reads outranks one only some sessions reach,
  // so an always-loaded file sorts first at the same score.
  const always = new Set(files.filter((f) => f.alwaysLoaded).map((f) => f.path));
  const weak = claim(mine.filter((r) => r.weak)
    .sort((a, b) => (always.has(a.file) ? 0 : 1) - (always.has(b.file) ? 0 : 1) || a.score - b.score));
  for (const r of weak) {
    const names = rowWeaknesses(r);
    const why = names.map((n) => (n === "F7" ? vagueEvidence(r).problem : PLAIN_PROBLEMS[n])).filter(Boolean)[0]
      || "too vague to act on";
    items.push(`${at(r)} — ${quote(r)} ${why}. Rewrite it.`);
  }

  const total = items.length;
  const shown = items.slice(0, PLAIN_MAX_ITEMS);
  out.push(total
    ? `assay read ${mine.length} ${mine.length === 1 ? "rule" : "rules"} here and found ${total} worth fixing, worst first.`
    : `assay read ${mine.length} ${mine.length === 1 ? "rule" : "rules"} here and found nothing worth fixing.`);
  out.push("");
  for (const line of shown) out.push("- " + line);
  if (total > shown.length) out.push(`- and ${total - shown.length} more, smaller than these.`);
  if (total) out.push("");

  // The closing block: what is about to appear on disk, named the way the file
  // that carries it will name it. A rule a wired hook already covers is not
  // about to be installed, so it is not listed here.
  const alreadyWired = new Set(findings.filter((f) => f.type === "redundant-enforcement").map((f) => f.rule));
  const byHook = new Map();
  for (const r of mine) {
    const h = (r.placement || {}).hookEvent;
    if (!h || alreadyWired.has(r.id)) continue;
    const key = h.event + "|" + (h.matcher || "*");
    if (!byHook.has(key)) byHook.set(key, { event: h.event, matcher: h.matcher || "*", n: 0 });
    byHook.get(key).n++;
  }
  const hooks = [...byHook.values()];
  out.push("About to be installed:");
  if (!hooks.length) out.push("- no hooks — nothing here is ready to run on its own yet.");
  for (const h of hooks.slice(0, PLAIN_MAX_HOOKS)) {
    out.push(`- a hook on ${h.event}, matching ${h.matcher} — covers ${h.n} ${h.n === 1 ? "rule" : "rules"}.`);
  }
  if (hooks.length > PLAIN_MAX_HOOKS) out.push(`- and ${hooks.length - PLAIN_MAX_HOOKS} more hooks.`);

  return out.join("\n");
}
// [Foreman: 075]
// The report leads with findings and ends with the hygiene grade. Four sections
// carry the whole diagnosis — hard gates, operational findings, policy
// placement, structural hygiene — and every detail table the report used to
// print at the top level still prints, one level down, inside the section it
// belongs to. Every finding line carries a bracketed evidence tag, because the
// one thing the interface must never do is let a heuristic read as a fact.
//
// [Foreman: 095] Reached by --verbose now. The default is renderBrief above.
function renderReport(audit, opts = {}) {
  const out = [];
  const { files } = audit;
  const rules = audit.rules.filter((r) => !r.suppressed);
  const suppressed = audit.rules.filter((r) => r.suppressed);
  // [Foreman: 078] The record is the sole input. A renderer never re-derives a
  // finding, a mechanism, a pair, or a score — a hand-built audit with no
  // `findings` renders an empty report rather than a second, differently-timed
  // analysis. What the reader sees is what the record says.
  const findings = audit.findings || [];
  // [Foreman: 079] What this profile lets the report say. `rubric` false means
  // no wording levers, no grade, and maintainability items reported apart from
  // reliability findings — SCOPE.md's Codex profile, step 8.
  const rubric = profilePolicy(audit).wordingRubric !== false;
  const findingByRule = new Map(findings.filter((f) => f.state).map((f) => [f.rule, f]));
  const rulesById = new Map(rules.map((r) => [r.id, r]));
  const stateOf = (r) => findingByRule.get(r.id) || null;
  const tagOf = (r) => { const f = stateOf(r); return f ? evidenceTag(f.evidence) : ""; };
  // [Foreman: 091, 097] A user-scope file arrives as an absolute path.
  // Backslashes break a markdown link target, and the home directory does not
  // belong in a shareable report — one shared helper now, see mdPathLink.
  // file:line as a markdown link — Claude Code renders it clickable, opening
  // the rule at its exact line. A path may carry a space, a bracket or a `(`,
  // none of which survives raw in a link, so both halves are escaped for the
  // side they land on.
  const loc = (r) => mdPathLink(r.file, r.lineStart);
  // [Foreman: 078] the same link off a finding's source span, which is what a
  // corpus finding carries instead of a rule
  const spanLink = (s) => mdPathLink(s.path, s.lineStart);
  // The rule cell itself is the click target: a bare line number is useless to
  // a reader, so the rule id + text opens the file at its line. Brackets in the
  // label would break the markdown link, so drop them.
  const ruleLink = (r, n) => `[${r.id} "${truncateCell(r.text, n).replace(/[[\]]/g, "")}"](${mdTarget(String(r.file).replace(/\\/g, "/"))}:${r.lineStart})`;
  const weakSkills = (audit.skills || []).filter(isWeakSkill);
  // [Foreman: 071] No `semantic` block means no model judged anything in this
  // audit. Every renderer says so rather than letting a renormalized score read
  // as the same measurement a model-judged one is.
  const deterministicOnly = !audit.semantic;
  out.push("# Rule audit — " + path.basename(audit.root));
  out.push("");
  // [Foreman: 072] Who produced this, under which host profile and schema.
  out.push(redactSecrets(recordBanner(audit)) + (deterministicOnly ? " · deterministic only" : ""));
  out.push("");
  // [Foreman: 071] The judgment cache invalidates structurally on an edited rule
  // (the key is a content hash); a changed rubric is the axis a hash cannot see.
  const judgedUnder = ((audit.semantic || {}).provenance || {}).promptVersion;
  if (judgedUnder && judgedUnder !== RUBRIC_VERSION) {
    out.push(`Judgments were made under rubric v${judgedUnder}; this engine ships rubric v${RUBRIC_VERSION} — rerun step 2 to refresh.`);
    out.push("");
  }
  if (!rules.length) {
    out.push("No rules found in CLAUDE.md or .claude/rules/.");
    out.push("");
    pushCoverageSection(out, audit, rules, suppressed, findings);
    if (weakSkills.length) {
      pushWeakSkillSection(out, weakSkills);
      pushPreGenerationSkills(out, audit.skills);
    }
    if (opts.verbose && suppressed.length) {
      out.push("");
      pushSuppressedSection(out, suppressed);
    }
    return out.join("\n");
  }
  pushCoverageSection(out, audit, rules, suppressed, findings);

  // 2. Headline — the risk topology, not a mean.
  const counts = stateCounts(findings);
  const present = FINDING_STATES.filter((s) => counts.get(s));
  const topology = present.map((s) => `${counts.get(s)} ${stateWord(s, counts.get(s))}`);
  out.push(`**${topology.join(", ")}** across ${files.filter((f) => f.ruleCount > 0).length} file(s).`);
  out.push("");
  // [Foreman: 097] Nine state words, no legend anywhere in the report or the
  // README. One line, glossing only the words this report actually used.
  out.push("In plain words: " + present.map((s) => `${stateWord(s, counts.get(s))} = ${STATE_GLOSS[s]}`).join(" · ") + ".");
  out.push("");
  out.push(rubric
    ? "Findings are this report's primary output. The structural-hygiene grade at the bottom is a secondary summary — it never overrides a hard gate, and it never predicts compliance."
    // [Foreman: 079] No grade to demote, so the sentence says what is there
    // instead of pointing at a number the report does not print.
    : "Findings are this report's primary output. This profile carries no hygiene grade, so they are the whole of it — and no finding here predicts compliance.");
  out.push("");

  // [Foreman: 097] Twenty sections and no way to see them without scrolling all
  // of them. One line, naming what is below in the order it appears.
  const contentsAt = out.length;

  if (opts.prev) pushProgressSection(out, audit, opts.prev, findings);

  // 3. Hard gates — the host cannot apply these at all.
  // [Foreman: 097] This repository's own. A rule in the reader's `~/.claude` or
  // in a directory above the root can be gated too, and it is still real — but
  // it belongs under the section for the files it lives in, where the fix is,
  // not at the top of a report about this project.
  const outOfRepo = new Set(files.filter(notReadersOwn).map((f) => f.path));
  const allGates = findings.filter((f) => HARD_GATE_STATES.has(f.state));
  const gates = allGates.filter((f) => !outOfRepo.has((((f.sources || [])[0]) || {}).path));
  const gated = new Set(allGates.map((f) => f.rule));
  out.push("## Hard gates");
  out.push("");
  if (!gates.length) {
    out.push("None — every rule the audit found can load in this context.");
    out.push("");
  } else {
    out.push("The host cannot apply these as written. No wording fix reaches them, and no hygiene score overrides one.");
    out.push("");
    for (const f of gates) {
      const r = rulesById.get(f.rule);
      out.push(`- ${ruleLink(r, 60)} — **${f.state}**: ${f.summary} ${evidenceTag(f.evidence)}`);
      pushSafeActions(out, f);
    }
    out.push("");
  }

  // [Foreman: 079] The chain the gates above refer to, right after them: a
  // reader who has just been told a file is never read needs the order and the
  // arithmetic that made it so.
  pushChainSection(out, files, (audit.coverage || {}).budget);
  pushOutputStyleSection(out, audit);

  // 4. Operational findings — loaded, but risky.
  // A hard-gated rule is named above with its state, never here with a grade:
  // a rule the host never loads has no operational behavior to be weak at.
  // [Foreman: 079] The three score-derived lists are the wording rubric's own,
  // so a profile that declines it gets none of them.
  // [Foreman: 091] A user-scope rule is fixed in the reader's own setup, not
  // in this repo — its findings render under User scope, never in the
  // project's fix list. Conflicts and duplicates stay cross-scope: a user rule
  // arguing with a project rule is exactly what that section exists to say.
  // [Foreman: 093] Ancestor files sit above the repo the way user files sit
  // outside it: graded, sectioned apart, never in the project's fix list.
  const userFilePaths = new Set(files.filter((f) => f.scope === "user").map((f) => f.path));
  const ancestorFilePaths = new Set(files.filter((f) => f.scope === "ancestor").map((f) => f.path));
  const projectRules = rules.filter((r) => !userFilePaths.has(r.file) && !ancestorFilePaths.has(r.file));
  const weak = rubric ? projectRules.filter((r) => r.weak && !gated.has(r.id)).sort((a, b) => a.score - b.score) : [];
  const userWeak = rubric ? rules.filter((r) => userFilePaths.has(r.file) && r.weak && !gated.has(r.id)).sort((a, b) => a.score - b.score) : [];
  const ancestorWeak = rubric ? rules.filter((r) => ancestorFilePaths.has(r.file) && r.weak && !gated.has(r.id)).sort((a, b) => a.score - b.score) : [];
  const stalls = projectRules.filter((r) => r.stallRisk);
  const buried = rubric ? projectRules.filter((r) => r.factorValues.F5 <= THRESHOLDS.buriedF5) : [];
  const stale = projectRules.filter((r) => r.staleness && r.staleness.missing.length);
  const badCategories = projectRules.filter((r) => r.invalidCategory);
  // [Foreman: 076] Corpus findings the renderer lists rather than re-derives.
  // [Foreman: 079] Duplicates and file shape are maintainability, not
  // reliability. Under a wording rubric they have always been listed here;
  // without one they move to their own section below, where SCOPE.md's step 8
  // says optional improvements belong.
  const allDuplicates = findings.filter((f) => f.type === "duplicate");
  const duplicates = rubric ? allDuplicates : [];
  const maintainability = rubric ? [] : allDuplicates.concat(findings.filter((f) => f.type === "action-clarity"));
  const conflicts = findings.filter((f) => f.type === "conflict" || f.type === "conditional-conflict");
  const sharedStale = findings.filter((f) => f.type === "stale-shared-target");
  const overlaps = findings.filter((f) => f.type === "scope-overlap");
  const proposals = ((audit.semantic || {}).candidates) || [];
  // [Foreman: 080] The skill findings a profile without the trigger recipe
  // produces. Empty under a profile that grades skills instead.
  const skillFindings = findings.filter((f) => SKILL_FINDING_TYPES.has(f.type));
  out.push("## Operational findings");
  out.push("");
  if (!weak.length && !stalls.length && !buried.length && !stale.length && !badCategories.length &&
      !duplicates.length && !conflicts.length && !sharedStale.length && !overlaps.length && !proposals.length && !skillFindings.length) {
    out.push("None — no loaded rule carries a risk the analyzers can see.");
    out.push("");
  } else {
    out.push("Rules the host loads that carry a risk to how reliably they act. Each line names the kind of evidence behind it.");
    out.push("");
  }

  // [Foreman: 076] Conflicts lead the section: a pair that contradicts itself
  // outranks any single weak rule, and it is the one finding here that no
  // rewrite of either rule alone can settle.
  if (conflicts.length) {
    out.push("### Conflicts");
    out.push("");
    out.push("Two loaded rules that ban and command the same action. assay names the pair and stops: which policy is correct is a decision about your project, not about wording, so neither rule is edited and neither is called the winner. [heuristic]");
    out.push("");
    for (const f of conflicts) {
      const [a, b] = f.sources;
      out.push(`- ${mdPathLink(a.path, a.lineStart)} ↔ ${mdPathLink(b.path, b.lineStart)} — ${f.summary}`);
      out.push(`  - ${f.explanation}`);
      pushSafeActions(out, f);
    }
    out.push("");
  }

  // [Foreman: 080] Skills, where the profile validates them instead of grading
  // them. Every line is mechanical or documented; none is a wording verdict, and
  // each says how the skill would have to be reached.
  if (skillFindings.length) {
    out.push("### Skills");
    out.push("");
    out.push("The host requires some skill metadata and publishes a budget for the list it builds at session start. These are read out of the files, never judged.");
    out.push("");
    for (const f of skillFindings) {
      out.push(`- ${redactSecrets(f.summary)} ${evidenceTag(f.evidence)}`);
      out.push(`  - ${f.explanation}`);
      pushSafeActions(out, f);
    }
    // Explicit invocation and implicit routing are two different ways in, and a
    // skill with routing switched off is reachable only by being named.
    const explicit = (audit.skills || []).filter((s) => s.metadata && s.metadata.allowImplicitInvocation === false);
    if (explicit.length) {
      out.push(`- ${explicit.length} skill(s) set \`allow_implicit_invocation: false\` — ${explicit.map((s) => "`" + s.name + "`").join(", ")}. Nothing routes to them from a description; a session reaches them by naming them.`);
    }
    out.push("");
  }

  if (weak.length) {
    out.push(`### Weak rules (${weak.length} below their category floor)`);
    out.push("");
    // [Foreman: 097] Nothing anywhere taught the reader the model behind these
    // verdicts. The page is in the plugin, one link from the README.
    out.push("Click a rule to open it at its line. `references/what-assay-measures.md` in this plugin explains every check below, with a worked example each.");
    out.push("");
    // [Foreman: 097] No State column. A rule with no finding of its own printed
    // as "healthy" inside a table headed "Weak rules", next to grade F — two
    // vocabularies disagreeing in adjacent cells about one rule. The state is on
    // the rule's own finding line above; here the grade is the verdict. And the
    // words are the short report's, so the place a confused reader is sent never
    // renames what confused them.
    out.push("| Rule | Evidence | Score | Main issue | Suggested fix |");
    out.push("|---|---|---|---|---|");
    for (const r of weak) {
      const names = rowWeaknesses(r);
      const evidence = vagueEvidence(r);
      const problems = names.map((n) => (n === "F7" ? evidence.problem : PLAIN_PROBLEMS[n] || n)).join(", ");
      const fixes = names.map((n) => (n === "F7" ? evidence.fix : PLAIN_FIXES[n])).filter(Boolean).join("; ");
      out.push(`| ${ruleLink(r, 60)} | ${tagOf(r)} | ${r.grade} (${fmt(r.score)}) | ${escapeTableCell(problems)} | ${escapeTableCell(fixes)} |`);
    }
    out.push("");
  }

  if (stalls.length) {
    // [Foreman: 079] The section's evidence tag is the evidence its findings
    // actually carry. On a profile the wording study never covered the pattern
    // is a structural observation, and the banner must not upgrade it.
    const stallEvidence = rubric ? WORDING_STUDY_EVIDENCE : STALL_STRUCTURE_EVIDENCE;
    out.push("### Stall risks (bare prohibitions)");
    out.push("");
    out.push(`A prohibition with no named alternative can stall a run outright when the task needs the banned thing. Pair it with the replacement — "Never X — do Y instead" — or with the escape hatch ("stop and ask"). ${evidenceTag(stallEvidence)} — ${stallEvidence.limits}.`);
    out.push("");
    for (const r of stalls) {
      out.push(`- ${r.id} (${loc(r)}) "${truncateCell(r.text, 80)}"`);
    }
    out.push("");
  }

  if (buried.length) {
    out.push("### Buried rules");
    out.push("");
    out.push("These sit in the bottom half of a long file, where rules lose force. Move load-bearing rules into the top quarter, or split the file into scoped rule files. [heuristic]");
    out.push("");
    for (const r of buried) {
      const total = files[r.fileIndex] ? files[r.fileIndex].lineCount : "?";
      out.push(`- ${r.id} (${loc(r)}) "${truncateCell(r.text, 80)}" — line ${r.lineStart} of ${total}`);
    }
    out.push("");
  }

  if (stale.length) {
    out.push("### Stale references");
    out.push("");
    out.push("A rule pointing at a path that no longer resolves makes the agent re-discover it or give up. Fix the path or drop the reference. [mechanical]");
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

  // [Foreman: 093] The corpus view of the same dead paths: one target, every
  // policy that leans on it. Rendered beside the per-rule list because the fix
  // is one restore, not N separate edits.
  if (sharedStale.length) {
    out.push("### Stale shared targets");
    out.push("");
    out.push("One missing path that several policies depend on — restoring it, or repairing every reference at once, fixes the whole set. [mechanical]");
    out.push("");
    for (const f of sharedStale) {
      out.push(`- ${f.summary}`);
      out.push(`  - ${f.explanation}`);
      pushSafeActions(out, f);
    }
    out.push("");
  }

  if (duplicates.length) pushDuplicateSection(out, duplicates, spanLink);

  if (overlaps.length) {
    out.push("### Scope overlap");
    out.push("");
    out.push("These scoped files load together for the same paths, which is how their rules ended up colliding. Overlapping globs are normal by themselves — this lists only the pairs that already state something twice or contradict each other. [mechanical]");
    out.push("");
    for (const f of overlaps) { out.push(`- ${f.summary}`); pushSafeActions(out, f); }
    out.push("");
  }

  // [Foreman: 076] The semantic proposal channel. Labelled on every line and
  // walled off from everything above it: a proposal never changes a state, a
  // score, the grade, or the deterministic relationship graph.
  if (proposals.length) {
    const byKey = new Map((audit.rules || []).map((r) => [r.key, r]));
    const acceptanceOf = (c) => (c.accepted === true ? "accepted" : c.accepted === false ? "rejected" : "proposed");
    const shown = proposals.filter((c) => opts.verbose || acceptanceOf(c) !== "rejected");
    if (shown.length) {
      out.push("### Proposed relationships");
      out.push("");
      // [Foreman: 140] Two channels now fill this section, and the difference
      // matters to a reader deciding how much weight to give a line — so each
      // row says which one proposed it rather than the heading claiming both.
      out.push("Proposals, not measurements: nothing here moved a rule's state, its score, the corpus grade, or the relationships assay derived deterministically. Each line says whether the model proposed it while judging or a script proposed it as a near miss. Accept or reject each one in conversation. [model-inferred]");
      out.push("");
      for (const c of shown) {
        const sites = (c.keys || []).map((k) => byKey.get(k)).filter(Boolean).map(loc);
        const where = sites.length ? sites.join(" ↔ ") : "(no rule in this scan matches its keys)";
        const from = c.proposedBy === "analyzer" ? "by a script" : "by the model";
        out.push(`- **${c.kind}** — ${acceptanceOf(c)} ${from} — ${where} — ${c.summary || ""}${c.reason ? " (" + c.reason + ")" : ""}`);
      }
      out.push("");
    }
  }

  if (badCategories.length) {
    out.push("### Unknown category annotations");
    out.push("");
    out.push(`A \`<!-- category: … -->\` annotation only recognizes ${Object.keys(CATEGORY_FLOORS).join(", ")}. These name something else, so the rule was graded under its file's default category — fix the spelling or it keeps the wrong pass mark. [mechanical]`);
    out.push("");
    for (const r of badCategories) {
      const line = r.invalidCategory.line;
      out.push(`- ${r.id} (${mdPathLink(r.file, line)}) — \`<!-- category: ${r.invalidCategory.value} -->\``);
    }
    out.push("");
  }

  // [Foreman: 079] Maintainability, separated from reliability — SCOPE.md's
  // Codex profile, step 8. Nothing here says the host will fail to act on a
  // rule; it says the corpus would be easier to keep correct. The section only
  // exists for a profile with no wording rubric, because under one these items
  // are already grouped with the findings they inform.
  // [Foreman: 097] Reshaping a file is advice about a file this repository owns.
  const outsidePaths = new Set([...userFilePaths, ...ancestorFilePaths]);
  const shapes = findings.filter((f) => f.type === "file-shape" &&
    !outsidePaths.has(((f.sources || [])[0] || {}).path));
  if (!rubric) {
    out.push("## Maintainability");
    out.push("");
    if (!maintainability.length && !shapes.length) {
      out.push("None — nothing in the corpus is redundant or hard to keep correct.");
      out.push("");
    } else {
      out.push("Optional improvements. None of these is a reliability failure: every rule below is one the host loads and can act on.");
      out.push("");
      for (const f of maintainability.filter((x) => x.type === "action-clarity")) {
        const r = rulesById.get(f.rule);
        out.push(`- ${r ? ruleLink(r, 60) : f.rule} — ${f.summary} ${evidenceTag(f.evidence)}`);
        pushSafeActions(out, f);
      }
      if (maintainability.some((f) => f.type === "duplicate")) {
        out.push("");
        pushDuplicateSection(out, maintainability.filter((f) => f.type === "duplicate"), spanLink);
      }
      if (shapes.length) pushRestructureSection(out, shapes);
    }
  }

  // 5. Policy placement — advisory and mechanical candidates.
  const hooks = rules.filter((r) => r.hookOpportunity);
  const placed = rules.filter((r) => r.placement);
  const restructure = rubric ? shapes : [];
  const redundant = findings.filter((f) => f.type === "redundant-enforcement");
  const advisory = findings.filter((f) => f.state === "advisory");
  const advisoryByCategory = advisory.filter((f) => f.evidence.level === "mechanical").length;
  const advisoryByModel = advisory.length - advisoryByCategory;
  // [Foreman: 077] Every mechanism the project already has, by ladder level.
  const mechanisms = audit.mechanisms || [];
  const activeRules = rules.filter((r) => !gated.has(r.id)).length;
  out.push("## Policy placement");
  out.push("");
  if (!hooks.length && !placed.length && !restructure.length && !advisory.length && !redundant.length && !mechanisms.length) {
    out.push("None — nothing here is better owned by another mechanism.");
    out.push("");
  } else {
    out.push("Where each policy belongs: a mechanism that enforces it, or prose that asks for judgment.");
    out.push("");
    // Advisory rules are counted, not enumerated: nothing about them needs
    // doing, and a list of every judgment call would bury the candidates.
    if (advisoryByCategory) {
      out.push(`- ${advisoryByCategory} rule(s) annotated \`preference\` — judgment that appropriately stays prose [mechanical]`);
    }
    if (advisoryByModel) {
      out.push(`- ${advisoryByModel} rule(s) need judgment no mechanism can supply — they appropriately stay prose [model-inferred]`);
    }
    if (advisory.length) out.push("");
  }

  // [Foreman: 080] Also when the ladder is empty ONLY because a surface could not
  // be read: a project whose one hook file will not parse has no mechanisms, and
  // suppressing the section there would hide the hole instead of naming it.
  if (mechanisms.length || (((audit.repoChecks || {}).inaccessible) || []).length) {
    pushLadderSection(out, audit, mechanisms, activeRules, opts, findings);
  }

  // [Foreman: 076] A rule whose moment a wired hook already fires on. The hook
  // is read out of the settings files, never watched — so this says "already
  // wired", not "already enforced".
  if (redundant.length) {
    out.push("### Already wired");
    out.push("");
    out.push("A hook is already configured for the moment each of these rules names. assay read that out of the settings files and has not watched it run, so confirm the hook actually covers the rule before retiring any prose. [heuristic]");
    out.push("");
    for (const f of redundant) {
      const r = rulesById.get(f.rule);
      // the summary quotes the wired hook command — redact before it prints
      out.push(`- ${r ? ruleLink(r, 60) : f.rule} — ${redactSecrets(f.summary)}`);
      pushSafeActions(out, f);
    }
    out.push("");
  }

  if (hooks.length) {
    out.push("### Better enforced by a hook");
    out.push("");
    out.push("A hook or script could enforce these mechanically, on every run, instead of relying on the agent to read and remember them: [model-inferred]");
    out.push("");
    for (const r of hooks) {
      out.push(`- ${r.id} (${loc(r)}) "${truncateCell(r.text, 80)}"`);
    }
    out.push("");
    // The wired-hook inventory stays out of the report: it is the reader's
    // working input for marking a candidate already covered, and once those
    // marks are in the list above nothing else consumes it. It ships in the
    // scan summary and in audit.json instead.
  }

  if (placed.length) {
    out.push("### Placement candidates");
    out.push("");
    // [Foreman: 077] Said once, in the intro: a candidate row names the
    // primitive that fits its wording, and the ladder is what says a stronger
    // level is available at all.
    const higher = mechanisms.some((m) => m.level >= 4)
      ? " Repository and remote gates exist in this project; a policy that must be impossible to merge belongs there, not in a hook."
      : "";
    // [Foreman: 080] The primitive's name is the host's, off the record.
    out.push(`Rules whose job fits a ${profileNouns(audit).primitive} better than rule prose:` + higher + " [heuristic]");
    out.push("");
    // [Foreman: 097] The signals ride the same line. They were a second line per
    // rule carrying detector names and decimals — the record has all of it, and
    // spending a line per rule on internals is what made this report a scroll.
    for (const r of placed) {
      const best = r.placement.detections[r.placement.bestFit] || null;
      const why = best ? ` — ${best.evidence.join(", ")} (${fmt(best.confidence)})` : "";
      out.push(`- ${r.id} (${loc(r)}) → **${r.placement.bestFit}** — "${truncateCell(r.text, 70)}"${why}`);
    }
    out.push("");
  }

  if (restructure.length) pushRestructureSection(out, restructure);

  // 6. Structural hygiene — the score, demoted to what it is.
  const corpusBit = audit.corpusScore === null
    ? "no mandate rules left to grade"
    : `corpus grade **${audit.corpusGrade} (${fmt(audit.corpusScore)})**, mandate rules only`;
  out.push("## Structural hygiene (secondary)");
  out.push("");
  // [Foreman: 097] The project's own rules, because the grade beside it averages
  // exactly those. It used to read "100 rules across 20 files — corpus grade C"
  // where the grade was the mean of 17 of them.
  const projectFiles = files.filter((f) => f.scope !== "user" && f.scope !== "ancestor");
  const headcount = `**${projectRules.length} rules across ${projectFiles.filter((f) => f.ruleCount > 0).length} file(s)**`;
  if (rubric) {
    out.push("A summary of how rules are written, scoped, and placed — never a prediction that Claude will comply, and never a reason to discount a hard gate above. A rule the host cannot apply shows that state whatever it scores here.");
    out.push("");
    out.push(`${headcount} — ${corpusBit}.`);
    out.push("");
    // [Foreman: 071] The scoring contract requires a hygiene score to state its
    // evidence mix. A renormalized score is a mean over a smaller factor set, so
    // it is not comparable to a model-judged one and does not pretend to be.
    if (deterministicOnly) {
      out.push("No model judged anything in this run, so each score is worked out over the checks that did run — which makes it a different measurement from a run that had one, not a lower one.");
      out.push("");
    }
    // [Foreman: 074] Said once, where the number is, so nobody reads the grade as
    // covering files that live outside the repo.
    if (files.some((f) => f.scope === "user" || f.scope === "ancestor")) {
      out.push("Files outside this repository — user scope and directories above the project root — are graded under their own sections and never move the project grade.");
      out.push("");
    }
    out.push("Grades assume the least forgiving reader: small models, subagents, headless runs. If only large models in interactive sessions read this corpus, treat severity one notch softer.");
    out.push("");
  } else {
    // [Foreman: 079] Where the grade would sit. Said once and plainly: the
    // hygiene rubric was measured on the Claude Code profile, and a number
    // carried to a host it was never measured on would be a claim assay cannot
    // support. Everything above it — the gates, the chain, the findings — is
    // host-neutral and ran in full.
    out.push(`${headcount} — no grade.`);
    out.push("");
    out.push(`The structural-hygiene rubric is measured on one host profile and carries no evidence for this one. It is not applied to \`${(audit.profile || {}).host || "this host"}\` sources until there is evidence for this one, so nothing here is graded and the findings above are the whole report.`);
    out.push("");
  }
  out.push("### Files");
  out.push("");
  out.push("| File | Rules | Grade | Loading |");
  out.push("|---|---|---|---|");
  for (const f of files.filter((x) => x.scope !== "user" && x.scope !== "ancestor")) {
    // [Foreman: 076] An unselected variant is listed, never described as loading.
    const g = f.grade === null ? "—" : `${f.grade} (${fmt(f.score)})`;
    out.push(`| ${mdPathLink(f.path)} | ${f.ruleCount} | ${g} | ${loadingCell(f)} |`);
  }
  out.push("");
  pushUserScopeSection(out, files, userWeak, { ruleLink });
  pushAncestorScopeSection(out, files, ancestorWeak, { ruleLink });

  if (weakSkills.length) pushWeakSkillSection(out, weakSkills);
  pushPreGenerationSkills(out, audit.skills);
  const weakAgents = (((audit.coverage || {}).agents) || []).filter(isWeakAgent);
  if (weakAgents.length) pushWeakAgentSection(out, weakAgents);

  // [Foreman: 079] Every column of this table is a rubric factor, so a profile
  // without the rubric has no table to print — the Instruction chain and Files
  // sections are that profile's inventory.
  if (opts.verbose && rubric) {
    out.push("## All rules");
    out.push("");
    // [Foreman: 097] The project's own. On a machine with auto memory this table
    // was 100 rows of decimals, 83 of them about files the reader does not own —
    // and every one of them is still in `--json`.
    out.push("This project's rules. Each column scores one thing about the rule, 0 (worst) to 1 (best): whether it has a firm verb, names an alternative, has a clear trigger, is scoped right, sits high in the file, and is concrete. The last column is different — a HIGH Judgment score means the rule genuinely needs Claude's judgment, and a low one means a hook could settle it. Rules loaded from outside this repository are in `--json`, not here.");
    out.push("");
    out.push("| Rule | Cat | " + FACTOR_COLUMNS.map(([, h]) => h).join(" | ") + " | Score | Grade |");
    out.push("|---|---|" + FACTOR_COLUMNS.map(() => "---").join("|") + "|---|---|");
    for (const r of projectRules) {
      const v = r.factorValues;
      // [Foreman: 071] An unjudged factor prints as a dash, never as a number
      // nobody measured.
      const cells = FACTOR_COLUMNS.map(([f]) => {
        const x = f === "F8" ? r.f8 : v[f];
        return x == null ? "—" : fmt(x);
      }).join(" | ");
      out.push(`| ${ruleLink(r, 40)} | ${r.category} | ${cells} | ${fmt(r.score)} | ${r.grade} |`);
    }
    out.push("");
  }
  // [Foreman: 079] Outside the table above, because a dropped entry must be
  // recoverable under --verbose whether or not the profile has a rubric.
  if (opts.verbose && suppressed.length) pushSuppressedSection(out, suppressed);

  // Built last, inserted where it belongs: the sections are known only once the
  // report is written, and a contents list that guesses at them would drift.
  const sections = out.slice(contentsAt)
    .filter((l) => /^## /.test(l))
    .map((l) => l.slice(3).trim());
  if (sections.length > 2) {
    out.splice(contentsAt, 0, "Below: " + sections.join(" · ") + ".", "");
  }

  return out.join("\n");
}

// [Foreman: 095] Only a backslash that IMMEDIATELY PRECEDES a pipe is doubled.
// Escaping the pipe alone would turn a rule's own `\|` into `\\|` — an escaped
// backslash followed by a live pipe — and split the row it sits in. Escaping
// every backslash instead corrupts the far more common ones: a regex in a code
// span, a Windows path. Backslash escapes do not even apply inside a code span,
// so there the doubling is visible damage. This touches exactly the sequence
// that breaks a table and nothing else.
//
// razor: markdown table escaping only. It escapes the one sequence that breaks
// a table and leaves the text otherwise exactly as the author wrote it.
//
// Split rather than `/(\\*)\|/g`: a greedy run backtracks from every position in
// a long line of backslashes, which turns a shared helper quadratic. This walks
// the string once.
function escapeTableCell(s) {
  const parts = String(s).split("|");
  if (parts.length === 1) return parts[0];
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    let run = 0;
    while (run < out.length && out[out.length - 1 - run] === "\\") run++;
    out += "\\".repeat(run) + "\\|" + parts[i];
  }
  return out;
}

// razor: shortening only, so the result stays faithful to the source text
// wherever it is printed — a markdown table cell wraps it in `truncateCell`
// instead, which escapes first and then cuts.
function truncate(text, n) {
  const clean = String(text).replace(/\s+/g, " ");
  return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
}

// Rule text inside a markdown table. Escaping runs BEFORE the cut so the added
// backslash is counted against the width, the way a rendered cell sees it.
function truncateCell(text, n) {
  return truncate(escapeTableCell(text), n);
}

// A `]` closes a markdown link label, so a path carrying one renders as literal
// text instead of a clickable location.
function mdLabel(s) {
  return String(s).replace(/([[\]])/g, "\\$1");
}

// A link target ends at a space or a `)`, a `#` starts a fragment and a `?` a
// query, and a `|` would still split the table row the link sits in. None of
// them survives as a raw byte. The LABEL beside it keeps the real path, so a
// terminal that reads `path:line` out of the visible text still sees it.
const TARGET_ESCAPES = { "(": "%28", ")": "%29", " ": "%20", "|": "%7C", "#": "%23", "?": "%3F" };
function mdTarget(s) {
  return String(s).replace(/[()| #?]/g, (c) => TARGET_ESCAPES[c]);
}

// A path as a clickable location, escaped on both halves: the label for the
// link syntax and the table cell it may sit in, the target for the URL. Pass
// `line` to open the file at it.
// [Foreman: 097] One implementation, so the seven call sites stop disagreeing.
// A backslash breaks a markdown link target and a full home directory does not
// belong in a shareable report; both used to be handled by a pair of local
// helpers that only some renderers had, so `--verbose`'s restructure section
// emitted raw `C:\Users\…` as a link that resolved nowhere.
const HOME_PREFIX = os.homedir().replace(/\\/g, "/");

// The label half of the same rule, for the places that print a path as text
// rather than as a link.
function displayPath(p) {
  const href = String(p).replace(/\\/g, "/");
  return HOME_PREFIX && href.startsWith(HOME_PREFIX) ? "~" + href.slice(HOME_PREFIX.length) : href;
}

function mdPathLink(p, line) {
  const at = line == null ? "" : ":" + line;
  const href = String(p).replace(/\\/g, "/");
  return `[${mdLabel(escapeTableCell(displayPath(p)))}${at}](${mdTarget(href)}${at})`;
}

// [Foreman: 072] The rejection message for a record this assay cannot read.
function staleRecordError(label, kind, problem) {
  return label + " is not a schema " + SCHEMA_VERSION + " " + kind + " record (" + problem + ") — rerun `assay.js scan` to replace it.";
}

function cmdReport(root, opts) {
  warnOpenChanges(root);
  const scanFile = path.join(root, TMP_DIR, "scan.json");
  if (!fs.existsSync(scanFile)) {
    process.stderr.write("No " + TMP_DIR + "/scan.json to report from — run `assay.js scan` here first" +
      " (in Claude Code, an audit command like `/assay:opus5` runs both).\n");
    process.exit(1);
  }
  const { record: scanData, problem } = readRecord(scanFile, "scan");
  if (problem) {
    process.stderr.write(staleRecordError(TMP_DIR + "/scan.json", "scan", problem) + "\n");
    process.exit(1);
  }
  // [Foreman: 097] A record copied in from somewhere else renders as a full,
  // confident report about files that are not here. The record names the
  // directory it was taken from, so this is a comparison, not a guess.
  const recordRoot = (scanData.context || {}).projectRoot;
  if (recordRoot && path.resolve(recordRoot) !== path.resolve(root)) {
    process.stderr.write(TMP_DIR + "/scan.json was taken from " + recordRoot + ", not " + path.resolve(root) +
      ".\n  A report from another project's scan would name files that are not here — run `scan` in this one.\n");
    process.exit(1);
  }
  // [Foreman: 071] No judgments file is the deterministic default, not an error.
  // A file that exists but does not validate is still fatal.
  const { judgments, error } = loadJudgments(root, scanData.rules);
  if (error) {
    process.stderr.write(error + "\n");
    process.exit(1);
  }
  const audit = makeRecord("audit", composeAudit(scanData, judgments, opts), root);
  fs.writeFileSync(path.join(root, TMP_DIR, "audit.json"), JSON.stringify(audit, null, 2));
  // [Foreman: 095] The default is the short report; --verbose is the full one,
  // unchanged. One line, so reverting the default is one line too.
  if (opts.json) process.stdout.write(JSON.stringify(audit, null, 2) + "\n");
  else if (opts.plain) process.stdout.write(renderPlain(audit) + "\n");
  else if (opts.verbose) process.stdout.write(renderReport(audit, opts) + "\n");
  else process.stdout.write(renderBrief(audit, opts) + "\n");
}

// [Foreman: 061]
// Remeasure closes the fix-and-check loop: re-scan the edited corpus, reuse every
// cached judgment whose rule is unchanged (keyed by the 059 content hash), and
// re-judge only the rules a fix reworded. The previous audit.json is read before
// the re-scan overwrites it, so the report can lead with before/after. This is
// why the audit skill no longer bans a second pass — it bounds it to one instead.
function cmdRemeasure(root, opts) {
  const tmp = path.join(root, TMP_DIR);
  fs.mkdirSync(tmp, { recursive: true });
  const judgeFile = path.join(tmp, "judgments.json");
  // [Foreman: 071] With no judgments to reuse there is nothing to re-judge:
  // remeasure stays deterministic end to end and goes straight to the report.
  const cached = fs.existsSync(judgeFile);
  // [Foreman: 072] A prior audit this assay cannot read is discarded, not fatal:
  // the re-scan is what the user asked for, and only the before/after comparison
  // depends on the old file.
  const auditFile = path.join(tmp, "audit.json");
  let prev = null;
  if (fs.existsSync(auditFile)) {
    const prior = readRecord(auditFile, "audit");
    if (prior.problem) {
      process.stderr.write("Ignoring " + TMP_DIR + "/audit.json from an older assay (" + prior.problem +
        ") — the before/after comparison is skipped this run.\n");
    } else {
      prev = prior.record;
    }
  }

  const scanData = scan(root, {
    projectOnly: opts.projectOnly, probeHost: true, adapter: opts.adapter, startup: opts.startup,
    rootFoundFrom: opts.rootFoundFrom,
  });
  requireStartupHonored(opts, scanData.context);
  writeRecord(path.join(tmp, "scan.json"), "scan", scanData, root);

  let judgments = null;
  if (cached) {
    try {
      judgments = JSON.parse(fs.readFileSync(judgeFile, "utf-8"));
    } catch (err) {
      process.stderr.write(TMP_DIR + "/judgments.json is not valid JSON: " + err.message + "\n");
      process.exit(1);
    }
  }

  const unknown = cached ? scanData.rules.filter((r) => !judgments[r.key]) : [];
  if (unknown.length) {
    // The fixes reworded these, so their hash is new and their old judgment is
    // gone. Emit them as a worklist and stop — the skill judges only these,
    // merges, and reruns. Nothing is composed or overwritten on this branch.
    process.stdout.write(JSON.stringify({
      remeasure: true,
      pending: unknown.length,
      judgmentsFile: TMP_DIR + "/judgments.json",
      note: "Judge these reworded rules, merge into judgments.json, then rerun remeasure.",
      judge: unknown.map((r) => ({
        id: r.id,
        key: r.key,
        text: r.text,
        context: r.contextText !== r.text ? r.contextText : undefined,
        needsF1: r.factors.F1.method === "extraction_failed",
        file: r.file,
        scope: (scanData.files[r.fileIndex] || {}).scope,
        ...((scanData.files[r.fileIndex] || {}).autoMemory ? { autoMemory: true } : {}),
      })),
    }, null, 2) + "\n");
    return;
  }

  const { judgments: valid, error } = loadJudgments(root, scanData.rules);
  if (error) {
    process.stderr.write(error + "\n");
    process.exit(1);
  }
  const audit = makeRecord("audit", composeAudit(scanData, valid, opts), root);
  fs.writeFileSync(auditFile, JSON.stringify(audit, null, 2));
  if (opts.json) process.stdout.write(JSON.stringify({ ...audit, previous: prev }, null, 2) + "\n");
  else process.stdout.write(renderReport(audit, { ...opts, prev }) + "\n");
}

// ---------------------------------------------------------------------------
// The safe-change transaction — [Foreman: 081]
// ---------------------------------------------------------------------------

// SCOPE.md's migration contract is `diagnose → plan → apply → validate`.
// `diagnose` is not a command: the scan/audit record already IS the diagnose
// artifact — context, coverage, per-file source hashes, findings as evidence.
// The four below are the mutation half, and the split between them and the audit
// skill is the mechanical-first rule drawn as a line: the skill interviews,
// chooses the rewrite, and collects approval; the engine owns the plan schema,
// the fingerprints, the exact patch, the staleness check, the journal and the
// rollback state. A model cannot decide a mechanical fact, so none of those live
// in prose.

// Where transaction state lives. NOT in `.assay-tmp/`: that directory's whole
// contract is "disposable", `clean` removes it, and the journal holds the only
// copy of a pre-image — the one file in this product that cannot be regenerated
// from the repository. A sibling `.assay/` keeps durability and disposability in
// different directories, so no future change to `clean` can widen into deleting
// an unrolled-back write. `clean` still removes a CLOSED journal (said out loud
// when it does) and refuses an open one; plan artifacts are kept, because a
// parked plan is a record the user meant to keep.
// STATE_DIR and statePath come from safety.js — see the require above.
const JOURNAL_FILE = "journal.jsonl";

// [Foreman: 162] How many dirty paths the refusal lists before it counts the
// rest. A refusal has to name the work it is refusing over; it does not have to
// print an entire unstaged rebase.
const DIRTY_PATHS_SHOWN = 10;

// The kinds of change a plan may carry. `park` is the deferral: recorded, never
// applied — the plan artifact itself is the park record.
const CHANGE_KINDS = ["rule-rewrite", "stale-reference-repair", "placement-promotion", "park"];

// Validation proportional to the kind, filled in when a draft names none. The
// steps are the mechanical ones assay can run itself; repository tests and fresh
// session smoke tests arrive through `--external` instead.
const VALIDATION_STEPS = {
  "rule-rewrite": ["reparse", "static-reanalysis"],
  "stale-reference-repair": ["reparse", "static-reanalysis"],
  "placement-promotion": ["reparse", "host-discovery", "static-reanalysis"],
  park: [],
};
const VALIDATION_STEP_NAMES = ["reparse", "host-discovery", "static-reanalysis"];

const MECHANISM_TYPES = ["hook", "skill", "subagent"];

// ---------------------------------------------------------------------------
// [Foreman: 167] Hook admission: proving a promoted hook before it is installed
// ---------------------------------------------------------------------------
//
// A hook is the one mechanism assay generates that changes what runs on every
// future turn of every future session. It is written from fetched
// documentation, and until now nothing between "the model wrote it" and "it is
// wired into settings.json" showed that it fires at all.
//
// Borrowed from jig's fixture-pair admission, with the one difference the
// primitive forces: jig proves a check by running its patterns over text, and a
// hook is a command, so this proves it by running the command. The shape is the
// same and so is the rule - a hook is admitted when it fires on its own
// violation fixture AND stays silent on its own near miss, and never for any
// other reason. The near miss is the half that matters: a hook that refuses
// everything passes the violation test.
//
// What this executes: the command out of the settings patch of the change being
// proved, nothing else, with the change's own files materialized in a scratch
// directory and the project untouched. It runs BEFORE the owner has approved
// anything, which is the point - the alternative is discovering the hook is
// wrong after it is installed - and fixes.md states it, so the procedure never
// hands assay a command the owner has not been shown.
const ADMISSION_TIMEOUT_MS = 10000;
const HOOK_SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"];

// Every command a settings file wires, with the event and matcher it sits
// under, so a discard can name the hook it is about.
function wiredHooks(settingsText) {
  let settings;
  try {
    settings = JSON.parse(settingsText);
  } catch (err) {
    return { problem: "the settings file it writes is not valid JSON (" + err.message + ")" };
  }
  const hooks = [];
  const table = (settings && settings.hooks) || {};
  for (const event of Object.keys(table)) {
    for (const group of Array.isArray(table[event]) ? table[event] : []) {
      for (const entry of Array.isArray(group && group.hooks) ? group.hooks : []) {
        if (entry && entry.type === "command" && typeof entry.command === "string" && entry.command.trim()) {
          hooks.push({ event, matcher: (group && group.matcher) || null, command: entry.command });
        }
      }
    }
  }
  return { hooks };
}

// The change's own files, at their project-relative paths, in a throwaway
// directory. An editing patch is replayed against the file as it stands now, so
// what runs is the settings file the apply WOULD produce rather than a fragment.
function materializeChange(root, change) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assay-admission-"));
  const written = new Map();
  for (const patch of change.patches) {
    let content = patch.new;
    if (patch.old !== null && patch.old !== undefined) {
      const from = path.join(root, patch.path);
      if (!fs.existsSync(from)) return { dir, problem: "it edits " + patch.path + ", which is not there" };
      content = fs.readFileSync(from, "utf-8").replace(patch.old, patch.new);
    }
    const target = path.join(dir, patch.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    written.set(patch.path, content);
  }
  return { dir, written };
}

// Did the hook refuse this input? Claude Code gives a hook two ways to say no -
// exit code 2, and a JSON decision on stdout - and any other non-zero exit is a
// failure the agent sees as a refusal too. Everything else is silence.
function hookRefused(result) {
  if (result.error) return { problem: "the hook command could not be run (" + result.error.message + ")" };
  if (result.signal) return { problem: "the hook command was killed (" + result.signal + "), so it proved nothing" };
  if (result.status !== 0) return { refused: true };
  const out = String(result.stdout || "").trim();
  if (out.startsWith("{")) {
    try {
      const decision = JSON.parse(out);
      const specific = decision.hookSpecificOutput || {};
      if (decision.decision === "block" || decision.continue === false ||
          decision.permissionDecision === "deny" || specific.permissionDecision === "deny") {
        return { refused: true };
      }
    } catch {
      // Unparseable stdout from an exit-0 hook is not a refusal; the host
      // ignores it too.
    }
  }
  return { refused: false };
}

function runHookOnce(command, dir, fixture) {
  const input = typeof fixture === "string" ? fixture : JSON.stringify(fixture);
  return spawnSync(command, {
    cwd: dir, shell: true, input, encoding: "utf-8", timeout: ADMISSION_TIMEOUT_MS,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
}

// The admission itself. Returns null when the promotion is admitted, or a
// sentence naming what stopped it - which is what the caller reports as the
// discard reason.
function admitHookPromotion(root, change) {
  const fixtures = change.fixtures;
  if (!isRecordObject(fixtures) || fixtures.violation === undefined || fixtures.nearMiss === undefined) {
    return "it carries no fixture pair, so nothing shows it fires - a hook promotion needs " +
      "`fixtures: { violation, nearMiss }`: the input the hook must refuse, and the neighbouring input it must let through";
  }
  const settingsPatch = change.patches.find((p) => HOOK_SETTINGS_FILES.includes(p.path));
  if (!settingsPatch) {
    return "it wires no hook: a hook promotion patches " + HOOK_SETTINGS_FILES.join(" or ");
  }
  const made = materializeChange(root, change);
  try {
    if (made.problem) return made.problem;
    const found = wiredHooks(made.written.get(settingsPatch.path));
    if (found.problem) return found.problem;
    if (!found.hooks.length) return "the settings file it writes wires no command hook";
    for (const hook of found.hooks) {
      const name = hook.event + (hook.matcher ? " on " + hook.matcher : "");
      const onViolation = hookRefused(runHookOnce(hook.command, made.dir, fixtures.violation));
      if (onViolation.problem) return name + ": " + onViolation.problem;
      if (!onViolation.refused) {
        return name + " let its own violation fixture through - the hook does not catch the thing it was written for";
      }
      const onNearMiss = hookRefused(runHookOnce(hook.command, made.dir, fixtures.nearMiss));
      if (onNearMiss.problem) return name + ": " + onNearMiss.problem;
      if (onNearMiss.refused) {
        return name + " refused its near miss too - a hook that blocks the neighbouring case blocks work it was never asked to stop";
      }
    }
    return null;
  } finally {
    fs.rmSync(made.dir, { recursive: true, force: true });
  }
}

// Every hook promotion in a draft, proved before the plan exists. A discarded
// change never reaches the plan artifact, so it can never be previewed,
// approved or applied - and every discard is reported, because a promotion that
// quietly vanished would read as one the audit never proposed.
function admitDraftHooks(root, changes) {
  const kept = [];
  const discarded = [];
  for (const raw of changes) {
    const isHook = isRecordObject(raw) && raw.kind === "placement-promotion" &&
      isRecordObject(raw.mechanism) && raw.mechanism.type === "hook";
    if (!isHook) { kept.push(raw); continue; }
    let reason;
    try {
      reason = admitHookPromotion(root, { ...raw, patches: Array.isArray(raw.patches) ? raw.patches : [] });
    } catch (err) {
      reason = "the admission test could not be run (" + err.message + ")";
    }
    if (reason) discarded.push({ id: typeof raw.id === "string" ? raw.id : "?", mechanism: raw.mechanism.name, reason });
    else kept.push(raw);
  }
  return { kept, discarded };
}

// A path a plan is allowed to write: project-relative, inside the root. The
// trust boundary — a draft plan is JSON the skill assembled, and an absolute or
// `..` path in it must never become a write outside the project.
function resolvePlanPath(root, rel) {
  if (typeof rel !== "string" || !rel.trim() || path.isAbsolute(rel)) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

// The write-time half of that boundary. resolvePlanPath screens the DRAFT; a
// plan artifact or journal row is a file on disk that may have been edited
// since, so every actual write re-checks its destination here — lexically
// first, then through the real path of the nearest existing ancestor, because a
// symlinked or junctioned directory inside the project that points outside IS
// outside, and a lexical prefix check cannot see that.
function resolveWritePath(root, rel) {
  const lexical = resolvePlanPath(root, typeof rel === "string" ? rel : "");
  if (!lexical) return null;
  let probe = path.dirname(lexical);
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  let realBase, realRoot;
  try {
    realBase = fs.realpathSync(probe);
    realRoot = fs.realpathSync(path.resolve(root));
  } catch {
    return null; // a boundary that cannot be resolved is not one to write past
  }
  const from = path.relative(realRoot, realBase);
  return from === "" || (!from.startsWith("..") && !path.isAbsolute(from)) ? lexical : null;
}

function countOccurrences(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Plan schema
// ---------------------------------------------------------------------------

// Read-boundary validation of a plan payload. Returns null when the changes are
// a usable instance, otherwise the first reason — the same discipline
// validateRecord uses, so a plan file rejects with one sentence naming what is
// wrong.
function validatePlanChanges(changes, batches) {
  if (!changes.length) return "a plan carries at least one change";
  const ids = new Set();
  for (const c of changes) {
    if (!isRecordObject(c)) return "a change is not an object";
    if (typeof c.id !== "string" || !c.id) return "a change is missing a string id";
    if (ids.has(c.id)) return "duplicate change id: " + c.id;
    ids.add(c.id);
    if (!CHANGE_KINDS.includes(c.kind)) return "change " + c.id + ": unknown kind " + JSON.stringify(c.kind);
    if (typeof c.rationale !== "string" || !c.rationale) return "change " + c.id + ": rationale is missing";
    if (!Array.isArray(c.files)) return "change " + c.id + ": files is missing or not an array";
    if (!Array.isArray(c.patches)) return "change " + c.id + ": patches is missing or not an array";
    if (c.kind === "park") {
      if (c.patches.length) return "change " + c.id + ": a park carries no patch — it records a deferral";
    } else if (!c.patches.length) {
      return "change " + c.id + ": no patch — a change that writes nothing is a park";
    }
    // One patch per file per change: the journal replays writes keyed by stage
    // and path, so a second patch on the same file would shadow the first
    // pre-image and a rollback would restore the file half-changed.
    const touched = new Set();
    for (const p of c.patches) {
      if (!isRecordObject(p) || typeof p.path !== "string") continue;
      if (touched.has(p.path)) {
        return "change " + c.id + ": two patches touch " + p.path +
          " — fold them into one patch whose `old` spans both edits";
      }
      touched.add(p.path);
    }
    for (const p of c.patches) {
      const problem = validatePlanPatch(c.id, p);
      if (problem) return problem;
    }
    if (!Array.isArray(c.validation)) return "change " + c.id + ": validation is missing or not an array";
    for (const step of c.validation) {
      if (!VALIDATION_STEP_NAMES.includes(step)) return "change " + c.id + ": unknown validation step " + JSON.stringify(step);
    }
    if (typeof c.rollback !== "string" || !c.rollback) return "change " + c.id + ": rollback story is missing";
    if (c.kind === "placement-promotion") {
      // A generated host artifact names the documentation its format came from,
      // and the mechanism it claims to install — otherwise `validate` has no
      // discovery question to ask and the format has no provenance.
      if (!isRecordObject(c.mechanism) || !MECHANISM_TYPES.includes(c.mechanism.type) || !c.mechanism.name) {
        return "change " + c.id + ": a promotion names mechanism { type: " + MECHANISM_TYPES.join("|") + ", name }";
      }
      if (!Array.isArray(c.provenance) || !c.provenance.length) {
        return "change " + c.id + ": a promotion records the documentation provenance behind its format";
      }
      for (const d of c.provenance) {
        if (!isRecordObject(d) || typeof d.claim !== "string" || typeof d.url !== "string") {
          return "change " + c.id + ": each provenance entry needs a claim and a url";
        }
      }
    }
  }
  if (batches !== undefined) {
    if (!isRecordObject(batches)) return "batches is not an object";
    for (const [name, members] of Object.entries(batches)) {
      if (!Array.isArray(members) || !members.length) return "batch " + name + " is empty";
      for (const m of members) if (!ids.has(m)) return "batch " + name + " names unknown change " + m;
    }
  }
  return null;
}

function validatePlanPatch(changeId, p) {
  const where = "change " + changeId + ": patch";
  if (!isRecordObject(p)) return where + " is not an object";
  if (typeof p.path !== "string" || !p.path) return where + " is missing a path";
  // Containment is re-checked at this read boundary: a plan artifact is JSON on
  // disk and may have been edited since `plan` wrote it. No root is in scope
  // here, so the check is lexical; the write itself re-checks with real paths.
  const norm = path.posix.normalize(p.path.replace(/\\/g, "/"));
  if (path.isAbsolute(p.path) || /^[A-Za-z]:/.test(p.path) || norm === ".." || norm.startsWith("../")) {
    return where + " on " + p.path + " escapes the project root";
  }
  if (typeof p.new !== "string") return where + " on " + p.path + " is missing a `new` string";
  // The fingerprint is the staleness check's whole basis, so its absence is a
  // rejection rather than a re-derivation: a plan that cannot say what the file
  // looked like cannot say the file is unchanged.
  if (!("sourceHash" in p)) return where + " on " + p.path + " is missing its source fingerprint";
  const creates = p.sourceHash === null;
  if (!creates && typeof p.sourceHash !== "string") return where + " on " + p.path + " has a non-string fingerprint";
  if (creates && p.old !== null) return where + " on " + p.path + " creates the file, so `old` is null";
  if (!creates && (typeof p.old !== "string" || !p.old)) return where + " on " + p.path + " is missing the `old` text it replaces";
  return null;
}

// Draft → canonical plan payload. Everything mechanical is computed here rather
// than trusted from the draft: the fingerprints, the affected-file list, the
// default validation steps, and the uniqueness of every `old` string.
function planFromDraft(draft, root) {
  const problems = [];
  if (!isRecordObject(draft)) return { problems: ["the draft is not a JSON object"] };
  if (!Array.isArray(draft.changes) || !draft.changes.length) {
    return { problems: ["the draft has no `changes` array"] };
  }
  const changes = [];
  for (const raw of draft.changes) {
    if (!isRecordObject(raw)) { problems.push("a change is not an object"); continue; }
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const label = "change " + (id || "?");
    const patches = [];
    for (const p of Array.isArray(raw.patches) ? raw.patches : []) {
      const patch = fingerprintPatch(p, root, label, problems);
      if (patch) patches.push(patch);
    }
    const files = [...new Set(patches.map((p) => p.path))].sort();
    const validation = [...new Set(
      Array.isArray(raw.validation) && raw.validation.length ? raw.validation : (VALIDATION_STEPS[raw.kind] || [])
    )].sort();
    // Key order is fixed so two runs over the same draft produce byte-identical
    // plans, which is what makes the plan id a content hash rather than a clock.
    const change = {
      id, kind: raw.kind, rationale: typeof raw.rationale === "string" ? raw.rationale.trim() : "",
      files, patches: patches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      validation,
      rollback: typeof raw.rollback === "string" && raw.rollback.trim()
        ? raw.rollback.trim()
        : "restore the journalled pre-image of every file this change wrote",
      coverage: {
        predicted: typeof raw.predicted === "string" ? raw.predicted : "",
        limitations: Array.isArray(raw.limitations) ? raw.limitations.filter((l) => typeof l === "string") : [],
      },
    };
    if (raw.addresses) change.addresses = String(raw.addresses);
    if (raw.mechanism) change.mechanism = { type: raw.mechanism.type, name: raw.mechanism.name };
    if (raw.provenance) change.provenance = raw.provenance;
    changes.push(change);
  }
  changes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const batches = {};
  for (const name of Object.keys(draft.batches || {}).sort()) {
    batches[name] = [...new Set(draft.batches[name])].sort();
  }
  const problem = problems.length ? null : validatePlanChanges(changes, batches);
  if (problem) problems.push(problem);
  if (problems.length) return { problems };
  const planId = hashContent(JSON.stringify({ changes, batches })).slice(0, 12);
  return {
    problems: [],
    payload: {
      planId,
      changes,
      batches,
      coverage: { changes: changes.length, files: [...new Set(changes.flatMap((c) => c.files))].sort() },
    },
  };
}

function fingerprintPatch(raw, root, label, problems) {
  if (!isRecordObject(raw)) { problems.push(label + ": a patch is not an object"); return null; }
  const rel = typeof raw.path === "string" ? raw.path.replace(/\\/g, "/").trim() : "";
  const full = resolvePlanPath(root, rel);
  if (!full) { problems.push(label + ": " + JSON.stringify(raw.path) + " is not a project-relative path"); return null; }
  if (typeof raw.new !== "string") { problems.push(label + ": the patch on " + rel + " has no `new` string"); return null; }
  const exists = fs.existsSync(full);
  const creates = raw.old === null || raw.old === undefined;
  if (creates) {
    if (exists) { problems.push(label + ": " + rel + " already exists — give the patch an `old` string to edit it"); return null; }
    return { path: rel, sourceHash: null, old: null, new: raw.new };
  }
  if (typeof raw.old !== "string" || !raw.old) { problems.push(label + ": the patch on " + rel + " has an empty `old`"); return null; }
  if (!exists) { problems.push(label + ": " + rel + " does not exist, so no fingerprint can be taken"); return null; }
  const content = fs.readFileSync(full, "utf-8");
  const hits = countOccurrences(content, raw.old);
  if (hits === 0) { problems.push(label + ": the `old` text is not in " + rel); return null; }
  if (hits > 1) {
    problems.push(label + ": the `old` text occurs " + hits + " times in " + rel +
      " — extend it with surrounding context until it matches once");
    return null;
  }
  return { path: rel, sourceHash: hashContent(content), old: raw.old, new: raw.new };
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

// ARCHITECT'S CALL, encoded here: a journal row stores its pre-image VERBATIM.
// Reversibility beats redaction inside a private local file — a redacted
// pre-image restores a file the user never had, which is data loss wearing a
// safety hat. The journal is therefore never rendered into a report or an
// export; any future rendered view of it passes through redactSecrets first,
// exactly as the report already does.
function appendJournal(root, row) {
  const file = statePath(root, JOURNAL_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
}

function readJournal(root) {
  const file = statePath(root, JOURNAL_FILE);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  // [Foreman: 085] A torn LAST line is an interrupted append — the write died
  // mid-row and there is nothing after it to lose. A torn line with rows behind
  // it is damage, and skipping it would silently drop a pre-image this file
  // holds the only copy of. So the two cases are told apart rather than both
  // being swallowed: the first is tolerated, the second refuses to be read.
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const last = lines.reduce((n, line, i) => (line.trim() ? i : n), -1);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      rows.push(JSON.parse(lines[i]));
    } catch (err) {
      if (i === last) continue;
      throw expected(STATE_DIR + "/" + JOURNAL_FILE + " is damaged: line " + (i + 1) + " of " +
        (last + 1) + " is not valid JSON (" + err.message + ")." +
        "\n  Only a torn final line is an interrupted append. An earlier one means the journal was" +
        " edited or truncated, and it holds the only copy of the files as they were — repair or" +
        " remove that line before running a transaction command again.");
    }
  }
  return rows;
}

// The journal is append-only, so state is a replay rather than a field anyone
// updates. Keyed by stage and path, so two writes to one file at different
// stages stay independent things to restore.
function replayJournal(rows) {
  const changes = new Map();
  let order = 0;
  for (const row of rows) {
    if (!row.change) continue;
    let c = changes.get(row.change);
    if (!c) {
      c = { id: row.change, transaction: row.transaction, plan: row.plan, writes: new Map(), evidence: [], rejected: false };
      changes.set(row.change, c);
    }
    c.transaction = row.transaction || c.transaction;
    const stage = row.stage || "apply";
    const key = stage + "\0" + row.path;
    if (row.event === "intent") {
      c.writes.set(key, {
        stage, path: row.path, preImage: row.preImage === undefined ? null : row.preImage,
        patch: row.patch, written: false, restored: false, order: ++order,
      });
    } else if (row.event === "outcome") {
      const w = c.writes.get(key);
      if (w) { w.written = true; w.hashAfter = row.hashAfter; w.order = ++order; }
    } else if (row.event === "restore") {
      const w = c.writes.get(key);
      if (w) { w.written = false; w.restored = true; w.order = ++order; }
    } else if (row.event === "reject") {
      c.rejected = true;
    } else if (row.event === "evidence") {
      c.evidence.push(row);
    }
  }
  return changes;
}

function changeWrites(state, stage) {
  return [...state.writes.values()].filter((w) => (stage ? w.stage === stage : true));
}

// The evidence rows of a change's LATEST validation run. Rows carry the `run`
// marker cmdValidate stamps per invocation; rows written before the marker
// existed group as one legacy run, which errs toward blocking — an old fail
// keeps blocking until a fresh validate passes clean.
function latestValidationEvidence(state) {
  const rows = state ? state.evidence : [];
  if (!rows.length) return [];
  const key = rows[rows.length - 1].run;
  return rows.filter((e) => e.run === key);
}

// A validation resolves a change only when its latest run passed IN FULL. One
// step recording `pass` beside another recording `fail` is a failed run — the
// static-reanalysis step always records `pass` because it is a recording, and
// that row alone must never read as success.
function latestRunClean(state) {
  const latest = latestValidationEvidence(state);
  return latest.some((e) => e.result === "pass") && !latest.some((e) => e.result === "fail");
}

// Open = written (or interrupted mid-write) and not yet resolved. The two
// resolutions are a clean validation run and a rollback.
function openChangeIds(rows) {
  const open = [];
  for (const c of replayJournal(rows).values()) {
    const live = changeWrites(c).filter((w) => !w.restored);
    if (!live.length) continue;
    const interrupted = live.some((w) => !w.written);
    if (!interrupted && latestRunClean(c)) continue;
    open.push(c.id);
  }
  return open;
}

// ---------------------------------------------------------------------------
// Writing, and checking what was written
// ---------------------------------------------------------------------------

function readIfExists(full) {
  return fs.existsSync(full) ? fs.readFileSync(full, "utf-8") : null;
}

// The mechanical post-write check, proportional to what the file is: JSON parses
// as JSON, a Markdown file's frontmatter parses as YAML and its body re-parses,
// and every path the change claims to have written exists. Nothing here judges
// content — it establishes that the artifact assay just produced is readable by
// the same parsers the host uses.
function postWriteProblems(root, paths) {
  const problems = [];
  for (const rel of paths) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) { problems.push(rel + " was written but is not on disk"); continue; }
    const text = fs.readFileSync(full, "utf-8");
    const ext = path.extname(rel).toLowerCase();
    if (ext === ".json") {
      try { JSON.parse(text); } catch (err) { problems.push(rel + " is not valid JSON: " + err.message); }
    } else if (ext === ".jsonl") {
      text.split("\n").forEach((line, i) => {
        if (!line.trim()) return;
        try { JSON.parse(line); } catch (err) { problems.push(rel + " line " + (i + 1) + " is not valid JSON: " + err.message); }
      });
    } else if (ext === ".md") {
      const fm = parseFrontmatterBlock(text);
      if (fm.error) problems.push(rel + " frontmatter is not valid YAML: " + fm.error);
      try { md.parse(text, {}); } catch (err) { problems.push(rel + " no longer parses as Markdown: " + err.message); }
    } else if (ext === ".yaml" || ext === ".yml") {
      // [Foreman: 082] A crafted Codex skill writes `agents/openai.yaml` beside
      // its SKILL.md, and that sidecar is where implicit invocation and the tool
      // dependencies are declared. A sidecar the host cannot parse is exactly as
      // broken as frontmatter it cannot parse — so it gets the same check, and
      // therefore the same automatic restore.
      try {
        yaml.load(text);
      } catch (err) {
        problems.push(rel + " is not valid YAML: " + String(err.message).split("\n")[0].trim());
      }
    }
  }
  return problems;
}

function writePatch(root, patch) {
  const full = path.join(root, patch.path);
  if (patch.sourceHash === null) {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, patch.new);
    return patch.new;
  }
  const content = fs.readFileSync(full, "utf-8");
  const next = content.replace(patch.old, () => patch.new);
  fs.writeFileSync(full, next);
  return next;
}

// The crash-ordering rule, in one place: intent BEFORE the write, outcome AFTER
// it. The journal may therefore claim a pre-image for a write that never
// happened — restoring it is a no-op — but can never hold a write whose
// pre-image was not recorded first, which would be unrecoverable. An intent with
// no outcome is exactly an interrupted apply, and `rollback` resolves it.
// razor: appendFileSync, not fsync — the ceiling is a power cut between the OS
// write and the disk, which loses the last row rather than lying about it. An
// fsync per row is the upgrade path if that ever matters.
function journalledWrite(root, ctx, patch, stage) {
  const full = resolveWritePath(root, patch.path);
  if (!full) {
    throw expected("Refusing to write " + patch.path + " for change " + ctx.change +
      ": the path resolves outside the project root. The plan was edited after it was written," +
      " or a directory on the path is a link that leaves the project. Nothing was written.");
  }
  const preImage = readIfExists(full);
  appendJournal(root, {
    event: "intent", stage, transaction: ctx.transaction, plan: ctx.plan, change: ctx.change,
    path: patch.path, preImage, patch: { old: patch.old, new: patch.new },
    hashBefore: preImage === null ? null : hashContent(preImage),
  });
  const written = writePatch(root, patch);
  appendJournal(root, {
    event: "outcome", stage, transaction: ctx.transaction, plan: ctx.plan, change: ctx.change,
    path: patch.path, hashAfter: hashContent(written),
  });
}

// Put one journalled write back the way it was. `preImage === null` means the
// write created the file, so undoing it is removing the file again.
function restoreWrite(root, ctx, write, cause) {
  // The journal is a file too, and a restore is a write: same boundary.
  const full = resolveWritePath(root, write.path);
  if (!full) {
    throw expected("Refusing to restore " + write.path + " for change " + ctx.change +
      ": the path resolves outside the project root. Nothing was restored for it.");
  }
  if (write.preImage === null) {
    // The write created the file, so undoing it removes the file — and the
    // directories the write had to create along with it, or a rolled-back skill
    // promotion leaves an empty `.claude/skills/<name>/` behind.
    fs.rmSync(full, { force: true });
    for (let dir = path.dirname(full); dir.startsWith(path.resolve(root) + path.sep); dir = path.dirname(dir)) {
      if (!fs.existsSync(dir) || fs.readdirSync(dir).length) break;
      fs.rmdirSync(dir);
    }
  } else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, write.preImage); }
  appendJournal(root, {
    event: "restore", stage: write.stage, transaction: ctx.transaction, plan: ctx.plan, change: ctx.change,
    path: write.path, cause, hashAfter: write.preImage === null ? null : hashContent(write.preImage),
  });
}

// ---------------------------------------------------------------------------
// Locating a change
// ---------------------------------------------------------------------------

function planFiles(root) {
  const dir = statePath(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^plan-[0-9a-f]+\.json$/.test(f)).sort()
    .map((f) => path.join(dir, f));
}

// A change id resolves against every plan artifact in `.assay/`. Two plans
// defining the same id is a refusal, not a guess — the CLI argument is the
// approval boundary and it has to mean one thing.
// razor: all plans are searched on every lookup. A `--plan <id>` selector is the
// upgrade path when a project keeps enough parked plans for that to cost.
function findChange(root, changeId) {
  const hits = [];
  for (const file of planFiles(root)) {
    const { record, problem } = readRecord(file, "plan");
    if (problem) return { problem: path.relative(root, file) + " is not a readable plan (" + problem + ")" };
    const change = record.changes.find((c) => c.id === changeId);
    if (change) hits.push({ plan: record, change, file });
  }
  if (!hits.length) return { problem: "no plan in " + STATE_DIR + "/ defines change " + changeId };
  if (hits.length > 1) {
    return { problem: "change " + changeId + " is defined by " + hits.length + " plans (" +
      hits.map((h) => h.plan.planId).join(", ") + ") — the id has to name one change" };
  }
  return hits[0];
}

function findBatch(root, batchId) {
  const hits = [];
  for (const file of planFiles(root)) {
    const { record, problem } = readRecord(file, "plan");
    if (problem) return { problem: path.relative(root, file) + " is not a readable plan (" + problem + ")" };
    if (record.batches && record.batches[batchId]) hits.push({ plan: record, members: record.batches[batchId] });
  }
  if (!hits.length) return { problem: "no plan in " + STATE_DIR + "/ defines batch " + batchId };
  if (hits.length > 1) return { problem: "batch " + batchId + " is defined by more than one plan" };
  return hits[0];
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

// [Foreman: 085] An expected failure raised from deep inside a read, where
// `fail` cannot be used because the caller may be a library consumer rather
// than the CLI. The entry point turns it into the same exit 1 and message; an
// unmarked throw is a bug and keeps its stack.
function expected(message) {
  const err = new Error(message);
  err.expected = true;
  return err;
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

function cmdPlan(root, opts) {
  if (!opts.from) fail("plan needs --from <draft.json>.");
  const draftFile = path.resolve(root, opts.from);
  if (!fs.existsSync(draftFile)) fail("No draft plan at " + opts.from + ".");
  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(draftFile, "utf-8"));
  } catch (err) {
    fail(opts.from + " is not valid JSON: " + err.message);
  }
  // [Foreman: 167] Every hook promotion is proved against its own fixture pair
  // before the plan exists. A hook that misses its violation, or fires on its
  // near miss, is discarded here - so it can never be previewed, approved or
  // installed - and every discard is reported below rather than disappearing.
  const admitted = admitDraftHooks(root, Array.isArray(draft.changes) ? draft.changes : []);
  const discardReport = admitted.discarded
    .map((d) => "  " + d.id + " (hook " + d.mechanism + "): " + d.reason);
  if (admitted.discarded.length && !admitted.kept.length) {
    fail("Every change in the draft was discarded by the hook admission test, so there is no plan:\n" +
      discardReport.join("\n"));
  }
  const batches = {};
  for (const name of Object.keys(draft.batches || {})) {
    const members = (draft.batches[name] || []).filter((id) => !admitted.discarded.some((d) => d.id === id));
    if (members.length) batches[name] = members;
  }
  const { problems, payload } = planFromDraft({ ...draft, changes: admitted.kept, batches }, root);
  if (problems.length) fail("The draft plan was rejected:\n  " + problems.join("\n  "));
  for (const d of admitted.discarded) {
    appendJournal(root, {
      event: "discard", stage: "plan", plan: payload.planId, change: d.id,
      mechanism: d.mechanism, reason: d.reason,
    });
  }
  const file = statePath(root, "plan-" + payload.planId + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The one file `plan` writes. It never touches a policy file: a plan states
  // what WOULD be written and nothing more.
  writeRecord(file, "plan", payload, root);
  process.stdout.write(JSON.stringify({
    planId: payload.planId,
    planFile: STATE_DIR + "/plan-" + payload.planId + ".json",
    changes: payload.changes.map((c) => ({ id: c.id, kind: c.kind, files: c.files })),
    batches: payload.batches,
    // [Foreman: 167] What the admission test threw away, and why. Never
    // omitted when empty: "nothing was discarded" is a result too.
    discarded: admitted.discarded,
  }, null, 2) + "\n");
  if (admitted.discarded.length) {
    process.stderr.write("Discarded by the hook admission test - not in this plan:\n" +
      discardReport.join("\n") + "\n");
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

// The transaction id is a function of the plan and the exact set of approved
// change ids, so the recorded boundary is the approval that was actually given.
function transactionId(planId, ids) {
  return "t" + hashContent(planId + "\0" + [...ids].sort().join(",")).slice(0, 10);
}

function cmdApply(root, opts) {
  // [Foreman: 162] Before anything is written, the undo story has to exist.
  // A dirty tree is a hard stop and never a stash: `git stash -u` moves the
  // owner's work somewhere they have to remember to look, which is a worse
  // trade than one refusal. The paths are named, because "commit first" is not
  // actionable unless it says what.
  const pre = preflight(root);
  if (pre.dirty.length) {
    const shown = pre.dirty.slice(0, DIRTY_PATHS_SHOWN);
    fail("The git tree has uncommitted changes, so apply stopped before writing anything." +
      "\n  " + shown.join("\n  ") +
      (pre.dirty.length > shown.length ? "\n  ...and " + (pre.dirty.length - shown.length) + " more" : "") +
      "\n  Undo for a git project is putting the files back the way the last commit had them, and that " +
      "only means something from a clean tree. Commit or stash this work yourself first — assay will not " +
      "move it for you.");
  }

  let ids = opts.changes;
  if (opts.batch) {
    // A batch is an approval too — an explicitly named one, defined in the plan.
    // It is what kept the retired apply-everything flag a recorded boundary.
    const found = findBatch(root, opts.batch);
    if (found.problem) fail(found.problem);
    ids = [...ids, ...found.members];
  }
  if (!ids.length) {
    fail("apply needs --change <id> (repeatable) or --batch <id>. There is no apply-everything default: " +
      "the argument is the approval boundary.");
  }
  ids = [...new Set(ids)];

  // Pre-flight every named change before writing anything. A stale plan must
  // never half-apply, so staleness is decided across the whole approved set.
  const selected = [];
  for (const id of ids) {
    const found = findChange(root, id);
    if (found.problem) fail(found.problem);
    const { plan, change } = found;
    if (change.kind === "park") {
      fail("change " + id + " is a park: a recorded deferral with nothing to apply. " +
        "Its plan artifact is the park record.");
    }
    const ctx = { transaction: transactionId(plan.planId, ids), plan: plan.planId, change: id };
    for (const patch of change.patches) {
      const full = path.join(root, patch.path);
      const found2 = fs.existsSync(full) ? hashContent(fs.readFileSync(full, "utf-8")) : null;
      if (found2 !== patch.sourceHash) {
        appendJournal(root, {
          event: "reject", stage: "apply", transaction: ctx.transaction, plan: ctx.plan, change: id,
          path: patch.path, reason: "stale-fingerprint", expected: patch.sourceHash, found: found2,
        });
        fail("Stale plan: " + patch.path + " changed since change " + id + " was planned.\n" +
          "  planned fingerprint: " + (patch.sourceHash === null ? "(file absent)" : patch.sourceHash) + "\n" +
          "  fingerprint now:     " + (found2 === null ? "(file absent)" : found2) + "\n" +
          "  Re-plan against the current file: `assay.js plan --from <draft.json>`. Nothing was written.");
      }
    }
    selected.push({ change, ctx });
  }

  // [Foreman: 162] One row per run, written BEFORE the writes rather than after
  // them, so a batch that half-applies is still a run a revert can find.
  //
  // [Foreman: 176] The copies are made in a repository too. `gitHead` alone is
  // a pointer into a history that can be rebased, amended or garbage-collected
  // out from under the row, and then the only recorded route is dead. Copying
  // costs one pass over the files the run already opens, and it is what makes
  // the two-route choice /assay:revert offers a real one on every row.
  const txId = selected[0].ctx.transaction;
  const files = [...new Set(selected.flatMap(({ change }) => change.patches.map((p) => p.path)))].sort();
  const backupDir = backupFiles(root, txId, files);
  appendTransaction(root, {
    txId,
    startedAt: new Date().toISOString(),
    model: MODEL_PROFILE.id,
    assayVersion: ANALYZER_VERSION,
    gitHead: pre.head,
    backupDir,
    files,
    changes: selected.flatMap(({ change }) =>
      change.patches.map((p) => ({ id: change.id, kind: change.kind, path: p.path }))),
  });

  const applied = [];
  for (const { change, ctx } of selected) {
    for (const patch of change.patches) journalledWrite(root, ctx, patch, "apply");
    // Syntax validation happens the moment the write lands, not at `validate`
    // time: an unparseable artifact is assay's own failure and it undoes it.
    const problems = postWriteProblems(root, change.patches.map((p) => p.path));
    if (problems.length) {
      const state = replayJournal(readJournal(root)).get(change.id);
      for (const w of changeWrites(state, "apply").filter((w) => w.written).sort((a, b) => b.order - a.order)) {
        restoreWrite(root, ctx, w, "post-write-validation");
      }
      // The batch is not atomic across changes, so the honest failure names the
      // part that DID land: earlier changes stay applied, journalled, and
      // reversible — but only if the reader knows they are there.
      const landed = applied.map((a) => a.id + " (" + a.files.join(", ") + ")");
      fail("Change " + change.id + " was restored: what it wrote does not parse.\n  " + problems.join("\n  ") +
        "\n  Both the write and the restore are in " + STATE_DIR + "/" + JOURNAL_FILE + "." +
        (landed.length
          ? "\n  Applied before it and still in place: " + landed.join("; ") +
            ". Undo them with `assay.js rollback --change <id>`."
          : ""));
    }
    applied.push({ id: change.id, transaction: ctx.transaction, files: change.patches.map((p) => p.path) });
  }

  process.stdout.write(JSON.stringify({
    applied,
    journal: STATE_DIR + "/" + JOURNAL_FILE,
    // [Foreman: 162] Where the undo lives once `clean` has taken the journal.
    transactions: STATE_DIR + "/" + TRANSACTIONS_FILE,
    backupDir,
    // No apply kind deletes or deactivates prose. A promotion adds the mechanism
    // beside the rule; a rewrite replaces rule text and leaves the rule in place.
    // Deactivating a rule is the author's own edit, outside this transaction:
    // `rollback` restores what assay wrote, never what a person wrote by hand.
    note: "The source instruction is still active. Validate next: `assay.js validate --change <id>`.",
  }, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

// The journal's evidence vocabulary is SCOPE.md's, plus one: `attested`, for a
// result recorded from outside — a repository test run, a fresh-session smoke
// test. assay did not compute it and will not call it mechanical. The extra
// level is safe here precisely because the journal is never rendered into a
// report, so it can never sit beside a finding's evidence tag.
function externalEvidence(spec) {
  const at = spec.indexOf(":");
  if (at === -1) return null;
  const kind = spec.slice(0, at).trim();
  const result = spec.slice(at + 1).trim();
  if (!kind || !result) return null;
  return { kind, result };
}

function validationEvidence(root, opts, change) {
  const rows = [];
  for (const step of change.validation) {
    if (step === "reparse") {
      const problems = postWriteProblems(root, change.files);
      rows.push({
        kind: "reparse", level: "mechanical", result: problems.length ? "fail" : "pass",
        detail: problems.length ? problems.join("; ") : change.files.join(", ") + " parse",
      });
    } else if (step === "static-reanalysis") {
      // razor: this step RECORDS the delta, it never fails on one. A finding
      // that survives a change is not automatically a defect — a promotion
      // deliberately leaves its rule and its placement finding in place. Deciding
      // which surviving finding is wrong is a judgment, and the judgment belongs
      // to the developer reading this row.
      const audit = composeAudit(scan(root, { projectOnly: true, adapter: opts.adapter, startup: opts.startup }), null);
      const states = {};
      // A rule finding names a `state`; a file or corpus finding names a `type`.
      for (const f of audit.findings) {
        const label = f.state || f.type;
        states[label] = (states[label] || 0) + 1;
      }
      // [Foreman: 097] A rewrite CHANGES the text, and the key is a hash of the
      // text — so every successful rewrite reported "the rule it addressed no
      // longer exists under that content hash" beside `result: pass`, which reads
      // as the rule having been destroyed. Look the rewritten rule up by what
      // this change actually wrote before falling back.
      let rule = change.addresses ? audit.rules.find((r) => r.key === change.addresses) : null;
      let rewritten = false;
      if (change.addresses && !rule) {
        const wrote = new Map((change.patches || []).map((p) => [p.path, String(p.new)]));
        const hits = audit.rules.filter((r) => wrote.has(r.file) && wrote.get(r.file).includes(r.text));
        rule = hits.sort((a, b) => b.text.length - a.text.length)[0] || null;
        rewritten = Boolean(rule);
      }
      const carries = (r) => audit.findings.filter((f) => f.rule === r.id).map((f) => f.state || f.type).join(", ") || "no finding";
      const addressed = change.addresses
        ? (rule
          ? (rewritten
            ? `the rewritten rule is now at ${rule.file}:${rule.lineStart} and carries: ${carries(rule)}`
            : "the rule it addressed still carries: " + carries(rule))
          : "the rule it addressed is no longer in the corpus under its old wording, and nothing this change wrote contains it")
        : "no rule was named, so this records the corpus state only";
      rows.push({
        kind: "static-reanalysis", level: "mechanical", result: "pass",
        detail: addressed + " — " + audit.findings.length + " finding(s) across " +
          audit.rules.length + " rule(s): " +
          Object.entries(states).map(([k, v]) => k + " " + v).join(", "),
      });
    } else if (step === "host-discovery") {
      rows.push(hostDiscoveryEvidence(root, opts, change));
    }
  }
  for (const spec of opts.external) {
    const parsed = externalEvidence(spec);
    if (!parsed) fail('--external takes "<kind>: <result>", e.g. --external "repo tests: pass".');
    rows.push({
      kind: parsed.kind, level: "attested", result: parsed.result,
      detail: "recorded from outside — assay did not run this",
    });
  }
  return rows;
}

function hostDiscoveryEvidence(root, opts, change) {
  const mech = change.mechanism || {};
  const scanData = scan(root, { projectOnly: true, adapter: opts.adapter, startup: opts.startup });
  let seen = false;
  if (mech.type === "hook") {
    seen = scanData.hookInventory.some((h) => change.files.includes(h.source) ||
      (h.command || "").includes(mech.name));
  } else if (mech.type === "skill") {
    seen = scanData.skills.some((s) => s.name === mech.name);
  } else if (mech.type === "subagent") {
    seen = (scanData.coverage.agents || []).some((a) => (typeof a === "string" ? a : a.name) === mech.name);
  }
  return {
    kind: "host-discovery", level: "mechanical", result: seen ? "pass" : "fail",
    // The state chain stops where the evidence stops. Discovery proves
    // `configured` and nothing above it — assay read a file and never watched
    // the mechanism run.
    state: "configured",
    detail: (seen ? "the host profile discovers " : "the host profile does not discover ") +
      mech.type + " " + mech.name + " — configured, not enabled, trusted or verified",
  };
}

function cmdValidate(root, opts) {
  if (opts.changes.length !== 1) fail("validate takes exactly one --change <id>.");
  // [Foreman: 096] validate re-scans, so the startup guarantee holds here too:
  // a named startup directory must be one this profile models. Checked before
  // the journal grows, and threaded into every scan this command runs.
  if (opts.startup) {
    requireStartupHonored(opts, opts.adapter.detectContext({ root, startup: opts.startup, projectOnly: true }));
  }
  const id = opts.changes[0];
  const found = findChange(root, id);
  if (found.problem) fail(found.problem);
  const journalRows = readJournal(root);
  const state = replayJournal(journalRows).get(id);
  const live = state ? changeWrites(state, "apply").filter((w) => w.written) : [];
  if (!live.length) {
    fail("Change " + id + " has not been applied (nothing in the journal to validate). " +
      "Apply it first: `assay.js apply --change " + id + "`.");
  }
  const ctx = { transaction: state.transaction, plan: found.plan.planId, change: id };
  // One marker per invocation, so a reader can tell THIS run's rows from an
  // earlier run's. The journal only grows, so its length is unique here.
  const run = "v" + journalRows.length;
  const rows = validationEvidence(root, opts, found.change);
  for (const row of rows) appendJournal(root, { event: "evidence", run, ...ctx, ...row });
  const failed = rows.filter((r) => r.result === "fail");
  if (failed.length) {
    fail("Validation failed for change " + id + ":\n  " +
      failed.map((r) => r.kind + ": " + r.detail).join("\n  ") +
      "\n  Nothing was rolled back. Undo it with `assay.js rollback --change " + id + "`.");
  }
  process.stdout.write(JSON.stringify({
    change: id, evidence: rows.map((r) => ({ kind: r.kind, level: r.level, result: r.result, detail: r.detail })),
    note: "Evidence is in " + STATE_DIR + "/" + JOURNAL_FILE + ". The source instruction is still active; " +
      "deactivating it is a separate decision, and your own edit.",
  }, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

function cmdRollback(root, opts) {
  const journal = readJournal(root);
  const state = replayJournal(journal);
  let ids = opts.changes;
  if (opts.transaction) {
    const inTx = [...state.values()].filter((c) => c.transaction === opts.transaction).map((c) => c.id);
    if (!inTx.length) fail("No transaction " + opts.transaction + " in " + STATE_DIR + "/" + JOURNAL_FILE + ".");
    ids = [...ids, ...inTx];
  }
  if (!ids.length) fail("rollback needs --change <id> (repeatable) or --transaction <id>.");
  ids = [...new Set(ids)];
  for (const id of ids) if (!state.has(id)) fail("No change " + id + " in " + STATE_DIR + "/" + JOURNAL_FILE + ".");

  // Reverse order of application, so a transaction unwinds the way it was laid
  // down. Across the boundary of the rollback set, the honest simple behavior is
  // a refusal: if a change NOT being rolled back wrote the same file later, its
  // write is the current content and undoing an older one would silently discard
  // it. Roll that one back first.
  const selected = ids.map((id) => state.get(id));
  const pending = selected.flatMap((c) => changeWrites(c).filter((w) => !w.restored).map((w) => ({ c, w })));
  for (const { c, w } of pending) {
    for (const other of state.values()) {
      if (ids.includes(other.id)) continue;
      const later = changeWrites(other).find((o) => o.path === w.path && !o.restored && o.order > w.order);
      if (later) {
        fail("Cannot roll back change " + c.id + ": change " + other.id + " wrote " + w.path +
          " afterwards and is still applied. Roll that one back first.");
      }
    }
  }

  // A file that changed after assay wrote it is somebody's later work, and a
  // restore would overwrite it silently. Only the LATEST live write per path is
  // compared: an earlier stage's hashAfter is legitimately superseded by a later
  // write inside the same rollback set.
  if (!opts.force) {
    const latestByPath = new Map();
    for (const { c, w } of pending) {
      const prev = latestByPath.get(w.path);
      if (!prev || w.order > prev.w.order) latestByPath.set(w.path, { c, w });
    }
    for (const { c, w } of latestByPath.values()) {
      if (!w.written || typeof w.hashAfter !== "string") continue;
      const current = readIfExists(path.join(root, w.path));
      const currentHash = current === null ? null : hashContent(current);
      if (currentHash !== w.hashAfter) {
        fail("Cannot roll back change " + c.id + ": " + w.path + " changed after assay wrote it.\n" +
          "  A restore would silently discard that later edit. Nothing was restored.\n" +
          "  Re-run with --force to discard the later edit and restore the journalled pre-image.");
      }
    }
  }

  const report = [];
  for (const c of selected.sort((a, b) => {
    const la = Math.max(...changeWrites(a).map((w) => w.order), 0);
    const lb = Math.max(...changeWrites(b).map((w) => w.order), 0);
    return lb - la;
  })) {
    const writes = changeWrites(c);
    if (!writes.length) {
      report.push({ change: c.id, outcome: c.rejected
        ? "nothing to roll back — the change was rejected as stale and never written"
        : "nothing to roll back — nothing was written for this change" });
      continue;
    }
    const live = writes.filter((w) => !w.restored);
    if (!live.length) {
      report.push({ change: c.id, outcome: "already restored — the journal shows every write put back" });
      continue;
    }
    const ctx = { transaction: c.transaction, plan: c.plan, change: c.id };
    const restored = [];
    for (const w of live.sort((a, b) => b.order - a.order)) {
      // An intent with no outcome is an interrupted apply: the write may or may
      // not have landed, and restoring the pre-image makes both cases the same.
      restoreWrite(root, ctx, w, w.written ? "rollback" : "interrupted-apply");
      restored.push(w.path);
    }
    report.push({
      change: c.id, outcome: live.some((w) => !w.written) ? "interrupted apply resolved" : "restored",
      files: restored,
    });
  }
  process.stdout.write(JSON.stringify({ rolledBack: report, journal: STATE_DIR + "/" + JOURNAL_FILE }, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// applied - [Foreman: 170]
// ---------------------------------------------------------------------------
//
// The report a run ends on. Every other view in this engine is about the corpus
// BEFORE the fix: the plain report is printed before anything is written, and
// remeasure compares scores. Neither says what actually landed, so an auto-fix
// run finished with the owner never seeing the work assay did on their behalf.
//
// It is read out of the journal and the transaction log, never out of what the
// model believes it did. That matters most in exactly the case the owner most
// needs it: an apply interrupted mid-write leaves a journal and a transaction
// row, and nothing else.
function appliedReport(root, txId) {
  const rows = readTransactions(root);
  if (!rows.length) {
    return { problem: "No run has been applied in this project yet - " + STATE_DIR + "/" +
      TRANSACTIONS_FILE + " is not there." };
  }
  const row = txId ? rows.find((r) => r.txId === txId) : rows[rows.length - 1];
  if (!row) {
    return { problem: "No run with id " + txId + ". Ids in this project: " +
      rows.map((r) => r.txId).join(", ") + "." };
  }
  // The journal is the truth about what was WRITTEN; the row is the truth about
  // what was meant to be. A change in the row with nothing in the journal was
  // planned by this run and never landed - which is the interrupted-apply case
  // and the one thing an after-report must not report as done.
  const replayed = replayJournal(readJournal(root));
  const changes = [];
  for (const id of [...new Set((row.changes || []).map((c) => c.id))]) {
    const kind = (row.changes.find((c) => c.id === id) || {}).kind || "?";
    const state = replayed.get(id);
    const writes = state ? changeWrites(state, "apply") : [];
    const found = findChange(root, id);
    const change = found.problem ? null : found.change;
    changes.push({
      id,
      kind,
      // What the change was for, in the author's own words, so the line is
      // readable without the plan open beside it.
      addresses: change && change.addresses ? change.addresses : null,
      rationale: change && change.rationale ? change.rationale : null,
      written: writes.filter((w) => w.written).map((w) => ({
        path: w.path, created: w.preImage === null,
      })).sort((a, b) => (a.path < b.path ? -1 : 1)),
      restored: writes.filter((w) => w.restored).map((w) => w.path).sort(),
    });
  }
  const plan = revertPlan(root, row.txId);
  return {
    // A journal that is GONE and a journal that is SILENT about a change are
    // different facts and get different sentences: `clean` removed the record,
    // versus the write never completed. Reporting either as the other would
    // make an interrupted apply look tidy.
    journalGone: !fs.existsSync(statePath(root, JOURNAL_FILE)),
    transaction: row.txId,
    startedAt: row.startedAt,
    model: row.model,
    assayVersion: row.assayVersion,
    revertedAt: row.revertedAt || null,
    changes,
    files: row.files || [],
    undo: {
      command: "/assay:revert " + row.txId,
      routes: plan.problem ? [] : plan.ready,
      problem: plan.problem || null,
    },
  };
}

function renderApplied(report) {
  const out = [];
  const wrote = report.changes.flatMap((c) => c.written);
  out.push("Run " + report.transaction + " - " + report.changes.length + " change(s), " +
    wrote.length + " file(s) written, started " + report.startedAt);
  if (report.revertedAt) out.push("Already reverted at " + report.revertedAt + ". Nothing below is still in place.");
  for (const c of report.changes) {
    out.push("");
    out.push("  " + c.id + "  " + c.kind + (c.addresses ? "  - addresses rule " + c.addresses : ""));
    if (c.rationale) out.push("    " + c.rationale);
    for (const w of c.written) out.push("    wrote   " + w.path + (w.created ? "  (created)" : ""));
    for (const path0 of c.restored) out.push("    put back " + path0 + "  (assay undid this one itself)");
    if (!c.written.length && !c.restored.length) {
      out.push(report.journalGone
        ? "    the journal is gone - `clean` removed it, so this run's files are recorded only as: " +
          report.files.join(", ")
        : "    nothing landed: this change is in the run's record but no write completed");
    }
  }
  out.push("");
  // The single command, and only the routes a revert can actually run today.
  if (report.undo.problem) {
    out.push("Undo: not available - " + report.undo.problem);
  } else {
    out.push("Undo the whole run: " + report.undo.command +
      (report.undo.routes.length ? "  (routes ready: " + report.undo.routes.join(", ") + ")" : ""));
  }
  return out.join("\n");
}

function cmdApplied(root, opts) {
  const report = appliedReport(root, opts.transaction);
  if (report.problem) fail(report.problem);
  if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(renderApplied(report) + "\n");
}

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

function cmdClean(root) {
  fs.rmSync(path.join(root, TMP_DIR), { recursive: true, force: true });
  const journal = statePath(root, JOURNAL_FILE);
  if (!fs.existsSync(journal)) return;
  const open = openChangeIds(readJournal(root));
  if (open.length) {
    fail("Removed " + TMP_DIR + "/, kept " + STATE_DIR + "/" + JOURNAL_FILE + ": " + open.length +
      " open change(s) — " + open.join(", ") + ".\n  An open change is applied and unresolved. Close each one " +
      "with `validate` or `rollback`; a journal holding the only copy of a pre-image is never deleted.");
  }
  fs.rmSync(journal, { force: true });
  const kept = planFiles(root).map((f) => path.relative(root, f).split(path.sep).join("/"));
  // [Foreman: 162] The directory goes only when it is empty. `.assay/` now also
  // holds the transaction log and the no-repo backups, and those are the record
  // that makes a run revertible after the journal is gone — `clean` removes the
  // journal it was asked to remove and nothing beside it.
  if (!fs.readdirSync(statePath(root)).length) fs.rmdirSync(statePath(root));
  // [Foreman: 097] What was destroyed, and what the undo is from here. The
  // journal holds the only pre-image of every file assay wrote; removing it is
  // the point of this command and it used to be reported as tidying up. And the
  // kept plans are named, not counted — a parked plan the user cannot find is a
  // plan they cannot act on.
  process.stdout.write("Removed " + TMP_DIR + "/ and the change journal — the undo history is gone, and `git diff` is the undo from here." +
    (kept.length ? "\nKept the parked plan(s): " + kept.join(", ") + "." : "") + "\n");
}

// ---------------------------------------------------------------------------
// ci — [Foreman: 084]
// ---------------------------------------------------------------------------

// SCOPE.md ratified two halves of one sentence: CI output is OPT-IN, and it may
// hard-fail only on stable mechanical findings. This command is the first half;
// everything below is the second, enforced structurally rather than by
// convention.
//
// The gate set is CLOSED. Each name maps to the finding states and types that
// may fail a build, and there is no flag, env var or config file that adds one:
// a heuristic or model-inferred finding is advisory, period, and "opt in to
// failing on it" is not an option assay offers. `--fail-on` selects WITHIN this
// table and nothing else.
//
// The split between `availability` and `stale-targets` is deliberate rather
// than cosmetic: both are hard gates, but "the host never loads this" and "the
// host loads it and its target is gone" are different build failures with
// different fixes, and a CI log that cannot tell them apart is worth less. Both
// are in the default set, so the default behavior is the union.
//
// `budget-truncation` is NOT here and belongs to no gate. The host's own
// documentation says where its cap lands and does not say whether the crossing
// file arrives whole — an unsettled question is not a stable mechanical
// finding, and a build must not fail on one.
// [Foreman: 097] `inaccessible-source` joins `availability`: a file the host
// loads and assay could not open is a hole in the audit, not a style note, and
// leaving it in the opt-in `malformed-config` gate meant a default CI run passed
// on a corpus it had not read. It stays listed under `malformed-config` too, so
// `--fail-on malformed-config` keeps its meaning; `ciGateOf` takes the first
// selected gate that matches, and the canonical order puts availability first.
const CI_GATES = {
  availability: { states: ["inactive", "shadowed"], types: ["budget-exceeded", "inaccessible-source"] },
  schema: { states: [], types: ["unknown-category", "skill-metadata"] },
  "stale-targets": { states: ["blocked"], types: ["stale-shared-target"] },
  conflicts: { states: ["conflicting"], types: ["conflict", "conditional-conflict"] },
  duplicates: { states: [], types: ["duplicate", "skill-name-collision", "mechanism-overlap"] },
  "malformed-config": { states: [], types: ["skill-metadata-unreadable", "inaccessible-source"] },
};
const CI_GATE_NAMES = Object.keys(CI_GATES);
// The conservative core, applied when --fail-on is omitted: what the host will
// not load, what does not validate, what points at nothing, and what
// contradicts itself. `duplicates` and `malformed-config` are real gates and
// stay opt-in — a duplicated duty and an unreadable sidecar are worth fixing
// and are not worth stopping a merge by default.
const CI_DEFAULT_GATES = ["availability", "schema", "stale-targets", "conflicts"];
// The second bound, and the one that holds even if the table above is wrong. A
// finding fails a build only when its own evidence level is mechanical or
// documented, so a gated TYPE whose evidence is heuristic — every `conflict`
// today, and every near `duplicate` — is reported and never gates. Mislabeling
// a future type into this table cannot make a heuristic finding fail a build.
const CI_GATE_EVIDENCE = new Set(["mechanical", "documented"]);
// 0 = clean, 2 = a gate failed, 1 = usage or analysis error. Two rather than
// one so a CI job can tell "assay found something" from "assay could not run".
const CI_EXIT_GATE_FAILED = 2;

function ciGateOf(finding, gates) {
  for (const name of gates) {
    const gate = CI_GATES[name];
    const hit = finding.state ? gate.states.includes(finding.state) : gate.types.includes(finding.type);
    if (hit) return name;
  }
  return null;
}

// What a run would exit on, as data. Pure over the audit, so a test can plant a
// finding and check the boundary without spawning anything.
function ciEvaluate(audit, gates) {
  const failed = [];
  const advisory = new Map();
  // [Foreman: 097] A build fails on this repository, never on the machine it is
  // checked out on. A user-scope file, a `CLAUDE.md` above the root and the
  // host's own auto-memory notes all load for a session here and none of them is
  // in the checkout — so their findings are counted as advisory instead of
  // stopping a merge nobody can fix from inside the repo.
  const elsewhere = new Set((audit.files || []).filter(notReadersOwn).map((f) => f.path));
  const outOfRepo = (finding) => {
    const at = (finding.sources || [])[0];
    return Boolean(at && elsewhere.has(at.path));
  };
  for (const finding of audit.findings || []) {
    const gate = outOfRepo(finding) ? null : ciGateOf(finding, gates);
    if (gate && CI_GATE_EVIDENCE.has((finding.evidence || {}).level)) {
      const at = finding.sources && finding.sources[0];
      failed.push({
        gate,
        ...(finding.state ? { state: finding.state } : { type: finding.type }),
        severity: finding.severity,
        evidence: finding.evidence.level,
        path: at ? at.path : null,
        line: at ? at.lineStart : null,
        summary: redactSecrets(finding.summary),
        // [Foreman: 097] The finding's own next step. A CI log that names three
        // paths and no repair leaves the reader to open the tool again to find
        // out what to do about them.
        fix: redactSecrets((finding.safeActions || [])[0] || ""),
      });
      continue;
    }
    // [Foreman: 084] The language modes land here by construction: no gate
    // names `unsupported-language`, and the mode travels with the count so a CI
    // log says which text the rubric could not read.
    const key = finding.type === "unsupported-language"
      ? finding.type + ":" + finding.mode
      : finding.state || finding.type;
    advisory.set(key, (advisory.get(key) || 0) + 1);
  }
  failed.sort((a, b) => gates.indexOf(a.gate) - gates.indexOf(b.gate) ||
    String(a.path).localeCompare(String(b.path)) || (a.line || 0) - (b.line || 0) ||
    a.summary.localeCompare(b.summary));
  return { failed, advisory: Object.fromEntries([...advisory].sort((a, b) => a[0].localeCompare(b[0]))) };
}

function ciCounts(entries, key) {
  const counts = new Map();
  for (const e of entries) counts.set(e[key], (counts.get(e[key]) || 0) + 1);
  return [...counts].map(([k, n]) => k + " " + n).join(", ");
}

// Nothing here carries a clock, a temp path or a project root: two runs over an
// unchanged tree print byte-identical output, which is what makes the exit code
// worth reading in a log.
function ciSummary(audit, gates, result) {
  const profile = audit.profile || {};
  // [Foreman: 097] The denominator. Without it a run that scanned nothing — a
  // wrong root, a checkout that had not finished — printed the same clean summary
  // as a project with nothing wrong.
  const scanned = (audit.rules || []).filter((r) => !r.suppressed).length;
  const withRules = (audit.files || []).filter((f) => f.ruleCount > 0).length;
  const lines = [
    `assay ci — ${profile.host || PROFILE_HOST} profile ${profile.version || PROFILE_VERSION}, analyzer ${ANALYZER_VERSION}`,
    `gates: ${gates.join(", ")}`,
    `looked at: ${scanned} rule(s) in ${withRules} file(s), ${(audit.skills || []).length} skill(s)`,
  ];
  if (result.failed.length) {
    lines.push(`gated findings: ${result.failed.length} (${ciCounts(result.failed, "gate")})`);
    for (const f of result.failed) {
      lines.push(`  ${f.gate}  ${f.path}:${f.line}  ${f.summary}  [${f.evidence}]`);
      if (f.fix) lines.push(`    fix: ${f.fix}`);
    }
  } else {
    lines.push("gated findings: none");
  }
  // [Foreman: 097] Files that load for a session here and are not in the
  // checkout. Nothing in them can fail this build, and saying so is what stops
  // "gated findings: none" from reading as "assay looked nowhere else".
  const elsewhere = (audit.files || []).filter((f) => f.scope === "user" || f.scope === "ancestor" || f.autoMemory).length;
  if (elsewhere) {
    lines.push(`outside this repository: ${elsewhere} file(s) load here and are not in the checkout — reported, never gated (\`--project-only\` skips them entirely)`);
  }
  const advisoryTotal = Object.values(result.advisory).reduce((n, c) => n + c, 0);
  lines.push(`advisory (never gates): ${advisoryTotal}` +
    (advisoryTotal ? ` (${Object.entries(result.advisory).map(([k, n]) => k + " " + n).join(", ")})` : ""));
  return lines.join("\n");
}

function parseFailOn(raw) {
  const named = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = named.filter((n) => !CI_GATE_NAMES.includes(n));
  if (!named.length || unknown.length) {
    usageError((unknown.length ? "--fail-on names no gate assay may fail on: " + unknown.join(", ") : "--fail-on names no gate") +
      ".\nThe gate set is closed: " + CI_GATE_NAMES.join(", ") + "." +
      "\nHeuristic and model-inferred findings are advisory by design — SCOPE.md rules out hard CI failures from them, and no flag opts back in.");
  }
  // Canonical order, so the same selection always prints and sorts the same way.
  return CI_GATE_NAMES.filter((n) => named.includes(n));
}

// Read-only in the strongest sense available: the scan reads the working tree,
// the audit is composed in memory, and NOTHING is written — no `.assay-tmp`
// record, no `.assay` state, not even a temp file. A CI job that runs this
// leaves the checkout exactly as it found it, so the command is safe on a
// shared workspace and produces no artifact anyone has to clean up. The host is
// not probed either: a version subprocess is a dependency a build should not
// need, and no gate reads the answer.
function cmdCi(root, opts) {
  warnOpenChanges(root);
  const gates = opts.failOn ? parseFailOn(opts.failOn) : CI_DEFAULT_GATES;
  const scanData = scan(root, {
    projectOnly: opts.projectOnly, probeHost: false, adapter: opts.adapter, startup: opts.startup,
    rootFoundFrom: opts.rootFoundFrom,
  });
  requireStartupHonored(opts, scanData.context);
  const audit = composeAudit(scanData, null);
  const result = ciEvaluate(audit, gates);
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      analyzer: { name: "assay", version: ANALYZER_VERSION },
      profile: audit.profile || { host: PROFILE_HOST, version: PROFILE_VERSION },
      gates,
      allowedGates: CI_GATE_NAMES,
      failed: result.failed,
      advisory: result.advisory,
      exitCode: result.failed.length ? CI_EXIT_GATE_FAILED : 0,
    }, null, 2) + "\n");
  } else {
    process.stdout.write(ciSummary(audit, gates, result) + "\n");
  }
  if (result.failed.length) process.exit(CI_EXIT_GATE_FAILED);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

// [Foreman: 070] One exit-code contract: 0 on success, 1 on any expected
// failure — a missing input, a malformed judgments file, a usage error.
// [Foreman: 081] The transaction commands join it unchanged: a stale plan, an
// unknown change id and a failed validation all exit 1.
// [Foreman: 084] `ci` adds the ONE second failure code in this engine: 2 means
// a selected gate failed, and it is distinct from 1 precisely so a build can
// tell a finding from a broken invocation. A `--fail-on` naming a gate outside
// the closed set is still 1 — that is a usage error, not a finding.
const COMMANDS = ["scan", "report", "remeasure", "clean",
  // [Foreman: 170] `applied` is the after-report: what a run actually wrote,
  // read back out of the journal and the transaction log.
  "applied",
  "plan", "apply", "validate", "rollback", "ci"];
// [Foreman: 096, 097] The commands that run discovery, and therefore the only
// ones a host profile or a startup directory means anything to. Both flags are
// refused elsewhere rather than accepted and ignored.
const SCANNING_COMMANDS = ["scan", "remeasure", "ci", "validate"];
const FLAGS = new Set(["--verbose", "--json", "--project-only", "--force", "--plain"]);
// [Foreman: 079] Flags that take a value, mapped to what that value is, so the
// parser skips the argument instead of rejecting it as an unknown flag and the
// error says what was missing.
const VALUE_FLAGS = new Map([
  ["--root", "path"], ["--host", "profile name"],
  // [Foreman: 175] Which model column the scoring runs under. The four audit
  // commands each name one; the flag is how that name reaches the engine.
  ["--model", "model profile id (" + Object.keys(PROFILES).join(", ") + ")"],
  // The startup directory a session is modeled as beginning in. Only a profile
  // whose host reads a root-to-startup chain consumes it; the engine refuses it
  // for any profile that ignores it, and for any command that would not read
  // it, so the flag can never silently do nothing.
  ["--startup", "startup directory (inside the root)"],
  // [Foreman: 081] The transaction's arguments. `--change` repeats, and that
  // repetition IS the approval boundary — every id written out by hand.
  ["--from", "draft plan path"], ["--change", "change id"], ["--batch", "batch id"],
  ["--transaction", "transaction id"], ["--external", '"<kind>: <result>"'],
  // [Foreman: 084] which gates may fail a ci run, from the closed set
  ["--fail-on", "comma-separated gate list (" + CI_GATE_NAMES.join(", ") + ")"],
  // [Foreman: 097] The middle zoom level. The two views were 8 rows or a full
  // per-rule table of decimals, with nothing between them.
  ["--top", "how many rows the short report shows (default " + BRIEF_FIX_ROWS + ")"],
]);
// [Foreman: 097] Two blocks, not one list. The old block put `plan`, `apply`,
// `validate` and `rollback` beside `report` with nothing saying which of them a
// person is meant to type — and the four that carry a write are exactly the ones
// nobody should be running by hand.
const HOSTS = Object.keys(ADAPTERS).join("|");
// [Foreman: 175] The model column the scoring runs under, offered wherever a
// host is: both name which profile the numbers come from.
const MODELS = Object.keys(PROFILES).join("|");
const USAGE = [
  "assay — reads the instruction files an agent loads for a project and reports what is",
  "vague, stale, buried, or better done by a script.",
  "",
  "In Claude Code the front door is the audit command for your model —",
  "`/assay:opus5`, `/assay:sonnet5`, `/assay:haiku45` or `/assay:fable5` — each runs all of this for you.",
  "",
  "Usage: assay.js <command> [--root <path>]",
  "",
  "Commands to run yourself:",
  "  scan            [--host <" + HOSTS + ">] [--model <" + MODELS + ">] [--startup <dir>] [--project-only]",
  "                  read the project and write " + TMP_DIR + "/scan.json",
  "  report          [--plain] [--verbose] [--json] [--top <n>]",
  "                  print the report from that scan, under the model that scan named",
  "  remeasure       [--host <" + HOSTS + ">] [--model <" + MODELS + ">] [--startup <dir>] [--project-only] [--verbose] [--json]",
  "                  re-scan after fixes and print the before/after",
  "  ci              [--host <" + HOSTS + ">] [--model <" + MODELS + ">] [--startup <dir>] [--project-only] [--fail-on <gate>[,<gate>…]] [--json]",
  "                  deterministic, writes nothing; exit 0 clean, 2 a gate failed, 1 usage error",
  "                  gates (closed set): " + CI_GATE_NAMES.join(", "),
  "                  default: " + CI_DEFAULT_GATES.join(", "),
  "  applied         [--transaction <id>] [--json]",
  "                  what the last run actually wrote, and the one command that undoes it",
  "  clean           remove " + TMP_DIR + "/ and the change journal once nothing is open",
  "  --help          print this and exit 0",
  "",
  "Driven by the skill, not by hand — each one carries the approval for a write:",
  "  plan            --from <draft.json>",
  "  apply           --change <id> [--change <id> …] | --batch <id>",
  // [Foreman: 150] `validate` re-scans, so it takes a host and a startup
  // directory like every other command that does. Both Codex surfaces have
  // instructed passing `--host codex` since 1.9.0 and the parser has always
  // accepted it; only this line did not say so.
  "  validate        --change <id> [--host <" + HOSTS + ">] [--model <" + MODELS + ">] [--startup <dir>] [--external \"<kind>: <result>\"]",
  "  rollback        --change <id> [--change <id> …] | --transaction <id>  [--force]",
].join("\n");

// A named startup directory the profile then ignored would be a report about
// the wrong session wearing the right label — the refusal keeps the flag honest
// without the engine ever asking which host it is running.
// [Foreman: 097]
// Where the project is, when nobody said. `process.cwd()` was the whole answer,
// so running the audit from `src/` reclassified the project's own CLAUDE.md as
// somebody else's file and the report came back clean — a green light that meant
// "looked in the wrong place". The walk stops at the nearest directory carrying
// a marker the host itself keys on, and falls back to the working directory when
// there is none, so a project with no instructions at all is still audited where
// the user stood.
//
// razor: three markers, no config. `.git` is the repository, `CLAUDE.md` and
// `.claude/` are the two instruction surfaces every profile discovers from a
// root. A profile-specific marker list is the upgrade path, not a need today.
const ROOT_MARKERS = ["CLAUDE.md", ".claude", "AGENTS.md", ".git"];

function findProjectRoot(from) {
  let dir = path.resolve(from);
  while (true) {
    for (const marker of ROOT_MARKERS) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(from);
    dir = parent;
  }
}

function requireStartupHonored(opts, context) {
  if (!opts.startup) return;
  if (path.resolve(context.startupDirectory) !== path.resolve(opts.startup)) {
    usageError("--startup is not supported by the " + (opts.adapter ? opts.adapter.name : "selected") +
      " profile: it models the startup directory as the project root.");
  }
}

// Every occurrence of a repeatable value flag, in the order they were given.
function valuesOf(args, flag) {
  const out = [];
  for (let i = 1; i < args.length; i++) if (args[i] === flag && args[i + 1]) out.push(args[i + 1]);
  return out;
}

function usageError(message) {
  process.stderr.write(message + "\n" + USAGE + "\n");
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  // [Foreman: 097] Asking for help is not an error. It used to exit 1 with
  // "Unknown command: --help" above the usage block it was asking for.
  if (args.some((a) => a === "--help" || a === "-h" || a === "help")) {
    process.stdout.write(USAGE + "\n");
    return;
  }
  if (!COMMANDS.includes(command)) {
    usageError(command ? "Unknown command: " + command : "No command given.");
  }
  // An unrecognized flag used to be ignored, so a typo silently produced the
  // default output instead of what was asked for.
  for (let i = 1; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) {
      if (!args[i + 1]) usageError(args[i] + " needs a " + VALUE_FLAGS.get(args[i]) + ".");
      i++;
      continue;
    }
    if (!FLAGS.has(args[i])) usageError("Unknown flag: " + args[i]);
  }
  // [Foreman: 097] A `--root` that does not exist used to be CREATED by the first
  // `mkdirSync` and audited as an empty project — a clean report about a
  // directory that was not there. Every other flag in this parser refuses in
  // plain English, and so does this one.
  const rootIdx = args.indexOf("--root");
  let rootFoundFrom = null;
  let root;
  if (rootIdx !== -1) {
    root = args[rootIdx + 1];
    const resolved = path.resolve(root);
    let stat = null;
    try { stat = fs.statSync(resolved); } catch { stat = null; }
    if (!stat) usageError("--root: " + root + " does not exist.");
    if (!stat.isDirectory()) usageError("--root: " + root + " is a file, not a directory.");
  } else {
    root = findProjectRoot(process.cwd());
    if (path.resolve(root) !== path.resolve(process.cwd())) rootFoundFrom = process.cwd();
  }
  // [Foreman: 079] Which host profile discovery runs under. Default is the
  // profile assay shipped with, so an existing invocation is unchanged. An
  // unknown name is a usage error naming the profiles that exist — silently
  // auditing the wrong host would be worse than refusing.
  const hostIdx = args.indexOf("--host");
  const host = hostIdx !== -1 ? args[hostIdx + 1] : DEFAULT_HOST;
  if (!ADAPTERS[host]) {
    usageError("Unknown host: " + host + " — valid hosts are " + Object.keys(ADAPTERS).join(", ") + ".");
  }
  // [Foreman: 175] Which model column the scoring runs under. Same shape as
  // `--host` above, and for the same reason: a name assay does not know is a
  // refusal naming the ones it does, never a silent fall back to the default.
  const modelIdx = args.indexOf("--model");
  if (modelIdx !== -1) {
    const id = args[modelIdx + 1];
    if (!PROFILES[id]) {
      usageError("Unknown model: " + id + " - valid models are " + Object.keys(PROFILES).join(", ") + ".");
    }
    // A record already names its column, so only a command that computes one
    // takes the flag; every other reads it back off the record it renders.
    if (!SCANNING_COMMANDS.includes(command)) {
      usageError("--model belongs to the commands that scan (" + SCANNING_COMMANDS.join(", ") + "); " +
        command + " reads the model profile off the saved records.");
    }
    useModelProfile(id, true);
  }
  // [Foreman: 097] The same honesty rule `--startup` has had: a flag a command
  // would silently ignore is refused instead of accepted. Only discovery reads a
  // host profile; every other command works from a record that already names one.
  if (hostIdx !== -1 && !SCANNING_COMMANDS.includes(command)) {
    usageError("--host belongs to the commands that scan (" + SCANNING_COMMANDS.join(", ") + "); " +
      command + " reads the host profile off the saved records.");
  }
  // The startup directory, when given, must be the root or inside it — a chain
  // to a directory outside the project is not a chain assay can describe.
  const startupIdx = args.indexOf("--startup");
  // Relative to the root, not the shell's cwd: the flag names a place in the
  // project being audited, wherever assay is invoked from.
  const startup = startupIdx !== -1 ? path.resolve(root, args[startupIdx + 1]) : null;
  if (startup) {
    const fromRoot = path.relative(path.resolve(root), startup);
    if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
      usageError("--startup must name the root or a directory inside it.");
    }
    if (!fs.existsSync(startup) || !fs.statSync(startup).isDirectory()) {
      usageError("--startup: " + args[startupIdx + 1] + " is not a directory.");
    }
  }
  // [Foreman: 096] The other half of the startup guarantee: only the commands
  // that run a scan can read the flag, so any other command refuses it instead
  // of accepting a label it would never honor.
  // [Foreman: 097] `--top` only means anything to the short report.
  let top = null;
  if (args.includes("--top")) {
    const raw = args[args.indexOf("--top") + 1];
    top = Number(raw);
    if (!Number.isInteger(top) || top < 1) usageError("--top takes a whole number of rows, at least 1.");
    if (command !== "report") usageError("--top belongs to `report`, which is the command that prints the short report.");
  }
  // [Foreman: 164] Same rule as `--top`: the plain renderer belongs to the one
  // command that prints a report a person reads before approving an edit.
  if (args.includes("--plain") && command !== "report") {
    usageError("--plain belongs to `report`, which is the command that prints the report the fix flow reads.");
  }
  if (startup && !SCANNING_COMMANDS.includes(command)) {
    usageError("--startup belongs to the commands that scan (" + SCANNING_COMMANDS.join(", ") + "); " +
      command + " works from the saved records, which already carry it.");
  }
  // [Foreman: 150] `--project-only` decides what discovery reaches, so only a
  // command that discovers can honour it. The audit skills forwarded it to every
  // later call, and `report`, `plan`, `apply`, `rollback` and `clean` accepted it
  // and did nothing — the same silent no-op `--host` and `--startup` already
  // refuse rather than accept.
  if (args.includes("--project-only") && !SCANNING_COMMANDS.includes(command)) {
    usageError("--project-only belongs to the commands that scan (" + SCANNING_COMMANDS.join(", ") + "); " +
      command + " works from the saved records, which were already scanned with it or without it.");
  }
  const opts = {
    verbose: args.includes("--verbose"),
    // [Foreman: 164] The third renderer, read by the auto-fix flow.
    plain: args.includes("--plain"),
    json: args.includes("--json"),
    // [Foreman: 074] Keep the audit inside the repo: no user-scope discovery.
    projectOnly: args.includes("--project-only"),
    // [Foreman: 140] Opt-in proposals: near-miss conflicts the deterministic
    // gates drop. The skills have advertised this flag since 1.7.0; until now
    // only the model half of the semantic pass answered to it.
    semantic: args.includes("--semantic"),
    adapter: ADAPTERS[host],
    startup,
    // [Foreman: 097] Where the walk started, when it moved. Null when the root
    // was named or the working directory already was one.
    rootFoundFrom,
    force: args.includes("--force"),
    // [Foreman: 081] the transaction's arguments
    from: args.includes("--from") ? args[args.indexOf("--from") + 1] : null,
    changes: valuesOf(args, "--change"),
    batch: args.includes("--batch") ? args[args.indexOf("--batch") + 1] : null,
    transaction: args.includes("--transaction") ? args[args.indexOf("--transaction") + 1] : null,
    external: valuesOf(args, "--external"),
    // [Foreman: 084] null means the conservative default set, not "no gates".
    failOn: args.includes("--fail-on") ? args[args.indexOf("--fail-on") + 1] : null,
    top,
  };

  if (command === "scan") cmdScan(root, opts);
  else if (command === "report") cmdReport(root, opts);
  else if (command === "remeasure") cmdRemeasure(root, opts);
  else if (command === "plan") cmdPlan(root, opts); // [Foreman: 081]
  else if (command === "apply") cmdApply(root, opts);
  else if (command === "validate") cmdValidate(root, opts);
  else if (command === "rollback") cmdRollback(root, opts);
  else if (command === "ci") cmdCi(root, opts); // [Foreman: 084]
  else if (command === "applied") cmdApplied(root, opts); // [Foreman: 170]
  else cmdClean(root);
}

module.exports = {
  parseFrontmatter, parseFrontmatterBlock, lineOffsets, sourceRange,
  // [Foreman: 175] which commands compute a record, and therefore the only
  // ones --host, --startup, --project-only and --model mean anything to
  SCANNING_COMMANDS,
  // [Foreman: 167] the fixture-pair admission a promoted hook has to pass
  admitDraftHooks, admitHookPromotion, wiredHooks, hookRefused,
  // [Foreman: 170] the after-report: what a run wrote, out of its own records
  appliedReport, renderApplied,
  // [Foreman: 074] discovery lives in the adapter; re-exported so callers and
  // tests keep one import
  adapter: claudeAdapter, findRuleMarkdownFiles: claudeAdapter.findRuleMarkdownFiles,
  readSources, readSkills,
  findInstructionFiles, stripMetadata, identifyChunks, classifyChunk,
  mergeClarifications, splitCompound, checkStaleness, scoreF1, scoreF2, scoreF4, scoreF5, scoreF7,
  composeScore, grade, detectPlacement, scan, composeAudit, renderReport, loadJudgments,
  // [Foreman: 095] the default report, the three limits its gates assert, and
  // the one escape both renderers share
  renderBrief, BRIEF_MAX_LINES, BRIEF_BANNED_WORDS, REPORT_BANNED_WORDS, escapeTableCell,
  // [Foreman: 164] the third renderer and the line budget G7 asserts
  renderPlain, PLAIN_MAX_LINES,
  // [Foreman: 075] the finding contract
  deriveFindings, evidenceTag, FINDING_STATES,
  // [Foreman: 076] the corpus relationship contract
  deriveRelationships, conflictPairs, duplicatePairs, CONTEXT_PRESSURE_BYTES,
  // [Foreman: 085] the ceiling on pairwise relationship analysis, and the
  // disclosure that stands in for it
  PAIRWISE_RULE_CAP,
  // [Foreman: 077] the mechanism contract: the ladder and its limits vocabulary
  deriveMechanisms, MECHANISM_LEVELS, MECHANISM_LIMITS,
  looksLikeStatement, hasImperativeVerb, checkSkillDescription, gradeSkill, findSkillFiles,
  // [Foreman: 078] the output contract: one record, one masker, one coverage
  // story every view of it has to tell the same way
  redactSecrets, coverageLines,
  // [Foreman: 072] the record contract
  RECORD_SCHEMA, SCHEMA_VERSION, ANALYZER_VERSION, validateRecord, makeRecord, hashContent,
  // [Foreman: 081] the safe-change transaction: the plan schema, the journal's
  // replay, and where transaction state lives
  CHANGE_KINDS, VALIDATION_STEPS, validatePlanChanges, planFromDraft,
  readJournal, replayJournal, openChangeIds, postWriteProblems, STATE_DIR, JOURNAL_FILE,
  // [Foreman: 079] the host-profile contract: the registry `--host` selects
  // from, and the policy every analyzer consults instead of a host name
  ADAPTERS, DEFAULT_POLICY, profilePolicy, DEFAULT_NOUNS, profileNouns, readSkillMetadata,
  // [Foreman: 082] the authoring seam: where each profile's host lets a new
  // rule, skill or hook be written
  profileTargets,
  // [Foreman: 071] the semantic contract: rubric axis + the candidate kinds a
  // later entry's semantic pass may propose
  RUBRIC_VERSION, SEMANTIC_CANDIDATE_KINDS,
  // [Foreman: 084] the language contract: which rubric a text is read under,
  // and the screen that decides
  detectLanguageMode, languageTokens, englishScored, languageModeLabel, FUNCTION_WORDS,
  // [Foreman: 084] the CI contract: the closed gate set, its default, the
  // evidence bound that holds regardless of it, and the pure evaluation
  CI_GATES, CI_GATE_NAMES, CI_DEFAULT_GATES, CI_GATE_EVIDENCE, CI_EXIT_GATE_FAILED, ciEvaluate,
};

if (require.main === module) {
  // [Foreman: 085] A partial artifact is an expected condition, not a crash: it
  // exits 1 with the file named. Anything unmarked is a defect and keeps its
  // stack, because hiding one behind a tidy message is how bugs get shipped.
  try {
    main();
  } catch (err) {
    if (!err || !err.expected) throw err;
    fail(err.message);
  }
}
