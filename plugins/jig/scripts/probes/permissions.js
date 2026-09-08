#!/usr/bin/env node
"use strict";

// The old probe measured Claude settings/permissions. Its result cannot grant
// a Codex capability. Keep the entry point explicit for existing references.
function main() {
  process.stderr.write("jig: permission-settings writes are unsupported in this Codex port. The retired Claude probe cannot enable them. Run scripts/probes/codex-host.js to measure supported Codex hook delivery; that probe grants no settings capability.\n");
  process.exitCode = 1;
}
if (require.main === module) main();
module.exports = { main };
