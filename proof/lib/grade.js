"use strict";

// Tier-1 deterministic graders — no model call. A grader scores a run against
// the arm's post-run checkout dir and the agent's response text. Absence
// graders (`*_absent`) treat a missing file as "no work done" (score 0), never
// as compliant absence — they must be paired with a validity gate so a session
// that did nothing cannot be rewarded.

const fs = require("fs");
const path = require("path");

function gradeOne(grader, ctx) {
  const readFile = (rel) => {
    const full = path.join(ctx.dir, rel);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf-8") : null;
  };
  switch (grader.type) {
    case "file_exists":
      return fs.existsSync(path.join(ctx.dir, grader.path)) ? 1 : 0;
    case "file_absent":
      return fs.existsSync(path.join(ctx.dir, grader.path)) ? 0 : 1;
    case "file_regex": {
      const content = readFile(grader.path);
      return content !== null && new RegExp(grader.pattern, grader.flags || "m").test(content) ? 1 : 0;
    }
    case "file_regex_absent": {
      const content = readFile(grader.path);
      if (content === null) return 0; // missing file is absence of work, not compliance
      return new RegExp(grader.pattern, grader.flags || "m").test(content) ? 0 : 1;
    }
    case "response_regex":
      return new RegExp(grader.pattern, grader.flags || "m").test(ctx.response || "") ? 1 : 0;
    case "response_regex_absent":
      return new RegExp(grader.pattern, grader.flags || "m").test(ctx.response || "") ? 0 : 1;
    case "composite": {
      const scores = grader.children.map((c) => gradeOne(c, ctx));
      if (grader.op === "or") return Math.max(...scores);
      return Math.min(...scores); // default: and
    }
    default:
      throw new Error("Unknown grader type: " + grader.type);
  }
}

// Score a list of graders; the run passes iff every grader passes (min).
function grade(graders, ctx) {
  const detail = graders.map((g) => ({ type: g.type, path: g.path, pattern: g.pattern, score: gradeOne(g, ctx) }));
  return { score: detail.length ? Math.min(...detail.map((d) => d.score)) : 0, detail };
}

module.exports = { gradeOne, grade };
