#!/usr/bin/env node
"use strict";

// Fake `claude` binary for offline tests. Reads the prompt from stdin, ignores
// CLI args, and emits a canned `--output-format json` envelope shaped like the
// real one. Behavior is chosen by PROOF_FAKE_MODE:
//
//   ok        success envelope, exit 0
//   exit1     success-shaped envelope but non-zero exit
//   iserror   is_error:true envelope (invalid-model style), exit 1
//   malformed non-JSON on stdout, exit 0
//   timeout   never respond (exercises the adapter's kill timer)
//   pipeline  act like the real gold cell: always write src/num.js's clamp;
//             write docs/api.md's clamp ONLY when the trigger rule is present in
//             the arm's CLAUDE.md — so baseline scores 0 and treatment scores 1.

const fs = require("fs");
const path = require("path");

const mode = process.env.PROOF_FAKE_MODE || "ok";

function envelope(extra) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    result: "Done.",
    session_id: "fake",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...extra,
  });
}

let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => run());
// stdin may already be ended in some spawn paths
process.stdin.on("error", () => run());

let ran = false;
function run() {
  if (ran) return;
  ran = true;

  if (mode === "timeout") { setTimeout(() => {}, 60000); return; } // hang until the adapter kills us

  if (mode === "malformed") {
    process.stdout.write("this is not json {oops");
    process.exit(0);
  }

  if (mode === "iserror") {
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", is_error: true,
      api_error_status: 404, num_turns: 0, result: "", total_cost_usd: 0,
      terminal_reason: "api_error",
    }));
    process.exit(1);
  }

  if (mode === "exit1") {
    process.stdout.write(envelope());
    process.exit(1);
  }

  if (mode === "pipeline") {
    const cwd = process.cwd();
    let claudeMd = "";
    try { claudeMd = fs.readFileSync(path.join(cwd, "CLAUDE.md"), "utf-8"); } catch { /* none */ }
    const src = path.join(cwd, "src", "num.js");
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, "\"use strict\";\n\nfunction clamp(n, min, max) { return Math.min(Math.max(n, min), max); }\n\nmodule.exports = { clamp };\n");
    // Only "follow" the trigger duty when it is actually present.
    if (/list it in docs\/api\.md/i.test(claudeMd)) {
      const docs = path.join(cwd, "docs", "api.md");
      fs.mkdirSync(path.dirname(docs), { recursive: true });
      fs.writeFileSync(docs, "# API reference\n\nExported functions:\n\n- clamp(n, min, max)\n");
    }
    process.stdout.write(envelope({ result: "Implemented clamp." }));
    process.exit(0);
  }

  // default: ok
  process.stdout.write(envelope());
  process.exit(0);
}
