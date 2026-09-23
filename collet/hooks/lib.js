// Shared by the three hooks. Everything here is fail-open and silent: a hook that cannot read the
// project must never be the reason a session stops working.
//
// One thing is deliberately not silent — the kill switch. `.collet/off` turns every hook off, and
// it exists so that "disabled" is a state somebody chose rather than the accidental result of a
// file going missing. The committed checks and anything wired to run them never read it.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COLLET = '.collet';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Some Antigravity calls omit both workspacePaths and cwd. The tool then provides the only
// location evidence. Relative arguments cannot anchor a project from the plugin's own cwd.
function antigravityDirectory(event) {
  const name = event.toolCall?.name;
  const args = event.toolCall?.args ?? {};
  if (name === 'run_command') {
    return typeof args.Cwd === 'string' && isAbsolute(args.Cwd) ? args.Cwd : null;
  }
  if (!['write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(name)) return null;
  const target = args.AbsolutePath ?? args.TargetFile;
  return typeof target === 'string' && isAbsolute(target) ? dirname(target) : null;
}

/**
 * Where the project is. Claude Code sets CLAUDE_PROJECT_DIR; Codex sends the directory as `cwd`.
 * Antigravity may send workspacePaths, or only an absolute tool location, and runs the hook from
 * the plugin's own directory. process.cwd() is therefore the last resort, never the first.
 *
 * A named directory may sit below the project. The nearest directory upwards that holds the
 * harness is the root; with none, the answer is the start. Explicit host context always wins.
 */
export function root(event = {}) {
  const workspace = Array.isArray(event.workspacePaths) ? event.workspacePaths[0] : null;
  const start = process.env.CLAUDE_PROJECT_DIR ?? event.cwd ?? workspace ?? antigravityDirectory(event) ?? process.cwd();
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, COLLET, 'config.json'))) return dir;
    if (dirname(dir) === dir) return start;
  }
}

/** A project that has collet mounted and has not switched it off, or null. */
export function mounted(dir) {
  if (!existsSync(join(dir, COLLET, 'config.json'))) return null;
  if (existsSync(join(dir, COLLET, 'off'))) return null;
  return join(dir, COLLET);
}

export function config(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, COLLET, 'config.json'), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/**
 * A module the project owns, with the plugin's own copy as the fallback.
 *
 * The project's copy is authoritative — it is the one committed, reviewed and run in CI. The
 * fallback exists so that deleting a single file cannot quietly disarm the guard while leaving
 * every sign that it is still on.
 */
export async function projectModule(dir, name) {
  for (const candidate of [join(dir, COLLET, name), join(PLUGIN_ROOT, 'templates', name)]) {
    if (!existsSync(candidate)) continue;
    try {
      return await import(pathToFileURL(candidate).href);
    } catch {
      /* try the next one */
    }
  }
  return null;
}

export function readEvent() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

export function fileText(dir, name) {
  const path = join(dir, COLLET, name);
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

// hooks.json gives the session-start and handoff hooks 10 s, and a host that reaches it stops the
// hook and drops what it printed. Each run marks itself running in `.collet/<name>.running` and
// clears the mark when it ends, so a mark older than that is a run the host stopped. A mark that
// cannot be written, read or removed changes nothing else the hook does.
const HOOK_TIMEOUT_MS = 10_000;
const marker = (dir, name) => join(dir, COLLET, `${name}.running`);

/** Mark this run of a hook as running, and return its id. */
export function started(dir, name) {
  const mark = { run: `${Date.now()}-${process.pid}`, at: new Date().toISOString() };
  try {
    writeFileSync(marker(dir, name), `${JSON.stringify(mark)}\n`, 'utf8');
  } catch {
    /* a trace nobody could write is not worth stopping the session for */
  }
  return mark.run;
}

/** The mark a run left behind longer ago than the host's timeout, or null. */
export function cutShort(dir, name) {
  try {
    const mark = JSON.parse(readFileSync(marker(dir, name), 'utf8'));
    return typeof mark?.run === 'string' && Date.now() - Date.parse(mark.at) > HOOK_TIMEOUT_MS ? mark : null;
  } catch {
    return null;
  }
}

/** Clear a run's mark, and only that run's: a run started meanwhile keeps its own. */
export function finished(dir, name, run) {
  try {
    if (JSON.parse(readFileSync(marker(dir, name), 'utf8'))?.run === run) rmSync(marker(dir, name), { force: true });
  } catch {
    /* nothing to clear, or nothing that can be */
  }
}

export function emit(event, context) {
  if (!context) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } })
  );
}

// Antigravity names its tools differently and passes their arguments in PascalCase. The scope
// check speaks Claude Code's vocabulary, so the call is translated here, at the wire, and the
// check stays one function that runs the same way in a session, at commit time and in CI.
const file = (args) => ({ file_path: args.AbsolutePath ?? args.TargetFile ?? null });
const ANTIGRAVITY_TOOLS = {
  run_command: (args) => ({ tool: 'Bash', input: { command: args.CommandLine ?? '' }, cwd: args.Cwd }),
  write_to_file: (args) => ({ tool: 'Write', input: file(args) }),
  replace_file_content: (args) => ({ tool: 'Edit', input: file(args) }),
  multi_replace_file_content: (args) => ({ tool: 'Edit', input: file(args) }),
};

// The two payload shapes a PreToolUse hook can be handed, and the two answers. Claude Code and
// Codex agree on both, and take silence as consent. Antigravity nests the call under `toolCall`,
// answers with a bare decision, and is told the allow out loud.
const HOSTS = {
  claude: {
    // `cwd` is where the call runs, which is what a relative path in it is relative to. The shell is
    // named where the tool says it: PowerShell, or a Bash tool off Windows. On Windows the same
    // Bash tool name can reach a PowerShell, so the shell stays unknown there.
    call: (event) => {
      const tool = event.tool_name ?? '';
      const shell = tool === 'PowerShell' ? 'powershell' : tool === 'Bash' && process.platform !== 'win32' ? 'posix' : undefined;
      return { tool, input: event.tool_input ?? {}, cwd: event.cwd, shell };
    },
    deny: (reason) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }),
    // A notice rides on an allowed call as context for the session, with no decision in it.
    allow: (notice) => (notice ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notice } } : null),
  },
  antigravity: {
    call: (event) => {
      const name = event.toolCall?.name ?? '';
      const args = event.toolCall?.args ?? {};
      return ANTIGRAVITY_TOOLS[name]?.(args) ?? { tool: name, input: args };
    },
    deny: (reason) => ({ decision: 'deny', reason }),
    allow: () => ({ decision: 'allow' }),
  },
};

export function host(name) {
  return HOSTS[name] ?? HOSTS.claude;
}
