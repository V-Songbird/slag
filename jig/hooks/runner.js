#!/usr/bin/env node
"use strict";

// The single dispatch point. `hooks.json` registers exactly one shell-free
// entry per event and passes the event name as argv[1], so each event costs one
// node process and every guard for that event is evaluated inside it — no
// chaining, no second spawn.
//
// Two spawns ride every Bash — one before it for the guards, one after it to
// witness a verification run — and one rides every Edit/Write, in every repo
// where jig is installed. That is why the two instant-exit checks happen
// before stdin is read and before the config is parsed: in a repository that
// never ran the interview, this file does two `existsSync` calls and stops.
//
// Codex reaches this same file through `codex-hooks.json`, which adds
// `--runtime codex`. Nothing else tells the two hosts apart: both export
// CLAUDE_PLUGIN_ROOT to a hook. The Codex half finds the nearest configured
// root from the tool's working directory, lets `codex.js` translate a patch
// into the views the evaluator reads, and prints only the top-level fields
// Codex accepts, because it rejects a whole reply over one it does not know.

const lib = require("./jig-lib");

const CODEX_FIELDS = ["hookSpecificOutput", "systemMessage", "decision", "reason"];

function main(argv) {
  const event = argv[0];
  // The dispatchable set, not the set a guard may name: Stop and the two
  // witness events run here and carry no guard at all.
  if (!lib.HOOK_EVENTS.includes(event)) return;
  const at = argv.indexOf("--runtime");
  const runtime = at === -1 ? "claude" : argv[at + 1];
  if (runtime === "codex") return codexMain(event, argv);
  if (runtime !== "claude") {
    process.stderr.write("jig: unknown --runtime " + JSON.stringify(runtime) + "; no guard ran for this call\n");
    return;
  }
  const root = process.cwd();
  if (lib.isOff(root) || !lib.isConfigured(root)) return;

  const out = lib.runEvent(root, event, lib.readInput(), (line) => process.stderr.write(line + "\n"));
  // The host reads its control fields off the top level, and runEvent puts a
  // DECIDING one there only for a guard that armed: its own row asked to, and
  // the proof it recorded still matches the check on disk. An observing guard
  // reaches the top level too, through `hookSpecificOutput.additionalContext`,
  // and only where its own row set `teach` — that channel refuses nothing.
  // Everything else it has to say stays under the `jig` key, where nothing acts
  // on it.
  process.stdout.write(JSON.stringify(out) + "\n");
}

// Required only on the Codex path, so a Claude Code hook spawn parses nothing
// it never calls into.
function codexMain(event, argv) {
  const codex = require("./codex");
  const root = codex.projectRoot(process.cwd());
  if (!root || lib.isOff(root) || !lib.isConfigured(root)) return;
  const out = codex.runEvent(lib, root, event, lib.readInput(), (line) => process.stderr.write(line + "\n"));
  // The diagnostic object is for local probes that ask for it by name.
  const wire = argv.includes("--diagnostic") ? out
    : Object.fromEntries(Object.entries(out).filter(([key]) => CODEX_FIELDS.includes(key)));
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
