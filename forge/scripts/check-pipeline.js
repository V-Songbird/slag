#!/usr/bin/env node
// Parse-only validator for the shipped Workflow pipeline script.
// The .mjs uses a top-level `return` (legal in the Workflow runtime, which runs
// the body inside an async function) and an `export const meta` — neither parses
// as a plain module. Strip the `export ` prefix and wrap the whole body in an
// async function expression via `new Function`, which parses `return` without
// running anything. Construct it, never call it.
const fs = require('node:fs');
const path = require('node:path');

const scriptPath = path.join(__dirname, '..', 'workflows', 'forge-pipeline.workflow.mjs');
const raw = fs.readFileSync(scriptPath, 'utf8');

// meta must be a discoverable literal with name + description.
if (!/export\s+const\s+meta\s*=/.test(raw)) fail('missing `export const meta =`');
const metaStart = raw.indexOf('{', raw.indexOf('export const meta'));
const metaBlock = raw.slice(metaStart, raw.indexOf('\n}', metaStart));
if (!/\bname\s*:/.test(metaBlock)) fail('meta block has no `name`');
if (!/\bdescription\s*:/.test(metaBlock)) fail('meta block has no `description`');

const body = raw.replace(/^\s*export\s+/m, '');
try {
  // eslint-disable-next-line no-new-func
  new Function('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow',
    `return (async () => {\n${body}\n})`);
} catch (e) {
  fail('parse error: ' + (e && e.message || e));
}

console.log('check-pipeline: OK — ' + scriptPath + ' parses, meta declares name + description');

function fail(msg) {
  console.error('check-pipeline: FAIL — ' + msg);
  process.exit(1);
}
