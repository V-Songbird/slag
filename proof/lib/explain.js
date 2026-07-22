"use strict";

// Null-verdict explanations (component 6) — the single most important UX element
// in the tool. The most common real query ("does this CLAUDE.md rule help on
// sonnet?") correctly returns a null, and an UNexplained null reads as "broken".
// So every non-positive verdict is diagnosed into one named cause, each with a
// distinct next step (spec §4):
//
//   TIER_SATURATION      baseline already at ceiling → no room to lift. The edit
//                        may work on a smaller model. Action: re-run on haiku.
//   BELOW_DETECTION_FLOOR wide CI, baseline has room → an effect too small for
//                        this cheap N to resolve (gate-1's floor finding). NOT
//                        evidence of no effect. Action: escalate the power ladder.
//   GENUINELY_INERT      tight CI around zero, baseline has room → a real, actionable
//                        null. Action: delete the config; it is dead weight.

const SATURATION = 0.8; // baseline compliance at/above this = no room to lift

// arm: the analyzed non-baseline arm {verdict, lift, ci, mean}. baselineMean:
// baseline arm compliance. tier: the tierFor() result (for the re-run hint).
function explainVerdict(arm, baselineMean, tier) {
  if (!arm || arm.verdict === "CONFIRMED+" || arm.verdict === "CONFIRMED-") return null;

  const base = baselineMean == null ? null : baselineMean;
  const wide = arm.verdict === "INCONCLUSIVE";
  const onBigModel = tier && /sonnet|opus|fable/i.test(String(tier.tier || ""));

  if (base != null && base >= SATURATION) {
    return {
      cause: "TIER_SATURATION",
      headline: "NO DETECTABLE EFFECT — diagnosed cause: TIER SATURATION",
      body: `Baseline already succeeds at ${base.toFixed(2)} on ${tier ? tier.tier : "this tier"} — there is no room for the config to lift anything. This is the correct null for a saturated tier, not a broken tool.`,
      action: onBigModel
        ? "Re-run on haiku, where the effect is detectable — or accept that this config is redundant on the tier you run."
        : "The behavior is already at ceiling here; the config is redundant on this tier.",
    };
  }

  if (wide) {
    return {
      cause: "BELOW_DETECTION_FLOOR",
      headline: "NO DETECTABLE EFFECT — diagnosed cause: BELOW THE DETECTION FLOOR",
      body: `The CI is wide and straddles zero (lift ${fmt(arm.lift)}, CI ${ci(arm.ci)}). There may be a real effect this cheap N cannot resolve — a small-magnitude lever below proof's detection floor (gate-1 finding). This is NOT evidence the config is inert.`,
      action: "Escalate the power ladder — more paired runs (e.g. --reps 24), then a costlier tier if needed — before deciding.",
    };
  }

  // NULL: tight CI inside the band, with room to move.
  return {
    cause: "GENUINELY_INERT",
    headline: "NO DETECTABLE EFFECT — diagnosed cause: GENUINELY INERT",
    body: `Baseline was ${base == null ? "below ceiling" : base.toFixed(2)} (room to improve), N is adequate, and the CI is tight around zero (${ci(arm.ci)}). Not saturation and not underpower — the config did not change behavior on these tasks.`,
    action: "Candidate for deletion — removing it frees context budget and stops it burying the rules that do work.",
  };
}

function fmt(x) { return x == null ? "—" : (x >= 0 ? "+" : "") + x.toFixed(2); }
function ci(c) { return c ? `[${c[0].toFixed(2)}, ${c[1].toFixed(2)}]` : "—"; }

module.exports = { explainVerdict, SATURATION };
