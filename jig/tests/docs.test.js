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

test("the witnessed close does not claim a toolchain probe is ever spawned", () => {
  // The engine's own assertion is in checks.test.js: every toolchain probe
  // comes back `ran: false`. This is the sentence that has to agree with it.
  const skill = read("skills", "jig", "SKILL.md");
  const close = skill.slice(skill.indexOf("## 8. Witnessed close"), skill.indexOf("## 9. Close"));
  assert.ok(close.includes("Witnessed close"), "section 8 is gone from SKILL.md");
  assert.doesNotMatch(close, /Most tools/,
    "the close claims only *most* tools go unspawned; the engine spawns none");
  assert.match(close, /spawns none of them|does not spawn/,
    "the close does not say that jig spawns no tool from a selftest");
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
  assert.match(header, /empty checks directory proves nothing/,
    "the header does not say an empty checks directory is a failure");

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

  // And an empty checks directory, which is the case the sentence names.
  assert.equal(driverRoot(driver, {}).status, 1);
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
