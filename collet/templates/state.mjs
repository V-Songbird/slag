// Where the open task comes from. One definition, read by the task CLI, the check runner and the
// session hooks, so none of them can disagree about what is open.
//
// There is exactly one ledger: .collet/ledger.jsonl, written only by .collet/task.mjs. A planning
// tool's roadmap beside it owns the plan and is never read here; only this ledger decides what is
// open.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const COLLET = '.collet';

const OPEN_STATUS = 'in_progress';

function lines(path) {
  if (!existsSync(path)) return [];
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function colletLedger(root) {
  return lines(join(root, COLLET, 'ledger.jsonl'));
}

export function config(root) {
  const path = join(root, COLLET, 'config.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** A config value that is still the template's placeholder says nothing and is treated as unset. */
export function filled(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.startsWith('REPLACE ME') || text.startsWith('REPLACE')) return null;
  return text;
}

// Characters a model reads and a person does not see: zero-width characters, the word joiner, a
// byte order mark, bidi embeddings and isolates, variation selectors and Unicode tags. Text holding
// them can carry an order nobody reviewing the file can read. The joiner inside an emoji and the
// tags of a subdivision flag render, so they are not matched. A subdivision flag is U+1F3F4, then
// two lowercase letter tags or three digit tags, one to four lowercase letter or digit tags, and
// the cancel tag U+E007F; any other tag is matched, including tags behind U+1F3F4 in another shape.
// U+FE0E or U+FE0F right after an Extended_Pictographic character, and U+FE0F between 0-9, # or *
// and the keycap U+20E3, choose how an emoji shows, so they are not matched; every other variation
// selector, U+FE00-U+FE0F and U+E0100-U+E01EF, is matched. The Mongolian free variation
// selectors U+180B-U+180D and U+180F right after a Mongolian letter, U+1820-U+1878 or
// U+1880-U+18AA, choose the letter's form, so they are not matched; anywhere else they are.
// Copied from anneal's audit, since collet ships alone; this is the one copy the task CLI, the
// mount and session start all read.
export const HIDDEN_CHARACTERS =
  /(?<!\p{Extended_Pictographic}\uFE0F?|[\u{1F3FB}-\u{1F3FF}])\u200D|(?<!\p{Extended_Pictographic}|[#*0-9](?=\uFE0F\u20E3))[\uFE0E\uFE0F]|(?<![\u1820-\u1878\u1880-\u18AA])[\u180B-\u180D\u180F]|[\u200B\u200C\u2060\uFEFF\u202A-\u202E\u2066-\u2069\uFE00-\uFE0D\u{E0100}-\u{E01EF}]|(?<!\u{1F3F4}(?=(?:[\u{E0061}-\u{E007A}]{2}|[\u{E0030}-\u{E0039}]{3})[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,4}\u{E007F})[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]*)[\u{E0000}-\u{E007F}]/gu;

/** The code points of `text` that do not show on screen. */
export const hiddenIn = (text) => [...String(text).matchAll(HIDDEN_CHARACTERS)].map(([char]) => char.codePointAt(0));

/** Those code points as U+XXXX, each named once. Tags are counted, never decoded. */
export function nameHidden(found) {
  const isTag = (code) => code >= 0xe0000 && code <= 0xe007f;
  const tags = found.filter(isTag).length;
  const named = [...new Set(found.filter((code) => !isTag(code)))].map(
    (code) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
  );
  if (tags) named.push(`${tags} Unicode tag character${tags === 1 ? '' : 's'}`);
  return named.join(', ');
}

/**
 * Why `text` cannot be written as `field`, or null. What the ledger and the config hold is read
 * back into every session, so a character nobody sees is refused where the text is written.
 */
export function unseen(field, text) {
  const found = hiddenIn(text);
  return found.length ? `${field} holds characters that do not show on screen: ${nameHidden(found)}.` : null;
}

/** The open task, or null. `{ id, title, foreman, why, status, scope, accept, widenings }` */
export function openTask(root) {
  const entry = colletLedger(root)
    .filter((item) => item.status === OPEN_STATUS)
    .pop();
  if (!entry) return null;
  return {
    id: entry.id,
    title: entry.title ?? '',
    foreman: entry.foreman ?? null,
    why: entry.why ?? '',
    status: entry.status,
    scope: entry.scope ?? [],
    accept: entry.accept ?? null,
    widenings: entry.widenings ?? [],
  };
}
