// Fixture: near-miss negatives for class silent-catch. Never executed.
// The literal text catch (err) { } in this comment must not count.
function readConfig(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`config at ${path} is not valid JSON`, { cause: err });
  }
}

function warmCache() {
  try {
    buildCache();
  } catch (err) {
    logger.warn("cache warm failed", err);
  }
}

// A string holding the violating shape must not count either.
const template = "try { risky() } catch (err) { }";

module.exports = { readConfig, warmCache, template };
