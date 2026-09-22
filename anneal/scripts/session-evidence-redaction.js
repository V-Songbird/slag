"use strict";

// What session-evidence copies out of a transcript is redacted and bounded: secrets and the home
// directory are masked, and every copied field is cut to a bound.

const os = require("node:os");

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

const HOME = homeDirectory();
const HOME_PATH = homePattern(HOME);

const WORD = /^[A-Za-z][a-z]*(?:[A-Z][a-z]+)*(?:-[A-Za-z][a-z]*(?:[A-Z][a-z]+)*)*$/;

// What follows Bearer or Basic is a credential when it has eight or more characters and is not prose:
// a word shorter than twenty letters, a date or number, a file name, or a path of words.
function isCredential(token) {
  const bare = token.replace(/\.+$/, "");
  return token.length >= 8 && !(bare.length < 20 && WORD.test(bare)) && !/^\d[\d./:-]*$/.test(bare)
    && !/^(?:[\w-]+\/)*[\w-]+\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(bare) && !/^[A-Za-z]+(?:\/[A-Za-z]+)+$/.test(bare);
}

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

function redact(value) {
  const text = String(value)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/-]+=*)/gi, (match, scheme, space, token) => (
      isCredential(token) ? `${scheme}${space}[REDACTED]` : match))
    .replace(/\b((?:set-)?cookie\s*:)\s*[^\r\n]+/gim, "$1 [REDACTED]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[REDACTED]@")
    .replace(/(--(?:api-key|access-token|password|secret|token)\s+)\S+/gi, "$1[REDACTED]")
    .replace(NAMED_SECRET, (match, name, secret) => (CODE_VALUE.test(secret) ? match : `${name}[REDACTED]`));
  return withoutHome(text);
}

// The home directory shortened to ~, and nothing else changed.
function withoutHome(text) {
  return HOME_PATH ? text.replace(HOME_PATH, "~") : text;
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
