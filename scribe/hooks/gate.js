#!/usr/bin/env node
"use strict";

// scribe — UserPromptSubmit gate.
//
// Judges nothing itself: it decides WHETHER the judgment rubric rides this
// prompt, then emits the static, byte-capped rubric as additionalContext. The
// ambiguity call is the model's; everything this
// file does is mechanical and stands in the way of exactly one thing — paying
// the rubric's tax on a prompt that should never be judged.
//
// Mechanical stand-downs, in order, all silent:
//   - SCRIBE_OFF=1 or .scribe/off      (kill switch)
//   - empty prompt                     (nothing to judge)
//   - slash-prefixed prompt            (commands are precise by construction)
//   - permission_mode bypassPermissions (unattended run — never stall a loop)
//   - config off:true                  (kill-switch mirror)
//   - fatigue cap reached              (logged — the cap is a decision)
//   - wave-off prompt after an ask     (logged — "just do it" is honored)
//
// Anything else is judged: one ledger line records that the rubric went out,
// and the rubric goes out. Unattended contexts no field can reveal are the
// rubric's own first stand-down clause — the model can tell; this file cannot.

const lib = require("./scribe-lib");

function main() {
  const payload = lib.readInput();
  const root = lib.projectRoot(payload.cwd);
  if (lib.isOff(root)) return;

  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (!prompt.trim()) return;
  if (/^\s*\//.test(prompt)) return;
  if (payload.permission_mode === "bypassPermissions") return;

  const cfg = lib.readConfig(root);
  for (const w of cfg.warnings) process.stderr.write("scribe: " + w + "\n");
  if (cfg.off) return;

  const session = typeof payload.session_id === "string" ? payload.session_id : null;
  const rounds = lib.askedCount(root, session);

  if (lib.isWaveOff(prompt) && rounds > 0) {
    lib.appendLedger(root, { session, kind: "waved-off", source: "mechanical", via: "prompt" });
    return;
  }

  if (cfg.fatigueCap > 0 && rounds >= cfg.fatigueCap) {
    lib.appendLedger(root, {
      session, kind: "judged", source: "mechanical", bar: cfg.bar,
      capped: true, prompt: prompt.slice(0, lib.PROMPT_KEEP),
    });
    return;
  }

  lib.appendLedger(root, {
    session, kind: "judged", source: "mechanical", bar: cfg.bar,
    prompt: prompt.slice(0, lib.PROMPT_KEEP),
  });
  process.stdout.write(lib.emission(cfg.bar));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // The gate must never take a turn with it.
    process.stderr.write("scribe: gate failed open (" + err.message + ")\n");
  }
  process.exitCode = 0;
}

module.exports = { main };
