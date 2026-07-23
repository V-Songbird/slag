"use strict";

// Statistics engine — bootstrap lift CI + a four-way verdict. This is the code
// that turns runs into claims, so it is the most tested code in the plugin and
// its randomness is seeded so every assertion is exact, not approximate.

const BOOTSTRAP_ITERS = 2000;
const NULL_BAND = 0.1; // a CI wholly inside ±this band around zero => NULL

// Deterministic LCG: same seed => same stream, so a bootstrap CI is reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// Percentile bootstrap of the lift (treatment mean − baseline mean): resample
// each arm with replacement, recompute the difference, take the 2.5/97.5
// percentiles. Returns [lo, hi].
function bootstrapLiftCI(variantScores, baselineScores, rand, iters = BOOTSTRAP_ITERS) {
  const lifts = [];
  for (let i = 0; i < iters; i++) {
    const v = Array.from({ length: variantScores.length }, () => variantScores[Math.floor(rand() * variantScores.length)]);
    const b = Array.from({ length: baselineScores.length }, () => baselineScores[Math.floor(rand() * baselineScores.length)]);
    lifts.push(mean(v) - mean(b));
  }
  lifts.sort((a, b) => a - b);
  return [lifts[Math.floor(0.025 * iters)], lifts[Math.floor(0.975 * iters)]];
}

// One-sample percentile bootstrap of a rate (the mean of a 0/1 score array):
// resample the scores with replacement, recompute the mean, take the 2.5/97.5
// percentiles. Returns [lo, hi] — the baseline band a drift re-check is judged
// against. Empty in => [null, null].
function bootstrapRateCI(scores, rand, iters = BOOTSTRAP_ITERS) {
  if (!scores.length) return [null, null];
  const rates = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < scores.length; j++) s += scores[Math.floor(rand() * scores.length)];
    rates.push(s / scores.length);
  }
  rates.sort((a, b) => a - b);
  return [rates[Math.floor(0.025 * iters)], rates[Math.floor(0.975 * iters)]];
}

// Four-way verdict from a lift CI:
//   CI entirely above 0       -> CONFIRMED+
//   CI entirely below 0       -> CONFIRMED-
//   CI straddles 0, inside band -> NULL (a real "no effect", tightly bounded)
//   CI straddles 0, wide       -> INCONCLUSIVE (underpowered, not a null)
function verdictFor(ciLow, ciHigh) {
  if (ciLow > 0) return "CONFIRMED+";
  if (ciHigh < 0) return "CONFIRMED-";
  if (ciLow > -NULL_BAND && ciHigh < NULL_BAND) return "NULL";
  return "INCONCLUSIVE";
}

module.exports = { lcg, mean, bootstrapLiftCI, bootstrapRateCI, verdictFor, BOOTSTRAP_ITERS, NULL_BAND };
