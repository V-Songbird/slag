// The scope check: a write landing outside the files the open task declared writable.
//
// It runs in three places — refused at write time by a session that has the plugin, at commit time
// and in CI through `run.mjs --live` — so it is a pure function with no side effects and no
// dependencies beyond Node.
//
// What it deliberately does not flag, because a guard that cries wolf gets switched off:
//   - a read, whatever tool it arrives in, including the shell forms that also have a write mode;
//   - a shell command that creates a path which does not exist yet outside `.collet/` (scratch
//     output is not a change to the repository);
//   - anything outside the repository, including another drive and /dev/null;
//   - the roadmap and state another planning tool owns, which that tool guards itself.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
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
// The files the mount writes its rules block into. Only the block between the markers is the
// harness's own; the rest of each file is the project's.
const RULES_SURFACES = ['AGENTS.md', 'CLAUDE.md', '.cursor/rules/collet.md'];
const BLOCK_BEGIN = '<!-- collet:begin';
const BLOCK_END = '<!-- collet:end -->';

/** The text with the rules block cut out, or null when it holds no complete block. */
function withoutBlock(text) {
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (start === -1 || end < start) return null;
  return text.slice(0, start) + text.slice(end + BLOCK_END.length);
}

/**
 * Repository-relative, forward-slashed path, or null when it is not inside the repository.
 *
 * The drive check comes first and is the whole reason this is not one line: on Windows,
 * `relative()` between two different roots returns the target's own absolute path, which starts
 * with a letter rather than `..` and would read as a repository path that matches no scope.
 */
function repoRelative(target, root, from = root) {
  const located = locate(target, root, from);
  if (!located) return null;
  const rel = relative(located.base, located.abs).split('\\').join('/');
  if (!rel || rel === '.' || rel.startsWith('..')) return null;
  return rel;
}

/** The root and the absolute path a target names, or null when it is empty or on another drive. */
function locate(target, root, from) {
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
  return { base, abs };
}

/**
 * Does a path name the repository root, or a directory that holds it? repoRelative reads both as
 * outside the repository, yet removing or moving one takes every file in it, the harness included.
 */
function holdsRoot(target, root, from = root) {
  const located = locate(target, root, from);
  if (!located) return false;
  const down = relative(located.abs, located.base);
  return !down.startsWith('..') && !isAbsolute(down);
}

/**
 * Is a repository path the harness's own directory or beneath it?
 *
 * Letter case does not count: a case-insensitive filesystem resolves `.Collet/off` to the kill
 * switch. The directory itself does: removing or moving it takes every hook with it.
 */
function harnessPath(rel) {
  return Boolean(rel) && NEVER_WRITABLE.some((prefix) => `${rel}/`.toLowerCase().startsWith(prefix));
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
// Parsed for the harness's own directory only, where a new `.collet/off` switches every hook off.
// Elsewhere what they create is scratch, and the working-tree check sees any other change.
const HARNESS_ONLY = new Set(['touch', 'mkdir', 'rename-item']);
// PowerShell's built-in aliases of the cmdlets read below, each read as its cmdlet. The five names a
// POSIX shell shares are in SHARED instead.
const ALIASES = new Map([
  ['ac', 'add-content'], ['clc', 'clear-content'], ['copy', 'copy-item'], ['cpi', 'copy-item'],
  ['move', 'move-item'], ['mi', 'move-item'], ['del', 'remove-item'], ['erase', 'remove-item'],
  ['rd', 'remove-item'], ['ri', 'remove-item'], ['rmdir', 'remove-item'], ['ren', 'rename-item'],
  ['rni', 'rename-item'], ['md', 'mkdir'], ['ni', 'new-item'],
]);
const PATH_FLAGS = new Set(['-path', '-literalpath', '-destination', '-filepath']);
// A flag value is not a positional path: `-ItemType File` must not turn File into a target. These
// are every non-switch parameter of the cmdlets below and every common one (Get-Command), by the
// name resolved() gives them.
const VALUE_FLAGS = new Set(
  [
    'itemtype', 'encoding', 'value', 'name', 'newname', 'filter', 'include', 'exclude', 'delimiter', 'stream', 'inputobject',
    'variable', 'credential', 'width', 'fromsession', 'tosession', 'erroraction', 'errorvariable', 'informationaction',
    'informationvariable', 'outbuffer', 'outvariable', 'pipelinevariable', 'progressaction', 'warningaction', 'warningvariable',
  ].map((flag) => `-${flag}`)
);
// Each cmdlet's own parameters in PowerShell 7, aliases after a colon (Get-Command). A flag reads
// as the parameter PowerShell binds it to: the one it names exactly, or the only one it begins. A
// common parameter such as -Debug never competes, and a prefix that begins several stays unread,
// since PowerShell refuses to run it.
const CONTENT = 'Credential Exclude Filter Force Include LiteralPath:PSPath:LP Path Stream';
const WRITTEN = `${CONTENT} AsByteStream Encoding NoNewline PassThru Value`;
const PARAMETERS = new Map(Object.entries({
  'add-content': WRITTEN,
  'set-content': WRITTEN,
  'clear-content': CONTENT,
  'out-file': 'Append Encoding FilePath:Path Force InputObject LiteralPath:PSPath:LP NoClobber:NoOverwrite NoNewline Width',
  'new-item': 'Credential Force ItemType:Type Name Path Value:Target',
  'remove-item': `${CONTENT} Recurse`,
  'copy-item': 'Container Credential Destination Exclude Filter Force FromSession Include LiteralPath:PSPath:LP PassThru Path Recurse ToSession',
  'move-item': 'Credential Destination Exclude Filter Force Include LiteralPath:PSPath:LP PassThru Path',
  'tee-object': 'Append Encoding FilePath:Path InputObject LiteralPath:PSPath:LP Variable',
  'rename-item': 'Credential Force LiteralPath:PSPath:LP NewName PassThru Path',
  mkdir: 'Credential Force Name Path Value',
}).map(([cmdlet, names]) => [cmdlet, parameterList(names)]));
// The common parameters every cmdlet also takes. One binds only when no parameter of the cmdlet's
// own fits the prefix: `-D` is Copy-Item's -Destination, never -Debug.
const COMMON = parameterList(
  'Confirm:CF Debug:DB ErrorAction:EA ErrorVariable:EV InformationAction:INFA InformationVariable:IV OutBuffer:OB ' +
    'OutVariable:OV PipelineVariable:PV ProgressAction:PROGA Verbose:VB WarningAction:WA WarningVariable:WV WhatIf:WI'
);
// Names that are also POSIX commands keep their own flags: `rm -i` asks, it does not filter.
const POSIX = new Set(['rm', 'mv', 'cp', 'tee', 'mkdir', 'rmdir']);
// Under PowerShell these name its cmdlets, with PowerShell's flags; in a POSIX shell they are the
// POSIX commands. A call whose shell is unknown is read both ways (see shellTargets).
const SHARED = new Map([
  ['rm', 'remove-item'], ['rmdir', 'remove-item'], ['cp', 'copy-item'], ['mv', 'move-item'], ['tee', 'tee-object'],
]);

function parameterList(names) {
  return names.toLowerCase().split(' ').map((entry) => entry.split(':'));
}

/** A flag as PowerShell binds it for this cmdlet, or the token unchanged when it binds to none. */
function resolved(cmdlet, token) {
  const parameters = PARAMETERS.get(cmdlet);
  if (!parameters || !/^-[a-z]+$/i.test(token)) return token;
  const typed = token.slice(1).toLowerCase();
  const exact = [...parameters, ...COMMON].find((names) => names.includes(typed));
  const begun = (list) => list.filter((names) => names.some((name) => name.startsWith(typed)));
  const own = begun(parameters);
  const fits = exact ? [exact] : own.length ? own : begun(COMMON);
  return fits.length === 1 ? `-${fits[0][0]}` : token;
}

/**
 * A PowerShell argument as the flag and value it binds: `-Path:x` is `-Path x`, abbreviated or
 * not, and a switch written `-Recurse:$false` takes nothing further.
 */
function bound(cmdlet, token) {
  const [, flag, value] = /^(-[a-z]+):(.*)$/is.exec(token) ?? [];
  if (!flag) return [resolved(cmdlet, token)];
  const name = resolved(cmdlet, flag);
  const takes = PATH_FLAGS.has(name.toLowerCase()) || VALUE_FLAGS.has(name.toLowerCase());
  return takes && value ? [name, value] : [name];
}

function unquote(token) {
  return String(token ?? '').replace(/^["']|["']$/g, '');
}

/** The token after a named flag that argumentsOf skips as a value, such as New-Item's `-Name`. */
function flagValue(tokens, flag) {
  const index = tokens.findIndex((token) => token.toLowerCase() === flag);
  return index === -1 ? undefined : unquote(tokens[index + 1]);
}

/** The directory part of a path operand, `.` when it names a file where the call runs. */
function parentOf(path) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? '.' : path.slice(0, cut) || '/';
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

/**
 * A path operand that starts with the working-directory or home token, as the path it names from
 * the call's directory, or null. `$PWD` and `${PWD}` (in any letter case under PowerShell) and cmd's
 * `%CD%` are the working directory, and a leading `~` is the home directory: unquoted in a POSIX
 * shell, quoted or not under PowerShell, whose FileSystem provider reads it in any path. Single
 * quotes keep the others literal, and so does a working directory the host did not name.
 */
function expanded(token, { cwd, root, powershell }) {
  const quote = /^["']/.test(token) ? token[0] : '';
  const [, head = '', rest = ''] = /^(\$PWD|\$\{PWD\}|%CD%|~)((?:[/\\].*)?)$/i.exec(quote ? token.slice(1, -1) : token) ?? [];
  // A POSIX shell reads $PWD in capitals only, and there a backslash escapes instead of separating.
  if (!head || (!powershell && head[0] !== '%' && (head !== head.toUpperCase() || rest.startsWith('\\')))) return null;
  const path = rest.split('\\').join('/');
  if (head === '~') return quote && !powershell ? null : join(relative(cwd ?? root, homedir()) || '.', path);
  return cwd && quote !== "'" ? join('.', path) : null;
}

function shellTargets(command, harness, removed, where) {
  const found = [];
  for (const words of shellCommands(command)) {
    const tokens = words.map((token) => expanded(token, where) ?? token);
    // A known shell reads the command its own way. With the shell unknown the POSIX reading stands,
    // and the PowerShell reading of a shared name adds what it would write under `.collet/`.
    for (const cmdlets of where.shell ? [where.shell === 'powershell'] : [false, true]) {
      const reading = commandTargets(tokens, harness, cmdlets);
      found.push(...(cmdlets && !where.shell ? reading.found.filter(harness) : reading.found));
      removed.push(...reading.removed);
    }
  }
  return [...new Set(found.map(unquote).filter((token) => LITERAL.test(token)))];
}

/** One command's write targets and removed paths, reading the shared names as cmdlets or not. */
function commandTargets(tokens, harness, cmdlets) {
  const found = [];
  const removed = [];
  const args = [];
  // Redirection writes regardless of which command produced its input. Quoted text containing
  // `>` remains one token and never enters this branch.
  for (let i = 0; i < tokens.length; i += 1) {
    if (/^[0-9]*>{1,2}$/.test(tokens[i])) {
      if (tokens[i + 1] !== undefined) found.push(tokens[++i]);
    } else args.push(tokens[i]);
  }
  const called = unquote(args.shift()).toLowerCase();
  const shared = cmdlets && SHARED.get(called);
  const name = shared || (ALIASES.get(called) ?? called);
  const flags = POSIX.has(called) && !shared ? args : args.flatMap((token) => bound(name, token));
  const { named, positional } = argumentsOf(flags);
  const paths = [...(named.get('-path') ?? []), ...(named.get('-literalpath') ?? [])];
  const destination = named.get('-destination');
  const hits = [];
  if (FIRST_ARG.has(name)) {
    hits.push(...(paths.length ? paths : named.get('-filepath') ?? positional[0] ?? []));
  } else if (name === 'remove-item' || name === 'rm') {
    hits.push(...paths, ...positional.flat());
    removed.push(...paths, ...positional.flat());
  } else if (name === 'copy-item' || (name === 'cp' && (paths.length || destination))) {
    // A copy reads its sources. With a named source the first positional group is the
    // destination; with positional sources it is the second group.
    hits.push(...(destination ?? positional[paths.length ? 0 : 1] ?? []));
  } else if (name === 'move-item' || name === 'mv') {
    // Moving also removes every source, so checking only its destination would allow a
    // removal outside the task to happen before the working-tree check could report it.
    hits.push(...paths, ...positional.flat(), ...(destination ?? []));
    // What leaves: the named paths, or every positional group but the last, which is where it goes.
    removed.push(...(destination ? [...paths, ...positional.flat()] : paths.length ? paths : positional.slice(0, -1).flat()));
  } else if (name === 'tee' || name === 'tee-object') {
    hits.push(...(named.get('-filepath') ?? (paths.length ? paths : positional.flat())));
  } else if (name === 'cp') {
    hits.push(...(positional.at(-1) ?? []));
  } else if (name === 'sed' && args.some((token) => /^-[a-zA-Z]*i/.test(token))) {
    // `sed` edits in place only with -i; every other form reads.
    hits.push(...(positional.at(-1) ?? []));
  } else if (name === 'rename-item') {
    // The source goes, and its new name lands in the same directory.
    const sources = paths.length ? paths : positional[0] ?? [];
    const renamed = flagValue(flags, '-newname') ?? unquote(positional[paths.length ? 0 : 1]?.[0]);
    hits.push(...sources, ...(renamed ? sources.map((source) => `${parentOf(unquote(source))}/${renamed}`) : []));
  } else if (HARNESS_ONLY.has(name)) {
    hits.push(...paths, ...positional.flat());
  }
  // New-Item puts -Name under -Path, or under the directory the call runs in. Read for the
  // harness only: every other decision New-Item had stays as it was.
  const leaf = name === 'new-item' ? flagValue(flags, '-name') : undefined;
  const under = leaf ? (paths.length ? paths : positional[0] ?? ['.']).map((base) => `${unquote(base)}/${leaf}`) : [];
  found.push(...(HARNESS_ONLY.has(name) ? hits.filter(harness) : hits), ...under.filter(harness));
  return { found, removed };
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
    // A directory counts: `rm -rf <dir>` is the most destructive thing this can see. Nothing created
    // under the harness's own directory is scratch: the close-time check skips it, and a new
    // `.collet/off` would switch every hook off. `check` still lets the unverified list through.
    const relOf = (target) => repoRelative(target, root, call.cwd ?? root);
    const removed = [];
    // The shell the host named; Claude Code's PowerShell tool names itself.
    const shell = call.shell ?? (tool === 'PowerShell' ? 'powershell' : undefined);
    const where = { cwd: call.cwd, root, shell, powershell: shell === 'powershell' };
    const targets = shellTargets(input.command ?? '', (target) => harnessPath(relOf(target)), removed, where).filter((target) => {
      const rel = relOf(target);
      if (!rel) return false;
      if (harnessPath(rel)) return true;
      try {
        const stat = statSync(join(resolve(root), rel));
        return stat.isFile() || stat.isDirectory();
      } catch {
        return false;
      }
    });
    // Removing or moving the repository, or a directory that holds it, takes the harness with it.
    const whole = removed.some((target) => holdsRoot(target, root, call.cwd ?? root));
    return whole ? [join(resolve(root), '.collet'), ...targets] : targets;
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
    if (harnessPath(rel)) {
      // `harness` tells the guard that widening cannot help here, whatever the wording says.
      return {
        fires: true,
        harness: true,
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
  const names = (text) => text.split('\0').filter(Boolean);
  let changed = [];
  let fresh = [];
  try {
    // Tracked changes and new files both. A change the repository has never seen is still a change
    // to it, and `git diff` alone reports only the first kind. --relative and the `.` pathspec keep
    // every path relative to the mount, which the scope is written against, including a mount below
    // the Git root; NUL delimiters keep names Git would otherwise quote. --no-renames lists both
    // sides of a move: with rename detection, a staged move out of a file the task may not touch
    // shows only its destination.
    // This listing stays apart from the one the bundle checks share through run.mjs's pass cache.
    // That one lives in .collet/source.mjs, which only a mount with checks writes and a project may
    // edit, and it pairs renames, while this check lists both sides of a move.
    changed = names(git(['diff', '--name-only', '--no-renames', '--relative', '-z', 'HEAD', '--', '.']));
    fresh = names(git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.']));
  } catch {
    return { fires: false, skipped: true, reason: 'not a git repository, or git is unavailable' };
  }
  // The mount's rules block stays uncommitted until the project commits it. Counted as a task
  // change, it would keep the first task after a mount from closing. A surface whose only change is
  // that block is the harness's own write, like .collet/; a change to the project's text around it
  // still counts.
  const inHead = (path) => {
    try {
      git(['cat-file', '-e', `HEAD:./${path}`]);
      return true;
    } catch {
      return false;
    }
  };
  const onlyTheBlock = (path) => {
    if (!RULES_SURFACES.includes(path)) return false;
    try {
      const now = withoutBlock(readFileSync(join(root, path), 'utf8'));
      if (now === null) return false;
      // A surface HEAD does not have starts empty, whether the mount's new file is untracked or
      // already staged. Git answers that, not the untracked list: `git add` moves the file off it.
      const head = inHead(path) ? git(['show', `HEAD:./${path}`]) : '';
      // The mount trims the text it appends to, and Git may convert line endings on checkout.
      const same = (text) => text.replace(/\r\n/g, '\n').trimEnd();
      return same(now) === same(withoutBlock(head) ?? head);
    } catch {
      return false;
    }
  };
  const scope = task.scope ?? [];
  const outside = [...new Set([...changed, ...fresh])]
    .filter((path) => !path.startsWith('.collet/'))
    .filter((path) => !OWNED_ELSEWHERE.some((owned) => matchScope(owned, path)))
    .filter((path) => !scope.some((pattern) => matchScope(pattern, path)))
    .filter((path) => !onlyTheBlock(path));
  if (!outside.length) return { fires: false, reason: 'everything changed is inside the task' };
  return { fires: true, reason: `changed outside the open task ${task.id}: ${outside.join(', ')}` };
}
