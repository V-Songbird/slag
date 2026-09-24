"use strict";

// What session-evidence copies out of a transcript is redacted and bounded: secrets and the home
// directory are masked, characters a reader cannot see are spelled out, and every copied field is
// cut to a bound.

const os = require("node:os");
const { HIDDEN_CHARACTERS } = require("./audit.js");

// The home directory however a shell, a URL or a JSON string spells it, as whole path segments: a
// separator is a slash or a run of backslashes, and a drive also reads as MSYS /c and WSL /mnt/c. A
// sibling such as <home>2 is another directory. Case is ignored for a Windows home, and a root home
// names nobody, so it matches nothing.
function homePattern(home) {
  const trimmed = home.replace(/[\\/]+$/, "");
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return null;
  const segments = trimmed.split(/[\\/]+/).map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const drive = /^([A-Za-z]):$/.exec(segments[0]);
  if (drive) segments[0] = `(?:${drive[1]}:|/(?:mnt/)?${drive[1]})`;
  const body = segments.join(String.raw`(?:\\+|/)`);
  const flags = /^(?:[A-Za-z]:|\\\\)/.test(trimmed) ? "giu" : "gu";
  return new RegExp(String.raw`(?<![\p{L}\p{N}_.-])${body}(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_-])`, flags);
}

// A machine can have no home directory. Then nothing is redacted as one, and no default host home exists.
function homeDirectory() {
  try {
    return os.homedir();
  } catch {
    return "";
  }
}

// The OS user name, or nothing where the OS has none for this process.
function userName() {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

// The account name, the home directory's last segment and the OS user name when that differs, in the shapes that carry
// it past the home: a whole path segment after a slash or backslash, a part of a Claude project key such as
// C--Users-<name>-shop or -home-<name>-shop, a part of a lowercase folder name built from a path such as
// -mnt-d-projects-<name>-shop, and the owner or group column of an `ls -l` line. A word in prose or code is left alone,
// since an account name can be a common word such as dev, and so is a segment that only contains it, such as <name>2.
// Case is ignored for a Windows home, as the home rule does.
function accountShapes(home) {
  const trimmed = home.replace(/[\\/]+$/, "");
  const flags = /^(?:[A-Za-z]:|\\\\)/.test(trimmed) ? "giu" : "gu";
  const names = [trimmed.split(/[\\/]+/).pop()];
  const user = userName();
  if (user && (flags.includes("i") ? user.toLowerCase() !== names[0].toLowerCase() : user !== names[0])) names.push(user);
  const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const any = names.map(escape).join("|");
  // A project key spells every character but an ASCII letter or digit as a hyphen.
  const keyed = names.map((name) => escape(name.replace(/[^A-Za-z0-9]/g, "-"))).join("|");
  return {
    names: new RegExp(`^(?:${any})$`, flags.replace("g", "")),
    segment: new RegExp(String.raw`(?<=[\\/])(?:${any})(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_-])`, flags),
    key: new RegExp(String.raw`(?<![\p{L}\p{N}_.-])([A-Za-z]--(?:[A-Za-z0-9]+-)*?|-(?:home|Users)-)(?:${keyed})(?=-|(?![\p{L}\p{N}_.]))`, flags),
    // A folder name built from a whole path, lower case, with a hyphen for each separator: a WSL mount such as mnt-d-,
    // a drive such as d--, or home- or users- comes first, and every part between it and the name has two or more
    // characters, so that a longer name such as v-<name> keeps the word. The name is the project key's, in lower case.
    folder: new RegExp(String.raw`(?<![\p{L}\p{N}_.-])(-?(?:[a-z0-9]+-+)*?(?:mnt-[a-z]-|[a-z]--|home-|users-)(?:[a-z0-9]{2,}-+)*?)`
      + String.raw`(?:${keyed.toLowerCase()})(?=-|(?![\p{L}\p{N}_.]))`, "gu"),
    listing: new RegExp(String.raw`(?:^|(?<=\\n))([ \t]*[-bcdlps][-rwxsStT]{9}[.+@]?[ \t]+\d+[ \t]+)(\S+)([ \t]+)(\S+)`, `m${flags}`),
  };
}

const HOME = homeDirectory();
const HOME_PATH = homePattern(HOME);
// Where the home rule masks nothing, neither does the account rule.
const ACCOUNT = HOME_PATH ? accountShapes(HOME) : null;
const PLACEHOLDER = "<user>";

const WORD = /^[A-Za-z][a-z]*(?:[A-Z][a-z]+)*(?:-[A-Za-z][a-z]*(?:[A-Z][a-z]+)*)*$/;

// What follows Bearer or Basic is a credential when it has eight or more characters and is not prose:
// a word shorter than twenty letters, a date or number, a file name, or a path of words.
function isCredential(token) {
  const bare = token.replace(/\.+$/, "");
  return token.length >= 8 && !(bare.length < 20 && WORD.test(bare)) && !/^\d[\d./:-]*$/.test(bare)
    && !/^(?:[\w-]+\/)*[\w-]+\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(bare) && !/^[A-Za-z]+(?:\/[A-Za-z]+)+$/.test(bare);
}

// The redaction patterns here keep ASCII \b edges on purpose. Before a keyword, a non-ASCII letter such as ñ counts
// as an edge, so the ASCII edge errs toward masking: a Unicode edge would let `contraseña_token: …` through.

// A value named as a secret, after a colon or an assignment but never a comparison or an arrow:
// `token === null` is code.
const SECRET_NAME = String.raw`\b(?:[a-z][a-z0-9_]*_)?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)\b`;
const NAMED_SECRET = new RegExp(String.raw`(${SECRET_NAME}["']?\s*(?::=?|=(?![=>]))\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}&]+)`, "gi");
// A value in that place that is code, not a secret: a type annotation, a literal keyword or a reference
// to an environment variable.
const CODE_VALUE = new RegExp([
  String.raw`^(?:string|number|boolean|bigint|symbol|object|any|unknown|never|void|null|undefined|true|false)$`,
  String.raw`^(?:process\.env|import\.meta\.env|os\.environ)\b`,
  String.raw`^\$\{?[A-Za-z_]\w*\}?$|^%[A-Za-z_]\w*%$`,
].join("|"));

// Characters a transcript can hold that a reader does not see, the ones the audit reports in instruction files, each
// shown as its code point, so an excerpt shows the owner what the session read. A run of Unicode tags is counted
// instead, since its code points spell out the hidden text.
function visible(text) {
  let shown = "";
  let last = 0;
  let tags = 0;
  const flush = () => {
    if (tags) shown += `<${tags} Unicode tag character${tags === 1 ? "" : "s"}>`;
    tags = 0;
  };
  for (const match of text.matchAll(HIDDEN_CHARACTERS)) {
    const code = match[0].codePointAt(0);
    if (match.index > last) {
      flush();
      shown += text.slice(last, match.index);
    }
    if (code >= 0xe0000) tags++;
    else {
      flush();
      shown += `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`;
    }
    last = match.index + match[0].length;
  }
  flush();
  return shown + text.slice(last);
}

function redact(value) {
  const text = String(value)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/-]+=*)/gi, (match, scheme, space, token) => (
      isCredential(token) ? `${scheme}${space}[REDACTED]` : match))
    .replace(/\b((?:set-)?cookie\s*:)\s*[^\r\n]+/gim, "$1 [REDACTED]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[REDACTED]@")
    .replace(/(--(?:api-key|access-token|password|secret|token)\s+)\S+/gi, "$1[REDACTED]")
    .replace(NAMED_SECRET, (match, name, secret) => (CODE_VALUE.test(secret) ? match : `${name}[REDACTED]`));
  return visible(withoutAccount(withoutHome(text)));
}

// The home directory shortened to ~, and nothing else changed.
function withoutHome(text) {
  return HOME_PATH ? text.replace(HOME_PATH, "~") : text;
}

// The account name replaced by the placeholder in its known shapes, once the home is shortened.
function withoutAccount(text) {
  if (!ACCOUNT) return text;
  const column = (value) => (ACCOUNT.names.test(value) ? PLACEHOLDER : value);
  return text.replace(ACCOUNT.segment, PLACEHOLDER).replace(ACCOUNT.key, `$1${PLACEHOLDER}`)
    .replace(ACCOUNT.folder, `$1${PLACEHOLDER}`)
    .replace(ACCOUNT.listing, (line, lead, owner, gap, group) => `${lead}${column(owner)}${gap}${column(group)}`);
}

function cut(text, size) {
  return text.length <= size ? text : `${text.slice(0, size)} [excerpt truncated]`;
}

function excerpt(value, size = 480) {
  return cut(redact(value), size);
}

// A field that names the session, its model or agent is copied as written, cut to the same bound.
function bounded(value, size = 120) {
  return value ? cut(String(value), size) : null;
}

// The session's working directory with its home prefix shortened to ~, as in a path, and nothing else changed:
// session-review expands the ~ again to compare it with the repository root.
function directory(value) {
  return value ? cut(withoutHome(String(value)), 480) : null;
}

// A record's timestamp is copied as an excerpt, so a malformed record cannot inflate the evidence.
function timeOf(row) {
  return row.timestamp ? excerpt(row.timestamp, 120) : null;
}

module.exports = { HOME, bounded, cut, directory, excerpt, redact, timeOf };
