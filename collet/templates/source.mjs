// Source-pattern checks shared by the optional catalogue checks a project mounts.
// No plugin or dependencies are needed once this file is copied into .collet/.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Enough glob for the catalogue's own path patterns: `**` crosses directory
// separators, `*` does not, `?` is one character, `{a,b}` is an alternation.
// Anything else is a literal. Without the alternation a path set like
// `**/*.{ts,tsx}` matches nothing at all, which is a silent zero-coverage
// failure rather than a loud one.
function globToRegExp(glob) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      depth++;
      out += "(?:";
    } else if (c === "}" && depth) {
      depth--;
      out += ")";
    } else if (c === "," && depth) {
      out += "|";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + out + ")".repeat(depth) + "$", "i");
}

function matchesAny(rel, globs) {
  return globs.some((g) => globToRegExp(g).test(rel));
}

// A class's optional `exclude` globs take a path back out of whatever its `paths` let in.
function eligible(rel, paths, spec) {
  return matchesAny(rel, paths) && !matchesAny(rel, spec.exclude ?? []);
}

// ---------------------------------------------------------------------------
// Comment and string blanking
// ---------------------------------------------------------------------------
//
// Every blanked region keeps its length and its newlines, so a match's line
// number is still the line number in the file the user will open. This is the
// single place false positives are most likely to live, which is why the
// catalogue's near-miss fixtures aim straight at it.

// Comment syntax is language data, so the edition that knows the language
// declares it per extension and hands the map down as `opts.commentSyntax`.
// This table is only the floor for a file no edition claimed — without it a
// `.py` or `.ps1` file would be read with JavaScript comment rules and every
// commented-out line would come back as live code.
const DEFAULT_COMMENT_SYNTAX = {
  ".py": "hash", ".pyi": "hash", ".rb": "hash", ".ps1": "hash", ".psm1": "hash",
  ".pl": "hash", ".pm": "hash", ".r": "hash", ".sh": "hash", ".bash": "hash",
  ".zsh": "hash", ".yml": "hash", ".yaml": "hash", ".toml": "hash",
};

function commentStyle(rel, syntax) {
  const ext = path.extname(rel).toLowerCase();
  if (syntax && typeof syntax[ext] === "string") return syntax[ext];
  if (/^(?:Dockerfile|Makefile|makefile|GNUmakefile)(?:\.|$)/.test(path.basename(rel))) return "hash";
  return DEFAULT_COMMENT_SYNTAX[ext] || "slash";
}

// A `/` opens a regular expression only where a value may start. After a name,
// a number, or a closing bracket it is division. The known miss is `if (x)
// /re/.test(s)`, where the regex body stays visible to the patterns — a rare
// shape, and one that can only ever add a finding, never hide one.
function regexCanStart(prev) {
  return prev === "" || !/[)\]}\w$]/.test(prev);
}

// Both `stripComments` and `stripStrings` default to true: blanking more is the
// fewer-false-positives direction, so an edition that says nothing gets the
// safe reading. `strings` is the driver's older spelling of `stripStrings`.
//
// Comments and string literals are RECOGNISED unconditionally and only ERASED
// when asked. That separation is the whole fix for the third fault: with string
// bodies left visible, a scanner that stopped tracking them read the `//` in a
// URL as a comment and blanked the rest of the line, and the `/*` in a glob as
// a block comment and blanked the rest of the file.
function blankRegions(text, rel, opts) {
  const o = opts || {};
  const style = commentStyle(rel, o.commentSyntax);
  const extension = path.extname(rel).toLowerCase();
  const stripComments = o.stripComments !== false;
  const stripStrings = o.stripStrings !== undefined ? o.stripStrings !== false : o.strings !== false;
  const out = text.split("");
  const erase = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const toLineEnd = (from) => {
    let j = from;
    while (j < text.length && text[j] !== "\n") j++;
    return j;
  };

  // A literal that never closes is not a literal: reading it as one is how a
  // lone apostrophe used to blank everything after it.
  const closedAt = (i, q, oneLine) => {
    let j = i + 1;
    while (j < text.length) {
      const d = text[j];
      if (d === "\\") { j += 2; continue; }
      if (d === q) return { body: i + 1, bodyEnd: j, end: j + 1 };
      if (d === "\n" && oneLine) return null;
      j++;
    }
    return null;
  };
  // Rust raw strings: `r"…"`, `r#"…"#`, `br##"…"##`. No escapes inside, and the
  // hash count picks the terminator, so a `"` in the body cannot end it early.
  const RAW = /(?:br|r)(#*)"/y;
  const textBlockAt = (i) => {
    if (!['.cs', '.java', '.kt', '.kts'].includes(extension) || !text.startsWith('"""', i)) return null;
    // C# verbatim strings use a different escape grammar and are not raw strings.
    if (extension === '.cs' && text[i - 1] === '@') return null;
    let width = 3;
    if (extension === '.cs') while (text[i + width] === '"') width++;
    const body = i + width;
    if (extension === '.java' && !/^[\t \f]*\r?\n/.test(text.slice(body))) return null;
    const delimiter = '"'.repeat(width);
    let close = body;
    while (close < text.length) {
      // Java text blocks retain escapes; Kotlin and C# raw blocks do not.
      if (extension === '.java' && text[close] === '\\') { close += 2; continue; }
      if (text.startsWith(delimiter, close)) {
        // Interpolation contains executable expressions. Leave these blocks visible until a
        // parser can distinguish their expressions from prose; never blank the whole expression.
        const preserve = (extension === '.cs' && text[i - 1] === '$') ||
          ((extension === '.kt' || extension === '.kts') && /\$(?:\{|[A-Za-z_])/.test(text.slice(body, close)));
        return { body, bodyEnd: close, end: close + width, preserve };
      }
      close++;
    }
    return null;
  };
  const literalAt = (i) => {
    const q = text[i];
    // INI quotes are value characters, not a string grammar. Only full-line comments disappear.
    if (style === 'ini') return null;
    if (extension === '.cs' && q === '"' &&
      (text[i - 1] === '@' || (text[i - 1] === '$' && text[i - 2] === '@'))) {
      let close = i + 1;
      while (close < text.length) {
        if (text[close] !== '"') { close++; continue; }
        if (text[close + 1] === '"') { close += 2; continue; }
        return { body: i + 1, bodyEnd: close, end: close + 1,
          preserve: text[i - 1] === '$' || text[i - 2] === '$' };
      }
      return null;
    }
    const block = q === '"' ? textBlockAt(i) : null;
    if (block) return block;
    if (style === "hash") {
      if (q !== '"' && q !== "'") return null;
      // Python triple quotes span lines; consuming one whole is what keeps the
      // scanner in step with the rest of the file.
      if (text[i + 1] === q && text[i + 2] === q) {
        const close = text.indexOf(q + q + q, i + 3);
        return close === -1 ? null : { body: i + 3, bodyEnd: close, end: close + 3 };
      }
      return closedAt(i, q, true);
    }
    if (q === "r" || q === "b") {
      if (/[\w$]/.test(text[i - 1] || "")) return null;
      RAW.lastIndex = i;
      const m = RAW.exec(text);
      if (!m || m.index !== i) return null;
      const term = '"' + m[1];
      const body = i + m[0].length;
      const close = text.indexOf(term, body);
      return close === -1 ? null : { body, bodyEnd: close, end: close + term.length };
    }
    if (q === '"' || q === "'") return closedAt(i, q, true);
    // Template literals and Go raw strings both span lines.
    if (q === "`") return closedAt(i, q, false);
    return null;
  };

  let prev = "";
  let lineOnlySpace = true;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if ((style === "hash" && c === "#") ||
      (style === 'ini' && lineOnlySpace && (c === '#' || c === ';'))) {
      const end = toLineEnd(i);
      if (stripComments) erase(i, end);
      i = end;
      continue;
    }
    if (style === "slash" && c === "/" && text[i + 1] === "/") {
      const end = toLineEnd(i);
      if (stripComments) erase(i, end);
      i = end;
      continue;
    }
    if (style === "slash" && c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      if (stripComments) erase(i, end);
      i = end;
      continue;
    }
    const lit = literalAt(i);
    if (lit) {
      if (stripStrings && !lit.preserve) erase(lit.body, lit.bodyEnd);
      prev = text[lit.end - 1];
      i = lit.end;
      continue;
    }
    if (style === "slash" && c === "/" && regexCanStart(prev)) {
      let j = i + 1;
      let charClass = false;
      while (j < text.length) {
        const d = text[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") break;
        if (d === "[") charClass = true;
        else if (d === "]") charClass = false;
        else if (d === "/" && !charClass) { j++; break; }
        j++;
      }
      erase(i + 1, Math.max(i + 1, j - 1));
      prev = "/";
      i = j;
      continue;
    }
    if (c === '\n') lineOnlySpace = true;
    else if (!/\s/.test(c)) lineOnlySpace = false;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

// A project's own `exclude` in `.collet/config.json` keeps paths such as a committed generated
// mirror out of every bundle check, next to each class's own list. An unreadable config adds none.
function withProjectExclude(root, spec) {
  let list;
  try {
    list = JSON.parse(readFileSync(path.join(root, '.collet', 'config.json'), 'utf8')).exclude;
  } catch {
    return spec;
  }
  const globs = Array.isArray(list) ? list.filter((glob) => typeof glob === 'string' && glob) : [];
  return globs.length ? { ...spec, exclude: [...(spec.exclude ?? []), ...globs] } : spec;
}

function relativeFile(root, target, cwd = root) {
  if (typeof target !== 'string' || !target) return null;
  const base = path.resolve(root);
  const absolute = path.resolve(base, cwd, target);
  const rel = path.relative(base, absolute).split(path.sep).join('/');
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith('../')) return null;
  return rel;
}

// Each pattern's matches, one entry per match holding the source lines it spans with whitespace
// collapsed, so a match that moved to another file can be recognized there. The count is the length.
function constructs(text, rel, spec) {
  const plain = (lines) => lines.replace(/\s+/g, ' ').trim();
  // A class may recognize a code annotation and a comment directive with different blanking
  // rules. Keep their counters independent; flattening flags would hide one or invent matches.
  return (spec.detectors ?? [spec]).flatMap((detector) => {
    if (!eligible(rel, detector.paths, spec)) return detector.patterns.map(() => []);
    const source = blankRegions(text, rel, { ...detector, commentSyntax: spec.commentSyntax });
    return detector.patterns.map((pattern) => {
      if (detector.perLine) {
        const regex = new RegExp(pattern);
        const lines = text.split('\n');
        return source.split('\n').flatMap((line, index) => (regex.test(line) ? [plain(lines[index])] : []));
      }
      return [...source.matchAll(new RegExp(pattern, 'g'))].map((match) => {
        const end = text.indexOf('\n', match.index + match[0].length);
        return plain(text.slice(text.lastIndexOf('\n', match.index - 1) + 1, end === -1 ? text.length : end));
      });
    });
  });
}

function introduces(before, after, rel, spec) {
  const old = constructs(before, rel, spec);
  return constructs(after, rel, spec).some((matches, index) => matches.length > old[index].length);
}

// The entries of `list` left after taking out one per entry of `other`.
function beyond(list, other) {
  const rest = [...list];
  for (const item of other) {
    const at = rest.indexOf(item);
    if (at !== -1) rest.splice(at, 1);
  }
  return rest;
}

// The changed files whose growth is not explained by matches that moved within the change. A file
// whose count fell can explain as many identical matches gained elsewhere as it lost, and no more,
// so splitting a file is not an introduction while any other added match still is.
function unmoved(files) {
  const found = new Set();
  for (let index = 0; index < (files[0]?.before.length ?? 0); index++) {
    const grown = files.filter(({ before, after }) => after[index].length > before[index].length);
    if (!grown.length) continue;
    const donors = files.map(({ before, after }) => ({
      spare: before[index].length - after[index].length,
      lost: beyond(before[index], after[index]),
    })).filter((donor) => donor.spare > 0);
    for (const file of grown) {
      let surplus = file.after[index].length - file.before[index].length;
      for (const match of beyond(file.after[index], file.before[index])) {
        const donor = donors.find((candidate) => candidate.spare > 0 && candidate.lost.includes(match));
        if (!donor) continue;
        donor.spare -= 1;
        donor.lost.splice(donor.lost.indexOf(match), 1);
        if (--surplus === 0) break;
      }
      if (surplus > 0) found.add(file);
    }
  }
  return files.filter((file) => found.has(file));
}

// A refusal names the introducing files in change order, up to this many, and counts the rest.
const NAMED_FILES = 10;

function finding(rels, spec) {
  const more = rels.length > NAMED_FILES ? ` and ${rels.length - NAMED_FILES} more` : '';
  const what = rels.length === 1
    ? `${rels[0]} introduces a matching source pattern`
    : `${rels.length} files introduce a matching source pattern: ${rels.slice(0, NAMED_FILES).join(', ')}${more}`;
  // A class's optional `remedy` says how a deliberate case passes.
  const remedy = spec.remedy ? ` ${spec.remedy}` : '';
  return { fires: true, reason: `${spec.id} (${spec.title}): ${what}. Fix the change before continuing.${remedy}` };
}

function skipped(reason) {
  return { fires: false, skipped: true, reason };
}

// Only a genuinely absent path has an empty baseline. A directory, symbolic link or unreadable
// file is a coverage gap, because guessing its previous text would manufacture a result.
function readSource(file) {
  try {
    if (!lstatSync(file).isFile()) throw new Error('not a regular file');
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

/** Editor calls carry proposed source; other tools are covered by the working-tree check. */
export function checkSource({ root, task, call }, spec) {
  if (!task) return skipped('no task is open, so nothing is enforced');
  spec = withProjectExclude(root, spec);
  if (!['Write', 'Edit', 'MultiEdit'].includes(call?.tool)) {
    return skipped('this tool does not carry supported source text; use the live check after the change');
  }
  const input = call.input ?? {};
  const rel = relativeFile(root, input.file_path, call.cwd ?? root);
  if (!rel || !eligible(rel, spec.paths, spec)) return { fires: false, reason: 'outside this source check\'s paths' };
  let pairs;
  if (call.tool === 'Write') {
    if (typeof input.content !== 'string') return skipped(`cannot read proposed source for ${rel}`);
    try {
      pairs = [{ old_string: readSource(path.resolve(root, rel)), new_string: input.content }];
    } catch {
      return skipped(`cannot read the existing source for ${rel}; no baseline was assumed`);
    }
  } else {
    pairs = call.tool === 'MultiEdit' ? input.edits : [input];
    if (!Array.isArray(pairs) || !pairs.length || pairs.some((edit) =>
      typeof edit?.old_string !== 'string' || typeof edit?.new_string !== 'string')) {
      return skipped(`cannot read the replacement source for ${rel}`);
    }
  }
  for (const edit of pairs) {
    if (introduces(edit.old_string, edit.new_string, rel, spec)) return finding([rel], spec);
  }
  return { fires: false, reason: 'no matching source pattern was introduced' };
}

// The change list against HEAD, with each working file and HEAD baseline read at most once.
// Returns null when Git cannot list the changes. A read that failed fails the same way again.
function changeSet(root) {
  const git = (args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  let changed;
  let prefix;
  try {
    // --relative keeps globs anchored at the mount, including a mount below the Git root.
    // NUL delimiters preserve spaces, tabs, Unicode and quoted-looking names verbatim.
    prefix = git(['rev-parse', '--show-prefix']).replace(/\r?\n$/, '');
    const entries = git(['diff', '--no-ext-diff', '--find-renames', '--relative', '--name-status', '-z', 'HEAD', '--', '.'])
      .split('\0').filter(Boolean);
    changed = new Map();
    for (let index = 0; index < entries.length;) {
      const status = entries[index++];
      const beforeRel = entries[index++];
      const rel = /^R\d+$/.test(status) ? entries[index++] : beforeRel;
      if (!rel || !/^(?:[ADMTU]|R\d+)$/.test(status)) throw new Error('unreadable change list');
      changed.set(rel, { status, beforeRel });
    }
    for (const rel of git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.']).split('\0').filter(Boolean)) {
      // A tracked deletion recreated as an untracked path still has its HEAD baseline.
      if (!changed.has(rel)) changed.set(rel, { status: 'A', beforeRel: rel });
    }
  } catch {
    return null;
  }
  const once = (cache, key, read) => {
    if (!cache.has(key)) {
      try {
        cache.set(key, { value: read() });
      } catch (error) {
        cache.set(key, { error });
      }
    }
    const { value, error } = cache.get(key);
    if (error) throw error;
    return value;
  };
  const sources = new Map();
  const heads = new Map();
  return {
    changed,
    source: (rel) => once(sources, rel, () => readSource(path.resolve(root, rel))),
    head: (rel) => once(heads, rel, () => git(['show', `HEAD:${prefix}${rel}`])),
  };
}

/**
 * Compare changed files with HEAD, including new files. Existing matches are not new failures,
 * including matches that moved from one changed file to another. The live runner passes one
 * `cache` to every check in a pass, so the change list and each baseline are read once per pass.
 */
export function liveSource({ root, task, cache }, spec) {
  if (!task) return skipped('no task is open, so nothing is enforced');
  spec = withProjectExclude(root, spec);
  const key = `source.mjs changes ${path.resolve(root)}`;
  let changes = cache?.get(key);
  if (changes === undefined) {
    changes = changeSet(root);
    cache?.set(key, changes);
  }
  if (!changes) {
    return skipped('cannot read the Git change list and HEAD baseline; Git or a committed HEAD may be unavailable');
  }
  const { changed } = changes;
  // A renamed file keeps its baseline only if its old name was eligible for this check too.
  // A failed show is not absence: only an added file or newly eligible path starts empty.
  const baseline = ({ status, beforeRel }) =>
    status === 'A' || (status.startsWith('R') && !eligible(beforeRel, spec.paths, spec))
      ? '' : changes.head(beforeRel);
  const gaps = [];
  const files = [];
  const emptied = [];
  for (const [rel, change] of changed) {
    if (rel.startsWith('.collet/') || !eligible(rel, spec.paths, spec)) continue;
    let before;
    let after;
    try {
      after = changes.source(rel);
      if (!after) {
        emptied.push([rel, change]);
        continue;
      }
      before = baseline(change);
    } catch {
      gaps.push(rel);
      continue;
    }
    files.push({ rel, before: constructs(before, rel, spec), after: constructs(after, rel, spec) });
  }
  let introducing = unmoved(files);
  // A deleted or emptied file adds nothing, so its baseline is read only to explain growth
  // elsewhere, and only when some growth is still unexplained.
  if (introducing.length && emptied.length) {
    for (const [rel, change] of emptied) {
      try {
        files.push({ rel, before: constructs(baseline(change), rel, spec), after: constructs('', rel, spec) });
      } catch {
        // An unreadable baseline explains no move, so the growth stays an introduction.
      }
    }
    introducing = unmoved(files);
  }
  if (introducing.length) return finding(introducing.map((file) => file.rel), spec);
  if (gaps.length) return skipped(`cannot read source or its HEAD baseline for: ${gaps.join(', ')}; no baseline was assumed`);
  return { fires: false, reason: 'no matching source pattern was introduced against HEAD' };
}
