"use strict";

// readme-check's rules, each with a draft that trips it and a near miss that does not, and the
// CLI through its real entry point.

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
require("./temp-root.js");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { checkReadme } = require("../scripts/readme-check.js");

const CLI = path.join(__dirname, "..", "scripts", "readme-check.js");
const USAGE = "usage: readme-check.js [--tier minimal|standard|advanced] README.md\n";

const doc = (...lines) => `${lines.join("\n")}\n`;
const CLEAN = doc("# csv-tidy", "", "csv-tidy removes empty rows from CSV files.", "", "```bash", "csv-tidy input.csv", "```", "", "Expected output:", "", "```text", "Wrote clean.csv", "```");
const of = (rule, text, options) => checkReadme(text, options).filter((finding) => finding.rule === rule);
// A sentence of n words.
const sentence = (n) => `${Array.from({ length: n }, (_, i) => `w${i}`).join(" ")}.`;

const MESSAGES = {
  unclosed: "code fence is never closed",
  badge: "badges appear before the description; move them below it",
  lang: "code fence has no language tag",
  prompt: "copyable block contains a `$` prompt; use a text block to show responses",
  result: "no block anywhere shows what a reader should see; add expected output, or a comment on the call showing the value it returns",
  placeholder: "unfilled template placeholder",
  vague: "link text does not name its destination",
  echo: "link text repeats the URL; name the destination instead",
};

test("a clean draft has no findings", () => {
  assert.deepStrictEqual(checkReadme(CLEAN), []);
});

describe("rules", () => {
  test("fence-unclosed: an open fence at the end, which no other fence rule reads", () => {
    assert.deepStrictEqual(checkReadme(doc("# T", "", "Text.", "", "```", "x")), [{ line: 5, rule: "fence-unclosed", message: MESSAGES.unclosed }]);
    assert.deepStrictEqual(of("fence-unclosed", CLEAN), []);
  });

  test("h1-count: none or two, and a heading inside a fence does not count", () => {
    assert.deepStrictEqual(checkReadme(doc("Text.")), [{ line: 1, rule: "h1-count", message: "expected exactly one H1, found 0" }]);
    assert.deepStrictEqual(checkReadme(doc("# A", "", "Text.", "", "# B")), [{ line: 1, rule: "h1-count", message: "expected exactly one H1, found 2" }]);
    assert.deepStrictEqual(checkReadme(doc("# A", "", "Text.", "", "```text", "# not a heading", "```")), []);
  });

  test("h1-count: an HTML or setext title counts once, an underline under nothing or in a fence does not", () => {
    assert.deepStrictEqual(checkReadme(doc('<h1 align="center">T</h1>', "", "Text.")), []);
    assert.deepStrictEqual(checkReadme(doc("T", "=", "", "Text.")), []);
    assert.deepStrictEqual(checkReadme(doc("# A", "", "Text.", "", "<H1>B</H1>")), [{ line: 1, rule: "h1-count", message: "expected exactly one H1, found 2" }]);
    assert.deepStrictEqual(checkReadme(doc("# A", "", "B", "===")), [{ line: 1, rule: "h1-count", message: "expected exactly one H1, found 2" }]);
    assert.deepStrictEqual(checkReadme(doc("# A", "", "===", "", "```text", "<h1>x</h1>", "T", "===", "```")), []);
  });

  test("h1-count: a mention of the tag in prose or a table is not a title", () => {
    assert.deepStrictEqual(checkReadme(doc("# T", "", "Wrap the title in an `<h1>` tag.", "", "| a | b |", "| - | - |", "| <h1 class=x> | y |")), []);
    assert.deepStrictEqual(checkReadme(doc("# T", "", "<h10>x</h10>")), []);
  });

  test("badge-first: a badge above the description, not below it", () => {
    assert.deepStrictEqual(checkReadme(doc("[![CI](ci.svg)](ci)", "# T", "", "Text.")), [{ line: 1, rule: "badge-first", message: MESSAGES.badge }]);
    assert.deepStrictEqual(checkReadme(doc("# T", "", "Text.", "", "[![CI](ci.svg)](ci)", "![logo](logo.png)")), []);
  });

  test("fence-lang: a bare fence, not a tagged one", () => {
    assert.deepStrictEqual(of("fence-lang", doc("# T", "", "```", "x", "```")), [{ line: 3, rule: "fence-lang", message: MESSAGES.lang }]);
    assert.deepStrictEqual(checkReadme(doc("# T", "", "```text", "x", "```")), []);
  });

  test("prompt-in-copy-block: once per shell fence, never in a text fence", () => {
    const text = doc("# T", "", "```bash", "$ npm install", "$ npm test", "```", "", "```text", "ok", "```");
    assert.deepStrictEqual(checkReadme(text), [{ line: 4, rule: "prompt-in-copy-block", message: MESSAGES.prompt }]);
    assert.deepStrictEqual(checkReadme(doc("# T", "", "```text", "$ npm test", "ok", "```")), []);
  });

  test("no-shown-result: no result fence and no result comment, against a json fence or a result comment", () => {
    assert.deepStrictEqual(checkReadme(doc("# T", "", "```js", "run();", "```")), [{ line: 3, rule: "no-shown-result", message: MESSAGES.result }]);
    assert.deepStrictEqual(checkReadme(doc("# T", "", "```js", "run();", "```", "", "```json", "{}", "```")), []);
    assert.deepStrictEqual(checkReadme(doc("# T", "", "```js", "const x = run();", "// x -> 2", "```")), []);
  });

  test("placeholder: in prose, not in a fence", () => {
    assert.deepStrictEqual(checkReadme(doc("# T", "", "Set {{NAME}} first.")), [{ line: 3, rule: "placeholder", message: MESSAGES.placeholder }]);
    assert.deepStrictEqual(checkReadme(doc("# T", "", "```text", "{{NAME}}", "```")), []);
  });

  test("link-text: a label that names no destination, in English or Spanish, not a descriptive one", () => {
    const text = doc("# T", "", "Read [here](docs.md).", "Lee [aquí](docs.md).");
    assert.deepStrictEqual(checkReadme(text), [
      { line: 3, rule: "link-text", message: MESSAGES.vague },
      { line: 4, rule: "link-text", message: MESSAGES.vague },
    ]);
    assert.deepStrictEqual(checkReadme(doc("# T", "", "Read [the install guide](docs.md).")), []);
  });

  test("link-text: a label that repeats its URL, whatever its scheme, www or trailing slash, not a named one", () => {
    assert.deepStrictEqual(checkReadme(doc("# T", "", "See [Example.com/docs/](https://www.example.com/docs/).")), [{ line: 3, rule: "link-text", message: MESSAGES.echo }]);
    assert.deepStrictEqual(checkReadme(doc("# T", "", "See [https://example.com/docs](https://example.com/docs).")), [{ line: 3, rule: "link-text", message: MESSAGES.echo }]);
    assert.deepStrictEqual(checkReadme(doc("# T", "", "See [HTTP://WWW.Example.com](https://example.com/).")), [{ line: 3, rule: "link-text", message: MESSAGES.echo }]);
    assert.deepStrictEqual(checkReadme(doc("# T", "", "See [www.example.com](https://example.com).")), [{ line: 3, rule: "link-text", message: MESSAGES.echo }]);
    assert.deepStrictEqual(checkReadme(doc("# T", "", "See the [API reference](https://example.com/docs).")), []);
  });

  test("filler: each word as written, never inside a longer word", () => {
    assert.deepStrictEqual(checkReadme(doc("# T", "", "Simply run it, JUST once.")), [
      { line: 3, rule: "filler", message: "remove or replace 'JUST'" },
      { line: 3, rule: "filler", message: "remove or replace 'Simply'" },
    ]);
    assert.deepStrictEqual(checkReadme(doc("# T", "", "Justify the choice, with simplyfied steps and éjust.")), []);
  });

  test("long-sentence: 26 words, not 25, a code span as one word, and only the first per line", () => {
    assert.deepStrictEqual(checkReadme(doc("# T", "", sentence(26))), [{ line: 3, rule: "long-sentence", message: "26 words; split it" }]);
    assert.deepStrictEqual(checkReadme(doc("# T", "", sentence(25))), []);
    assert.deepStrictEqual(checkReadme(doc("# T", "", `Run \`a b c d e\` ${sentence(23)}`)), []);
    assert.deepStrictEqual(checkReadme(doc("# T", "", `${sentence(27)} ${sentence(30)}`)), [{ line: 3, rule: "long-sentence", message: "27 words; split it" }]);
  });

  test("over-budget: prose over the tier's budget, not tables, headings, badges or fences", () => {
    const lines = [...Array.from({ length: 40 }, () => sentence(10))];
    const over = doc("# T", "", ...lines, "One.");
    assert.deepStrictEqual(checkReadme(over, { tier: "minimal" }), [{ line: 1, rule: "over-budget", message: "401 words of prose against a minimal budget of 400; move a section behind a link" }]);
    assert.deepStrictEqual(checkReadme(over), []);
    assert.deepStrictEqual(checkReadme(over, { tier: "standard" }), []);
    const atBudget = doc("# T", "", ...lines, "", "[![CI](ci.svg)](ci) many words in a badge line", "", "## A heading of several more words", "", "| a table | of words |", "| --- | --- |", "", "```text", "many words inside a fence", "```");
    assert.deepStrictEqual(checkReadme(atBudget, { tier: "minimal" }), []);
  });

  test("CRLF and lone CR line endings give the findings of LF", () => {
    const text = doc("[![CI](ci.svg)](ci)", "# T", "", "Simply read [here](x).", "", "```bash", "$ npm test", "```");
    const lf = checkReadme(text);
    assert.strictEqual(lf.length, 5);
    assert.deepStrictEqual(checkReadme(text.replaceAll("\n", "\r\n")), lf);
    assert.deepStrictEqual(checkReadme(text.replaceAll("\n", "\r")), lf);
  });

  test("a byte order mark before the title is not part of the H1", () => {
    assert.deepStrictEqual(checkReadme(`${String.fromCharCode(0xfeff)}${CLEAN}`), []);
  });
});

describe("CLI", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-readme-check-"));
  const file = (name, content) => {
    fs.writeFileSync(path.join(dir, name), content);
    return path.join(dir, name);
  };
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

  test("exit 0 and 0 findings for a clean draft", () => {
    const run = cli(file("clean.md", CLEAN));
    assert.deepStrictEqual([run.status, run.stdout, run.stderr], [0, "0 findings\n", ""]);
  });

  test("exit 1 with the findings sorted by line, then rule, and their count", () => {
    const run = cli(file("found.md", doc("# T", "", "Simply read [here](x).", "", "```bash", "$ npm test", "```", "", "# Again")));
    assert.strictEqual(run.status, 1);
    assert.strictEqual(run.stdout, [
      "1:h1-count  expected exactly one H1, found 2",
      "3:filler  remove or replace 'Simply'",
      "3:link-text  link text does not name its destination",
      "5:no-shown-result  no block anywhere shows what a reader should see; add expected output, or a comment on the call showing the value it returns",
      "6:prompt-in-copy-block  copyable block contains a `$` prompt; use a text block to show responses",
      "5 findings",
      "",
    ].join("\n"));
  });

  test("one finding is counted in the singular, and --tier takes any case", () => {
    const run = cli("--tier", "MINIMAL", file("one.md", doc("# T", "", ...Array.from({ length: 41 }, () => sentence(10)))));
    assert.deepStrictEqual([run.status, run.stdout], [1, "1:over-budget  410 words of prose against a minimal budget of 400; move a section behind a link\n1 finding\n"]);
  });

  test("exit 2 with the usage line for bad arguments", () => {
    const clean = file("args.md", CLEAN);
    for (const args of [[], [clean, clean], ["--tier", "huge", clean], [clean, "--tier"], ["--json", clean]]) {
      const run = cli(...args);
      assert.deepStrictEqual([run.status, run.stdout, run.stderr], [2, "", USAGE], args.join(" "));
    }
  });

  test("exit 2 for a file it cannot read", () => {
    const missing = path.join(dir, "missing.md");
    const run = cli(missing);
    assert.strictEqual(run.status, 2);
    assert.strictEqual(run.stdout, "");
    assert.ok(run.stderr.startsWith(`readme-check: cannot read ${missing}: `), run.stderr);
  });
});
