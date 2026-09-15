"use strict";

// Codex's hook transport is not its model-facing tool API. Shells arrive as
// Bash/command; apply_patch arrives as a complete patch in command. Keep this
// translation outside the proven, host-independent detector evaluator.
const fs = require("fs");
const path = require("path");

function projectRoot(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".jig", "off")) ||
        fs.existsSync(path.join(dir, ".jig", "config.json"))) return dir;
    // Do not borrow a parent repository's policy for an unconfigured nested
    // checkout. A linked worktree's .git file is a boundary too.
    if (fs.existsSync(path.join(dir, ".git"))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function inside(root, file) {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

function scopedPath(root, cwd, name) {
  const file = path.resolve(cwd, name);
  if (!inside(root, file)) throw new Error("patch path is outside this Jig repository: " + name);
  // Check existing parents as well: an added file beneath a symlink can leave
  // the repository even when its spelling is repo-relative.
  let existing = file;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (!inside(fs.realpathSync(root), fs.realpathSync(existing))) {
    throw new Error("patch path resolves outside this Jig repository: " + name);
  }
  return file;
}

function parsePatch(command) {
  if (typeof command !== "string") throw new Error("apply_patch has no string command");
  const lines = command.trim().replace(/\r\n/g, "\n").split("\n");
  if (["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines[0]) && lines.at(-1).endsWith("EOF")) { lines.shift(); lines.pop(); }
  if (lines.shift()?.trim() !== "*** Begin Patch" || lines.pop()?.trim() !== "*** End Patch") {
    throw new Error("apply_patch has an unrecognized patch envelope");
  }
  const files = [];
  let i = 0;
  while (i < lines.length) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++]);
    if (!header) throw new Error("unrecognized apply_patch file header");
    const file = { kind: header[1], path: header[2], hunks: [] };
    if (file.kind === "Add") {
      const content = [];
      while (i < lines.length && !lines[i].startsWith("*** ")) {
        if (!lines[i].startsWith("+")) throw new Error("unrecognized added-file line");
        content.push(lines[i++].slice(1));
      }
      file.content = content.join("\n") + (content.length ? "\n" : "");
    } else if (file.kind === "Update") {
      if (lines[i] && lines[i].startsWith("*** Move to: ")) file.move = lines[i++].slice(13);
      while (i < lines.length && !/^\*\*\* (?:Add|Update|Delete) File: /.test(lines[i])) {
        let heading = null;
        if (lines[i] === "@@" || lines[i].startsWith("@@ ")) {
          heading = lines[i++].slice(3) || null;
        } else if (file.hunks.length) {
          throw new Error("unrecognized update hunk header");
        }
        const before = [], after = [];
        let eof = false;
        while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("*** ")) {
          const line = lines[i++];
          if (line.startsWith(" ")) { before.push(line.slice(1)); after.push(line.slice(1)); }
          else if (line.startsWith("-")) before.push(line.slice(1));
          else if (line.startsWith("+")) after.push(line.slice(1));
          else if (line === "") { before.push(""); after.push(""); }
          else throw new Error("unrecognized update hunk line");
        }
        if (lines[i] === "*** End of File") { eof = true; i++; }
        if (!before.length && !after.length) throw new Error("empty update hunk");
        file.hunks.push({ before, after, heading, eof });
      }
      if (!file.hunks.length) throw new Error("update has no hunks");
    }
    files.push(file);
  }
  return files;
}

// Search and replacement ordering follow OpenAI's apply-patch implementation:
// openai/codex rust-v0.153.4, apply-patch/src/{seek_sequence,file_update}.rs.
// The default NormalizeToLf mode is reproduced. Prefer an exact
// match anywhere after the cursor before relaxing whitespace or punctuation;
// repeated contexts select the first match, as the native tool does.
function normalizeContext(line) {
  return line.trim().replace(/[‐-―−]/g, "-")
    .replace(/[‘-‛]/g, "'").replace(/[“-‟]/g, '"')
    .replace(/[  -   　]/g, " ");
}
function seekSequence(lines, pattern, start, eof) {
  if (!pattern.length) return start;
  if (pattern.length > lines.length) return -1;
  const begin = eof ? lines.length - pattern.length : start;
  for (const normalize of [(line) => line, (line) => line.trimEnd(), (line) => line.trim(), normalizeContext]) {
    for (let at = begin; at <= lines.length - pattern.length; at++) {
      if (pattern.every((line, offset) => normalize(lines[at + offset]) === normalize(line))) return at;
    }
  }
  return -1;
}
function applyHunks(text, hunks, reverse) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const replacements = [];
  let cursor = 0;
  for (const hunk of hunks) {
    let before = reverse ? hunk.after : hunk.before;
    let after = reverse ? hunk.before : hunk.after;
    if (hunk.heading) {
      const heading = seekSequence(lines, [hunk.heading], cursor, false);
      if (heading === -1) throw new Error("patch context heading was not found");
      cursor = heading + 1;
    }
    if (!before.length) {
      replacements.push({ at: lines.at(-1) === "" ? lines.length - 1 : lines.length, count: 0, after });
      continue;
    }
    let at = seekSequence(lines, before, cursor, hunk.eof);
    if (at === -1 && before.at(-1) === "") {
      before = before.slice(0, -1);
      if (after.at(-1) === "") after = after.slice(0, -1);
      at = seekSequence(lines, before, cursor, hunk.eof);
    }
    if (at === -1) throw new Error("patch context was not found in the source file");
    replacements.push({ at, count: before.length, after });
    cursor = at + before.length;
  }
  replacements.sort((a, b) => a.at - b.at);
  for (const replacement of replacements.reverse()) lines.splice(replacement.at, replacement.count, ...replacement.after);
  if (lines.at(-1) !== "") lines.push("");
  return lines.join("\n");
}

// Keep every independently readable file. One unsupported external path or
// malformed secondary hunk must not erase a proven deny on another file.
function patchFiles(command, problems) {
  if (typeof command !== "string") throw new Error("apply_patch has no string command");
  let lines = command.trim().replace(/\r\n/g, "\n").split("\n");
  if (["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines[0]) && lines.at(-1).endsWith("EOF")) lines = lines.slice(1, -1);
  if (lines.shift()?.trim() !== "*** Begin Patch" || lines.pop()?.trim() !== "*** End Patch") throw new Error("apply_patch has an unrecognized patch envelope");
  const sections = lines.join("\n").split(/(?=^\*\*\* [A-Za-z]+ File: )/m).filter((section) => section.trim());
  const files = [];
  for (const section of sections) {
    try { files.push(...parsePatch("*** Begin Patch\n" + section.replace(/\n$/, "") + "\n*** End Patch")); }
    catch (error) { problems.push(error.message); }
  }
  return files;
}

function patchViews(root, cwd, event, command, problems = []) {
  return patchFiles(command, problems).flatMap((file) => {
    try {
    const source = scopedPath(root, cwd, file.path);
    const destination = file.move ? scopedPath(root, cwd, file.move) : source;
    let before, after;
    if (file.kind === "Add") {
      // Codex can overwrite an existing path with Add File. Those old bytes
      // are removal evidence too; treating every Add as a new file is a bypass.
      before = event === "PreToolUse" && fs.existsSync(source) ? fs.readFileSync(source, "utf-8") : "";
      after = file.content;
    }
    else if (file.kind === "Delete") {
      if (event !== "PreToolUse") throw new Error("deleted file has no before text at PostToolUse: " + file.path);
      before = fs.readFileSync(source, "utf-8"); after = "";
    } else if (event === "PreToolUse") {
      before = fs.readFileSync(source, "utf-8"); after = applyHunks(before, file.hunks, false);
    } else {
      after = fs.readFileSync(destination, "utf-8"); before = applyHunks(after, file.hunks, true);
    }
    const destinationBefore = source !== destination && event === "PreToolUse"
      ? (fs.existsSync(destination) ? fs.readFileSync(destination, "utf-8") : "") : before;
    const views = [{ file_path: destination, old_string: destinationBefore, new_string: after }];
    // Moving a file out of a guarded zone removes its contents from that zone.
    // Inspect both names, while keeping the destination's introduction counts.
    if (source !== destination) views.unshift({ file_path: source, old_string: before, new_string: "" });
    return views;
    } catch (error) { problems.push(file.path + ": " + error.message); return []; }
  });
}

function combine(event, outputs) {
  const guards = outputs.flatMap((out) => out.jig.guards || []);
  const out = { jig: { event, mode: guards.some((g) => g.mode === "armed") ? "armed" : "observe",
    decision: guards.some((g) => g.decision === "deny") ? "deny" :
      guards.some((g) => g.decision === "would-deny") ? "would-deny" : "pass", guards } };
  const denied = outputs.find((result) => result.hookSpecificOutput?.permissionDecision === "deny" || result.decision === "block");
  if (denied?.hookSpecificOutput) out.hookSpecificOutput = { ...denied.hookSpecificOutput };
  if (denied?.decision) { out.decision = denied.decision; out.reason = denied.reason; }
  const teaching = outputs.find((result) => result.hookSpecificOutput?.additionalContext);
  if (teaching) out.hookSpecificOutput = { ...out.hookSpecificOutput, hookEventName: event,
    additionalContext: teaching.hookSpecificOutput.additionalContext };
  return out;
}

function runEvent(lib, root, event, payload, warn) {
  if (payload.tool_name !== "apply_patch") {
    const out = lib.runEvent(root, event, payload, warn,
      { runtime: "codex", host: payload.hook_event_name === event ? "codex" : undefined });
    // Stop's additionalContext is not a supported Codex context channel.
    // A warning preserves Jig's advisory completion signal without creating a
    // new turn, blocking completion, or implying that the model saw it.
    if (lib.STOP_EVENTS.includes(event) && out.jig.stale) {
      out.systemMessage = out.jig.stale;
      delete out.hookSpecificOutput;
    }
    return out;
  }
  try {
    const cwd = typeof payload.cwd === "string" ? payload.cwd : root;
    const problems = [];
    const views = patchViews(root, cwd, event, payload.tool_input?.command, problems);
    const out = combine(event, views.map((input) => lib.runEvent(root, event,
      { ...payload, tool_name: "Edit", tool_input: input }, warn, { runtime: "codex", ledgerTool: "apply_patch", host: payload.hook_event_name === event ? "codex" : undefined })));
    if (problems.length) {
      const problem = "apply_patch was not fully inspected: " + problems.join("; ");
      warn("jig: " + problem);
      out.jig.failedOpen = problem;
      out.systemMessage = "jig: " + problem;
      try { lib.appendLedger(root, { session: payload.session_id || null, actor: "jig", tool: "apply_patch", guardId: null, decision: "pass", failedOpen: problem }); }
      catch { /* A known deny still stands when a gap cannot be recorded. */ }
    }
    return out;
  } catch (err) {
    const problem = "apply_patch was not inspected: " + err.message;
    warn("jig: " + problem);
    try { lib.appendLedger(root, { ts: new Date().toISOString(), session: payload.session_id || null,
      actor: "jig", tool: "apply_patch", guardId: null, decision: "pass", failedOpen: problem }); }
    catch { /* The hook remains advisory when its evidence cannot be recorded. */ }
    return { systemMessage: "jig: " + problem, jig: { event, decision: "pass", guards: [], failedOpen: problem } };
  }
}

module.exports = { projectRoot, parsePatch, seekSequence, applyHunks, patchViews, combine, runEvent };
