"use strict";

// The import fixer against real files on disk: what it rewrites after a move,
// and what it deliberately leaves alone.

const { test, describe, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { updateImports } = require("../scripts/update-imports.js");

const CLI = path.join(__dirname, "..", "scripts", "update-imports.js");

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// Write the files, then perform the move the fixer is told about.
function moved(files, from, to) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anneal-imports-"));
  created.push(root);
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const target = path.join(root, to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(path.join(root, from), target);
  return root;
}

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

describe("references from other files", () => {
  test("a relative import of the moved file is re-pointed", () => {
    const root = moved({
      "src/utils/format.js": "export const f = 1;\n",
      "src/app.js": "import { f } from './utils/format';\n",
    }, "src/utils/format.js", "src/cart/format.js");

    const { updated } = updateImports({ root, from: "src/utils/format.js", to: "src/cart/format.js" });
    assert.deepStrictEqual(updated, [{ file: "src/app.js", changed: 1 }]);
    assert.strictEqual(read(root, "src/app.js"), "import { f } from './cart/format';\n");
  });

  test("require, dynamic import and re-export are covered", () => {
    const root = moved({
      "src/a.js": "const x = require('./old');\n",
      "src/b.js": "const y = await import('./old');\n",
      "src/c.js": "export * from './old';\nexport { z } from './old';\n",
      "src/old.js": "",
    }, "src/old.js", "src/deep/new.js");

    updateImports({ root, from: "src/old.js", to: "src/deep/new.js" });
    assert.strictEqual(read(root, "src/a.js"), "const x = require('./deep/new');\n");
    assert.strictEqual(read(root, "src/b.js"), "const y = await import('./deep/new');\n");
    assert.strictEqual(read(root, "src/c.js"), "export * from './deep/new';\nexport { z } from './deep/new';\n");
  });

  test("an extension is kept when the specifier carried one, and not added when it did not", () => {
    const root = moved({
      "src/with.js": "import './old.js';\n",
      "src/without.js": "import './old';\n",
      "src/old.js": "",
    }, "src/old.js", "lib/new.js");

    updateImports({ root, from: "src/old.js", to: "lib/new.js" });
    assert.strictEqual(read(root, "src/with.js"), "import '../lib/new.js';\n");
    assert.strictEqual(read(root, "src/without.js"), "import '../lib/new';\n");
  });

  test("explicit extensions distinguish modules and assets with the same basename", () => {
    const root = moved({
      "src/app.ts": [
        "import { value } from './old.js';",
        "const settings = require('./old.json');",
        "import './old.css';",
        "export { Model } from './old.ts';",
        "const module = import('./old.mjs');",
        "",
      ].join("\n"),
      "src/old.js": "export const value = 1;\n",
      "src/old.json": "{}\n",
      "src/old.css": "body {}\n",
      "src/old.ts": "export type Model = string;\n",
      "src/old.mjs": "export const other = 2;\n",
    }, "src/old.js", "lib/new.js");

    const { updated } = updateImports({ root, from: "src/old.js", to: "lib/new.js" });
    assert.strictEqual(read(root, "src/app.ts"), [
      "import { value } from '../lib/new.js';",
      "const settings = require('./old.json');",
      "import './old.css';",
      "export { Model } from './old.ts';",
      "const module = import('./old.mjs');",
      "",
    ].join("\n"));
    assert.deepStrictEqual(updated, [{ file: "src/app.ts", changed: 1 }]);
  });

  test("extensionless imports still follow every supported source extension", () => {
    for (const extension of ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte"]) {
      const from = `src/old.${extension}`;
      const to = `lib/new.${extension}`;
      const root = moved({
        "src/app.js": "import './old';\n",
        [from]: "",
      }, from, to);

      updateImports({ root, from, to });
      assert.strictEqual(read(root, "src/app.js"), "import '../lib/new';\n", extension);
    }
  });

  test("an extensionless require still follows a moved JSON module", () => {
    const root = moved({
      "src/app.js": "const settings = require('./old');\n",
      "src/old.json": "{}\n",
    }, "src/old.json", "lib/settings.json");

    const { updated } = updateImports({ root, from: "src/old.json", to: "lib/settings.json" });
    assert.strictEqual(read(root, "src/app.js"), "const settings = require('../lib/settings');\n");
    assert.deepStrictEqual(updated, [{ file: "src/app.js", changed: 1 }]);
  });

  test("a path that only looks like the moved one is untouched", () => {
    const root = moved({
      "src/app.js": "import './format-date';\nimport './utils/formatter';\n",
      "src/format.js": "",
    }, "src/format.js", "src/cart/format.js");

    const { updated } = updateImports({ root, from: "src/format.js", to: "src/cart/format.js" });
    assert.deepStrictEqual(updated, []);
  });

  test("package specifiers and aliases are left for the caller to handle", () => {
    const root = moved({
      "src/app.js": "import 'lodash';\nimport '@/old';\nimport 'old';\n",
      "src/old.js": "",
    }, "src/old.js", "src/new.js");

    assert.deepStrictEqual(updateImports({ root, from: "src/old.js", to: "src/new.js" }).updated, []);
  });

  test("build and dependency folders are not walked", () => {
    const root = moved({
      "node_modules/pkg/index.js": "import '../../src/old';\n",
      "dist/bundle.js": "import '../src/old';\n",
      "src/old.js": "",
    }, "src/old.js", "src/new.js");

    assert.deepStrictEqual(updateImports({ root, from: "src/old.js", to: "src/new.js" }).updated, []);
  });
});

describe("the moved file itself", () => {
  test("its own relative imports are re-anchored to the new folder", () => {
    const root = moved({
      "src/old.js": "import './sibling';\nimport '../config';\n",
      "src/sibling.js": "",
      "config.js": "",
    }, "src/old.js", "src/cart/new.js");

    updateImports({ root, from: "src/old.js", to: "src/cart/new.js" });
    assert.strictEqual(read(root, "src/cart/new.js"), "import '../sibling';\nimport '../../config';\n");
  });

  test("a rename inside the same folder leaves its imports alone", () => {
    const root = moved({
      "src/old.js": "import './sibling';\n",
      "src/sibling.js": "",
    }, "src/old.js", "src/renamed.js");

    assert.deepStrictEqual(updateImports({ root, from: "src/old.js", to: "src/renamed.js" }).updated, []);
    assert.strictEqual(read(root, "src/renamed.js"), "import './sibling';\n");
  });
});

describe("CLI", () => {
  test("it names each file it rewrote and how many specifiers it changed", () => {
    const root = moved({
      "src/app.js": "import './old';\nimport './old';\n",
      "src/old.js": "",
    }, "src/old.js", "src/new.js");

    const run = spawnSync(process.execPath, [CLI, "--root", root, "--from", "src/old.js", "--to", "src/new.js"], { encoding: "utf8" });
    assert.strictEqual(run.status, 0);
    assert.match(run.stdout, /updated 1 file\n\s+src\/app\.js \(2\)/);
    assert.strictEqual(read(root, "src/app.js"), "import './new';\nimport './new';\n");
  });

  test("a missing --from or --to is a usage error, not a no-op", () => {
    const run = spawnSync(process.execPath, [CLI, "--from", "a.js"], { encoding: "utf8" });
    assert.strictEqual(run.status, 2);
    assert.match(run.stderr, /usage:/);
  });
});
