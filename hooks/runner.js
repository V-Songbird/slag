#!/usr/bin/env node
"use strict";

// One Node handler per event, launched by Codex's command-hook executor.
// Discover the nearest configured Jig root without spawning git. Unconfigured
// repositories and an explicit off switch return before stdin/config parsing.
// Codex payload translation lives separately from the proven guard evaluator.

const lib = require("./jig-lib");
const codex = require("./codex");

function main(argv) {
  const event = argv[0];
  // Stop events and the shell witness carry no guard.
  if (!lib.HOOK_EVENTS.includes(event)) return;
  const root = codex.projectRoot(process.cwd());
  if (!root || lib.isOff(root) || !lib.isConfigured(root)) return;

  const out = codex.runEvent(lib, root, event, lib.readInput(), (line) => process.stderr.write(line + "\n"));
  // Codex validates hook output and rejects unknown top-level fields. The
  // engine's diagnostic object is available only to explicitly local probes.
  const wire = argv.includes("--diagnostic") ? out : Object.fromEntries(
    Object.entries(out).filter(([key]) => ["hookSpecificOutput", "systemMessage", "decision", "reason"].includes(key)));
  process.stdout.write(JSON.stringify(wire) + "\n");
}

function cli(argv) {
  try {
    main(argv);
  } catch (err) {
    // A guard runner that throws must never take the tool call with it.
    process.stderr.write("jig: runner failed open (" + err.message + ")\n");
  }
  process.exitCode = 0;
}

if (require.main === module) cli(process.argv.slice(2));

module.exports = { main, cli };
