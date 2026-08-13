#!/usr/bin/env node
"use strict";

// The single dispatch point. `hooks.json` registers exactly one shell-free
// entry per event and passes the event name as argv[1], so PreToolUse[Bash] and
// PostToolUse[Edit|Write] cost one node process each and every guard for that
// event is evaluated inside it — no chaining, no second spawn (jig-brief §3).
//
// Two spawns ride every Bash and every Edit/Write in every repo where jig is
// installed (sign-off S2). That is why the two instant-exit checks happen
// before stdin is read and before the config is parsed: in a repository that
// never ran the interview, this file does two `existsSync` calls and stops.

const lib = require("./jig-lib");

function main(argv) {
  const event = argv[0];
  if (!lib.HOOK_RUNNERS.includes(event)) return;
  const root = process.cwd();
  if (lib.isOff(root) || !lib.isConfigured(root)) return;

  const out = lib.runEvent(root, event, lib.readInput(), (line) => process.stderr.write(line + "\n"));
  // The host reads its control fields off the top level, and runEvent puts one
  // there only for a guard that armed: its own row asked to, and the proof it
  // recorded still matches the check on disk. Everything else an observing
  // guard has to say stays under the `jig` key, where nothing acts on it.
  process.stdout.write(JSON.stringify(out) + "\n");
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    // A guard runner that throws must never take the tool call with it.
    process.stderr.write("jig: runner failed open (" + err.message + ")\n");
  }
  process.exitCode = 0;
}

module.exports = { main };
