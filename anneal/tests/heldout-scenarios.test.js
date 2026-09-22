"use strict";

// The held-out eval cases, graded without a model session. They check the
// navigation cases' two route lines on a second repository: the fixture script
// builds both snapshots of a booking platform whose layout, domain, map format
// and contract differ from the navigation fixture's. Each case's graders are
// evaluated the way the eval harness evaluates a regex grader, against what a
// run can leave behind. A known-good solution passes every grader; a plausible
// wrong or partial one fails at least one. Where the task changes code, the
// code's behaviour must agree with the verdict.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { frontmatter, readGraders: graders, passes } = require("./eval-harness");

const EVALS = path.join(__dirname, "..", "evals");
const FIXTURE = path.join(EVALS, "heldout-fixture.js");
const NAVIGATION_FIXTURE = path.join(EVALS, "navigation-fixture.js");
const VARIANTS = ["original", "oriented"];
const LIMITS = "integrations/carrier/src/limits.js";
const FEES = "services/booking/src/fees.js";
const READ_MAP = "Before anything else, read `AGENTS.md`.";

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

function listFiles(root) {
  return fs
    .readdirSync(root, { recursive: true })
    .map((file) => file.split(path.sep).join("/"))
    .filter((file) => !file.split("/").includes(".git") && fs.statSync(path.join(root, file)).isFile())
    .sort();
}

// Git without the user's or the system's configuration, as the harness runs a
// scaffold script.
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
const snapshots = {};
before(() => {
  gitEnv.GIT_CONFIG_GLOBAL = path.join(tempDir("anneal-heldout-git-"), "config");
  fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "");
  for (const variant of VARIANTS) {
    snapshots[variant] = tempDir(`anneal-heldout-${variant}-`);
    execFileSync(process.execPath, [FIXTURE, variant], { cwd: snapshots[variant], env: gitEnv, stdio: "pipe" });
  }
});

const CASES = fs
  .readdirSync(EVALS)
  .map((name) => /^heldout-(.+)-(original|oriented)$/.exec(name))
  .filter(Boolean)
  .map(([name, scenario, variant]) => ({ name, scenario, variant, dir: path.join(EVALS, name) }));
const caseDir = (scenario, variant) => path.join(EVALS, `heldout-${scenario}-${variant}`);

// What a run leaves behind: its last message, and its edits as [file, text,
// replacement] triples applied to a copy of the snapshot.
const WHY = "The booking service's quote in services/booking/src/quote.js imports returningCustomerDiscount from lib/fare-rules, whose index re-exports it from src/returning-customer.js.\n\n";
const batches = (size, max) => [
  [LIMITS, "MANIFEST_DEFAULT_BATCH: 100,", `MANIFEST_DEFAULT_BATCH: ${size},`],
  [LIMITS, "MANIFEST_MAX_BATCH: 500,", `MANIFEST_MAX_BATCH: ${max},`],
];
const region = (line) => [[FEES, '  NL: "eu",\n', `  NL: "eu",\n  ${line}\n`]];

const SOLUTIONS = {
  "package-lookup": [
    { kind: "good", name: "a plain answer line", message: `${WHY}ANSWER: lib/fare-rules/src/returning-customer.js returningCustomerDiscount` },
    { kind: "good", name: "a formatted answer line", message: `${WHY}**ANSWER:** \`lib/fare-rules/src/returning-customer.js#returningCustomerDiscount()\`` },
    { kind: "good", name: "an absolute path with a line number", message: `${WHY}ANSWER: /workspace/run/lib/fare-rules/src/returning-customer.js:11 returningCustomerDiscount` },
    { kind: "wrong", name: "the v1 library's repeat discount", message: "ANSWER: lib/fares-v1/src/repeat.js applyRepeatDiscount" },
    { kind: "wrong", name: "the promotions library's returning-booker code", message: "ANSWER: lib/promotions/src/codes.js repeatBookerCode" },
    { kind: "partial", name: "the library entry that re-exports it", message: "ANSWER: lib/fare-rules/src/index.js returningCustomerDiscount" },
    { kind: "partial", name: "the file without the function", message: "ANSWER: lib/fare-rules/src/returning-customer.js" },
    { kind: "partial", name: "two answer lines", message: "ANSWER: lib/fare-rules/src/returning-customer.js returningCustomerDiscount\nANSWER: lib/fares-v1/src/repeat.js applyRepeatDiscount" },
    { kind: "partial", name: "two candidates on one line", message: "ANSWER: lib/fare-rules/src/returning-customer.js returningCustomerDiscount or lib/fares-v1/src/repeat.js applyRepeatDiscount" },
    { kind: "partial", name: "two candidates on one line, the right one last", message: "ANSWER: lib/fares-v1/src/repeat.js applyRepeatDiscount or lib/fare-rules/src/returning-customer.js returningCustomerDiscount" },
    { kind: "partial", name: "the right function without an answer line", message: "The booking service uses returningCustomerDiscount from lib/fare-rules/src/returning-customer.js." },
  ],
  "contract-section": [
    { kind: "good", name: "the manifests entry's batch sizes", edits: batches(25, 60) },
    {
      kind: "good",
      name: "the same batch sizes under a note",
      edits: [[LIMITS, "  MANIFEST_DEFAULT_BATCH: 100,\n  MANIFEST_MAX_BATCH: 500,", "  // POST /v3/manifests sets its own batch sizes (section 6).\n  MANIFEST_DEFAULT_BATCH: 25,\n  MANIFEST_MAX_BATCH: 60,"]],
    },
    { kind: "wrong", name: "no change, since the general rule matches", edits: [] },
    { kind: "wrong", name: "the retired v2 batch sizes", edits: batches(50, 250) },
    { kind: "wrong", name: "the label batch sizes", edits: batches(20, 40) },
    { kind: "wrong", name: "the parcel batch sizes", edits: batches(75, 300) },
    { kind: "wrong", name: "the right batch sizes and the old rate limit", edits: [...batches(25, 60), [LIMITS, "REQUESTS_PER_MINUTE: 90,", "REQUESTS_PER_MINUTE: 60,"]] },
    { kind: "partial", name: "only the maximum", edits: batches(100, 60) },
    { kind: "partial", name: "only the default", edits: batches(25, 500) },
    { kind: "partial", name: "the right default with the v2 maximum", edits: batches(25, 250) },
  ],
  "explicit-path": [
    { kind: "good", name: "an entry in the region table", edits: region('PT: "eu",') },
    { kind: "good", name: "an assignment after the table", edits: [[FEES, '  NO: "europe",\n};\n', '  NO: "europe",\n};\nREGIONS.PT = "eu";\n']] },
    { kind: "wrong", name: "no change", edits: [] },
    { kind: "wrong", name: "Portugal in the non-EU Europe region", edits: region('PT: "europe",') },
    { kind: "wrong", name: "a lower non-EU fee instead", edits: [[FEES, '"non-eu": 900', '"non-eu": 250']] },
    { kind: "wrong", name: "the Netherlands' entry overwritten", edits: [[FEES, 'NL: "eu"', 'PT: "eu"']] },
    { kind: "wrong", name: "every unlisted country made EU", edits: [[FEES, '?? "non-eu"', '?? "eu"']] },
    { kind: "partial", name: "a misspelled region", edits: region('PT: "EU",') },
    {
      kind: "partial",
      name: "only a test for Portugal",
      edits: [["services/booking/test/fees.test.js", 'assert.strictEqual(serviceFeeCents("US"), 900);', 'assert.strictEqual(serviceFeeCents("US"), 900);\n  assert.strictEqual(serviceFeeCents("PT"), 250);']],
    },
  ],
};

// The behaviour a code-changing task asks for, including what it must keep.
const BEHAVIOUR = {
  "contract-section": (dir) => {
    const { manifestBatches } = require(path.join(dir, "integrations/carrier/src/manifests.js"));
    const limits = require(path.join(dir, LIMITS));
    const parcels = Array.from({ length: 130 }, (_, i) => i);
    const sizes = (size) => manifestBatches(parcels, size).map((batch) => batch.length).join(",");
    return sizes() === "25,25,25,25,25,5" && sizes(500) === "60,60,10" && limits.REQUESTS_PER_MINUTE === 90 && limits.LABELS_MAX_BATCH === 40;
  },
  "explicit-path": (dir) => {
    const { serviceFeeCents } = require(path.join(dir, FEES));
    const expected = { PT: 250, DE: 250, ES: 250, FR: 250, IT: 250, NL: 250, CH: 400, GB: 400, NO: 400, US: 900 };
    return Object.entries(expected).every(([country, cents]) => serviceFeeCents(country) === cents);
  },
};

function behaves(scenario, dir) {
  try {
    return BEHAVIOUR[scenario](dir);
  } catch {
    return false;
  }
}

function applySolution(variant, solution) {
  const dir = tempDir("anneal-heldout-run-");
  fs.cpSync(snapshots[variant], dir, { recursive: true, filter: (source) => path.basename(source) !== ".git" });
  for (const [file, text, replacement] of solution.edits ?? []) {
    const content = read(dir, file);
    assert.ok(content.includes(text), `${solution.name}: ${file} contains ${JSON.stringify(text)}`);
    fs.writeFileSync(path.join(dir, file), content.replace(text, () => replacement));
  }
  return { dir, reply: solution.message ?? "Done." };
}

function assertOwnTestsPass(dir, label) {
  // A nested test run reports to its parent runner unless this is cleared.
  const run = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  assert.strictEqual(run.status, 0, `${label}: the fixture's own tests fail\n${run.stdout}${run.stderr}`);
}

describe("held-out cases", () => {
  test("three scenarios each run on the original and the oriented snapshot", () => {
    const scenarios = [...new Set(CASES.map((c) => c.scenario))].sort();
    assert.deepStrictEqual(scenarios, Object.keys(SOLUTIONS).sort());
    for (const scenario of scenarios) {
      assert.deepStrictEqual(CASES.filter((c) => c.scenario === scenario).map((c) => c.variant).sort(), [...VARIANTS].sort());
    }
  });

  test("both cases of a scenario share prompt, graders and settings, and all six share limits and tools", () => {
    for (const scenario of Object.keys(SOLUTIONS)) {
      const [original, oriented] = VARIANTS.map((variant) => caseDir(scenario, variant));
      assert.strictEqual(read(oriented, "prompt.md"), read(original, "prompt.md"), scenario);
      assert.deepStrictEqual(listFiles(path.join(oriented, "graders")), listFiles(path.join(original, "graders")), scenario);
      for (const file of listFiles(path.join(original, "graders"))) assert.strictEqual(read(oriented, `graders/${file}`), read(original, `graders/${file}`));
      const settings = (dir) => read(dir, "case.yaml").replace(/^(name|description|  scaffold_script): .*\n/gm, "");
      assert.strictEqual(settings(oriented), settings(original), scenario);
      assert.match(read(original, "case.yaml"), /^tags: \[heldout\]$/m);
    }
    const limits = CASES.map(({ dir }) => {
      const { max_turns, timeout_seconds, allowed_tools } = frontmatter(path.join(dir, "prompt.md"));
      return JSON.stringify({ max_turns, timeout_seconds, allowed_tools });
    });
    assert.strictEqual(new Set(limits).size, 1);
  });

  test("every prompt first asks for AGENTS.md, as the navigation cases do, and its task text never names the map", () => {
    for (const { name, dir } of CASES) {
      const body = read(dir, "prompt.md").replace(/^---\s*\n[\s\S]*?---\s*\n?/, "").trim();
      assert.ok(body.startsWith(`${READ_MAP}\n\n`), name);
      assert.ok(!body.slice(READ_MAP.length).includes("AGENTS.md"), name);
    }
  });

  test("each case scaffolds its own snapshot with the held-out fixture script", () => {
    for (const { name, variant, dir } of CASES) {
      assert.match(read(dir, "case.yaml"), new RegExp(`^name: ${name}\\n[\\s\\S]*^  scaffold_script: ${name}\\.sh$`, "m"));
      assert.strictEqual(read(dir, `${name}.sh`), `#!/usr/bin/env bash\nset -euo pipefail\n\nnode "$(dirname "$0")/../heldout-fixture.js" ${variant}\n`);
    }
  });
});

describe("held-out snapshots", () => {
  test("the snapshots differ only in the Start here section of the map file", () => {
    const [original, oriented] = VARIANTS.map((variant) => snapshots[variant]);
    assert.deepStrictEqual(listFiles(oriented), listFiles(original));
    for (const file of listFiles(original)) {
      if (file !== "AGENTS.md") assert.strictEqual(read(oriented, file), read(original, file), file);
    }
    const map = read(oriented, "AGENTS.md");
    assert.match(map, /^## Start here$/m);
    assert.strictEqual(map.replace(/^## Start here\n[\s\S]*?(?=^## )/m, ""), read(original, "AGENTS.md"));
    assert.strictEqual(read(original, "CLAUDE.md"), "@AGENTS.md\n");
  });

  test("each Start here line names only what its destination holds, and neither a fee nor a decoy", () => {
    const lines = read(snapshots.oriented, "AGENTS.md").split("\n").filter((line) => line.startsWith("- Before changing"));
    assert.strictEqual(lines.length, 2);
    const [library, contract] = lines;
    assert.strictEqual(library, "- Before changing returning-customer discounts, go to `lib/fare-rules/`.");
    const exported = Object.keys(require(path.join(fs.realpathSync(snapshots.oriented), "lib/fare-rules")));
    assert.ok(exported.includes("returningCustomerDiscount"), exported.join(", "));
    assert.match(contract, /^- Before changing an endpoint's batch or page size, read that endpoint's entry under `## 6\. Endpoints` in `reference\/carrier-api\.md`\.$/);
    const endpoints = read(snapshots.oriented, "reference/carrier-api.md").split(/^## 6\. Endpoints$/m)[1].split(/^## 7\. /m)[0];
    assert.match(endpoints, /when it gives no `batch_size`/);
    assert.match(endpoints, /A page holds \d+/);
    for (const line of lines) assert.doesNotMatch(line, /fee|fares-v1|promotions|legacy-gateway/i);
  });

  test("the layout shares no top-level folder with the navigation fixture, and the map uses a tree instead of a table", () => {
    const navigation = tempDir("anneal-heldout-navigation-");
    execFileSync(process.execPath, [NAVIGATION_FIXTURE, "original"], { cwd: navigation, env: gitEnv, stdio: "pipe" });
    const folders = (root) => new Set(fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name));
    const shared = [...folders(snapshots.original)].filter((folder) => folders(navigation).has(folder));
    assert.deepStrictEqual(shared, []);
    assert.match(read(snapshots.original, "AGENTS.md"), /^```text\nservices\//m);
    assert.doesNotMatch(read(snapshots.original, "AGENTS.md"), /^\| Path \|/m);
  });

  test("each snapshot is committed and passes its own tests", () => {
    for (const variant of VARIANTS) {
      assert.strictEqual(execFileSync("git", ["status", "--porcelain"], { cwd: snapshots[variant], env: gitEnv, encoding: "utf8" }), "");
      assertOwnTestsPass(snapshots[variant], variant);
    }
  });

  test("the script refuses to write over an existing file", () => {
    const run = spawnSync(process.execPath, [FIXTURE, "original"], { cwd: snapshots.original, encoding: "utf8" });
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /refusing to overwrite/);
  });

  test("the booking quote loads the function the package lookup expects, and the decoys are real", () => {
    const root = fs.realpathSync(snapshots.original);
    require(path.join(root, "services/booking/src/quote.js"));
    const loaded = Object.keys(require.cache)
      .filter((file) => file.startsWith(root))
      .map((file) => path.relative(root, file).split(path.sep).join("/"));
    assert.ok(loaded.includes("lib/fare-rules/src/returning-customer.js"), loaded.join(", "));
    assert.deepStrictEqual(loaded.filter((file) => /^lib\/(fares-v1|promotions)\//.test(file)), []);
    assert.match(read(root, "lib/fare-rules/src/returning-customer.js"), /^function returningCustomerDiscount\(/m);
    assert.match(read(root, "lib/fares-v1/src/repeat.js"), /^function applyRepeatDiscount\(/m);
    assert.match(read(root, "lib/promotions/src/codes.js"), /^function repeatBookerCode\(/m);
  });

  test("the contract gives the manifest batch sizes in the endpoint's entry, past line 2,000", () => {
    const contract = read(snapshots.original, "reference/carrier-api.md");
    const lines = contract.split("\n");
    const start = lines.findIndex((line) => /^### 6\.\d+ `POST \/v3\/manifests`$/.test(line));
    assert.ok(start !== -1, "the contract has a POST /v3/manifests entry");
    const end = lines.findIndex((line, index) => index > start && /^#{2,3} /.test(line));
    assert.ok(start + 1 > 2000, `the entry starts on line ${start + 1}`);
    assert.match(lines.slice(start, end).join("\n"), /a request takes at most 60 parcels, and 25 when it gives no `batch_size`/);
    assert.match(contract, /accepts up to 500 items per request, and uses 100 when the request gives no `batch_size`/);
    assert.doesNotMatch(contract, /Bearer [A-Za-z0-9._-]{20,}/);
  });
});

describe("held-out graders", () => {
  for (const [scenario, solutions] of Object.entries(SOLUTIONS)) {
    test(`${scenario}: a known-good solution passes every grader, a wrong or partial one fails at least one`, () => {
      for (const variant of VARIANTS) {
        const checks = graders(caseDir(scenario, variant));
        for (const solution of solutions) {
          const run = applySolution(variant, solution);
          const failed = checks.filter((grader) => !passes(grader, run)).map((grader) => grader.name);
          if (solution.kind === "good") assert.deepStrictEqual(failed, [], `${variant}, ${solution.name}`);
          else assert.notDeepStrictEqual(failed, [], `${variant}, ${solution.name}: passes every grader`);
          if (BEHAVIOUR[scenario]) assert.strictEqual(behaves(scenario, run.dir), solution.kind === "good", `${variant}, ${solution.name}: behaviour`);
        }
      }
    });
  }

  test("known-good changes keep the fixture's own tests passing", () => {
    for (const scenario of Object.keys(BEHAVIOUR)) {
      for (const solution of SOLUTIONS[scenario].filter(({ kind }) => kind === "good")) {
        assertOwnTestsPass(applySolution("original", solution).dir, `${scenario}, ${solution.name}`);
      }
    }
  });
});
