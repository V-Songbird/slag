'use strict';

// Compares an installed copy of a plugin with its tracked source and reports every file whose
// bytes differ, every installed file the source does not track, every tracked file the install
// lacks, and every hook event whose definition differs in hooks/hooks.json, hooks/codex-hooks.json
// or the plugin-root hooks.json. The host-owned .in_use folder inside an installed copy is not part
// of the plugin and is ignored. The check only reads: it never writes to either directory.
//
// Usage: node scripts/plugin-parity.js <plugin directory in the checkout> <installed plugin directory>
// Exit 0 when nothing differs, 1 when anything does, 2 on a usage error or an unreadable directory.
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_FILES = ['hooks/hooks.json', 'hooks/codex-hooks.json', 'hooks.json'];

function trackedFiles(dir) {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${dir}: ${listed.stderr.trim()}`);
  return listed.stdout.split('\0').filter(Boolean);
}

function installedFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((file) => !file.startsWith('.in_use/'));
}

function read(dir, file) {
  try {
    return readFileSync(path.join(dir, file));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
    throw error;
  }
}

// The event map of a hook definition file: the hooks key, or the plugin-name key of the
// plugin-root file. null when the file is absent or not JSON.
function hookEvents(dir, file) {
  const buffer = read(dir, file);
  if (buffer === null) return null;
  try {
    const config = JSON.parse(buffer.toString('utf8'));
    return config.hooks ?? Object.values(config)[0] ?? {};
  } catch {
    return null;
  }
}

function compareHooks(sourceDir, installedDir) {
  const differences = [];
  for (const file of HOOK_FILES) {
    const source = hookEvents(sourceDir, file);
    const installed = hookEvents(installedDir, file);
    if (source === null && installed === null) {
      if (read(sourceDir, file) !== null || read(installedDir, file) !== null) {
        differences.push({ file, event: '*', difference: 'changed' });
      }
      continue;
    }
    for (const event of new Set([...Object.keys(source ?? {}), ...Object.keys(installed ?? {})])) {
      const before = source === null ? undefined : JSON.stringify(source[event]);
      const after = installed === null ? undefined : JSON.stringify(installed[event]);
      if (before === after) continue;
      const difference = before === undefined ? 'added' : after === undefined ? 'missing' : 'changed';
      differences.push({ file, event, difference });
    }
  }
  return differences;
}

function compare(sourceDir, installedDir) {
  const tracked = new Set(trackedFiles(sourceDir));
  const installed = new Set(installedFiles(installedDir));
  const result = { changed: [], added: [], missing: [], hooks: compareHooks(sourceDir, installedDir) };
  for (const file of tracked) {
    const source = read(sourceDir, file);
    if (source === null) continue; // deleted in the work tree or a submodule
    if (!installed.has(file)) result.missing.push(file);
    else if (!source.equals(read(installedDir, file))) result.changed.push(file);
  }
  for (const file of installed) if (!tracked.has(file)) result.added.push(file);
  for (const list of [result.changed, result.added, result.missing]) list.sort();
  return result;
}

function main(args) {
  if (args.length !== 2) {
    console.error('usage: node scripts/plugin-parity.js <plugin directory> <installed plugin directory>');
    return 2;
  }
  let result;
  try {
    result = compare(...args);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const lines = [
    ...result.changed.map((file) => `changed ${file}`),
    ...result.added.map((file) => `added ${file}`),
    ...result.missing.map((file) => `missing ${file}`),
    ...result.hooks.map(({ file, event, difference }) => `hook ${file} ${event} ${difference}`),
  ];
  console.log(lines.length ? lines.join('\n') : 'parity: no differences');
  return lines.length ? 1 : 0;
}

module.exports = { compare };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
