"use strict";

// The navigation eval cases, graded without a model session. The fixture script
// builds both snapshots the cases run in. Each case's graders are evaluated the
// way the eval harness evaluates a regex grader, against what a run can leave
// behind: its last message and its edits to a copy of the snapshot. A
// known-good solution passes every grader; a plausible wrong or partial one
// fails at least one. Where the task changes code, the code's behaviour must
// agree with the verdict.

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { frontmatter, readGraders: graders, passes } = require("./eval-harness");

const EVALS = path.join(__dirname, "..", "evals");
const FIXTURE = path.join(EVALS, "navigation-fixture.js");
const VARIANTS = ["original", "oriented"];
const LIMITS = "packages/partner-client/src/limits.js";
const SHIPPING = "apps/storefront/src/shipping.js";

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
  gitEnv.GIT_CONFIG_GLOBAL = path.join(tempDir("anneal-nav-git-"), "config");
  fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "");
  for (const variant of VARIANTS) {
    snapshots[variant] = tempDir(`anneal-nav-${variant}-`);
    execFileSync(process.execPath, [FIXTURE, variant], { cwd: snapshots[variant], env: gitEnv, stdio: "pipe" });
  }
});

const CASES = fs
  .readdirSync(EVALS)
  .map((name) => /^navigation-(.+)-(original|oriented)$/.exec(name))
  .filter(Boolean)
  .map(([name, scenario, variant]) => ({ name, scenario, variant, dir: path.join(EVALS, name) }));
const caseDir = (scenario, variant) => path.join(EVALS, `navigation-${scenario}-${variant}`);

// What a run leaves behind: its last message, and its edits as [file, text,
// replacement] triples applied to a copy of the snapshot.
const WHY = "The storefront checkout in apps/storefront/src/checkout.js imports memberDiscount from packages/price-engine, whose index re-exports it from src/member-discounts.js.\n\n";
const pageSizes = (size, max) => [
  [LIMITS, "SHIPMENTS_DEFAULT_PAGE_SIZE: 50,", `SHIPMENTS_DEFAULT_PAGE_SIZE: ${size},`],
  [LIMITS, "SHIPMENTS_MAX_PAGE_SIZE: 200,", `SHIPMENTS_MAX_PAGE_SIZE: ${max},`],
];
const zoneEntry = (line) => [[SHIPPING, '  FI: "nordic",\n', `  FI: "nordic",\n  ${line}\n`]];

const SOLUTIONS = {
  "package-lookup": [
    { kind: "good", name: "a plain answer line", message: `${WHY}ANSWER: packages/price-engine/src/member-discounts.js memberDiscount` },
    { kind: "good", name: "a formatted answer line", message: `${WHY}**ANSWER:** \`packages/price-engine/src/member-discounts.js#memberDiscount()\`` },
    { kind: "good", name: "an absolute path with a line number", message: `${WHY}ANSWER: /workspace/run/packages/price-engine/src/member-discounts.js:8 memberDiscount` },
    { kind: "wrong", name: "the v1 package's loyalty function", message: "ANSWER: packages/pricing/src/loyalty.js applyLoyaltyDiscount" },
    { kind: "wrong", name: "the quotes package's loyalty function", message: "ANSWER: packages/quotes/src/rebates.js loyaltyRebate" },
    { kind: "partial", name: "the package entry that re-exports it", message: "ANSWER: packages/price-engine/src/index.js memberDiscount" },
    { kind: "partial", name: "the file without the function", message: "ANSWER: packages/price-engine/src/member-discounts.js" },
    { kind: "partial", name: "two answer lines", message: "ANSWER: packages/price-engine/src/member-discounts.js memberDiscount\nANSWER: packages/pricing/src/loyalty.js applyLoyaltyDiscount" },
    { kind: "partial", name: "two candidates on one line", message: "ANSWER: packages/price-engine/src/member-discounts.js memberDiscount or packages/pricing/src/loyalty.js applyLoyaltyDiscount" },
    { kind: "partial", name: "two candidates on one line, the right one last", message: "ANSWER: packages/pricing/src/loyalty.js applyLoyaltyDiscount or packages/price-engine/src/member-discounts.js memberDiscount" },
    { kind: "partial", name: "the right function without an answer line", message: "The storefront uses memberDiscount from packages/price-engine/src/member-discounts.js." },
  ],
  "contract-section": [
    { kind: "good", name: "the shipments entry's page sizes", edits: pageSizes(20, 100) },
    {
      kind: "good",
      name: "the same page sizes under a note",
      edits: [[LIMITS, "  SHIPMENTS_DEFAULT_PAGE_SIZE: 50,\n  SHIPMENTS_MAX_PAGE_SIZE: 200,", "  // GET /v2/shipments sets its own page sizes (section 8).\n  SHIPMENTS_DEFAULT_PAGE_SIZE: 20,\n  SHIPMENTS_MAX_PAGE_SIZE: 100,"]],
    },
    { kind: "wrong", name: "no change, since the general rule matches", edits: [] },
    { kind: "wrong", name: "the retired v1 page sizes", edits: pageSizes(25, 250) },
    { kind: "wrong", name: "the events page sizes", edits: pageSizes(100, 1000) },
    { kind: "wrong", name: "the right page sizes and the old rate limit", edits: [...pageSizes(20, 100), [LIMITS, "REQUESTS_PER_MINUTE: 120,", "REQUESTS_PER_MINUTE: 100,"]] },
    { kind: "partial", name: "only the maximum", edits: pageSizes(50, 100) },
    { kind: "partial", name: "only the default", edits: pageSizes(20, 200) },
    { kind: "partial", name: "the right default with the events maximum", edits: pageSizes(20, 1000) },
  ],
  "explicit-path": [
    { kind: "good", name: "an entry in the zone table", edits: zoneEntry('NO: "nordic",') },
    { kind: "good", name: "an assignment after the table", edits: [[SHIPPING, '  SE: "nordic",\n};\n', '  SE: "nordic",\n};\nZONES.NO = "nordic";\n']] },
    { kind: "wrong", name: "no change", edits: [] },
    { kind: "wrong", name: "Norway in the EU zone", edits: zoneEntry('NO: "eu",') },
    { kind: "wrong", name: "a lower world rate instead", edits: [[SHIPPING, "world: 2490", "world: 1290"]] },
    { kind: "wrong", name: "Sweden's entry overwritten", edits: [[SHIPPING, 'SE: "nordic"', 'NO: "nordic"']] },
    { kind: "wrong", name: "every unlisted country made nordic", edits: [[SHIPPING, '?? "world"', '?? "nordic"']] },
    { kind: "partial", name: "a misspelled zone", edits: zoneEntry('NO: "Nordic",') },
    {
      kind: "partial",
      name: "only a test for Norway",
      edits: [["apps/storefront/test/shipping.test.js", 'assert.strictEqual(shippingCents("SE"), 1290);', 'assert.strictEqual(shippingCents("SE"), 1290);\n  assert.strictEqual(shippingCents("NO"), 1290);']],
    },
  ],
};

// The behaviour a code-changing task asks for, including what it must keep.
const BEHAVIOUR = {
  "contract-section": (dir) => {
    const { shipmentsQuery } = require(path.join(dir, "packages/partner-client/src/shipments.js"));
    const limits = require(path.join(dir, LIMITS));
    return shipmentsQuery() === "limit=20" && shipmentsQuery({ limit: 500 }) === "limit=100" && limits.REQUESTS_PER_MINUTE === 120 && limits.LABELS_MAX_BATCH === 25;
  },
  "explicit-path": (dir) => {
    const { shippingCents } = require(path.join(dir, SHIPPING));
    const expected = { NO: 1290, DE: 490, AT: 990, FR: 990, NL: 990, DK: 1290, FI: 1290, SE: 1290, US: 2490 };
    return Object.entries(expected).every(([country, cents]) => shippingCents(country) === cents);
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
  const dir = tempDir("anneal-nav-run-");
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

describe("cases", () => {
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
    }
    const limits = CASES.map(({ dir }) => {
      const { max_turns, timeout_seconds, allowed_tools } = frontmatter(path.join(dir, "prompt.md"));
      return JSON.stringify({ max_turns, timeout_seconds, allowed_tools });
    });
    assert.strictEqual(new Set(limits).size, 1);
  });

  // The harness starts each session with only user settings, so the fixture's
  // CLAUDE.md and AGENTS.md never load; the same first line in every prompt
  // brings each snapshot's map in the same way.
  test("every prompt first asks for AGENTS.md, and its task text never names the map", () => {
    const READ_MAP = "Before anything else, read `AGENTS.md`.";
    for (const { name, dir } of CASES) {
      const body = read(dir, "prompt.md").replace(/^---\s*\n[\s\S]*?---\s*\n?/, "").trim();
      assert.ok(body.startsWith(`${READ_MAP}\n\n`), name);
      assert.ok(!body.slice(READ_MAP.length).includes("AGENTS.md"), name);
    }
  });

  test("each case scaffolds its own snapshot with the fixture script", () => {
    for (const { name, scenario, variant, dir } of CASES) {
      const script = `${scenario}-${variant}.sh`;
      assert.match(read(dir, "case.yaml"), new RegExp(`^name: ${name}\\n[\\s\\S]*^  scaffold_script: ${script}$`, "m"));
      assert.strictEqual(read(dir, script), `#!/usr/bin/env bash\nset -euo pipefail\n\nnode "$(dirname "$0")/../navigation-fixture.js" ${variant}\n`);
    }
  });
});

describe("snapshots", () => {
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

  test("each Start here line names only what its destination holds, and no decoy", () => {
    const lines = read(snapshots.oriented, "AGENTS.md").split("\n").filter((line) => line.startsWith("- Before changing"));
    assert.strictEqual(lines.length, 2);
    const [library, contract] = lines;
    assert.strictEqual(library, "- Before changing member discounts or tax, go to `packages/price-engine/`.");
    const exported = Object.keys(require(path.join(fs.realpathSync(snapshots.oriented), "packages/price-engine")));
    assert.deepStrictEqual(exported.sort(), ["TIER_RATES", "VAT_RATES", "memberDiscount", "vatCents"]);
    assert.strictEqual(contract, "- Before changing an endpoint's batch or page size, read that endpoint's entry under `## 8. Endpoint reference` in `docs/partner-api.md`.");
    const endpoints = read(snapshots.oriented, "docs/partner-api.md").split(/^## 8\. Endpoint reference$/m)[1].split(/^## 9\. /m)[0];
    assert.match(endpoints, /for at most \d+ shipments per request/);
    assert.match(endpoints, /Page size\. Default \d+, maximum \d+\./);
    assert.doesNotMatch(endpoints, /requests per minute/);
    for (const line of lines) assert.doesNotMatch(line, /packages\/pricing|packages\/quotes|apps\/api-v1|frozen/);
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

  test("the storefront checkout loads the function the package lookup expects, and the decoys are real", () => {
    const root = fs.realpathSync(snapshots.original);
    require(path.join(root, "apps/storefront/src/checkout.js"));
    const loaded = Object.keys(require.cache)
      .filter((file) => file.startsWith(root))
      .map((file) => path.relative(root, file).split(path.sep).join("/"));
    assert.ok(loaded.includes("packages/price-engine/src/member-discounts.js"), loaded.join(", "));
    assert.deepStrictEqual(loaded.filter((file) => /^packages\/(pricing|quotes)\//.test(file)), []);
    assert.match(read(root, "packages/price-engine/src/member-discounts.js"), /^function memberDiscount\(/m);
    assert.match(read(root, "packages/pricing/src/loyalty.js"), /^function applyLoyaltyDiscount\(/m);
    assert.match(read(root, "packages/quotes/src/rebates.js"), /^function loyaltyRebate\(/m);
  });

  test("the contract gives the shipments page sizes in the endpoint's entry, past line 2,000", () => {
    const contract = read(snapshots.original, "docs/partner-api.md");
    const lines = contract.split("\n");
    const start = lines.findIndex((line) => /^#### 8\.\d+ GET \/v2\/shipments$/.test(line));
    const end = lines.findIndex((line, index) => index > start && /^#{2,4} /.test(line));
    assert.ok(start + 1 > 2000, `the entry starts on line ${start + 1}`);
    assert.match(lines.slice(start, end).join("\n"), /\| Page size\. Default 20, maximum 100\. \|/);
    assert.match(contract, /`limit` defaults to 50 and may be at most 200\./);
  });
});

describe("graders", () => {
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
