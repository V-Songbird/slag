// Shared by the three hooks. Everything here is fail-open and silent: a hook that cannot read the
// project must never be the reason a session stops working.
//
// One thing is deliberately not silent — the kill switch. `.collet/off` turns every hook off, and
// it exists so that "disabled" is a state somebody chose rather than the accidental result of a
// file going missing. The committed checks and anything wired to run them never read it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COLLET = '.collet';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function root() {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
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

export function emit(event, context) {
  if (!context) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } })
  );
}

export function deny(event, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: reason },
    })
  );
}
