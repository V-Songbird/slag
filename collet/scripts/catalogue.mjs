// Select the optional bundle and prove new checks before the mount writes them. The catalogue
// stays in the plugin; a mounted project receives ordinary modules and their fixture pairs.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));

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

export async function prepareCatalogue(target, catalogue) {
  const source = join(target, '.collet', 'source.mjs');
  const runtime = await import(pathToFileURL(existsSync(source) ? source : join(PLUGIN, 'templates', 'source.mjs')).href);
  if (typeof runtime.checkSource !== 'function' || typeof runtime.liveSource !== 'function') {
    throw new Error('The preserved .collet/source.mjs must export checkSource and liveSource. Review it before adding catalogue checks.');
  }
  const files = [];
  const kept = [];
  const checksDir = join(target, '.collet', 'checks');
  const installed = existsSync(checksDir) ? readdirSync(checksDir) : [];
  const root = mkdtempSync(join(tmpdir(), 'collet-catalogue-'));
  try {
    for (const item of catalogue.classes) {
      const id = `${catalogue.id}.${item.id}`;
      const examples = [{ ...item.fixtures, id: '' }, ...(item.fixtures.additional ?? [])];
      const fixtures = examples.flatMap((example) => [
        { name: `${id}.violation${example.id ? `-${example.id}` : ''}.json`, expected: true,
          data: fixtureFor(item, example.violation, 'the planted mistake', example.path) },
        { name: `${id}.nearmiss${example.id ? `-${example.id}` : ''}.json`, expected: false,
          data: fixtureFor(item, example.nearMiss, 'the look-alike', example.path) },
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
      const { title, paths, patterns, stripComments, stripStrings, perLine, detectors } = item;
      const spec = { id, title, paths, patterns, stripComments, stripStrings, perLine, detectors, commentSyntax: catalogue.commentSyntax };
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
  return { files, kept };
}
