// The scope check: a write landing outside the files the open task declared writable.
//
// It runs in three places — refused at write time by a session that has the plugin, at commit time
// and in CI through `run.mjs --live` — so it is a pure function with no side effects and no
// dependencies beyond Node.
//
// What it deliberately does not flag, because a guard that cries wolf gets switched off:
//   - a read, whatever tool it arrives in, including the shell forms that also have a write mode;
//   - a shell command that creates a path which does not exist yet (scratch output is not a change
//     to the repository);
//   - anything outside the repository, including another drive and /dev/null;
//   - the roadmap and state another planning tool owns, which that tool guards itself.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';

export const id = 'scope';
export const what = 'a write outside the files the open task declared writable';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const PATCH_TOOLS = new Set(['apply_patch']);
// Every file a patch names, whichever verb it uses on it.
const PATCH_FILE = /^\s*\*\*\*\s+(?:(?:Add|Update|Delete)\s+File|Move to):\s*(.+?)\s*$/gm;
const NEVER_WRITABLE = ['.collet/'];
const ALWAYS_WRITABLE = ['.collet/unverified.md'];
const OWNED_ELSEWHERE = ['ROADMAP.jsonl', '.foreman/'];

/**
 * Repository-relative, forward-slashed path, or null when it is not inside the repository.
 *
 * The drive check comes first and is the whole reason this is not one line: on Windows,
 * `relative()` between two different roots returns the target's own absolute path, which starts
 * with a letter rather than `..` and would read as a repository path that matches no scope.
 */
function repoRelative(target, root, from = root) {
  if (typeof target !== 'string' || !target.trim()) return null;
  const clean = target.trim().replace(/^["']|["']$/g, '');
  if (!clean || clean === '-') return null;
  // Both sides go through resolve() first: a root spelled with forward slashes and a target
  // resolved with native ones have different-looking drive prefixes for the same drive.
  const base = resolve(root);
  // A relative path means what it meant to the session: relative to the directory the call ran
  // in, which is below the root once a session is opened in `src/` or a shell has changed directory.
  const abs = isAbsolute(clean) ? resolve(clean) : resolve(from, clean);
  if (parse(abs).root.toLowerCase() !== parse(base).root.toLowerCase()) return null;
  const rel = relative(base, abs).split('\\').join('/');
  if (!rel || rel === '.' || rel.startsWith('..')) return null;
  return rel;
}

/**
 * Does one declared entry cover one path?
 *
 * A plain entry owns what sits beneath it, so `src/auth` and `src/auth/` both cover
 * `src/auth/token.ts`. A scope is written by hand, and a folder is the natural unit to name; it
 * costs nothing for a single file, which nothing can sit beneath.
 */
export function matchScope(pattern, path) {
  const glob = String(pattern)
    .split('\\')
    .join('/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (!glob) return false;
  if (glob.endsWith('/**')) {
    const base = glob.slice(0, -3);
    return path === base || path.startsWith(`${base}/`);
  }
  if (glob.includes('*')) {
    const escape = (part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const source = glob
      .split('**')
      .map((chunk) => chunk.split('*').map(escape).join('[^/]*'))
      .join('.*');
    return new RegExp(`^${source}$`).test(path);
  }
  return path === glob || path.startsWith(`${glob}/`);
}

const LITERAL = /^[A-Za-z0-9._/\\: -]+$/;
// Keep literal quoted arguments together. This deliberately does not evaluate variables,
// substitutions or nested shell syntax; it only separates simple commands and their operands.
const SHELL_TOKEN = /"[^"]*"|'[^']*'|[;&|\r\n]+|[0-9]*>{1,2}|,|[^\s"';&|>,]+/g;
const FIRST_ARG = new Set(['add-content', 'set-content', 'clear-content', 'out-file', 'new-item']);
const PATH_FLAGS = new Set(['-path', '-literalpath', '-destination', '-filepath']);
// A flag value is not a positional path: `-ItemType File` must not turn File into a target.
const VALUE_FLAGS = new Set(
  ['itemtype', 'encoding', 'value', 'name', 'newname', 'filter', 'include', 'exclude', 'delimiter', 'stream', 'inputobject', 'variable'].map(
    (flag) => `-${flag}`
  )
);

function unquote(token) {
  return String(token ?? '').replace(/^["']|["']$/g, '');
}

function shellCommands(command) {
  const commands = [[]];
  for (const token of String(command).match(SHELL_TOKEN) ?? []) {
    if (/^[;&|\r\n]+$/.test(token)) commands.push([]);
    else commands.at(-1).push(token);
  }
  return commands.filter((tokens) => tokens.length);
}

/** Named path values and positional groups; PowerShell comma lists stay one argument. */
function argumentsOf(tokens) {
  const named = new Map();
  const positional = [];
  let options = true;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (options && token === '--') { options = false; continue; }
    const flag = token.toLowerCase();
    if (options && token.startsWith('-')) {
      if (PATH_FLAGS.has(flag)) {
        const values = [];
        if (tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('-')) {
          values.push(tokens[++i]);
          while (tokens[i + 1] === ',' && tokens[i + 2] !== undefined) {
            i += 2;
            values.push(tokens[i]);
          }
        }
        named.set(flag, [...(named.get(flag) ?? []), ...values]);
      } else if (VALUE_FLAGS.has(flag)) {
        i += 1;
      }
      continue;
    }
    if (token === ',') continue;
    const values = [token];
    while (tokens[i + 1] === ',' && tokens[i + 2] !== undefined) {
      i += 2;
      values.push(tokens[i]);
    }
    positional.push(values);
  }
  return { named, positional };
}

function shellTargets(command) {
  const found = [];
  for (const tokens of shellCommands(command)) {
    const args = [];
    // Redirection writes regardless of which command produced its input. Quoted text containing
    // `>` remains one token and never enters this branch.
    for (let i = 0; i < tokens.length; i += 1) {
      if (/^[0-9]*>{1,2}$/.test(tokens[i])) {
        if (tokens[i + 1] !== undefined) found.push(tokens[++i]);
      } else args.push(tokens[i]);
    }
    const name = unquote(args.shift()).toLowerCase();
    const { named, positional } = argumentsOf(args);
    const paths = [...(named.get('-path') ?? []), ...(named.get('-literalpath') ?? [])];
    const destination = named.get('-destination');
    if (FIRST_ARG.has(name)) {
      found.push(...(paths.length ? paths : named.get('-filepath') ?? positional[0] ?? []));
    } else if (name === 'remove-item' || name === 'rm') {
      found.push(...paths, ...positional.flat());
    } else if (name === 'copy-item' || (name === 'cp' && (paths.length || destination))) {
      // A copy reads its sources. With a named source the first positional group is the
      // destination; with positional sources it is the second group.
      found.push(...(destination ?? positional[paths.length ? 0 : 1] ?? []));
    } else if (name === 'move-item' || name === 'mv') {
      // Moving also removes every source, so checking only its destination would allow a
      // removal outside the task to happen before the working-tree check could report it.
      found.push(...paths, ...positional.flat(), ...(destination ?? []));
    } else if (name === 'tee' || name === 'tee-object') {
      found.push(...(named.get('-filepath') ?? positional.flat()));
    } else if (name === 'cp') {
      found.push(...(positional.at(-1) ?? []));
    } else if (name === 'sed' && args.some((token) => /^-[a-zA-Z]*i/.test(token))) {
      // `sed` edits in place only with -i; every other form reads.
      found.push(...(positional.at(-1) ?? []));
    }
  }
  return [...new Set(found.map(unquote).filter((token) => LITERAL.test(token)))];
}

/** Every path this call would write, or null when the tool is not a write at all. */
export function targetsOf(call, root) {
  const tool = call?.tool ?? '';
  const input = call?.input ?? {};

  if (WRITE_TOOLS.has(tool)) return [input.file_path ?? input.notebook_path ?? null];

  if (PATCH_TOOLS.has(tool)) {
    // Codex hands the patch over as `command`. Missing that key read every patch as empty and
    // allowed every file edit on that host.
    const text = String(input.patch ?? input.input ?? input.command ?? input.content ?? '');
    return [...text.matchAll(PATCH_FILE)].map((match) => match[1]);
  }

  if (SHELL_TOOLS.has(tool)) {
    // Only something that already exists can be changed by a shell command. Creating a path is how
    // scratch output and temp files happen, and flagging that is how a guard loses its audience.
    // A directory counts: `rm -rf <dir>` is the most destructive thing this can see.
    return shellTargets(input.command ?? '').filter((target) => {
      const rel = repoRelative(target, root, call.cwd ?? root);
      if (!rel) return false;
      try {
        const stat = statSync(join(resolve(root), rel));
        return stat.isFile() || stat.isDirectory();
      } catch {
        return false;
      }
    });
  }

  return null;
}

export function check({ root, task, call }) {
  if (!task) return { fires: false, reason: 'no task is open, so nothing is enforced' };

  const targets = targetsOf(call, root);
  if (targets === null) return { fires: false, reason: 'not a write' };

  const scope = task.scope ?? [];

  for (const target of targets) {
    const rel = repoRelative(target, root, call.cwd ?? root);
    if (!rel) continue;
    if (OWNED_ELSEWHERE.some((owned) => matchScope(owned, rel))) continue;
    if (ALWAYS_WRITABLE.includes(rel)) continue;
    if (NEVER_WRITABLE.some((prefix) => rel.startsWith(prefix))) {
      return {
        fires: true,
        reason: `${rel} is the harness's own state (${task.id} is open), not a task file.`,
      };
    }
    if (!scope.some((pattern) => matchScope(pattern, rel))) {
      return {
        fires: true,
        reason: `${rel} is outside the open task (${task.id}). Writable: ${scope.join(', ') || 'nothing'}.`,
      };
    }
  }

  return { fires: false, reason: 'inside the open task' };
}

/**
 * The same question against the working tree, for a commit hook or CI.
 *
 * When it cannot read the tree it reports `skipped` rather than `ok`: a check that did not run is
 * not a check that passed, and a green printed for an absent git is the exact false comfort this
 * whole design exists to refuse.
 */
export function live({ root, task }) {
  if (!task) return { fires: false, skipped: true, reason: 'no task is open, so nothing is enforced' };
  const git = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  try {
    // Tracked changes and new files both. A change the repository has never seen is still a change
    // to it, and `git diff` alone reports only the first kind.
    out = `${git(['diff', '--name-only', 'HEAD'])}\n${git(['ls-files', '--others', '--exclude-standard'])}`;
  } catch {
    return { fires: false, skipped: true, reason: 'not a git repository, or git is unavailable' };
  }
  const scope = task.scope ?? [];
  const outside = [
    ...new Set(
      out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  ]
    .filter((path) => !path.startsWith('.collet/'))
    .filter((path) => !OWNED_ELSEWHERE.some((owned) => matchScope(owned, path)))
    .filter((path) => !scope.some((pattern) => matchScope(pattern, path)));
  if (!outside.length) return { fires: false, reason: 'everything changed is inside the task' };
  return { fires: true, reason: `changed outside the open task ${task.id}: ${outside.join(', ')}` };
}
