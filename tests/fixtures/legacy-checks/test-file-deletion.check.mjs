// jig:owned — generated from jig's test-file-deletion check template.
//
// A test file staged for deletion. This is the only check here that does not
// read source: a deletion leaves nothing to read, so the evidence is the
// staged diff and nothing else. That is also why the agent-side guard for this
// class is a command pattern rather than an edit watcher — an edit hook never
// sees a file go away.
//
// The command and the path patterns below are the catalogue's, and jig's tests
// refuse to ship a copy that has drifted from them.

export const id = "test-file-deletion";
export const title = "A test file staged for deletion";
export const severity = "safety";
export const confidence = "deterministic";

export const command = ["git", "diff", "--cached", "--diff-filter=D", "--name-only"];
export const paths = [
  "**/*.test.js", "**/*.test.mjs", "**/*.test.ts", "**/*.spec.js", "**/*.spec.ts",
  "**/tests/**", "**/__tests__/**",
];

// The deleted paths come from git, not from the working tree, so the driver's
// own file walk has nothing to match them against.
function matches(rel, globs) {
  return globs.some((g) => {
    let out = "";
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === "*" && g[i + 1] === "*") {
        out += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += g[i + 2] === "/" ? 2 : 1;
      } else if (c === "*") {
        out += "[^/]*";
      } else if (c === "?") {
        out += "[^/]";
      } else {
        out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
    }
    return new RegExp("^" + out + "$", "i").test(rel);
  });
}

export function check(ctx) {
  const staged = ctx.git(command.slice(1));
  // No git, no index, no repository: say so and name the command, rather than
  // returning an empty list that reads exactly like a clean result.
  if (!staged.ok) {
    return [{ skipped: "git did not answer, so staged deletions could not be read", command: command.join(" ") }];
  }
  const out = [];
  for (const line of staged.stdout.split("\n")) {
    const rel = line.trim();
    if (rel && matches(rel, paths)) out.push(ctx.finding(id, rel, 1, "staged deletion", "staged for deletion"));
  }
  return out;
}

// A staged deletion cannot be seeded in a throwaway directory without building
// a repository and an index there, which is more machinery than a selftest
// should own. The exact command to run by hand is printed instead.
export const selftest = {
  path: null,
  why: "a staged deletion needs a real git index, which the selftest does not create",
  command: "git rm --cached path/to/some.test.js && node .jig/checks/run.mjs",
};
