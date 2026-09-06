"use strict";

// jig's own prose, checked against jig's own engine.
//
// Every claim below was true of a release jig has not shipped yet: CI running
// the toolchain, a selftest spawning a linter, a driver that only fails a
// selftest on an empty checks directory. Prose drifts silently — nothing fails
// when a sentence stops being true — so each passage is pinned here to the
// artifact that decides it. When a later release makes one of these claims
// true, the assertion below is what says the sentence may change.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PLUGIN_ROOT = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(PLUGIN_ROOT, ...parts), "utf-8");

const roots = [];
test.after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

test("the interview's CI answer promises only what the CI workflow actually runs", () => {
  const workflow = read("scripts", "templates", "jig.yml");
  const steps = workflow.split("\n")
    .filter((l) => /^\s*run:/.test(l))
    .map((l) => l.replace(/^\s*run:\s*/, "").trim());
  assert.ok(steps.length, "the CI workflow template runs nothing at all");
  for (const step of steps) {
    assert.match(step, /^node \.jig\/checks\/run\.mjs/,
      "the CI lane now runs " + step + ", so the interview's CI answer may say so");
  }

  const interview = read("skills", "jig", "references", "interview.md");
  const answer = interview.slice(interview.indexOf("**Question seven**, header `\"CI floor\"`"));
  assert.ok(answer.startsWith("**Question seven**"), "question seven is gone from the interview reference");
  const yes = answer.slice(0, answer.indexOf("- `No`"));
  assert.doesNotMatch(yes, /running the committed check driver and the tools you ticked/,
    "the CI answer promises the ticked tools, and no lane runs them");
  assert.match(yes, /selftest/, "the CI answer does not name the selftest the workflow runs");
});

test("the witnessed close names the flag that spawns a tool, and says none is spawned without it", () => {
  // Roadmap 207 made the toolchain probe real: it spawns the tool the run names
  // and nothing else. The engine's own assertions are in checks.test.js and
  // toolchain.test.js; these are the sentences that have to agree with them.
  const skill = read("skills", "jig", "SKILL.md");
  const close = skill.slice(skill.indexOf("## 8. Witnessed close"), skill.indexOf("## 9. Close"));
  assert.ok(close.includes("Witnessed close"), "section 8 is gone from SKILL.md");
  assert.doesNotMatch(close, /Most tools/,
    "the close claims only *most* tools go unspawned; the engine spawns the named ones and no others");
  // The old regex matched the old sentence too ("jig spawns none of them"),
  // which is the opposite claim, so it pinned nothing about this release.
  assert.match(close, /does not spawn a tool the run did not\s+name/,
    "the close does not say that a tool the run did not name goes unspawned");
  assert.match(close, /--toolchain/, "the close does not name the flag that spawns a tool");
  assert.match(close, /cannotRun/,
    "the close does not name the field a tool jig cannot start comes back with");
  assert.match(close, /ran: false/, "the close does not name the field the model has to read");
});

// A driver installed beside the given check modules, ready to run.
function driverRoot(driver, modules) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jig-docs-"));
  roots.push(root);
  const checks = path.join(root, ".jig", "checks");
  fs.mkdirSync(checks, { recursive: true });
  fs.writeFileSync(path.join(checks, "run.mjs"), driver);
  for (const [name, body] of Object.entries(modules)) fs.writeFileSync(path.join(checks, name), body);
  return spawnSync(process.execPath, [path.join(checks, "run.mjs"), "--selftest"],
    { cwd: root, encoding: "utf-8", windowsHide: true });
}

test("the driver's header comment states the selftest exit code the driver returns", () => {
  const driver = read("scripts", "templates", "run.mjs");
  const header = driver.slice(0, driver.indexOf("// A check declares one of two detector kinds"));
  assert.doesNotMatch(header, /no check ran at all/,
    "the header blames an empty checks directory alone; an unproven check exits 1 too");
  assert.match(header, /claims this driver and carries no pair it can run/,
    "the header does not state the condition the selftest actually exits 1 on");
  assert.match(header, /the exit code stays 0/,
    "the header does not say what an empty checks directory means to the exit code");

  // One check, loaded and run, claiming this driver and carrying no pair it can
  // run. Nothing threw and the directory is not empty, and the selftest still
  // exits 1 because that check was never admitted.
  const unproven = driverRoot(driver, {
    "unproven.check.mjs": [
      "export const id = \"unproven\";",
      "export const title = \"a check nobody admitted\";",
      "export const severity = \"safety\";",
      "export const detectors = [{ id: \"unproven-0\", lever: \"check-driver\", runner: \"checks\",",
      "  kind: \"pattern\", paths: [\"src/**/*.js\"], pattern: \"eval\\\\(\", message: \"no eval\" }];",
      "",
    ].join("\n"),
  });
  assert.equal(unproven.status, 1, "a check claiming this driver proved nothing and exited 0: " + unproven.stdout);

  // And an empty checks directory, which is the case the sentence names: the
  // report says nothing is proven, and the exit code says nothing failed —
  // this step ships in the workflow, and a `--select` or toolchain-only
  // install lands exactly this directory.
  assert.equal(driverRoot(driver, {}).status, 0);
  assert.match(driverRoot(driver, {}).stdout, /nothing here is proven/);
});

test("a healthy install whose checks are all session guards does not fail its own selftest", () => {
  // The shipped CI workflow runs `--selftest` as a required step, so exiting 1
  // here is a lane that is red on every push for ever. A session-only check is
  // proven by `jig selftest --live` through the guard, not by this driver.
  const driver = read("scripts", "templates", "run.mjs");
  const run = driverRoot(driver, {
    "session-only.check.mjs": [
      "export const id = \"session-only\";",
      "export const detectors = [{ runner: \"PostToolUse\", lever: \"edit-observe-guard\",",
      "  params: { paths: [\"src/**/*.js\"], patterns: [\"evilcall\"] } }];",
      "export const fixtures = { violation: \"evilcall(x)\\n\", nearMiss: \"goodcall(x)\\n\" };",
      "",
    ].join("\n"),
  });
  assert.equal(run.status, 0, "a repository whose checks are all session guards failed its selftest: " + run.stdout);
  assert.match(run.stdout, /proven in the session lane/);

  const workflow = read("scripts", "templates", "jig.yml");
  assert.match(workflow, /run\.mjs --selftest/, "the workflow no longer runs the selftest this test is about");
});

test("both surfaces document every field of the one lanes payload they share", () => {
  // `cmdInventory` returns `cmdReview`'s own lanes object. A field documented on
  // one skill and not the other is a surface answering "is anything actually
  // running" without reading the thing that would tell it.
  const review = read("skills", "review", "SKILL.md");
  const inventory = read("skills", "inventory", "SKILL.md");
  for (const field of ["off", "offSince", "executable", "installed"]) {
    const named = new RegExp("`" + field + "[`:]");
    assert.match(review, named, "review/SKILL.md never names `" + field + "`");
    assert.match(inventory, named, "inventory/SKILL.md never names `" + field + "`");
  }
});

// 2.14.0's surfaces said three things about the shell tools that the code
// underneath cannot support. `shell.seen` is a union over the whole ledger, so
// no surface may read it as one guard's or as this host's; and no surface may
// name an idiom that fails to match, because nothing measured one —
// HOST-PROBE-2026-09-02 records the host's shell as PowerShell 7, which
// implements `&&` and `||` as pipeline chain operators.
test("no surface reads shell.seen as per-guard or per-host, and none names an unmeasured idiom", () => {
  const review = read("skills", "review", "SKILL.md");
  const inventory = read("skills", "inventory", "SKILL.md");
  const authoring = read("skills", "jig", "SKILL.md");

  // The per-guard field exists, so both surfaces that report a guard's counts
  // point at it rather than at the repository-wide one.
  assert.match(review, /`evaluatedOn`/, "review/SKILL.md never names the per-guard shell field");
  assert.match(inventory, /`evaluatedOn`/, "inventory/SKILL.md never names the per-guard shell field");
  assert.match(authoring, /`evaluatedOn`/, "the authoring skill still sends an author to a repository-wide field");

  for (const [name, text] of [["review", review], ["inventory", inventory]]) {
    assert.doesNotMatch(text, /`seen` is the ones a guard has actually/,
      name + "/SKILL.md reads the repository-wide `seen` as one guard's");
    assert.doesNotMatch(text, /recorded on this host/,
      name + "/SKILL.md reads a ledger with no host scoping as this host's");
  }

  // The examples 2.14.0 shipped, in every surface that carried them. `&&` is the
  // one that is demonstrably wrong; the other two were never measured either.
  for (const [name, text] of [["review", review], ["inventory", inventory], ["jig", authoring]]) {
    // Not `| sh` — the authoring skill's fixture table carries it as the
    // `pipe-to-shell` violation an admitted check actually fires on, which is a
    // measured fact about a fixture and not a claim about a shell.
    for (const idiom of ["2>/dev/null", "POSIX idiom", "POSIX shell idiom"]) {
      assert.ok(!text.includes(idiom), "skills/" + name + "/SKILL.md names an idiom nothing measured: " + idiom);
    }
  }
});

test("the README describes the quick start and the kill switch as the engine has them", () => {
  const readme = read("README.md");
  const quick = readme.split("\n").find((l) => l.includes("/jig:jig --quick`"));
  assert.ok(quick, "the --quick row is gone from the README");
  assert.match(quick, /assumed/,
    "the --quick row sells a selection without saying every value in it was assumed");

  const kill = readme.split("\n").find((l) => l.startsWith("- Kill switch:"));
  assert.ok(kill, "the kill-switch line is gone from the README");
  assert.match(kill, /session guards/, "the kill-switch line does not say which lane goes silent");
  // The shim reads no config and no off file — it runs the driver or logs a
  // skip. That is why the README may not say the commit lane goes quiet too.
  const shim = read("scripts", "templates", "hook-pre-commit.sh");
  assert.doesNotMatch(shim, /\.jig\/off/,
    "the commit shim now honours the kill switch, so the README line may say so");
});

test("the item tier is asked as an enumerated multi-select, and applied one pair at a time", () => {
  // SCOPE's derail-pass row on N19 allows the multi-select on two conditions:
  // nothing pre-ticked, and the token unchanged. Both are prose, so both are
  // pinned here — the engine cannot refuse a skill that walks the tier as
  // paragraphs or ticks an option nobody chose.
  const skill = read("skills", "jig", "SKILL.md");
  const consent = skill.slice(skill.indexOf("Then take consent in two tiers"), skill.indexOf("## 7. Apply"));
  assert.ok(consent.includes("consent.item"), "the consent section is gone from SKILL.md");
  assert.match(consent, /multiSelect/, "the item tier is not asked as an AskUserQuestion multiSelect");
  assert.match(consent, /at most four options per question and at\s+most four questions per call/,
    "the item tier's page size is not stated");
  assert.match(consent, /\*\*Nothing is pre-ticked\.\*\*/,
    "the item tier does not say that nothing is pre-ticked");
  assert.match(consent, /label is the change id/, "the option label is not the change id");
  assert.match(consent, /--change <id> --path <rel>/,
    "the multi-select no longer says the token stays one pair per ticked id");
});

// Roadmap 234 made the batch half of a mixed plan reachable by `apply --plan`,
// and SCOPE, "May a batch approval skip a change already applied", requires the
// skipped ids to be named rather than dropped. Both are prose here: the engine
// has no way to refuse a skill that never runs the command, and a `skipped`
// list nobody reads out is the silence that row exists to forbid.
test("the apply section names the command that carries the batch tier, and relays what it skipped", () => {
  const skill = read("skills", "jig", "SKILL.md");
  const apply = skill.slice(skill.indexOf("## 7. Apply"), skill.indexOf("## 8. Witnessed close"));
  assert.ok(apply.includes("## 7. Apply"), "section 7 is gone from SKILL.md");
  assert.match(apply, /jig\.js" apply --plan <planId>/,
    "section 7 never runs `apply --plan`, so the batch tier it exists to reach has no caller");
  // The order is the whole of it: `--plan` refuses while an item-tier change is
  // unapplied, so a skill told to run it first only ever reads the refusal.
  assert.match(apply, /The item tier first/, "section 7 does not apply the item tier first");
  assert.match(apply, /refuses while any item-tier change in the plan is still unapplied/,
    "section 7 does not say why `--plan` comes second");
  assert.match(apply, /\*\*names every one it\s+skipped\*\*/,
    "section 7 does not tell the model to relay `skipped`");
  assert.match(apply, /`skipped`/, "section 7 never names the field the skipped list comes back on");

  // 2.14.0. Section 7 said a repaired item comes back "reported as `restored`".
  // `restored` needs a `sourceHash`, which only a file that EXISTED at plan time
  // has: every file jig itself created — so every check module in a greenfield
  // install — comes back `applied`, and a model told to expect one word reads the
  // other as a failure. Pinned to the engine's own branch below.
  assert.match(apply, /as `applied` when it was not/,
    "section 7 names only one repair outcome, and the engine has two");
  const outcome = read("scripts", "jig.js");
  assert.match(outcome, /const missing = current === null && change\.sourceHash !== null;/,
    "the branch section 7 describes has moved — re-read it before trusting the prose");
  assert.match(outcome, /outcome: missing \? "restored" : "applied"/);
});

// Question seven is where CI is agreed to, and the CI lane runs the project's
// own `test` script where no test runner was ticked (DERAIL-PASS N8). Prose that
// left that out was jig substituting a default for an answer the owner never
// gave — which SCOPE forbids whatever the plan later names.
test("the interview's CI answer names the project's own test script as a lane step", () => {
  const interview = read("skills", "jig", "references", "interview.md");
  const answer = interview.slice(interview.indexOf("**Question seven**, header `\"CI floor\"`"));
  const yes = answer.slice(0, answer.indexOf("- `No`"));
  assert.match(yes, /`test` script/,
    "the CI answer never mentions the test script the lane list adds when no test runner is ticked");
});

// DERAIL-PASS N12b: the four routes around the harness are interview text, not
// catalogue rows — SCOPE:205 keeps session levers authored, so nothing in the
// engine fails when an offer goes missing from round one. Pin all four, and pin
// the force-push row's refspec claim against the parser that decides it.
const guardLib = require("../hooks/jig-lib.js");
const STANDING_OFFERS = ["hook-bypassed", "force-push-to-default", "pipe-to-shell", "harness-switched-off"];

test("round one offers all four routes around the harness, leading on the agent persona", () => {
  const interview = read("skills", "jig", "references", "interview.md");
  const round = interview.slice(
    interview.indexOf("**Question three**, header `\"Guard against\"`"),
    interview.indexOf("**Question four**, header"));
  assert.ok(round.startsWith("**Question three**"), "question three is gone from the interview reference");
  for (const offer of STANDING_OFFERS) {
    assert.ok(round.includes("`" + offer + "`"), "question three never offers `" + offer + "`");
  }
  assert.match(round, /`Me and my AI sessions` persona they lead the list/,
    "the standing offers do not lead the list on the persona whose sessions take these routes");
  assert.match(round, /Ticking one of those installs nothing/,
    "question three does not say that ticking a standing offer installs nothing");
});

test("SKILL.md authors each standing offer against a lever the engine has", () => {
  const skill = read("skills", "jig", "SKILL.md");
  const section = skill.slice(
    skill.indexOf("### When the mistake is a route around the harness"),
    skill.indexOf("Write the drafted checks to `.jig/authored.json`"));
  assert.ok(section.startsWith("### When the mistake is a route around the harness"),
    "step 4 no longer describes the routes around the harness");
  for (const offer of STANDING_OFFERS) {
    assert.ok(section.includes("`" + offer + "`"), "step 4 says nothing about authoring `" + offer + "`");
  }
  for (const lever of new Set(section.match(/`(?:bash|edit)-guard`/g) || [])) {
    assert.ok(Object.keys(guardLib.LEVER_TOOLS).includes(lever.replace(/`/g, "")),
      "step 4 points a standing offer at " + lever + ", which is not a lever the engine runs");
  }

  // The refspec spellings the section promises are one branch are exactly the
  // ones `pushBranch` folds together, and the pair it prints is separable by
  // the scope the row declares. A pair that is not is admitted and catches
  // nothing.
  for (const spelling of ["+main", "HEAD:main", ":main", "refs/heads/main"]) {
    assert.ok(section.includes("`" + spelling + "`"),
      "the force-push row does not name the refspec spelling " + spelling);
    assert.equal(guardLib.pushBranch("git push --force origin " + spelling), "main",
      "the section promises " + spelling + " reads as the default branch, and the parser disagrees");
  }
  assert.equal(guardLib.branchInScope("git push --force origin HEAD:main", ["<default>"], {}), true,
    "the force-push violation falls outside the scope the row declares");
  assert.equal(guardLib.branchInScope("git push --force origin refs/heads/spike", ["<default>"], {}), false,
    "the force-push near miss is in scope too, so the pair proves nothing");
});

// ---------------------------------------------------------------------------
// The measured session, and what a surface may infer from it
// ---------------------------------------------------------------------------
//
// 2.14.0. `docs/research/jig/HOST-PROBE-2026-09-02.md` section 3 measured ONE
// headless win32 session offered `PowerShell` and no `Bash`; section 4 measured
// an interactive session on the SAME machine carrying both, and calls section
// 3's claim "false of this machine as a whole". SCOPE states the rule that
// follows: the set is per session, not per platform. Three comments this
// release added generalised the one session to the platform anyway — in the
// release's own evidence files, which is where the generalisation does the most
// damage. This gate reads jig's own source for the phrasings that do it.
test("no jig source reads the measured session as a fact about the platform", () => {
  const banned = [
    /every win32 session/i,
    /on win32,? (?:Claude Code )?offers/i,
    /on that platform,? no command guard/i,
    /on win32 — where the tool is/i,
    /never evaluated on the owner's own platform/i,
  ];
  const files = [
    ...["hooks/jig-lib.js", "hooks/jig-hook.js", "scripts/jig.js", "scripts/vocab.js"],
    // Every suite but this one: the phrases are literals in the regexes above,
    // so a gate that read its own source would fail on the thing it forbids.
    ...fs.readdirSync(path.join(PLUGIN_ROOT, "tests"))
      .filter((n) => n.endsWith(".test.js") && n !== "docs.test.js").map((n) => "tests/" + n),
    ...fs.readdirSync(path.join(PLUGIN_ROOT, "skills")).map((n) => "skills/" + n + "/SKILL.md"),
  ].filter((rel) => fs.existsSync(path.join(PLUGIN_ROOT, rel)));
  assert.ok(files.length > 10, "the file list this gate reads collapsed, so it proves nothing");
  for (const rel of files) {
    const text = read(...rel.split("/"));
    for (const phrase of banned) {
      assert.doesNotMatch(text, phrase, rel + " infers the shell tool set from the platform: " + phrase);
    }
  }
});

// The other half of the same rule, on the surface an author reads. jig watches
// two names; whether any host names its shell a third is recorded as NOT
// probed, and plan.md discloses it. An authoring skill that says the guard runs
// "either way" tells the author the set is exhaustive, which no run establishes.
test("the authoring skill discloses the third name the probe never ruled out", () => {
  const authoring = read("skills", "jig", "SKILL.md");
  assert.ok(!authoring.includes("so the guard runs either way"),
    "the authoring skill calls two names exhaustive, which HOST-PROBE-2026-09-02 marks as not probed");
  assert.match(authoring, /names its shell anything else\s+is a host where this guard does not evaluate/,
    "the authoring skill never tells an author where a command guard does not run at all");
  assert.match(authoring, /not probed and is not guessed/,
    "the authoring skill states the gap as known rather than as unmeasured");
});

// A citation is the only thing standing between a comment and folklore, so it
// has to point at where the measurement is. The untrusted-workspace trap is in
// the record's `## Method`; section 1 is `PostToolUseFailure`, and a reader who
// followed the citation as written found a finding about something else. The
// record itself is a local research file this suite cannot read, which is
// exactly why the citation in the source has to be right.
test("the permissions probe cites the section its trap was actually recorded in", () => {
  const probe = read("scripts", "probes", "permissions.js");
  const trap = probe.slice(probe.indexOf("A fresh mkdtemp root"), probe.indexOf("function tmpProject"));
  assert.ok(trap.includes("permissions.allow"), "the untrusted-workspace note is gone from the probe");
  assert.ok(!/section 1/.test(trap), "the note still cites section 1, which is `PostToolUseFailure`");
  assert.match(trap, /`## Method`, the traps list/, "the note does not say where the trap is recorded");
});
