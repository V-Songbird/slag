// Where the open task comes from. One definition, read by the task CLI, the check runner and the
// session hooks, so none of them can disagree about what is open.
//
// There is exactly one ledger: .collet/ledger.jsonl, written only by .collet/task.mjs. A project
// that plans its work somewhere else never gets this far — the mount refuses, so a second ledger
// beside a working one cannot happen and nothing here has to know about the first.
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

/** The open task, or null. `{ id, title, why, status, scope, accept, widenings }` */
export function openTask(root) {
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
  };
}
