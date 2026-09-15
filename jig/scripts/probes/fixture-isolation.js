"use strict";

const fs = require("node:fs");
const path = require("node:path");

const isGitVariable = (name) => /^GIT_/i.test(name);

// The caller owns this fresh directory. Git must not read the owner's config,
// copy their templates, or follow inherited repository/index routing variables.
function fixtureGitEnvironment(directory, inherited = process.env) {
  fs.mkdirSync(directory, { recursive: true });
  const config = path.join(directory, "empty-config");
  const template = path.join(directory, "empty-template");
  fs.writeFileSync(config, "", { flag: "wx" });
  fs.mkdirSync(template);
  return {
    ...Object.fromEntries(Object.entries(inherited).filter(([name]) => !isGitVariable(name))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: config,
    GIT_CONFIG_GLOBAL: config,
    GIT_TEMPLATE_DIR: template,
    GIT_ATTR_NOSYSTEM: "1",
  };
}

// Engine entry points are synchronous and inherit process.env in their own
// subprocesses. Restore the exact prior Git environment even when they throw.
function withFixtureGitEnvironment(environment, callback) {
  const previous = Object.fromEntries(Object.entries(process.env).filter(([name]) => isGitVariable(name)));
  const replace = (values) => {
    for (const name of Object.keys(process.env)) if (isGitVariable(name)) delete process.env[name];
    for (const [name, value] of Object.entries(values)) if (isGitVariable(name)) process.env[name] = value;
  };
  replace(environment);
  try { return callback(); } finally { replace(previous); }
}

// The probes drive the engine the way the Codex skills do. Set the runtime for
// the call and put back whatever the caller had, even when the callback throws.
function withCodexRuntime(callback) {
  const previous = process.env.JIG_RUNTIME;
  process.env.JIG_RUNTIME = "codex";
  try { return callback(); } finally {
    if (previous === undefined) delete process.env.JIG_RUNTIME;
    else process.env.JIG_RUNTIME = previous;
  }
}

module.exports = { fixtureGitEnvironment, withFixtureGitEnvironment, withCodexRuntime };
