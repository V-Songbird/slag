// Fixture: seeded violations for class silent-catch. Never executed.
// Two shapes: a bound error that is discarded, and a bare catch.
function readConfig(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
  }
  return null;
}

function warmCache() {
  try {
    buildCache();
  } catch {}
}

module.exports = { readConfig, warmCache };
