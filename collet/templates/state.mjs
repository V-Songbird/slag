// Where the open task comes from. One definition, read by the task CLI, the check runner and the
// session hooks, so none of them can disagree about what is open.
//
// Two owners are possible and the project decides, not the user:
//
//   collet   — .collet/ledger.jsonl, written only by .collet/task.mjs
//   foreman  — ROADMAP.jsonl, written only by that plugin's own CLI
//
// On a project that already plans its work elsewhere, collet writes no ledger of its own and
// enforces the files that plan already declares. A second ledger beside a working one is the
// failure this split exists to avoid: two records, and nobody knows which is authoritative.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const COLLET = '.collet';

/** Paths another tool owns. collet never refuses a write to these, in either mode. */
export const OWNED_ELSEWHERE = ['ROADMAP.jsonl', '.foreman/', '.foreman'];

const ROADMAP = 'ROADMAP.jsonl';
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

/**
 * True when the project plans its work in a roadmap this plugin does not own.
 *
 * Recognised by the directory, by the format marker, or by an entry's own shape — a roadmap
 * written before the marker existed carries no marker, and missing it would mean writing the
 * second ledger anyway.
 */
export function foremanProject(root) {
  if (existsSync(join(root, '.foreman'))) return true;
  const entries = lines(join(root, ROADMAP));
  if (!entries.length) return false;
  if (Object.prototype.hasOwnProperty.call(entries[0], 'foreman_roadmap_format')) return true;
  return entries.some(
    (entry) => entry.id && (Array.isArray(entry.planned_touches) || Array.isArray(entry.touches))
  );
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

/**
 * The open task, normalised across both owners, or null.
 *
 * `{ id, title, status, scope, accept, owner }` — `accept` is null under an owner that has its
 * own completion rule, and callers must not invent one.
 */
export function openTask(root) {
  if (foremanProject(root)) {
    const entry = lines(join(root, ROADMAP))
      .filter((item) => item.status === OPEN_STATUS)
      .pop();
    if (!entry) return null;
    return {
      id: entry.id,
      title: entry.title ?? '',
      why: entry.why ?? '',
      status: entry.status,
      scope: entry.planned_touches ?? entry.touches ?? [],
      accept: null,
      owner: 'foreman',
    };
  }

  const entry = colletLedger(root)
    .filter((item) => item.status === OPEN_STATUS)
    .pop();
  if (!entry) return null;
  return {
    id: entry.id,
    title: entry.title ?? '',
    why: entry.why ?? '',
    status: entry.status,
    scope: entry.scope ?? [],
    accept: entry.accept ?? null,
    widenings: entry.widenings ?? [],
    owner: 'collet',
  };
}
