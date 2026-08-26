#!/usr/bin/env node
"use strict";

// [Foreman: 085] Host documentation provenance, checked against the live pages.
//
// SCOPE.md makes a profile releasable only when "host documentation provenance
// is current or the affected capability is disabled with an explanation". Every
// adapter states its claims in `docs()` with a URL and a verified date, and the
// date is the only thing standing behind them — a date is a memory, not a
// check. This script is the check: for each documented page, the strings that
// carry the encoded behavior must still be on it.
//
// razor: string presence, NOT content hashes. A hash drifts on every cosmetic
// edit — a reworded heading, a new nav item, a changed code-block theme — and a
// probe that cries drift every week gets ignored, which is worse than no probe.
// The strings below are the load-bearing facts: a filename the adapter reads, a
// configuration key it parses, a number it enforces. Losing one of those is
// real drift; losing a paragraph around it is not.
//
// Deliberately NOT part of `node --test`: it needs the network, and a test
// suite that fails on someone's flaky DNS teaches people to ignore failures.
// It is the manual pre-release step named in the release-gates header.
//
// Usage: node scripts/assay-doc-drift.js
//   exit 0  every page reachable and every guarded string present
//   exit 2  DRIFT — the named profile is blocked for release
//   exit 1  usage error, or a page could not be reached (unreachable is NOT
//           drift: nothing was disproved, so nothing is blocked)

const TIMEOUT_MS = 20000;

// One row per URL. `expect` rows each name the adapter claim they guard, and
// hold the literal(s) that carry it — several alternatives where the page has a
// choice of spellings ("32 KiB" and "32768" are the same fact), any one of
// which counts as present.
const PROBES = [
  {
    profile: "claude-code",
    url: "https://code.claude.com/docs/en/memory.md",
    expect: [
      { claim: "user, project, and local memory files and their load order", any: ["CLAUDE.md"] },
      { claim: "user, project, and local memory files and their load order", any: ["CLAUDE.local.md"] },
      { claim: "user, project, and local memory files and their load order", any: ["~/.claude/CLAUDE.md"] },
      { claim: ".claude/rules/ recursive discovery, symlinks, and paths scoping", any: [".claude/rules"] },
      { claim: ".claude/rules/ recursive discovery, symlinks, and paths scoping", any: ["paths:"] },
      { claim: "@path imports and their recursion depth", any: ["@path", "import"] },
      { claim: "@path imports recurse to a maximum depth of four hops", any: ["four hops", "4 hops"] },
      { claim: "CLAUDE.md above the working directory loads in full at launch", any: ["above the working directory", "walking up the directory tree"] },
      { claim: "~/.claude/rules/ user rules load before project rules", any: ["~/.claude/rules"] },
      { claim: "nested memory in subdirectories loads on demand", any: ["subtree", "subdirector"] },
      // [ADR 2026-08-05 B4/C2] The auto-memory surface and the per-file size guidance.
      { claim: "auto memory lives at ~/.claude/projects/<project>/memory/", any: ["~/.claude/projects"] },
      { claim: "the auto-memory index MEMORY.md loads at conversation start under a read limit", any: ["MEMORY.md"] },
      { claim: "the MEMORY.md read limit is the first 200 lines or 25KB", any: ["25KB"] },
      { claim: "CLAUDE.md size guidance: target under 200 lines per file", any: ["under 200 lines", "200 lines"] },
    ],
  },
  {
    profile: "claude-code",
    url: "https://code.claude.com/docs/en/skills.md",
    expect: [
      { claim: "skill discovery and SKILL.md frontmatter", any: ["SKILL.md"] },
      { claim: "skill discovery and SKILL.md frontmatter", any: [".claude/skills"] },
      { claim: "skill discovery and SKILL.md frontmatter", any: ["description"] },
      // [ADR 2026-08-05 C4] The listing cap is a documented, configurable default.
      { claim: "the skill-listing entry truncates the combined text at 1,536 characters", any: ["1,536", "1536"] },
      { claim: "the listing cap is configurable via skillListingMaxDescChars", any: ["skillListingMaxDescChars"] },
    ],
  },
  {
    // [Foreman: 169] The source that outranks every rule assay grades.
    profile: "claude-code",
    url: "https://code.claude.com/docs/en/output-styles.md",
    expect: [
      { claim: "custom output styles live under .claude/output-styles/ and ~/.claude/output-styles", any: [".claude/output-styles"] },
      { claim: "the active style is the outputStyle settings field", any: ["outputStyle"] },
      { claim: "the terminal writes the selection to .claude/settings.local.json", any: ["settings.local.json"] },
      { claim: "a custom style drops the built-in engineering instructions unless keep-coding-instructions is true", any: ["keep-coding-instructions"] },
      { claim: "the style name comes from the name frontmatter field or the file name", any: ["Name of the output style", "file name"] },
      { claim: "output styles modify the system prompt", any: ["system prompt"] },
      { claim: "the built-in styles are Default, Proactive, Concise, Explanatory and Learning", any: ["Explanatory"] },
      { claim: "a plugin style can force itself on with force-for-plugin", any: ["force-for-plugin"] },
    ],
  },
  {
    profile: "claude-code",
    url: "https://code.claude.com/docs/en/commands.md",
    expect: [
      // [ADR 2026-08-05 C2] The host's own documented CLAUDE.md remedy.
      { claim: "/doctor trims a checked-in CLAUDE.md and migrates the remaining guidance", any: ["/doctor"] },
      { claim: "the /doctor CLAUDE.md trim check requires v2.1.206 or later", any: ["v2.1.206"] },
    ],
  },
  {
    profile: "claude-code",
    url: "https://code.claude.com/docs/en/workflows.md",
    expect: [
      // [ADR 2026-08-05 C5] Saved workflows are an explicit-invocation surface.
      { claim: "saved workflow scripts live in .claude/workflows/", any: [".claude/workflows"] },
      { claim: "workflow example prompts ask to adversarially verify each finding", any: ["adversarially"] },
    ],
  },
  {
    profile: "claude-code",
    url: "https://code.claude.com/docs/en/hooks.md",
    expect: [
      { claim: "hook configuration in settings files", any: ["settings.json"] },
      { claim: "hook configuration in settings files", any: ["matcher"] },
      { claim: "hook configuration in settings files", any: ["PreToolUse"] },
      { claim: "hook configuration in settings files", any: ["PostToolUse"] },
      { claim: "hooks require a trusted workspace, which no static read can confirm", any: ["workspace trust"] },
    ],
  },
  {
    profile: "claude-code",
    url: "https://code.claude.com/docs/en/sub-agents.md",
    expect: [
      { claim: "subagent definitions in .claude/agents/", any: [".claude/agents"] },
    ],
  },
  {
    profile: "codex",
    url: "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
    expect: [
      { claim: "per-directory selection order is AGENTS.override.md, AGENTS.md, then configured fallback names", any: ["AGENTS.override.md"] },
      { claim: "per-directory selection order is AGENTS.override.md, AGENTS.md, then configured fallback names", any: ["AGENTS.md"] },
      { claim: "project_doc_max_bytes caps the COMBINED size of the instruction chain", any: ["project_doc_max_bytes"] },
      { claim: "the default combined cap is 32 KiB", any: ["32 KiB", "32768", "32,768"] },
      { claim: "project_doc_fallback_filenames names extra candidates", any: ["project_doc_fallback_filenames"] },
      { claim: "CODEX_HOME relocates the Codex home directory, which is where config.toml lives", any: ["CODEX_HOME"] },
    ],
  },
  {
    profile: "codex",
    url: "https://learn.chatgpt.com/docs/build-skills",
    expect: [
      { claim: "repository skills live in `.agents/skills`", any: [".agents/skills"] },
      { claim: "user skills live in $HOME/.agents/skills and admin skills in /etc/codex/skills", any: ["/etc/codex/skills"] },
      { claim: "a skill is a directory holding a required SKILL.md", any: ["SKILL.md"] },
      { claim: "the optional `agents/openai.yaml` sidecar carries interface metadata and policy", any: ["agents/openai.yaml", "openai.yaml"] },
      { claim: "allow_implicit_invocation false switches implicit routing off", any: ["allow_implicit_invocation"] },
      { claim: "the initial skill list uses at most 2% of the context window", any: ["2%"] },
      { claim: "…or 8,000 characters when the context window is unknown", any: ["8,000", "8000"] },
    ],
  },
  {
    profile: "codex",
    url: "https://learn.chatgpt.com/docs/hooks",
    expect: [
      { claim: "hooks are configured in hooks.json and in inline [hooks] tables in config.toml", any: ["hooks.json"] },
      { claim: "hooks are configured in hooks.json and in inline [hooks] tables in config.toml", any: ["[hooks]"] },
      { claim: "hooks are configured in hooks.json and in inline [hooks] tables in config.toml", any: ["config.toml"] },
      { claim: "a higher-precedence layer does not replace a lower one", any: ["loads all matching hooks"] },
      { claim: "project-local hooks load only when the project .codex layer is trusted", any: ["Project-local hooks load only when the project"] },
      { claim: "trust is recorded against a hook definition's hash, and a changed definition is skipped until trusted", any: ["records trust against the hook"] },
      { claim: "trust is recorded against a hook definition's hash, and a changed definition is skipped until trusted", any: ["skipped until trusted"] },
      { claim: "allow_managed_hooks_only skips hooks from user, project, session, and plugin sources", any: ["allow_managed_hooks_only"] },
      { claim: "managed hooks come from requirements.toml and other managed layers", any: ["requirements.toml"] },
    ],
  },
  {
    profile: "codex",
    url: "https://developers.openai.com/plugins/build/plugins",
    expect: [
      { claim: ".codex-plugin/plugin.json is the plugin manifest", any: [".codex-plugin/plugin.json"] },
      { claim: "plugin-bundled hooks default to hooks/hooks.json under the plugin root", any: ["hooks/hooks.json"] },
    ],
  },
];

async function probe(row) {
  let text;
  try {
    const res = await fetch(row.url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { status: "UNREACHABLE", reason: "HTTP " + res.status };
    text = await res.text();
  } catch (err) {
    return { status: "UNREACHABLE", reason: err.message };
  }
  const missing = row.expect.filter((e) => !e.any.some((s) => text.includes(s)));
  return missing.length
    ? { status: "DRIFT", missing }
    : { status: "OK", guarded: new Set(row.expect.map((e) => e.claim)).size };
}

async function main() {
  if (process.argv.length > 2) {
    process.stderr.write("Usage: node scripts/assay-doc-drift.js\n" +
      "Checks every host-profile documentation claim against the live page.\n");
    process.exit(1);
  }

  const drifted = new Map(); // profile -> [{url, missing}]
  const unreachable = [];
  for (const row of PROBES) {
    const result = await probe(row);
    const head = result.status.padEnd(11) + " " + row.url + "  [" + row.profile + "]";
    if (result.status === "OK") {
      process.stdout.write(head + " — " + result.guarded + " claim(s) guarded\n");
    } else if (result.status === "UNREACHABLE") {
      unreachable.push(row.url);
      process.stdout.write(head + " — " + result.reason + "\n");
    } else {
      if (!drifted.has(row.profile)) drifted.set(row.profile, []);
      drifted.get(row.profile).push(row.url);
      process.stdout.write(head + "\n");
      for (const e of result.missing) {
        process.stdout.write("            missing " + JSON.stringify(e.any.join(" | ")) +
          " — guards: " + e.claim + "\n");
      }
    }
  }

  if (drifted.size) {
    process.stdout.write("\nDRIFT — the documentation no longer states a fact this analyzer encodes.\n");
    for (const [profile, urls] of drifted) {
      process.stdout.write("  BLOCKED FOR RELEASE: profile `" + profile + "` (" + urls.length + " page(s))\n");
    }
    process.stdout.write("  SCOPE.md: a profile is releasable only when host documentation provenance is\n" +
      "  current, or the affected capability is disabled with an explanation. Re-read the\n" +
      "  page, correct the adapter's docs() claim and its verified date, or disable it.\n");
    process.exit(2);
  }
  if (unreachable.length) {
    process.stdout.write("\nUNREACHABLE is not drift: " + unreachable.length + " page(s) could not be read, so\n" +
      "nothing was disproved and no profile is blocked. Re-run when the network is back.\n");
    process.exit(1);
  }
  process.stdout.write("\nOK — every documented claim is still stated on its page.\n");
}

main();
