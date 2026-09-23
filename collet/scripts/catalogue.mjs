// Select the optional bundle and prove new checks before the mount writes them. The catalogue
// stays in the plugin; a mounted project receives ordinary modules and their fixture pairs.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));

// The bundle checks' shared runtime, `.collet/source.mjs`, may carry a project's own edits, so a
// remount replaces it only while it holds what collet wrote: a first line recording the hash of the
// rest, or the content of a version collet shipped before that line existed (0.3.0-alpha).
const SOURCE_MARK = '// collet:source ';
const SHIPPED_SOURCES = new Set(['5a5c01db878de2ba60b646c24ca2d0ce2fccfdecbd9a137fc5ff1f155e3d34ba']);
const digest = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const SOURCE_BODY = readFileSync(join(PLUGIN, 'templates', 'source.mjs'), 'utf8');
export const SOURCE_TEXT = `${SOURCE_MARK}${digest(SOURCE_BODY)} - mount.mjs replaces this file on a remount while this hash matches the rest.\n${SOURCE_BODY}`;

/** Does a project's `.collet/source.mjs` hold only what collet wrote, so a remount may replace it? */
export function unedited(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const cut = normalized.indexOf('\n');
  if (normalized.startsWith(SOURCE_MARK)) {
    return normalized.slice(SOURCE_MARK.length, SOURCE_MARK.length + 64) === digest(normalized.slice(cut + 1));
  }
  return SHIPPED_SOURCES.has(digest(normalized)) || digest(normalized) === digest(SOURCE_BODY);
}

export function cataloguesFor(target, editions = []) {
  const dir = join(PLUGIN, 'catalogue');
  const catalogues = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  const unknown = editions.filter((id) => !catalogues.some((item) => item.id === id));
  if (unknown.length) {
    throw new Error(`Unknown check edition: ${unknown.join(', ')}. Available: ${catalogues.map((item) => item.id).join(', ')}.`);
  }
  const names = readdirSync(target, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  // Detection reads root markers, including the filename globs used by project/solution files.
  // It never walks dependency trees; a nested package can be selected with an explicit edition.
  const markerMatches = (pattern) => {
    const expression = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
    return names.some((name) => new RegExp(`^${expression}$`, 'i').test(name));
  };
  const found = catalogues.filter((item) => editions.length
    ? editions.includes(item.id)
    : item.detect.files.some(markerMatches));
  if (!found.length) {
    throw new Error(`No supported language marker found at the project root. Use --edition <id> for a nested package, or omit --checks. Available: ${catalogues.map((item) => item.id).join(', ')}.`);
  }
  return found;
}

function fixtureFor(item, content, half, examplePath) {
  const path = examplePath ?? item.paths[0].replace(/\{([^}]+)\}/g, (_, choices) => choices.split(',')[0])
    .replace(/\*\*\//g, '').replace(/\*/g, 'fixture');
  return {
    what: `${item.title} — ${half}`,
    setup: {},
    task: { id: 't1', status: 'in_progress', scope: ['**'], accept: 'node -e 0' },
    call: { tool: 'Write', input: { file_path: path, content } },
  };
}

// The optional class fields: a refusal remedy, paths taken back out, and opt-in membership.
function checkFields(id, item) {
  if (item.remedy !== undefined && (typeof item.remedy !== 'string' || !item.remedy.trim())) {
    throw new Error(`${id} has a remedy that is not text.`);
  }
  if (item.exclude !== undefined && (!Array.isArray(item.exclude) || !item.exclude.every((glob) => typeof glob === 'string' && glob))) {
    throw new Error(`${id} has an exclude that is not a list of globs.`);
  }
  if (item.optional !== undefined && typeof item.optional !== 'boolean') {
    throw new Error(`${id} has an optional flag that is not true or false.`);
  }
}

/**
 * `chosen` names the opt-in classes to write and `removed` the classes the project took out, both
 * as <edition>.<class>.
 */
export async function prepareCatalogue(target, catalogue, chosen = [], removed = []) {
  const source = join(target, '.collet', 'source.mjs');
  // Prove new checks against the runtime this mount leaves in place: the project's copy only when it
  // has edits of its own, otherwise the template the mount installs or refreshes it to.
  const own = existsSync(source) && !unedited(readFileSync(source, 'utf8'));
  const runtime = await import(pathToFileURL(own ? source : join(PLUGIN, 'templates', 'source.mjs')).href);
  if (typeof runtime.checkSource !== 'function' || typeof runtime.liveSource !== 'function') {
    throw new Error('The preserved .collet/source.mjs must export checkSource and liveSource. Review it before adding catalogue checks.');
  }
  const files = [];
  const kept = [];
  const optional = [];
  const out = [];
  const checksDir = join(target, '.collet', 'checks');
  const installed = existsSync(checksDir) ? readdirSync(checksDir) : [];
  const root = mkdtempSync(join(tmpdir(), 'collet-catalogue-'));
  try {
    for (const item of catalogue.classes) {
      const id = `${catalogue.id}.${item.id}`;
      checkFields(id, item);
      // A class the project removed stays out, whatever its files or the catalogue say.
      if (removed.includes(id)) {
        out.push(id);
        continue;
      }
      const examples = [{ ...item.fixtures, id: '' }, ...(item.fixtures.additional ?? [])];
      const fixtures = examples.flatMap((example) => [
        { name: `${id}.violation${example.id ? `-${example.id}` : ''}.json`, expected: true,
          data: fixtureFor(item, example.violation, 'the planted mistake', example.path) },
        { name: `${id}.nearmiss${example.id ? `-${example.id}` : ''}.json`, expected: false,
          // A near miss may sit elsewhere, such as in a path the class excludes.
          data: fixtureFor(item, example.nearMiss, 'the look-alike', example.nearMissPath ?? example.path) },
      ]);
      const names = [`${id}.mjs`, ...fixtures.map((fixture) => fixture.name)];
      // The project owns its installed revision and may use custom fixture suffixes. A new
      // catalogue example does not make a valid older revision incomplete. Keep the module and
      // all its own examples together; the mounted runner will prove those, not our new pairs.
      const hasModule = installed.includes(names[0]);
      const violations = installed.filter((name) => name.startsWith(`${id}.violation`) && name.endsWith('.json'));
      const nearMisses = installed.filter((name) => name.startsWith(`${id}.nearmiss`) && name.endsWith('.json'));
      const hasExisting = hasModule || violations.length || nearMisses.length;
      if (hasExisting && (!hasModule || !violations.length || !nearMisses.length)) {
        throw new Error(`${id} has an incomplete check/example set. It was preserved; review the missing files before mounting again.`);
      }
      if (hasExisting) {
        kept.push(`${id} (existing check or fixture; set preserved)`);
        continue;
      }
      // An opt-in class is written only when the mount names it; an installed one is kept above.
      if (item.optional && !chosen.includes(id)) {
        optional.push(id);
        continue;
      }
      const { title, paths, exclude, patterns, stripComments, stripStrings, perLine, detectors, remedy } = item;
      const spec = { id, title, paths, exclude, patterns, stripComments, stripStrings, perLine, detectors, remedy, commentSyntax: catalogue.commentSyntax };
      for (const { data: fixture, expected } of fixtures) {
        const result = runtime.checkSource({ root, task: fixture.task, call: fixture.call }, spec);
        if (result?.skipped || Boolean(result?.fires) !== expected) {
          throw new Error(`${id} failed its ${expected ? 'violation' : 'near-miss'} example: ${result?.reason ?? 'no result'}. No catalogue checks were written.`);
        }
      }
      const gap = (Array.isArray(item.gapNotes) ? item.gapNotes.join('\n') : String(item.gapNotes ?? ''))
        .split('\n').map((line) => `// ${line}`).join('\n');
      const module = `${gap}\nimport { checkSource, liveSource } from '../source.mjs';\n\n` +
        `const spec = ${JSON.stringify(spec, null, 2)};\n` +
        `export const id = spec.id;\nexport const what = spec.title;\n` +
        `export const check = (context) => checkSource(context, spec);\n` +
        `export const live = (context) => liveSource(context, spec);\n`;
      files.push([names[0], module], ...fixtures.map(({ name, data }) => [name, JSON.stringify(data, null, 2) + '\n']));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { files, kept, optional, removed: out };
}
